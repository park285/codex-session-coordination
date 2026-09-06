#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { TextDecoder } from "node:util";

const REQUIRED_NODE_VERSION = "24.20.0";
const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;
const TARGET_SCAN_PAGE_SIZE = 100;
const MAX_TARGET_SCAN_PAGES = 10;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_HANDSHAKE_BYTES = 16 * 1024;
const MAX_STDERR_BYTES = 4096;
const DEFAULT_TIMEOUT_MS = 5000;
const MIN_TIMEOUT_MS = 50;
const MAX_TIMEOUT_MS = 30000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const THREAD_STATUSES = new Set(["notLoaded", "idle", "active", "systemError"]);
const ACTIVE_FLAGS = new Set(["waitingOnApproval", "waitingOnUserInput"]);
const GOAL_STATUSES = new Set([
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
]);
const SOURCE_KINDS = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
];

/**
 * @typedef {{exitCode: number | null, signal: NodeJS.Signals | null, stderr?: string}} ProcessDetails
 * @typedef {{method: string, resolve: (value: unknown) => void, reject: (reason?: unknown) => void, timer: NodeJS.Timeout}} PendingRequest
 * @typedef {{status: "queued" | "rejected" | "outcome_unknown", exitCode: number | null, signal: NodeJS.Signals | null, stderr?: string}} QueueResult
 * @typedef {{threadId: string, sessionId: string, name: string | null, cwd: string, source: string, runtime: {status: string, activeFlags: string[]}, agent: {nickname: string | null, role: string | null}}} NormalizedThread
 * @typedef {{output: unknown, success: boolean}} CommandResult
 */

class SessionCtlError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown> | undefined} details
   */
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "SessionCtlError";
    this.code = code;
    this.details = details;
  }
}

/**
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown> | undefined} details
 * @returns {never}
 */
function fail(code, message, details = undefined) {
  throw new SessionCtlError(code, message, details);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireNodeVersion() {
  if (process.versions.node !== REQUIRED_NODE_VERSION) {
    fail(
      "unsupported_node_version",
      `session coordination requires Node ${REQUIRED_NODE_VERSION}; found ${process.versions.node}`,
    );
  }
}

/** @returns {number} */
function readTimeout() {
  const raw = process.env.CODEX_SESSION_COORDINATION_TIMEOUT_MS;
  if (raw === undefined) {
    return DEFAULT_TIMEOUT_MS;
  }
  if (!/^[0-9]+$/.test(raw)) {
    fail("invalid_timeout", "CODEX_SESSION_COORDINATION_TIMEOUT_MS must be an integer");
  }
  const timeout = Number(raw);
  if (!Number.isSafeInteger(timeout) || timeout < MIN_TIMEOUT_MS || timeout > MAX_TIMEOUT_MS) {
    fail(
      "invalid_timeout",
      `CODEX_SESSION_COORDINATION_TIMEOUT_MS must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`,
    );
  }
  return timeout;
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function boundedText(value) {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  if (Buffer.byteLength(value) <= MAX_STDERR_BYTES) {
    return value;
  }
  return `${Buffer.from(value).subarray(0, MAX_STDERR_BYTES).toString("utf8")}\n[truncated]`;
}

/**
 * @param {string} current
 * @param {string | Buffer | Uint8Array} chunk
 * @returns {string}
 */
function appendBoundedText(current, chunk) {
  const currentBytes = Buffer.byteLength(current);
  if (currentBytes >= MAX_STDERR_BYTES) {
    return current;
  }
  const remaining = MAX_STDERR_BYTES - currentBytes;
  return current + Buffer.from(chunk).subarray(0, remaining).toString("utf8");
}

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
    maskedPayload[index] = payload[index] ^ mask[index % 4];
  }
  return Buffer.concat([header, maskedPayload]);
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function validateThreadId(value, label = "thread ID") {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    fail("invalid_thread_id", `${label} must be a UUID`);
  }
  return value;
}

/**
 * @param {unknown} source
 * @returns {string}
 */
function normalizeSource(source) {
  if (typeof source === "string" && source.length > 0) {
    return source;
  }
  if (isObject(source) && typeof source.custom === "string") {
    return "custom";
  }
  if (isObject(source) && isObject(source.subAgent)) {
    return "subAgent";
  }
  fail("malformed_thread", "thread source is missing or unsupported");
}

