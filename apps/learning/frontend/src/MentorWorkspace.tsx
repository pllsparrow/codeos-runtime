import { FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Brain, RefreshCw, Save, Send, Square, Target, X } from 'lucide-react'
import { apiRequest } from './api'
import { requestId } from './requestId'

type ContextMode = 'auto' | 'none' | 'selected'
type Session = { id: string; context_mode: ContextMode; archived: boolean; created_at: string }
type Run = { id: string; status: 'queued' | 'running' | 'completed' | 'failed'; partial_output: string; error: string | null }
type Message = { id: string; role: 'user' | 'assistant'; content: string; run: Run | null; source_refs?: Array<{ service: string; source_id: string; version?: string }>; retrievals: Array<{ sources: Array<{ source_id: string; title?: string; version?: string; content?: unknown; notebook_href?: string; lesson_href?: string | null }> }> }
type Source = { source_id: string; title: string; version?: string; notebook_href?: string; lesson_href?: string | null }
const isLabSource = (source: Source) => /^(experiment|notebook-run)\//.test(source.source_id)
type Review = { id: string; cutoff_message_id: string; status: 'running' | 'completed' | 'failed' | 'cancelled'; error_code: string | null; document: null | { topic: string; key_points: string[]; observations: Array<{ statement: string; evidence_ids: string[] }>; next_exercise: { prompt: string; expected_check: string } } }
type Profile = { topic: string; hypothesis: string; confidence: number; user_correction: string | null; updated_at: string }
type LearningPlanItem = { evidence_topic: string; title: string; observation: string; priority: 'focus' | 'reinforce' | 'inspect'; action_label: string; href: string; confidence: number; corrected_by_user: boolean; successful_count: number; observation_count: number; source_refs: Array<{ service: string; source_id: string; version?: string }> }
type LearningPlan = { evidence_count: number; focus_count: number; items: LearningPlanItem[]; disclaimer: string }

