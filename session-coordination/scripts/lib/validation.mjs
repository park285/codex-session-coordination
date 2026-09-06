/** 고정된 오류 코드와 선택적인 진단 정보를 담는 명령·프로토콜 오류입니다. */
export class SessionCtlError extends Error {
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
 * 명령이나 전달 상태를 바꾸지 않고 구조화된 오류를 던집니다.
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown> | undefined} details
 * @returns {never}
 */
export function fail(code, message, details = undefined) {
  throw new SessionCtlError(code, message, details);
}

/**
 * 외부 JSON의 필드에 접근하기 전에 객체 여부를 확인합니다.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
