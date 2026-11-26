import { useEffect, useRef, type ReactNode } from 'react'

/** A secondary-actions disclosure with native keyboard activation and focus-safe dismissal. */
export default function WorkbenchMenu({ label, icon, children }: { label: string; icon: ReactNode; children: ReactNode }) {
  const menu = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const dismiss = (event: PointerEvent | KeyboardEvent) => {
      const element = menu.current
      if (!element?.open) return
      if (event.type === 'keydown') {
        if ((event as KeyboardEvent).key !== 'Escape') return
        event.preventDefault()
        element.open = false
        element.querySelector('summary')?.focus()
      } else if (!element.contains(event.target as Node)) element.open = false
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', dismiss)
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', dismiss) }
  }, [])
  return <details ref={menu} className="workbench-menu" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false }}>
    <summary aria-label={label} title={label}>{icon}</summary>
    <div className="workbench-menu-panel" aria-label={`${label} options`} onClick={event => {
      if (!(event.target as Element).closest('button:not(:disabled), a[href]')) return
      const element = menu.current
      if (!element) return
      const restore = element.contains(document.activeElement)
      element.open = false
      if (restore) element.querySelector('summary')?.focus()
    }}>{children}</div>
  </details>
}