export default function MentorWorkspace() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [session, setSession] = useState<Session | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [mode, setMode] = useState<ContextMode>('auto')
  const [sources, setSources] = useState<Source[]>([])
  const [selected, setSelected] = useState<Source[]>([])
  const [sourcesLoading, setSourcesLoading] = useState(false)
  const [sourcesLoaded, setSourcesLoaded] = useState(false)
  const [sourceQuery, setSourceQuery] = useState('')
  const [labRequest, setLabRequest] = useState(() => {
    const params = new URLSearchParams(window.location.search)
    const id = params.get('experiment')
    const notebook = params.get('notebook')
    const cell = params.get('cell')
    const version = params.get('version')
    if (params.has('session') || !version) return null
    if (notebook && cell !== null) {
      return `/api/mentor/sources/notebook-run?${new URLSearchParams({ notebook, cell, version })}`
    }
    return id ? `/api/mentor/sources/lab/${encodeURIComponent(id)}?${new URLSearchParams({ version })}` : null
  })
  const [labLoading, setLabLoading] = useState(Boolean(labRequest))
  const [labError, setLabError] = useState('')
  const [message, setMessage] = useState('')
  const [streamed, setStreamed] = useState('')
  const [activeRun, setActiveRun] = useState<Run | null>(null)
  const [reviews, setReviews] = useState<Review[]>([])
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [plan, setPlan] = useState<LearningPlan | null>(null)
  const [corrections, setCorrections] = useState<Record<string, string>>({})
  const [directionBusy, setDirectionBusy] = useState(false)
  const [busy, setBusy] = useState(false)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('Ready')
  const streamRef = useRef<EventSource | null>(null)
  const pendingId = useRef<string | null>(null)
  const openingRef = useRef(false)

  const stopStream = useCallback(() => { streamRef.current?.close(); streamRef.current = null }, [])
  const loadLearningDirection = useCallback(async () => {
    const [nextProfiles, nextPlan] = await Promise.all([
      apiRequest<Profile[]>('/api/mentor/profile'),
      apiRequest<LearningPlan>('/api/mentor/learning-plan'),
    ])
    setProfiles(nextProfiles)
    setPlan(nextPlan)
    setCorrections(Object.fromEntries(nextProfiles.map((item) => [item.topic, item.user_correction || ''])))
  }, [])
  const loadSessions = useCallback(async () => {
    try { setSessions((await apiRequest<Session[]>('/api/mentor/sessions')).filter((item) => !item.archived)) }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Mentor is unavailable') }
  }, [])
  const loadReviews = useCallback(async (sessionId: string, isCurrent: () => boolean = () => true) => {
    const reviews = await apiRequest<{ items: Review[] }>(`/api/mentor/sessions/${sessionId}/reviews`)
      .then((result) => result.items, () => [])
    if (isCurrent()) setReviews(reviews)
  }, [])
  const loadHistory = useCallback(async (sessionId: string, isCurrent: () => boolean = () => true) => {
    const history = await apiRequest<Message[]>(`/api/mentor/sessions/${sessionId}/messages`)
    if (!isCurrent()) return null
    setMessages(history)
    const lastQuestion = [...history].reverse().find((item) => item.role === 'user')
    const evidence = new Map(lastQuestion?.retrievals.flatMap((item) => item.sources)
      .map((source) => [source.source_id, source]))
    setSelected((lastQuestion?.source_refs || []).filter((ref) => ref.service === 'codelab')
      .map((ref) => {
        const source = evidence.get(ref.source_id)
        return { ...ref, title: source?.title || ref.source_id,
          notebook_href: source?.notebook_href, lesson_href: source?.lesson_href }
      }))
    await loadReviews(sessionId, isCurrent)
    return history.find((item) => item.run && ['queued', 'running'].includes(item.run.status))?.run || null
  }, [loadReviews])

  const watchRun = useCallback((run: Run, sessionId: string) => {
    stopStream(); setActiveRun(run); setStreamed(run.partial_output || ''); setBusy(true); setStatus('Mentor is responding')
    const source = new EventSource(`/api/mentor/model-runs/${run.id}/stream`)
    streamRef.current = source
    let settled = false
    const isCurrent = () => streamRef.current === source
    source.addEventListener('active', (event) => {
      if (!isCurrent() || settled) return
      const current = JSON.parse((event as MessageEvent).data) as Run
      setStreamed(current.partial_output || '')
      setStatus('Following the saved response')
    })
    source.addEventListener('token', (event) => {
      if (!isCurrent() || settled) return
      const payload = JSON.parse((event as MessageEvent).data) as { text: string }
      setStreamed((value) => value + payload.text)
    })
    source.addEventListener('retrieval', (event) => {
      if (!isCurrent() || settled) return
      const payload = JSON.parse((event as MessageEvent).data) as { status: string; source_count: number }
      setStatus(payload.status === 'matched' ? `Using ${payload.source_count} learning sources` : 'No indexed learning evidence matched')
    })
    const finish = async (interrupted: boolean) => {
      if (!isCurrent() || settled) return
      settled = true
      source.close()
      setStatus(interrupted ? 'Connection interrupted. Reloading saved output…' : 'Loading saved answer…')
      try {
        await loadHistory(sessionId, isCurrent)
        if (isCurrent()) setStatus(interrupted ? 'Connection interrupted. Reload to reconnect or retry.' : 'Ready')
      } catch (failure) {
        if (isCurrent()) {
          setError(failure instanceof Error ? failure.message : 'Could not refresh the conversation')
          setStatus('Reload the conversation to recover saved output.')
        }
      } finally {
        if (isCurrent()) {
          streamRef.current = null
          setBusy(false); setActiveRun(null); setStreamed('')
        }
      }
    }
    source.addEventListener('complete', () => void finish(false))
    source.addEventListener('failed', () => void finish(false))
    source.onerror = () => void finish(true)
  }, [loadHistory, stopStream])

  useEffect(() => {
    void loadSessions()
    void loadLearningDirection().catch(() => undefined)
  }, [loadLearningDirection, loadSessions])
  useEffect(() => () => stopStream(), [stopStream])
  useEffect(() => {
    if (!labRequest) return
    let current = true
    setMode('selected')
    void apiRequest<Source>(labRequest)
      .then((source) => { if (current) setSelected([source]) })
      .catch((failure: unknown) => {
        if (current) setLabError(failure instanceof Error ? failure.message : 'Could not load the Lab result.')
      })
      .finally(() => { if (current) setLabLoading(false) })
    return () => { current = false }
  }, [labRequest])
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('session')
    if (requested && sessions.some((item) => item.id === requested) && session?.id !== requested) void openSession(requested)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions])

  const openSession = async (id: string) => {
    if (busy || sourcesLoading || labLoading || openingRef.current) return
    openingRef.current = true
    setOpening(true)
    stopStream(); setError(''); setStatus('Loading conversation')
    try {
      const next = await apiRequest<Session>(`/api/mentor/sessions/${id}`)
      const run = await loadHistory(id)
      if (session?.id !== id) {
        pendingId.current = null
        setLabRequest(null)
        setLabError('')
        setMessage('')
        setSourceQuery('')
      }
      setSession(next); setMode(next.context_mode)
      const url = new URL(window.location.pathname, window.location.origin)
      url.searchParams.set('session', id)
      window.history.replaceState(null, '', url)
      setStatus('Ready')
      if (run) watchRun(run, id)
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not load the conversation'); setStatus('Error') }
    finally { openingRef.current = false; setOpening(false) }
  }

  const newConversation = () => {
    if (openingRef.current || sourcesLoading || labLoading || (busy && !streamRef.current)) return
    pendingId.current = null
    setLabRequest(null)
    setLabError('')
    setError(''); setSourceQuery('')
    stopStream(); setSession(null); setMessages([]); setReviews([]); setSelected([]); setMode('auto'); setMessage(''); setActiveRun(null); setStreamed(''); setBusy(false); setStatus('Ready')
    window.history.replaceState(null, '', window.location.pathname)
  }

  const loadSources = async () => {
    if (openingRef.current) return
    setSourcesLoading(true); setStatus('Loading Notes'); setError('')
    try {
      const current = await apiRequest<Source[]>('/api/mentor/sources/notes')
      setSources(current); setSourcesLoaded(true)
      setSelected((previous) => {
        const notes = current.filter((source) => previous.some((item) => item.source_id === source.source_id))
        return [...previous.filter(isLabSource), ...notes]
      })
      setStatus('Current Notes ready')
    }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Notes are unavailable'); setStatus('Reload Notes to retry') }
    finally { setSourcesLoading(false) }
  }

  const sendMessage = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || openingRef.current || sourcesLoading || labLoading || labError || !message.trim()) return
    if (mode === 'selected' && selected.length === 0) { setError('Select at least one Note source.'); return }
    setBusy(true); setError(''); setStatus('Sending')
    try {
      let activeSession = session
      if (!activeSession) {
        activeSession = await apiRequest<Session>('/api/mentor/sessions', { method: 'POST', body: JSON.stringify({ context_mode: mode }) })
        setSession(activeSession); await loadSessions()
        const url = new URL(window.location.pathname, window.location.origin)
        url.searchParams.set('session', activeSession.id)
        window.history.replaceState(null, '', url)
      }
      pendingId.current ||= requestId()
      const accepted = await apiRequest<{ run: Run }>(`/api/mentor/sessions/${activeSession.id}/messages`, { method: 'POST', body: JSON.stringify({ content: message, client_message_id: pendingId.current, source_refs: mode === 'selected' ? selected.map(({ source_id, version }) => ({ service: 'codelab', source_id, version })) : [] }) })
      pendingId.current = null; setMessage(''); setSession(activeSession)
      await loadHistory(activeSession.id); watchRun(accepted.run, activeSession.id)
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not send the message'); setBusy(false); setStatus('Error') }
  }

  const retryRun = async (runId: string) => {
    setBusy(true); setError('')
    try { const accepted = await apiRequest<{ run: Run }>(`/api/mentor/model-runs/${runId}/retry`, { method: 'POST' }); if (session) watchRun(accepted.run, session.id) }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not retry the answer'); setBusy(false) }
  }

  const generateReview = async () => {
    if (!session) return
    const cutoff = [...messages].reverse().find((item) => item.role === 'assistant')?.id
    if (!cutoff) return
    setBusy(true); setStatus('Generating review')
    try { await apiRequest(`/api/mentor/sessions/${session.id}/reviews`, { method: 'POST', body: JSON.stringify({ client_review_id: requestId(), cutoff_message_id: cutoff }) }); await loadReviews(session.id); setStatus('Review ready') }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Review is unavailable'); setStatus('Review unavailable') }
    finally { setBusy(false) }
  }

  const cancelReview = async (id: string) => {
    if (!session) return
    try { await apiRequest(`/api/mentor/reviews/${id}/cancel`, { method: 'POST' }); await loadReviews(session.id) }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not cancel the review') }
  }

  const refreshLearningDirection = async () => {
    setDirectionBusy(true); setError(''); setStatus('Syncing completed learning evidence')
    try {
      const result = await apiRequest<{ profile: Profile[]; plan: LearningPlan }>('/api/mentor/learning-direction/refresh', { method: 'POST' })
      setProfiles(result.profile)
      setPlan(result.plan)
      setCorrections(Object.fromEntries(result.profile.map((item) => [item.topic, item.user_correction || ''])))
      setStatus('Learning direction updated')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not update the learning direction')
      setStatus('Learning direction unavailable')
    } finally { setDirectionBusy(false) }
  }

  const saveCorrection = async (profile: Profile) => {
    setDirectionBusy(true); setError('')
    try {
      await apiRequest<Profile>('/api/mentor/profile', {
        method: 'PUT',
        body: JSON.stringify({
          topic: profile.topic,
          hypothesis: profile.hypothesis,
          confidence: profile.confidence,
          user_correction: corrections[profile.topic]?.trim() || null,
        }),
      })
      await loadLearningDirection()
      setStatus('Learning correction saved')
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save the correction') }
    finally { setDirectionBusy(false) }
  }

  const filteredSources = sources.filter((source) => `${source.title} ${source.source_id}`.toLowerCase().includes(sourceQuery.trim().toLowerCase()))
  const latestReview = reviews.find((item) => item.status === 'running') || reviews[0]
  const planTopics = new Set(plan?.items.map((item) => item.evidence_topic) || [])
  const visibleProfiles = profiles.filter((profile) => !planTopics.size || planTopics.has(profile.topic))
  const navigationPending = opening || sourcesLoading || labLoading
  const labSources = selected.filter(isLabSource)
  return <main className="learning-child mentor-workspace">
    <header className="child-heading"><div><span className="section-label">LEARNING CONVERSATIONS</span><h1>Mentor</h1><p>Ask, inspect the evidence used, and turn a difficult idea into a review.</p></div><div className="child-actions"><span className="child-status">{status}</span><a href="/learning/"><ArrowLeft size={14} /> Learning</a></div></header>
    {error && <div className="child-error" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss error"><X size={14} /></button></div>}
    <div className="mentor-layout"><aside className="child-sidebar"><button className="child-primary mentor-new" disabled={navigationPending || (busy && !activeRun)} onClick={newConversation}>New conversation</button><div className="child-sidebar-title"><h2>Recent conversations</h2><button onClick={() => void loadSessions()} aria-label="Refresh conversations"><RefreshCw size={14} /></button></div>{sessions.map((item) => <button className={`child-list-button ${session?.id === item.id ? 'active' : ''}`} key={item.id} disabled={busy || navigationPending} onClick={() => void openSession(item.id)}><strong>{new Date(item.created_at).toLocaleString()}</strong><small>{item.context_mode} context</small></button>)}{!sessions.length && <p className="child-muted">Your conversations will appear here.</p>}</aside>
      <section className="child-content mentor-content"><section className="learning-direction" aria-labelledby="learning-direction-title"><div className="learning-direction-heading"><div><span className="section-label">EVIDENCE LOOP</span><h2 id="learning-direction-title">Learning direction</h2><p>Completed Prep and OJ activity becomes an editable hypothesis, then a visible next action.</p></div><button disabled={directionBusy || busy} onClick={() => void refreshLearningDirection()}><RefreshCw size={13} /> {directionBusy ? 'Updating' : 'Update from activity'}</button></div>{plan?.items.length ? <div className="learning-direction-grid"><div className="learning-next"><span className="learning-direction-label"><Target size={13} /> Next actions · {plan.focus_count} focus</span>{plan.items.slice(0, 3).map((item) => <a href={item.href} key={item.evidence_topic}><span className={`learning-priority ${item.priority}`}>{item.priority}</span><span><strong>{item.title}</strong><small>{item.observation_count ? `${item.successful_count}/${item.observation_count} successful observations · ` : ''}{item.observation}</small><em>{item.action_label}</em></span><ArrowRight size={14} /></a>)}</div><div className="learning-profile"><span className="learning-direction-label"><Brain size={13} /> Editable hypotheses · {plan.evidence_count}</span>{visibleProfiles.slice(0, 3).map((profile) => <label key={profile.topic}><span><strong>{profile.topic.replace(/^skill:/, '')}</strong><small>{Math.round(profile.confidence * 100)}% evidence confidence</small></span><textarea rows={2} value={corrections[profile.topic] || ''} placeholder={profile.hypothesis} onChange={(event) => setCorrections((current) => ({ ...current, [profile.topic]: event.target.value }))} /><button disabled={directionBusy} onClick={() => void saveCorrection(profile)}><Save size={12} /> Save correction</button></label>)}</div></div> : <div className="learning-direction-empty"><Brain size={18} /><span><strong>No learning evidence has been derived yet.</strong><small>Update from completed activity after an OJ submission or Prep attempt.</small></span></div>}<p className="learning-direction-disclaimer">{plan?.disclaimer || 'Hypotheses remain separate from formal scores and progress.'}</p></section><section className="mentor-context"><label>Context for this conversation<select value={mode} disabled={Boolean(session) || busy || navigationPending || Boolean(labError)} onChange={(event) => setMode(event.target.value as ContextMode)}><option value="auto">Auto</option><option value="none">No context</option><option value="selected">Use sources</option></select></label><p>{mode === 'selected' ? 'Select up to 8 saved sources. Reload Notes after editing to use their current versions.' : mode === 'auto' ? 'Mentor matches indexed learning evidence when the question needs it.' : 'Only the conversation is sent to the model.'}</p>{labLoading && <p role="status">Checking the saved Lab result…</p>}{labError && <div role="alert"><p>{labError}</p><a href="/codelab/lab">Return to Lab</a></div>}
        {mode === 'selected' && labSources.map((source) => <div className="mentor-lab-source" key={source.source_id}>
          <strong>Lab result · {source.title}</strong>
          <small>{source.version}</small>
          {source.source_id.startsWith('notebook-run/') && <a
            href={source.notebook_href || `/codelab/jupy?${new URLSearchParams({ notebook: source.source_id.split('/').slice(2).join('/') })}`}
            target="_blank" rel="noopener noreferrer">Open Notebook</a>}
          {source.lesson_href && <a href={source.lesson_href}>Return to lesson</a>}
          <p>Sending a question includes excerpts of saved code, setup, and output in the model request.</p>
          <button type="button" disabled={busy || navigationPending} onClick={() => setSelected((items) => items.filter((item) => item.source_id !== source.source_id))}>Remove Lab result</button>
        </div>)}{mode === 'selected' && <div className="mentor-sources" aria-busy={sourcesLoading}><div><input type="search" aria-label="Find a Note" value={sourceQuery} onChange={(event) => setSourceQuery(event.target.value)} placeholder="Find a Note" /><button disabled={busy || navigationPending} onClick={() => void loadSources()}>{sourcesLoading ? 'Loading Notes…' : sourcesLoaded ? 'Reload Notes' : 'Load Notes'}</button></div><p>{selected.length}/8 selected{selected.length > 0 ? ` · ${selected.map((source) => source.title).join(', ')}` : ''}</p>{sourcesLoaded && !filteredSources.length && <p>{sources.length ? 'No Notes match your search.' : 'No saved Notes yet. Create and save a Note in Writing, then reload Notes.'}</p>}<div className="mentor-note-options" role="group" aria-label="Saved Web Notes">{filteredSources.map((source) => <label key={source.source_id}><input type="checkbox" disabled={busy || navigationPending || (selected.length >= 8 && !selected.some((item) => item.source_id === source.source_id))} checked={selected.some((item) => item.source_id === source.source_id)} onChange={() => setSelected((current) => current.some((item) => item.source_id === source.source_id) ? current.filter((item) => item.source_id !== source.source_id) : current.length < 8 ? [...current, source] : current)} />{source.title}<small>{source.source_id}</small></label>)}</div></div>}</section>
        <div className="mentor-conversation-title"><h2>{session ? `Conversation · ${new Date(session.created_at).toLocaleDateString()}` : 'New conversation'}</h2>{session && <button disabled={busy || navigationPending} onClick={() => void openSession(session.id)}><RefreshCw size={13} /> Reload</button>}</div>
        <section className="mentor-messages" aria-label="Conversation messages">{messages.map((item) => <article className={`mentor-message ${item.role}`} key={item.id}><strong>{item.role === 'user' ? 'You' : 'Mentor'}</strong><pre>{item.content}</pre>{item.retrievals.flatMap((retrieval) => retrieval.sources).map((source) => <details key={`${item.id}-${source.source_id}`}><summary>{source.title || source.source_id}</summary><pre>Version: {source.version || 'current'}{`\n\n`}{typeof source.content === 'string' ? source.content : JSON.stringify(source.content, null, 2)}</pre></details>)}{item.run?.status === 'failed' && <section className="mentor-incomplete" aria-label="Incomplete Mentor answer"><strong>Mentor · Incomplete answer</strong>{item.run.partial_output && <pre>{item.run.partial_output}</pre>}<p>{item.run.error || 'The response stopped before completion.'}</p><button disabled={busy} onClick={() => void retryRun(item.run!.id)}>Generate a new answer</button></section>}</article>)}{activeRun && <article className="mentor-message assistant streaming"><strong>Mentor · Responding</strong><pre>{streamed || 'Waiting for the model…'}</pre></article>}{!messages.length && !activeRun && <div className="child-empty"><Brain size={25} /><h2>Start with one question</h2><p>You can follow up in the same conversation.</p></div>}</section>
        {session && messages.some((item) => item.role === 'assistant') && <section className="mentor-review"><div><h2>Learning review</h2><button disabled={busy || latestReview?.status === 'running'} onClick={() => void generateReview()}>Generate review</button>{latestReview?.status === 'running' && <button onClick={() => void cancelReview(latestReview.id)}><Square size={12} /> Cancel</button>}</div>{latestReview ? <article><strong>{latestReview.document?.topic || `Review ${latestReview.status}`}</strong>{latestReview.error_code && <p>{latestReview.error_code}</p>}{latestReview.document?.key_points.map((point) => <p key={point}>• {point}</p>)}{latestReview.document && <><h3>Next exercise</h3><p>{latestReview.document.next_exercise.prompt}</p><small>Check: {latestReview.document.next_exercise.expected_check}</small></>}</article> : <p>No reviews yet.</p>}</section>}
        <form className="mentor-composer" onSubmit={(event) => void sendMessage(event)}><label>Your question<textarea value={message} disabled={opening || busy} onChange={(event) => setMessage(event.target.value)} maxLength={32000} rows={4} required placeholder="What would you like to understand?" /></label><button className="child-primary" disabled={busy || navigationPending || Boolean(labError) || (mode === 'selected' && selected.length === 0)}><Send size={14} /> Send message</button></form>
      </section></div>
  </main>
}
