#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
helper="${root_dir}/session-coordination/scripts/sessionctl.mjs"
syncer="${root_dir}/sync-session-coordination-skill.sh"
fixture_root="$(mktemp -d)"
trap 'rm -rf "${fixture_root}"' EXIT
fixture_bin="${fixture_root}/bin"
mkdir -p "${fixture_bin}"

cat >"${fixture_bin}/codex" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "app-server" && "${2:-}" == "proxy" ]]; then
  exec node "${FAKE_PROXY_SCRIPT}"
fi
if [[ "${1:-}" == "queue" ]]; then
  exec node "${FAKE_QUEUE_SCRIPT}" "$@"
fi
echo "unsupported fake codex invocation" >&2
exit 64
SH
chmod +x "${fixture_bin}/codex"

cat >"${fixture_root}/fake-proxy.mjs" <<'JS'
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

const selfId = "018f0000-0000-7000-8000-000000000001";
const targetId = "018f0000-0000-7000-8000-000000000002";
const thirdId = "018f0000-0000-7000-8000-000000000003";
const turnId = "018f0000-0000-7000-8000-000000000004";
const mode = process.env.FAKE_MODE ?? "normal";

function thread(id, name, status, agentNickname = null, agentRole = null) {
  return {
    id,
    sessionId: id,
    name,
    cwd: "/fixture/work",
    source: "cli",
    status,
    agentNickname,
    agentRole,
  };
}

const threads = [
  thread(selfId, "sender", { type: "active", activeFlags: ["waitingOnUserInput"] }, "sender-agent", "worker"),
  thread(targetId, "target", { type: "idle" }),
  thread(thirdId, mode === "duplicate" ? "target" : "other", { type: "notLoaded" }),
];

function serverFrame(payload) {
  const bytes = Buffer.from(payload);
  const extendedLength = bytes.length < 126 ? 0 : bytes.length <= 0xffff ? 2 : 8;
  const header = Buffer.alloc(2 + extendedLength);
  header[0] = 0x81;
  if (extendedLength === 0) {
    header[1] = bytes.length;
  } else if (extendedLength === 2) {
    header[1] = 126;
    header.writeUInt16BE(bytes.length, 2);
  } else {
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(bytes.length), 2);
  }
  return Buffer.concat([header, bytes]);
}

function send(message) {
  process.stdout.write(serverFrame(JSON.stringify(message)));
}

function respond(id, result) {
  send({ id, result });
}

function rpcError(id, message, code = -32602) {
  send({ id, error: { code, message } });
}

if (mode === "daemon-missing") {
  process.stderr.write("fixture daemon unavailable\n");
  process.exit(70);
}

let upgraded = false;
let inputBuffer = Buffer.alloc(0);

