import { create } from 'zustand'
import * as api from '../api'
import type { AiChatAttachment } from '../aiAttachments'
import { clone, docToPlainText, useApp } from '../store'
import type { CanvasDoc } from '../types'
import { extractHashTags, extractWikiLinks, uid } from '../utils'
import { isCanvasAgentSkillId } from './layoutSkills'
import type {
  CanvasAgentPreview,
  CanvasAgentProgress,
  CanvasAgentHistoryMessage,
  CanvasAgentScope,
  CanvasAgentStep,
  CanvasAgentStepDelta,
  CanvasAgentWorkflow,
} from './types'

const AGENT_THREADS_KEY = 'agent.threads.v1'
const MAX_THREADS = 12
const MAX_MESSAGES = 40
const MAX_UNDO_SNAPSHOTS = 6

export type AgentWorkspaceStatus = 'working' | 'ready' | 'kept' | 'adopted' | 'discarded'
export type AgentMessageStatus = 'running' | 'done' | 'stopped' | 'error'
export type AgentStageStatus = 'pending' | 'active' | 'done' | 'error'

export interface AgentWorkspace {
  id: string
  sourceSectionId: string
  sourceSectionName: string
  draftSectionId: string
  draftSectionName: string
  pageMap: api.AgentPageClone[]
  sourceSnapshot: string
  status: AgentWorkspaceStatus
  createdAt: number
  updatedAt: number
}

export interface AgentMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  createdAt: number
  status?: AgentMessageStatus
  error?: string
  workflow?: CanvasAgentWorkflow
  steps?: CanvasAgentStep[]
  undo?: AgentUndoSnapshot
  attachments?: AgentMessageAttachment[]
  attachmentContext?: string
}

export interface AgentMessageAttachment {
  name: string
  mime: string
  kind: AiChatAttachment['kind']
  size: number
  truncated?: boolean
}

export interface AgentUndoSnapshot {
  pageId: string
  before: CanvasDoc
  afterFingerprint: string
  stepCount: number
  createdAt: number
  revertedAt?: number
}

export interface AgentThread {
  id: string
  workspace: AgentWorkspace
  messages: AgentMessage[]
  createdAt: number
  updatedAt: number
}

interface PersistedAgentState {
  version: 1
  activeThreadId: string | null
  threads: AgentThread[]
}

interface CanvasAgentStore {
  hydrated: boolean
  running: boolean
  finalizing: boolean
  prompt: string
  progress: CanvasAgentProgress[]
  preview: CanvasAgentPreview | null
  error: string | null
  runToken: number

  threads: AgentThread[]
  activeThreadId: string | null
  workflow: CanvasAgentWorkflow | null
  stageStatus: Record<string, AgentStageStatus>
  liveDoc: CanvasDoc | null
  livePageId: string | null
  activeElementIds: string[]
  activeStrokeIds: string[]
  completedElementIds: string[]
  completedStrokeIds: string[]
  committedStepCount: number

  hydrate: () => Promise<void>
  run: (
    prompt: string,
    scope: CanvasAgentScope,
    attachments?: AiChatAttachment[],
    conversationHistory?: CanvasAgentHistoryMessage[]
  ) => Promise<CanvasAgentPreview | null>
  cancel: () => void
  adoptDraft: () => Promise<api.AgentSectionAdoptResult>
  undoAgentChange: (messageId: string) => Promise<AgentUndoSnapshot>
  keepDraft: () => void
  discardDraft: () => Promise<void>
  clearHistory: () => void
  activateForSection: (sectionId: string | null) => void
  applyPreview: () => CanvasAgentPreview
  clearPreview: () => void
  reset: () => void
}

let hydratePromise: Promise<void> | null = null
let draftSaveChain: Promise<void> = Promise.resolve()
let runtimeCommitChain: Promise<void> = Promise.resolve()
let runtimeCommitError: Error | null = null
let persistChain: Promise<void> = Promise.resolve()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function documentFingerprint(doc: CanvasDoc) {
  return JSON.stringify({
    version: doc.version,
    background: doc.background,
    elements: doc.elements,
    strokes: doc.strokes,
  })
}

function normalizeCanvasDoc(value: unknown): CanvasDoc | null {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.background !== 'string' ||
    !Array.isArray(value.elements) ||
    !Array.isArray(value.strokes)
  ) {
    return null
  }
  return clone(value as unknown as CanvasDoc)
}

