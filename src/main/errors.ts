import type { AppErrorInfo } from '@shared/types'
import { ValidationError } from '@shared/validation'

export class AppError extends Error {
  readonly code: string
  readonly hint?: string

  constructor(code: string, message: string, hint?: string) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.hint = hint
  }
}

export function toErrorInfo(error: unknown): AppErrorInfo {
  if (error instanceof AppError) {
    return error.hint
      ? { code: error.code, message: error.message, hint: error.hint }
      : { code: error.code, message: error.message }
  }

  if (error instanceof ValidationError) {
    return { code: error.code, message: error.message }
  }

  if (error instanceof Error) {
    return { code: 'INTERNAL_ERROR', message: error.message }
  }

  return { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' }
}