/**
 * @param {unknown} status
 * @returns {{status: string, activeFlags: string[]}}
 */
function normalizeRuntimeStatus(status) {
  if (!isObject(status) || typeof status.type !== "string" || !THREAD_STATUSES.has(status.type)) {
    fail("malformed_thread", "thread runtime status is missing or unsupported");
  }
  if (status.type !== "active") {
    return { status: status.type, activeFlags: [] };
  }
  if (
    !Array.isArray(status.activeFlags) ||
    status.activeFlags.some((flag) => typeof flag !== "string" || !ACTIVE_FLAGS.has(flag))
  ) {
    fail("malformed_thread", "active thread flags are missing or unsupported");
  }
  return { status: status.type, activeFlags: [...status.activeFlags] };
}

/**
 * @param {unknown} thread
 * @returns {NormalizedThread}
 */
function normalizeThread(thread) {
  if (!isObject(thread)) {
    fail("malformed_thread", "thread response is not an object");
  }
  const threadId = validateThreadId(thread.id);
  const sessionId = validateThreadId(thread.sessionId, "session ID");
  if (thread.name !== null && thread.name !== undefined && typeof thread.name !== "string") {
    fail("malformed_thread", "thread name is not a string or null");
  }
  if (typeof thread.cwd !== "string" || thread.cwd.length === 0) {
    fail("malformed_thread", "thread cwd is missing");
  }
  if (thread.agentNickname !== null && thread.agentNickname !== undefined && typeof thread.agentNickname !== "string") {
    fail("malformed_thread", "agent nickname is not a string or null");
  }
  if (thread.agentRole !== null && thread.agentRole !== undefined && typeof thread.agentRole !== "string") {
    fail("malformed_thread", "agent role is not a string or null");
  }
  return {
    threadId,
    sessionId,
    name: thread.name ?? null,
    cwd: thread.cwd,
    source: normalizeSource(thread.source),
    runtime: normalizeRuntimeStatus(thread.status),
    agent: {
      nickname: thread.agentNickname ?? null,
      role: thread.agentRole ?? null,
    },
  };
}

/**
 * @param {unknown} goal
 * @param {string} threadId
 */
function normalizeGoal(goal, threadId) {
  if (goal === null || goal === undefined) {
    return { reported: false, status: "unreported" };
  }
  if (!isObject(goal) || goal.threadId !== threadId) {
    fail("malformed_goal", "goal response does not belong to the requested thread");
  }
  if (typeof goal.objective !== "string" || typeof goal.status !== "string" || !GOAL_STATUSES.has(goal.status)) {
    fail("malformed_goal", "goal response is missing objective or has an unsupported status");
  }
  for (const field of ["tokensUsed", "timeUsedSeconds", "updatedAt"]) {
    const fieldValue = goal[field];
    if (typeof fieldValue !== "number" || !Number.isSafeInteger(fieldValue) || fieldValue < 0) {
      fail("malformed_goal", `goal ${field} is not a non-negative integer`);
    }
  }
  if (goal.tokenBudget !== null && goal.tokenBudget !== undefined) {
    if (typeof goal.tokenBudget !== "number" || !Number.isSafeInteger(goal.tokenBudget) || goal.tokenBudget <= 0) {
      fail("malformed_goal", "goal tokenBudget is not a positive integer or null");
    }
  }
  return {
    reported: true,
    status: goal.status,
    objective: goal.objective,
    tokenBudget: goal.tokenBudget ?? null,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    updatedAt: goal.updatedAt,
  };
}

class AppServerClient {
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
      const first = this.frameBuffer[0];
      const second = this.frameBuffer[1];
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
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGTERM");
    }
  }
}

/**
 * @template T
 * @param {(client: AppServerClient) => Promise<T>} operation
 * @returns {Promise<T>}
 */
async function withClient(operation) {
  const client = new AppServerClient(readTimeout());
  try {
    await client.initialize();
    return await operation(client);
  } finally {
    client.close();
  }
}

/**
 * @param {AppServerClient} client
 * @param {string} threadId
 * @returns {Promise<NormalizedThread>}
 */
