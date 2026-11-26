export type PendingRequest = { body: string; key: string }
export function isLessonExperiment(path: string, identity: string): boolean {
  return /^[a-z0-9-]+$/.test(identity) && new RegExp(`^workspace/(?:course--)?${identity}-[a-z0-9-]+\\.ipynb$`).test(path)
}
export function recoverRequests(raw: string | null, identity: string): Map<string, PendingRequest> {
  const result = new Map<string, PendingRequest>()
  try {
    const rows: unknown = JSON.parse(raw || '[]')
    if (!Array.isArray(rows)) return result
    const lessonPrefix = `/api/codelab/learning/paths/lessons/${identity}/`
    for (const row of rows.slice(0, 5)) {
      if (!Array.isArray(row) || row.length !== 2) continue
      const [url, request] = row
      const allowed = typeof url === 'string' && (['notebook', 'reading', 'checkpoints'].some(action => url === lessonPrefix + action) || url.startsWith('/api/codelab/lab/workspaces/') && isLessonExperiment(url.slice('/api/codelab/lab/workspaces/'.length), identity))
      if (!allowed || !request || typeof request.body !== 'string' || request.body.length > 100000 || typeof request.key !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(request.key)) continue
      const body = JSON.parse(request.body)
      if (body && typeof body === 'object' && !Array.isArray(body)) result.set(url, { body: request.body, key: request.key })
    }
  } catch { /* Recovery is optional and never changes server state. */ }
  return result
}
