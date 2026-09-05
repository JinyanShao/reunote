import { Check, Sparkles } from 'lucide-react'
import { useCanvasAgent } from '../../lib/agent/store'
import { strokeToPath } from '../../lib/ink'
import { useApp } from '../../lib/store'
import type { CanvasDoc, CanvasElement } from '../../lib/types'

const PREVIEW_Z = 999_900
const EMPTY_IDS: string[] = []

type AgentVisualState = {
  liveDoc?: CanvasDoc | null
  livePageId?: string | null
  activeElementIds?: string[]
  completedElementIds?: string[]
  activeStrokeIds?: string[]
  completedStrokeIds?: string[]
}

type ElementHighlightKind = 'active' | 'completed' | 'created' | 'changed'

interface ElementHighlight {
  element: CanvasElement
  before?: CanvasElement
  kind: ElementHighlightKind
}

export function AgentPreviewWorld() {
  const preview = useCanvasAgent((state) => state.preview)
  const running = useCanvasAgent((state) => state.running)
  const liveDoc = useCanvasAgent(
    (state) => (state as typeof state & AgentVisualState).liveDoc ?? null
  )
  const livePageId = useCanvasAgent(
    (state) => (state as typeof state & AgentVisualState).livePageId ?? null
  )
  const activeElementIds = useCanvasAgent(
    (state) => (state as typeof state & AgentVisualState).activeElementIds ?? EMPTY_IDS
  )
  const completedElementIds = useCanvasAgent(
    (state) => (state as typeof state & AgentVisualState).completedElementIds ?? EMPTY_IDS
  )
  const activeStrokeIds = useCanvasAgent(
    (state) => (state as typeof state & AgentVisualState).activeStrokeIds ?? EMPTY_IDS
  )
  const completedStrokeIds = useCanvasAgent(
    (state) => (state as typeof state & AgentVisualState).completedStrokeIds ?? EMPTY_IDS
  )
  const pageId = useApp((state) => state.pageId)
  const persistedDoc = useApp((state) => state.doc)
  const zoom = useApp((state) => state.viewport.zoom)
  const pagePreview = preview?.pageId === pageId ? preview : null
  const liveOnCurrentPage = !!liveDoc && (!livePageId || livePageId === pageId)
  const visibleDoc = liveOnCurrentPage && liveDoc ? liveDoc : pagePreview?.after ?? persistedDoc
  const beforeDoc = pagePreview?.before ?? persistedDoc

  const activeElements = new Set(liveOnCurrentPage ? activeElementIds : EMPTY_IDS)
  const completedElements = new Set(liveOnCurrentPage ? completedElementIds : EMPTY_IDS)
  const activeStrokes = new Set(liveOnCurrentPage ? activeStrokeIds : EMPTY_IDS)
  const completedStrokes = new Set(liveOnCurrentPage ? completedStrokeIds : EMPTY_IDS)

  // The legacy one-shot preview does not publish workflow targets. Preserve its
  // changed/created feedback once the incremental run has finished.
  const usePreviewFallback =
    !running &&
    activeElements.size === 0 &&
    completedElements.size === 0 &&
    activeStrokes.size === 0 &&
    completedStrokes.size === 0 &&
    !!pagePreview
  const changedElements = new Set(usePreviewFallback ? pagePreview.changedElementIds : EMPTY_IDS)
  const createdElements = new Set(usePreviewFallback ? pagePreview.createdElementIds : EMPTY_IDS)
  const previewStrokes = new Set(usePreviewFallback ? pagePreview.changedStrokeIds : EMPTY_IDS)

  const visibleById = new Map(visibleDoc.elements.map((element) => [element.id, element]))
  const beforeById = new Map(beforeDoc.elements.map((element) => [element.id, element]))
  const highlightedIds = new Set([
    ...activeElements,
    ...completedElements,
    ...changedElements,
    ...createdElements,
  ])
  const elementHighlights: ElementHighlight[] = []
  for (const id of highlightedIds) {
    const element = visibleById.get(id) ?? beforeById.get(id)
    if (!element) continue
    const kind: ElementHighlightKind = activeElements.has(id)
      ? 'active'
      : completedElements.has(id)
        ? 'completed'
        : createdElements.has(id)
          ? 'created'
          : 'changed'
    elementHighlights.push({ element, before: beforeById.get(id), kind })
  }

  const visibleStrokes = new Map(visibleDoc.strokes.map((stroke) => [stroke.id, stroke]))
  const beforeStrokes = new Map(beforeDoc.strokes.map((stroke) => [stroke.id, stroke]))
  const highlightedStrokeIds = new Set([
    ...activeStrokes,
    ...completedStrokes,
    ...previewStrokes,
  ])

  if (elementHighlights.length === 0 && highlightedStrokeIds.size === 0) return null

  return (
    <>
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute left-0 top-0 overflow-visible"
        style={{ width: 1, height: 1, zIndex: PREVIEW_Z }}
      >
        {elementHighlights.map(({ element, before, kind }) => {
          if (
            !before ||
            kind === 'created' ||
            (before.x === element.x && before.y === element.y)
          ) {
            return null
          }
          return (
            <line
              key={`move-${element.id}`}
              x1={before.x + before.w / 2}
              y1={before.y + before.h / 2}
              x2={element.x + element.w / 2}
              y2={element.y + element.h / 2}
              stroke={
                kind === 'active'
                  ? '#d97706'
                  : kind === 'completed'
                    ? '#059669'
                    : 'var(--ink-accent)'
              }
              strokeWidth={1.5 / zoom}
              strokeDasharray={`${7 / zoom} ${5 / zoom}`}
              opacity={kind === 'active' ? 0.85 : 0.45}
            />
          )
        })}
        {[...highlightedStrokeIds].map((id) => {
          const stroke = visibleStrokes.get(id) ?? beforeStrokes.get(id)
          if (!stroke) return null
          const active = activeStrokes.has(id)
          const completed = completedStrokes.has(id)
          return (
            <path
              key={`stroke-${id}`}
              data-agent-stroke-state={active ? 'active' : completed ? 'completed' : 'changed'}
              d={strokeToPath(stroke)}
              fill={active ? '#d97706' : completed ? '#059669' : 'var(--ink-accent)'}
              stroke={active ? '#f59e0b' : completed ? '#10b981' : 'var(--ink-accent)'}
              strokeWidth={(active ? 3 : 2) / zoom}
              opacity={active ? 0.52 : 0.28}
            />
          )
        })}
      </svg>

      {elementHighlights.map(({ element, kind }) => {
        const style = highlightStyle(kind, zoom)
        return (
          <div key={`highlight-${element.id}`}>
            <div
              aria-hidden="true"
              data-agent-element-state={kind}
              className={`pointer-events-none absolute border-dashed ${kind === 'active' ? 'animate-pulse' : ''}`}
              style={{
                left: element.x,
                top: element.y,
                width: element.w,
                height: element.h,
                transform: `rotate(${element.rotation || 0}deg)`,
                transformOrigin: 'center',
                zIndex: PREVIEW_Z,
                borderColor: style.border,
                borderWidth: style.borderWidth,
                background: style.background,
                boxShadow: style.boxShadow,
                borderRadius: 4 / zoom,
              }}
            />
            <span
              className="pointer-events-none absolute whitespace-nowrap font-medium text-white shadow-sm"
              style={{
                left: element.x,
                top: element.y - 25 / zoom,
                zIndex: PREVIEW_Z + 1,
                maxWidth: Math.max(element.w, 180 / zoom),
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                fontSize: 10.5 / zoom,
                lineHeight: `${16 / zoom}px`,
                padding: `${1.5 / zoom}px ${6 / zoom}px`,
                borderRadius: 4 / zoom,
                background: style.label,
              }}
            >
              {highlightLabel(kind)} · {previewLabel(element)}
            </span>
          </div>
        )
      })}
    </>
  )
}

