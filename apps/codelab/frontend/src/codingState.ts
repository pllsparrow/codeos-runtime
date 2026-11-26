export type CodingProblem = { index: number; title: string; slug: string; category: string; difficulty: string; progress: string }

export function categorySelection(value: string | null): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(0, 50) : []
  } catch {
    return []
  }
}

export function filterCodingProblems<T extends CodingProblem>(items: T[], query: string, difficulty: string, categories: string[], progress: string): T[] {
  const needle = query.trim().toLocaleLowerCase()
  return items.filter((item) => (!needle || `${item.index} ${item.title} ${item.slug} ${item.category}`.toLocaleLowerCase().includes(needle)) &&
    (!difficulty || item.difficulty === difficulty) && (!categories.length || categories.includes(item.category)) &&
    (!progress || (progress === 'unresolved' ? item.progress !== 'accepted' : item.progress === progress)))
}

export function sameDraft(saved: { index: number; source: string; language?: string }, current: { index: number; source: string; language?: string }): boolean {
  return saved.index === current.index && saved.source === current.source && (saved.language || 'python') === (current.language || 'python')
}
