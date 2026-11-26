const LAST_NOTEBOOK_KEY = 'codeos.jupy.last-notebook'

type ResumeStorage = Pick<Storage, 'getItem' | 'setItem'>

export function lastNotebook(storage?: ResumeStorage, context = ''): string {
  try {
    return (storage || window.localStorage).getItem(context ? `${LAST_NOTEBOOK_KEY}.lesson.${context}` : LAST_NOTEBOOK_KEY) || ''
  } catch {
    return ''
  }
}

export function rememberNotebook(path: string, storage?: ResumeStorage, context = ''): void {
  try {
    (storage || window.localStorage).setItem(context ? `${LAST_NOTEBOOK_KEY}.lesson.${context}` : LAST_NOTEBOOK_KEY, path)
  } catch {
    // Viewing remains available when browser storage is disabled or full.
  }
}

export function initialNotebook(search: string, isJupy: boolean, storage?: ResumeStorage): string {
  const params = new URLSearchParams(search), context = params.get('learning_context') || ''
  return params.get('notebook') || (isJupy ? lastNotebook(storage, context) : '')
}
