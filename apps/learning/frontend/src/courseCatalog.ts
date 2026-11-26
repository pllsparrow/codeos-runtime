import type { NoteMeta } from './notesClient'

export const courseTracks = [
  { id: 'python', title: 'Python', description: 'Write Python, solve problems and build useful programs.' },
  { id: 'go', title: 'Go', description: 'Learn the language in GoLand, then build a command-line tool.' },
  { id: 'backend', title: 'Backend development', description: 'Understand Linux, HTTP, databases and the tools behind a service.' },
  { id: 'ai', title: 'AI application development', description: 'Build model calls, tool-using agents and retrieval pipelines.' },
] as const
export type CourseTrack = typeof courseTracks[number]['id']
export type CourseReading = { noteId: number; title: string }
export type ReadingCourse = { id: string; track: CourseTrack; title: string; description: string; practice: string; kind?: 'Project' | 'Learning plan'; overview?: number; readings: CourseReading[] }
const readings = (ids: number[], titles: string[]): CourseReading[] => ids.map((noteId, index) => ({ noteId, title: titles[index] }))

// Reviewed stable Note references; no path-based or title-based reclassification of owner notes.
export const readingCourses: ReadingCourse[] = [
  { id: 'python-language', track: 'python', title: 'Learn Python', description: 'Objects, collections, functions and errors through one small task program.', practice: 'Local Python or Jupy', readings: readings([72, 73, 74], ['Objects, collections and copying', 'Functions, iteration and language tools', 'Errors, type hints and testing']) },
  { id: 'python-web', track: 'python', title: 'Async Python & Web APIs', description: 'Follow an HTTP request through validation, service logic and async I/O.', practice: 'Local Python', readings: readings([75, 76], ['Async I/O and bounded concurrency', 'FastAPI request and response flow']) },
  { id: 'go-language', track: 'go', title: 'Learn Go', description: 'Start with structs. Grow a Task program with slices, maps, methods and errors.', practice: 'Local GoLand', overview: 226, readings: readings([53, 54, 55, 227], ['Set up GoLand and run Go', 'Task: structs, slices, maps and methods', 'Task: errors and cleanup', 'Pointers, panic and concurrency basics']) },
  { id: 'go-codeosctl', track: 'go', title: 'Build a Go CLI', description: 'Connect Go foundations to codeosctl: arguments, directory traversal and useful output.', practice: 'Local GoLand', kind: 'Project', overview: 148, readings: readings([60], ['codeosctl: file statistics and the project path']) },
  { id: 'linux', track: 'backend', title: 'Learn Linux', description: 'Work with commands, permissions, processes, ports and logs.', practice: 'Local terminal', readings: readings([13, 14, 15], ['Commands and arguments', 'Permissions and processes', 'Ports, logs and troubleshooting']) },
  { id: 'operating-systems', track: 'backend', title: 'Processes, Memory & Concurrency', description: 'Explain how programs run, wait, share resources and clean up.', practice: 'Reading and small experiments', readings: readings([62, 63, 64, 65, 66, 67, 68, 69], ['Processes and threads', 'Virtual memory', 'I/O and file descriptors', 'Isolation and containers', 'Process lifecycle', 'Scheduling and context switches', 'Races, locks and worker pools', 'Connect the process model']) },
  { id: 'http-networks', track: 'backend', title: 'HTTP & Networking', description: 'Trace DNS, TCP, TLS and HTTP; reason about timeouts, retries and idempotency.', practice: 'Reading and local HTTP examples', readings: readings([19, 20, 21, 22, 23, 24, 25], ['IP, ports and sockets', 'TCP and UDP', 'Connections and shutdown', 'Reliable transport', 'HTTP and HTTPS', 'The complete request lifecycle', 'Timeouts, retries and idempotency']) },
  { id: 'databases', track: 'backend', title: 'Databases & PostgreSQL', description: 'Understand tables, indexes, transactions, isolation, locks and caching.', practice: 'Synthetic data only', readings: readings([27, 28, 29, 30, 31, 32, 33, 34, 35], ['Relational data and SQL', 'Indexes and query plans', 'Transactions and ACID', 'Isolation levels', 'Locks and deadlocks', 'MVCC', 'PostgreSQL schemas and queries', 'Redis and cache consistency', 'Constraints and migrations']) },
  { id: 'git', track: 'backend', title: 'Learn Git', description: 'Understand changes, commits, branches, collaboration and safe recovery.', practice: 'Local practice repository', kind: 'Learning plan', readings: readings([233], ['Git workflow and practice sequence']) },
  { id: 'docker', track: 'backend', title: 'Learn Docker', description: 'Connect images, containers, Dockerfiles, Compose and persistent storage.', practice: 'Disposable local examples', readings: readings([47, 48, 49, 50, 51], ['Start with the container model', 'Images, containers and boundaries', 'Write a Dockerfile', 'Compose services and networks', 'Storage, backup and operations']) },
  { id: 'ai-agents', track: 'ai', title: 'Build AI Agents', description: 'From structured model output to tool execution, state, context and evaluation.', practice: 'Local Python experiments', overview: 237, readings: readings([235, 78, 79, 80, 81, 82], ['Model calls and structured output', 'Tool calling and execution', 'ReAct and feedback', 'Agent runtime and termination', 'State, memory and context', 'Tracing, reliability and evaluation']) },
  { id: 'rag', track: 'ai', title: 'Build RAG Applications', description: 'Index documents, retrieve evidence, combine rankings and evaluate answers.', practice: 'Local Python experiments', readings: readings([95, 96, 97, 98, 99, 100], ['The retrieval and generation pipeline', 'Embeddings and vector search', 'Chunking, metadata and indexing', 'Keyword, vector and hybrid retrieval', 'Rank fusion and reranking', 'Evaluation and debugging']) },
]
export const teachingNoteIds = new Set([
  ...readingCourses.flatMap(course => [...course.readings.map(item => item.noteId), ...(course.overview ? [course.overview] : [])]),
  // Existing reviewed algorithm/SQL lectures and their published route overviews.
  ...Array.from({ length: 54 }, (_, index) => 170 + index), 236,
])
export const supplementalReferenceIds = new Set([169, 224, 225, 228, 229, 230, 231, 232, 234])
export const courseForNote = (id: number) => readingCourses.find(course => course.overview === id || course.readings.some(item => item.noteId === id))
export const availableReadings = (course: ReadingCourse, notes: NoteMeta[]) => course.readings.filter(item => notes.some(note => note.id === item.noteId && !note.deleted_at))
export const courseReadingHref = (course: ReadingCourse, id: number) => `/learning/courses/${encodeURIComponent(course.id)}/lessons/${id}`
export const courseNoteOrder = (course: ReadingCourse) => [...(course.overview ? [course.overview] : []), ...course.readings.map(item => item.noteId)]
