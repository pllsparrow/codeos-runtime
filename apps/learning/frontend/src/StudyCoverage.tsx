import { useEffect, useState } from 'react'
import { ChevronDown } from 'lucide-react'
export type CoverageItem = { kind: 'reading' | 'experiment' | 'problem'; key: string; title?: string; covered: boolean; status: string }
export type CourseStudy = { total: number; covered: number; unknown: number; percent: number | null; items: CoverageItem[]; lessons: Record<string, { stage: string; items: CoverageItem[] }>; resume: { lesson_id: string; title: string; stage: string; updated_at: string } | null }
export type StudySummary = Record<string, CourseStudy>
export async function studyRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/codelab/learning/paths${path}`, { ...options, signal: options.signal || AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json', ...options.headers } })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(typeof body.detail === 'string' ? body.detail : 'Study information unavailable')
  return body
}
export function useStudySummary() {
  const [summary, setSummary] = useState<StudySummary>({}), [error, setError] = useState(''), [revision, setRevision] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setError('')
    void studyRequest<StudySummary>('/study', { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setSummary(value) }).catch(failure => { if (!controller.signal.aborted) setError(failure.message) })
    return () => controller.abort()
  }, [revision])
  return { summary, error, retry: () => setRevision(value => value + 1) }
}
export function Coverage({ value, compact = false }: { value?: CourseStudy; compact?: boolean }) {
  if (!value || !Array.isArray(value.items)) return null
  const progress = <><span className="coverage-track" role={value.percent === null ? undefined : 'progressbar'} aria-label="Course coverage" aria-valuenow={value.percent ?? undefined} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${value.percent ?? 0}%` }} /></span><small>{value.covered} / {value.total} learning items{value.unknown ? ` · ${value.unknown} unavailable` : ''}</small></>
  return <details className={`study-coverage${compact ? ' study-coverage-compact' : ''}`}><summary>{compact ? <span>Coverage <strong>{value.percent === null ? 'Pending evidence' : `${value.percent}%`}</strong><ChevronDown size={12} aria-hidden="true" /></span> : <><span>Course coverage <strong>{value.percent === null ? 'Pending evidence' : `${value.percent}%`}</strong></span>{progress}</>}</summary><div className="coverage-breakdown">{compact && progress}{(['reading','experiment','problem'] as const).map(kind => { const items = value.items.filter(item => item.kind === kind); return items.length ? <span key={kind}>{kind === 'reading' ? 'Reading' : kind === 'experiment' ? 'Experiments' : 'Problems'}<strong>{items.filter(item => item.covered).length}/{items.length}</strong></span> : null })}<p>Reading you confirm, saved experiments with current successful runs, and shared accepted problems. Coverage records activity, not understanding.</p><details><summary>Learning items</summary><ul className="coverage-items">{value.items.map(item => <li key={`${item.kind}:${item.key}`} data-covered={item.covered}><span>{item.title || item.key}<small>{item.kind}</small></span><strong>{item.covered ? 'Covered' : item.status}</strong></li>)}</ul></details></div></details>
}
