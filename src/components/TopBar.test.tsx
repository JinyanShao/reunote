// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/react'
import { useCanvasAgent } from '../lib/agent/store'
import { setActiveEditor } from '../lib/activeEditor'
import { undoDocument } from '../lib/documentCommands'
import { useApp } from '../lib/store'
import type { CanvasDoc } from '../lib/types'
import { TopBar } from './TopBar'

const emptyDoc: CanvasDoc = { version: 1, background: 'grid', elements: [], strokes: [] }

describe('TopBar history controls', () => {
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
    setActiveEditor(null)
    useApp.setState(appState, true)
    useCanvasAgent.setState(agentState, true)
    container.remove()
    document.body.innerHTML = ''
  })

  it('exposes undo and redo, then locks them while Agent is writing', async () => {
    const undo = vi.fn()
    const redo = vi.fn()
    useApp.setState({
      pageId: 'page-1',
      title: '测试页面',
      pages: [],
      doc: emptyDoc,
      past: [emptyDoc],
      future: [emptyDoc],
      viewport: { x: 0, y: 0, zoom: 1 },
      undo,
      redo,
    })
    useCanvasAgent.setState({ running: false, finalizing: false })

    await act(async () => root.render(<TopBar onExport={() => undefined} />))
    const undoButton = container.querySelector<HTMLButtonElement>('button[aria-label="撤回"]')!
    const redoButton = container.querySelector<HTMLButtonElement>('button[aria-label="恢复"]')!

    expect(undoButton.disabled).toBe(false)
    expect(redoButton.disabled).toBe(false)
    await act(async () => {
      undoButton.click()
      redoButton.click()
    })
    expect(undo).toHaveBeenCalledOnce()
    expect(redo).toHaveBeenCalledOnce()

    await act(async () => useCanvasAgent.setState({ running: true }))
    expect(undoButton.disabled).toBe(true)
    expect(redoButton.disabled).toBe(true)
  })

  it('disables unavailable history actions', async () => {
    useApp.setState({
      pageId: 'page-2',
      title: '测试页面',
      pages: [],
      doc: emptyDoc,
      past: [],
      future: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    })
    useCanvasAgent.setState({ running: false, finalizing: false })

    await act(async () => root.render(<TopBar onExport={() => undefined} />))

    expect(container.querySelector<HTMLButtonElement>('button[aria-label="撤回"]')?.disabled).toBe(
      true
    )
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="恢复"]')?.disabled).toBe(
      true
    )
  })

  it('keeps rich-text focus and routes top-bar and native undo through its history', async () => {
    const editorUndo = vi.fn(() => true)
    const editorRedo = vi.fn(() => true)
    const eventListeners = new Map<string, () => void>()
    const editor = {
      isDestroyed: false,
      isFocused: true,
      can: () => ({ undo: () => true, redo: () => false }),
      commands: { undo: editorUndo, redo: editorRedo },
      on: (event: string, listener: () => void) => eventListeners.set(event, listener),
      off: (event: string) => eventListeners.delete(event),
    } as unknown as Editor
    const canvasUndo = vi.fn()
    useApp.setState({
      pageId: 'page-rich-text',
      title: '富文本页面',
      pages: [],
      doc: emptyDoc,
      past: [],
      future: [emptyDoc],
      viewport: { x: 0, y: 0, zoom: 1 },
      undo: canvasUndo,
    })
    useCanvasAgent.setState({ running: false, finalizing: false })
    setActiveEditor(editor)

    await act(async () => root.render(<TopBar onExport={() => undefined} />))
    const undoButton = container.querySelector<HTMLButtonElement>('button[aria-label="撤回"]')!
    const redoButton = container.querySelector<HTMLButtonElement>('button[aria-label="恢复"]')!
    const pointerDown = new MouseEvent('pointerdown', { bubbles: true, cancelable: true })
    const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true })

    expect(undoButton.disabled).toBe(false)
    expect(redoButton.disabled).toBe(true)
    undoButton.dispatchEvent(pointerDown)
    expect(pointerDown.defaultPrevented).toBe(true)
    undoButton.dispatchEvent(mouseDown)
    expect(mouseDown.defaultPrevented).toBe(true)
    await act(async () => undoButton.click())
    expect(editorUndo).toHaveBeenCalledOnce()
    expect(canvasUndo).not.toHaveBeenCalled()

    expect(undoDocument()).toBe(true)
    expect(editorUndo).toHaveBeenCalledTimes(2)

    await act(async () => useCanvasAgent.setState({ running: true }))
    expect(undoButton.disabled).toBe(true)
    expect(undoDocument()).toBe(false)
    expect(editorUndo).toHaveBeenCalledTimes(2)
  })
})
