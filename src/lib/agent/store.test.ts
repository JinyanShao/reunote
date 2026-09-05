import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import type { AiChatAttachment } from '../aiAttachments'
import { clone, useApp } from '../store'
import type { CanvasAgentPreview } from './types'
import { useCanvasAgent, type AgentThread } from './store'
import { runCanvasAgent } from './session'

vi.mock('../api', () => ({
  savePage: vi.fn().mockResolvedValue(Date.now()),
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
  duplicateSectionForAgent: vi.fn(),
  adoptAgentDraft: vi.fn(),
}))

vi.mock('./session', () => ({
  runCanvasAgent: vi.fn(),
}))

const beforeDoc = {
  version: 1 as const,
  background: 'grid' as const,
  elements: [],
  strokes: [],
}

const afterDoc = {
  ...beforeDoc,
  background: 'dots' as const,
}

function preview(baseRev = 4): CanvasAgentPreview {
  return {
    pageId: 'page-1',
    baseRev,
    prompt: '把背景改成点阵',
    scope: 'page',
    before: clone(beforeDoc),
    after: clone(afterDoc),
    summary: '已更换页面背景',
    steps: [],
    changedElementIds: [],
    createdElementIds: [],
    deletedElementIds: [],
    changedStrokeIds: [],
    backgroundChanged: true,
  }
}

