import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { TextDecoder } from "node:util";
import { SessionCtlError, fail, isObject } from "./validation.mjs";
import { boundedText, appendBoundedText, terminateChild } from "./process.mjs";

/**
 * @typedef {import('./process.mjs').ProcessDetails} ProcessDetails
 * @typedef {{method: string, resolve: (value: unknown) => void, reject: (reason?: unknown) => void, timer: NodeJS.Timeout}} PendingRequest
 */

const MAX_LINE_BYTES = 1024 * 1024;

const MAX_HANDSHAKE_BYTES = 16 * 1024;

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/**
 * @param {number} opcode
 * @param {Buffer} payload
 * @returns {Buffer}
 */
function encodeClientFrame(opcode, payload = Buffer.alloc(0)) {
  if (!Buffer.isBuffer(payload)) {
    fail("app_server_protocol_error", "WebSocket payload must be a buffer");
  }
  const payloadLength = payload.length;
  const extendedLength = payloadLength < 126 ? 0 : payloadLength <= 0xffff ? 2 : 8;
  const header = Buffer.alloc(2 + extendedLength + 4);
  header[0] = 0x80 | opcode;
  let maskOffset = 2;
  if (extendedLength === 0) {
    header[1] = 0x80 | payloadLength;
  } else if (extendedLength === 2) {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payloadLength, 2);
    maskOffset = 4;
  } else {
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payloadLength), 2);
    maskOffset = 10;
  }
  const mask = randomBytes(4);
  mask.copy(header, maskOffset);
  const maskedPayload = Buffer.alloc(payloadLength);
  for (let index = 0; index < payloadLength; index += 1) {
    maskedPayload[index] = payload.readUInt8(index) ^ mask.readUInt8(index % 4);
  }
  return Buffer.concat([header, maskedPayload]);
}

/** 로컬 Codex 프록시 프로세스를 통해 시간·크기를 제한한 JSON-RPC 요청을 처리합니다. */
export class AppServerClient {
  /** @param {number} timeoutMs */
  constructor(timeoutMs) {
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    /** @type {Map<number, PendingRequest>} */
    this.pending = new Map();
    this.handshakeBuffer = Buffer.alloc(0);
    this.frameBuffer = Buffer.alloc(0);
    /** @type {Buffer[] | null} */
    this.fragmentBuffers = null;
    this.fragmentBytes = 0;
    this.stderr = "";
    this.closed = false;
    this.handshakeComplete = false;
    this.readySettled = false;
    /** @type {Promise<void>} */
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.child = spawn("codex", ["app-server", "proxy"], {
      env: process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderr = appendBoundedText(this.stderr, chunk);
    });
    this.child.stdin.on("error", (error) => {
      if (!this.closed) {
        this.connectionFailure(
          new SessionCtlError("app_server_unavailable", `codex app-server proxy stdin failed: ${error.message}`),
        );
      }
    });
    this.child.on("error", (error) => {
      this.connectionFailure(
        new SessionCtlError("app_server_spawn_failed", `could not start codex app-server proxy: ${error.message}`),
      );
    });
    this.child.on("exit", (code, signal) => {
      if (!this.closed) {
        /** @type {ProcessDetails} */
        const details = { exitCode: code, signal: signal ?? null };
        const stderr = boundedText(this.stderr);
        if (stderr !== undefined) {
          details.stderr = stderr;
        }
        this.connectionFailure(
          new SessionCtlError("app_server_unavailable", "codex app-server proxy exited unexpectedly", details),
        );
      }
    });
    this.startHandshake();
  }