function handleRequest(request) {
  if (process.env.FAKE_RPC_CAPTURE) {
    appendFileSync(process.env.FAKE_RPC_CAPTURE, `${JSON.stringify(request)}\n`);
  }
  if (request.method === "initialized") {
    return;
  }
  if (mode === "timeout") {
    return;
  }
  if (mode === "malformed") {
    process.stdout.write(serverFrame("{not-json}"));
    return;
  }
  if (request.method === "initialize") {
    respond(request.id, {
      userAgent: "codex-cli/0.152.1",
      codexHome: "/fixture/codex",
      platformFamily: "unix",
      platformOs: "linux",
    });
    return;
  }
  if (request.method === "thread/list") {
    respond(request.id, { data: threads, nextCursor: null });
    return;
  }
  if (request.method === "thread/read") {
    const match = threads.find((candidate) => candidate.id === request.params.threadId);
    if (match === undefined) {
      rpcError(request.id, "fixture thread not found");
      return;
    }
    // 목록의 오래된 idle 상태를 그대로 사용하면 스티어링이 생략되는 회귀를 확인합니다.
    const status = match.id !== targetId ? match.status
      : mode.startsWith("steer-") ? { type: "active", activeFlags: mode === "steer-approval" ? ["waitingOnApproval"] : [] }
      : mode === "send-notloaded" ? { type: "notLoaded" }
      : mode === "send-system-error" ? { type: "systemError" }
      : match.status;
    respond(request.id, { thread: { ...match, status } });
    return;
  }
  if (request.method === "thread/turns/list") {
    if (mode === "steer-discovery-timeout") return;
    if (mode === "steer-discovery-capability") {
      rpcError(request.id, "fixture method unavailable", -32601);
      return;
    }
    const turn = { id: turnId, status: "inProgress", itemsView: "notLoaded", items: [] };
    if (mode === "steer-finished") turn.status = "completed";
    if (mode === "steer-discovery-status") turn.status = "unknown";
    if (mode === "steer-discovery-items") turn.items = [{ type: "userMessage", content: "fixture private content" }];
    if (mode === "steer-discovery-view") delete turn.itemsView;
    const data = mode === "steer-no-turns" || mode === "steer-discovery-empty-page" ? []
      : mode === "steer-discovery-malformed" ? null
      : mode === "steer-discovery-limit" ? [turn, turn]
      : [turn];
    respond(request.id, { data, nextCursor: mode === "steer-discovery-empty-page" ? "fixture-cursor" : null });
    return;
  }
  if (request.method === "turn/steer") {
    if (mode === "steer-timeout") return;
    if (mode === "steer-disconnect") process.exit(70);
    if (mode === "steer-malformed-json") {
      process.stdout.write(serverFrame("{not-json}"));
      return;
    }
    if (mode === "steer-malformed-rpc") {
      send({ id: request.id, error: { code: "-32602", message: "no active turn to steer" } });
      return;
    }
    if (mode === "steer-error-result") {
      send({ id: request.id, result: { turnId }, error: { code: -32602, message: "no active turn to steer" } });
      return;
    }
    if (mode === "steer-empty-reply") {
      send({ id: request.id });
      return;
    }
    const rejections = {
      "steer-no-active": [-32602, "no active turn to steer"],
      "steer-review": [-32602, "cannot steer a review turn"],
      "steer-review-queue-fail": [-32602, "cannot steer a review turn"],
      "steer-compact": [-32602, "cannot steer a compact turn"],
      "steer-mismatch": [-32602, "expected active turn id `previous`, got `current`"],
      "steer-capability": [-32601, "fixture method unavailable"],
      "steer-rejected": [-32602, "fixture request rejected"],
      "steer-lookalike": [-32602, "no active turn to steer (unverified)"],
      "steer-internal": [-32603, "fixture server error after possible acceptance"],
      "steer-unavailable-wrong-code": [-32603, "no active turn to steer"],
    };
    const rejection = rejections[mode];
    if (rejection !== undefined) {
      rpcError(request.id, rejection[1], rejection[0]);
      return;
    }
    respond(request.id, mode === "steer-malformed-result" ? {}
      : { turnId: mode === "steer-wrong-turn" ? thirdId : turnId });
    return;
  }
  if (request.method === "thread/goal/get") {
    const goal = request.params.threadId === selfId
      ? {
          threadId: selfId,
          objective: "fixture objective",
          status: "active",
          tokenBudget: 1000,
          tokensUsed: 10,
          timeUsedSeconds: 2,
          createdAt: 1,
          updatedAt: 2,
        }
      : null;
    respond(request.id, { goal });
    return;
  }
  rpcError(request.id, "fixture method unavailable");
}

function acceptUpgrade() {
  const headerEnd = inputBuffer.indexOf("\r\n\r\n");
  if (headerEnd < 0) {
    return false;
  }
  const request = inputBuffer.subarray(0, headerEnd).toString("ascii");
  inputBuffer = inputBuffer.subarray(headerEnd + 4);
  const keyLine = request.split("\r\n").find((line) => line.toLowerCase().startsWith("sec-websocket-key:"));
  if (keyLine === undefined) {
    process.exit(65);
  }
  const key = keyLine.slice(keyLine.indexOf(":") + 1).trim();
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  process.stdout.write([
    "HTTP/1.1 101 Switching Protocols",
    "Connection: Upgrade",
    "Upgrade: websocket",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    "",
  ].join("\r\n"));
  upgraded = true;
  return true;
}

