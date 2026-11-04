/**
 * Shared validation error used by every exact-key parser. It lives in its own
 * module so validation and settings can depend on it without a runtime import
 * cycle (settings parsers are themselves used by validation for download
 * controls).
 */
export class ValidationError extends Error {
  readonly code = 'INVALID_INPUT'

  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}
