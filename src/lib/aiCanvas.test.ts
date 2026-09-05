// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasDoc, CanvasElement } from './types'

vi.mock('./aiActions', () => ({
  completeJson: vi.fn(),
  complete: vi.fn(),
}))

vi.mock('./bus', () => ({
  emit: vi.fn(),
}))

import { completeJson } from './aiActions'
import { generateConceptDiagram, generateFlowchart, generateMindMap } from './aiCanvas'
import { emit } from './bus'
import { clone, useApp } from './store'

const mockedCompleteJson = vi.mocked(completeJson)
const mockedEmit = vi.mocked(emit)

const sourceElement: CanvasElement = {
  id: 'source',
  type: 'text',
  x: 100,
  y: 100,
  w: 360,
  h: 120,
  rotation: 0,
  z: 1,
  html: '<p>用户提交申请，审核通过后归档，否则退回修改。</p>',
  bg: 'transparent',
  border: 'transparent',
  fontFamily: 'sans',
  fontScale: 1,
  padding: 8,
}

function sourceDoc(): CanvasDoc {
  return { version: 1, background: 'grid', elements: [sourceElement], strokes: [] }
}

function expectGeneratedDiagramFocused(expectedNodeCount: number) {
  const state = useApp.getState()
  const selection = state.selection
  expect(selection).toHaveLength(expectedNodeCount)
  expect(selection.every((id) => state.doc.elements.some((element) => element.id === id))).toBe(true)
  expect(
    mockedEmit.mock.calls.some(
      ([command]) =>
        command.type === 'reveal-elements' &&
        selection.every((id) => command.ids.includes(id))
    )
  ).toBe(true)
}

describe('AI canvas diagrams', () => {
  let originalCreateChildPageWithDoc: ReturnType<typeof useApp.getState>['createChildPageWithDoc']

  beforeEach(() => {
    vi.useFakeTimers()
    mockedCompleteJson.mockReset()
    mockedEmit.mockReset()
    originalCreateChildPageWithDoc = useApp.getState().createChildPageWithDoc
    useApp.setState({
      pageId: 'page-1',
      sectionId: 'section-1',
      title: '审批说明',
      pages: [
        {
          id: 'page-1',
          sectionId: 'section-1',
          notebookId: 'notebook-1',
          parentId: null,
          title: '审批说明',
          preview: '',
          sortOrder: 1000,
          favorite: false,
          createdAt: 1,
          updatedAt: 1,
          deletedAt: null,
          tags: [],
        },
      ],
      doc: clone(sourceDoc()),
      past: [],
      future: [],
      selection: [],
      rev: 1,
    })
  })

  afterEach(() => {
    useApp.setState({ createChildPageWithDoc: originalCreateChildPageWithDoc })
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('creates a connected flowchart in one undoable update', async () => {
    mockedCompleteJson.mockResolvedValueOnce({
      title: '审批流程',
      nodes: [
        { id: 'start', label: '提交申请', type: 'start' },
        { id: 'review', label: '审核通过？', type: 'decision' },
        { id: 'end', label: '归档', type: 'end' },
      ],
      edges: [
        { from: 'start', to: 'review' },
        { from: 'review', to: 'end', label: '是' },
      ],
    })

    await generateFlowchart()

    const created = useApp.getState().doc.elements.slice(1)
    expect(
      created.filter((element) => element.type === 'shape' && element.shape === 'arrow')
    ).toHaveLength(2)
    expect(created.filter((element) => element.type === 'shape' && element.label)).toHaveLength(3)
    expect(useApp.getState().past).toEqual([sourceDoc()])
    expectGeneratedDiagramFocused(3)
  })

  it('selects and reveals a generated mind map', async () => {
    const progress = vi.fn()
    const sourceBefore = clone(useApp.getState().doc)
    let sourceAtCreate: CanvasDoc | null = null
    const createChildPageWithDoc = vi.fn(async (_title: string, _parentId: string, doc: CanvasDoc) => {
      sourceAtCreate = clone(useApp.getState().doc)
      useApp.setState({ pageId: 'mindmap-child', doc: clone(doc), selection: [], past: [], future: [] })
      return 'mindmap-child'
    })
    useApp.setState({ createChildPageWithDoc })
    mockedCompleteJson.mockResolvedValueOnce({
      root: '申请流程',
      nodes: [
        { id: 'submit', label: '提交申请', parent: null },
        { id: 'review', label: '审核', parent: 'submit' },
      ],
    })

    await generateMindMap(undefined, progress)

    expect(createChildPageWithDoc).toHaveBeenCalledOnce()
    expect(createChildPageWithDoc.mock.calls[0][0]).toBe('审批说明 · 思维导图')
    expect(createChildPageWithDoc.mock.calls[0][1]).toBe('page-1')
    expect(sourceAtCreate).toEqual(sourceBefore)
    expect(useApp.getState().doc.elements).not.toContainEqual(sourceElement)
    expectGeneratedDiagramFocused(3)
    expect(progress.mock.calls.map(([message]) => message)).toEqual(
      expect.arrayContaining([
        '读取当前页面并提取主题材料',
        '请求模型生成思维导图层级',
        '校验层级并计算左右分支布局',
        '保存原笔记并创建思维导图子页面',
        '打开子页面并定位思维导图',
      ])
    )
  })

  it('does not create a child page when the mind-map service request fails', async () => {
    const createChildPageWithDoc = vi.fn()
    useApp.setState({ createChildPageWithDoc })
    mockedCompleteJson.mockRejectedValueOnce(new Error('AI 服务连接失败'))

    await expect(generateMindMap()).rejects.toThrow('AI 服务连接失败')

    expect(createChildPageWithDoc).not.toHaveBeenCalled()
    expect(useApp.getState().doc).toEqual(sourceDoc())
    expect(useApp.getState().pageId).toBe('page-1')
  })

  it('creates a relationship diagram with a central concept', async () => {
    mockedCompleteJson.mockResolvedValueOnce({
      title: '系统关系',
      nodes: [
        { id: 'core', label: '笔记系统', kind: 'core' },
        { id: 'ai', label: 'AI 助手', kind: 'system' },
        { id: 'user', label: '用户', kind: 'person' },
      ],
      links: [
        { from: 'core', to: 'ai' },
        { from: 'user', to: 'core' },
      ],
    })

    await generateConceptDiagram()

    const labeledShapes = useApp
      .getState()
      .doc.elements.filter((element) => element.type === 'shape' && element.label)
    expect(labeledShapes.map((element) => element.type === 'shape' && element.label)).toEqual([
      '笔记系统',
      'AI 助手',
      '用户',
    ])
    expectGeneratedDiagramFocused(3)
  })

  it('falls back to a local outline when structured model output is invalid', async () => {
    mockedCompleteJson.mockRejectedValueOnce(new Error('模型连续两次未返回可解析的 JSON'))

    const message = await generateFlowchart()

    expect(message).toContain('已用本地提纲生成')
    expect(useApp.getState().doc.elements.length).toBeGreaterThan(1)
    expectGeneratedDiagramFocused(useApp.getState().selection.length)
  })

  it('propagates service failures without changing the canvas', async () => {
    mockedCompleteJson.mockRejectedValueOnce(new Error('AI 服务连接失败'))

    await expect(generateFlowchart()).rejects.toThrow('AI 服务连接失败')

    expect(useApp.getState().doc).toEqual(sourceDoc())
    expect(useApp.getState().selection).toEqual([])
    expect(mockedEmit).not.toHaveBeenCalled()
  })
})
