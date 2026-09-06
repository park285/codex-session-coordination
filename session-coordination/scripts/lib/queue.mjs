import { spawn } from "node:child_process";
import { boundedText, appendBoundedText, terminateChild } from "./process.mjs";

/**
 * @typedef {import('./process.mjs').ProcessDetails} ProcessDetails
 * @typedef {{status: "queued" | "rejected" | "outcome_unknown", exitCode: number | null, signal: NodeJS.Signals | null, stderr?: string}} QueueResult
 */

/**
 * Codex CLI로 메시지를 전달하며, 제한 시간 초과나 중단 시 결과의 불확실성을 보존합니다.
 * @param {string} threadId
 * @param {string} message
 * @param {number} timeoutMs
 * @returns {Promise<QueueResult>}
 */
export async function runQueue(threadId, message, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn("codex", ["queue", "--thread", threadId, "--message", message], {
      env: process.env,
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let settled = false;
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
      const diagnostic = boundedText(error.message);
      finish({
        status: "outcome_unknown",
        exitCode: null,
        signal: null,
        ...(diagnostic === undefined ? {} : { stderr: diagnostic }),
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
      if (signal !== null) {
        finish({ status: "outcome_unknown", ...common });
      } else if (code === 0) {
        finish({ status: "queued", ...common });
      } else {
        finish({ status: "rejected", ...common });
      }
    });
    timer = setTimeout(() => {
      const diagnostic = boundedText(stderr);
      finish({
        status: "outcome_unknown",
        exitCode: child.exitCode,
        signal: child.signalCode,
        ...(diagnostic === undefined ? {} : { stderr: diagnostic }),
      });
      terminateChild(child);
    }, timeoutMs);
  });
}