function readFrames() {
  while (inputBuffer.length >= 2) {
    const first = inputBuffer[0];
    const second = inputBuffer[1];
    const opcode = first & 0x0f;
    if ((second & 0x80) === 0) {
      process.exit(66);
    }
    let payloadLength = second & 0x7f;
    let headerLength = 2;
    if (payloadLength === 126) {
      if (inputBuffer.length < 4) return;
      payloadLength = inputBuffer.readUInt16BE(2);
      headerLength = 4;
    } else if (payloadLength === 127) {
      if (inputBuffer.length < 10) return;
      payloadLength = Number(inputBuffer.readBigUInt64BE(2));
      headerLength = 10;
    }
    const frameLength = headerLength + 4 + payloadLength;
    if (inputBuffer.length < frameLength) {
      return;
    }
    const mask = inputBuffer.subarray(headerLength, headerLength + 4);
    const encoded = inputBuffer.subarray(headerLength + 4, frameLength);
    inputBuffer = inputBuffer.subarray(frameLength);
    if (opcode === 0x08) {
      process.exit(0);
    }
    if (opcode !== 0x01) {
      process.exit(67);
    }
    const payload = Buffer.alloc(payloadLength);
    for (let index = 0; index < payloadLength; index += 1) {
      payload[index] = encoded[index] ^ mask[index % 4];
    }
    handleRequest(JSON.parse(payload.toString("utf8")));
  }
}

process.stdin.on("data", (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  if (!upgraded && !acceptUpgrade()) {
    return;
  }
  readFrames();
});
JS

cat >"${fixture_root}/fake-queue.mjs" <<'JS'
import { appendFileSync } from "node:fs";

const mode = process.env.FAKE_MODE ?? "normal";
if (process.env.FAKE_QUEUE_CAPTURE) {
  appendFileSync(process.env.FAKE_QUEUE_CAPTURE, `${JSON.stringify(process.argv.slice(2))}\n`);
}
if (mode === "queue-fail" || mode === "steer-review-queue-fail") {
  process.stderr.write("fixture queue rejected\n");
  process.exit(23);
}
if (mode === "queue-signal") {
  process.kill(process.pid, "SIGTERM");
}
JS

export PATH="${fixture_bin}:${PATH}"
export FAKE_PROXY_SCRIPT="${fixture_root}/fake-proxy.mjs"
export FAKE_QUEUE_SCRIPT="${fixture_root}/fake-queue.mjs"
export CODEX_SESSION_COORDINATION_TIMEOUT_MS=150
self_id="018f0000-0000-7000-8000-000000000001"
target_id="018f0000-0000-7000-8000-000000000002"
turn_id="018f0000-0000-7000-8000-000000000004"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

run_failure() {
  local stdout_file="$1"
  local stderr_file="$2"
  shift 2
  if "$@" >"${stdout_file}" 2>"${stderr_file}"; then
    fail "command unexpectedly succeeded: $*"
  fi
}

FAKE_MODE=normal CODEX_THREAD_ID="${self_id}" node "${helper}" self >"${fixture_root}/self.json"
jq -e '
  .command == "self" and
  .session.threadId == "018f0000-0000-7000-8000-000000000001" and
  .session.runtime.status == "active" and
  .session.runtime.activeFlags == ["waitingOnUserInput"] and
  .session.goal.status == "active"
' "${fixture_root}/self.json" >/dev/null || fail "self output is not truthful"

FAKE_MODE=normal node "${helper}" list --limit 3 >"${fixture_root}/list.json"
jq -e '
  .command == "list" and
  .limit == 3 and
  .truncated == false and
  (.sessions | length) == 3 and
  .sessions[1].runtime.status == "idle" and
  .sessions[1].goal.status == "unreported"
' "${fixture_root}/list.json" >/dev/null || fail "list output is not bounded and truthful"
if rg -q 'preview|turns|reasoning|commandOutput|diff' "${fixture_root}/list.json"; then
  fail "list output exposed forbidden session content"
fi

FAKE_MODE=normal node "${helper}" status target >"${fixture_root}/status.json"
jq -e --arg target_id "${target_id}" '.session.threadId == $target_id and .session.name == "target"' \
  "${fixture_root}/status.json" >/dev/null || fail "exact-name status resolution failed"

queue_capture="${fixture_root}/queue.json"
# 큐 인자가 셸에서 평가되지 않는지 확인하기 위해 셸 문법을 문자열 그대로 유지합니다.
# shellcheck disable=SC2016
message='literal $HOME $(touch should-not-run) ; `false`'
FAKE_MODE=normal FAKE_QUEUE_CAPTURE="${queue_capture}" CODEX_THREAD_ID="${self_id}" \
  node "${helper}" send target "${message}" >"${fixture_root}/send.json"
