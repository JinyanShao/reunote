import type { CanvasElement } from './types'
import type { Viewport } from './store'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export function screenToWorld(sx: number, sy: number, vp: Viewport) {
  return { x: (sx - vp.x) / vp.zoom, y: (sy - vp.y) / vp.zoom }
}

export function worldToScreen(wx: number, wy: number, vp: Viewport) {
  return { x: wx * vp.zoom + vp.x, y: wy * vp.zoom + vp.y }
}

export function rectsIntersect(a: Rect, b: Rect) {
  return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y)
}

export function pointInRect(x: number, y: number, r: Rect) {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h
}

export function boundsOf(elements: CanvasElement[]): Rect | null {
  if (elements.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const e of elements) {
    minX = Math.min(minX, e.x)
    minY = Math.min(minY, e.y)
    maxX = Math.max(maxX, e.x + e.w)
    maxY = Math.max(maxY, e.y + e.h)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

export interface Guide {
  axis: 'x' | 'y'
  at: number
  from: number
  to: number
}

const SNAP_PX = 6

/**
 * 计算移动时的吸附偏移与参考线。
 * moving 为正在拖动的包围盒，others 为其他元素。
 */
export function computeSnap(
  moving: Rect,
  others: Rect[],
  zoom: number
): { dx: number; dy: number; guides: Guide[] } {
  const tol = SNAP_PX / Math.max(0.2, zoom)
  const guides: Guide[] = []
  let dx = 0
  let dy = 0
  let bestX = tol
  let bestY = tol

  const movingX = [moving.x, moving.x + moving.w / 2, moving.x + moving.w]
  const movingY = [moving.y, moving.y + moving.h / 2, moving.y + moving.h]

  for (const o of others) {
    const targetX = [o.x, o.x + o.w / 2, o.x + o.w]
    const targetY = [o.y, o.y + o.h / 2, o.y + o.h]

    for (const mx of movingX) {
      for (const tx of targetX) {
        const d = tx - mx
        if (Math.abs(d) < bestX) {
          bestX = Math.abs(d)
          dx = d
        }
      }
    }
    for (const my of movingY) {
      for (const ty of targetY) {
        const d = ty - my
        if (Math.abs(d) < bestY) {
          bestY = Math.abs(d)
          dy = d
        }
      }
    }
  }

  if (bestX < tol) {
    const at = moving.x + dx
    for (const o of others) {
      const targetX = [o.x, o.x + o.w / 2, o.x + o.w]
      for (const tx of targetX) {
        if (Math.abs(tx - (moving.x + dx)) < 0.5 || Math.abs(tx - (moving.x + moving.w + dx)) < 0.5 || Math.abs(tx - (moving.x + moving.w / 2 + dx)) < 0.5) {
          guides.push({
            axis: 'x',
            at: tx,
            from: Math.min(o.y, moving.y + dy),
            to: Math.max(o.y + o.h, moving.y + moving.h + dy),
          })
        }
      }
    }
    void at
  }
  if (bestY < tol) {
    for (const o of others) {
      const targetY = [o.y, o.y + o.h / 2, o.y + o.h]
      for (const ty of targetY) {
        if (Math.abs(ty - (moving.y + dy)) < 0.5 || Math.abs(ty - (moving.y + moving.h + dy)) < 0.5 || Math.abs(ty - (moving.y + moving.h / 2 + dy)) < 0.5) {
          guides.push({
            axis: 'y',
            at: ty,
            from: Math.min(o.x, moving.x + dx),
            to: Math.max(o.x + o.w, moving.x + moving.w + dx),
          })
        }
      }
    }
  }

  return { dx: bestX < tol ? dx : 0, dy: bestY < tol ? dy : 0, guides }
}

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

export function resizeRect(
  base: Rect,
  handle: Handle,
  dx: number,
  dy: number,
  keepRatio: boolean,
  min = 40
): Rect {
  let { x, y, w, h } = base
  const ratio = base.w / Math.max(1, base.h)

  if (handle.includes('e')) w = base.w + dx
  if (handle.includes('s')) h = base.h + dy
  if (handle.includes('w')) {
    w = base.w - dx
    x = base.x + dx
  }
  if (handle.includes('n')) {
    h = base.h - dy
    y = base.y + dy
  }

  if (keepRatio && handle.length === 2) {
    if (Math.abs(w - base.w) > Math.abs(h - base.h)) h = w / ratio
    else w = h * ratio
    if (handle.includes('w')) x = base.x + base.w - w
    if (handle.includes('n')) y = base.y + base.h - h
  }

  if (w < min) {
    if (handle.includes('w')) x = base.x + base.w - min
    w = min
  }
  if (h < min) {
    if (handle.includes('n')) y = base.y + base.h - min
    h = min
  }
  return { x, y, w, h }
}

export const HANDLES: { key: Handle; cursor: string; sx: number; sy: number }[] = [
  { key: 'nw', cursor: 'nwse-resize', sx: 0, sy: 0 },
  { key: 'n', cursor: 'ns-resize', sx: 0.5, sy: 0 },
  { key: 'ne', cursor: 'nesw-resize', sx: 1, sy: 0 },
  { key: 'e', cursor: 'ew-resize', sx: 1, sy: 0.5 },
  { key: 'se', cursor: 'nwse-resize', sx: 1, sy: 1 },
  { key: 's', cursor: 'ns-resize', sx: 0.5, sy: 1 },
  { key: 'sw', cursor: 'nesw-resize', sx: 0, sy: 1 },
  { key: 'w', cursor: 'ew-resize', sx: 0, sy: 0.5 },
]
