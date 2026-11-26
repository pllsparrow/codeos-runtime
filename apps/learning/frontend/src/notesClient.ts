export type NoteMeta = { id: number; path: string; title: string; updated_at: string; created_at: string; deleted_at: string | null; source_path: string | null }
export type Note = NoteMeta & { content: string }
export type Folder = { path: string; version: string }
export type Catalog = { notes: NoteMeta[]; folders: Folder[]; management_ready: boolean }
export type Draft = { title: string; content: string; folder: string }
export type Recovery = { id: number; expected_version: string; draft: Draft }
export const notesBase = '/api/codelab/learning/note-workspace'
export const folderOf = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
export const asDraft = (note: Note): Draft => ({ title: note.title, content: note.content, folder: folderOf(note.path) })
export const changed = (note: Note | null, draft: Draft | null): boolean => Boolean(note && draft && JSON.stringify(asDraft(note)) !== JSON.stringify(draft))
export const noteHref = (id: number) => `/learning/knowledge/notes/${id}`
export const draftKey = (id: number) => `codeos.notes.draft.${id}`

export class NotesFailure extends Error {
  constructor(message: string, public status: number) { super(message) }
}
export async function notesRequest<T>(path = '', options: RequestInit = {}): Promise<T> {
  const response = await fetch(notesBase + path, { ...options, cache: options.cache || 'no-store', headers: { 'Content-Type': 'application/json', ...options.headers } })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new NotesFailure(typeof body.detail === 'string' ? body.detail : `Notes request failed (${response.status})`, response.status)
  return body as T
}

export function recoveryFrom(raw: string | null, id: number): Recovery | null {
  try {
    const item = JSON.parse(raw || 'null') as Recovery | null
    if (!item || item.id !== id || typeof item.expected_version !== 'string' || !item.draft ||
      !['title', 'content', 'folder'].every((key) => typeof item.draft[key as keyof Draft] === 'string')) return null
    return item
  } catch { return null }
}

export function downloadNote(title: string, content: string) {
  const filename = (title.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'Note') + '.md'
  const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }))
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
