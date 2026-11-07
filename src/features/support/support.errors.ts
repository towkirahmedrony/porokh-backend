/**
 * Stable error codes returned by the support API. They are added to the
 * global EXPOSED_ERROR_CODES list so clients can react to them without parsing
 * messages.
 */
export const SUPPORT_ERROR_CODES = {
  DUPLICATE_TICKET: 'DUPLICATE_TICKET',
  TICKET_CLOSED: 'TICKET_CLOSED',
  INVALID_STATUS_TRANSITION: 'INVALID_STATUS_TRANSITION',
} as const;

export class SupportValidationError extends Error {
  status = 400;
  errorCode = 'VALIDATION_FAILED';

  constructor(message: string) {
    super(message);
    this.name = 'SupportValidationError';
  }
}

export class SupportNotFoundError extends Error {
  status = 404;

  constructor(message = 'Support ticket not found') {
    super(message);
    this.name = 'SupportNotFoundError';
  }
}

export class SupportConflictError extends Error {
  status = 409;
  errorCode: string;
  details?: Record<string, unknown>;

  constructor(message: string, errorCode: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'SupportConflictError';
    this.errorCode = errorCode;
    this.details = details;
  }
}

/** Raised when an attachment cannot be stored because storage is unavailable. */
export class SupportAttachmentError extends Error {
  status: number;
  exposeMessage = true;

  constructor(message: string, status = 503) {
    super(message);
    this.name = 'SupportAttachmentError';
    this.status = status;
  }
}
