import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, CheckCircle2, Clock3, RefreshCw } from 'lucide-react'
import { apiRequest } from './api'

type Answer = string | string[] | null
type Question = { id: number; position: number; prompt: string; question_type: 'single_choice' | 'multiple_choice' | 'free_text'; options: Array<{ id: string; label: string }>; answer: Answer }
type QuestionSet = { id: number; title: string; mode: string; latest_version_id: number; latest_version_no: number; question_version_ids: number[]; archived: boolean }
type Session = { id: number; set_version_id: number; mode: string; started_at: string; questions: Question[] }
type AttemptSummary = { id: number; total_score: number; scored_question_count: number }
type Attempt = AttemptSummary & { elapsed_seconds: number; revealed: boolean; answers: Array<{ question_version_id: number; position: number; prompt: string; answer: Answer; score: number | null; reference_answer: Answer }> }
type Review = { id: number; verdict: string | null; notes: string; next_action: string | null }

function setAttemptInUrl(attemptId: number | null) {
  const url = new URL(window.location.href)
  if (attemptId === null) url.searchParams.delete('attempt')
  else url.searchParams.set('attempt', String(attemptId))
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
}

function formatAnswer(value: Answer): string {
  if (value === null || value === '') return 'No answer'
  return Array.isArray(value) ? value.join(', ') : value
}

