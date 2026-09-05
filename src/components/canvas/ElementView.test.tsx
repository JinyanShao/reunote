// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const richTextRender = vi.hoisted(() => vi.fn(() => null))

vi.mock('../editor/RichText', () => ({ RichText: richTextRender }))

import type { CanvasElement } from '../../lib/types'
import { ElementView } from './ElementView'

const noop = () => undefined

function textElement(): CanvasElement {
  return {
    id: 'moving-text',
    type: 'text',
    x: 30,
    y: 40,
    w: 360,
    h: 500,
    rotation: 0,
    z: 1,
    html: '<p>很多公式</p>',
    bg: 'transparent',
    border: 'transparent',
    fontFamily: 'sans',
    fontScale: 1,
    padding: 10,
  }
}

describe('ElementView movement rendering', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    richTextRender.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('updates only the composited outer transform while dragging', async () => {
    const el = textElement()
    const render = (offset?: { dx: number; dy: number }) =>
      root.render(
        <ElementView
          el={el}
          selected
          editing={false}
          offset={offset}
          onPointerDown={noop}
          onDoubleClick={noop}
          onChangeHtml={noop}
          onStopEditing={noop}
        />
      )

    await act(async () => render())
    expect(richTextRender).toHaveBeenCalledTimes(1)

    await act(async () => render({ dx: 125, dy: -35 }))

    const element = container.querySelector<HTMLElement>('[data-element-id="moving-text"]')!
    expect(element.style.left).toBe('30px')
    expect(element.style.top).toBe('40px')
    expect(element.style.transform).toBe('translate3d(125px, -35px, 0)')
    expect(element.style.willChange).toBe('transform')
    expect(richTextRender).toHaveBeenCalledTimes(1)
  })
})
