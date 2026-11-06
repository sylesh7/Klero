export type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'NOT_WINNER'
  | 'ROUND_CLOSED'
  | 'STALE_AUTHORITY'
  | 'NOT_HUMAN_BACKED'
  | 'ALREADY_EXECUTED'
  | 'APPROVAL_MISMATCH'
  | 'POLICY_DENIED'
  | 'APPROVAL_EXPIRED'
  | 'INPUT_HASH_MISMATCH'
  | 'UPSTREAM_FAILED'
  | 'WORLD_UNAVAILABLE';

const STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  NOT_WINNER: 409,
  ROUND_CLOSED: 409,
  STALE_AUTHORITY: 409,
  NOT_HUMAN_BACKED: 409, // World AgentKit: agent wallet not proven human-backed (provider fence)
  ALREADY_EXECUTED: 409,
  APPROVAL_MISMATCH: 409,
  POLICY_DENIED: 402,
  APPROVAL_EXPIRED: 410,
  INPUT_HASH_MISMATCH: 422,
  UPSTREAM_FAILED: 502,
  WORLD_UNAVAILABLE: 503,
};

export class ApiError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.status = STATUS[code];
  }
  toJSON() {
    return { error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } };
  }
}
