// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCanvasAgent } from '../../lib/agent/store'
import { useApp } from '../../lib/store'
import { DEFAULT_SETTINGS, type CanvasElement } from '../../lib/types'
import { AIPanel } from './AIPanel'

const mocks = vi.hoisted(() => ({
  generateMindMap: vi.fn(),
  aiChat: vi.fn(),
}))

vi.mock('../../lib/aiCanvas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/aiCanvas')>()
  return { ...actual, generateMindMap: mocks.generateMindMap }
})

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return { ...actual, aiChat: mocks.aiChat }
})

const profile = {
  id: 'test-profile',
  name: 'Test AI',
  baseUrl: 'https://example.test/v1',
  apiKey: 'test-key',
  model: 'test-model',
  apiStyle: 'openai' as const,
  temperature: 0.2,
  maxTokens: 4096,
  timeoutSecs: 30,
  supportsVision: true,
}

const generatedNode: CanvasElement = {
  id: 'generated-node',
  type: 'shape',
  x: 120,
  y: 300,
  w: 190,
  h: 58,
  rotation: 0,
  z: 1,
  shape: 'rect',
  stroke: '#4f46e5',
  fill: '#eef2ff',
  strokeWidth: 2,
  dashed: false,
  label: '生成节点',
}

function buttonWithText(container: HTMLElement, text: string) {
  const button = Array.from(container.querySelectorAll('button')).find(
    (item) => item.textContent?.trim() === text
  )
  if (!button) throw new Error(`Button not found: ${text}`)
  return button
}

async function flushAsyncWork() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('AIPanel canvas generation', () => {
  let container: HTMLDivElement
  let root: Root
  let appState: ReturnType<typeof useApp.getState>
  let agentState: ReturnType<typeof useCanvasAgent.getState>

  beforeEach(async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    appState = useApp.getState()
    agentState = useCanvasAgent.getState()
    mocks.generateMindMap.mockReset()
    mocks.aiChat.mockReset()

    useApp.setState({
      aiOpen: true,
      pageId: 'page-1',
      sectionId: 'section-1',
      doc: { version: 1, background: 'grid', elements: [], strokes: [] },
      selection: [],
      strokeSelection: [],
      settings: {
        ...DEFAULT_SETTINGS,
        aiProfiles: [profile],
        activeProfileId: profile.id,
      },
    })
    useCanvasAgent.setState({
      hydrated: true,
      running: false,
      finalizing: false,
      progress: [],
      error: null,
      activeThreadId: null,
      threads: [],
    })

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root.render(<AIPanel />))
    await act(async () => buttonWithText(container, '画布').click())
  })

  afterEach(() => {
    act(() => root.unmount())
    useApp.setState(appState, true)
    useCanvasAgent.setState(agentState, true)
    container.remove()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('runs mind-map generation and records the result in the unified conversation', async () => {
    mocks.generateMindMap.mockImplementation(async (_topic, report) => {
      report?.('请求模型生成思维导图层级')
      useApp.getState().addElement(generatedNode)
      return '已生成思维导图，共 4 个节点'
    })
    const commands: unknown[] = []
    const listener = (event: Event) => commands.push((event as CustomEvent).detail)
    window.addEventListener('jinyan-notes:cmd', listener)

    await act(async () => {
      buttonWithText(container, '生成思维导图').click()
      await flushAsyncWork()
    })

    expect(mocks.generateMindMap).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('执行画布操作：思维导图')
    expect(container.textContent).toContain('请求模型生成思维导图层级')
    expect(container.textContent).toContain('定位并选中生成结果')
    expect(container.textContent).toContain('已生成思维导图，共 4 个节点')
    expect(container.textContent).toContain('已完成')
    expect(container.textContent).not.toContain('正在思考')
    const locateButton = buttonWithText(container, '定位到生成内容')
    await act(async () => locateButton.click())
    expect(commands).toContainEqual({ type: 'reveal-elements', ids: ['generated-node'] })
    window.removeEventListener('jinyan-notes:cmd', listener)
  })

  it('shows the current generation stage before the model finishes', async () => {
    let finish!: (message: string) => void
    mocks.generateMindMap.mockImplementation((_topic, report) => {
      report?.('请求模型生成思维导图层级')
      return new Promise<string>((resolve) => {
        finish = resolve
      })
    })

    await act(async () => {
      buttonWithText(container, '生成思维导图').click()
      await flushAsyncWork()
    })

    expect(container.querySelector('[data-ai-operation="running"]')).not.toBeNull()
    expect(container.textContent).toContain('请求模型生成思维导图层级')
    expect(container.textContent).toContain('执行中')

    await act(async () => {
      finish('生成完成')
      await flushAsyncWork()
    })
    expect(container.querySelector('[data-ai-operation="done"]')).not.toBeNull()
  })

  it('keeps a rejected generation error visible in the unified conversation', async () => {
    mocks.generateMindMap.mockRejectedValue(new Error('模型没有返回可解析的思维导图 JSON'))

    await act(async () => {
      buttonWithText(container, '生成思维导图').click()
      await flushAsyncWork()
    })

    expect(mocks.generateMindMap).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('执行画布操作：思维导图')
    expect(container.textContent).toContain('模型没有返回可解析的思维导图 JSON')
    expect(container.textContent).not.toContain('正在思考')
  })

  it('routes a conversational mind-map request to the dedicated workflow', async () => {
    mocks.generateMindMap.mockResolvedValue('已保存到子页面「审批说明 · 思维导图」')
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, '把这页内容整理成思维导图')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[title="交给 AI 修改画布"]')!
        .click()
      await flushAsyncWork()
    })

    expect(mocks.generateMindMap).toHaveBeenCalledOnce()
    expect(mocks.aiChat).not.toHaveBeenCalled()
    expect(container.textContent).toContain('把这页内容整理成思维导图')
    expect(container.textContent).toContain('已保存到子页面')
  })

  it('shows preparation, reasoning, and output stages for a normal AI request', async () => {
    mocks.aiChat.mockImplementation(async (_profile, _messages, _requestId, onEvent) => {
      onEvent({ type: 'reasoning', text: '正在分析问题' })
      onEvent({ type: 'delta', text: '这是回答。' })
      onEvent({ type: 'done', finish: 'stop' })
    })
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, '请解释当前笔记')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const send = container.querySelector<HTMLButtonElement>('button[title="发送消息"]')!

    await act(async () => {
      send.click()
      await flushAsyncWork()
    })

    expect(mocks.aiChat).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('回答问题')
    expect(container.textContent).toContain('读取笔记上下文')
    expect(container.textContent).toContain('模型正在分析')
    expect(container.textContent).toContain('接收并整理模型输出')
    expect(container.textContent).toContain('已完成')
    expect(container.textContent).not.toContain('正在思考')
  })
})
