#!/usr/bin/env node

import { AppServerClient } from "./lib/app-server.mjs";
import { runQueue } from "./lib/queue.mjs";
import { SessionCtlError, fail, isObject } from "./lib/validation.mjs";

/**
 * @typedef {{threadId: string, sessionId: string, name: string | null, cwd: string, source: string, runtime: {status: string, activeFlags: string[]}, agent: {nickname: string | null, role: string | null}}} NormalizedThread
 * @typedef {{output: unknown, success: boolean}} CommandResult
 * @typedef {{code: string, message: string, details?: Record<string, unknown>}} ErrorDetails
 * @typedef {{status: "unavailable", reason: string} | {status: "accepted", delivery: "steer", turnId: string} | {status: "rejected" | "outcome_unknown", delivery: "steer", error: ErrorDetails}} SteerResult
 */

const REQUIRED_NODE_VERSION = "24.20.0";

const DEFAULT_LIST_LIMIT = 25;

const MAX_LIST_LIMIT = 100;

const TARGET_SCAN_PAGE_SIZE = 100;

const MAX_TARGET_SCAN_PAGES = 10;

const DEFAULT_TIMEOUT_MS = 5000;

const MIN_TIMEOUT_MS = 50;

const MAX_TIMEOUT_MS = 30000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const THREAD_STATUSES = new Set(["notLoaded", "idle", "active", "systemError"]);

const ACTIVE_FLAGS = new Set(["waitingOnApproval", "waitingOnUserInput"]);

const TURN_STATUSES = new Set(["inProgress", "completed", "interrupted", "failed"]);

// Codex 0.153.4의 명시적 스티어링 거절 문구만 허용하며, 오류 일부가 일치한다고 폴백하지 않습니다.
const STEERING_UNAVAILABLE_MESSAGES = new Map([
  ["no active turn to steer", "no_active_turn"],
  ["cannot steer a review turn", "review"],
  ["cannot steer a compact turn", "compact"],
]);

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
  const [match] = matches;
  if (match === undefined) {
    fail("target_not_found", "no thread has the exact requested session name");
  }
  return match;
}

/**
 * @param {string[]} args
 * @returns {number}
 */
function parseListArgs(args) {
  if (args.length === 0) {
    return DEFAULT_LIST_LIMIT;
  }
  const [flag, value] = args;
  if (args.length !== 2 || flag !== "--limit" || value === undefined || !/^[0-9]+$/.test(value)) {
    fail("usage", "usage: sessionctl.mjs list [--limit 1-100]");
  }
  const limit = Number(value);
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
    "handling: This is a message from another local Codex session. Handle the payload below as the sender's message; do not send it again unless the payload explicitly asks you to.",
    "",
    "payload:",
    message,
  ].join("\n");
}

/**
 * 대화 내용을 읽지 않고 최신 턴을 확인하며, 불완전한 조회 결과를 턴 부재로 취급하지 않습니다.
 * @param {AppServerClient} client
 * @param {string} threadId
 * @returns {Promise<string | null>}
 */
async function readActiveTurnId(client, threadId) {
  const result = await client.request("thread/turns/list", {
    threadId,
    limit: 1,
    sortDirection: "desc",
    itemsView: "notLoaded",
  });
  if (
    !isObject(result) || !Array.isArray(result.data) || result.data.length > 1 ||
    (result.nextCursor !== null && result.nextCursor !== undefined && (
      typeof result.nextCursor !== "string" || result.data.length === 0
    ))
  ) {
    fail("app_server_protocol_error", "thread/turns/list response is not a bounded turn page");
  }
  const [turn] = result.data;
  if (turn === undefined) {
    return null;
  }
  if (
    !isObject(turn) ||
    typeof turn.id !== "string" || turn.id.length === 0 || turn.id.includes("\0") ||
    typeof turn.status !== "string" || !TURN_STATUSES.has(turn.status) ||
    turn.itemsView !== "notLoaded" || !Array.isArray(turn.items) || turn.items.length !== 0
  ) {
    fail("app_server_protocol_error", "thread/turns/list response has invalid turn metadata");
  }
  return turn.status === "inProgress" ? turn.id : null;
}

