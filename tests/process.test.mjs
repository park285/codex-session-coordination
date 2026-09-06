import assert from "node:assert/strict";
import test from "node:test";
import { terminateChild, TERMINATION_GRACE_MS } from "../session-coordination/scripts/lib/process.mjs";
import { fakeChild } from "./helpers/child.mjs";

test("종료되지 않는 자식도 유예 시간 후 강제 종료하고 핸들을 정리한다", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { child, kill, unref } = fakeChild(context);
  terminateChild(child);
  assert.deepEqual(kill.mock.calls.map((call) => call.arguments[0]), ["SIGTERM"]);
  context.mock.timers.tick(TERMINATION_GRACE_MS - 1);
  assert.equal(unref.mock.callCount(), 0);
  context.mock.timers.tick(1);
  assert.deepEqual(kill.mock.calls.map((call) => call.arguments[0]), ["SIGTERM", "SIGKILL"]);
  assert.equal(unref.mock.callCount(), 1);
  assert.ok(child.stdin?.destroyed);
  assert.ok(child.stdout?.destroyed);
  assert.ok(child.stderr?.destroyed);
  assert.equal(child.listenerCount("close"), 0);
});

test("유예 시간 안에 종료되면 강제 종료 타이머를 취소한다", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { child, kill, unref } = fakeChild(context);
  terminateChild(child);
  child.emit("close", 0, null);
  context.mock.timers.tick(TERMINATION_GRACE_MS);
  assert.deepEqual(kill.mock.calls.map((call) => call.arguments[0]), ["SIGTERM"]);
  assert.equal(unref.mock.callCount(), 1);
  assert.ok(child.stderr?.destroyed);
});

test("자식이 종료됐어도 열린 파이프 때문에 close가 없으면 정리한다", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { child, kill, unref } = fakeChild(context);
  terminateChild(child);
  Object.defineProperty(child, "exitCode", { value: 0 });
  context.mock.timers.tick(TERMINATION_GRACE_MS);
  assert.deepEqual(kill.mock.calls.map((call) => call.arguments[0]), ["SIGTERM"]);
  assert.equal(unref.mock.callCount(), 1);
  assert.ok(child.stdout?.destroyed);
  assert.ok(child.stderr?.destroyed);
});

test("이미 종료됐거나 시작되지 않은 자식에는 종료 신호를 보내지 않는다", (context) => {
  for (const started of [true, false]) {
    const { child, kill, unref } = fakeChild(context, started);
    if (started) Object.defineProperty(child, "exitCode", { value: 0 });
    terminateChild(child);
    assert.equal(kill.mock.callCount(), 0);
    assert.equal(unref.mock.callCount(), 1);
    assert.ok(child.stderr?.destroyed);
  }
});
