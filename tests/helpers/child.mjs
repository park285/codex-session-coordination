import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";

/**
 * 운영체제 프로세스를 시작하지 않고 종료 신호와 파이프 정리를 관찰합니다.
 * @param {import('node:test').TestContext} context
 * @param {boolean} started
 */
export function fakeChild(context, started = true) {
  const child = new ChildProcess();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  if (started) {
    Object.defineProperty(child, "pid", { value: 12345 });
  }
  const kill = context.mock.method(child, "kill", () => true);
  const unref = context.mock.method(child, "unref", () => {});
  return { child, kill, unref };
}