jq -e --arg target_id "${target_id}" '.status == "queued" and .delivery == "queue" and .fallbackReason == "no_active_turn" and .targetThreadId == $target_id and .exitCode == 0' \
  "${fixture_root}/send.json" >/dev/null || fail "send did not report queued"
self_name_json="$(jq -c '.session.name' "${fixture_root}/self.json")"
expected_message="$(printf '[CODEX SESSION MESSAGE]\nsender_name: %s\nsender_thread_id: %s\nreply_to: %s\nhandling: This is a message from another local Codex session. Handle the payload below as the sender'"'"'s message; do not send it again unless the payload explicitly asks you to.\n\npayload:\n%s' \
  "${self_name_json}" "${self_id}" "${self_id}" "${message}")"
jq -e --arg target_id "${target_id}" --arg message "${expected_message}" \
  '. == ["queue", "--thread", $target_id, "--message", $message]' "${queue_capture}" >/dev/null || \
  fail "queue arguments did not carry the sender envelope with the literal payload"

for mode in steer-success steer-approval; do
  capture="${fixture_root}/${mode}.rpc"
  queue_capture="${fixture_root}/${mode}.queue"
  FAKE_MODE="${mode}" FAKE_RPC_CAPTURE="${capture}" FAKE_QUEUE_CAPTURE="${queue_capture}" CODEX_THREAD_ID="${self_id}" \
    node "${helper}" send target "${message}" >"${fixture_root}/${mode}.json"
  jq -e --arg target_id "${target_id}" --arg turn_id "${turn_id}" \
    '.status == "accepted" and .delivery == "steer" and .targetThreadId == $target_id and .turnId == $turn_id' \
    "${fixture_root}/${mode}.json" >/dev/null || fail "${mode} did not report steering acceptance"
  jq -se --arg target_id "${target_id}" --arg turn_id "${turn_id}" --arg message "${expected_message}" '
    [ .[] | select(.method == "thread/turns/list") | .params ] ==
      [{ threadId: $target_id, limit: 1, sortDirection: "desc", itemsView: "notLoaded" }] and
    [ .[] | select(.method == "turn/steer") | .params ] ==
      [{ threadId: $target_id, expectedTurnId: $turn_id, input: [{ type: "text", text: $message }] }] and
    all(.[]; .method != "turn/start" and .method != "thread/resume") and
    all(.[] | select(.method == "thread/read"); .params.includeTurns == false)
  ' "${capture}" >/dev/null || fail "${mode} did not preserve bounded reads and the literal steering envelope"
  [[ ! -e "${queue_capture}" ]] || fail "${mode} also invoked the queue"
done

for mode in send-notloaded steer-no-turns steer-finished steer-no-active steer-review steer-compact; do
  capture="${fixture_root}/${mode}.rpc"
  queue_capture="${fixture_root}/${mode}.queue"
  reason="no_active_turn"
  [[ "${mode}" != "steer-review" ]] || reason="review"
  [[ "${mode}" != "steer-compact" ]] || reason="compact"
  FAKE_MODE="${mode}" FAKE_RPC_CAPTURE="${capture}" FAKE_QUEUE_CAPTURE="${queue_capture}" CODEX_THREAD_ID="${self_id}" \
    node "${helper}" send "${target_id}" "${message}" >"${fixture_root}/${mode}.json"
  jq -e --arg reason "${reason}" '.status == "queued" and .delivery == "queue" and .fallbackReason == $reason' \
    "${fixture_root}/${mode}.json" >/dev/null || fail "${mode} did not report the queue fallback"
  jq -se --arg target_id "${target_id}" --arg message "${expected_message}" \
    '. == [["queue", "--thread", $target_id, "--message", $message]]' \
    "${queue_capture}" >/dev/null || fail "${mode} did not queue the original envelope exactly once"
  expected_attempts=1
  case "${mode}" in send-notloaded|steer-no-turns|steer-finished) expected_attempts=0 ;; esac
  jq -se --argjson attempts "${expected_attempts}" \
    '[.[] | select(.method == "turn/steer")] | length == $attempts' \
    "${capture}" >/dev/null || fail "${mode} retried or skipped steering unexpectedly"
done

