import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { runQueue } from "../session-coordination/scripts/lib/queue.mjs";
import { TERMINATION_GRACE_MS } from "../session-coordination/scripts/lib/process.mjs";
import { fakeChild } from "./helpers/child.mjs";

/** @param {import('node:test').TestContext} context */
function queueFixture(context) {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = fakeChild(context);
  const spawn = context.mock.method(childProcess, "spawn", () => fixture.child);
  syncBuiltinESMExports();
  context.after(() => {
    context.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return { ...fixture, spawn };
}

test("종료 이벤트가 없어도 제한 시각에 결과를 확정하고 재전송하지 않는다", async (context) => {
  const { child, spawn, kill, unref } = queueFixture(context);
  const pending = runQueue("fixture-thread", "fixture message", 50);
  context.mock.timers.tick(50);
  const result = await pending;
  assert.deepEqual(result, { status: "outcome_unknown", exitCode: null, signal: null });
  assert.equal(spawn.mock.callCount(), 1);
  assert.deepEqual(kill.mock.calls.map((call) => call.arguments[0]), ["SIGTERM"]);
  assert.equal(unref.mock.callCount(), 0);
  context.mock.timers.tick(TERMINATION_GRACE_MS);
  assert.deepEqual(kill.mock.calls.map((call) => call.arguments[0]), ["SIGTERM", "SIGKILL"]);
  assert.equal(unref.mock.callCount(), 1);
  child.emit("close", 0, null);
  assert.equal((await pending).status, "outcome_unknown");
  assert.equal(spawn.mock.callCount(), 1);
});

test("정상 종료와 거절 결과를 유지하고 완료 후 타이머를 취소한다", async (context) => {
  const { child, spawn, kill } = queueFixture(context);
  const pending = runQueue("fixture-thread", "literal message", 50);
  child.stderr?.emit("data", "fixture rejected");
  child.emit("close", 23, null);
  assert.deepEqual(await pending, {
    status: "rejected", exitCode: 23, signal: null, stderr: "fixture rejected",
  });
  assert.deepEqual(spawn.mock.calls[0]?.arguments[1], [
    "queue", "--thread", "fixture-thread", "--message", "literal message",
  ]);
  context.mock.timers.tick(50 + TERMINATION_GRACE_MS);
  assert.equal(kill.mock.callCount(), 0);
});

test("정상 접수와 신호 중단을 구분한다", async (context) => {
  const { child, kill } = queueFixture(context);
  const accepted = runQueue("fixture-thread", "fixture", 50);
  child.emit("close", 0, null);
  assert.deepEqual(await accepted, { status: "queued", exitCode: 0, signal: null });

  const interrupted = runQueue("fixture-thread", "fixture", 50);
  child.emit("close", null, "SIGTERM");
  assert.deepEqual(await interrupted, { status: "outcome_unknown", exitCode: null, signal: "SIGTERM" });
  context.mock.timers.tick(50 + TERMINATION_GRACE_MS);
  assert.equal(kill.mock.callCount(), 0);
});

test("시작 오류 뒤의 종료 이벤트가 불명확한 결과를 덮어쓰지 않는다", async (context) => {
  const { child, kill } = queueFixture(context);
  const pending = runQueue("fixture-thread", "fixture", 50);
  child.emit("error", new Error("fixture spawn error"));
  child.emit("close", 1, null);
  assert.deepEqual(await pending, {
    status: "outcome_unknown", exitCode: null, signal: null, stderr: "fixture spawn error",
  });
  context.mock.timers.tick(50 + TERMINATION_GRACE_MS);
  assert.equal(kill.mock.callCount(), 0);
});
