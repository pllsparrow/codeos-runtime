import { useEffect, useState } from 'react'
import { studyRequest } from './StudyCoverage'
type Context = { id: string; path_id: string; path_title: string; title: string }
export default function PersonalNoteContext({ noteId }: { noteId: number }) {
  const [contexts, setContexts] = useState<Context[]>([]), [error, setError] = useState(''), [revision, retry] = useState(0)
  const identity = new URLSearchParams(window.location.search).get('learning_context')
  useEffect(() => {
    let active = true
    setError('')
    void studyRequest<Context[]>(`/note-context/${noteId}`).then(value => { if (active) setContexts(Array.isArray(value) ? value : []) }).catch(failure => { if (active) setError(failure.message) })
    return () => { active = false }
  }, [noteId, revision])
  if (!contexts.length && !identity && !error) return null
  return <aside className="personal-note-context" aria-label="Linked courses"><strong>Linked courses</strong>{contexts.map(item => <a href={`/learning/paths/${item.path_id}/lessons/${item.id}?stage=reflect`} key={item.id}>{item.path_title} · {item.title}</a>)}{error && <p role="alert">{error}<button onClick={() => retry(value => value + 1)}>Retry links</button></p>}</aside>
}
