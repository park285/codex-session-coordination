#!/usr/bin/env node

import { AppServerClient } from "./lib/app-server.mjs";
import { runQueue } from "./lib/queue.mjs";
import { SessionCtlError, fail, isObject } from "./lib/validation.mjs";

/**
 * @typedef {{threadId: string, sessionId: string, name: string | null, cwd: string, source: string, runtime: {status: string, activeFlags: string[]}, agent: {nickname: string | null, role: string | null}}} NormalizedThread
 * @typedef {{output: unknown, success: boolean}} CommandResult
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
    "handling: This is a message from another local Codex session. Handle the payload below as the sender's message; do not queue it again unless the payload explicitly asks you to.",
    "",
    "payload:",
    message,
  ].join("\n");
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
    const { sender, target } = await withClient(async (client) => {
      const sender = await readThread(client, senderThreadId);
      const target = await resolveTarget(client, targetName);
      return { sender, target };
    });
    const result = await runQueue(target.threadId, formatSessionMessage(sender, message), readTimeout());
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
