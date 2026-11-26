import { createElement, type HTMLAttributes, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

export function markdownUrl(value: string): string | undefined {
  const safe = defaultUrlTransform(value)
  if (!safe) return undefined
  const protocol = safe.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase()
  return protocol && !['http', 'https', 'mailto'].includes(protocol) ? undefined : safe
}

const components: Components = {
  a: ({ children, href }) => createElement('a', { href, target: href?.startsWith('http') ? '_blank' : undefined, rel: 'noreferrer noopener' }, children),
  img: ({ alt }) => createElement('span', { className: 'lab-markdown-image-placeholder' }, alt || 'Image'),
}

export default function MarkdownPreview({ source, sourcePositions = false }: { source: string; sourcePositions?: boolean }) {
  const positioned: Components = { ...components }
  if (sourcePositions) {
    for (const tag of ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'td', 'th', 'code', 'strong', 'em'] as const) {
      const render = ({ node, children, ...props }: HTMLAttributes<HTMLElement> & { children?: ReactNode; node?: { position?: { start: { offset?: number } } } }) => createElement(tag, { ...props, 'data-source-from': node?.position?.start.offset }, children)
      Object.assign(positioned, { [tag]: render })
    }
  }
  return createElement('div', { className: 'lab-markdown-preview', 'aria-label': 'Markdown preview' },
    createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], skipHtml: true, urlTransform: markdownUrl, components: positioned, children: source }))
}
