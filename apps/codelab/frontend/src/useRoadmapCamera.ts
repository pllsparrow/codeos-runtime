import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { CAMERA_STORAGE_KEY, DEFAULT_CAMERA, restoreCamera, zoomAt, type MapCamera } from './roadmapCamera'

type Point = { x: number; y: number }
type Gesture = { start: Point; time: number; velocity: Point; moved: boolean }

export function useRoadmapCamera(center: number, canvasWidth: number, canvasHeight: number) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [camera, setCamera] = useState(() => {
    try { return restoreCamera(sessionStorage.getItem(CAMERA_STORAGE_KEY)) } catch { return { ...DEFAULT_CAMERA } }
  })
  const [isPanning, setIsPanning] = useState(false)
  const current = useRef(camera)
  const frame = useRef(0)
  const motion = useRef(0)
  const saveTimer = useRef(0)
  const wheelTarget = useRef<MapCamera | undefined>(undefined)
  const pointers = useRef(new Map<number, Point>())
  const gesture = useRef<Gesture | undefined>(undefined)
  const suppressClick = useRef(false)
  const geometry = useRef({ center, canvasWidth, canvasHeight, ...size })
  geometry.current = { center, canvasWidth, canvasHeight, ...size }

  const persist = useCallback(() => {
    try { sessionStorage.setItem(CAMERA_STORAGE_KEY, JSON.stringify(current.current)) } catch { /* View restoration is optional. */ }
  }, [])
  const stop = useCallback(() => { cancelAnimationFrame(motion.current); motion.current = 0; wheelTarget.current = undefined }, [])
  const constrain = useCallback((next: MapCamera): MapCamera => {
    const g = geometry.current
    const inset = g.width <= 860 ? 130 : 0
    return { ...next,
      x: g.width ? Math.max(96 - g.width / 2 - (g.canvasWidth - g.center) * next.zoom, Math.min(g.width / 2 - 96 + g.center * next.zoom, next.x)) : next.x,
      y: g.height ? Math.max(96 - g.canvasHeight * next.zoom - inset, Math.min(g.height - 96 - inset, next.y)) : next.y,
    }
  }, [])
  const publish = useCallback((next: MapCamera) => {
    current.current = constrain(next)
    if (!frame.current) frame.current = requestAnimationFrame(() => { frame.current = 0; setCamera(current.current); window.clearTimeout(saveTimer.current); saveTimer.current = window.setTimeout(persist, 150) })
  }, [constrain, persist])
  const anchorAt = useCallback((point: Point) => {
    const bounds = viewportRef.current!.getBoundingClientRect()
    return { x: point.x - bounds.left - bounds.width / 2, y: point.y - bounds.top - (bounds.width <= 860 ? 130 : 0) }
  }, [])
  const animateTo = useCallback((target: MapCamera) => {
    stop()
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { publish(target); return }
    const from = current.current
    const started = performance.now()
    const tick = (now: number) => {
      const t = Math.min(1, (now - started) / 180)
      const eased = 1 - (1 - t) ** 3
      publish({ x: from.x + (target.x - from.x) * eased, y: from.y + (target.y - from.y) * eased, zoom: from.zoom + (target.zoom - from.zoom) * eased })
      if (t < 1) motion.current = requestAnimationFrame(tick)
      else motion.current = 0
    }
    motion.current = requestAnimationFrame(tick)
  }, [publish, stop])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }))
    observer.observe(viewport)
    const wheel = (event: WheelEvent) => {
      if ((event.target as HTMLElement).closest('.route-index-popover, .practice-floating-rail, .practice-canvas-controls, .practice-map-heading')) return
      event.preventDefault()
      if (!wheelTarget.current) stop()
      const base = wheelTarget.current || current.current
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1
      if (event.ctrlKey || event.metaKey) {
        wheelTarget.current = constrain(zoomAt(base, base.zoom * Math.exp(Math.max(-0.18, Math.min(0.18, -event.deltaY * unit * 0.008))), anchorAt({ x: event.clientX, y: event.clientY }), geometry.current.center))
      } else {
        wheelTarget.current = constrain({ ...base, x: base.x - event.deltaX * unit, y: base.y - event.deltaY * unit })
      }
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { publish(wheelTarget.current); wheelTarget.current = undefined; return }
      if (!motion.current) {
        let last = performance.now()
        const glide = (now: number) => {
          const target = wheelTarget.current
          if (!target) return
          const amount = 1 - Math.exp(-Math.min(40, Math.max(8, now - last)) / 40)
          last = now
          const from = current.current
          const finished = Math.abs(from.x - target.x) + Math.abs(from.y - target.y) < 0.25 && Math.abs(from.zoom - target.zoom) < 0.0005
          publish(finished ? target : { x: from.x + (target.x - from.x) * amount, y: from.y + (target.y - from.y) * amount, zoom: from.zoom + (target.zoom - from.zoom) * amount })
          if (finished) { wheelTarget.current = undefined; motion.current = 0 }
          else motion.current = requestAnimationFrame(glide)
        }
        motion.current = requestAnimationFrame(glide)
      }
    }
    viewport.addEventListener('wheel', wheel, { passive: false })
    window.addEventListener('pagehide', persist)
    return () => {
      observer.disconnect(); viewport.removeEventListener('wheel', wheel); window.removeEventListener('pagehide', persist)
      stop(); cancelAnimationFrame(frame.current); frame.current = 0; window.clearTimeout(saveTimer.current); persist()
    }
  }, [anchorAt, constrain, persist, publish, stop])

  const beginPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    suppressClick.current = false
    if (event.button !== 0 || (event.target as HTMLElement).closest('.route-index-popover, .practice-floating-rail, .practice-canvas-controls, .practice-map-heading')) return
    stop()
    const point = { x: event.clientX, y: event.clientY }
    pointers.current.set(event.pointerId, point)
    gesture.current = { start: point, time: performance.now(), velocity: { x: 0, y: 0 }, moved: pointers.current.size > 1 }
  }
  const movePan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const previous = pointers.current.get(event.pointerId)
    const g = gesture.current
    if (!previous || !g) return
    const next = { x: event.clientX, y: event.clientY }
    const others = [...pointers.current.entries()].filter(([id]) => id !== event.pointerId)
    if (!g.moved && Math.hypot(next.x - g.start.x, next.y - g.start.y) < 4) return
    g.moved = true; suppressClick.current = true; setIsPanning(true)
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.setPointerCapture(event.pointerId)
    if (others.length) {
      const other = others[0][1]
      const oldMid = { x: (previous.x + other.x) / 2, y: (previous.y + other.y) / 2 }
      const newMid = { x: (next.x + other.x) / 2, y: (next.y + other.y) / 2 }
      const ratio = Math.hypot(next.x - other.x, next.y - other.y) / Math.max(1, Math.hypot(previous.x - other.x, previous.y - other.y))
      const zoomed = zoomAt(current.current, current.current.zoom * ratio, anchorAt(oldMid), center)
      publish({ ...zoomed, x: zoomed.x + newMid.x - oldMid.x, y: zoomed.y + newMid.y - oldMid.y })
      g.velocity = { x: 0, y: 0 }
    } else {
      const now = performance.now()
      const dt = Math.max(8, now - g.time)
      g.velocity = { x: (next.x - previous.x) / dt, y: (next.y - previous.y) / dt }
      g.time = now
      publish({ ...current.current, x: current.current.x + next.x - previous.x, y: current.current.y + next.y - previous.y })
    }
    pointers.current.set(event.pointerId, next)
  }
  const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return
    pointers.current.delete(event.pointerId)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    const g = gesture.current
    if (pointers.current.size) {
      const remaining = [...pointers.current.values()][0]
      gesture.current = { start: remaining, time: performance.now(), velocity: { x: 0, y: 0 }, moved: true }
      return
    }
    gesture.current = undefined; setIsPanning(false)
    if (!g?.moved || event.type === 'pointercancel' || performance.now() - g.time > 80 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let vx = Math.max(-2.5, Math.min(2.5, g.velocity.x)), vy = Math.max(-2.5, Math.min(2.5, g.velocity.y))
    let last = performance.now()
    const coast = (now: number) => {
      const dt = Math.min(32, now - last); last = now
      const decay = Math.exp(-dt / 110); vx *= decay; vy *= decay
      publish({ ...current.current, x: current.current.x + vx * dt, y: current.current.y + vy * dt })
      if (Math.hypot(vx, vy) > 0.025) motion.current = requestAnimationFrame(coast)
      else motion.current = 0
    }
    motion.current = requestAnimationFrame(coast)
  }
  const adjustZoom = (delta: number) => {
    const bounds = viewportRef.current?.getBoundingClientRect()
    if (!bounds) return
    animateTo(zoomAt(current.current, current.current.zoom + delta, anchorAt({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }), center))
  }
  return { viewportRef, size, camera, isPanning, beginPan, movePan, endPan, suppressClick, adjustZoom, resetCanvas: () => animateTo({ ...DEFAULT_CAMERA }) }
}
