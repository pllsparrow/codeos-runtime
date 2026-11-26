import { useEffect, useState } from 'react'
import { ArrowRight, BookOpen, FileText, Search } from 'lucide-react'
import { planNoteIds, readerHref, reviewNoteIds } from './contentRegistry'
import { notesRequest, type Catalog, type NoteMeta } from './notesClient'
import { courseTracks, readingCourses, supplementalReferenceIds, teachingNoteIds } from './courseCatalog'
import { knowledgeReferenceIds, knowledgeTopics, topicReadings, topicReadingHref } from './knowledgeTopics'
import TechnologyIcon from './TechnologyIcon'
import './courseCatalog.css'
export const isSavedReference = (note: NoteMeta) => Boolean(note.source_path) || teachingNoteIds.has(note.id) || supplementalReferenceIds.has(note.id) || knowledgeReferenceIds.has(note.id)
const knowledgeViews = {
  topics: 'Topics',
  personal: 'My notes',
  plans: 'Learning plans',
  references: 'Saved references',
} as const
type KnowledgeView = keyof typeof knowledgeViews
function initialView(): KnowledgeView {
  const view = new URLSearchParams(window.location.search).get('view')
  return view === 'personal' || view === 'plans' || view === 'references' ? view : 'topics'
}
export default function KnowledgeLibrary({ topicId }: { topicId?: string }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null), [matches, setMatches] = useState<NoteMeta[]>([])
  const [query, setQuery] = useState(''), [view, setView] = useState<KnowledgeView>(initialView)
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [revision, setRevision] = useState(0)
  const topic = knowledgeTopics.find(item => item.id === topicId)
  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setLoading(true); setError('')
      void Promise.all([notesRequest<Catalog>('', { signal: controller.signal }), query.trim() ? notesRequest<Catalog>(`?q=${encodeURIComponent(query.trim())}`, { signal: controller.signal }) : Promise.resolve(null)]).then(([all, found]) => {
        if (!Array.isArray(all.notes) || (found && !Array.isArray(found.notes))) throw new Error('Knowledge returned an unexpected response')
        if (!controller.signal.aborted) { setCatalog(all); setMatches((found || all).notes.filter(note => !note.deleted_at && !reviewNoteIds.has(note.id))) }
      }).catch(failure => { if (!controller.signal.aborted) { setError(failure instanceof Error ? failure.message : 'Knowledge unavailable'); setCatalog(null); setMatches([]) } }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    }, 200)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [query, revision])
  const active = (catalog?.notes || []).filter(note => !note.deleted_at)
  const personal = matches.filter(note => !planNoteIds.has(note.id) && !isSavedReference(note) && (!topic || query.trim() || topic.personalNoteIds?.includes(note.id)))
  const references = matches.filter(note => !planNoteIds.has(note.id) && isSavedReference(note) && !teachingNoteIds.has(note.id))
  const plans = matches.filter(note => planNoteIds.has(note.id))
  const visibleNotes = view === 'personal' ? personal : view === 'plans' ? plans : references
  const [notePage, setNotePage] = useState(0)
  useEffect(() => setNotePage(0), [query, view, topicId])
  const noteCards = (items: NoteMeta[]) => {
    const pages = Math.max(1, Math.ceil(items.length / 30)), page = Math.min(notePage, pages - 1)
    return <><div className="knowledge-note-cards">{items.slice(page * 30, (page + 1) * 30).map(note => <a className="knowledge-note-card" key={note.id} href={readerHref(note.id)}><FileText size={18} /><span><strong>{note.title}</strong><small>{planNoteIds.has(note.id) ? 'Learning plan' : isSavedReference(note) ? 'Saved reference' : 'Personal note'} · {new Date(note.updated_at).toLocaleDateString()}</small></span><ArrowRight size={14} /></a>)}</div>{pages > 1 && <nav className="knowledge-note-pagination" aria-label="Saved reading pages"><button disabled={!page} onClick={() => setNotePage(page - 1)}>Previous notes</button><span>{page + 1} / {pages}</span><button disabled={page + 1 >= pages} onClick={() => setNotePage(page + 1)}>Next notes</button></nav>}</>
  }
  const search = <label className="course-search"><Search size={16} /><input aria-label={view === 'plans' ? 'Search learning plans' : 'Search my notes'} type="search" maxLength={300} value={query} onChange={event => setQuery(event.target.value)} placeholder="Search titles and saved text…" /></label>
  return <main className="course-directory knowledge-library">
    <header className="course-catalog-heading"><div>{topic && <a className="course-back" href="/learning/knowledge/">← Knowledge</a>}<span className="section-label">{topic ? 'UNDERSTAND THE MODEL' : 'YOUR KNOWLEDGE SYSTEM'}</span><h1>{topic?.title || (topicId ? 'Topic not found' : 'Knowledge')}</h1><p>{topic?.description || 'Understand concepts, compare approaches and review common pitfalls. Keep your own notes alongside the references.'}</p></div></header>
    {!topicId && <nav className="course-track-filters" aria-label="Knowledge views">{(Object.keys(knowledgeViews) as KnowledgeView[]).map(id => <button key={id} aria-pressed={view === id} onClick={() => { setView(id); setQuery('') }}>{knowledgeViews[id]}</button>)}</nav>}
    {error && <div className="catalog-message" role="alert">{error}<button onClick={() => setRevision(value => value + 1)}>Retry Knowledge</button></div>}
    {loading && <p role="status">Loading Knowledge…</p>}
    {topicId && !topic ? <a href="/learning/knowledge/">Browse knowledge topics</a> : topic ? <>
      <section className="knowledge-topic-references"><header><h2>Concept references</h2><p>Understand the relationships, trace how they work and compare their limits. Use the guided course for practice.</p></header><div className="knowledge-note-cards">{topicReadings(topic).map(reading => active.some(note => note.id === reading.noteId) ? <a className="knowledge-note-card" key={reading.noteId} href={topicReadingHref(topic, reading.noteId)}><BookOpen size={18} /><strong>{reading.title}</strong><ArrowRight size={14} /></a> : !loading && !error ? <span className="catalog-message" key={reading.noteId}>{reading.title} · Reference unavailable</span> : null)}</div><div className="knowledge-course-links">{topic.courses.map(id => { const course = readingCourses.find(item => item.id === id); return course && <a key={id} href={`/learning/courses/${id}`}>Open course · {course.title} <ArrowRight size={14} /></a> })}</div></section>
      <section className="knowledge-personal-section"><header><h2>My notes</h2><p>Your own notes stay separate from these references. Search saved text to find what you wrote.</p></header><div className="knowledge-note-search">{search}<button onClick={() => setQuery(topic.title)}>Search my notes for “{topic.title}”</button></div>{!loading && !error && noteCards(personal)}{!loading && !error && !personal.length && <p>{query ? 'No personal notes match this search.' : 'No personal notes are linked to this view yet.'}</p>}</section>
    </> : view === 'topics' ? <>{courseTracks.map(group => <section className="course-track-section" key={group.id}><header><h2>{group.title}</h2></header><div className="knowledge-topic-grid">{knowledgeTopics.filter(item => item.track === group.id).map(item => <a className="knowledge-topic-card" data-track={item.track} key={item.id} href={`/learning/knowledge/topics/${item.id}`}><span className="knowledge-topic-icon"><TechnologyIcon technology={item.id} /></span><span><strong>{item.title}</strong><p>{item.description}</p><small>{loading ? 'Loading…' : error ? 'References unavailable' : `${topicReadings(item).filter(reading => active.some(note => note.id === reading.noteId)).length} references`}</small></span><ArrowRight size={14} /></a>)}</div></section>)}<section className="knowledge-personal-section"><header><h2>Recent personal notes</h2></header>{!loading && !error && noteCards(personal.slice(0, 6))}{!loading && !error && !personal.length && <p>Your own explanations and observations will appear here.</p>}</section></> : <><div className="course-catalog-toolbar"><p>{view === 'personal' ? 'Your own explanations and observations.' : view === 'plans' ? 'Learning goals, timelines and next steps.' : 'Concept references and other saved material. Guided lectures are in Courses.'}</p>{search}</div>{!loading && !error && noteCards(visibleNotes)}{!loading && !error && !visibleNotes.length && <p>{query ? 'No saved notes match this search.' : 'No saved notes in this view yet.'}</p>}</>}
  </main>
}