for mode in steer-mismatch steer-capability steer-rejected steer-lookalike \
  steer-internal steer-unavailable-wrong-code steer-timeout steer-disconnect \
  steer-malformed-json steer-malformed-rpc steer-error-result steer-empty-reply \
  steer-malformed-result steer-wrong-turn; do
  capture="${fixture_root}/${mode}.rpc"
  queue_capture="${fixture_root}/${mode}.queue"
  expected_status="outcome_unknown"
  case "${mode}" in steer-mismatch|steer-capability|steer-rejected|steer-lookalike) expected_status="rejected" ;; esac
  run_failure "${fixture_root}/${mode}.out" "${fixture_root}/${mode}.err" \
    env FAKE_MODE="${mode}" FAKE_RPC_CAPTURE="${capture}" FAKE_QUEUE_CAPTURE="${queue_capture}" CODEX_THREAD_ID="${self_id}" \
    node "${helper}" send "${target_id}" message
  jq -e --arg status "${expected_status}" '.status == $status and .delivery == "steer" and (.error.code | type == "string")' \
    "${fixture_root}/${mode}.out" >/dev/null || fail "${mode} lost its delivery failure semantics"
  [[ ! -e "${queue_capture}" ]] || fail "${mode} incorrectly fell back to the queue"
  jq -se '[.[] | select(.method == "turn/steer")] | length == 1' \
    "${capture}" >/dev/null || fail "${mode} retried steering"
done

for mode in send-system-error steer-discovery-timeout steer-discovery-capability steer-discovery-malformed \
  steer-discovery-status steer-discovery-items steer-discovery-view steer-discovery-limit steer-discovery-empty-page; do
  capture="${fixture_root}/${mode}.rpc"
  queue_capture="${fixture_root}/${mode}.queue"
  run_failure "${fixture_root}/${mode}.out" "${fixture_root}/${mode}.err" \
    env FAKE_MODE="${mode}" FAKE_RPC_CAPTURE="${capture}" FAKE_QUEUE_CAPTURE="${queue_capture}" CODEX_THREAD_ID="${self_id}" \
    node "${helper}" send "${target_id}" message
  jq -e '.status == "error" and (.error.code | type == "string")' \
    "${fixture_root}/${mode}.err" >/dev/null || fail "${mode} did not preserve the discovery failure"
  [[ ! -e "${queue_capture}" ]] || fail "${mode} treated a discovery failure as unavailable steering"
  jq -se 'all(.[]; .method != "turn/steer")' "${capture}" >/dev/null || fail "${mode} sent a message after failed discovery"
  if rg -q 'fixture private content' "${fixture_root}/${mode}.out" "${fixture_root}/${mode}.err"; then
    fail "${mode} exposed conversation items"
  fi
done

queue_capture="${fixture_root}/steer-review-queue-fail.queue"
run_failure "${fixture_root}/steer-review-queue-fail.out" "${fixture_root}/steer-review-queue-fail.err" \
  env FAKE_MODE=steer-review-queue-fail FAKE_QUEUE_CAPTURE="${queue_capture}" CODEX_THREAD_ID="${self_id}" \
  node "${helper}" send "${target_id}" message
jq -e '.status == "rejected" and .delivery == "queue" and .fallbackReason == "review" and .exitCode == 23' \
  "${fixture_root}/steer-review-queue-fail.out" >/dev/null || fail "steering refusal hid queue rejection"
jq -se 'length == 1' "${queue_capture}" >/dev/null || fail "failed queue fallback was retried"

run_failure "${fixture_root}/missing-id.out" "${fixture_root}/missing-id.err" \
  env -u CODEX_THREAD_ID FAKE_MODE=normal node "${helper}" self
jq -e '.error.code == "missing_sender_identity"' "${fixture_root}/missing-id.err" >/dev/null || \
  fail "missing sender identity was not rejected"

run_failure "${fixture_root}/duplicate.out" "${fixture_root}/duplicate.err" \
  env FAKE_MODE=duplicate CODEX_THREAD_ID="${self_id}" node "${helper}" send target message
jq -e '.error.code == "ambiguous_target"' "${fixture_root}/duplicate.err" >/dev/null || \
  fail "duplicate exact names were not rejected"

run_failure "${fixture_root}/daemon.out" "${fixture_root}/daemon.err" \
  env FAKE_MODE=daemon-missing node "${helper}" list
jq -e '.error.code == "app_server_unavailable"' "${fixture_root}/daemon.err" >/dev/null || \
  fail "daemon failure was not preserved"

