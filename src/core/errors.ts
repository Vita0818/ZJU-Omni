export class ToolError extends Error {
  code: string;
  details: Record<string, unknown>;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function isToolError(error: unknown, code?: string): error is ToolError {
  return error instanceof ToolError && (code === undefined || error.code === code);
}

export interface SafeError {
  code: string;
  message: string;
  [key: string]: unknown;
}

export function safeError(error: unknown): SafeError {
  if (error instanceof ToolError) return { code: error.code, message: error.message, ...error.details };
  return { code: 'INTERNAL_ERROR', message: '操作失败。凭据和原始服务器响应已从错误输出中省略。' };
}
