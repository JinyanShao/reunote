import type { Viewport } from './store'

export interface Size {
  width: number
  height: number
}

export function centeredWorldPosition(
  viewport: Viewport,
  canvas: Size,
  item: Size,
  cascade = 0
) {
  return {
    x: Math.round((canvas.width / 2 - viewport.x) / viewport.zoom - item.width / 2 + cascade),
    y: Math.round((canvas.height / 2 - viewport.y) / viewport.zoom - item.height / 2 + cascade),
  }
}
