// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const renderMathHtml = vi.hoisted(() => vi.fn((html: string) => html))

vi.mock('../../lib/richTextMath', () => ({
  renderRichTextMathHtml: renderMathHtml,
}))

import { useCanvasAgent } from '../../lib/agent/store'
import { useApp } from '../../lib/store'
import type { CanvasDoc, CanvasElement } from '../../lib/types'
import { RichText } from '../editor/RichText'
import { CanvasStage } from './CanvasStage'

function textElement(): CanvasElement {
  return {
    id: 'long-formula-text',
    type: 'text',
    x: 40,
    y: 60,
    w: 420,
    h: 900,
    rotation: 0,
    z: 1,
    html: '<p>正文 \\(E=mc^2\\) 正文</p>',
    bg: 'transparent',
    border: 'transparent',
    fontFamily: 'sans',
    fontScale: 1,
    padding: 10,
  }
}

function canvasDoc(): CanvasDoc {
  return {
    version: 1,
    background: 'grid',
    elements: [textElement()],
    strokes: [],
  }
}

describe('canvas rendering performance guards', () => {
  let container: HTMLDivElement
  let root: Root
  let appState: ReturnType<typeof useApp.getState>
  let agentState: ReturnType<typeof useCanvasAgent.getState>

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    appState = useApp.getState()
    agentState = useCanvasAgent.getState()
    renderMathHtml.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    useApp.setState(appState, true)
    useCanvasAgent.setState(agentState, true)
    container.remove()
    document.body.innerHTML = ''
  })

  it('reuses rendered formula HTML while non-content props change', async () => {
    const html = '<p>正文 \\(E=mc^2\\) 正文</p>'

    await act(async () => root.render(<RichText html={html} editable={false} className="first" />))
    expect(renderMathHtml).toHaveBeenCalledTimes(1)

    await act(async () =>
      root.render(<RichText html={html} editable={false} className="second" compact />)
    )
    expect(renderMathHtml).toHaveBeenCalledTimes(1)

    await act(async () =>
      root.render(<RichText html={`${html}<p>新增内容</p>`} editable={false} className="second" />)
    )
    expect(renderMathHtml).toHaveBeenCalledTimes(2)
  })

  it('moves and zooms the canvas without regenerating unchanged formula HTML', async () => {
    useApp.setState({
      pageId: 'performance-page',
      doc: canvasDoc(),
      viewport: { x: 0, y: 0, zoom: 1 },
      tool: 'select',
      selection: [],
      strokeSelection: [],
      editingId: null,
    })
    useCanvasAgent.setState({ running: false, finalizing: false, preview: null, liveDoc: null })

    await act(async () => root.render(<CanvasStage />))
    expect(renderMathHtml).toHaveBeenCalledTimes(1)

    act(() => useApp.getState().setViewport({ x: 180, y: -90, zoom: 1.75 }))

    expect(container.querySelector<HTMLElement>('[data-world="1"]')?.style.transform).toBe(
      'translate3d(180px, -90px, 0) scale(1.75)'
    )
    expect(renderMathHtml).toHaveBeenCalledTimes(1)

    act(() => useApp.getState().setSelection(['long-formula-text']))
    expect(renderMathHtml).toHaveBeenCalledTimes(1)
  })
})
