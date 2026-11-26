import { useEffect, useState } from 'react'
export default function LessonContext({ canLeave }: { canLeave: () => boolean }) {
  const identity = new URLSearchParams(window.location.search).get('learning_context')
  const [context, setContext] = useState<{ title: string; path_title: string; return_href: string }>()
  const [error, setError] = useState(''), [revision, retry] = useState(0)
  useEffect(() => {
    if (!identity) return
    if (!/^[a-z0-9-]{1,80}$/.test(identity)) { setError('Invalid learning context'); return }
    const controller = new AbortController()
    setError(''); setContext(undefined)
    void fetch(`/api/codelab/learning/paths/lessons/${identity}`, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Lesson context unavailable')
      const body = await response.json()
      if (!/^\/learning\/paths\/[a-z0-9-]+\/lessons\/[a-z0-9-]+$/.test(body.return_href) || !body.return_href.endsWith('/' + identity)) throw new Error('Invalid lesson return route')
      setContext(body)
    }).catch(failure => { if (!controller.signal.aborted) setError(failure.message) })
    return () => controller.abort()
  }, [identity, revision])
  if (!identity) return null
  return <aside className="lesson-context" aria-label="Learning context">{error ? <><span>{error}</span><button onClick={() => retry(value => value + 1)}>Retry context</button></> : context ? <><span>{context.path_title} · <strong>{context.title}</strong></span><a href={`${context.return_href}?stage=${window.location.pathname.startsWith('/codelab/jupy') ? 'experiment' : 'reflect'}`} onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !canLeave()) event.preventDefault() }}>Return to lesson</a><small>Save your work, then confirm evidence in Learning.</small></> : <span>Loading lesson context…</span>}</aside>
}
