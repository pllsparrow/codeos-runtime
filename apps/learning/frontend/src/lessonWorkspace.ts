export const lessonStages = [
  { id: 'read', title: 'Read', description: 'Understand and predict' },
  { id: 'experiment', title: 'Experiment', description: 'Decompose in Jupy' },
  { id: 'solve', title: 'Solve', description: 'Complete the program' },
  { id: 'reflect', title: 'Reflect', description: 'Explain and save evidence' },
] as const
export type LessonStage = typeof lessonStages[number]['id']
export function lessonStage(search: string): LessonStage {
  const value = new URLSearchParams(search).get('stage')
  return lessonStages.find(stage => stage.id === value)?.id || 'read'
}
export function stageHref(pathname: string, search: string, stage: LessonStage): string {
  const params = new URLSearchParams(search)
  params.set('stage', stage)
  return `${pathname}?${params}`
}
