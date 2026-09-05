import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import {
  ArrowUp,
  Bot,
  Check,
  ClipboardCopy,
  Eraser,
  FileText,
  Image as ImageIcon,
  LocateFixed,
  Paperclip,
  PlusSquare,
  Replace,
  Settings2,
  Sparkles,
  Square,
  Undo2,
  Workflow,
  X,
} from 'lucide-react'
import { useApp } from '../../lib/store'
import * as api from '../../lib/api'
import type { AiMessage, ChatTurn } from '../../lib/types'
import {
  ACTION_GROUPS,
  QUICK_ACTIONS,
  TARGET_LANGUAGES,
  activeProfile,
  buildContext,
  translateAction,
} from '../../lib/aiActions'
import {
  draftFromPage,
  generateConceptDiagram,
  generateFlowchart,
  generateMindMap,
  generateStickyWall,
  smartLayout,
  tidyLayout,
  translatePageToNewPage,
  type AiCanvasProgress,
} from '../../lib/aiCanvas'
import { cn, formatBytes, uid } from '../../lib/utils'
import { emit } from '../../lib/bus'
import { hasRememberedSelection, replaceSelection, takeSelectionText } from '../../lib/activeEditor'
import {
  buildAiUserContent,
  loadAiChatAttachment,
  type AiChatAttachment,
} from '../../lib/aiAttachments'
import {
  applyAiStreamEvent,
  mergeAiConversationHistory,
  sortAiConversationTimeline,
  stopPendingAiTurns,
} from '../../lib/aiChatState'
import {
  classifyAiIntent,
  inferAiAgentScope,
  isMindMapGenerationIntent,
} from '../../lib/aiIntent'
import { useCanvasAgent } from '../../lib/agent/store'
import { canvasAgentSkillLabel } from '../../lib/agent/layoutSkills'
import type { CanvasAgentHistoryMessage, CanvasAgentScope } from '../../lib/agent/types'
import { IconButton, Select, Spinner, useToast } from '../ui'

marked.setOptions({ breaks: true, gfm: true })

const SYSTEM_CHAT = `你是「reunote」里的笔记助手。请始终使用简体中文回答，除非用户明确要求其他语言。
回答要具体、结构清晰，可以使用 Markdown。当用户提供了笔记上下文时，优先基于上下文作答；如果上下文里没有答案，请直接说明。`

function advanceOperation(turn: ChatTurn, label: string): ChatTurn {
  if (!turn.operation || turn.operation.status !== 'running') return turn
  const previous = turn.operation.steps[turn.operation.steps.length - 1]
  if (previous?.label === label && previous.status === 'running') return turn
  return {
    ...turn,
    operation: {
      ...turn.operation,
      steps: turn.operation.steps
        .map((step) => (step.status === 'running' ? { ...step, status: 'done' as const } : step))
        .concat({ id: uid('operation-step'), label, status: 'running' as const }),
    },
  }
}

function finishOperation(turn: ChatTurn, status: 'done' | 'error'): ChatTurn {
  if (!turn.operation || turn.operation.status !== 'running') return turn
  return {
    ...turn,
    operation: {
      ...turn.operation,
      status,
      steps: turn.operation.steps.map((step) => ({
        ...step,
        status: step.status === 'running' ? status : step.status,
      })),
    },
  }
}

function canvasActionTargets(
  beforePageId: string | null,
  beforeElements: Map<string, string>,
  after: ReturnType<typeof useApp.getState>
) {
  const existingIds = new Set(after.doc.elements.map((element) => element.id))
  if (after.pageId !== beforePageId) {
    const selected = after.selection.filter((id) => existingIds.has(id))
    return selected.length > 0 ? selected : Array.from(existingIds)
  }
  const changed = after.doc.elements
    .filter(
      (element) =>
        !beforeElements.has(element.id) || beforeElements.get(element.id) !== JSON.stringify(element)
    )
    .map((element) => element.id)
  if (changed.length > 0) return changed
  return after.selection.filter((id) => existingIds.has(id))
}

