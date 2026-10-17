export const ERROR_STATUS: Record<string, number> = {
  unauthorized: 401,
  forbidden_scope: 403,
  rejected_secret: 422,
  rejected_financial: 422,
  rejected_government_id: 422,
  rejected_employer: 422,
  rejected_pii: 422,
  conflict_etag: 409,
  not_found: 404,
  rate_limited: 429,
  invalid: 400,
};

export type ErrorCode = keyof typeof ERROR_STATUS;

export class VaultError extends Error {
  readonly reasons: string[];
  readonly status: number;

  constructor(readonly code: ErrorCode, message: string, reasons: string[] = []) {
    super(message);
    this.name = "VaultError";
    this.reasons = reasons;
    this.status = ERROR_STATUS[code];
  }
}

export type ApiError = { code: string; message: string; reasons: string[] };

export type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };

export type ApiSuccess<T = { [key: string]: JsonValue }> = { ok: true; data: T };
export type ApiFailure = { ok: false; error: ApiError };
export type ApiResult<T = { [key: string]: JsonValue }> = ApiSuccess<T> | ApiFailure;

export function failure(error: VaultError): ApiFailure {
  return {
    ok: false,
    error: { code: error.code, message: error.message, reasons: error.reasons },
  };
}

export function asVaultError(err: unknown): VaultError {
  if (err instanceof VaultError) return err;
  return new VaultError("invalid", "Request failed");
}
