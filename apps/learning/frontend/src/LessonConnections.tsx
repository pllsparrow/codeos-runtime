import { useEffect, useRef, useState, type ReactNode } from 'react'
import NotesMarkdown from './NotesMarkdown'
import { notesRequest, type Note } from './notesClient'
import { studyRequest, type StudySummary } from './StudyCoverage'
import { lessonStage, type LessonStage } from './lessonWorkspace'
import { requestId } from './requestId'

type LinkedNote = { note_id: number; title: string; path: string; updated_at: string; deleted_at: string | null }
type Lesson = { id: string; reading_note_id: number | null; path_id: string; resources: { kind: string; reference: string }[] }
export default function LessonConnections({ lesson, stage, restoreStage, children }: { lesson: Lesson; stage: LessonStage; restoreStage: (value: LessonStage) => void; children?: ReactNode }) {
  const [reading, setReading] = useState<Note>(), [readingError, setReadingError] = useState('')
  const [links, setLinks] = useState<LinkedNote[] | null>(null)
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [ready, setReady] = useState(false), [revision, retry] = useState(0), [readingRevision, retryReading] = useState(0)
  const [problemError, setProblemError] = useState(''), [problemRevision, retryProblem] = useState(0)
  const [problem, setProblem] = useState<{ practice_url?: string; title: string }>()
  const [confirmedRevision, setConfirmedRevision] = useState<string | null>(null)
  const restoreRef = useRef(restoreStage); restoreRef.current = restoreStage
  const writeQueue = useRef<Promise<unknown>>(Promise.resolve())
  const context = `learning_context=${encodeURIComponent(lesson.id)}`
  useEffect(() => {
    let active = true
    setReady(false); setError('')
    void Promise.allSettled([studyRequest<StudySummary>('/study'), studyRequest<LinkedNote[]>(`/lessons/${lesson.id}/notes`)]).then(([summary, linked]) => {
      if (!active) return
      const failures: string[] = []
      if (linked.status === 'fulfilled' && Array.isArray(linked.value)) setLinks(linked.value)
      else { setLinks(null); failures.push(linked.status === 'rejected' ? linked.reason.message : 'Note links unavailable') }
      if (summary.status === 'fulfilled') {
        const saved = summary.value[lesson.path_id]?.lessons?.[lesson.id]
        if (saved && !new URLSearchParams(window.location.search).has('stage')) restoreRef.current(lessonStage(`?stage=${saved.stage}`))
        setReady(true)
      } else failures.push(summary.reason.message)
      setError(failures.join(' · '))
    })
    return () => { active = false }
  }, [lesson.id, lesson.path_id, revision])
  useEffect(() => {
    let active = true
    setReading(undefined); setReadingError('')
    if (lesson.reading_note_id) void notesRequest<Note>(`/notes/${lesson.reading_note_id}`).then(value => { if (active) { if (value.deleted_at) setReadingError('This reading is in Trash.'); else setReading(value) } }).catch(failure => { if (active) setReadingError(failure.message) })
    else setReadingError('No reading is linked to this lesson.')
    return () => { active = false }
  }, [lesson.id, lesson.reading_note_id, readingRevision])
  useEffect(() => {
    let active = true
    setProblem(undefined); setProblemError('')
    const index = lesson.resources.find(item => item.kind === 'oj')?.reference.split(':')[0]
    if (index && /^\d+$/.test(index)) void fetch(`/api/codelab/coding/problems/${index}`, { signal: AbortSignal.timeout(15000) }).then(async response => { if (!response.ok) throw new Error('Problem reference unavailable'); return response.json() }).then(value => { const reference = lesson.resources.find(item => item.kind === 'oj')?.reference; if (`${value.index}:${value.slug}` !== reference) throw new Error('The linked problem identity changed. Refresh the lesson.'); if (active) setProblem(value) }).catch(failure => { if (active) setProblemError(failure.message) })
    return () => { active = false }
  }, [lesson.id, problemRevision])
  useEffect(() => {
    if (!ready) return
    let active = true
    const timer = window.setTimeout(() => {
      const key = requestId()
      writeQueue.current = writeQueue.current.catch(() => {}).then(async () => {
        await studyRequest(`/lessons/${lesson.id}/position`, { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify({ stage }) })
        const saved = await studyRequest<{ stage: string; reading_revision: string | null }>(`/lessons/${lesson.id}/position`)
        if (saved.stage !== stage) throw new Error('Study position changed in another page; your current lesson stays open.')
        if (active) setConfirmedRevision(saved.reading_revision)
      }).catch(failure => { if (active) setError(`Position not saved: ${failure.message}`) })
    }, 300)
    return () => { active = false; window.clearTimeout(timer) }
  }, [ready, lesson.id, stage, revision])
  const confirmReading = async () => {
    if (!reading || busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      await writeQueue.current.catch(() => {})
      await studyRequest(`/lessons/${lesson.id}/position`, { method: 'POST', headers: { 'Idempotency-Key': requestId() }, body: JSON.stringify({ stage, reading_revision: reading.updated_at }) })
      const saved = await studyRequest<{ reading_revision: string }>(`/lessons/${lesson.id}/position`)
      if (saved.reading_revision !== reading.updated_at) throw new Error('Reading coverage could not be confirmed. Retry.')
      setConfirmedRevision(saved.reading_revision); setNotice('Reading coverage saved.')
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to confirm reading') } finally { setBusy(false) }
  }
  return <>
    {error && <div className="lesson-connection-error" role="alert">{error}<button disabled={busy} onClick={() => retry(value => value + 1)}>Retry study information</button></div>}
    {notice && <p className="lesson-connection-notice" role="status">{notice}</p>}
    <div className="lesson-inline-reading" hidden={stage !== 'read'}>
      {readingError ? <p role="alert">{readingError} <button onClick={() => retryReading(value => value + 1)}>Retry reading</button></p> : reading ? <><NotesMarkdown content={reading.content} /><div className="reading-confirm"><span>{confirmedRevision === reading.updated_at ? 'Current reading covered' : 'Read at your pace, then record your coverage.'}</span><button disabled={busy || confirmedRevision === reading.updated_at} onClick={() => void confirmReading()}>{confirmedRevision === reading.updated_at ? 'Reading recorded' : 'Record reading coverage'}</button><button disabled={busy} onClick={() => retryReading(value => value + 1)}>Refresh reading</button></div><div className="lesson-stage-actions"><button className="lesson-primary" onClick={() => restoreStage('experiment')}>Continue to experiment →</button></div></> : <p role="status">Loading lesson reading…</p>}
    </div>
    {stage === 'solve' && problemError && <p role="alert">{problemError} <button onClick={() => retryProblem(value => value + 1)}>Retry problem reference</button></p>}
    {stage === 'solve' && problem?.practice_url && /^https:\/\/(www\.)?neetcode\.io\//.test(problem.practice_url) && <p className="lesson-reference"><a href={problem.practice_url} target="_blank" rel="noreferrer">NeetCode · {problem.title} ↗</a></p>}
    {children}
    <section className="lesson-personal-notes" aria-label="Personal lesson notes"><header><div><span className="section-label">RELATED UNDERSTANDING</span><h2>Personal notes</h2></div></header><p>Read your own explanation alongside the course.</p>
      {links === null ? <p>Note links are unavailable.</p> : links.length ? <ul>{links.map(item => <li key={item.note_id}>{item.deleted_at ? <span>{item.title} · Archived</span> : <a href={`/learning/knowledge/notes/${item.note_id}?${context}`}>{item.title}</a>}</li>)}</ul> : <p>No personal notes linked yet.</p>}
    </section>
  </>
}
