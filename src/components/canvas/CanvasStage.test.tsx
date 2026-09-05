// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useCanvasAgent } from '../../lib/agent/store'
import { useApp } from '../../lib/store'
import type { CanvasDoc, CanvasElement } from '../../lib/types'
import { CanvasStage } from './CanvasStage'

function shape(x: number, label: string): CanvasElement {
  return {
    id: 'target',
    type: 'shape',
    x,
    y: 40,
    w: 120,
    h: 80,
    rotation: 0,
    z: 1,
    shape: 'rect',
    stroke: '#111827',
    fill: 'transparent',
    strokeWidth: 2,
    dashed: false,
    label,
  }
}

function canvasDoc(x: number, label: string): CanvasDoc {
  return {
    version: 1,
    background: 'grid',
    elements: [shape(x, label)],
    strokes: [],
  }
}

function nextAnimationFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

function zoomStep(
  viewport: { x: number; y: number; zoom: number },
  factor: number,
  x: number,
  y: number
) {
  const zoom = Math.min(6, Math.max(0.15, viewport.zoom * factor))
  const scale = zoom / viewport.zoom
  return {
    zoom,
    x: x - (x - viewport.x) * scale,
    y: y - (y - viewport.y) * scale,
  }
}

describe('CanvasStage Agent rendering', () => {
  let container: HTMLDivElement
  let root: Root
  let appState: ReturnType<typeof useApp.getState>
  let agentState: ReturnType<typeof useCanvasAgent.getState>

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    appState = useApp.getState()
    agentState = useCanvasAgent.getState()
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

  it('renders the live document and locks content writes while retaining viewport pan', async () => {
    useApp.setState({
      pageId: 'page-1',
      doc: canvasDoc(10, '持久内容'),
      viewport: { x: 0, y: 0, zoom: 1 },
      tool: 'select',
      selection: ['target'],
      strokeSelection: [],
      editingId: null,
    })
    useCanvasAgent.setState({
      running: true,
      preview: null,
      liveDoc: canvasDoc(140, '实时内容'),
      activeElementIds: ['target'],
      completedElementIds: [],
      activeStrokeIds: [],
      completedStrokeIds: [],
    } as never)

    await act(async () => root.render(<CanvasStage />))

    const element = container.querySelector<HTMLElement>('[data-element-id="target"]')!
    expect(element.style.left).toBe('140px')
    expect(container.textContent).toContain('实时内容')
    expect(container.textContent).toContain('Agent 正在修改')
    expect(container.querySelector('[data-agent-element-state="active"]')).not.toBeNull()

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    })
    expect(useApp.getState().doc.elements).toHaveLength(1)

    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-canvas-stage]')!
        .dispatchEvent(
          new WheelEvent('wheel', { deltaX: 24, deltaY: 12, bubbles: true, cancelable: true })
        )
      await nextAnimationFrame()
    })
    expect(useApp.getState().viewport).toMatchObject({ x: -24, y: -12, zoom: 1 })
  })

  it('coalesces wheel panning into one viewport write per animation frame', async () => {
    useApp.setState({
      pageId: 'page-pan',
      doc: canvasDoc(10, '平移内容'),
      viewport: { x: 0, y: 0, zoom: 1 },
      tool: 'select',
      selection: [],
      strokeSelection: [],
      editingId: null,
    })
    useCanvasAgent.setState({ running: false, finalizing: false, preview: null, liveDoc: null })

    await act(async () => root.render(<CanvasStage />))

    let viewportWrites = 0
    const unsubscribe = useApp.subscribe((state, previous) => {
      if (state.viewport !== previous.viewport) viewportWrites += 1
    })
    const stage = container.querySelector<HTMLElement>('[data-canvas-stage]')!

    act(() => {
      stage.dispatchEvent(
        new WheelEvent('wheel', { deltaX: 5, deltaY: 7, bubbles: true, cancelable: true })
      )
      stage.dispatchEvent(
        new WheelEvent('wheel', { deltaX: -2, deltaY: 4, bubbles: true, cancelable: true })
      )
      stage.dispatchEvent(
        new WheelEvent('wheel', { deltaX: 9, deltaY: -3, bubbles: true, cancelable: true })
      )
    })

    expect(useApp.getState().viewport).toEqual({ x: 0, y: 0, zoom: 1 })
    expect(viewportWrites).toBe(0)

    await act(nextAnimationFrame)

    expect(useApp.getState().viewport).toEqual({ x: -12, y: -8, zoom: 1 })
    expect(viewportWrites).toBe(1)
    unsubscribe()
  })

  it('preserves sequential zoom anchors and clamp behavior while coalescing', async () => {
    const initial = { x: 20, y: 30, zoom: 5.9 }
    useApp.setState({
      pageId: 'page-zoom',
      doc: canvasDoc(10, '缩放内容'),
      viewport: initial,
      tool: 'select',
      selection: [],
      strokeSelection: [],
      editingId: null,
    })
    useCanvasAgent.setState({ running: false, finalizing: false, preview: null, liveDoc: null })

    await act(async () => root.render(<CanvasStage />))

    const stage = container.querySelector<HTMLElement>('[data-canvas-stage]')!
    const firstAnchor = { x: 100, y: 120 }
    const secondAnchor = { x: 320, y: 240 }
    const afterFirst = zoomStep(initial, Math.exp(1), firstAnchor.x, firstAnchor.y)
    const expected = zoomStep(afterFirst, Math.exp(-0.1), secondAnchor.x, secondAnchor.y)

    act(() => {
      stage.dispatchEvent(
        new WheelEvent('wheel', {
          ctrlKey: true,
          clientX: firstAnchor.x,
          clientY: firstAnchor.y,
          deltaY: -100,
          bubbles: true,
          cancelable: true,
        })
      )
      stage.dispatchEvent(
        new WheelEvent('wheel', {
          ctrlKey: true,
          clientX: secondAnchor.x,
          clientY: secondAnchor.y,
          deltaY: 10,
          bubbles: true,
          cancelable: true,
        })
      )
    })

    await act(nextAnimationFrame)

    const actual = useApp.getState().viewport
    expect(actual.zoom).toBeCloseTo(expected.zoom, 10)
    expect(actual.x).toBeCloseTo(expected.x, 10)
    expect(actual.y).toBeCloseTo(expected.y, 10)
  })

  it('uses a same-page final preview when there is no live document', async () => {
    const before = canvasDoc(10, '原内容')
    const after = canvasDoc(260, '最终预览')
    useApp.setState({ pageId: 'page-2', doc: before, viewport: { x: 0, y: 0, zoom: 1 } })
    useCanvasAgent.setState({
      running: false,
      liveDoc: null,
      activeElementIds: [],
      completedElementIds: [],
      activeStrokeIds: [],
      completedStrokeIds: [],
      preview: {
        pageId: 'page-2',
        baseRev: 3,
        prompt: '移动内容',
        scope: 'page',
        before,
        after,
        summary: '已移动内容',
        steps: [],
        changedElementIds: ['target'],
        createdElementIds: [],
        deletedElementIds: [],
        changedStrokeIds: [],
        backgroundChanged: false,
      },
    } as never)

    await act(async () => root.render(<CanvasStage />))

    expect(container.querySelector<HTMLElement>('[data-element-id="target"]')?.style.left).toBe(
      '260px'
    )
    expect(container.textContent).toContain('最终预览')
    expect(container.querySelector('[data-agent-element-state="changed"]')).not.toBeNull()
  })

  it('keeps content locked while a stopped Agent run is finishing its save', async () => {
    useApp.setState({
      pageId: 'page-3',
      doc: canvasDoc(20, '正在保存'),
      viewport: { x: 0, y: 0, zoom: 1 },
      tool: 'select',
      selection: ['target'],
      strokeSelection: [],
      editingId: null,
    })
    useCanvasAgent.setState({
      running: false,
      finalizing: true,
      preview: null,
      liveDoc: null,
    })

    await act(async () => root.render(<CanvasStage />))
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    })

    expect(useApp.getState().doc.elements).toHaveLength(1)
    expect(container.querySelector('[data-element-id="target"]')?.parentElement?.className).toContain(
      'pointer-events-none'
    )
  })

  it('selects and fits a generated element group into the viewport', async () => {
    const first = { ...shape(100, '节点一'), id: 'generated-a', y: 100 }
    const second = { ...shape(700, '节点二'), id: 'generated-b', y: 400 }
    useApp.setState({
      pageId: 'page-generated',
      doc: { version: 1, background: 'grid', elements: [first, second], strokes: [] },
      viewport: { x: 0, y: 0, zoom: 1 },
      tool: 'hand',
      selection: [],
      strokeSelection: [],
      editingId: null,
    })
    useCanvasAgent.setState({ running: false, finalizing: false, preview: null, liveDoc: null })

    await act(async () => root.render(<CanvasStage />))
    const stage = container.querySelector<HTMLElement>('[data-canvas-stage]')!
    Object.defineProperty(stage, 'clientWidth', { configurable: true, value: 1000 })
    Object.defineProperty(stage, 'clientHeight', { configurable: true, value: 700 })

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('jinyan-notes:cmd', {
          detail: { type: 'reveal-elements', ids: ['generated-a', 'generated-b'] },
        })
      )
    })

    const state = useApp.getState()
    expect(state.tool).toBe('select')
    expect(state.selection).toEqual(['generated-a', 'generated-b'])
    expect(state.viewport.zoom).toBeGreaterThan(1)
    expect(state.viewport.zoom).toBeLessThanOrEqual(1.4)
    expect((100 + 720 / 2) * state.viewport.zoom + state.viewport.x).toBeCloseTo(500)
    expect((100 + 380 / 2) * state.viewport.zoom + state.viewport.y).toBeCloseTo(350)
  })
})
