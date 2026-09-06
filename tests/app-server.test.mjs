import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { AppServerClient } from "../session-coordination/scripts/lib/app-server.mjs";
import { TERMINATION_GRACE_MS } from "../session-coordination/scripts/lib/process.mjs";
import { fakeChild } from "./helpers/child.mjs";

test("프록시 연결 제한 시간이 지나면 오류를 유지하고 자식 핸들을 정리한다", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { child, kill, unref } = fakeChild(context);
  context.mock.method(childProcess, "spawn", () => child);
  syncBuiltinESMExports();
  context.after(() => {
    context.mock.restoreAll();
    syncBuiltinESMExports();
  });

  const client = new AppServerClient(50);
  const rejected = assert.rejects(client.initialize(), { code: "app_server_timeout" });
  context.mock.timers.tick(50);
  await rejected;
  assert.deepEqual(kill.mock.calls.map((call) => call.arguments[0]), ["SIGTERM"]);
  client.close();
  context.mock.timers.tick(TERMINATION_GRACE_MS);
  assert.deepEqual(kill.mock.calls.map((call) => call.arguments[0]), ["SIGTERM", "SIGKILL"]);
  assert.equal(unref.mock.callCount(), 1);
  assert.ok(child.stdin?.destroyed);
  assert.ok(child.stdout?.destroyed);
  assert.ok(child.stderr?.destroyed);
});