async function readThread(client, threadId) {
  const result = await client.request("thread/read", { threadId, includeTurns: false });
  if (!isObject(result) || !isObject(result.thread)) {
    fail("app_server_protocol_error", "thread/read response is missing thread metadata");
  }
  const session = normalizeThread(result.thread);
  if (session.threadId !== threadId) {
    fail("app_server_protocol_error", "thread/read returned a different thread");
  }
  return session;
}

/**
 * @param {AppServerClient} client
 * @param {string} threadId
 */
async function readGoal(client, threadId) {
  const result = await client.request("thread/goal/get", { threadId });
  if (!isObject(result)) {
    fail("app_server_protocol_error", "thread/goal/get response is not an object");
  }
  return normalizeGoal(result.goal, threadId);
}

/**
 * @param {AppServerClient} client
 * @param {string} threadId
 */
async function readSession(client, threadId) {
  const [session, goal] = await Promise.all([readThread(client, threadId), readGoal(client, threadId)]);
  return { ...session, goal };
}

/**
 * @param {AppServerClient} client
 * @param {number} limit
 * @param {string | null} cursor
 * @returns {Promise<{sessions: NormalizedThread[], nextCursor: string | null}>}
 */
async function listThreadPage(client, limit, cursor = null) {
  const result = await client.request("thread/list", {
    cursor,
    limit,
    sortKey: "updated_at",
    sortDirection: "desc",
    sourceKinds: SOURCE_KINDS,
    useStateDbOnly: true,
  });
  if (!isObject(result) || !Array.isArray(result.data)) {
    fail("app_server_protocol_error", "thread/list response is missing data");
  }
  if (result.nextCursor !== null && result.nextCursor !== undefined && typeof result.nextCursor !== "string") {
    fail("app_server_protocol_error", "thread/list nextCursor is not a string or null");
  }
  return {
    sessions: result.data.map((thread) => normalizeThread(thread)),
    nextCursor: result.nextCursor ?? null,
  };
}

/**
 * @param {AppServerClient} client
 * @param {string} target
 * @returns {Promise<NormalizedThread>}
 */
async function resolveTarget(client, target) {
  if (typeof target !== "string" || target.length === 0 || target.includes("\0")) {
    fail("invalid_target", "target must be a non-empty UUID or exact session name");
  }
  if (UUID_PATTERN.test(target)) {
    return readThread(client, target);
  }
  let cursor = null;
  let pages = 0;
  /** @type {NormalizedThread[]} */
  const matches = [];
  do {
    const page = await listThreadPage(client, TARGET_SCAN_PAGE_SIZE, cursor);
    matches.push(...page.sessions.filter((session) => session.name === target));
    if (matches.length > 1) {
      fail("ambiguous_target", "exact session name matches more than one thread", { matchCount: matches.length });
    }
    cursor = page.nextCursor;
    pages += 1;
  } while (cursor !== null && pages < MAX_TARGET_SCAN_PAGES);
  if (cursor !== null) {
    fail("target_scan_limit", "exact-name resolution exceeded the bounded thread scan");
  }
  if (matches.length === 0) {
    fail("target_not_found", "no thread has the exact requested session name");
  }
  return matches[0];
}

/**
 * @param {string[]} args
 * @returns {number}
 */
function parseListArgs(args) {
  if (args.length === 0) {
    return DEFAULT_LIST_LIMIT;
  }
  if (args.length !== 2 || args[0] !== "--limit" || !/^[0-9]+$/.test(args[1])) {
    fail("usage", "usage: sessionctl.mjs list [--limit 1-100]");
  }
  const limit = Number(args[1]);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    fail("invalid_limit", `list limit must be between 1 and ${MAX_LIST_LIMIT}`);
  }
  return limit;
}

function requireOwnThreadId() {
  const threadId = process.env.CODEX_THREAD_ID;
  if (threadId === undefined || threadId.length === 0) {
    fail("missing_sender_identity", "CODEX_THREAD_ID is required for this command");
  }
  return validateThreadId(threadId, "CODEX_THREAD_ID");
}

/**
 * @param {NormalizedThread} sender
 * @param {string} message
 * @returns {string}
 */