function normalizeUndoSnapshot(value: unknown): AgentUndoSnapshot | undefined {
  if (!isRecord(value)) return undefined
  const before = normalizeCanvasDoc(value.before)
  if (
    !before ||
    typeof value.pageId !== 'string' ||
    typeof value.afterFingerprint !== 'string' ||
    !isFiniteNumber(value.stepCount) ||
    value.stepCount < 1 ||
    !isFiniteNumber(value.createdAt)
  ) {
    return undefined
  }
  return {
    pageId: value.pageId,
    before,
    afterFingerprint: value.afterFingerprint,
    stepCount: value.stepCount,
    createdAt: value.createdAt,
    ...(isFiniteNumber(value.revertedAt) ? { revertedAt: value.revertedAt } : {}),
  }
}

function normalizeWorkflow(value: unknown): CanvasAgentWorkflow | undefined {
  if (!isRecord(value) || !Array.isArray(value.stages)) return undefined
  if (
    typeof value.id !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.summary !== 'string'
  ) {
    return undefined
  }
  const stages = value.stages.flatMap((stage) => {
    if (!isRecord(stage) || !Array.isArray(stage.targetElementIds)) return []
    if (
      typeof stage.id !== 'string' ||
      !isFiniteNumber(stage.index) ||
      typeof stage.title !== 'string' ||
      typeof stage.objective !== 'string' ||
      !stage.targetElementIds.every((id) => typeof id === 'string')
    ) {
      return []
    }
    return [
      {
        id: stage.id,
        index: stage.index,
        title: stage.title,
        objective: stage.objective,
        targetElementIds: stage.targetElementIds,
        ...(isCanvasAgentSkillId(stage.skill) ? { skill: stage.skill } : {}),
      },
    ]
  })
  return { id: value.id, title: value.title, summary: value.summary, stages }
}

function normalizeStep(value: unknown): CanvasAgentStep | null {
  if (!isRecord(value)) return null
  if (
    !isFiniteNumber(value.index) ||
    typeof value.tool !== 'string' ||
    typeof value.reason !== 'string' ||
    typeof value.observation !== 'string'
  ) {
    return null
  }
  return {
    index: value.index,
    tool: value.tool as CanvasAgentStep['tool'],
    reason: value.reason,
    observation: value.observation,
    ...(typeof value.stageId === 'string' ? { stageId: value.stageId } : {}),
    ...(isFiniteNumber(value.stageIndex) ? { stageIndex: value.stageIndex } : {}),
  }
}

function normalizeMessage(value: unknown): AgentMessage | null {
  if (!isRecord(value)) return null
  if (
    typeof value.id !== 'string' ||
    (value.role !== 'user' && value.role !== 'assistant') ||
    typeof value.text !== 'string' ||
    !isFiniteNumber(value.createdAt)
  ) {
    return null
  }
  const validStatuses: AgentMessageStatus[] = ['running', 'done', 'stopped', 'error']
  const rawStatus = validStatuses.includes(value.status as AgentMessageStatus)
    ? (value.status as AgentMessageStatus)
    : undefined
  const interrupted = rawStatus === 'running'
  const workflow = normalizeWorkflow(value.workflow)
  const undo = normalizeUndoSnapshot(value.undo)
  const steps = Array.isArray(value.steps)
    ? value.steps.map(normalizeStep).filter((step): step is CanvasAgentStep => step !== null)
    : undefined
  const attachments = Array.isArray(value.attachments)
    ? value.attachments
        .flatMap((attachment) => {
          if (
            !isRecord(attachment) ||
            typeof attachment.name !== 'string' ||
            typeof attachment.mime !== 'string' ||
            (attachment.kind !== 'image' && attachment.kind !== 'document') ||
            !isFiniteNumber(attachment.size) ||
            attachment.size < 0
          ) {
            return []
          }
          return [
            {
              name: attachment.name,
              mime: attachment.mime,
              kind: attachment.kind,
              size: attachment.size,
              ...(attachment.truncated === true ? { truncated: true } : {}),
            } satisfies AgentMessageAttachment,
          ]
        })
        .slice(0, 6)
    : undefined
  return {
    id: value.id,
    role: value.role,
    text:
      interrupted && !value.text
        ? '应用上次退出时中断，本轮已停止；已完成的步骤仍保留在 AI 工作稿中。'
        : value.text,
    createdAt: value.createdAt,
    ...(rawStatus ? { status: interrupted ? 'stopped' : rawStatus } : {}),
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
    ...(workflow ? { workflow } : {}),
    ...(steps ? { steps } : {}),
    ...(undo ? { undo } : {}),
    ...(attachments?.length ? { attachments } : {}),
    ...(typeof value.attachmentContext === 'string' && value.attachmentContext.trim()
      ? { attachmentContext: value.attachmentContext.slice(0, 12_000) }
      : {}),
  }
}

