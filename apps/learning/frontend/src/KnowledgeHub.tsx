import { useEffect, useState } from 'react'
import { apiRequest } from './api'
type Question = { id: number; topic: string; question_type: 'single_choice' | 'multiple_choice' | 'free_text'; prompt: string; archived: boolean; latest_version_id: number }
type QuestionSet = { id: number; title: string; latest_version_id: number; question_version_ids: number[]; archived: boolean }
const conceptTopics = new Set(['http_basics','linux_commands','database_modeling','linux_permissions','backend_reliability','network','mysql_innodb'])
export default function KnowledgeHub() {
  const [sets, setSets] = useState<QuestionSet[]>([])
  const [questions, setQuestions] = useState<Question[]>([])
  const [error, setError] = useState(''), [loading, setLoading] = useState(true), [revision, setRevision] = useState(0)
  const [kind, setKind] = useState<'concepts' | 'choices'>('concepts')
  useEffect(() => {
    let active = true
    setLoading(true); setError('')
    void Promise.all([apiRequest<Question[]>('/api/prep/questions', { signal: AbortSignal.timeout(15000) }), apiRequest<QuestionSet[]>('/api/prep/question-sets', { signal: AbortSignal.timeout(15000) })]).then(([value, questionSets]) => { if (active) { setQuestions(value.filter(question => !question.archived)); setSets(questionSets.filter(set => !set.archived)) } }).catch(failure => { if (active) setError(failure instanceof Error ? failure.message : 'Question bank unavailable') }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [revision])
  const visible = questions.filter(question => kind === 'choices' ? question.question_type !== 'free_text' : question.question_type === 'free_text' && conceptTopics.has(question.topic))
  const allowedVersions = new Set(visible.map(question => question.latest_version_id))
  const availableSets = sets.filter(set => set.question_version_ids.length > 0 && set.question_version_ids.every(id => allowedVersions.has(id)))
  return <main className="learning-subjects"><header><a href="/learning/">Learning</a><h1>Interview & Quizzes</h1><p>Read a concept, explain it in your own words, answer a prompt, and review.</p></header>
    <nav className="subject-tabs" aria-label="Question kind"><button aria-pressed={kind === 'concepts'} onClick={() => setKind('concepts')}>Interview concepts</button><button aria-pressed={kind === 'choices'} onClick={() => setKind('choices')}>Written-test choices</button></nav>
    <div className="subject-links"><a href="/learning/knowledge/">Explore Knowledge concepts</a><a href="/learning/prep/">Open question sets and reviews</a></div>
    {loading && <p role="status">Loading saved questions…</p>}{error && <p role="alert">{error} <button onClick={() => setRevision(value => value + 1)}>Retry question bank</button></p>}
    {!loading && !error && <section><p>{visible.length} saved prompts</p>{availableSets.map(set => <a className="path-action" key={set.id} href={`/learning/knowledge/practice?set=${set.latest_version_id}`}>Open · {set.title} · {set.question_version_ids.length} prompts</a>)}{!visible.length && <p>{kind === 'choices' ? 'No multiple-choice questions are saved yet. Existing short-answer drills remain available.' : 'No interview concept prompts are saved yet.'}</p>}{visible.map(question => <article className="knowledge-prompt" key={question.id}><small>{question.topic.replaceAll('_',' ')} · {question.question_type.replaceAll('_',' ')}</small><p>{question.prompt}</p></article>)}</section>}
  </main>
}
