import { useEffect, useState } from 'react'
type Submission = { id: number; verdict: string; language?: string; passed: number; total: number; created_at: string }
export default function LessonSubmissions({ problem, active, select }: { problem?: string; active: boolean; select: (id: string) => void }) {
  const [items, setItems] = useState<Submission[]>([]), [error, setError] = useState(''), [loading, setLoading] = useState(false), [revision, retry] = useState(0)
  useEffect(() => {
    if (!active || !problem) return
    const controller = new AbortController()
    setLoading(true); setError('')
    void fetch(`/api/codelab/coding/problems/${problem}/submissions?limit=10`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) }).then(async response => {
      if (!response.ok) throw new Error('Submission history unavailable')
      return response.json()
    }).then(value => { if (!Array.isArray(value.items)) throw new Error('Submission history returned an unexpected response'); if (!controller.signal.aborted) setItems(value.items) }).catch(failure => { if (!controller.signal.aborted) setError(failure.message) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [active, problem, revision])
  if (!problem) return null
  return <details className="lesson-submissions"><summary>Attach a recent OJ submission</summary>{loading ? <p role="status">Loading submissions…</p> : error ? <p role="alert">{error} <button onClick={() => retry(value => value + 1)}>Retry submissions</button></p> : !items.length ? <p>No submissions for this problem yet.</p> : <ul>{items.map(item => <li key={item.id}><span>#{item.id} · {item.language === 'go' ? 'Go' : 'Python'} · {item.verdict} · {item.passed}/{item.total}<small>{new Date(item.created_at).toLocaleString()}</small></span><button onClick={() => select(String(item.id))}>Use #{item.id}</button></li>)}</ul>}</details>
}