export function AIPanel() {
  const aiOpen = useApp((s) => s.aiOpen)
  const settings = useApp((s) => s.settings)
  const patchSettings = useApp((s) => s.patchSettings)
  const sectionId = useApp((s) => s.sectionId)
  const selectionCount = useApp((s) => s.selection.length + s.strokeSelection.length)
  const agentRunning = useCanvasAgent((s) => s.running)
  const agentFinalizing = useCanvasAgent((s) => s.finalizing)
  const agentProgressCount = useCanvasAgent((s) => s.progress.length)
  const agentMessageCount = useCanvasAgent((s) =>
    s.threads.find((thread) => thread.id === s.activeThreadId)?.messages.length ?? 0
  )
  const activeAgentDraft = useCanvasAgent((s) => {
    const status = s.threads.find((thread) => thread.id === s.activeThreadId)?.workspace.status
    return status === 'working' || status === 'ready'
  })
  const agentHasError = useCanvasAgent((s) => Boolean(s.error))
  const store = useApp
  const toast = useToast()

  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [useContext, setUseContext] = useState(true)
  const [canReplace, setCanReplace] = useState(false)
  const [group, setGroup] = useState<string>('改写')
  const [agentScope, setAgentScope] = useState<CanvasAgentScope>('page')
  const [attachments, setAttachments] = useState<AiChatAttachment[]>([])
  const [attaching, setAttaching] = useState(false)
  const reqRef = useRef<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  const profile = useMemo(
    () => activeProfile(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings.aiProfiles, settings.activeProfileId]
  )
  const predictedIntent = useMemo(
    () =>
      classifyAiIntent(input, {
        hasAttachments: attachments.length > 0,
        hasActiveAgentDraft: activeAgentDraft,
        hasAgentHistory: agentMessageCount > 0,
        hasSelection: selectionCount > 0,
      }),
    [activeAgentDraft, agentMessageCount, attachments.length, input, selectionCount]
  )
  const executionBusy = busy || agentRunning || agentFinalizing
  const showAgentScope =
    predictedIntent === 'agent' ||
    agentRunning ||
    agentFinalizing ||
    (activeAgentDraft && input.trim().length === 0)
  const showEmptyState =
    turns.length === 0 &&
    agentMessageCount === 0 &&
    agentProgressCount === 0 &&
    !agentRunning &&
    !agentFinalizing &&
    !agentHasError &&
    !activeAgentDraft

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [turns, agentProgressCount, agentMessageCount])

  useEffect(() => {
    if (aiOpen) setTimeout(() => taRef.current?.focus(), 60)
  }, [aiOpen])

  useEffect(() => {
    if (selectionCount === 0 && agentScope === 'selection') setAgentScope('page')
  }, [agentScope, selectionCount])

  useEffect(() => {
    let active = true
    void useCanvasAgent
      .getState()
      .hydrate()
      .then(() => {
        if (active) useCanvasAgent.getState().activateForSection(sectionId)
      })
    return () => {
      active = false
    }
  }, [sectionId, agentRunning, agentFinalizing])

  const run = useCallback(
    async (
      userText: string,
      systemPrompt = SYSTEM_CHAT,
      withContext = true,
      allowReplace = false,
      files: AiChatAttachment[] = [],
      operationLabel = 'AI 回复'
    ) => {
      const p = activeProfile()
      if (!p) {
        toast('请先在设置里添加 AI 服务', 'error')
        store.getState().setUI({ settingsOpen: true })
        return
      }
      if (useCanvasAgent.getState().running || useCanvasAgent.getState().finalizing) return
      if (!userText.trim() && files.length === 0) return
      let userContent: unknown
      try {
        userContent = buildAiUserContent(p, userText, files)
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), 'error')
        return
      }
      // 「替换原文」只对本次调用显式声明可替换时才成立。
      // 普通对话必须置回 false，否则上一次快捷动作留下的 true 会漂到无关回答上。
      setCanReplace(allowReplace)

      // 上一个请求还在跑：先取消，否则它的 requestId 会被覆盖、永远停不掉
      if (reqRef.current) {
        void api.aiCancel(reqRef.current)
        reqRef.current = null
      }

      const userTurn: ChatTurn = {
        id: uid('t'),
        role: 'user',
        text: userText.trim() || '请阅读附件并概括重点。',
        attachments: files.map(({ name, kind }) => ({ name, kind })),
        createdAt: Date.now(),
      }
      const botTurn: ChatTurn = {
        id: uid('t'),
        role: 'assistant',
        text: '',
        pending: true,
        operation: {
          label: operationLabel,
          status: 'running',
          steps: [
            {
              id: uid('operation-step'),
              label: '准备本轮请求',
              status: 'running',
            },
          ],
        },
        createdAt: Date.now(),
      }
      setTurns((v) => v.concat([userTurn, botTurn]))
      setBusy(true)

      const report = (label: string) => {
        setTurns((current) =>
          current.map((turn) =>
            turn.id === botTurn.id ? advanceOperation(turn, label) : turn
          )
        )
      }

      let contextBlock = ''
      if (withContext) {
        report('读取笔记上下文')
        try {
          contextBlock = await buildContext(settings.aiContextScope)
        } catch {
          contextBlock = ''
        }
      }
      report('等待模型响应')

      const agentState = useCanvasAgent.getState()
      const agentThread = agentState.threads.find(
        (thread) => thread.id === agentState.activeThreadId
      )
      const agentHistory = (agentThread?.messages ?? [])
        .filter((message, index, messages) => {
          if (message.status === 'running' || message.status === 'error' || message.error) return false
          const next = messages[index + 1]
          return !(
            message.role === 'user' &&
            next?.role === 'assistant' &&
            next.undo?.revertedAt
          ) && !message.undo?.revertedAt
        })
        .map((message) => ({
          role: message.role,
          content: message.text,
          createdAt: message.createdAt,
        }))
      const history = mergeAiConversationHistory(
        turns
          .filter((turn) => !turn.pending && !turn.error)
          .map((turn) => ({ role: turn.role, content: turn.text, createdAt: turn.createdAt }))
          .concat(agentHistory),
        12
      )

      const messages: AiMessage[] = [{ role: 'system', content: systemPrompt }]
      if (contextBlock) {
        messages.push({
          role: 'user',
          content: `以下是我当前的笔记内容，供你参考：\n\n<笔记>\n${contextBlock}\n</笔记>`,
        })
        messages.push({ role: 'assistant', content: '好的，我已经读完这些笔记。' })
      }
      messages.push(...history, { role: 'user', content: userContent })

      const requestId = uid('req')
      reqRef.current = requestId

      try {
        await api.aiChat(p, messages, requestId, (ev) => {
          // 停止或被后续请求取代后，忽略仍在通道里排队的流式事件。
          if (reqRef.current !== requestId) return
          setTurns((v) =>
            v.map((t) => {
              if (t.id !== botTurn.id) return t
              let next = applyAiStreamEvent(t, ev)
              if (ev.type === 'reasoning') next = advanceOperation(next, '模型正在分析')
              if (ev.type === 'delta') next = advanceOperation(next, '接收并整理模型输出')
              if (ev.type === 'done') next = finishOperation(next, 'done')
              if (ev.type === 'error') next = finishOperation(next, 'error')
              return next
            })
          )
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setTurns((v) =>
          v.map((t) =>
            t.id === botTurn.id
              ? finishOperation({ ...t, pending: false, error: msg }, 'error')
              : t
          )
        )
      } finally {
        setTurns((v) =>
          v.map((t) =>
            t.id === botTurn.id
              ? t.error
                ? { ...t, pending: false }
                : finishOperation({ ...t, pending: false }, 'done')
              : t
          )
        )
        // 只有仍属于本次请求时才收尾，避免把后发请求的状态误清
        if (reqRef.current === requestId) {
          setBusy(false)
          reqRef.current = null
        }
      }
    },
    [turns, settings.aiContextScope, store, toast]
  )

  const stop = () => {
    if (useCanvasAgent.getState().running) useCanvasAgent.getState().cancel()
    const requestId = reqRef.current
    reqRef.current = null
    if (requestId) void api.aiCancel(requestId)
    setTurns((current) =>
      stopPendingAiTurns(current).map((turn) =>
        turn.stopped ? finishOperation(turn, 'error') : turn
      )
    )
    setBusy(false)
  }

  const runAgentCommand = async (
    text: string,
    files: AiChatAttachment[] = [],
    scope: CanvasAgentScope = agentScope
  ) => {
    if (busy || useCanvasAgent.getState().running || useCanvasAgent.getState().finalizing) return
    const p = activeProfile()
    if (!p) {
      toast('请先在设置里添加 AI 服务', 'error')
      store.getState().setUI({ settingsOpen: true })
      return
    }
    if (!text.trim()) return
    try {
      // 在创建工作稿前完成附件数量、大小与视觉能力校验。
      buildAiUserContent(p, text, files)
      const chatHistory: CanvasAgentHistoryMessage[] = turns
        .filter((turn) => !turn.pending && !turn.error)
        .slice(-8)
        .map((turn) => ({ role: turn.role, content: turn.text, createdAt: turn.createdAt }))
      const preview = await useCanvasAgent.getState().run(text, scope, files, chatHistory)
      if (preview) toast('本轮修改已保存到 AI 工作稿', 'success')
    } catch (error) {
      setInput((current) => current || text)
      if (files.length > 0) {
        setAttachments((current) => (current.length > 0 ? current : files))
      }
      toast(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  const pickAttachments = async () => {
    if (attaching || busy || agentRunning || agentFinalizing) return
    setAttaching(true)
    try {
      const picked = await openDialog({
        title: '添加到 AI 助手',
        multiple: true,
        filters: [
          {
            name: '图片、PDF、文本和代码',
            extensions: [
              'png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'txt', 'md',
              'markdown', 'csv', 'json', 'xml', 'html', 'htm', 'css', 'js', 'jsx', 'ts',
              'tsx', 'py', 'rs', 'go', 'java', 'c', 'h', 'cpp', 'yaml', 'yml', 'toml',
              'log', 'tex',
            ],
          },
        ],
      })
      if (!picked) return
      const paths = (Array.isArray(picked) ? picked : [picked]).slice(0, 6 - attachments.length)
      const loaded: AiChatAttachment[] = []
      for (const path of paths) {
        try {
          loaded.push(await loadAiChatAttachment(path))
        } catch (error) {
          toast(error instanceof Error ? error.message : String(error), 'error')
        }
      }
      if (loaded.length > 0) setAttachments((current) => current.concat(loaded).slice(0, 6))
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setAttaching(false)
    }
  }

  const submitInput = () => {
    if (busy || agentRunning || agentFinalizing) return
    const text =
      input.trim() ||
      (attachments.length ? '请阅读附件并概括重点。' : '')
    if (!text) return
    const p = activeProfile()
    if (!p) {
      toast('请先在设置里添加 AI 服务', 'error')
      store.getState().setUI({ settingsOpen: true })
      return
    }
    try {
      buildAiUserContent(p, text, attachments)
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error')
      return
    }
    const files = attachments
    const intent = classifyAiIntent(text, {
      hasAttachments: files.length > 0,
      hasActiveAgentDraft: activeAgentDraft,
      hasAgentHistory: agentMessageCount > 0,
      hasSelection: selectionCount > 0,
    })
    setInput('')
    setAttachments([])
    if (files.length === 0 && isMindMapGenerationIntent(text)) {
      void runCanvas('思维导图', (report) => generateMindMap(undefined, report), text)
      return
    }
    if (intent === 'agent') {
      const scope = inferAiAgentScope(text, selectionCount, agentScope)
      setAgentScope(scope)
      void runAgentCommand(text, files, scope)
    } else {
      void run(text, SYSTEM_CHAT, useContext, false, files, '回答问题')
    }
  }

  const runQuick = async (key: string) => {
    const action = QUICK_ACTIONS.find((a) => a.key === key)
    if (!action) return
    const sel = takeSelectionText()
    let material = sel
    let replaceable = false
    if (material) {
      replaceable = hasRememberedSelection()
    } else {
      if (action.needsSelection) {
        toast('请先在文本块里选中一段文字', 'error')
        return
      }
      material = await buildContext('page')
    }
    await run(
      action.user(material),
      action.system,
      false,
      replaceable && action.replaces,
      [],
      action.label
    )
  }

  const runTranslate = async (langLabel: string) => {
    const action = translateAction(langLabel)
    const sel = takeSelectionText()
    const material = sel || (await buildContext('page'))
    if (!material.trim()) {
      toast('当前页面还没有内容', 'error')
      return
    }
    await run(
      action.user(material),
      action.system,
      false,
      !!sel && hasRememberedSelection(),
      [],
      `翻译为${langLabel}`
    )
  }

  /** 专用画布生成器：直接落到当前页，同时纳入统一对话时间线。 */
  const runCanvas = async (
    label: string,
    fn: (report: AiCanvasProgress) => Promise<string>,
    userText?: string
  ) => {
    if (busy || useCanvasAgent.getState().running || useCanvasAgent.getState().finalizing) return
    if (!activeProfile()) {
      toast('请先在设置里添加 AI 服务', 'error')
      store.getState().setUI({ settingsOpen: true })
      return
    }
    const startedAt = Date.now()
    const userTurn: ChatTurn = {
      id: uid('t'),
      role: 'user',
      text: userText ?? `执行画布操作：${label}`,
      createdAt: startedAt,
    }
    const assistantTurn: ChatTurn = {
      id: uid('t'),
      role: 'assistant',
      text: '',
      pending: true,
      operation: {
        label,
        status: 'running',
        steps: [
          {
            id: uid('operation-step'),
            label: '准备画布任务',
            status: 'running',
          },
        ],
      },
      createdAt: startedAt + 1,
    }
    setCanReplace(false)
    setTurns((current) => current.concat(userTurn, assistantTurn))
    setBusy(true)
    toast(`${label}：正在生成…`)
    const before = store.getState()
    const beforePageId = before.pageId
    const beforeElements = new Map(
      before.doc.elements.map((element) => [element.id, JSON.stringify(element)])
    )
    const report: AiCanvasProgress = (stepLabel) => {
      setTurns((current) =>
        current.map((turn) =>
          turn.id === assistantTurn.id ? advanceOperation(turn, stepLabel) : turn
        )
      )
    }
    try {
      const msg = await fn(report)
      report('定位并选中生成结果')
      const after = store.getState()
      const targets = canvasActionTargets(beforePageId, beforeElements, after)
      if (targets.length > 0) emit({ type: 'reveal-elements', ids: targets })
      setTurns((current) =>
        current.map((turn) =>
          turn.id === assistantTurn.id
            ? {
                ...turn,
                text: msg,
                pending: false,
                operation: turn.operation
                  ? {
                      ...turn.operation,
                      status: 'done',
                      targetPageId: after.pageId ?? undefined,
                      targetElementIds: targets,
                      steps: turn.operation.steps.map((step) => ({
                        ...step,
                        status: step.status === 'running' ? 'done' : step.status,
                      })),
                    }
                  : undefined,
              }
            : turn
        )
      )
      toast(msg, 'success')
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setTurns((current) =>
        current.map((turn) =>
          turn.id === assistantTurn.id
            ? {
                ...turn,
                pending: false,
                error: message,
                operation: turn.operation
                  ? {
                      ...turn.operation,
                      status: 'error',
                      steps: turn.operation.steps.map((step) => ({
                        ...step,
                        status: step.status === 'running' ? 'error' : step.status,
                      })),
                    }
                  : undefined,
              }
            : turn
        )
      )
      toast(message, 'error')
    } finally {
      setBusy(false)
    }
  }

  /** 不需要联网的本地整理 */
  const runLocal = (label: string, fn: () => number) => {
    try {
      const n = fn()
      toast(n > 0 ? `${label}：已重排 ${n} 个元素` : '画布上没有可整理的元素', n > 0 ? 'success' : 'info')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ action: string }>).detail
      if (detail?.action) void runQuick(detail.action)
    }
    window.addEventListener('jinyan-notes:ai-action', handler)
    return () => window.removeEventListener('jinyan-notes:ai-action', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns, settings.aiContextScope])

  const renderChatTurn = (turn: ChatTurn, index: number) => (
    <Turn
      key={turn.id}
      turn={turn}
      onInsert={(text) => emit({ type: 'insert-ai-text', text })}
      onReplace={
        canReplace && index === turns.length - 1
          ? (html) => {
              const ok = replaceSelection(html)
              toast(ok ? '已替换原文' : '原选区已失效，请重新选择', ok ? 'success' : 'error')
              if (ok) setCanReplace(false)
            }
          : undefined
      }
    />
  )

  if (!aiOpen) return null

  return (
    <div className="flex h-full w-[352px] shrink-0 flex-col border-l border-[var(--ink-border)] bg-[var(--ink-panel)]">
      <div data-tauri-drag-region className="h-[38px] shrink-0 drag-region" />

      <div className="flex items-center gap-2 px-3 pb-2">
        <Bot size={16} className="text-[var(--ink-accent)]" />
        <span className="flex-1 text-[13px] font-semibold">AI 助手</span>
        <IconButton
          title="清空对话（保留可撤回修改）"
          disabled={executionBusy}
          onClick={() => {
            setTurns([])
            setCanReplace(false)
            useCanvasAgent.getState().clearHistory()
          }}
        >
          <Eraser size={15} />
        </IconButton>
        <IconButton
          title="AI 设置"
          onClick={() => store.getState().setUI({ settingsOpen: true })}
        >
          <Settings2 size={15} />
        </IconButton>
        <IconButton title="关闭 ⌘J" onClick={() => store.getState().setUI({ aiOpen: false })}>
          <X size={15} />
        </IconButton>
      </div>

      <div className="flex items-center gap-1.5 px-3 pb-2">
        <Select
          value={settings.activeProfileId ?? ''}
          onChange={(e) => patchSettings({ activeProfileId: e.target.value })}
          className="h-7 flex-1 !py-0 !text-[12px]"
        >
          {settings.aiProfiles.length === 0 && <option value="">未配置服务</option>}
          {settings.aiProfiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {p.model}
            </option>
          ))}
        </Select>
        <Select
          value={settings.aiContextScope}
          onChange={(e) =>
            patchSettings({ aiContextScope: e.target.value as 'page' | 'section' | 'notebook' })
          }
          className="h-7 w-[92px] !py-0 !text-[12px]"
          title="AI 可见的上下文范围"
        >
          <option value="page">本页</option>
          <option value="section">本分区</option>
          <option value="notebook">本笔记本</option>
        </Select>
      </div>

      {/* 分组标签 */}
      <div className="flex gap-1 px-3 pb-1.5">
        {[...ACTION_GROUPS, '画布'].map((g) => (
          <button
            key={g}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setGroup(g)}
            className={cn(
              'rounded-md px-2 py-[3px] text-[11.5px] transition',
              group === g
                ? 'bg-[var(--ink-accent-soft)] font-medium text-[var(--ink-accent)]'
                : 'text-[var(--ink-muted)] hover:bg-[var(--ink-panel-2)]'
            )}
          >
            {g}
          </button>
        ))}
      </div>

      {/* 动作按钮 */}
      <div className="flex max-h-[104px] flex-wrap gap-1 overflow-y-auto px-3 pb-2">
        {group === '翻译' &&
          TARGET_LANGUAGES.map((l) => (
            <ActionPill
              key={l.code}
              disabled={executionBusy}
              onClick={() => void runTranslate(l.label)}
            >
              {l.label}
            </ActionPill>
          ))}

        {group === '画布' && (
          <>
            <ActionPill disabled={executionBusy} onClick={() => runLocal('一键整理', () => tidyLayout(2))}>
              一键整理
            </ActionPill>
            <ActionPill
              disabled={executionBusy}
              onClick={() => void runCanvas('智能布局', (report) => smartLayout(true, report))}
            >
              AI 智能布局
            </ActionPill>
            <ActionPill
              disabled={executionBusy}
              onClick={() =>
                void runCanvas('思维导图', (report) => generateMindMap(undefined, report))
              }
            >
              生成思维导图
            </ActionPill>
            <ActionPill
              disabled={executionBusy}
              onClick={() => void runCanvas('流程图', generateFlowchart)}
            >
              生成流程图
            </ActionPill>
            <ActionPill
              disabled={executionBusy}
              onClick={() => void runCanvas('关系示意图', generateConceptDiagram)}
            >
              生成示意图
            </ActionPill>
            <ActionPill
              disabled={executionBusy}
              onClick={() => void runCanvas('便签墙', generateStickyWall)}
            >
              拆成便签墙
            </ActionPill>
            <ActionPill
              disabled={executionBusy}
              onClick={() => void runCanvas('成稿', draftFromPage)}
            >
              整理成文章
            </ActionPill>
            <ActionPill
              disabled={executionBusy}
              onClick={() =>
                void runCanvas('整页翻译', (report) =>
                  translatePageToNewPage('英语', report)
                )
              }
            >
              整页译为英语
            </ActionPill>
          </>
        )}

        {group !== '翻译' &&
          group !== '画布' &&
          QUICK_ACTIONS.filter((a) => a.group === group).map((a) => (
            <ActionPill key={a.key} disabled={executionBusy} onClick={() => void runQuick(a.key)}>
              {a.label}
            </ActionPill>
          ))}
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {showEmptyState && (
          <div className="mt-6 px-2 text-center">
            <Sparkles size={22} className="mx-auto mb-2 text-[var(--ink-accent)] opacity-60" />
            <div className="text-[13px] font-medium">问点什么，或选中文字后用上面的快捷操作</div>
            <div className="mt-1.5 text-[12px] leading-relaxed text-[var(--ink-muted)]">
              {profile
                ? `当前服务：${profile.name}（${profile.model}）`
                : '还没有配置 AI 服务，点右上角齿轮添加'}
            </div>
          </div>
        )}
        <AgentRunView chatTurns={turns} renderChatTurn={renderChatTurn} />
      </div>

      <div className="border-t border-[var(--ink-border)] p-2.5">
        <div className="relative rounded-xl border border-[var(--ink-border)] bg-[var(--ink-panel-2)] focus-within:border-[var(--ink-accent)]">
          {attachments.length > 0 && (
            <div className="flex max-h-[86px] flex-wrap gap-1.5 overflow-y-auto px-2.5 pt-2.5">
              {attachments.map((attachment) => (
                <div
                  key={attachment.id}
                  className="flex max-w-full items-center gap-1.5 rounded-md border border-[var(--ink-border)] bg-[var(--ink-panel)] px-2 py-1 text-[11px]"
                  title={`${attachment.name} · ${formatBytes(attachment.size)}`}
                >
                  {attachment.kind === 'image' ? (
                    <ImageIcon size={12} className="shrink-0 text-[var(--ink-accent)]" />
                  ) : (
                    <FileText size={12} className="shrink-0 text-[var(--ink-accent)]" />
                  )}
                  <span className="max-w-[210px] truncate">{attachment.name}</span>
                  <button
                    type="button"
                    title="移除附件"
                    onClick={() =>
                      setAttachments((current) =>
                        current.filter((item) => item.id !== attachment.id)
                      )
                    }
                    className="text-[var(--ink-muted)] hover:text-[var(--ink-text)]"
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={taRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                submitInput()
              }
            }}
            rows={3}
            placeholder="提问，或描述希望 AI 如何调整画布…"
            className="max-h-[160px] w-full resize-none bg-transparent px-3 py-2.5 text-[13px] outline-none placeholder:text-[var(--ink-muted)]"
          />
          <div className="flex items-center justify-between px-2 pb-2">
            <div className="flex min-w-0 items-center gap-1">
              <IconButton
                title="添加图片、PDF、文本或代码文件"
                onClick={() => void pickAttachments()}
                disabled={attaching || executionBusy}
                className="!h-6 !w-6"
              >
                {attaching ? <Spinner size={12} /> : <Paperclip size={13} />}
              </IconButton>
              {showAgentScope ? (
                <div className="flex rounded-md bg-[var(--ink-panel)] p-0.5 text-[11px]">
                  <button
                    onClick={() => setAgentScope('page')}
                    className={cn(
                      'rounded px-2 py-0.5',
                      agentScope === 'page'
                        ? 'bg-[var(--ink-accent-soft)] text-[var(--ink-accent)]'
                        : 'text-[var(--ink-muted)]'
                    )}
                  >
                    整页
                  </button>
                  <button
                    onClick={() => setAgentScope('selection')}
                    disabled={selectionCount === 0}
                    className={cn(
                      'rounded px-2 py-0.5 disabled:opacity-35',
                      agentScope === 'selection'
                        ? 'bg-[var(--ink-accent-soft)] text-[var(--ink-accent)]'
                        : 'text-[var(--ink-muted)]'
                    )}
                  >
                    选中 {selectionCount || ''}
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setUseContext((v) => !v)}
                  className={cn(
                    'truncate rounded-full px-2 py-[2px] text-[11px] transition',
                    useContext
                      ? 'bg-[var(--ink-accent-soft)] text-[var(--ink-accent)]'
                      : 'text-[var(--ink-muted)] hover:bg-[var(--ink-panel)]'
                  )}
                  title="是否把笔记内容作为上下文发送"
                >
                  {useContext ? '已带上笔记上下文' : '不带上下文'}
                </button>
              )}
            </div>
            {busy || agentRunning ? (
              <IconButton title="停止生成" onClick={stop}>
                <Square size={14} className="fill-current" />
              </IconButton>
            ) : agentFinalizing ? (
              <IconButton title="正在保存 AI 工作稿" disabled>
                <Spinner size={13} />
              </IconButton>
            ) : (
              <button
                onClick={submitInput}
                disabled={!input.trim() && attachments.length === 0}
                title={predictedIntent === 'agent' ? '交给 AI 修改画布' : '发送消息'}
                className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--ink-accent)] text-white transition hover:brightness-110 disabled:opacity-35"
              >
                <ArrowUp size={15} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function AgentRunView({
  chatTurns,
  renderChatTurn,
}: {
  chatTurns: ChatTurn[]
  renderChatTurn: (turn: ChatTurn, index: number) => React.ReactNode
}) {
  const running = useCanvasAgent((state) => state.running)
  const finalizing = useCanvasAgent((state) => state.finalizing)
  const progress = useCanvasAgent((state) => state.progress)
  const error = useCanvasAgent((state) => state.error)
  const threads = useCanvasAgent((state) => state.threads)
  const activeThreadId = useCanvasAgent((state) => state.activeThreadId)
  const currentWorkflow = useCanvasAgent((state) => state.workflow)
  const currentStageStatus = useCanvasAgent((state) => state.stageStatus)
  const toast = useToast()
  const [acting, setActing] = useState(false)
  const thread = threads.find((item) => item.id === activeThreadId) ?? null
  const workspace = thread?.workspace ?? null
  const latestUndoMessageId = thread?.messages
    .slice()
    .reverse()
    .find((message) => message.role === 'assistant' && message.undo && !message.undo.revertedAt)?.id
  const conversationItems = sortAiConversationTimeline([
    ...chatTurns.map((turn, index) => ({
      kind: 'chat' as const,
      createdAt: turn.createdAt,
      turn,
      turnIndex: index,
    })),
    ...(thread?.messages ?? []).map((message, index) => ({
      kind: 'agent' as const,
      createdAt: message.createdAt,
      message,
      messageIndex: index,
    })),
  ])

  const adopt = async () => {
    setActing(true)
    try {
      await useCanvasAgent.getState().adoptDraft()
      toast('已采纳工作稿，原内容已保存到回收站', 'success')
    } catch (actionError) {
      toast(actionError instanceof Error ? actionError.message : String(actionError), 'error')
    } finally {
      setActing(false)
    }
  }

  const keep = () => {
    try {
      useCanvasAgent.getState().keepDraft()
      toast('AI 工作稿已作为独立分区保留', 'success')
    } catch (actionError) {
      toast(actionError instanceof Error ? actionError.message : String(actionError), 'error')
    }
  }

  const discard = async () => {
    if (!window.confirm('丢弃这个 AI 工作稿？工作稿会移入回收站。')) return
    setActing(true)
    try {
      await useCanvasAgent.getState().discardDraft()
      toast('AI 工作稿已移入回收站')
    } catch (actionError) {
      toast(actionError instanceof Error ? actionError.message : String(actionError), 'error')
    } finally {
      setActing(false)
    }
  }

  const undoAgentChange = async (messageId: string) => {
    setActing(true)
    try {
      const snapshot = await useCanvasAgent.getState().undoAgentChange(messageId)
      toast(`已撤回本轮 ${snapshot.stepCount} 个 Agent 操作`, 'success')
    } catch (actionError) {
      toast(actionError instanceof Error ? actionError.message : String(actionError), 'error')
    } finally {
      setActing(false)
    }
  }

  if (!thread && !running && progress.length === 0 && !error) {
    return <>{chatTurns.map(renderChatTurn)}</>
  }

  return (
    <div className="py-2">
      {workspace && (
        <div className="mb-3 border-b border-[var(--ink-border)] pb-2.5">
          <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--ink-muted)]">
            <span className="truncate">{workspace.sourceSectionName}</span>
            <span aria-hidden="true">→</span>
            <span className="min-w-0 flex-1 truncate font-medium text-[var(--ink-text)]">
              {workspace.draftSectionName}
            </span>
            <span
              className={cn(
                'shrink-0 text-[10.5px]',
                workspace.status === 'working' || workspace.status === 'ready'
                  ? 'text-[var(--ink-accent)]'
                  : 'text-[var(--ink-muted)]'
              )}
            >
              {workspace.status === 'working'
                ? running
                  ? '修改中'
                  : finalizing
                    ? '正在保存'
                  : '工作稿'
                : workspace.status === 'ready'
                  ? '待处理'
                  : workspace.status === 'kept'
                    ? '已保留'
                    : workspace.status === 'adopted'
                      ? '已采纳'
                      : '已丢弃'}
            </span>
          </div>
        </div>
      )}
      <div className="space-y-3">
        {conversationItems.map((item) => {
          if (item.kind === 'chat') return renderChatTurn(item.turn, item.turnIndex)
          const { message, messageIndex } = item
          const isCurrent = messageIndex === (thread?.messages.length ?? 0) - 1
          const workflow = isCurrent && message.status === 'running' ? currentWorkflow : message.workflow
          const steps = message.steps ?? []
          if (message.role === 'user') {
            return (
              <div key={message.id} className="flex justify-end">
                <div className="max-w-[88%] whitespace-pre-wrap rounded-lg rounded-br-sm bg-[var(--ink-accent)] px-3 py-2 text-[12.5px] leading-relaxed text-white">
                  {message.text}
                  {message.attachments && message.attachments.length > 0 && (
                    <div className="mt-1.5 space-y-1 border-t border-white/25 pt-1.5 text-[10.5px] text-white/85">
                      {message.attachments.map((attachment, index) => (
                        <div
                          key={`${message.id}-${attachment.name}-${index}`}
                          className="flex min-w-0 items-center gap-1"
                        >
                          {attachment.kind === 'image' ? (
                            <ImageIcon size={10} className="shrink-0" />
                          ) : (
                            <FileText size={10} className="shrink-0" />
                          )}
                          <span className="truncate">{attachment.name}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )
          }
          return (
            <div key={message.id} className="border-l-2 border-[var(--ink-border)] pl-2.5">
              {workflow && (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-1.5 text-[11.5px] font-medium">
                    <Workflow size={13} className="text-[var(--ink-accent)]" />
                    <span className="min-w-0 truncate">{workflow.title}</span>
                  </div>
                  {workflow.stages.map((stage) => {
                    const persistedDone =
                      message.status === 'done' || steps.some((step) => step.stageId === stage.id)
                    const status =
                      isCurrent && message.status === 'running'
                        ? currentStageStatus[stage.id] ?? 'pending'
                        : persistedDone
                          ? 'done'
                          : 'pending'
                    return (
                      <div
                        key={stage.id}
                        className={cn(
                          'flex items-start gap-2 text-[11.5px] leading-relaxed',
                          status === 'active' ? 'text-[var(--ink-text)]' : 'text-[var(--ink-muted)]'
                        )}
                      >
                        {status === 'active' ? (
                          <Spinner size={11} />
                        ) : status === 'done' ? (
                          <Check size={12} className="mt-0.5 shrink-0 text-emerald-500" />
                        ) : (
                          <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--ink-border)]" />
                        )}
                        <span>
                          <span className="font-medium">{stage.title}</span>
                          {stage.skill && (
                            <span className="ml-1.5 text-[10px] text-[var(--ink-accent)]">
                              {canvasAgentSkillLabel(stage.skill)}
                            </span>
                          )}
                          {status === 'active' && stage.objective && (
                            <span className="mt-0.5 block text-[10.5px] text-[var(--ink-muted)]">
                              {stage.objective}
                            </span>
                          )}
                        </span>
                      </div>
                    )
                  })}
                </div>
              )}

              {steps.length > 0 && (
                <details className="mt-2 text-[11px] text-[var(--ink-muted)]">
                  <summary className="cursor-pointer">已执行 {steps.length} 个操作</summary>
                  <div className="mt-1.5 space-y-1 border-l border-[var(--ink-border)] pl-2">
                    {steps.map((step) => (
                      <div key={`${message.id}-${step.index}`}>
                        {step.index}. {step.reason}：{step.observation}
                      </div>
                    ))}
                  </div>
                </details>
              )}

              {isCurrent && message.status === 'running' && progress.length > 0 && (
                <div className="mt-2 space-y-1 text-[11px] text-[var(--ink-muted)]">
                  {progress.slice(-4).map((item, index, visible) => (
                    <div key={item.id} className="flex items-start gap-1.5">
                      {index === visible.length - 1 ? (
                        <Spinner size={10} />
                      ) : (
                        <Check size={11} className="mt-0.5 shrink-0 text-emerald-500" />
                      )}
                      <span>{item.text}</span>
                    </div>
                  ))}
                </div>
              )}

              {message.text && (
                <div
                  className={cn(
                    'mt-2 text-[12px] leading-relaxed',
                    message.status === 'error' ? 'text-red-500' : 'text-[var(--ink-text)]'
                  )}
                >
                  {message.text}
                </div>
              )}
              {message.error && (
                <div className="mt-1 text-[11px] leading-relaxed text-red-500">{message.error}</div>
              )}
              {message.undo?.revertedAt ? (
                <div className="mt-2 flex items-center gap-1 text-[11px] text-[var(--ink-muted)]">
                  <Undo2 size={11} /> 本轮修改已撤回
                </div>
              ) :
                message.id === latestUndoMessageId &&
                workspace?.status !== 'discarded' && (
                  <button
                    type="button"
                    onClick={() => void undoAgentChange(message.id)}
                    disabled={acting || running || finalizing}
                    className="mt-2 flex h-7 items-center gap-1 rounded-md border border-[var(--ink-border)] px-2 text-[11px] text-[var(--ink-muted)] hover:bg-[var(--ink-panel-2)] disabled:opacity-45"
                    title="恢复到本轮 Agent 修改开始前，不影响普通画布撤销记录"
                  >
                    {acting ? <Spinner size={11} /> : <Undo2 size={11} />}
                    撤回本轮修改
                  </button>
                )}
            </div>
          )
        })}
      </div>

      {!thread && error && <div className="mt-2 text-[12px] text-red-500">{error}</div>}

      {workspace && (workspace.status === 'working' || workspace.status === 'ready') && !running && (
        <div className="mt-4 border-t border-[var(--ink-border)] pt-3">
          <button
            onClick={() => void adopt()}
            disabled={acting || finalizing}
            className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-[var(--ink-accent)] px-3 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-45"
          >
            {acting || finalizing ? <Spinner size={12} /> : <Replace size={13} />}
            {finalizing ? '正在保存修改…' : '采纳并替换原分区'}
          </button>
          <div className="mt-1.5 grid grid-cols-2 gap-1.5">
            <button
              onClick={keep}
              disabled={acting || finalizing}
              className="flex h-7 items-center justify-center gap-1 rounded-md border border-[var(--ink-border)] text-[11.5px] text-[var(--ink-muted)] hover:bg-[var(--ink-panel-2)] disabled:opacity-45"
            >
              <FileText size={12} /> 保留工作稿
            </button>
            <button
              onClick={() => void discard()}
              disabled={acting || finalizing}
              className="flex h-7 items-center justify-center gap-1 rounded-md border border-red-500/25 text-[11.5px] text-red-500 hover:bg-red-500/8 disabled:opacity-45"
            >
              <X size={12} /> 丢弃工作稿
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function ActionPill({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      className="rounded-full border border-[var(--ink-border)] px-2.5 py-[3px] text-[11.5px] text-[var(--ink-muted)] transition hover:border-[var(--ink-accent)] hover:text-[var(--ink-accent)] disabled:opacity-40"
    >
      {children}
    </button>
  )
}

function Turn({
  turn,
  onInsert,
  onReplace,
}: {
  turn: ChatTurn
  onInsert: (text: string) => void
  onReplace?: (html: string) => void
}) {
  const toast = useToast()
  const html = useMemo(() => {
    if (turn.role === 'user') return ''
    try {
      return marked.parse(turn.text || '') as string
    } catch {
      return turn.text
    }
  }, [turn.text, turn.role])

  if (turn.role === 'user') {
    return (
      <div className="mb-3 flex justify-end">
        <div className="max-w-[86%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-[var(--ink-accent)] px-3 py-2 text-[13px] leading-relaxed text-white">
          {turn.attachments && turn.attachments.length > 0 && (
            <div className="mb-1.5 flex flex-wrap justify-end gap-1">
              {turn.attachments.map((attachment) => (
                <span
                  key={`${attachment.kind}-${attachment.name}`}
                  className="flex max-w-full items-center gap-1 rounded bg-white/15 px-1.5 py-0.5 text-[10.5px]"
                >
                  {attachment.kind === 'image' ? <ImageIcon size={10} /> : <FileText size={10} />}
                  <span className="truncate">{attachment.name}</span>
                </span>
              ))}
            </div>
          )}
          {turn.text.length > 900 ? turn.text.slice(0, 900) + '…' : turn.text}
        </div>
      </div>
    )
  }

  return (
    <div className="group mb-3.5">
      {turn.reasoning && (
        <details className="mb-1.5 rounded-lg bg-[var(--ink-panel-2)] px-2.5 py-1.5">
          <summary className="cursor-pointer text-[11px] text-[var(--ink-muted)]">思考过程</summary>
          <div className="mt-1 whitespace-pre-wrap text-[11.5px] leading-relaxed text-[var(--ink-muted)]">
            {turn.reasoning}
          </div>
        </details>
      )}

      {turn.operation && (
        <div
          data-ai-operation={turn.operation.status}
          aria-live="polite"
          className="mb-2 border-l-2 border-[var(--ink-accent)]/45 pl-2.5"
        >
          <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-[var(--ink-text)]">
            <Workflow size={12} className="text-[var(--ink-accent)]" />
            <span className="min-w-0 flex-1 truncate">{turn.operation.label}</span>
            <span className="shrink-0 text-[10.5px] font-normal text-[var(--ink-muted)]">
              {turn.operation.status === 'running'
                ? '执行中'
                : turn.operation.status === 'done'
                  ? '已完成'
                  : '未完成'}
            </span>
          </div>
          <div className="mt-1.5 space-y-1">
            {turn.operation.steps.map((step) => (
              <div
                key={step.id}
                className={cn(
                  'flex min-w-0 items-start gap-1.5 text-[11px] leading-4',
                  step.status === 'error' ? 'text-red-500' : 'text-[var(--ink-muted)]'
                )}
              >
                <span className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                  {step.status === 'running' ? (
                    <Spinner size={10} />
                  ) : step.status === 'done' ? (
                    <Check size={11} className="text-emerald-500" />
                  ) : (
                    <X size={11} />
                  )}
                </span>
                <span className="min-w-0 break-words">{step.label}</span>
              </div>
            ))}
          </div>
          {turn.operation.status === 'done' &&
            turn.operation.targetElementIds &&
            turn.operation.targetElementIds.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  const operation = turn.operation
                  if (!operation?.targetElementIds?.length) return
                  void (async () => {
                    if (
                      operation.targetPageId &&
                      useApp.getState().pageId !== operation.targetPageId
                    ) {
                      await useApp.getState().openPage(operation.targetPageId)
                      if (useApp.getState().pageId !== operation.targetPageId) {
                        toast('无法打开生成内容所在页面，请先保存当前页面', 'error')
                        return
                      }
                    }
                    emit({ type: 'reveal-elements', ids: operation.targetElementIds ?? [] })
                  })()
                }}
                className="mt-2 flex h-7 items-center gap-1 rounded-md border border-[var(--ink-border)] px-2 text-[11px] text-[var(--ink-accent)] hover:bg-[var(--ink-accent-soft)]"
              >
                <LocateFixed size={12} />
                定位到生成内容
              </button>
            )}
        </div>
      )}

      {turn.error && !turn.text ? (
        <div className="rounded-xl border border-red-500/30 bg-red-500/8 px-3 py-2 text-[12.5px] leading-relaxed text-red-500">
          {turn.error}
        </div>
      ) : (
        <>
          <div
            className="ai-md selectable text-[13px] leading-relaxed"
            dangerouslySetInnerHTML={{ __html: html }}
          />
          {/* 中途出错时保留已经收到的正文，错误另起一行提示 */}
          {turn.error && (
            <div className="mt-1.5 rounded-lg border border-red-500/30 bg-red-500/8 px-2.5 py-1.5 text-[11.5px] leading-relaxed text-red-500">
              生成中断：{turn.error}
            </div>
          )}
          {turn.pending && (
            <span className="caret-blink ml-0.5 inline-block h-[14px] w-[7px] translate-y-[2px] bg-[var(--ink-accent)]" />
          )}
          {turn.stopped && (
            <div className="mt-1 text-[11px] text-[var(--ink-muted)]">已停止生成</div>
          )}
          {!turn.pending && turn.text && (
            <div className="mt-1.5 flex gap-1 opacity-0 transition group-hover:opacity-100">
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(turn.text)
                  toast('已复制')
                }}
                className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-[var(--ink-muted)] hover:bg-[var(--ink-panel-2)]"
              >
                <ClipboardCopy size={11} /> 复制
              </button>
              <button
                onClick={() => {
                  onInsert(marked.parse(turn.text) as string)
                  toast('已插入画布')
                }}
                className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-[var(--ink-muted)] hover:bg-[var(--ink-panel-2)]"
              >
                <PlusSquare size={11} /> 插入画布
              </button>
              {onReplace && (
                <button
                  onClick={() => onReplace(marked.parse(turn.text) as string)}
                  className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-[var(--ink-accent)] hover:bg-[var(--ink-accent-soft)]"
                >
                  <Replace size={11} /> 替换原文
                </button>
              )}
            </div>
          )}
        </>
      )}
      {turn.pending && !turn.text && !turn.operation && (
        <div className="flex items-center gap-2 text-[12px] text-[var(--ink-muted)]">
          <Spinner /> 正在思考…
        </div>
      )}
    </div>
  )
}
