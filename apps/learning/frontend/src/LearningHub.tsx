import { useEffect, useState } from 'react'
import { ArrowRight, BookOpen, Search, Terminal } from 'lucide-react'
import { Coverage, useStudySummary } from './StudyCoverage'
import { apiRequest } from './api'
import { notesRequest, type Catalog } from './notesClient'
import { type PathSummary } from './learningSubjects'
import { availableReadings, courseReadingHref, courseTracks, readingCourses, type CourseTrack } from './courseCatalog'
import { knowledgeTopics } from './knowledgeTopics'
import TechnologyIcon from './TechnologyIcon'
import './courseCatalog.css'

export default function LearningHub({ courseId }: { courseId?: string }) {
  const study = useStudySummary()
  const [catalog, setCatalog] = useState<Catalog | null>(null), [paths, setPaths] = useState<PathSummary[]>([])
  const [readingError, setReadingError] = useState(''), [pathError, setPathError] = useState('')
  const [loading, setLoading] = useState(true), [revision, setRevision] = useState(0)
  const initialTrack = new URLSearchParams(window.location.search).get('track') || 'all'
  const [track, setTrack] = useState(courseTracks.some(item => item.id === initialTrack) ? initialTrack : 'all')
  const [query, setQuery] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setReadingError(''); setPathError('')
    void Promise.allSettled([
      notesRequest<Catalog>('', { signal: controller.signal }).then(value => { if (!Array.isArray(value.notes)) throw new Error('Reading catalog returned an unexpected response'); if (!controller.signal.aborted) setCatalog(value) }).catch(error => { if (!controller.signal.aborted) { setCatalog(null); setReadingError(error instanceof Error ? error.message : 'Reading catalog unavailable') } }),
      apiRequest<PathSummary[]>('/api/codelab/learning/paths', { signal: controller.signal }).then(value => { if (!Array.isArray(value)) throw new Error('Course catalog returned an unexpected response'); if (!controller.signal.aborted) setPaths(value) }).catch(error => { if (!controller.signal.aborted) { setPaths([]); setPathError(error instanceof Error ? error.message : 'Courses unavailable') } }),
    ]).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [revision])
  const notes = (catalog?.notes || []).filter(note => !note.deleted_at)
  const selected = readingCourses.find(course => course.id === courseId)
  const retry = () => setRevision(value => value + 1)
  const failures = <>{readingError && <div className="catalog-message" role="alert">{readingError}<button onClick={retry}>Retry reading</button></div>}{pathError && <div className="catalog-message" role="alert">{pathError}<button onClick={retry}>Retry courses</button></div>}</>
  if (courseId) return <main className="course-directory course-detail">
    <a className="course-back" href={selected ? `/learning/?track=${selected.track}` : '/learning/'}>← All courses</a>
    {!selected ? <><h1>Course not found</h1><p>Choose a course from the catalog.</p></> : <>
      <header className="course-detail-hero" data-track={selected.track}><div className="course-art"><TechnologyIcon technology={selected.id} /></div><div><span className="section-label">{courseTracks.find(item => item.id === selected.track)?.title} · {selected.kind || 'Course'}</span><h1>{selected.title}</h1><p>{selected.description}</p><div className="course-facts"><span>{loading ? 'Loading readings…' : `${availableReadings(selected, notes).length} readings`}</span><span>{selected.practice}</span></div></div></header>
      {failures}
      {loading ? <p role="status">Loading course readings…</p> : <div className="course-detail-layout"><section className="course-syllabus"><header><span className="section-label">YOUR LEARNING SEQUENCE</span><h2>Course syllabus</h2></header>{selected.overview && notes.some(note => note.id === selected.overview) && <a className="course-overview-link" href={courseReadingHref(selected, selected.overview)}><BookOpen size={18} /><span>Start here<strong>Learning plan and practice approach</strong></span><ArrowRight size={17} /></a>}<ol>{selected.readings.map((reading, index) => <li key={reading.noteId}><span className="syllabus-number">{String(index + 1).padStart(2, '0')}</span>{notes.some(note => note.id === reading.noteId) ? <a href={courseReadingHref(selected, reading.noteId)}>{reading.title}<ArrowRight size={16} /></a> : <span>{reading.title}<small>Reading unavailable</small></span>}</li>)}</ol></section><aside className="course-practice"><Terminal size={22} /><h2>Think, explain, then practise</h2><p>Start with a question: what do you expect, and why? Read for a hint, explain the idea in your own words, then test it with a small change. Compare the result and revise your explanation.</p><strong>{selected.practice}</strong><p>{selected.track === 'go' ? 'Write and run the examples in GoLand. Predict the result, change one thing and observe what happens.' : 'Use a small, synthetic example to check the idea. Compare the result with your prediction.'}</p><hr /><BookOpen size={20} /><h3>Your own understanding</h3><p>Revisit concept references in Knowledge. Create your own observations and explanations separately in Notes.</p><a href={`/learning/knowledge/topics/${knowledgeTopics.find(topic => topic.courses.includes(selected.id))?.id || ''}`}>Read concept references <ArrowRight size={14} /></a></aside></div>}
    </>}
  </main>
  const matches = (title: string, description: string, itemTrack: CourseTrack) => (track === 'all' || track === itemTrack) && `${title} ${description}`.toLowerCase().includes(query.trim().toLowerCase())
  const readings = readingCourses.filter(course => matches(course.title, course.description, course.track))
  const live = paths.filter(path => path.id && path.title && matches(path.title, path.objective, path.subject === 'sql' ? 'backend' : 'python'))
  const chooseTrack = (id: string) => { setTrack(id); const url = new URL(window.location.href); if (id === 'all') url.searchParams.delete('track'); else url.searchParams.set('track', id); window.history.replaceState({}, '', url) }
  return <main className="course-directory">
    <header className="course-catalog-heading"><div><span className="section-label">YOUR CODEOS CURRICULUM</span><h1>What will you build next?</h1><p>Learn Python and Go. Understand backend systems. Build AI applications.</p></div><a className="course-knowledge-link" href="/learning/knowledge/">Knowledge models <ArrowRight size={16} /></a></header>
    <nav className="course-track-filters" aria-label="Course directions"><button aria-pressed={track === 'all'} onClick={() => chooseTrack('all')}>All courses</button>{courseTracks.map(item => <button key={item.id} aria-pressed={track === item.id} onClick={() => chooseTrack(item.id)}>{item.title}</button>)}</nav>
    <div className="course-catalog-toolbar"><p>{track === 'all' ? 'A practical path, one course at a time.' : courseTracks.find(item => item.id === track)?.description}</p><label className="course-search"><Search size={16} /><input aria-label="Find a course" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find Go, SQL, agents…" /></label></div>
    {failures}{loading && <p role="status">Loading your courses…</p>}
    <div className="course-track-sections" aria-label="Course catalog">{courseTracks.filter(group => readings.some(course => course.track === group.id) || live.some(path => (path.subject === 'sql' ? 'backend' : 'python') === group.id)).map(group => <section className="course-track-section" key={group.id}><header><h2>{group.title}</h2><p>{group.description}</p></header><div className="course-card-grid">
      {readings.filter(course => course.track === group.id).map(course => { const count = availableReadings(course, notes).length; return <article className="curriculum-card" data-track={course.track} key={course.id}><a className="curriculum-card-link" href={`/learning/courses/${course.id}`}><div className="course-art"><TechnologyIcon technology={course.id} /><span>{course.track === 'go' ? 'GO' : course.track === 'python' ? 'PY' : course.id === 'rag' ? 'RAG' : course.track === 'ai' ? 'AI' : course.id === 'databases' ? 'SQL' : 'BACKEND'}</span></div><div className="curriculum-card-body"><span className="course-type">{course.kind || 'Course'} · {courseTracks.find(item => item.id === course.track)?.title}</span><h2>{course.title}</h2><p>{course.description}</p><div className="curriculum-card-meta"><span>{loading ? 'Loading readings…' : readingError ? 'Readings unavailable' : `${count} ${count === 1 ? 'reading' : 'readings'}`}</span><span>{course.practice}</span></div></div></a><footer className="curriculum-card-footer"><a href={`/learning/courses/${course.id}`}>Explore {course.kind === 'Project' ? 'project' : 'course'} <ArrowRight size={14} /></a></footer></article> })}
      {live.filter(path => (path.subject === 'sql' ? 'backend' : 'python') === group.id).map(path => <article className="curriculum-card live-curriculum-card" data-track={path.subject === 'sql' ? 'backend' : 'python'} key={path.id}><a className="curriculum-card-link" href={`/learning/paths/${encodeURIComponent(path.id)}`}><div className="course-art"><TechnologyIcon technology={path.subject === 'sql' ? 'sql' : 'python'} /><span>{path.subject === 'sql' ? 'SQL' : 'PY · ACM'}</span></div><div className="curriculum-card-body"><span className="course-type">Practice course · {path.subject === 'sql' ? 'Backend development' : 'Python'}</span><h2>{path.title}</h2><p>{path.objective}</p><div className="curriculum-card-meta"><span>{path.lessons.length} {path.lessons.length === 1 ? 'lesson' : 'lessons'}</span><span>{path.subject === 'sql' ? 'Jupy · SQL' : 'Jupy · OJ'}</span></div></div></a><footer className="curriculum-card-footer"><a href={`/learning/paths/${encodeURIComponent(path.id)}`}>Open course <ArrowRight size={14} /></a><Coverage compact value={study.summary[path.id]} /></footer></article>)}
    </div></section>)}</div>
    {!loading && !readings.length && !live.length && <p className="catalog-message">No courses match. Try another subject or search.</p>}
    {study.error && <p className="catalog-message" role="alert">Course coverage unavailable. <button onClick={study.retry}>Retry coverage</button></p>}
    <footer className="course-directory-footer"><span>Experiment freely. Keep your own understanding.</span><a href="/codelab/lab">Open Lab</a><a href="/codelab/oj">Solve in OJ</a><a href="/learning/interviews">Interview practice</a><a href="/learning/knowledge/">Knowledge</a></footer>
  </main>
}