  startHandshake() {
    const websocketKey = randomBytes(16).toString("base64");
    this.expectedAccept = createHash("sha1")
      .update(`${websocketKey}${WEBSOCKET_GUID}`)
      .digest("base64");
    const request = [
      "GET / HTTP/1.1",
      "Host: localhost",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${websocketKey}`,
      "Sec-WebSocket-Version: 13",
      "",
      "",
    ].join("\r\n");
    this.handshakeTimer = setTimeout(() => {
      this.connectionFailure(new SessionCtlError("app_server_timeout", "WebSocket handshake timed out"));
    }, this.timeoutMs);
    this.child.stdin.write(request);
  }

  /** @param {string | Buffer | Uint8Array} chunk */
  onStdout(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!this.handshakeComplete) {
      this.onHandshakeData(bytes);
      return;
    }
    this.onFrameData(bytes);
  }

  /** @param {Buffer} chunk */
  onHandshakeData(chunk) {
    this.handshakeBuffer = Buffer.concat([this.handshakeBuffer, chunk]);
    if (this.handshakeBuffer.length > MAX_HANDSHAKE_BYTES) {
      this.protocolFailure("WebSocket handshake exceeded the size limit");
      return;
    }
    const headerEnd = this.handshakeBuffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      return;
    }
    const headerText = this.handshakeBuffer.subarray(0, headerEnd).toString("ascii");
    const remaining = this.handshakeBuffer.subarray(headerEnd + 4);
    const lines = headerText.split("\r\n");
    if (!/^HTTP\/1\.[01] 101(?: |$)/.test(lines[0] ?? "")) {
      this.protocolFailure("app-server proxy did not accept the WebSocket upgrade");
      return;
    }
    /** @type {Map<string, string>} */
    const headers = new Map();
    for (const line of lines.slice(1)) {
      const separator = line.indexOf(":");
      if (separator <= 0) {
        this.protocolFailure("app-server proxy returned a malformed WebSocket header");
        return;
      }
      headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
    }
    const connectionTokens = (headers.get("connection") ?? "")
      .toLowerCase()
      .split(",")
      .map((token) => token.trim());
    if (
      headers.get("upgrade")?.toLowerCase() !== "websocket" ||
      !connectionTokens.includes("upgrade") ||
      headers.get("sec-websocket-accept") !== this.expectedAccept
    ) {
      this.protocolFailure("app-server proxy returned an invalid WebSocket acceptance response");
      return;
    }
    clearTimeout(this.handshakeTimer);
    this.handshakeComplete = true;
    this.handshakeBuffer = Buffer.alloc(0);
    this.readySettled = true;
    this.resolveReady();
    if (remaining.length > 0) {
      this.onFrameData(remaining);
    }
  }

  /** @param {Buffer} chunk */
  onFrameData(chunk) {
    this.frameBuffer = Buffer.concat([this.frameBuffer, chunk]);
    while (true) {
      if (this.frameBuffer.length < 2) {
        return;
      }
      const first = this.frameBuffer.readUInt8(0);
      const second = this.frameBuffer.readUInt8(1);
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      if ((first & 0x70) !== 0 || (second & 0x80) !== 0) {
        this.protocolFailure("app-server emitted an unsupported or masked WebSocket frame");
        return;
      }
      let payloadLength = second & 0x7f;
      let headerLength = 2;
      if (payloadLength === 126) {
        if (this.frameBuffer.length < 4) {
          return;
        }
        payloadLength = this.frameBuffer.readUInt16BE(2);
        headerLength = 4;
      } else if (payloadLength === 127) {
        if (this.frameBuffer.length < 10) {
          return;
        }
        const largeLength = this.frameBuffer.readBigUInt64BE(2);
        if (largeLength > BigInt(MAX_LINE_BYTES)) {
          this.protocolFailure("app-server WebSocket message exceeded the size limit");
          return;
        }
        payloadLength = Number(largeLength);
        headerLength = 10;
      }
      if (payloadLength > MAX_LINE_BYTES) {
        this.protocolFailure("app-server WebSocket message exceeded the size limit");
        return;
      }
      if (this.frameBuffer.length < headerLength + payloadLength) {
        return;
      }
      const payload = this.frameBuffer.subarray(headerLength, headerLength + payloadLength);
      this.frameBuffer = this.frameBuffer.subarray(headerLength + payloadLength);
      this.onFrame(opcode, fin, payload);
      if (this.closed) {
        return;
      }
    }
  }

  /**
   * @param {number} opcode
   * @param {boolean} fin
   * @param {Buffer} payload
   */
  onFrame(opcode, fin, payload) {
    if (opcode >= 0x08) {
      if (!fin || payload.length > 125) {
        this.protocolFailure("app-server emitted an invalid WebSocket control frame");
      } else if (opcode === 0x08) {
        this.connectionFailure(new SessionCtlError("app_server_unavailable", "app-server closed the connection"));
      } else if (opcode === 0x09) {
        this.sendFrame(0x0a, payload);
      } else if (opcode !== 0x0a) {
        this.protocolFailure("app-server emitted an unsupported WebSocket control frame");
      }
      return;
    }
    if (opcode === 0x01) {
      if (this.fragmentBuffers !== null) {
        this.protocolFailure("app-server started a new message during a fragmented message");
        return;
      }
      if (fin) {
        this.onTextPayload(payload);
        return;
      }
      this.fragmentBuffers = [Buffer.from(payload)];
      this.fragmentBytes = payload.length;
      return;
    }
    if (opcode === 0x00) {
      if (this.fragmentBuffers === null) {
        this.protocolFailure("app-server emitted a continuation frame without a message");
        return;
      }
      this.fragmentBytes += payload.length;
      if (this.fragmentBytes > MAX_LINE_BYTES) {
        this.protocolFailure("app-server fragmented message exceeded the size limit");
        return;
      }
      this.fragmentBuffers.push(Buffer.from(payload));
      if (fin) {
        const completePayload = Buffer.concat(this.fragmentBuffers, this.fragmentBytes);
        this.fragmentBuffers = null;
        this.fragmentBytes = 0;
        this.onTextPayload(completePayload);
      }
      return;
    }
    this.protocolFailure("app-server emitted a non-text WebSocket data frame");
  }

  /** @param {Buffer} payload */
  onTextPayload(payload) {
    let text;
    try {
      text = UTF8_DECODER.decode(payload);
    } catch {
      this.protocolFailure("app-server emitted invalid UTF-8");
      return;
    }
    /** @type {unknown} */
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      this.protocolFailure("app-server emitted malformed JSON");
      return;
    }
    this.onMessage(message);
  }

  /** @param {unknown} message */
  onMessage(message) {
    if (!isObject(message)) {
      this.protocolFailure("app-server emitted a non-object message");
      return;
    }
    if (message.id === undefined) {
      if (typeof message.method !== "string") {
        this.protocolFailure("app-server emitted a message without an id or method");
      }
      return;
    }
    if (typeof message.id !== "number" || !Number.isSafeInteger(message.id)) {
      this.protocolFailure("app-server emitted a response with an invalid request id");
      return;
    }
    const pending = this.pending.get(message.id);
    if (pending === undefined) {
      this.protocolFailure("app-server emitted a response with an unknown request id");
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error !== undefined) {
      const rpcMessage = isObject(message.error) && typeof message.error.message === "string"
        ? message.error.message
        : "unknown app-server error";
      const rpcCode = isObject(message.error) ? message.error.code : undefined;
      pending.reject(
        new SessionCtlError("app_server_request_failed", rpcMessage, {
          method: pending.method,
          rpcCode: rpcCode ?? null,
        }),
      );
      return;
    }
    if (!("result" in message)) {
      pending.reject(new SessionCtlError("app_server_protocol_error", "app-server response has no result"));
      return;
    }
    pending.resolve(message.result);
  }

  /** @param {string} message */
  protocolFailure(message) {
    const error = new SessionCtlError("app_server_protocol_error", message);
    this.connectionFailure(error);
  }

  /** @param {SessionCtlError} error */
  connectionFailure(error) {
    if (!this.readySettled) {
      this.readySettled = true;
      clearTimeout(this.handshakeTimer);
      this.rejectReady(error);
    }
    this.failPending(error);
    this.close(error);
  }

  /** @param {SessionCtlError} error */
  failPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  /**
   * @param {number} opcode
   * @param {Buffer} payload
   */
  sendFrame(opcode, payload) {
    if (this.closed || !this.child.stdin.writable) {
      fail("app_server_unavailable", "codex app-server proxy is not writable");
    }
    this.child.stdin.write(encodeClientFrame(opcode, payload));
  }

  /** @param {Record<string, unknown>} message */
  write(message) {
    const payload = Buffer.from(JSON.stringify(message));
    if (payload.length > MAX_LINE_BYTES) {
      fail("app_server_protocol_error", "outgoing app-server request exceeded the size limit");
    }
    this.sendFrame(0x01, payload);
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} params
   * @returns {Promise<unknown>}
   */
  request(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SessionCtlError("app_server_timeout", `${method} timed out`));
        this.close();
      }, this.timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.write({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async initialize() {
    await this.readyPromise;
    const result = await this.request("initialize", {
      clientInfo: {
        name: "session-coordination",
        title: "Session Coordination Skill",
        version: "1.0.0",
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [],
      },
    });
    if (!isObject(result) || typeof result.userAgent !== "string" || result.userAgent.length === 0) {
      fail("app_server_protocol_error", "initialize response is missing the server user agent");
    }
    this.write({ method: "initialized", params: {} });
  }

  /** @param {SessionCtlError} error */
  close(error = new SessionCtlError("app_server_closed", "app-server connection closed")) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    clearTimeout(this.handshakeTimer);
    if (!this.readySettled) {
      this.readySettled = true;
      this.rejectReady(error);
    }
    this.failPending(error);
    this.child.stdin.end();
    terminateChild(this.child);
  }
}
