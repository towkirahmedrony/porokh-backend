export const ADMISSION_ERROR_CODES = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNIVERSITY_NOT_FOUND: 'UNIVERSITY_NOT_FOUND',
  UNIVERSITY_INVALID_TYPE: 'UNIVERSITY_INVALID_TYPE',
  UNIT_NOT_FOUND: 'ADMISSION_UNIT_NOT_FOUND',
  UNIT_CODE_TAKEN: 'ADMISSION_UNIT_CODE_TAKEN',
  UNIT_IN_USE: 'ADMISSION_UNIT_IN_USE',
  PRACTICE_EMPTY: 'ADMISSION_PRACTICE_EMPTY',
} as const;

export type AdmissionErrorCode =
  (typeof ADMISSION_ERROR_CODES)[keyof typeof ADMISSION_ERROR_CODES];

/** Admin-facing error carrying the HTTP status and safe machine-readable code. */
export class AdmissionError extends Error {
  status: number;
  errorCode: AdmissionErrorCode;
  details?: unknown;

  constructor(
    message: string,
    status = 400,
    errorCode: AdmissionErrorCode = ADMISSION_ERROR_CODES.VALIDATION_FAILED,
    details?: unknown
  ) {
    super(message);
    this.name = 'AdmissionError';
    this.status = status;
    this.errorCode = errorCode;
    this.details = details;
  }
}
