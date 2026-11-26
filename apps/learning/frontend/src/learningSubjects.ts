export type Subject = 'algorithms' | 'sql' | 'knowledge'
export const subjects: { id: Subject; title: string; description: string; href: string }[] = [
  { id: 'algorithms', title: 'Algorithms', description: 'Model the problem, experiment, write a complete ACM program, and reflect.', href: '/learning/algorithms' },
  { id: 'sql', title: 'SQL', description: 'Read relational data, write queries, compare expected rows, and explain.', href: '/learning/sql' },
  { id: 'knowledge', title: 'Interview & Quizzes', description: 'Understand concepts, answer interview prompts, and practise written-test choices.', href: '/learning/interviews' },
]
export type PathSummary = { id: string; title: string; objective: string; subject?: Subject; overview_note_id?: number; lessons: { id: string; title: string; stage?: string; checkpoint_count?: number }[] }
