export const ERROR_STATUS: Record<string, number> = {
  unauthorized: 401,
  forbidden_scope: 403,
  conflict_etag: 409,
  not_found: 404,
  rate_limited: 429,
  invalid: 400,
  payload_too_large: 413,
  unclassified_domain: 400,
  forget_protected_path: 400,
  job_running: 409,
  migration_required: 409,
  count_mismatch: 409,
  misconfigured: 500,
};

export type ErrorCode = keyof typeof ERROR_STATUS;

export function isErrorCode(code: string): code is ErrorCode {
  return Object.hasOwn(ERROR_STATUS, code);
}

// `extra` holds small machine-readable fields that ride on the error object, such as the 413
// `limit` tag or the `job_id` of a running job. Never put content in it.
export class VaultError extends Error {
  readonly reasons: string[];
  readonly status: number;
  readonly extra: Record<string, string>;

  constructor(readonly code: ErrorCode, message: string, reasons: string[] = [], extra: Record<string, string> = {}) {
    super(message);
    this.name = "VaultError";
    this.reasons = reasons;
    this.status = ERROR_STATUS[code] ?? 400;
    this.extra = extra;
  }
}

export type ApiError = { code: string; message: string; reasons: string[] } & Record<string, unknown>;

export type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };

// `status` is the HTTP status for a success other than 200: 201 for a rerouted write, 202 for a
// write still running after the caller-facing timeout.
export type ApiSuccess<T = { [key: string]: JsonValue }> = { ok: true; data: T; status?: number };
export type ApiFailure = { ok: false; error: ApiError };
export type ApiResult<T = { [key: string]: JsonValue }> = ApiSuccess<T> | ApiFailure;

export function errorBody(error: VaultError): ApiError {
  return { code: error.code, message: error.message, reasons: error.reasons, ...error.extra };
}

export function failure(error: VaultError): ApiFailure {
  return { ok: false, error: errorBody(error) };
}

export function fromFailure(error: ApiError): VaultError {
  const code = isErrorCode(error.code) ? error.code : "invalid";
  const extra: Record<string, string> = {};
  for (const [key, value] of Object.entries(error)) {
    if (key === "code" || key === "message" || key === "reasons") continue;
    if (typeof value === "string") extra[key] = value;
  }
  return new VaultError(code, error.message, Array.isArray(error.reasons) ? error.reasons : [], extra);
}

export function asVaultError(err: unknown): VaultError {
  if (err instanceof VaultError) return err;
  return new VaultError("invalid", "Request failed");
}
