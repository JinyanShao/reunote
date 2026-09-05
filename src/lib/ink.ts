import getStroke from 'perfect-freehand'
import type { Stroke } from './types'

export interface StrokeOptions {
  size: number
  thinning: number
  smoothing: number
  streamline: number
  simulatePressure: boolean
  easing: (t: number) => number
  start: { taper: number; cap: boolean }
  end: { taper: number; cap: boolean }
}

export function optionsFor(stroke: Pick<Stroke, 'size' | 'tool'>): StrokeOptions {
  if (stroke.tool === 'highlighter') {
    return {
      size: stroke.size,
      thinning: 0,
      smoothing: 0.6,
      streamline: 0.45,
      simulatePressure: false,
      easing: (t) => t,
      start: { taper: 0, cap: false },
      end: { taper: 0, cap: false },
    }
  }
  return {
    size: stroke.size,
    thinning: 0.62,
    smoothing: 0.55,
    streamline: 0.42,
    simulatePressure: true,
    easing: (t) => Math.sin((t * Math.PI) / 2),
    start: { taper: 0, cap: true },
    end: { taper: 0, cap: true },
  }
}

/** 把外轮廓点转成 SVG path（二次贝塞尔平滑） */
export function outlineToPath(points: number[][]): string {
  if (!points.length) return ''
  const d = points.reduce(
    (acc, [x0, y0], i, arr) => {
      const [x1, y1] = arr[(i + 1) % arr.length]
      acc.push(x0.toFixed(2), y0.toFixed(2), ((x0 + x1) / 2).toFixed(2), ((y0 + y1) / 2).toFixed(2))
      return acc
    },
    ['M', points[0][0].toFixed(2), points[0][1].toFixed(2), 'Q'] as string[]
  )
  d.push('Z')
  return d.join(' ')
}

export function strokeToPath(stroke: Pick<Stroke, 'points' | 'size' | 'tool'>): string {
  if (!stroke.points || stroke.points.length === 0) return ''
  const outline = getStroke(stroke.points, optionsFor(stroke) as never) as number[][]
  return outlineToPath(outline)
}

/** 笔迹包围盒（用于套索命中与导出裁剪） */
export function strokeBounds(stroke: Stroke) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of stroke.points) {
    if (p[0] < minX) minX = p[0]
    if (p[1] < minY) minY = p[1]
    if (p[0] > maxX) maxX = p[0]
    if (p[1] > maxY) maxY = p[1]
  }
  const pad = stroke.size / 2 + 2
  return {
    x: minX - pad,
    y: minY - pad,
    w: maxX - minX + pad * 2,
    h: maxY - minY + pad * 2,
  }
}

export function pointInPolygon(x: number, y: number, poly: number[][]) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0]
    const yi = poly[i][1]
    const xj = poly[j][0]
    const yj = poly[j][1]
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-9) + xi
    if (intersect) inside = !inside
  }
  return inside
}

/** 橡皮命中检测：笔迹上任意采样点落在半径内即视为命中 */
export function strokeHitsCircle(stroke: Stroke, cx: number, cy: number, r: number) {
  const rr = (r + stroke.size / 2) ** 2
  const pts = stroke.points
  for (let i = 0; i < pts.length; i++) {
    const dx = pts[i][0] - cx
    const dy = pts[i][1] - cy
    if (dx * dx + dy * dy <= rr) return true
    // 线段中点补采样，避免快速划过时漏判
    if (i + 1 < pts.length) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2
      const my = (pts[i][1] + pts[i + 1][1]) / 2
      const ddx = mx - cx
      const ddy = my - cy
      if (ddx * ddx + ddy * ddy <= rr) return true
    }
  }
  return false
}

/** 简易形状识别：把随手画的封闭线条识别为矩形 / 椭圆 / 直线 */
export function recognizeShape(points: number[][]):
  | { kind: 'rect' | 'ellipse'; x: number; y: number; w: number; h: number }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number }
  | null {
  if (points.length < 12) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let length = 0
  for (let i = 0; i < points.length; i++) {
    const [x, y] = points[i]
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
    if (i > 0) {
      length += Math.hypot(x - points[i - 1][0], y - points[i - 1][1])
    }
  }
  const w = maxX - minX
  const h = maxY - minY
  if (w < 24 && h < 24) return null

  const start = points[0]
  const end = points[points.length - 1]
  const gap = Math.hypot(end[0] - start[0], end[1] - start[1])
  const diag = Math.hypot(w, h)

  // 直线：位移接近路径长度
  if (gap > diag * 0.9 && length < gap * 1.16) {
    return { kind: 'line', x1: start[0], y1: start[1], x2: end[0], y2: end[1] }
  }

  // 闭合图形
  if (gap > diag * 0.32) return null

  const perimRect = 2 * (w + h)
  const perimEllipse = Math.PI * (1.5 * (w / 2 + h / 2) - Math.sqrt((w / 2) * (h / 2)))
  const dRect = Math.abs(length - perimRect)
  const dEllipse = Math.abs(length - perimEllipse)
  if (Math.min(dRect, dEllipse) > Math.max(perimRect, perimEllipse) * 0.42) return null

  return {
    kind: dEllipse < dRect ? 'ellipse' : 'rect',
    x: minX,
    y: minY,
    w,
    h,
  }
}
