import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, RefreshCw, Sparkles, X } from 'lucide-react'

type ReviewDocument = {
  topic: string; key_points: string[];
  observations: { statement: string; evidence_ids: string[] }[];
  next_exercise: { prompt: string; expected_check: string };
}
type Review = {
  id: string; submission_id: number; status: 'running' | 'completed' | 'failed' | 'cancelled';
  result: ReviewDocument | null; error_code: string | null; created_at: string;
}
type Submission = { id: number; source: string; verdict: string; passed: number; total: number; language: string }

async function readJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(15_000), headers: { 'Content-Type': 'application/json', ...options.headers } })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(typeof body.detail === 'string' ? body.detail : `Review request failed (${response.status}).`)
  return body as T
}

export default function SubmissionReview({ submissionId, onClose }: { submissionId: number; onClose: () => void }) {
  const [submission, setSubmission] = useState<Submission>()
  const [reviews, setReviews] = useState<Review[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [pollRevision, setPollRevision] = useState(0)
  const pendingKey = useRef<string | undefined>(undefined)
  const generationController = useRef<AbortController | undefined>(undefined)
  const inFlight = useRef(false)
  const base = `/api/mentor/submissions/${submissionId}/reviews`
  const selected = reviews.find(item => item.id === selectedId) || reviews[0]
  const running = reviews.some(item => item.status === 'running')

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    const codelab = (import.meta.env.VITE_CODELAB_API_URL || '/api/codelab').replace(/\/$/, '')
    Promise.all([
      readJson<Submission>(`${codelab}/coding/submissions/${submissionId}`, { signal: controller.signal }).then(setSubmission),
      readJson<{ items: Review[] }>(base, { signal: controller.signal }).then(page => setReviews(page.items)),
    ]).catch(failure => { if (!controller.signal.aborted) setError(failure.message || 'Could not load this submission.') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [base, revision, submissionId])

  useEffect(() => () => generationController.current?.abort(), [])

  useEffect(() => {
    if (!running) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      readJson<{ items: Review[] }>(base, { signal: controller.signal })
        .then(page => { setReviews(page.items); setError('') })
        .catch(failure => {
          if (!controller.signal.aborted) {
            // A failed read does not mean the persisted generation has stopped.
            setError(failure.message)
            setPollRevision(value => value + 1)
          }
        })
    }, 2000)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [base, running, reviews, pollRevision])

  async function generate() {
    if (inFlight.current || running || submission?.language !== 'python') return
    inFlight.current = true
    const controller = new AbortController()
    generationController.current = controller
    const timeout = window.setTimeout(() => controller.abort(), 110_000)
    pendingKey.current ||= crypto.randomUUID()
    setGenerating(true); setError('')
    try {
      const row = await readJson<Review>(base, {
        method: 'POST', body: JSON.stringify({ client_review_id: pendingKey.current }), signal: controller.signal,
      })
      if (controller.signal.aborted) return
      pendingKey.current = undefined
      setReviews(items => [row, ...items.filter(item => item.id !== row.id)])
      setSelectedId(row.id)
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Generation failed. Try the same request again.')
      else setError('The request was interrupted. Refresh history before retrying.')
    } finally {
      window.clearTimeout(timeout)
      inFlight.current = false; setGenerating(false)
    }
  }

  return <section className="oj-review" aria-label={`AI review for submission ${submissionId}`}>
    <header><div><span className="oj-review-eyebrow">SAVED SUBMISSION #{submissionId}</span><h3>AI review</h3></div><button type="button" className="oj-review-icon" aria-label="Close review" onClick={onClose}><X size={17} /></button></header>
    {loading && <p role="status"><LoaderCircle className="oj-spinner" size={16} /> Loading saved submission…</p>}
    {submission && <><div className="oj-review-facts"><strong>{submission.verdict}</strong><span>{submission.passed}/{submission.total} judge cases</span><span>{submission.language === 'python' ? 'Python' : submission.language}</span></div><details><summary>Submitted code</summary><pre>{submission.source}</pre></details></>}
    <div className="oj-review-actions"><button type="button" className="oj-review-primary" disabled={loading || generating || running || !submission || submission.language !== 'python'} onClick={() => void generate()}>{generating || running ? <LoaderCircle className="oj-spinner" size={15} /> : <Sparkles size={15} />}{generating || running ? 'Generating review…' : selected ? 'Generate another review' : 'Generate review'}</button><button type="button" disabled={generating || loading} onClick={() => setRevision(value => value + 1)}><RefreshCw size={14} /> Refresh history</button></div>
    {error && <p className="oj-review-error" role="alert">{error}</p>}
    {!loading && !selected && !error && <p className="oj-review-muted">Review this saved code and its judge result to decide what to try next.</p>}
    {reviews.length > 1 && <nav className="oj-review-history" aria-label="Review history">{reviews.map(item => <button type="button" aria-pressed={selected?.id === item.id} key={item.id} onClick={() => setSelectedId(item.id)}>{new Date(item.created_at).toLocaleString()} · {item.status}</button>)}</nav>}
    {selected && <article className="oj-review-document"><p className="oj-review-muted">{new Date(selected.created_at).toLocaleString()} · {selected.status}</p>{selected.result ? <><h4>{selected.result.topic}</h4><ul>{selected.result.key_points.map((point, index) => <li key={index}>{point}</li>)}</ul>{selected.result.observations.map((observation, index) => <blockquote key={index}>{observation.statement}<small>Source: {observation.evidence_ids.map(id => id === 'submission' ? `submission #${submissionId}` : 'problem statement').join(', ')}</small></blockquote>)}<h4>Next practice</h4><p>{selected.result.next_exercise.prompt}</p><p><strong>Check:</strong> {selected.result.next_exercise.expected_check}</p></> : selected.status !== 'running' && <p role="alert">This review did not finish ({selected.error_code || selected.status}). You can generate another review.</p>}</article>}
  </section>
}
