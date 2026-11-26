import { readerHref } from './contentRegistry'
import LessonSubmissions from './LessonSubmissions'
import LessonConnections from './LessonConnections'
import { Coverage, useStudySummary } from './StudyCoverage'
import { requestId } from './requestId'
import { lessonStages, lessonStage, stageHref, type LessonStage } from './lessonWorkspace'
import { subjects, type PathSummary, type Subject } from './learningSubjects'
import { isLessonExperiment, recoverRequests } from './learningRecovery'
import { useEffect, useRef, useState } from 'react'
const base = '/api/codelab/learning/paths'
const learningEdition = import.meta.env.VITE_CODEOS_LEARNING_EDITION === 'true'
type Lesson = { subject?: Subject; stage?: string; experiment_plan?: string[]; experiment_setup?: string; updated_at: string; id: string; path_id: string; path_title: string; title: string; objective: string; reading_note_id: number | null; revision: number; resources: { kind: string; reference: string; updated_at: string }[]; checkpoints: { id: number; explanation: string; curriculum_revision: number; evidence: { notebook: { revision: string } | null; submission: { verdict: string } | null }; created_at: string }[]; evidence: Record<string, { status: string; revision?: string; message?: string; has_execution?: boolean; stale_execution?: boolean }> }
class LearningFailure extends Error { constructor(message: string, public status: number) { super(message) } }
async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json', ...options.headers } })
  const body = await response.json()
  if (!response.ok) throw new LearningFailure(body.detail || `Request failed (${response.status})`, response.status)
  return body as T
}
export default function LearningPaths() {
  const study = useStudySummary()
  const identity = window.location.pathname.match(/\/lessons\/([a-z0-9-]+)\/?$/)?.[1]
  const pathIdentity = window.location.pathname.match(/^\/learning\/paths\/([a-z0-9-]+)\/?$/)?.[1]
  const selectedSubject = window.location.pathname.startsWith('/learning/sql') ? 'sql' : window.location.pathname.startsWith('/learning/algorithms') ? 'algorithms' : null
  const [activeStage, setActiveStage] = useState<LessonStage>(() => lessonStage(window.location.search))
  const goStage = (stage: LessonStage) => {
    setActiveStage(stage)
    window.history.replaceState(window.history.state, '', stageHref(window.location.pathname, window.location.search, stage))
  }
  useEffect(() => {
    const restoreStage = () => setActiveStage(lessonStage(window.location.search))
    window.addEventListener('popstate', restoreStage)
    return () => window.removeEventListener('popstate', restoreStage)
  }, [])
  const [paths, setPaths] = useState<PathSummary[]>([])
  const [lesson, setLesson] = useState<Lesson>()
  const [error, setError] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [notice, setNotice] = useState('')
  const [notebook, setNotebook] = useState(''), [explanation, setExplanation] = useState(''), [submission, setSubmission] = useState('')
  const reflectionRef = useRef({ explanation, submission })
  reflectionRef.current = { explanation, submission }
  const pending = useRef(new Map<string, { body: string; key: string }>())
  const working = useRef(false)
  const draftKey = `codeos.learning.lesson.${identity || 'catalog'}`
  const receiptKey = draftKey + '.requests'
  useEffect(() => { try { pending.current = recoverRequests(sessionStorage.getItem(receiptKey), identity || '') } catch { /* Optional retry recovery. */ } }, [receiptKey, identity])
  const rememberRequests = () => { try { sessionStorage.setItem(receiptKey, JSON.stringify([...pending.current])) } catch { /* Retain the current in-memory request. */ } }
  const forgetRequest = (url: string) => { pending.current.delete(url); rememberRequests() }
  useEffect(() => { try { setExplanation(sessionStorage.getItem(draftKey) || '') } catch { /* Optional recovery storage. */ } }, [draftKey])
  useEffect(() => { try { sessionStorage.setItem(draftKey, explanation) } catch { /* Keep the current draft even without storage. */ } }, [draftKey, explanation])
  useEffect(() => { if (!explanation) return; const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }; window.addEventListener('beforeunload', protect); return () => window.removeEventListener('beforeunload', protect) }, [explanation])
  const load = async () => {
    setLoading(true); setError('')
    try {
      setPaths(await request<typeof paths>(base))
      if (identity) { const data = await request<Lesson>(`${base}/lessons/${identity}`); setLesson(data); setNotebook(current => current || data.resources.find(r => r.kind === 'notebook')?.reference || '') }
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Learning Paths unavailable') } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [identity])
  const write = async <T,>(url: string, payload: unknown): Promise<T> => {
    const old = pending.current.get(url)
    const value = payload as Record<string, unknown>
    const previous = old ? JSON.parse(old.body) as Record<string, unknown> : null
    const sameIntent = previous && (url.endsWith('/checkpoints') ? previous.explanation === value.explanation && previous.submission_id === value.submission_id : url.endsWith('/reading') ? previous.note_id === value.note_id : previous.reference === value.reference)
    const body = sameIntent ? old!.body : JSON.stringify(payload)
    const key = old?.body === body ? old.key : requestId()
    pending.current.set(url, { body, key }); rememberRequests()
    try { return await request<T>(url, { method: 'POST', headers: { 'Idempotency-Key': key }, body }) } catch (failure) { if (failure instanceof LearningFailure && [409,422].includes(failure.status)) forgetRequest(url); throw failure }
  }
  const action = async (perform: () => Promise<void>) => {
    if (working.current) return
    working.current = true; setBusy(true); setError(''); setNotice('')
    try { await perform() } catch (failure) { setError(failure instanceof Error ? failure.message : 'Action failed; draft retained') }
    finally { working.current = false; setBusy(false) }
  }
  const bind = async (path = notebook) => {
    if (!lesson) return
    const url = `${base}/lessons/${identity}/notebook`
    const saved = await write<{ reference: string; updated_at: string }>(url, { reference: path, expected_version: lesson.resources.find(r => r.kind === 'notebook')?.updated_at || null })
    const verified = await request<Lesson>(`${base}/lessons/${identity}`)
    if (!verified.resources.some(r => r.kind === 'notebook' && r.reference === saved.reference && r.updated_at === saved.updated_at)) throw new Error('Association read-back did not match; draft retained')
    forgetRequest(url); setLesson(verified); setNotebook(path); setNotice('Notebook association saved and confirmed')
  }
  const createPath = useRef('')
  if (!createPath.current) {
    let saved = ''
    try { saved = sessionStorage.getItem(draftKey + '.experiment') || '' } catch { /* Optional creation recovery. */ }
    createPath.current = isLessonExperiment(saved, identity || '') ? saved : `workspace/course--${identity || 'lesson'}-${requestId()}.ipynb`
  }
  const create = async () => {
    if (!lesson) return
    const path = createPath.current, url = `/api/codelab/lab/workspaces/${path}`
    try { sessionStorage.setItem(draftKey + '.experiment', path) } catch { /* Retain the current creation identity. */ }
    const cell = (cell_type: 'markdown' | 'code', source: string) => ({ cell_type, source, execution_count: null, output_count: 0 })
    const steps = lesson.experiment_plan || []
    const cells = [cell('markdown', `# Goal\n${lesson.objective}`), cell('markdown', '## Prediction\nWrite your expected result before running.')]
    if (lesson.experiment_setup) cells.push(cell('markdown', '## Synthetic setup\nRun once in a new kernel before the query experiments. This creates only an in-memory teaching fixture.'), cell('code', lesson.experiment_setup))
    if (steps.length) steps.forEach((step, index) => cells.push(cell('markdown', `## Experiment ${index + 1}\n${step}\n\nPredict before writing code.`), cell('code', ''), cell('markdown', '### Observation\nRecord expected and actual results, then explain any difference.')))
    else cells.push(cell('code', ''))
    if (lesson.subject === 'sql') cells.push(cell('markdown', '## Final query\nWrite your own complete query and compare its rows with the reading contract. There is no automatic SQL verdict.'), cell('code', ''))
    cells.push(cell('markdown', '## Observation and checkpoint\nRecord what happened, an edge case, and what you can explain.'))
    const payload = { notebook: { path, title: `${lesson.title} — Experiment`, language: 'python', cells }, create_only: true }
    const cached = pending.current.get(url), body = cached?.body || JSON.stringify(payload)
    const key = cached?.key || requestId(); pending.current.set(url, { body, key }); rememberRequests()
    await request(url, { method: 'PUT', headers: { 'Idempotency-Key': key }, body })
    const verified = await request<{ resource_path: string }>(url)
    if (verified.resource_path !== path) throw new Error('Notebook creation is not yet confirmed')
    setNotebook(path); setNotice('Notebook created. If association fails, bind the retained path; do not recreate it.')
    await bind(path)
    forgetRequest(url)
    try { sessionStorage.removeItem(draftKey + '.experiment') } catch { /* Binding is already confirmed through the API. */ }
  }
  const confirm = async () => {
    if (!lesson) return
    const url = `${base}/lessons/${identity}/checkpoints`
    const saved = await write<{ id: number }>(url, { explanation, submission_id: submission ? Number(submission) : null, expected_id: lesson.checkpoints[0]?.id || null, expected_revision: lesson.revision, expected_reading_revision: lesson.evidence.reading?.revision, expected_notebook_revision: lesson.evidence.notebook?.revision || null })
    const verified = await request<Lesson>(`${base}/lessons/${identity}`)
    if (!verified.checkpoints.some(c => c.id === saved.id && c.explanation === explanation)) throw new Error('Checkpoint read-back unconfirmed; reflection retained')
    forgetRequest(url); setLesson(verified)
    const unchanged = reflectionRef.current.explanation === explanation && reflectionRef.current.submission === submission
    if (unchanged) { setExplanation(''); setSubmission('') }
    setNotice(unchanged ? 'Checkpoint saved and confirmed. Practice facts and understanding remain separate evidence.' : 'Earlier checkpoint saved and confirmed. Newer reflection is retained as an unsaved draft.')
  }
  const pathLessons = paths.find(path => path.id === lesson?.path_id)?.lessons || []
  const lessonIndex = pathLessons.findIndex(item => item.id === identity)
  const nextLesson = lessonIndex >= 0 ? pathLessons[lessonIndex + 1] : undefined
  const teachingBrief = lesson ? [
    'Teach me this CodeOS lesson through prediction, small experiments and explanation; do not start with a complete solution.',
    `Lesson: ${lesson.title}`, `Goal: ${lesson.objective}`,
    `Reading Note: ${lesson.reading_note_id || 'not linked'}`,
    ...lesson.resources.map(resource => `${resource.kind}: ${resource.reference}`),
    'Ask me to describe the problem contract and unresolved assumptions first. Keep prediction, experiment, judge result and understanding separate.',
    lesson.subject === 'sql' ? 'I will write SQL queries against the synthetic in-memory fixture, compare expected rows, save observations in Jupy and explicitly confirm a reflection. No automatic SQL judge is attached.' : learningEdition ? 'I will save my prediction and observations in Jupy, then confirm a reflection.' : 'I will save my own prediction and observations in Jupy, complete the ACM program in OJ, and explicitly confirm a reflection in Learning.'
  ].join('\n') : ''
  const copyTeachingBrief = async () => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(teachingBrief)
      setNotice('Teaching brief copied; choose what to share with your external AI.')
    } catch { setNotice('Clipboard unavailable; select and copy the teaching brief manually.') }
  }
  const context = `learning_context=${encodeURIComponent(identity || '')}`
  const boundNotebook = lesson?.resources.find(r => r.kind === 'notebook')
  const problem = lesson?.resources.find(r => r.kind === 'oj')?.reference.split(':')[0]
  const selectedPath = pathIdentity ? paths.find(path => path.id === pathIdentity) : undefined
  const subject = lesson?.subject || selectedPath?.subject || selectedSubject
  const subjectInfo = subjects.find(item => item.id === subject)
  const visiblePaths = pathIdentity ? paths.filter(path => path.id === pathIdentity) : selectedSubject ? paths.filter(path => (path.subject || 'algorithms') === selectedSubject) : paths
  return <main className="learning-paths"><header><a href="/learning/">Learning</a><h1>{lesson?.title || selectedPath?.title || subjectInfo?.title || 'Courses'}</h1><p>{lesson?.objective || selectedPath?.objective || subjectInfo?.description || 'Choose a subject and follow its learning path.'}</p></header>
    {error && <div role="alert">{error}<button disabled={busy} onClick={() => void load()}>Refresh / Retry</button></div>}{error && lesson && <p>Previously loaded lesson retained; evidence may be unavailable or out of date.</p>}{notice && <p role="status">{notice}</p>}{loading && <p role="status">Loading curriculum…</p>}
    {!identity && !pathIdentity && <nav className="subject-tabs" aria-label="Learning subjects">{subjects.map(item => <a className="path-action" key={item.id} href={item.href}>{item.title}</a>)}</nav>}
    {!identity && !loading && !error && !visiblePaths.length && <div className="catalog-state"><p>{pathIdentity ? 'This course is unavailable or no longer published.' : 'No courses are saved for this subject yet.'}</p><a className="path-action" href="/learning/">Browse courses</a></div>}
    {!identity && !loading && !error && visiblePaths.map(path => <section key={path.id}><h2>{pathIdentity ? 'Course syllabus' : <a href={`/learning/paths/${encodeURIComponent(path.id)}`}>{path.title}</a>}</h2>{!pathIdentity && <p>{path.objective}</p>}<p className="course-lesson-count">{path.lessons.length} lessons</p><Coverage value={study.summary[path.id]} />{study.summary[path.id]?.resume && <a className="path-action" href={`/learning/paths/${path.id}/lessons/${study.summary[path.id].resume!.lesson_id}?stage=${study.summary[path.id].resume!.stage}`}>Continue · {study.summary[path.id].resume!.title}</a>}{path.overview_note_id && <a className="path-action" href={readerHref(path.overview_note_id)}>Read roadmap</a>}{[...new Set(path.lessons.map(item => item.stage || 'Lessons'))].map(stage => <div className="lesson-stage" key={stage}><h3>{stage}</h3>{path.lessons.filter(item => (item.stage || 'Lessons') === stage).map(item => <div className="lesson-entry" key={item.id}><a href={`/learning/paths/${path.id}/lessons/${item.id}`}>{item.title}</a><small>{study.summary[path.id]?.lessons?.[item.id] ? `${study.summary[path.id].lessons[item.id].items.filter(value => value.covered).length} / ${study.summary[path.id].lessons[item.id].items.length} covered` : 'Coverage unavailable'}{item.checkpoint_count ? <span> · {item.checkpoint_count} checkpoints</span> : null}</small></div>)}</div>)}</section>)}
    {study.error && <p className="study-error">Coverage unavailable. <button onClick={study.retry}>Retry coverage</button></p>}
    {lesson && <div className="lesson-workspace">
      <details className="lesson-syllabus"><summary>Course lessons · {lessonIndex + 1} / {pathLessons.length}</summary><nav aria-label="Course syllabus">{pathLessons.map((item, index) => <a key={item.id} aria-current={item.id === identity ? 'page' : undefined} href={`/learning/paths/${lesson.path_id}/lessons/${item.id}`}><span>{String(index+1).padStart(2,'0')}</span>{item.title}</a>)}</nav></details>
      <div className="lesson-breadcrumb"><a href={subjectInfo?.href || '/learning/paths'}>{subjectInfo?.title || 'All paths'}</a><span>/</span><a href={`/learning/paths/${encodeURIComponent(lesson.path_id)}`}>{lesson.path_title}</a>{lesson.stage && <small>{lesson.stage}</small>}</div>
      <nav className="lesson-stages" aria-label="Lesson stages">{lessonStages.filter(stage => !learningEdition || stage.id !== 'solve').map((stage, index) => <button key={stage.id} aria-current={activeStage === stage.id ? 'step' : undefined} onClick={() => goStage(stage.id)}><span className="lesson-stage-number">{index + 1}</span><span>{stage.title}<small>{stage.id === 'solve' && subject === 'sql' ? 'Compare query results' : stage.description}</small></span></button>)}</nav>
      <div className="lesson-evidence-summary" aria-label="Lesson evidence"><span>Reading · {lesson.evidence.reading?.status || 'unavailable'}</span><span>Experiment · {lesson.evidence.notebook?.status || 'not linked'}{lesson.evidence.notebook?.stale_execution ? ' · stale output' : lesson.evidence.notebook?.has_execution ? ' · execution recorded' : ''}</span><span>Reflection · {lesson.checkpoints.length ? 'saved checkpoints' : 'not recorded'}</span></div>
      <section className="lesson-panel" hidden={activeStage !== 'read'} aria-labelledby="lesson-read-title">
        <span className="section-label">READING & PREDICTION</span><h2 id="lesson-read-title">Read</h2><p>{lesson.objective}</p><p>Understand the rule and predict a small example before writing the complete program.</p>
        {lesson.evidence.reading?.status === 'available' && <a className="path-action" href={`${readerHref(lesson.reading_note_id!)}?${context}`}>Open reading</a>}


      </section>
      <LessonConnections lesson={lesson} stage={activeStage} restoreStage={goStage}>
      <section className="lesson-panel" hidden={activeStage !== 'experiment'} aria-labelledby="lesson-experiment-title">
        <span className="section-label">JUPY · SMALL EXPERIMENTS</span><h2 id="lesson-experiment-title">Experiment</h2><p>Predict first; keep success and boundary observations. Saving and execution are separate evidence.</p>
        {!!lesson.experiment_plan?.length && <div><h3>Experiment plan</h3><ol>{lesson.experiment_plan.map((step, index) => <li className="experiment-step" key={index}>{step}</li>)}</ol></div>}
        <p>{lesson.evidence.notebook?.status || 'Not linked'}{lesson.evidence.notebook?.has_execution ? ' · execution recorded' : ' · execution not recorded'}{lesson.evidence.notebook?.stale_execution ? ' · output belongs to earlier or unknown source' : ''}</p>
        {boundNotebook && ['available','changed'].includes(lesson.evidence.notebook?.status) && <a className="path-action" href={`/codelab/jupy?notebook=${encodeURIComponent(boundNotebook.reference)}&${context}`}>Open experiment</a>}
        {!boundNotebook && <button className="lesson-primary" disabled={busy || !!notebook} onClick={() => void action(create)}>Create experiment</button>}
        <details className="lesson-repair" open={!!notebook && !boundNotebook || !!boundNotebook && !['available','changed'].includes(lesson.evidence.notebook?.status || '')}><summary>Bind or repair a saved Notebook</summary><label>Saved Notebook path<input disabled={busy} value={notebook} onChange={e => setNotebook(e.target.value)} placeholder="workspace/example.ipynb" /></label><button disabled={busy || !notebook} onClick={() => void action(() => bind())}>Bind / refresh association</button></details>
        <div className="lesson-stage-actions"><button onClick={() => goStage('read')}>← Reading</button><button className="lesson-primary" onClick={() => goStage(learningEdition ? 'reflect' : 'solve')}>{learningEdition ? 'Continue to reflection →' : 'Continue to solve →'}</button></div>
      </section>
      <section className="lesson-panel" hidden={learningEdition || activeStage !== 'solve'} aria-labelledby="lesson-solve-title">
        <span className="section-label">{subject === 'sql' ? 'QUERY CONTRACT' : 'OJ · ACM PROGRAM'}</span><h2 id="lesson-solve-title">{subject === 'sql' ? 'Query practice' : 'Solve'}</h2>
        {subject === 'sql' ? <><p>Write the final query against the synthetic fixture and compare expected rows. No automatic SQL judge is attached.</p>{boundNotebook && ['available','changed'].includes(lesson.evidence.notebook?.status) && <a className="path-action" href={`/codelab/jupy?notebook=${encodeURIComponent(boundNotebook.reference)}&${context}`}>Open query practice</a>}</> : <><p>Write a complete stdin → stdout program. Run uses your custom input; Submit checks the problem cases. Accepted is judge evidence, not mastery.</p><p>{lesson.evidence.oj?.status || 'No judge attached'}</p>{lesson.evidence.oj?.status === 'available' && <a className="path-action" href={`/codelab/oj/problem/${problem}?${context}`}>Open ACM problem</a>}</>}
        <div className="lesson-stage-actions"><button onClick={() => goStage('experiment')}>← Experiment</button><button className="lesson-primary" onClick={() => goStage('reflect')}>Return and reflect →</button></div>
      </section>
      <div hidden={activeStage !== 'reflect'}>
        <section className="lesson-panel" aria-labelledby="lesson-reflect-title"><span className="section-label">YOUR EXPLANATION · REAL EVIDENCE</span><h2 id="lesson-reflect-title">Confirm a checkpoint</h2><label>Your prediction, rule, boundary case and explanation<textarea value={explanation} onChange={e => setExplanation(e.target.value)} maxLength={20000} /></label>{!learningEdition && subject !== 'sql' && <LessonSubmissions problem={problem} active={activeStage === 'reflect'} select={setSubmission} />}{!learningEdition && subject !== 'sql' && <label>Submission ID (optional)<input type="number" min="1" value={submission} onChange={e => setSubmission(e.target.value)} /></label>}<p>Saved experiments and submission facts are checked independently. A checkpoint can record remaining confusion; it does not mark mastery.</p><div className="lesson-stage-actions"><button onClick={() => goStage(learningEdition ? 'experiment' : 'solve')}>{learningEdition ? '← Revisit experiment' : '← Revisit solution'}</button><button className="lesson-primary" disabled={busy || !explanation.trim()} onClick={() => void action(confirm)}>{busy ? 'Saving…' : 'Confirm checkpoint'}</button></div></section>
        <section><h2>Recent checkpoints</h2>{!lesson.checkpoints.length && <p>No checkpoint confirmed yet.</p>}{lesson.checkpoints.map(c => <article key={c.id}><strong>#{c.id} · {new Date(c.created_at).toLocaleString()}</strong><p>{c.explanation}</p><small>Explanation: owner-confirmed · Experiment: {c.evidence.notebook ? c.evidence.notebook.revision !== lesson.evidence.notebook?.revision ? 'historical snapshot' : 'snapshot attached' : 'not attached'} · Submission: {c.evidence.submission?.verdict || 'not attached'}{c.curriculum_revision !== lesson.revision ? ' · older curriculum' : ''}</small></article>)}</section>
        {nextLesson && <a className="path-action" href={`/learning/paths/${lesson.path_id}/lessons/${nextLesson.id}`}>Next lesson · {nextLesson.title}</a>}
      </div>
      <details className="lesson-teaching"><summary>Teaching bridge · external AI</summary><p>Use external AI for teaching now. Save your learning work in CodeOS. Copying does not send data or run code.</p><textarea aria-label="Teaching brief" readOnly value={teachingBrief} /><button onClick={() => void copyTeachingBrief()}>Copy teaching brief</button></details>
      </LessonConnections>
    </div>}
  </main>
}
