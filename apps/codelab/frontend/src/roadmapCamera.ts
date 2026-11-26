export type MapCamera = { x: number; y: number; zoom: number }
export const DEFAULT_CAMERA: MapCamera = { x: 0, y: 96, zoom: 0.82 }
export const CAMERA_STORAGE_KEY = 'codeos.practice.map.camera.v1'
export const TOPIC_STORAGE_KEY = 'codeos.practice.map.topic.v1'

export function zoomAt(camera: MapCamera, zoom: number, anchor: { x: number; y: number }, center: number): MapCamera {
  const nextZoom = Math.max(0.45, Math.min(1.3, zoom))
  const ratio = nextZoom / camera.zoom
  // Anchor coordinates are relative to the viewport's horizontal center and mobile top inset.
  const worldX = camera.x - center * camera.zoom
  return { x: anchor.x - (anchor.x - worldX) * ratio + center * nextZoom, y: anchor.y - (anchor.y - camera.y) * ratio, zoom: nextZoom }
}

export function restoreCamera(raw: string | null): MapCamera {
  try {
    const value = JSON.parse(raw || 'null')
    if (value && [value.x, value.y, value.zoom].every((item) => typeof item === 'number' && Number.isFinite(item)) && value.zoom >= 0.45 && value.zoom <= 1.3 && Math.abs(value.x) < 10000 && Math.abs(value.y) < 10000) return { x: value.x, y: value.y, zoom: value.zoom }
  } catch { /* Unavailable or obsolete view state falls back to the initial view. */ }
  return { ...DEFAULT_CAMERA }
}
