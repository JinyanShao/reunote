import { describe, expect, it } from 'vitest'
import { centeredWorldPosition } from './canvasPlacement'

describe('centeredWorldPosition', () => {
  it('centers an item in the visible world after pan and zoom', () => {
    expect(
      centeredWorldPosition(
        { x: -200, y: 100, zoom: 2 },
        { width: 1000, height: 700 },
        { width: 300, height: 200 }
      )
    ).toEqual({ x: 200, y: 25 })
  })

  it('offsets consecutive pasted items without changing the center basis', () => {
    expect(
      centeredWorldPosition(
        { x: 0, y: 0, zoom: 1 },
        { width: 900, height: 600 },
        { width: 300, height: 200 },
        28
      )
    ).toEqual({ x: 328, y: 228 })
  })
})
