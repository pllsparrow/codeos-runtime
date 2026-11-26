import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { StateEffect, StateField, type EditorState, type Range } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view'
import type { MarkdownNode } from './NotesMarkdown'

const parser = unified().use(remarkParse).use(remarkGfm)
export const previewFocus = StateEffect.define<boolean>()
export const previewComposition = StateEffect.define<boolean>()
type Block = MarkdownNode & { position: NonNullable<MarkdownNode['position']> }
const bounds = (node: MarkdownNode) => [node.position?.start.offset || 0, node.position?.end.offset || 0] as const

// Keep rendered text tied to its source, including repeated words in lists and tables.
const positioned: Components = Object.fromEntries(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'td', 'th', 'strong', 'em', 'code', 'a'].map((tag) => [tag, ({ node, ...props }: { node?: { position?: { start: { offset?: number } } } }) => createElement(tag, { ...props, 'data-source-from': node?.position?.start.offset || 0 })]))

export function caretSourceOffset(source: string, text: string, offset: number, scopeFrom = 0) {
  const start = text ? source.indexOf(text, scopeFrom) : -1
  return start < 0 ? scopeFrom : start + Math.min(text.length, Math.max(0, offset))
}
class PreviewBlock extends WidgetType {
  private root?: Root
  constructor(readonly source: string, readonly references: string) { super() }
  eq(other: PreviewBlock) { return this.source === other.source && this.references === other.references }
  toDOM(view: EditorView) {
    const element = document.createElement('div')
    element.className = 'notes-live-block'
    this.root = createRoot(element)
    this.root.render(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], components: positioned, children: this.source + this.references }))
    element.addEventListener('pointerdown', (event) => {
      if (view.state.readOnly || event.button !== 0 || event.target instanceof Element && event.target.closest('a')) return
      const doc = element.ownerDocument as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null }
      const caret = doc.caretPositionFromPoint?.(event.clientX, event.clientY)
      const range = !caret ? doc.caretRangeFromPoint?.(event.clientX, event.clientY) : null
      const node = caret?.offsetNode || range?.startContainer
      const offset = caret?.offset ?? range?.startOffset ?? 0
      const text = node?.nodeType === Node.TEXT_NODE && element.contains(node) ? node.textContent || '' : ''
      const scope = Number((node?.parentElement || (event.target instanceof Element ? event.target : null))?.closest('[data-source-from]')?.getAttribute('data-source-from') || 0)
      const from = view.posAtDOM(element)
      const anchor = Math.min(view.state.doc.length, from + caretSourceOffset(this.source, text, offset, scope))
      event.preventDefault()
      view.dispatch({ selection: { anchor }, effects: previewFocus.of(true) })
      view.focus()
    })
    return element
  }
  destroy() { const root = this.root; if (root) queueMicrotask(() => root.unmount()) }
  ignoreEvent() { return true }
}
class ListBullet extends WidgetType {
  toDOM() { const span = document.createElement('span'); span.textContent = '•'; span.className = 'notes-list-bullet'; return span }
  ignoreEvent() { return false }
}
class TaskCheckbox extends WidgetType {
  constructor(readonly checked: boolean, readonly readOnly: boolean) { super() }
  eq(other: TaskCheckbox) { return this.checked === other.checked && this.readOnly === other.readOnly }
  toDOM(view: EditorView) {
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = this.checked
    input.className = 'notes-task-checkbox'; input.disabled = this.readOnly
    input.setAttribute('aria-label', this.checked ? 'Mark task incomplete' : 'Mark task complete')
    input.addEventListener('mousedown', (event) => event.preventDefault())
    input.addEventListener('change', () => {
      if (view.state.readOnly) return
      const from = view.posAtDOM(input)
      view.dispatch({ changes: { from: from + 1, to: from + 2, insert: input.checked ? 'x' : ' ' } })
      view.focus()
    })
    return input
  }
  ignoreEvent() { return true }
}
function selected(state: EditorState, from: number, to: number) {
  return state.selection.ranges.some((range) => range.from <= to && range.to >= from)
}
function decorate(state: EditorState, tree: MarkdownNode, focused: boolean) {
  const ranges: Range<Decoration>[] = [], lines = new Map<number, Set<string>>()
  const addLine = (from: number, name: string) => {
    const start = state.doc.lineAt(from).from
    if (!lines.has(start)) lines.set(start, new Set())
    lines.get(start)!.add(name)
  }
  const hide = (from: number, to: number) => {
    if (to > from && !(focused && selected(state, from, to))) ranges.push(Decoration.replace({}).range(from, to))
  }
  const mark = (from: number, to: number, name: string) => { if (to > from) ranges.push(Decoration.mark({ class: name }).range(from, to)) }
  const inline = (node: MarkdownNode) => {
    const [from, to] = bounds(node), source = state.sliceDoc(from, to)
    if (node.type === 'heading') {
      addLine(from, `notes-live-h${node.depth || 1}`)
      const prefix = source.match(/^#{1,6}\s+/)?.[0]
      if (prefix) hide(from, from + prefix.length)
      else { const underline = source.match(/\n[ \t]*(?:=+|-+)[ \t]*$/); if (underline) hide(to - underline[0].length, to) }
    }
    if (node.type === 'strong' || node.type === 'emphasis' || node.type === 'delete') {
      const size = node.type === 'emphasis' ? 1 : 2
      mark(from, to, `notes-live-${node.type}`); hide(from, from + size); hide(to - size, to)
    }
    if (node.type === 'inlineCode') {
      const size = source.match(/^`+/)?.[0].length || 1
      mark(from, to, 'notes-live-inline-code'); hide(from, from + size); hide(to - size, to)
    }
    if (node.type === 'link' || node.type === 'linkReference') {
      const first = node.children?.[0], last = node.children?.at(-1)
      if (first && last) { mark(from, to, 'notes-live-link'); hide(from, bounds(first)[0]); hide(bounds(last)[1], to) }
    }
    if (node.type === 'listItem') {
      const prefix = source.match(/^([ \t]*)([-+*]|\d+[.)])\s+(\[[ xX]\]\s+)?/)
      if (prefix) {
        const marker = from + prefix[1].length
        addLine(from, 'notes-live-list-item')
        if (prefix[3]) {
          const taskFrom = from + prefix[0].indexOf('[')
          hide(marker, taskFrom)
          ranges.push(Decoration.replace({ widget: new TaskCheckbox(/\[[xX]\]/.test(prefix[3]), state.readOnly) }).range(taskFrom, taskFrom + 3))
        } else if (prefix[2].length === 1) ranges.push(Decoration.replace({ widget: new ListBullet() }).range(marker, marker + 1))
      }
    }
    if (node.type === 'blockquote') {
      for (let line = state.doc.lineAt(from); line.from < to; line = state.doc.line(line.number + 1)) {
        addLine(line.from, 'notes-live-quote')
        const prefix = line.text.match(/^\s*>\s?/)
        if (prefix) hide(line.from, line.from + prefix[0].length)
        if (line.number === state.doc.lines) break
      }
    }
    node.children?.forEach(inline)
  }
  const references = (tree.children || []).filter((node) => node.type === 'definition').map((node) => state.sliceDoc(...bounds(node))).join('\n')
  for (const node of tree.children || []) {
    if (!node.position) continue
    const block = node as Block, [from, to] = bounds(block)
    if (to <= from || block.type === 'definition') continue
    if (!(focused && selected(state, from, to))) {
      ranges.push(Decoration.replace({ block: true, widget: new PreviewBlock(state.sliceDoc(from, to), references ? '\n\n' + references : '') }).range(from, to))
    } else {
      inline(block)
      if (block.type === 'table' || block.type === 'code' || block.type === 'html') {
        for (let line = state.doc.lineAt(from); line.from < to; line = state.doc.line(line.number + 1)) {
          addLine(line.from, 'notes-live-source-block')
          if (line.number === state.doc.lines) break
        }
      }
    }
  }
  for (const [from, names] of lines) ranges.push(Decoration.line({ class: [...names].join(' ') }).range(from))
  return Decoration.set(ranges, true)
}
type PreviewState = { tree: MarkdownNode; focused: boolean; composing: boolean; decorations: DecorationSet }
export const livePreviewField = StateField.define<PreviewState>({
  create(state) { const tree = parser.parse(state.doc.toString()) as MarkdownNode; return { tree, focused: false, composing: false, decorations: decorate(state, tree, false) } },
  update(value, transaction) {
    let { focused, composing } = value
    for (const effect of transaction.effects) {
      if (effect.is(previewFocus)) focused = effect.value
      if (effect.is(previewComposition)) composing = effect.value
    }
    const tree = transaction.docChanged ? parser.parse(transaction.state.doc.toString()) as MarkdownNode : value.tree
    const changed = transaction.docChanged || transaction.selection || transaction.reconfigured || focused !== value.focused || composing !== value.composing
    return { tree, focused, composing, decorations: composing ? value.decorations.map(transaction.changes) : changed ? decorate(transaction.state, tree, focused) : value.decorations }
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
})
export const notesLivePreview = [livePreviewField, ViewPlugin.define((view) => {
  let destroyed = false
  const sync = (effect: ReturnType<typeof previewFocus.of> | ReturnType<typeof previewComposition.of>) => queueMicrotask(() => { if (!destroyed) view.dispatch({ effects: effect }) })
  return { destroy() { destroyed = true }, focus() { sync(previewFocus.of(view.hasFocus)) }, compositionEnd() { sync(previewComposition.of(false)) } }
}, { eventHandlers: {
  focus() { this.focus() }, blur() { this.focus() },
  compositionstart(_event, view) { view.dispatch({ effects: previewComposition.of(true) }) },
  compositionend() { this.compositionEnd() },
} })]