function formatSessionMessage(sender, message) {
  return [
    "[CODEX SESSION MESSAGE]",
    `sender_name: ${JSON.stringify(sender.name)}`,
    `sender_thread_id: ${sender.threadId}`,
    `reply_to: ${sender.threadId}`,
    "handling: This is a message from another local Codex session. Handle the payload below as the sender's message; do not queue it again unless the payload explicitly asks you to.",
    "",
    "payload:",
    message,
  ].join("\n");
}

/**
 * @param {string} threadId
 * @param {string} message
 * @param {number} timeoutMs
 * @returns {Promise<QueueResult>}
 */
async function runQueue(threadId, message, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn("codex", ["queue", "--thread", threadId, "--message", message], {
      env: process.env,
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let settled = false;
    let timedOut = false;
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    /** @param {QueueResult} result */
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = appendBoundedText(stderr, chunk);
    });
    child.on("error", (error) => {
      finish({
        status: "outcome_unknown",
        exitCode: null,
        signal: null,
        stderr: boundedText(error.message),
      });
    });
    child.on("close", (code, signal) => {
      /** @type {ProcessDetails} */
      const common = {
        exitCode: code,
        signal: signal ?? null,
      };
      const nativeStderr = boundedText(stderr);
      if (nativeStderr !== undefined) {
        common.stderr = nativeStderr;
      }
      if (timedOut || signal !== null) {
        finish({ status: "outcome_unknown", ...common });
      } else if (code === 0) {
        finish({ status: "queued", ...common });
      } else {
        finish({ status: "rejected", ...common });
      }
    });
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
  });
}

/**
 * @param {string | undefined} command
 * @param {string[]} args
 * @returns {Promise<CommandResult>}
 */
async function runCommand(command, args) {
  if (command === "self") {
    if (args.length !== 0) {
      fail("usage", "usage: sessionctl.mjs self");
    }
    const threadId = requireOwnThreadId();
    const session = await withClient((client) => readSession(client, threadId));
    return { output: { command, session }, success: true };
  }

  if (command === "list") {
    const limit = parseListArgs(args);
    const output = await withClient(async (client) => {
      const page = await listThreadPage(client, limit);
      const sessions = await Promise.all(
        page.sessions.map(async (session) => ({ ...session, goal: await readGoal(client, session.threadId) })),
      );
      return {
        command,
        limit,
        truncated: page.nextCursor !== null,
        sessions,
      };
    });
    return { output, success: true };
  }

  if (command === "status") {
    if (args.length !== 1) {
      fail("usage", "usage: sessionctl.mjs status <UUID|exact-name>");
    }
    const session = await withClient(async (client) => {
      const target = await resolveTarget(client, args[0]);
      const goal = await readGoal(client, target.threadId);
      return { ...target, goal };
    });
    return { output: { command, session }, success: true };
  }

  if (command === "send") {
    if (args.length !== 2 || args[1].length === 0 || args[1].includes("\0")) {
      fail("usage", "usage: sessionctl.mjs send <UUID|exact-name> <message>");
    }
    const senderThreadId = requireOwnThreadId();
    const { sender, target } = await withClient(async (client) => {
      const sender = await readThread(client, senderThreadId);
      const target = await resolveTarget(client, args[0]);
      return { sender, target };
    });
    const result = await runQueue(target.threadId, formatSessionMessage(sender, args[1]), readTimeout());
    return {
      output: {
        command,
        targetThreadId: target.threadId,
        ...result,
      },
      success: result.status === "queued",
    };
  }

  fail("usage", "usage: sessionctl.mjs <self|list|status|send> ...");
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  try {
    requireNodeVersion();
    const result = await runCommand(command, args);
    process.stdout.write(`${JSON.stringify(result.output, null, 2)}\n`);
    if (!result.success) {
      process.exitCode = 1;
    }
  } catch (error) {
    const normalized = error instanceof SessionCtlError
      ? error
      : new SessionCtlError("internal_error", error instanceof Error ? error.message : "unknown error");
    /** @type {{status: string, error: {code: string, message: string, details?: Record<string, unknown>}}} */
    const output = {
      status: "error",
      error: {
        code: normalized.code,
        message: normalized.message,
      },
    };
    if (normalized.details !== undefined) {
      output.error.details = normalized.details;
    }
    process.stderr.write(`${JSON.stringify(output, null, 2)}\n`);
    process.exitCode = normalized.code === "usage" ? 2 : 1;
  }
}

await main();