export default function PrepWorkspace({ subjectTitle = 'Prep', returnHref = '/learning/' }: { subjectTitle?: string; returnHref?: string } = {}) {
  const [sets, setSets] = useState<QuestionSet[]>([])
  const [attempts, setAttempts] = useState<AttemptSummary[]>([])
  const [session, setSession] = useState<Session | null>(null)
  const [attempt, setAttempt] = useState<Attempt | null>(null)
  const [reviews, setReviews] = useState<Review[]>([])
  const [elapsed, setElapsed] = useState(0)
  const [status, setStatus] = useState('Loading')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = useRef(new Map<number, Promise<void>>())
  const saveErrors = useRef(new Set<number>())

  const loadLists = useCallback(async () => {
    setError('')
    try {
      const [nextSets, nextAttempts] = await Promise.all([
        apiRequest<QuestionSet[]>('/api/prep/question-sets'),
        apiRequest<AttemptSummary[]>('/api/prep/attempts'),
      ])
      setSets(nextSets.filter((item) => !item.archived))
      setAttempts(nextAttempts)
      setStatus('Ready')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Prep is unavailable')
      setStatus('Unavailable')
    }
  }, [])

  useEffect(() => { void loadLists() }, [loadLists])
  useEffect(() => {
    if (!session) return
    const started = Date.parse(session.started_at)
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - started) / 1000)))
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [session])

  const startSession = async (setVersionId: number) => {
    setBusy(true); setError(''); setStatus('Starting')
    try {
      const next = await apiRequest<Session>('/api/prep/sessions', { method: 'POST', body: JSON.stringify({ set_version_id: setVersionId }) })
      pending.current.clear(); saveErrors.current.clear(); setAttempt(null); setReviews([]); setSession(next); setAttemptInUrl(null); setStatus('Active')
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not start the session'); setStatus('Error') }
    finally { setBusy(false) }
  }

  const saveAnswer = (questionId: number, answer: Answer) => {
    if (!session) return
    setSession({ ...session, questions: session.questions.map((question) => question.id === questionId ? { ...question, answer } : question) })
    const sessionId = session.id
    const previous = pending.current.get(questionId) || Promise.resolve()
    const task = previous.catch(() => undefined).then(async () => {
      const updated = await apiRequest<Session>(`/api/prep/sessions/${sessionId}/answers/${questionId}`, { method: 'PUT', body: JSON.stringify({ answer }) })
      if (sessionId === session.id) setSession(updated)
      saveErrors.current.delete(questionId)
    }).catch((failure) => {
      saveErrors.current.add(questionId)
      setError(failure instanceof Error ? failure.message : 'An answer could not be saved')
    }).finally(() => {
      if (pending.current.get(questionId) === task) pending.current.delete(questionId)
    })
    pending.current.set(questionId, task)
    setStatus('Saving')
  }

  const loadReviews = useCallback(async (attemptId: number) => setReviews(await apiRequest<Review[]>(`/api/prep/attempts/${attemptId}/reviews`)), [])
  const openAttempt = useCallback(async (attemptId: number) => {
    setBusy(true); setError(''); setStatus('Loading attempt')
    try { const next = await apiRequest<Attempt>(`/api/prep/attempts/${attemptId}`); setSession(null); setAttempt(next); await loadReviews(next.id); setAttemptInUrl(next.id); setStatus('Attempt loaded') }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not load the attempt'); setStatus('Error') }
    finally { setBusy(false) }
  }, [loadReviews])

  useEffect(() => {
    const requestedAttempt = Number(new URLSearchParams(window.location.search).get('attempt'))
    if (Number.isInteger(requestedAttempt) && requestedAttempt > 0) void openAttempt(requestedAttempt)
  }, [openAttempt])

  const submit = async () => {
    if (!session) return
    setBusy(true); setError(''); setStatus('Saving answers')
    try {
      await Promise.allSettled([...pending.current.values()])
      if (saveErrors.current.size) throw new Error('One or more answers were not saved. Change them and retry.')
      setStatus('Submitting')
      const result = await apiRequest<{ attempt_id: number }>(`/api/prep/sessions/${session.id}/submit`, { method: 'POST' })
      const next = await apiRequest<Attempt>(`/api/prep/attempts/${result.attempt_id}`)
      setSession(null); setAttempt(next); setAttemptInUrl(next.id); await Promise.all([loadReviews(next.id), loadLists()]); setStatus('Submitted')
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not submit the session'); setStatus('Error') }
    finally { setBusy(false) }
  }

  const reveal = async () => {
    if (!attempt) return
    setBusy(true)
    try { setAttempt(await apiRequest<Attempt>(`/api/prep/attempts/${attempt.id}/reveal`, { method: 'POST' })); setStatus('Reference material revealed') }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not reveal reference material') }
    finally { setBusy(false) }
  }

  const saveReview = async (form: HTMLFormElement) => {
    if (!attempt) return
    const fields = new FormData(form)
    setBusy(true)
    try {
      await apiRequest(`/api/prep/attempts/${attempt.id}/reviews`, { method: 'POST', body: JSON.stringify({ verdict: fields.get('verdict'), tags: [], notes: fields.get('notes'), next_action: fields.get('next_action') || null }) })
      form.reset(); await loadReviews(attempt.id); setStatus('Review saved')
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save the review') }
    finally { setBusy(false) }
  }

  const requestedSet = Number(new URLSearchParams(window.location.search).get('set'))
  const selectedSet = sets.find(set => set.latest_version_id === requestedSet)
  const title = session ? sets.find((item) => item.latest_version_id === session.set_version_id)?.title : null
  return <main className="learning-child prep-workspace">
    <header className="child-heading"><div><span className="section-label">PERSONAL PRACTICE</span><h1>{subjectTitle}</h1><p>Complete a set, submit it, then record what you learned.</p></div><div className="child-actions"><span className="child-status">{status}</span><a href={returnHref}><ArrowLeft size={14} /> {subjectTitle === 'Prep' ? 'Learning' : 'Back to subject'}</a></div></header>
    {error && <div className="child-error" role="alert">{error}</div>}
    {!session && !attempt && selectedSet && <section className="selected-question-set"><h2>{selectedSet.title}</h2><p>{selectedSet.question_version_ids.length} prompts. Start explicitly when ready; opening this link does not create a session.</p><button className="child-primary" disabled={busy} onClick={() => void startSession(selectedSet.latest_version_id)}>Start selected set</button></section>}
    <div className="prep-layout"><aside className="child-sidebar"><div className="child-sidebar-title"><h2>Question sets</h2><button onClick={() => void loadLists()} aria-label="Refresh Prep"><RefreshCw size={14} /></button></div>{sets.map((set) => <button className="child-list-button" key={set.id} disabled={busy} onClick={() => void startSession(set.latest_version_id)}><strong>{set.title}</strong><small>{set.mode.replace('_', ' ')} · v{set.latest_version_no} · {set.question_version_ids.length} questions</small></button>)}{!sets.length && <p className="child-muted">No active question sets.</p>}<h2 className="child-history-title">Recent attempts</h2>{attempts.slice(0, 12).map((item) => <button className="child-list-button child-attempt" key={item.id} onClick={() => void openAttempt(item.id)}><span>Attempt #{item.id}</span><strong>{item.total_score}/{item.scored_question_count}</strong></button>)}</aside>
      <section className="child-content">{!session && !attempt && <div className="child-empty"><CheckCircle2 size={24} /><h2>Choose a question set</h2><p>Select a set to start a focused practice session.</p></div>}
        {session && <><div className="prep-session-header"><div><span className="section-label">{session.mode.replace('_', ' ')}</span><h2>{title || 'Practice session'}</h2></div><div><span className="prep-clock"><Clock3 size={14} />{String(Math.floor(elapsed / 60)).padStart(2, '0')}:{String(elapsed % 60).padStart(2, '0')}</span><button className="child-primary" disabled={busy} onClick={() => void submit()}>Submit</button></div></div><div className="prep-questions">{session.questions.map((question) => <fieldset className="prep-question" key={question.id}><legend>{question.position}. {question.prompt}</legend>{question.question_type === 'free_text' ? <textarea defaultValue={typeof question.answer === 'string' ? question.answer : ''} onBlur={(event) => saveAnswer(question.id, event.currentTarget.value)} /> : question.options.map((option) => <label key={option.id}><input type={question.question_type === 'multiple_choice' ? 'checkbox' : 'radio'} name={`question-${question.id}`} value={option.id} checked={Array.isArray(question.answer) ? question.answer.includes(option.id) : question.answer === option.id} onChange={() => { const current = Array.isArray(question.answer) ? question.answer : []; saveAnswer(question.id, question.question_type === 'multiple_choice' ? (current.includes(option.id) ? current.filter((id) => id !== option.id) : [...current, option.id]) : option.id) }} />{option.label}</label>)}</fieldset>)}</div></>}
        {attempt && <div className="prep-attempt"><h2>Attempt #{attempt.id}</h2><strong className="prep-score">{attempt.total_score} / {attempt.scored_question_count}</strong><p>{attempt.elapsed_seconds}s recorded</p>{attempt.answers.map((answer) => <article key={answer.question_version_id}><strong>{answer.position}. {answer.prompt}</strong><p>Your answer: {formatAnswer(answer.answer)}</p><p>{answer.score === null ? 'Manual review' : answer.score === 1 ? 'Correct' : 'Incorrect'}</p>{attempt.revealed && <p>Reference: {formatAnswer(answer.reference_answer)}</p>}</article>)}{!attempt.revealed && <button className="child-primary" disabled={busy} onClick={() => void reveal()}>Reveal reference material</button>}<section className="prep-review"><h3>Learning review</h3><form onSubmit={(event) => { event.preventDefault(); void saveReview(event.currentTarget) }}><label>Verdict<select name="verdict"><option value="needs_review">Needs review</option><option value="understood">Understood</option><option value="retry">Retry</option></select></label><label>Next action<input name="next_action" maxLength={500} /></label><label>Notes<textarea name="notes" maxLength={20000} /></label><button className="child-primary" disabled={busy}>Save review</button></form>{reviews.map((review) => <article key={review.id}><strong>{review.verdict || 'Review'}</strong><p>{review.notes || 'No notes'}</p>{review.next_action && <small>Next: {review.next_action}</small>}</article>)}</section></div>}
      </section></div>
  </main>
}
