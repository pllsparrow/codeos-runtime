export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const detail = payload && typeof payload === 'object' && 'detail' in payload ? String(payload.detail) : `Request failed (${response.status})`
    throw new Error(detail)
  }
  return payload as T
}