function thread(
  id = 'thread-1',
  status: AgentThread['workspace']['status'] = 'ready',
  updatedAt = 2
): AgentThread {
  return {
    id,
    workspace: {
      id: `workspace-${id}`,
      sourceSectionId: 'section-1',
      sourceSectionName: '原分区',
      draftSectionId: `draft-${id}`,
      draftSectionName: '原分区 · AI 工作稿',
      pageMap: [{ sourcePageId: 'page-1', draftPageId: 'page-1' }],
      sourceSnapshot: `snapshot-${id}`,
      status,
      createdAt: 1,
      updatedAt,
    },
    messages: [
      { id: `message-${id}`, role: 'user', text: '继续整理', createdAt: 2, status: 'done' },
    ],
    createdAt: 1,
    updatedAt,
  }
}

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('canvas agent store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    vi.mocked(api.savePage).mockResolvedValue(Date.now())
    vi.mocked(api.getSetting).mockResolvedValue(null)
    vi.mocked(api.setSetting).mockResolvedValue(undefined)
    vi.mocked(api.duplicateSectionForAgent).mockReset()
    vi.mocked(api.adoptAgentDraft).mockReset()
    vi.mocked(runCanvasAgent).mockReset()
    useApp.setState({
      notebookId: 'notebook-1',
      sectionId: 'section-1',
      pageId: 'page-1',
      title: '页面 1',
      doc: clone(beforeDoc),
      rev: 4,
      past: [],
      future: [],
      selection: [],
      strokeSelection: [],
      dirty: false,
    })
    useCanvasAgent.setState({
      running: false,
      finalizing: false,
      prompt: '',
      progress: [],
      preview: preview(),
      error: null,
      runToken: 0,
      hydrated: true,
      threads: [],
      activeThreadId: null,
      workflow: null,
      stageStatus: {},
      liveDoc: null,
      livePageId: null,
      activeElementIds: [],
      activeStrokeIds: [],
      completedElementIds: [],
      completedStrokeIds: [],
      committedStepCount: 0,
    })
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('applies a preview as one undoable history entry', () => {
    useCanvasAgent.getState().applyPreview()

    expect(useApp.getState().doc).toEqual(afterDoc)
    expect(useApp.getState().past).toEqual([beforeDoc])
    expect(useApp.getState().rev).toBe(5)
    expect(useCanvasAgent.getState().preview).toBeNull()

    useApp.getState().undo()

    expect(useApp.getState().doc).toEqual(beforeDoc)
    expect(useApp.getState().past).toHaveLength(0)
    expect(useApp.getState().future).toEqual([afterDoc])
  })

  it('rejects a preview after the page revision changes', () => {
    useApp.setState({ rev: 5 })

    expect(() => useCanvasAgent.getState().applyPreview()).toThrow(
      '画布已发生变化，原预览已失效，请重新生成'
    )
    expect(useApp.getState().doc).toEqual(beforeDoc)
    expect(useApp.getState().past).toHaveLength(0)
    expect(useCanvasAgent.getState().preview).toBeNull()
  })

  it('keeps compact Agent conversation history when runtime state resets', () => {
    useCanvasAgent.setState({
      activeThreadId: 'thread-1',
      threads: [
        {
          id: 'thread-1',
          workspace: {
            id: 'workspace-1',
            sourceSectionId: 'section-1',
            sourceSectionName: '原分区',
            draftSectionId: 'section-draft',
            draftSectionName: '原分区 · AI 工作稿',
            pageMap: [{ sourcePageId: 'page-1', draftPageId: 'page-draft' }],
            sourceSnapshot: 'snapshot',
            status: 'ready',
            createdAt: 1,
            updatedAt: 2,
          },
          messages: [
            { id: 'message-1', role: 'user', text: '继续整理', createdAt: 2, status: 'done' },
          ],
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    })

    useCanvasAgent.getState().reset()

    expect(useCanvasAgent.getState().activeThreadId).toBe('thread-1')
    expect(useCanvasAgent.getState().threads[0].messages[0].text).toBe('继续整理')
  })

  it('does not clone a section when saving the current page fails', async () => {
    vi.mocked(api.savePage).mockRejectedValueOnce(new Error('disk full'))
    useApp.setState({ dirty: true })

    await expect(useCanvasAgent.getState().run('整理当前页面', 'page')).rejects.toThrow(
      '当前页面保存失败，未创建 AI 工作稿'
    )

    expect(api.duplicateSectionForAgent).not.toHaveBeenCalled()
    expect(useApp.getState().dirty).toBe(true)
  })

  it('creates a new workspace instead of mutating a kept draft', async () => {
    useCanvasAgent.setState({ activeThreadId: 'thread-1', threads: [thread('thread-1', 'kept')] })
    vi.mocked(api.duplicateSectionForAgent).mockRejectedValueOnce(new Error('new workspace'))

    await expect(useCanvasAgent.getState().run('继续整理', 'page')).rejects.toThrow('new workspace')

    expect(api.duplicateSectionForAgent).toHaveBeenCalledWith('section-1', 'page-1')
    expect(useCanvasAgent.getState().threads[0].workspace.status).toBe('kept')
  })

  it('records an Agent round checkpoint without adding to regular undo history', async () => {
    const agentThread = thread('thread-1', 'ready')
    const regularPast = [{ ...beforeDoc, background: 'blank' as const }]
    useApp.setState({
      sectionId: agentThread.workspace.draftSectionId,
      doc: clone(beforeDoc),
      past: clone(regularPast),
    })
    useCanvasAgent.setState({ activeThreadId: agentThread.id, threads: [agentThread] })
    vi.mocked(runCanvasAgent).mockImplementationOnce(async (input, options) => {
      const step = {
        index: 1,
        tool: 'set_background' as const,
        reason: '调整背景',
        observation: '已改为点阵',
      }
      options?.onStepCommitted?.({
        workflowId: 'workflow-1',
        stage: {
          id: 'stage-1',
          index: 1,
          title: '调整背景',
          objective: '改为点阵背景',
          targetElementIds: [],
        },
        stepIndex: 1,
        tool: 'set_background',
        reason: step.reason,
        activeElementIds: [],
        activeStrokeIds: [],
        doc: clone(afterDoc),
        step,
        changedElementIds: [],
        createdElementIds: [],
        deletedElementIds: [],
        changedStrokeIds: [],
        backgroundChanged: true,
      })
      return { ...preview(input.baseRev), pageId: input.pageId, steps: [step] }
    })

    await useCanvasAgent.getState().run('把背景改成点阵', 'page')

    const assistant = useCanvasAgent
      .getState()
      .threads[0].messages.find((message) => message.role === 'assistant')
    expect(assistant?.undo).toMatchObject({
      pageId: 'page-1',
      before: beforeDoc,
      stepCount: 1,
    })
    expect(useApp.getState().doc).toEqual(afterDoc)
    expect(useApp.getState().past).toEqual(regularPast)
  })

  it('forwards attachments and persists only metadata plus the extracted context', async () => {
    const agentThread = thread('thread-attachment', 'ready')
    useApp.setState({ sectionId: agentThread.workspace.draftSectionId })
    useCanvasAgent.setState({ activeThreadId: agentThread.id, threads: [agentThread] })
    const attachment: AiChatAttachment = {
      id: 'image-1',
      name: 'diagram.png',
      mime: 'image/png',
      kind: 'image',
      size: 3,
      base64: 'YWJj',
    }
    vi.mocked(runCanvasAgent).mockImplementationOnce(async (input, options) => {
      options?.onAttachmentContext?.('图中包含三个流程节点。')
      return { ...preview(input.baseRev), pageId: input.pageId }
    })

    await useCanvasAgent.getState().run('整理流程图', 'page', [attachment])

    expect(runCanvasAgent).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: [attachment] }),
      expect.any(Object)
    )
    const userMessages = useCanvasAgent
      .getState()
      .threads[0].messages.filter((message) => message.role === 'user')
    const userMessage = userMessages[userMessages.length - 1]
    expect(userMessage).toMatchObject({
      attachmentContext: '图中包含三个流程节点。',
      attachments: [
        { name: 'diagram.png', mime: 'image/png', kind: 'image', size: 3 },
      ],
    })
    expect(JSON.stringify(userMessage)).not.toContain('YWJj')
  })

  it('shares recent chat context with a canvas Agent run', async () => {
    const agentThread = thread('thread-context', 'ready')
    useApp.setState({ sectionId: agentThread.workspace.draftSectionId })
    useCanvasAgent.setState({ activeThreadId: agentThread.id, threads: [agentThread] })
    vi.mocked(runCanvasAgent).mockImplementationOnce(async (input) => ({
      ...preview(input.baseRev),
      pageId: input.pageId,
    }))

    await useCanvasAgent.getState().run('按刚才的方案修改画布', 'page', [], [
      { role: 'user', content: '先讨论一下两栏方案', createdAt: 3 },
      { role: 'assistant', content: '建议左侧正文、右侧公式。', createdAt: 4 },
    ])

    const input = vi.mocked(runCanvasAgent).mock.calls[0][0]
    expect(input.history).toEqual([
      { role: 'user', content: '继续整理' },
      { role: 'user', content: '先讨论一下两栏方案' },
      { role: 'assistant', content: '建议左侧正文、右侧公式。' },
    ])
  })

  it('waits for a stopped live document to finish saving before adoption', async () => {
    let finishCommit!: (value: number) => void
    vi.mocked(api.savePage)
      .mockImplementationOnce(
        () => new Promise<number>((resolve) => (finishCommit = resolve))
      )
      .mockResolvedValue(Date.now())
    vi.mocked(api.adoptAgentDraft).mockRejectedValueOnce(new Error('adopt reached'))
    useCanvasAgent.setState({
      activeThreadId: 'thread-1',
      threads: [thread('thread-1', 'working')],
      running: true,
      liveDoc: clone(afterDoc),
      livePageId: 'page-1',
      committedStepCount: 1,
    })

    useCanvasAgent.getState().cancel()
    const adopting = useCanvasAgent.getState().adoptDraft()
    await flushPromises()

    expect(useCanvasAgent.getState().finalizing).toBe(true)
    expect(useCanvasAgent.getState().liveDoc).toEqual(afterDoc)
    expect(api.adoptAgentDraft).not.toHaveBeenCalled()
    useCanvasAgent.getState().clearHistory()
    expect(useCanvasAgent.getState().threads[0].messages).toHaveLength(1)
    expect(() => useCanvasAgent.getState().keepDraft()).toThrow('正在保存已完成的修改')
    finishCommit(Date.now())

    await expect(adopting).rejects.toThrow('adopt reached')
    expect(useCanvasAgent.getState().finalizing).toBe(false)
    expect(useCanvasAgent.getState().liveDoc).toBeNull()
    expect(api.adoptAgentDraft).toHaveBeenCalledWith(
      'section-1',
      'draft-thread-1',
      'snapshot-thread-1',
      'page-1'
    )
    expect(JSON.parse(vi.mocked(api.savePage).mock.calls[0][0].content)).toMatchObject(afterDoc)
  })

  it('keeps unreverted Agent checkpoints when clearing conversation history', () => {
    const agentThread = thread('thread-clear', 'ready')
    agentThread.messages.push({
      id: 'assistant-clear',
      role: 'assistant',
      text: '已完成排版',
      createdAt: 3,
      status: 'done',
      undo: {
        pageId: 'page-1',
        before: clone(beforeDoc),
        afterFingerprint: 'after',
        stepCount: 2,
        createdAt: 3,
      },
    })
    useCanvasAgent.setState({ activeThreadId: agentThread.id, threads: [agentThread] })

    useCanvasAgent.getState().clearHistory()

    expect(useCanvasAgent.getState().threads[0].messages).toEqual([
      expect.objectContaining({ id: 'assistant-clear', text: '已完成排版', undo: expect.any(Object) }),
    ])
  })

  it('adopts and reopens the draft page that the user was viewing', async () => {
    const originalMethods = {
      save: useApp.getState().save,
      refreshTree: useApp.getState().refreshTree,
      openPage: useApp.getState().openPage,
      selectSection: useApp.getState().selectSection,
    }
    const save = vi.fn(async () => true)
    const navigation: string[] = []
    const refreshTree = vi.fn(async () => {
      navigation.push('refreshTree')
    })
    const openPage = vi.fn(async (id: string) => {
      navigation.push(`openPage:${id}`)
      useApp.setState({ pageId: id, sectionId: 'section-1' })
    })
    const selectSection = vi.fn(async () => true)
    const agentThread = thread('thread-1', 'ready')
    agentThread.workspace.pageMap = [
      { sourcePageId: 'source-page-1', draftPageId: 'draft-page-1' },
      { sourcePageId: 'source-page-2', draftPageId: 'draft-page-2' },
    ]
    vi.mocked(api.adoptAgentDraft).mockResolvedValueOnce({
      sourceSection: {
        id: 'section-1',
        notebookId: 'notebook-1',
        name: '原分区',
        color: '#000000',
        sortOrder: 1,
        createdAt: 1,
        updatedAt: 2,
        deletedAt: null,
      },
      backupSectionId: agentThread.workspace.draftSectionId,
      currentPageId: 'draft-page-2',
      adoptedPageIds: ['draft-page-1', 'draft-page-2'],
    })
    useApp.setState({
      sectionId: agentThread.workspace.draftSectionId,
      pageId: 'draft-page-2',
      save,
      refreshTree,
      openPage,
      selectSection,
    })
    useCanvasAgent.setState({ activeThreadId: agentThread.id, threads: [agentThread] })

    try {
      const result = await useCanvasAgent.getState().adoptDraft()

      expect(api.adoptAgentDraft).toHaveBeenCalledWith(
        'section-1',
        agentThread.workspace.draftSectionId,
        agentThread.workspace.sourceSnapshot,
        'draft-page-2'
      )
      expect(result.currentPageId).toBe('draft-page-2')
      expect(refreshTree).toHaveBeenCalledTimes(1)
      expect(openPage).toHaveBeenCalledWith('draft-page-2')
      expect(selectSection).not.toHaveBeenCalled()
      expect(useApp.getState().pageId).toBe('draft-page-2')
      expect(navigation).toEqual(['openPage:draft-page-2', 'refreshTree'])
    } finally {
      useApp.setState(originalMethods)
    }
  })

  it('serializes persisted history so an older write cannot finish last', async () => {
    let finishFirst!: () => void
    vi.mocked(api.setSetting)
      .mockImplementationOnce(() => new Promise<void>((resolve) => (finishFirst = resolve)))
      .mockResolvedValue(undefined)
    useCanvasAgent.setState({ activeThreadId: 'thread-1', threads: [thread()] })

    useCanvasAgent.getState().keepDraft()
    useCanvasAgent.getState().clearHistory()
    await flushPromises()

    expect(api.setSetting).toHaveBeenCalledTimes(1)
    finishFirst()
    await flushPromises()

    expect(api.setSetting).toHaveBeenCalledTimes(2)
    const first = JSON.parse(vi.mocked(api.setSetting).mock.calls[0][1])
    const second = JSON.parse(vi.mocked(api.setSetting).mock.calls[1][1])
    expect(first.threads[0].workspace.status).toBe('kept')
    expect(second.threads[0].messages).toEqual([])
  })

  it('hydrates valid threads independently and stops interrupted messages', async () => {
    const interrupted = thread('valid', 'working')
    interrupted.messages.push({
      id: 'assistant-running',
      role: 'assistant',
      text: '',
      createdAt: 3,
      status: 'running',
    })
    vi.mocked(api.getSetting).mockResolvedValueOnce(
      JSON.stringify({
        version: 1,
        activeThreadId: 'valid',
        threads: [{ id: 'broken' }, interrupted],
      })
    )
    useCanvasAgent.setState({ hydrated: false, threads: [], activeThreadId: null })

    await useCanvasAgent.getState().hydrate()

    expect(useCanvasAgent.getState().threads).toHaveLength(1)
    expect(useCanvasAgent.getState().activeThreadId).toBe('valid')
    expect(useCanvasAgent.getState().threads[0].workspace.status).toBe('ready')
    const hydratedMessages = useCanvasAgent.getState().threads[0].messages
    expect(hydratedMessages[hydratedMessages.length - 1]).toMatchObject({
      status: 'stopped',
      text: expect.stringContaining('上次退出时中断'),
    })
  })

  it('compacts hydrated threads by recent activity rather than array position', async () => {
    const threads = Array.from({ length: 13 }, (_, index) =>
      thread(`thread-${index}`, 'ready', index === 0 ? 100 : index)
    )
    vi.mocked(api.getSetting).mockResolvedValueOnce(
      JSON.stringify({ version: 1, activeThreadId: 'thread-0', threads })
    )
    useCanvasAgent.setState({ hydrated: false, threads: [], activeThreadId: null })

    await useCanvasAgent.getState().hydrate()

    expect(useCanvasAgent.getState().threads).toHaveLength(12)
    expect(useCanvasAgent.getState().threads.some((item) => item.id === 'thread-0')).toBe(true)
    expect(useCanvasAgent.getState().threads.some((item) => item.id === 'thread-1')).toBe(false)
    expect(useCanvasAgent.getState().activeThreadId).toBe('thread-0')
  })

  it('clears a stale active thread when the selected section has no Agent history', () => {
    useCanvasAgent.setState({ activeThreadId: 'thread-1', threads: [thread()] })

    useCanvasAgent.getState().activateForSection('unrelated-section')

    expect(useCanvasAgent.getState().activeThreadId).toBeNull()
  })

  it('reverts the latest Agent round without changing the regular canvas undo stacks', async () => {
    const agentThread = thread()
    agentThread.messages.push({
      id: 'assistant-undo',
      role: 'assistant',
      text: '已更换页面背景',
      createdAt: 3,
      status: 'done',
      steps: [
        {
          index: 1,
          tool: 'set_background',
          reason: '调整背景',
          observation: '已改为点阵',
        },
      ],
      undo: {
        pageId: 'page-1',
        before: clone(beforeDoc),
        afterFingerprint: JSON.stringify({
          version: afterDoc.version,
          background: afterDoc.background,
          elements: afterDoc.elements,
          strokes: afterDoc.strokes,
        }),
        stepCount: 1,
        createdAt: 3,
      },
    })
    const regularPast = [{ ...beforeDoc, background: 'blank' as const }]
    const regularFuture = [{ ...beforeDoc, background: 'lines' as const }]
    useApp.setState({
      doc: clone(afterDoc),
      past: clone(regularPast),
      future: clone(regularFuture),
    })
    useCanvasAgent.setState({ activeThreadId: agentThread.id, threads: [agentThread] })

    const reverted = await useCanvasAgent.getState().undoAgentChange('assistant-undo')

    expect(reverted.revertedAt).toEqual(expect.any(Number))
    expect(useApp.getState().doc).toEqual(beforeDoc)
    expect(useApp.getState().past).toEqual(regularPast)
    expect(useApp.getState().future).toEqual(regularFuture)
    expect(useCanvasAgent.getState().finalizing).toBe(false)
    expect(
      useCanvasAgent.getState().threads[0].messages.find((message) => message.id === 'assistant-undo')
        ?.undo?.revertedAt
    ).toEqual(expect.any(Number))
    expect(JSON.parse(vi.mocked(api.savePage).mock.calls[0][0].content)).toMatchObject(beforeDoc)
  })

  it('does not revert Agent changes after the page was edited manually', async () => {
    const agentThread = thread()
    agentThread.messages.push({
      id: 'assistant-undo',
      role: 'assistant',
      text: '已更换页面背景',
      createdAt: 3,
      status: 'done',
      undo: {
        pageId: 'page-1',
        before: clone(beforeDoc),
        afterFingerprint: JSON.stringify({
          version: afterDoc.version,
          background: afterDoc.background,
          elements: afterDoc.elements,
          strokes: afterDoc.strokes,
        }),
        stepCount: 1,
        createdAt: 3,
      },
    })
    const manuallyEdited = { ...beforeDoc, background: 'blank' as const }
    useApp.setState({ doc: clone(manuallyEdited) })
    useCanvasAgent.setState({ activeThreadId: agentThread.id, threads: [agentThread] })

    await expect(useCanvasAgent.getState().undoAgentChange('assistant-undo')).rejects.toThrow(
      '又发生了变化'
    )

    expect(useApp.getState().doc).toEqual(manuallyEdited)
    expect(api.savePage).not.toHaveBeenCalled()
    expect(useCanvasAgent.getState().finalizing).toBe(false)
  })
})
