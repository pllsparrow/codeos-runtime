import { useMemo, type ReactNode } from 'react'
import { canonicalContentHref } from './contentRegistry'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

export type MarkdownNode = { type?: string; value?: string; depth?: number; children?: MarkdownNode[]; position?: { start: { offset: number }; end: { offset: number } }; data?: { hProperties?: Record<string, unknown> } }
type Heading = { id: string; text: string; level: number; from: number }
type OutlineEntry = Heading & { children: OutlineEntry[] }
const textOf = (node: MarkdownNode): string => node.value || (node.children || []).map(textOf).join('')
function indexHeadings(tree: MarkdownNode): Heading[] {
  const result: Heading[] = []
  const walk = (node: MarkdownNode) => {
    if (node.type === 'heading') {
      const id = `note-heading-${result.length + 1}`
      node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id } }
      result.push({ id, text: textOf(node), level: node.depth || 1, from: node.position?.start.offset || 0 })
    }
    node.children?.forEach(walk)
  }
  walk(tree)
  return result
}
const headingIds = () => (tree: MarkdownNode) => { indexHeadings(tree) }
function outlineTree(headings: Heading[]): OutlineEntry[] {
  const roots: OutlineEntry[] = [], parents: OutlineEntry[] = []
  for (const heading of headings) {
    const item: OutlineEntry = { ...heading, children: [] }
    while (parents.length && parents.at(-1)!.level >= item.level) parents.pop()
    // Skipped heading levels attach to the nearest preceding lower-level heading.
    const siblings = parents.at(-1)?.children || roots
    siblings.push(item)
    parents.push(item)
  }
  return roots
}
function OutlineList({ items, onNavigate }: { items: OutlineEntry[]; onNavigate?: (from: number) => void }) {
  return <ul>{items.map((item) => <li key={item.id} data-level={item.level}>
    <a href={`#${item.id}`} onClick={(event) => {
      event.preventDefault()
      if (onNavigate) { onNavigate(item.from); return }
      const target = event.currentTarget.closest('.notes-reading-layout')?.querySelector<HTMLElement>(`.notes-document #${item.id}`)
      if (!target) return
      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      target.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' })
      target.setAttribute('tabindex', '-1')
      target.focus({ preventScroll: true })
      const url = new URL(window.location.href)
      url.hash = item.id
      window.history.replaceState(window.history.state, '', url)
    }}><span className="notes-outline-mark" aria-hidden="true" /><span>{item.text}</span></a>
    {item.children.length > 0 && <OutlineList items={item.children} onNavigate={onNavigate} />}
  </li>)}</ul>
}
export function NotesBody({ content }: { content: string }) {
  return <ReactMarkdown components={{ a: ({ href, children, ...props }) => <a {...props} href={canonicalContentHref(href || '')}>{children}</a> }} remarkPlugins={[remarkGfm, headingIds]}>{content}</ReactMarkdown>
}
export default function NotesMarkdown({ content, children, header, onNavigate }: { content: string; children?: ReactNode; header?: ReactNode; onNavigate?: (from: number) => void }) {
  const headings = useMemo(() => outlineTree(indexHeadings(unified().use(remarkParse).use(remarkGfm).parse(content) as MarkdownNode)), [content])
  return <div className="notes-reading-layout">
    <article className="notes-document">{header}{children || <NotesBody content={content} />}</article>
    <aside className="notes-outline" aria-label="Article outline"><strong>ON THIS PAGE</strong><nav aria-label="Article headings">{headings.length ? <OutlineList items={headings} onNavigate={onNavigate} /> : <small>No headings yet.</small>}</nav></aside>
  </div>
}
