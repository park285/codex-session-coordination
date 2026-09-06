/** @typedef {{exitCode: number | null, signal: NodeJS.Signals | null, stderr?: string}} ProcessDetails */

const MAX_STDERR_BYTES = 4096;

/** 소유한 자식 프로세스를 강제 종료하고 핸들을 정리하기 전의 유예 시간입니다. */
export const TERMINATION_GRACE_MS = 250;

/**
 * 길이를 제한한 진단 문자열을 반환하며, 빈 값이나 문자열이 아닌 값은 생략합니다.
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function boundedText(value) {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  if (Buffer.byteLength(value) <= MAX_STDERR_BYTES) {
    return value;
  }
  return `${Buffer.from(value).subarray(0, MAX_STDERR_BYTES).toString("utf8")}\n[truncated]`;
}

/**
 * 진단 버퍼의 크기 제한을 유지하면서 stderr 데이터를 덧붙입니다.
 * @param {string} current
 * @param {string | Buffer | Uint8Array} chunk
 * @returns {string}
 */
export function appendBoundedText(current, chunk) {
  const currentBytes = Buffer.byteLength(current);
  if (currentBytes >= MAX_STDERR_BYTES) {
    return current;
  }
  const remaining = MAX_STDERR_BYTES - currentBytes;
  return current + Buffer.from(chunk).subarray(0, remaining).toString("utf8");
}

/**
 * 소유한 자식 프로세스의 종료를 요청하고, 유예 시간이 지나면 남은 파이프와 핸들을 정리합니다.
 * 이 정리는 대기열에 넣은 작업의 완료 여부를 보장하지 않습니다.
 * @param {import('node:child_process').ChildProcess} child
 */
export function terminateChild(child) {
  const release = () => {
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
  };
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    release();
    return;
  }

  const onClose = () => {
    clearTimeout(timer);
    release();
  };
  const timer = setTimeout(() => {
    child.removeListener("close", onClose);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    // 직접 실행한 자식이 종료돼도 하위 프로세스가 파이프를 잡고 있을 수 있습니다.
    release();
  }, TERMINATION_GRACE_MS);
  child.once("close", onClose);
  child.kill("SIGTERM");
}
