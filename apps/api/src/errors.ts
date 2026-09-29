export class AppError extends Error {
  constructor(message: string, readonly statusCode = 400, readonly code = 'INVALID_REQUEST', readonly retryable = false) {
    super(message);
    this.name = 'AppError';
  }
}

export function asAppError(error: unknown) {
  return error instanceof AppError ? error : new AppError('The service could not complete this request.', 500, 'SERVICE_UNAVAILABLE', true);
}