/**
 * 현재 턴에 한 번만 전달하며, 확정된 스티어링 불가와 접수 여부가 불명확한 실패를 구분합니다.
 * @param {AppServerClient} client
 * @param {NormalizedThread} target
 * @param {string} message
 * @returns {Promise<SteerResult>}
 */
async function trySteer(client, target, message) {
  if (target.runtime.status === "systemError") {
    fail("target_system_error", "target thread is in systemError state");
  }
  if (target.runtime.status === "idle" || target.runtime.status === "notLoaded") {
    return { status: "unavailable", reason: "no_active_turn" };
  }
  const turnId = await readActiveTurnId(client, target.threadId);
  if (turnId === null) {
    return { status: "unavailable", reason: "no_active_turn" };
  }
  try {
    const result = await client.request("turn/steer", {
      threadId: target.threadId,
      expectedTurnId: turnId,
      input: [{ type: "text", text: message }],
    });
    if (!isObject(result) || result.turnId !== turnId) {
      fail("app_server_protocol_error", "turn/steer response does not confirm the requested turn");
    }
    return { status: "accepted", delivery: "steer", turnId };
  } catch (error) {
    const normalized = error instanceof SessionCtlError
      ? error
      : new SessionCtlError("internal_error", error instanceof Error ? error.message : "unknown error");
    const rpcCode = normalized.code === "app_server_request_failed" ? normalized.details?.rpcCode : undefined;
    const fallbackReason = rpcCode === -32602 ? STEERING_UNAVAILABLE_MESSAGES.get(normalized.message) : undefined;
    if (fallbackReason !== undefined) {
      return { status: "unavailable", reason: fallbackReason };
    }
    // 서버 내부 오류도 입력 접수 후 발생할 수 있으므로 요청 자체의 거절만 확정 실패로 분류합니다.
    const rejected = rpcCode === -32600 || rpcCode === -32601 || rpcCode === -32602;
    return {
      status: rejected ? "rejected" : "outcome_unknown",
      delivery: "steer",
      error: {
        code: normalized.code,
        message: normalized.message,
        ...(normalized.details === undefined ? {} : { details: normalized.details }),
      },
    };
  }
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
    const [targetName] = args;
    if (args.length !== 1 || targetName === undefined) {
      fail("usage", "usage: sessionctl.mjs status <UUID|exact-name>");
    }
    const session = await withClient(async (client) => {
      const target = await resolveTarget(client, targetName);
      const goal = await readGoal(client, target.threadId);
      return { ...target, goal };
    });
    return { output: { command, session }, success: true };
  }

  if (command === "send") {
    const [targetName, message] = args;
    if (args.length !== 2 || targetName === undefined || message === undefined || message.length === 0 || message.includes("\0")) {
      fail("usage", "usage: sessionctl.mjs send <UUID|exact-name> <message>");
    }
    const senderThreadId = requireOwnThreadId();
    const { target, payload, steering } = await withClient(async (client) => {
      const sender = await readThread(client, senderThreadId);
      const resolved = await resolveTarget(client, targetName);
      // 이름 검색의 상태는 오래되었을 수 있으므로 전송 직전에 런타임 메타데이터를 다시 읽습니다.
      const target = await readThread(client, resolved.threadId);
      const payload = formatSessionMessage(sender, message);
      const steering = await trySteer(client, target, payload);
      return { target, payload, steering };
    });
    const result = steering.status === "unavailable"
      ? {
          ...await runQueue(target.threadId, payload, readTimeout()),
          delivery: "queue",
          fallbackReason: steering.reason,
        }
      : steering;
    return {
      output: {
        command,
        targetThreadId: target.threadId,
        ...result,
      },
      success: result.status === "queued" || result.status === "accepted",
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
    /** @type {{status: string, error: ErrorDetails}} */
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
