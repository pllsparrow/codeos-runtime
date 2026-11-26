export class NotebookRequestError extends Error {
  status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}

export function apiErrorMessage(body: unknown, status: number): string {
  const detail = body && typeof body === 'object' && 'detail' in body ? body.detail : undefined
  if (typeof detail === 'string' && detail) return detail
  if (Array.isArray(detail)) {
    const messages = detail.flatMap((item) => item && typeof item.msg === 'string' ? [item.msg] : [])
    if (messages.length) return [...new Set(messages)].slice(0, 3).join('; ')
  }
  return `Request failed with status ${status}`
}