export function AgentPreviewBar() {
  const preview = useCanvasAgent((state) => state.preview)
  const running = useCanvasAgent((state) => state.running)
  const pageId = useApp((state) => state.pageId)
  if (running || !preview || preview.pageId !== pageId) return null

  return (
    <div className="absolute left-1/2 top-3 z-50 flex max-w-[calc(100%-120px)] -translate-x-1/2 items-center gap-2 rounded-lg border border-[var(--ink-accent)]/40 bg-[var(--ink-panel)]/95 px-2.5 py-1.5 shadow-panel backdrop-blur">
      <Sparkles size={14} className="shrink-0 text-[var(--ink-accent)]" />
      <span className="min-w-0 truncate text-[12px] font-medium">{preview.summary}</span>
      <span className="flex shrink-0 items-center gap-1 text-[11px] text-emerald-600">
        <Check size={12} /> 已保存到工作稿
      </span>
    </div>
  )
}

function highlightStyle(kind: ElementHighlightKind, zoom: number) {
  if (kind === 'active') {
    return {
      border: '#d97706',
      borderWidth: 2.5 / zoom,
      background: 'rgba(245, 158, 11, .10)',
      boxShadow: `0 0 0 ${3 / zoom}px rgba(245, 158, 11, .16)`,
      label: '#b45309',
    }
  }
  if (kind === 'completed' || kind === 'created') {
    return {
      border: kind === 'completed' ? 'rgba(5, 150, 105, .64)' : '#059669',
      borderWidth: (kind === 'completed' ? 1.5 : 2) / zoom,
      background: kind === 'completed' ? 'rgba(16, 185, 129, .045)' : 'rgba(16, 185, 129, .09)',
      boxShadow: 'none',
      label: kind === 'completed' ? 'rgba(5, 150, 105, .88)' : '#047857',
    }
  }
  return {
    border: 'var(--ink-accent)',
    borderWidth: 2 / zoom,
    background: 'color-mix(in srgb, var(--ink-accent) 9%, transparent)',
    boxShadow: 'none',
    label: 'var(--ink-accent)',
  }
}

function highlightLabel(kind: ElementHighlightKind) {
  if (kind === 'active') return 'Agent 正在修改'
  if (kind === 'completed') return 'Agent 已完成'
  if (kind === 'created') return '新增'
  return '调整'
}

function previewLabel(element: CanvasElement) {
  if (element.type === 'text' || element.type === 'sticky') {
    const text = element.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    return text.slice(0, 24) || (element.type === 'text' ? '文本' : '便签')
  }
  if (element.type === 'shape') return element.label || element.shape
  if (element.type === 'image') return element.alt || '图片'
  if (element.type === 'pdf') return element.filename
  if (element.type === 'code') return '代码'
  if (element.type === 'math') return '公式'
  return element.filename
}
