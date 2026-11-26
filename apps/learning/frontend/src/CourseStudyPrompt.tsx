import type { ReadingCourse } from './courseCatalog'

type Prompt = { question: string; hint: string; practice: string }
const prompts: Record<string, Prompt> = {
  'python-language': { question: 'When two names refer to the same object, which changes will both callers observe?', hint: 'Separate rebinding a name from modifying the object. Draw the references before looking at the example.', practice: 'Predict the output, change one operation, then explain why the result changed.' },
  'python-web': { question: 'While a request waits for I/O, what can another request do?', hint: 'Trace validation, the handler and its dependencies. Identify the exact operation that waits or blocks.', practice: 'Compare a successful request with one invalid input or timeout. Explain which layer handles each outcome.' },
  'go-language': { question: 'If a function receives a Task value, which changes can reach the caller?', hint: 'Distinguish the copied value from any underlying shared data. Check the receiver and field types.', practice: 'Use the Task program in GoLand. Predict the result, change one field or receiver, then compare and explain.' },
  'go-codeosctl': { question: 'What should file statistics mean when one directory cannot be read?', hint: 'Separate traversal, aggregation and presentation. Decide which partial results remain meaningful.', practice: 'Use a disposable directory and compare normal, empty and invalid inputs. Explain the result and error boundary.' },
  linux: { question: 'A file exists, but the command cannot read it. Which assumption would you check first?', hint: 'Separate the working directory, path resolution, permissions and process identity.', practice: 'Use a disposable example. Change one permission or relative path and explain the observed outcome.' },
  'operating-systems': { question: 'Which resources are shared by two threads, and which remain independent?', hint: 'Distinguish address space, stack, open resources and scheduling state.', practice: 'Draw the resource relationships, then use a small example to test one prediction.' },
  'http-networks': { question: 'A client times out after sending a write. Can it safely repeat the request?', hint: 'A missing response does not tell you whether the server committed a change. Consider idempotency.', practice: 'Trace a synthetic request and one failure path. Explain where the outcome becomes uncertain.' },
  databases: { question: 'If two requests both check that a value is absent, can both insert it?', hint: 'Draw the interleaving. Separate application checks from database constraints and isolation.', practice: 'Use synthetic data only. Compare the expected rule with the database result and explain the guarantee.' },
  git: { question: 'After git add, you edit the file again. Which version goes into the next commit?', hint: 'Draw the working tree, index and commit as separate snapshots.', practice: 'Use a disposable repository and compare diff with diff --cached before committing.' },
  docker: { question: 'If you replace a container, which data survives and why?', hint: 'Separate the image, writable container layer and mounted storage.', practice: 'Use disposable data. Trace where each file lives before predicting what replacement will preserve.' },
  'ai-agents': { question: 'A model says a tool succeeded. What evidence should the application trust?', hint: 'Separate the generated request, tool execution, returned result and authoritative state.', practice: 'Use a synthetic tool response and a failure case. Explain how the workflow decides to continue or stop.' },
  rag: { question: 'An answer sounds plausible but is wrong. Did retrieval supply the needed evidence?', hint: 'Inspect the source, retrieved candidates and final context separately from generated text.', practice: 'Use a small reviewed document set. Compare retrieval and answer quality for a supported and unsupported question.' },
}
const lessonPrompts: Record<number, Prompt> = {
  53: { question: 'How do package main, func main and the run command relate to the program you execute?', hint: 'Separate the source file, package, executable and working directory.', practice: 'Run the smallest program in GoLand, change its output, and explain the path from source to result.' },
  55: { question: 'When a Task title is invalid, what should the caller receive and which state should stay unchanged?', hint: 'Separate validation, state change and the error return. Look for the order of operations.', practice: 'Try one valid and one invalid title in GoLand. Explain why failure leaves the collection unchanged.' },
  74: { question: 'Can a type annotation reject an empty title, and what should happen when validation fails?', hint: 'Distinguish static type information, runtime validation and exception handling.', practice: 'Predict success and failure cases, write a small test, then explain the behavior it actually proves.' },
}
export default function CourseStudyPrompt({ course, noteId }: { course: ReadingCourse; noteId: number }) {
  const prompt = lessonPrompts[noteId] || prompts[course.id]
  if (!prompt) return null
  return <aside className="course-study-prompt" aria-label="Guided learning">
    <span className="section-label">THINK FIRST</span><p><strong>{prompt.question}</strong></p>
    <p>State your prediction and reason before reading.</p>
    <details><summary>Need a hint?</summary><p>{prompt.hint}</p></details>
    <p><strong>Try and reflect</strong> · {prompt.practice}</p>
    <p>What did you expect? What happened? Which part of your explanation needs to change?</p>
  </aside>
}