run_failure "${fixture_root}/timeout.out" "${fixture_root}/timeout.err" \
  env FAKE_MODE=timeout node "${helper}" list
jq -e '.error.code == "app_server_timeout"' "${fixture_root}/timeout.err" >/dev/null || \
  fail "app-server timeout was not preserved"

run_failure "${fixture_root}/malformed.out" "${fixture_root}/malformed.err" \
  env FAKE_MODE=malformed node "${helper}" list
jq -e '.error.code == "app_server_protocol_error"' "${fixture_root}/malformed.err" >/dev/null || \
  fail "malformed app-server response was not rejected"

run_failure "${fixture_root}/queue-fail.out" "${fixture_root}/queue-fail.err" \
  env FAKE_MODE=queue-fail CODEX_THREAD_ID="${self_id}" node "${helper}" send "${target_id}" message
jq -e '.status == "rejected" and .exitCode == 23 and (.stderr | contains("fixture queue rejected"))' \
  "${fixture_root}/queue-fail.out" >/dev/null || fail "queue rejection semantics were not preserved"

run_failure "${fixture_root}/queue-signal.out" "${fixture_root}/queue-signal.err" \
  env FAKE_MODE=queue-signal CODEX_THREAD_ID="${self_id}" node "${helper}" send "${target_id}" message
jq -e '.status == "outcome_unknown" and .signal == "SIGTERM"' "${fixture_root}/queue-signal.out" >/dev/null || \
  fail "ambiguous queue outcome was not preserved"

run_failure "${fixture_root}/limit.out" "${fixture_root}/limit.err" \
  env FAKE_MODE=normal node "${helper}" list --limit 101
jq -e '.error.code == "invalid_limit"' "${fixture_root}/limit.err" >/dev/null || \
  fail "unbounded list limit was not rejected"

install_root="${fixture_root}/skills"
if CODEX_SESSION_COORDINATION_SKILLS_ROOT="${install_root}" bash "${syncer}" --check >/dev/null 2>&1; then
  fail "missing fixture installation passed drift check"
fi
CODEX_SESSION_COORDINATION_SKILLS_ROOT="${install_root}" bash "${syncer}" --apply >/dev/null
CODEX_SESSION_COORDINATION_SKILLS_ROOT="${install_root}" bash "${syncer}" --check >/dev/null
FAKE_MODE=normal CODEX_THREAD_ID="${self_id}" \
  node "${install_root}/session-coordination/scripts/sessionctl.mjs" self >"${fixture_root}/installed.json"
jq -e --arg self_id "${self_id}" '.session.threadId == $self_id' "${fixture_root}/installed.json" >/dev/null || \
  fail "fresh installation did not execute with its imported modules"
printf '\nfixture drift\n' >>"${install_root}/session-coordination/SKILL.md"
if CODEX_SESSION_COORDINATION_SKILLS_ROOT="${install_root}" bash "${syncer}" --check >/dev/null 2>&1; then
  fail "fixture installation drift was not detected"
fi

legacy_root="${fixture_root}/legacy-skills"
mkdir -p "${legacy_root}/session-coordination/agents" "${legacy_root}/session-coordination/scripts"
cp "${root_dir}/session-coordination/SKILL.md" "${legacy_root}/session-coordination/SKILL.md"
cp "${root_dir}/session-coordination/agents/openai.yaml" "${legacy_root}/session-coordination/agents/openai.yaml"
printf 'throw new Error("legacy entry was not replaced");\n' >"${legacy_root}/session-coordination/scripts/sessionctl.mjs"
CODEX_SESSION_COORDINATION_SKILLS_ROOT="${legacy_root}" bash "${syncer}" --apply >/dev/null
CODEX_SESSION_COORDINATION_SKILLS_ROOT="${legacy_root}" bash "${syncer}" --check >/dev/null
FAKE_MODE=normal CODEX_THREAD_ID="${self_id}" \
  node "${legacy_root}/session-coordination/scripts/sessionctl.mjs" self >"${fixture_root}/upgraded.json"
jq -e --arg self_id "${self_id}" '.session.threadId == $self_id' "${fixture_root}/upgraded.json" >/dev/null || \
  fail "three-file installation did not upgrade to the module bundle"

echo "PASS: session coordination protocol, targeting, steering, bounded queue fallback, uncertain outcomes, fresh install, upgrade, and sync drift"