function undoSnapshot(
  pageId: string,
  before: CanvasDoc,
  after: CanvasDoc,
  stepCount: number,
  existing?: AgentUndoSnapshot
): AgentUndoSnapshot {
  return {
    pageId,
    before: existing?.before ?? clone(before),
    afterFingerprint: documentFingerprint(after),
    stepCount,
    createdAt: existing?.createdAt ?? Date.now(),
  }
}

function normalizeThread(value: unknown): AgentThread | null {
  if (!isRecord(value) || !isRecord(value.workspace) || !Array.isArray(value.messages)) return null
  const workspace = value.workspace
  const validWorkspaceStatuses: AgentWorkspaceStatus[] = [
    'working',
    'ready',
    'kept',
    'adopted',
    'discarded',
  ]
  if (
    typeof value.id !== 'string' ||
    !isFiniteNumber(value.createdAt) ||
    !isFiniteNumber(value.updatedAt) ||
    typeof workspace.id !== 'string' ||
    typeof workspace.sourceSectionId !== 'string' ||
    typeof workspace.sourceSectionName !== 'string' ||
    typeof workspace.draftSectionId !== 'string' ||
    typeof workspace.draftSectionName !== 'string' ||
    !Array.isArray(workspace.pageMap) ||
    typeof workspace.sourceSnapshot !== 'string' ||
    !validWorkspaceStatuses.includes(workspace.status as AgentWorkspaceStatus) ||
    !isFiniteNumber(workspace.createdAt) ||
    !isFiniteNumber(workspace.updatedAt)
  ) {
    return null
  }
  const pageMap = workspace.pageMap.flatMap((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.sourcePageId !== 'string' ||
      typeof entry.draftPageId !== 'string'
    ) {
      return []
    }
    return [{ sourcePageId: entry.sourcePageId, draftPageId: entry.draftPageId }]
  })
  const messages = value.messages
    .map(normalizeMessage)
    .filter((message): message is AgentMessage => message !== null)
    .slice(-MAX_MESSAGES)
  return {
    id: value.id,
    workspace: {
      id: workspace.id,
      sourceSectionId: workspace.sourceSectionId,
      sourceSectionName: workspace.sourceSectionName,
      draftSectionId: workspace.draftSectionId,
      draftSectionName: workspace.draftSectionName,
      pageMap,
      sourceSnapshot: workspace.sourceSnapshot,
      status:
        workspace.status === 'working'
          ? 'ready'
          : (workspace.status as AgentWorkspaceStatus),
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    },
    messages,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

function updateThread(
  threads: AgentThread[],
  threadId: string,
  update: (thread: AgentThread) => AgentThread
) {
  const index = threads.findIndex((thread) => thread.id === threadId)
  if (index < 0) return threads
  const next = update(threads[index])
  return threads.slice(0, index).concat(threads.slice(index + 1), next)
}

function updateMessage(
  threads: AgentThread[],
  threadId: string,
  messageId: string,
  patch: Partial<AgentMessage>
) {
  return updateThread(threads, threadId, (thread) => ({
    ...thread,
    updatedAt: Date.now(),
    messages: thread.messages.map((message) =>
      message.id === messageId ? { ...message, ...patch } : message
    ),
  }))
}

function compactThreads(threads: AgentThread[]) {
  return threads
    .slice()
    .sort((a, b) => a.updatedAt - b.updatedAt || a.createdAt - b.createdAt)
    .slice(-MAX_THREADS)
    .map((thread) => {
      const messages = thread.messages.slice(-MAX_MESSAGES)
      const undoIndices = messages
        .map((message, index) => ({ message, index }))
        .filter(({ message }) => message.undo && !message.undo.revertedAt)
        .slice(-MAX_UNDO_SNAPSHOTS)
        .map(({ index }) => index)
      const remaining = MAX_UNDO_SNAPSHOTS - undoIndices.length
      if (remaining > 0) {
        undoIndices.unshift(
          ...messages
            .map((message, index) => ({ message, index }))
            .filter(({ message, index }) => message.undo?.revertedAt && !undoIndices.includes(index))
            .slice(-remaining)
            .map(({ index }) => index)
        )
      }
      const keepUndo = new Set(undoIndices)
      return {
        ...thread,
        messages: messages.map((message, index) =>
          message.undo && !keepUndo.has(index) ? { ...message, undo: undefined } : message
        ),
      }
    })
}

function queueDraftSave(pageId: string, title: string, doc: CanvasDoc) {
  const snapshot = clone(doc)
  const plainText = docToPlainText(snapshot)
  const save = () =>
    api
      .savePage({
        id: pageId,
        title,
        content: JSON.stringify(snapshot),
        plainText,
        links: extractWikiLinks(plainText),
        tags: extractHashTags(plainText),
      })
      .then(() => undefined)
  draftSaveChain = draftSaveChain.catch(() => undefined).then(save)
  return draftSaveChain
}

function mergeIds(current: string[], next: string[]) {
  return [...new Set(current.concat(next))]
}

function stageMap(workflow: CanvasAgentWorkflow | null, value: AgentStageStatus = 'pending') {
  return Object.fromEntries((workflow?.stages ?? []).map((stage) => [stage.id, value]))
}

function activeThreadOf(state: Pick<CanvasAgentStore, 'threads' | 'activeThreadId'>) {
  return state.threads.find((thread) => thread.id === state.activeThreadId) ?? null
}

export const useCanvasAgent = create<CanvasAgentStore>((set, get) => {
  const persist = () => {
    if (!get().hydrated) return
    const payload: PersistedAgentState = {
      version: 1,
      activeThreadId: get().activeThreadId,
      threads: compactThreads(get().threads),
    }
    const value = JSON.stringify(payload)
    persistChain = persistChain
      .catch(() => undefined)
      .then(() => api.setSetting(AGENT_THREADS_KEY, value))
    void persistChain.catch(() => undefined)
  }

  const flushPendingWrites = async () => {
    await runtimeCommitChain
    if (runtimeCommitError) throw runtimeCommitError
    await draftSaveChain
  }

  const setWorkspaceStatus = (threadId: string, status: AgentWorkspaceStatus) => {
    set((state) => ({
      threads: updateThread(state.threads, threadId, (thread) => ({
        ...thread,
        updatedAt: Date.now(),
        workspace: { ...thread.workspace, status, updatedAt: Date.now() },
      })),
    }))
    persist()
  }

  const commitLiveDocument = async (pageId: string, doc: CanvasDoc) => {
    await draftSaveChain
    const app = useApp.getState()
    if (app.pageId !== pageId) return
    app.replaceDoc(clone(doc), false)
    if (!(await useApp.getState().save(true))) {
      throw new Error('AI 工作稿保存失败，已保留当前画布，请重试')
    }
  }

  const prepareWorkspace = async (scope: CanvasAgentScope) => {
    await get().hydrate()
    const initial = useApp.getState()
    if (!initial.sectionId || !initial.pageId) throw new Error('请先打开一个分区页面')

    const selectedElementIds = initial.selection.slice()
    const selectedStrokeIds = initial.strokeSelection.slice()
    const reusable = get()
      .threads.slice()
      .reverse()
      .find(
        (thread) =>
          (thread.workspace.status === 'working' || thread.workspace.status === 'ready') &&
          (thread.workspace.sourceSectionId === initial.sectionId ||
            thread.workspace.draftSectionId === initial.sectionId)
      )

    if (reusable) {
      set({ activeThreadId: reusable.id })
      if (initial.sectionId === reusable.workspace.sourceSectionId) {
        const mapped = reusable.workspace.pageMap.find(
          (item) => item.sourcePageId === initial.pageId
        )?.draftPageId
        await useApp.getState().refreshTree()
        if (mapped) await useApp.getState().openPage(mapped)
        else await useApp.getState().selectSection(reusable.workspace.draftSectionId)
        if (scope === 'selection') {
          useApp.getState().setSelection(selectedElementIds)
          useApp.getState().setStrokeSelection(selectedStrokeIds)
        }
      }
      setWorkspaceStatus(reusable.id, 'working')
      return reusable.id
    }

    if (!(await initial.save(true))) {
      throw new Error('当前页面保存失败，未创建 AI 工作稿')
    }
    const result = await api.duplicateSectionForAgent(initial.sectionId, initial.pageId)
    const createdAt = Date.now()
    const thread: AgentThread = {
      id: uid('agent-thread'),
      workspace: {
        id: uid('agent-workspace'),
        sourceSectionId: result.sourceSection.id,
        sourceSectionName: result.sourceSection.name,
        draftSectionId: result.draftSection.id,
        draftSectionName: result.draftSection.name,
        pageMap: result.pageMap,
        sourceSnapshot: result.sourceSnapshot,
        status: 'working',
        createdAt,
        updatedAt: createdAt,
      },
      messages: [],
      createdAt,
      updatedAt: createdAt,
    }
    set((state) => ({
      threads: compactThreads(state.threads.concat(thread)),
      activeThreadId: thread.id,
    }))
    persist()

    await useApp.getState().refreshTree()
    if (result.currentDraftPageId) await useApp.getState().openPage(result.currentDraftPageId)
    else await useApp.getState().selectSection(result.draftSection.id)
    if (scope === 'selection') {
      useApp.getState().setSelection(selectedElementIds)
      useApp.getState().setStrokeSelection(selectedStrokeIds)
    }
    return thread.id
  }

  return {
    hydrated: false,
    running: false,
    finalizing: false,
    prompt: '',
    progress: [],
    preview: null,
    error: null,
    runToken: 0,

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

    async hydrate() {
      if (get().hydrated) return
      if (hydratePromise) return hydratePromise
      hydratePromise = (async () => {
        try {
          const raw = await api.getSetting(AGENT_THREADS_KEY)
          if (raw) {
            const parsed: unknown = JSON.parse(raw)
            if (isRecord(parsed) && parsed.version === 1 && Array.isArray(parsed.threads)) {
              const threads = compactThreads(
                parsed.threads
                  .map(normalizeThread)
                  .filter((thread): thread is AgentThread => thread !== null)
              )
              const parsedActiveThreadId =
                typeof parsed.activeThreadId === 'string' ? parsed.activeThreadId : null
              const activeThreadId = threads.some(
                (thread) => thread.id === parsedActiveThreadId
              )
                ? parsedActiveThreadId
                : threads[threads.length - 1]?.id ?? null
              set({ threads, activeThreadId })
            }
          }
        } catch {
          // 损坏或旧版历史不应阻止应用启动。
        } finally {
          set({ hydrated: true })
          hydratePromise = null
        }
      })()
      return hydratePromise
    },

    async run(prompt, scope, attachments = [], conversationHistory = []) {
      await flushPendingWrites()
      const runAttachments = attachments.slice(0, 6)
      const normalized =
        prompt.trim() ||
        (runAttachments.length ? '请阅读附件并把关键信息整理到当前画布。' : '')
      if (!normalized) throw new Error('请描述你希望 Agent 如何调整画布')
      const beforePrepare = useApp.getState()
      if (
        scope === 'selection' &&
        beforePrepare.selection.length === 0 &&
        beforePrepare.strokeSelection.length === 0
      ) {
        throw new Error('请先选择要操作的元素或笔迹')
      }

      const threadId = await prepareWorkspace(scope)
      const app = useApp.getState()
      if (!app.pageId) throw new Error('AI 工作稿中没有可编辑页面')
      const thread = get().threads.find((item) => item.id === threadId)
      if (!thread) throw new Error('Agent 对话线程已失效')

      const agentHistory = thread.messages
        .filter((message, index, messages) => {
          if (message.status === 'running' || message.error || message.undo?.revertedAt) return false
          const next = messages[index + 1]
          return !(
            message.role === 'user' &&
            next?.role === 'assistant' &&
            next.undo?.revertedAt
          )
        })
        .slice(-12)
        .map((message) => ({
          role: message.role,
          content: [
            message.text,
            message.attachments?.length
              ? `附件：${message.attachments.map((attachment) => attachment.name).join('、')}`
              : '',
            message.attachmentContext
              ? `附件材料摘要：${message.attachmentContext}`
              : '',
          ]
            .filter(Boolean)
            .join('\n'),
          createdAt: message.createdAt,
        }))
      const chatHistory = conversationHistory
        .filter(
          (message) =>
            (message.role === 'user' || message.role === 'assistant') &&
            typeof message.content === 'string' &&
            message.content.trim().length > 0
        )
        .slice(-8)
        .map((message) => ({
          role: message.role,
          content: message.content.slice(0, 12_000),
          createdAt: message.createdAt ?? 0,
        }))
      const history = agentHistory
        .concat(chatHistory)
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(-16)
        .map(({ role, content }) => ({ role, content }))
      const userMessage: AgentMessage = {
        id: uid('agent-message'),
        role: 'user',
        text: normalized,
        createdAt: Date.now(),
        status: 'done',
        ...(runAttachments.length
          ? {
              attachments: runAttachments.map(({ name, mime, kind, size, truncated }) => ({
                name,
                mime,
                kind,
                size,
                ...(truncated ? { truncated: true } : {}),
              })),
            }
          : {}),
      }
      const assistantMessage: AgentMessage = {
        id: uid('agent-message'),
        role: 'assistant',
        text: '',
        createdAt: Date.now(),
        status: 'running',
        steps: [],
      }
      const token = get().runToken + 1
      const input = {
        pageId: app.pageId,
        baseRev: app.rev,
        prompt: normalized,
        scope,
        doc: clone(app.doc),
        selectedElementIds: app.selection.slice(),
        selectedStrokeIds: app.strokeSelection.slice(),
        history,
        attachments: runAttachments,
      }
      const inputTitle = app.title
      set((state) => ({
        running: true,
        finalizing: false,
        prompt: normalized,
        progress: [],
        preview: null,
        error: null,
        runToken: token,
        activeThreadId: threadId,
        workflow: null,
        stageStatus: {},
        liveDoc: clone(app.doc),
        livePageId: app.pageId,
        activeElementIds: [],
        activeStrokeIds: [],
        completedElementIds: [],
        completedStrokeIds: [],
        committedStepCount: 0,
        threads: updateThread(state.threads, threadId, (current) => ({
          ...current,
          updatedAt: Date.now(),
          workspace: { ...current.workspace, status: 'working', updatedAt: Date.now() },
          messages: current.messages.concat(userMessage, assistantMessage).slice(-MAX_MESSAGES),
        })),
      }))
      persist()

      try {
        const { runCanvasAgent } = await import('./session')
        const preview = await runCanvasAgent(input, {
          isCancelled: () => get().runToken !== token,
          onProgress: (item) => {
            if (get().runToken !== token) return
            set((state) => ({ progress: state.progress.concat(item).slice(-80) }))
          },
          onAttachmentContext: (context) => {
            if (get().runToken !== token) return
            set((state) => ({
              threads: updateMessage(state.threads, threadId, userMessage.id, {
                attachmentContext: context.slice(0, 12_000),
              }),
            }))
            persist()
          },
          onWorkflow: (workflow) => {
            if (get().runToken !== token) return
            set((state) => ({
              workflow,
              stageStatus: stageMap(workflow),
              threads: updateMessage(state.threads, threadId, assistantMessage.id, { workflow }),
            }))
            persist()
          },
          onStepStart: (step) => {
            if (get().runToken !== token) return
            set((state) => ({
              activeElementIds: step.activeElementIds,
              activeStrokeIds: step.activeStrokeIds,
              stageStatus: {
                ...Object.fromEntries(
                  Object.entries(state.stageStatus).map(([id, status]) => [
                    id,
                    status === 'active' ? 'done' : status,
                  ])
                ),
                [step.stage.id]: 'active',
              },
            }))
          },
          onStepCommitted: (delta: CanvasAgentStepDelta) => {
            if (get().runToken !== token) return
            set((state) => {
              const currentThread = state.threads.find((item) => item.id === threadId)
              const currentMessage = currentThread?.messages.find(
                (message) => message.id === assistantMessage.id
              )
              const steps = (currentMessage?.steps ?? [])
                .filter((step) => step.index !== delta.step.index)
                .concat(delta.step)
                .sort((a, b) => a.index - b.index)
              return {
                liveDoc: clone(delta.doc),
                livePageId: input.pageId,
                activeElementIds: delta.activeElementIds,
                activeStrokeIds: delta.activeStrokeIds,
                completedElementIds: mergeIds(
                  state.completedElementIds,
                  delta.changedElementIds.concat(delta.createdElementIds)
                ),
                completedStrokeIds: mergeIds(state.completedStrokeIds, delta.changedStrokeIds),
                committedStepCount: state.committedStepCount + 1,
                threads: updateMessage(state.threads, threadId, assistantMessage.id, {
                  steps,
                  undo: undoSnapshot(
                    input.pageId,
                    input.doc,
                    delta.doc,
                    steps.length,
                    currentMessage?.undo
                  ),
                }),
              }
            })
            void queueDraftSave(input.pageId, inputTitle, delta.doc)
            persist()
          },
        })
        if (get().runToken !== token) return null

        await draftSaveChain
        if (get().runToken !== token) return null
        await commitLiveDocument(input.pageId, preview.after)
        if (get().runToken !== token) return null
        set((state) => {
          const currentMessage = state.threads
            .find((item) => item.id === threadId)
            ?.messages.find((message) => message.id === assistantMessage.id)
          const undo =
            preview.steps.length > 0
              ? undoSnapshot(
                  input.pageId,
                  input.doc,
                  preview.after,
                  preview.steps.length,
                  currentMessage?.undo
                )
              : currentMessage?.undo
          return {
            running: false,
            preview,
            error: null,
            workflow: state.workflow,
            stageStatus: Object.fromEntries(
              Object.keys(state.stageStatus).map((id) => [id, 'done' as AgentStageStatus])
            ),
            liveDoc: null,
            livePageId: null,
            activeElementIds: [],
            activeStrokeIds: [],
            threads: updateMessage(
              updateThread(state.threads, threadId, (current) => ({
                ...current,
                workspace: { ...current.workspace, status: 'ready', updatedAt: Date.now() },
              })),
              threadId,
              assistantMessage.id,
              {
                text: preview.summary,
                status: 'done',
                steps: preview.steps,
                workflow: preview.workflow ?? state.workflow ?? undefined,
                ...(undo ? { undo } : {}),
              }
            ),
          }
        })
        persist()
        return preview
      } catch (error) {
        if (get().runToken !== token) return null
        const message = error instanceof Error ? error.message : String(error)
        const liveDoc = get().liveDoc
        if (liveDoc && get().committedStepCount > 0) {
          try {
            await commitLiveDocument(input.pageId, liveDoc)
          } catch {
            // 原始错误更有助于定位 Agent 失败原因。
          }
        }
        set((state) => ({
          running: false,
          error: message,
          liveDoc: null,
          livePageId: null,
          activeElementIds: [],
          activeStrokeIds: [],
          progress: state.progress.concat({
            id: `error-${Date.now()}`,
            phase: 'error',
            text: message,
          }),
          threads: updateMessage(state.threads, threadId, assistantMessage.id, {
            text: '本轮执行未完成，已完成的步骤仍保留在 AI 工作稿中。',
            status: 'error',
            error: message,
          }),
        }))
        persist()
        throw error
      }
    },

    cancel() {
      const state = get()
      if (!state.running) return
      const liveDoc = state.liveDoc ? clone(state.liveDoc) : null
      const livePageId = state.livePageId
      const committedStepCount = state.committedStepCount
      const hasPendingCommit = Boolean(liveDoc && livePageId && committedStepCount > 0)
      const thread = activeThreadOf(state)
      const runningMessage = thread?.messages
        .slice()
        .reverse()
        .find((message) => message.status === 'running')
      set((current) => ({
        running: false,
        finalizing: hasPendingCommit,
        runToken: current.runToken + 1,
        error: null,
        liveDoc: hasPendingCommit ? liveDoc : null,
        livePageId: hasPendingCommit ? livePageId : null,
        activeElementIds: [],
        activeStrokeIds: [],
        progress: current.progress.concat({
          id: `cancel-${Date.now()}`,
          phase: 'error',
          text: '已停止；已完成的修改保留在 AI 工作稿中',
        }),
        threads:
          thread && runningMessage
            ? updateMessage(current.threads, thread.id, runningMessage.id, {
                text: '已停止本轮执行；完成的步骤已保留在工作稿中。',
                status: 'stopped',
              })
            : current.threads,
      }))
      if (liveDoc && livePageId && hasPendingCommit) {
        runtimeCommitError = null
        runtimeCommitChain = commitLiveDocument(livePageId, liveDoc)
          .catch((error) => {
            runtimeCommitError = error instanceof Error ? error : new Error(String(error))
            set({ error: runtimeCommitError.message })
          })
          .finally(() => set({ finalizing: false, liveDoc: null, livePageId: null }))
      }
      persist()
    },

    async adoptDraft() {
      const thread = activeThreadOf(get())
      if (!thread) throw new Error('没有可采纳的 AI 工作稿')
      if (get().running) throw new Error('请先等待 Agent 完成本轮操作')
      await flushPendingWrites()
      const app = useApp.getState()
      const currentDraftPageId =
        app.sectionId === thread.workspace.draftSectionId
          ? app.pageId
          : thread.workspace.pageMap.find((item) => item.sourcePageId === app.pageId)?.draftPageId ??
            null
      if (!(await app.save(true))) throw new Error('AI 工作稿保存失败，暂未采纳')
      const result = await api.adoptAgentDraft(
        thread.workspace.sourceSectionId,
        thread.workspace.draftSectionId,
        thread.workspace.sourceSnapshot,
        currentDraftPageId
      )
      setWorkspaceStatus(thread.id, 'adopted')
      set({ preview: null, liveDoc: null, livePageId: null })
      if (result.currentPageId) await useApp.getState().openPage(result.currentPageId)
      else await useApp.getState().selectSection(thread.workspace.sourceSectionId)
      await useApp.getState().refreshTree()
      return result
    },

    async undoAgentChange(messageId) {
      if (get().running) throw new Error('请先停止 Agent 后再撤回修改')
      if (get().finalizing) throw new Error('正在保存已完成的修改，请稍候')
      await flushPendingWrites()
      const thread = activeThreadOf(get())
      if (!thread) throw new Error('没有可撤回的 Agent 修改')
      if (thread.workspace.status === 'discarded') throw new Error('工作稿已丢弃，无法撤回修改')
      const latestUndoable = thread.messages
        .slice()
        .reverse()
        .find((message) => message.role === 'assistant' && message.undo && !message.undo.revertedAt)
      if (!latestUndoable?.undo || latestUndoable.id !== messageId) {
        throw new Error('请先撤回最近一轮 Agent 修改')
      }
      const snapshot = latestUndoable.undo
      set({ finalizing: true, error: null })
      try {
        if (useApp.getState().pageId !== snapshot.pageId) {
          await useApp.getState().openPage(snapshot.pageId)
        }
        const app = useApp.getState()
        if (app.pageId !== snapshot.pageId) throw new Error('对应的工作稿页面不存在')
        if (documentFingerprint(app.doc) !== snapshot.afterFingerprint) {
          throw new Error('该页面在本轮 Agent 修改后又发生了变化，为避免覆盖内容，暂未撤回')
        }
        const previous = clone(app.doc)
        app.replaceDoc(clone(snapshot.before), false)
        if (!(await useApp.getState().save(true))) {
          useApp.getState().replaceDoc(previous, false)
          throw new Error('撤回结果保存失败，画布已恢复到撤回前状态')
        }
        const reverted: AgentUndoSnapshot = { ...snapshot, revertedAt: Date.now() }
        set((state) => ({
          finalizing: false,
          preview: null,
          error: null,
          completedElementIds: [],
          completedStrokeIds: [],
          activeElementIds: [],
          activeStrokeIds: [],
          threads: updateMessage(state.threads, thread.id, messageId, { undo: reverted }),
        }))
        persist()
        return reverted
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        set({ finalizing: false, error: message })
        throw error
      }
    },

    keepDraft() {
      const thread = activeThreadOf(get())
      if (!thread) throw new Error('没有可保留的 AI 工作稿')
      if (get().running) throw new Error('请先等待 Agent 完成本轮操作')
      if (get().finalizing) throw new Error('正在保存已完成的修改，请稍候')
      setWorkspaceStatus(thread.id, 'kept')
      set({ preview: null, liveDoc: null, livePageId: null })
    },

    async discardDraft() {
      const thread = activeThreadOf(get())
      if (!thread) throw new Error('没有可丢弃的 AI 工作稿')
      if (get().running) throw new Error('请先停止 Agent 后再丢弃工作稿')
      await flushPendingWrites()
      const app = useApp.getState()
      const sourcePageId = thread.workspace.pageMap.find(
        (item) => item.draftPageId === app.pageId
      )?.sourcePageId
      await app.selectSection(thread.workspace.sourceSectionId)
      if (sourcePageId && useApp.getState().pageId !== sourcePageId) {
        await useApp.getState().openPage(sourcePageId)
      }
      await api.deleteSection(thread.workspace.draftSectionId)
      setWorkspaceStatus(thread.id, 'discarded')
      set({ preview: null, liveDoc: null, livePageId: null })
      await useApp.getState().refreshTree()
    },

    clearHistory() {
      if (get().running || get().finalizing) return
      const thread = activeThreadOf(get())
      if (!thread) return
      set((state) => ({
        progress: [],
        error: null,
        workflow: null,
        stageStatus: {},
        threads: updateThread(state.threads, thread.id, (current) => ({
          ...current,
          messages:
            current.workspace.status === 'working' || current.workspace.status === 'ready'
              ? current.messages
                  .filter(
                    (message) =>
                      message.role === 'assistant' &&
                      message.undo &&
                      !message.undo.revertedAt
                  )
                  .map((message) => ({
                    id: message.id,
                    role: message.role,
                    text: message.text || '保留的可撤回 Agent 修改',
                    createdAt: message.createdAt,
                    status: 'done' as const,
                    undo: message.undo,
                  }))
              : [],
          updatedAt: Date.now(),
        })),
      }))
      persist()
    },

    activateForSection(sectionId) {
      if (get().running || get().finalizing) return
      const matching = sectionId
        ? get()
            .threads.slice()
            .reverse()
            .find(
              (thread) =>
                thread.workspace.sourceSectionId === sectionId ||
                thread.workspace.draftSectionId === sectionId
            )
        : null
      const nextThreadId = matching?.id ?? null
      if (nextThreadId !== get().activeThreadId) {
        set({ activeThreadId: nextThreadId, progress: [], error: null, workflow: null, stageStatus: {} })
        persist()
      }
    },

    applyPreview() {
      const preview = get().preview
      if (!preview) throw new Error('没有待应用的 Agent 方案')
      const app = useApp.getState()
      if (app.pageId !== preview.pageId || app.rev !== preview.baseRev) {
        set({ preview: null })
        throw new Error('画布已发生变化，原预览已失效，请重新生成')
      }
      app.replaceDoc(clone(preview.after), true)
      const selected = preview.changedElementIds.concat(preview.createdElementIds)
      if (selected.length > 0) app.setSelection(selected)
      set({ preview: null, progress: [], error: null })
      return preview
    },

    clearPreview() {
      set({ preview: null, error: null })
    },

    reset() {
      runtimeCommitError = null
      set((state) => ({
        running: false,
        finalizing: false,
        prompt: '',
        progress: [],
        preview: null,
        error: null,
        runToken: state.runToken + 1,
        workflow: null,
        stageStatus: {},
        liveDoc: null,
        livePageId: null,
        activeElementIds: [],
        activeStrokeIds: [],
        completedElementIds: [],
        completedStrokeIds: [],
        committedStepCount: 0,
      }))
    },
  }
})

export const selectActiveAgentThread = (state: CanvasAgentStore) => activeThreadOf(state)
