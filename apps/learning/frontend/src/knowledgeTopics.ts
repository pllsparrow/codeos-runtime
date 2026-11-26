import { type CourseReading, type CourseTrack } from './courseCatalog'
export type KnowledgeTopic = { id: string; title: string; description: string; track: CourseTrack; courses: string[]; personalNoteIds?: number[] }
export const knowledgeTopics: KnowledgeTopic[] = [
  { id: 'python', title: 'Python', description: 'Objects, collections, functions and errors.', track: 'python', courses: ['python-language'] },
  { id: 'async-python', title: 'Async Python & FastAPI', description: 'Coroutines, concurrency and request handling.', track: 'python', courses: ['python-web'] },
  { id: 'go', title: 'Go', description: 'Structs, slices, maps, pointers and methods.', track: 'go', courses: ['go-language', 'go-codeosctl'] },
  { id: 'linux', title: 'Linux', description: 'Commands, permissions, processes and logs.', track: 'backend', courses: ['linux'] },
  { id: 'operating-systems', title: 'Operating systems', description: 'Memory, I/O, scheduling and concurrency.', track: 'backend', courses: ['operating-systems'] },
  { id: 'http', title: 'HTTP & Networking', description: 'TCP, DNS, TLS, requests and reliability.', track: 'backend', courses: ['http-networks'] },
  { id: 'databases', title: 'SQL & Databases', description: 'Indexes, transactions, PostgreSQL and caching.', track: 'backend', courses: ['databases'] },
  { id: 'docker', title: 'Docker', description: 'Images, containers, Compose and storage.', track: 'backend', courses: ['docker'] },
  { id: 'git', title: 'Git', description: 'Changes, commits, branches and recovery.', track: 'backend', courses: ['git'] },
  { id: 'agents', title: 'AI Agents', description: 'Model calls, tools, state, context and evaluation.', track: 'ai', courses: ['ai-agents'] },
  { id: 'rag', title: 'RAG', description: 'Embeddings, retrieval, reranking and evaluation.', track: 'ai', courses: ['rag'] },
]
// Independently authored conceptual references, published and read back through the Notes API.
const conceptReadings: Record<string, CourseReading[]> = {
  python: [{ noteId: 251, title: 'Objects, mutability and copying' }, { noteId: 250, title: 'Functions, iterators and generators' }, { noteId: 249, title: 'Exceptions, type hints and testing concepts' }],
  'async-python': [{ noteId: 239, title: 'Coroutines, concurrency and FastAPI' }],
  go: [{ noteId: 245, title: 'Structs, values and pointers' }, { noteId: 243, title: 'Arrays, slices and maps' }, { noteId: 244, title: 'Methods, interfaces and errors' }],
  linux: [{ noteId: 247, title: 'Paths, permissions and processes' }],
  'operating-systems': [{ noteId: 248, title: 'Processes, threads, memory and I/O' }],
  http: [{ noteId: 246, title: 'Requests, connections and idempotency' }],
  databases: [{ noteId: 240, title: 'Indexes, transactions and consistency' }],
  docker: [{ noteId: 241, title: 'Images, containers and volumes' }],
  git: [{ noteId: 242, title: 'Working tree, staging and commits' }],
  agents: [{ noteId: 238, title: 'Models, tools, state and evaluation' }],
  rag: [{ noteId: 252, title: 'Retrieval, generation and evaluation' }],
}
export const topicReadings = (topic: KnowledgeTopic): CourseReading[] => conceptReadings[topic.id] || []
export const knowledgeReferenceIds = new Set(Object.values(conceptReadings).flat().map(reading => reading.noteId))
export const topicForNote = (id: number) => knowledgeTopics.find(topic => topicReadings(topic).some(reading => reading.noteId === id))
export const topicReadingHref = (topic: KnowledgeTopic, id: number) => `/learning/knowledge/articles/${id}`

export function installTopics(topics: KnowledgeTopic[], entries: Record<string, CourseReading[]>) {
  knowledgeTopics.splice(0, knowledgeTopics.length, ...topics)
  for (const key of Object.keys(conceptReadings)) delete conceptReadings[key]
  Object.assign(conceptReadings, entries)
}
