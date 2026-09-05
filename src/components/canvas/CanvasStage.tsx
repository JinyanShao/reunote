import { memo, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { useApp, newElementId, newStrokeId, type Viewport } from '../../lib/store'
import type { CanvasDoc, CanvasElement, ShapeKind, Stroke, Tool } from '../../lib/types'
import {
  HANDLES,
  boundsOf,
  computeSnap,
  pointInRect,
  rectsIntersect,
  resizeRect,
  screenToWorld,
  type Guide,
  type Handle,
  type Rect,
} from '../../lib/geometry'
import { pointInPolygon, strokeBounds, strokeHitsCircle, strokeToPath } from '../../lib/ink'
import { adaptInkColor, clamp, uid } from '../../lib/utils'
import { useIsDark } from '../../lib/useIsDark'
import { useCanvasAgent } from '../../lib/agent/store'
import { ElementView } from './ElementView'
import { ElementToolbar } from './ElementToolbar'
import { StrokeToolbar } from './StrokeToolbar'
import { AgentPreviewBar, AgentPreviewWorld } from './AgentPreviewOverlay'

const GRID = 24
const MIN_ZOOM = 0.15
const MAX_ZOOM = 6
/** 框选、参考线、选中框、进行中笔迹等浮层的 z-index，必须压过所有内容元素 */
const OVERLAY_Z = 1_000_000

function isAgentContentLocked() {
  const state = useCanvasAgent.getState()
  return state.running || state.finalizing
}

type DragState =
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number }
  | { kind: 'marquee'; a: { x: number; y: number }; b: { x: number; y: number }; additive: boolean }
  | {
      kind: 'move'
      ids: string[]
      start: { x: number; y: number }
      dx: number
      dy: number
      guides: Guide[]
      moved: boolean
    }
  | {
      kind: 'resize'
      id: string
      handle: Handle
      base: Rect
      start: { x: number; y: number }
      rect: Rect
      ratio: boolean
    }
  | { kind: 'ink'; points: number[][]; tool: 'pen' | 'highlighter'; color: string; size: number }
  | { kind: 'erase'; hit: Set<string>; x: number; y: number }
  | { kind: 'lasso'; points: number[][] }
  | { kind: 'shape'; shape: ShapeKind; a: { x: number; y: number }; b: { x: number; y: number } }
  | null

const StrokeView = memo(function StrokeView({
  stroke,
  selectedZoom,
  erasePreview,
  isDark,
}: {
  stroke: Stroke
  selectedZoom?: number
  erasePreview: boolean
  isDark: boolean
}) {
  const path = useMemo(() => strokeToPath(stroke), [stroke])
  const selected = selectedZoom !== undefined

  return (
    <svg
      className="absolute left-0 top-0"
      style={{
        width: 1,
        height: 1,
        overflow: 'visible',
        pointerEvents: 'none',
        zIndex: stroke.z,
      }}
    >
      <path
        d={path}
        fill={stroke.tool === 'highlighter' ? stroke.color : adaptInkColor(stroke.color, isDark)}
        className={stroke.tool === 'highlighter' ? 'ink-highlighter' : undefined}
        opacity={erasePreview ? 0.18 : stroke.tool === 'highlighter' ? 0.42 : 1}
        style={{
          stroke: selected ? 'var(--ink-accent)' : undefined,
          strokeWidth: selected ? 1.5 / (selectedZoom ?? 1) : undefined,
        }}
      />
    </svg>
  )
})

export function CanvasStage() {
  const hostRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState>(null)
  const spaceRef = useRef(false)
  const rafRef = useRef(0)
  const viewportRafRef = useRef(0)
  const pendingViewportRef = useRef<{ pageId: string | null; viewport: Viewport } | null>(null)
  const [, tick] = useReducer((x: number) => x + 1, 0)
  const cursorRef = useRef<{ x: number; y: number } | null>(null)

  const doc = useApp((s) => s.doc)
  const viewport = useApp((s) => s.viewport)
  const tool = useApp((s) => s.tool)
  const selection = useApp((s) => s.selection)
  const strokeSelection = useApp((s) => s.strokeSelection)
  const editingId = useApp((s) => s.editingId)
  const settings = useApp((s) => s.settings)
  const pageId = useApp((s) => s.pageId)
  const rev = useApp((s) => s.rev)
  const agentRunning = useCanvasAgent((s) => s.running)
  const agentFinalizing = useCanvasAgent((s) => s.finalizing)
  const agentPreview = useCanvasAgent((s) => s.preview)
  const agentLiveDoc = useCanvasAgent(
    (s) => (s as typeof s & { liveDoc?: CanvasDoc | null }).liveDoc ?? null
  )
  const agentLivePageId = useCanvasAgent(
    (s) => (s as typeof s & { livePageId?: string | null }).livePageId ?? null
  )
  const isDark = useIsDark()
  const store = useApp

  const pagePreview = agentPreview?.pageId === pageId ? agentPreview : null
  const liveOnCurrentPage = !!agentLiveDoc && (!agentLivePageId || agentLivePageId === pageId)
  const renderDoc = liveOnCurrentPage ? agentLiveDoc : pagePreview?.after ?? doc
  const agentContentLocked = agentRunning || agentFinalizing

  useEffect(() => {
    if (!agentContentLocked && pagePreview && rev > pagePreview.baseRev + 1) {
      useCanvasAgent.getState().clearPreview()
    }
  }, [agentContentLocked, pagePreview, rev])

  const schedule = useCallback(() => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      tick()
    })
  }, [])

  const cancelQueuedViewport = useCallback(() => {
    if (viewportRafRef.current) cancelAnimationFrame(viewportRafRef.current)
    viewportRafRef.current = 0
    pendingViewportRef.current = null
  }, [])

  const flushQueuedViewport = useCallback(() => {
    if (viewportRafRef.current) cancelAnimationFrame(viewportRafRef.current)
    viewportRafRef.current = 0
    const pending = pendingViewportRef.current
    pendingViewportRef.current = null
    const current = store.getState()
    if (pending && current.pageId === pending.pageId) current.setViewport(pending.viewport)
  }, [store])

  const queueViewport = useCallback(
    (update: (current: Viewport) => Viewport) => {
      const state = store.getState()
      const pending = pendingViewportRef.current
      const current = pending?.pageId === state.pageId ? pending.viewport : state.viewport
      pendingViewportRef.current = { pageId: state.pageId, viewport: update(current) }
      if (viewportRafRef.current) return
      viewportRafRef.current = requestAnimationFrame(() => {
        viewportRafRef.current = 0
        const nextPending = pendingViewportRef.current
        pendingViewportRef.current = null
        const nextState = store.getState()
        if (nextPending && nextState.pageId === nextPending.pageId) {
          nextState.setViewport(nextPending.viewport)
        }
      })
    },
    [store]
  )

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      cancelQueuedViewport()
    }
  }, [cancelQueuedViewport])

  useEffect(() => {
    return cancelQueuedViewport
  }, [cancelQueuedViewport, pageId])

  useEffect(() => {
    if (!agentContentLocked) return
    dragRef.current = null
    cursorRef.current = null
    const current = store.getState()
    if (current.editingId) current.setEditing(null)
    schedule()
  }, [agentContentLocked, schedule, store])

  const toWorld = useCallback(
    (clientX: number, clientY: number) => {
      const r = hostRef.current?.getBoundingClientRect()
      const vp = store.getState().viewport
      return screenToWorld((clientX - (r?.left ?? 0)), (clientY - (r?.top ?? 0)), vp)
    },
    [store]
  )

  // ───────── 缩放 / 平移 ─────────

  const zoomAt = useCallback(
    (factor: number, clientX?: number, clientY?: number) => {
      cancelQueuedViewport()
      const r = hostRef.current?.getBoundingClientRect()
      const vp = store.getState().viewport
      const cx = (clientX ?? (r ? r.left + r.width / 2 : 0)) - (r?.left ?? 0)
      const cy = (clientY ?? (r ? r.top + r.height / 2 : 0)) - (r?.top ?? 0)
      const next = clamp(vp.zoom * factor, MIN_ZOOM, MAX_ZOOM)
      const k = next / vp.zoom
      store.getState().setViewport({
        zoom: next,
        x: cx - (cx - vp.x) * k,
        y: cy - (cy - vp.y) * k,
      })
    },
    [cancelQueuedViewport, store]
  )

  const fitToContent = useCallback(() => {
    cancelQueuedViewport()
    const s = store.getState()
    const host = hostRef.current
    if (!host) return
    const elBounds = boundsOf(renderDoc.elements)
    const inkRects = renderDoc.strokes.map(strokeBounds)
    let r: Rect | null = elBounds
    for (const b of inkRects) {
      if (!r) r = b
      else {
        const x = Math.min(r.x, b.x)
        const y = Math.min(r.y, b.y)
        const mx = Math.max(r.x + r.w, b.x + b.w)
        const my = Math.max(r.y + r.h, b.y + b.h)
        r = { x, y, w: mx - x, h: my - y }
      }
    }
    if (!r || r.w <= 0 || r.h <= 0) {
      s.setViewport({ x: 60, y: 60, zoom: 1 })
      return
    }
    const pad = 60
    const zoom = clamp(
      Math.min((host.clientWidth - pad * 2) / r.w, (host.clientHeight - pad * 2) / r.h),
      MIN_ZOOM,
      2
    )
    s.setViewport({
      zoom,
      x: host.clientWidth / 2 - (r.x + r.w / 2) * zoom,
      y: host.clientHeight / 2 - (r.y + r.h / 2) * zoom,
    })
  }, [cancelQueuedViewport, renderDoc, store])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) {
        const r = hostRef.current?.getBoundingClientRect()
        const cx = e.clientX - (r?.left ?? 0)
        const cy = e.clientY - (r?.top ?? 0)
        const factor = Math.exp(-e.deltaY * 0.01)
        queueViewport((vp) => {
          const next = clamp(vp.zoom * factor, MIN_ZOOM, MAX_ZOOM)
          const k = next / vp.zoom
          return {
            zoom: next,
            x: cx - (cx - vp.x) * k,
            y: cy - (cy - vp.y) * k,
          }
        })
      } else {
        queueViewport((vp) => ({ ...vp, x: vp.x - e.deltaX, y: vp.y - e.deltaY }))
      }
    }
    host.addEventListener('wheel', onWheel, { passive: false })
    return () => host.removeEventListener('wheel', onWheel)
  }, [queueViewport])

  // ───────── 元素工具 ─────────

  const makeText = useCallback(
    (x: number, y: number, html = '<p></p>') => {
      const el: CanvasElement = {
        id: newElementId(),
        type: 'text',
        x: Math.round(x),
        y: Math.round(y),
        w: 380,
        h: 90,
        rotation: 0,
        z: 0,
        html,
        bg: 'transparent',
        border: 'transparent',
        fontFamily: 'sans',
        fontScale: 1,
        padding: 10,
      }
      store.getState().addElement(el)
      store.getState().setTool('select')
      store.getState().setEditing(el.id)
      return el
    },
    [store]
  )

  const makeSticky = useCallback(
    (x: number, y: number) => {
      const el: CanvasElement = {
        id: newElementId(),
        type: 'sticky',
        x: Math.round(x),
        y: Math.round(y),
        w: 210,
        h: 170,
        rotation: 0,
        z: 0,
        html: '<p></p>',
        color: '#FEF3C7',
      }
      store.getState().addElement(el)
      store.getState().setTool('select')
      store.getState().setEditing(el.id)
    },
    [store]
  )

  // ───────── 指针交互 ─────────

  const beginElementDrag = useCallback(
    (e: React.PointerEvent, el: CanvasElement) => {
      if (isAgentContentLocked()) return
      // 正在编辑本元素：让事件留在编辑器内部，别冒泡到画布
      if (store.getState().editingId === el.id) {
        e.stopPropagation()
        return
      }
      const t = store.getState().tool
      if (t !== 'select') return
      e.stopPropagation()
      // 点到别的元素时退出上一个编辑态
      if (store.getState().editingId) store.getState().setEditing(null)
      if (el.locked) return

      const cur = store.getState().selection
      let ids = cur
      if (e.shiftKey) {
        ids = cur.includes(el.id) ? cur.filter((i) => i !== el.id) : cur.concat([el.id])
        store.getState().setSelection(ids)
        return
      }
      if (!cur.includes(el.id)) {
        ids = [el.id]
        store.getState().setSelection(ids)
      }
      flushQueuedViewport()
      const p = toWorld(e.clientX, e.clientY)
      dragRef.current = { kind: 'move', ids, start: p, dx: 0, dy: 0, guides: [], moved: false }
      schedule()
    },
    [flushQueuedViewport, store, toWorld, schedule]
  )

  const beginResize = useCallback(
    (e: React.PointerEvent, handle: Handle) => {
      if (isAgentContentLocked()) return
      e.stopPropagation()
      const s = store.getState()
      if (s.selection.length !== 1) return
      const el = s.doc.elements.find((x) => x.id === s.selection[0])
      if (!el || el.locked) return
      flushQueuedViewport()
      const base: Rect = { x: el.x, y: el.y, w: el.w, h: el.h }
      dragRef.current = {
        kind: 'resize',
        id: el.id,
        handle,
        base,
        start: toWorld(e.clientX, e.clientY),
        rect: base,
        ratio: el.type === 'image' || el.type === 'pdf',
      }
      schedule()
    },
    [flushQueuedViewport, store, toWorld, schedule]
  )

  const onStagePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button === 2) return
      const s = store.getState()
      const t = s.tool

      const wantPan = t === 'hand' || spaceRef.current || e.button === 1
      if (wantPan) {
        if (s.editingId) s.setEditing(null)
        flushQueuedViewport()
        const vp = store.getState().viewport
        dragRef.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: vp.x, vy: vp.y }
        schedule()
        return
      }

      if (isAgentContentLocked()) return
      if (s.editingId) s.setEditing(null)
      flushQueuedViewport()
      const p = toWorld(e.clientX, e.clientY)

      switch (t) {
        case 'text':
          makeText(p.x, p.y)
          return
        case 'sticky':
          makeSticky(p.x, p.y)
          return
        case 'pen':
        case 'highlighter': {
          const isPen = t === 'pen'
          dragRef.current = {
            kind: 'ink',
            tool: isPen ? 'pen' : 'highlighter',
            color: isPen ? s.settings.penColor : s.settings.highlighterColor,
            size: isPen ? s.settings.penSize : s.settings.highlighterSize,
            points: [[p.x, p.y, pressureOf(e)]],
          }
          schedule()
          return
        }
        case 'eraser':
          dragRef.current = { kind: 'erase', hit: new Set(), x: p.x, y: p.y }
          eraseAt(p.x, p.y)
          schedule()
          return
        case 'lasso':
          dragRef.current = { kind: 'lasso', points: [[p.x, p.y]] }
          schedule()
          return
        case 'rect':
        case 'ellipse':
        case 'diamond':
        case 'line':
        case 'arrow':
          dragRef.current = { kind: 'shape', shape: t as ShapeKind, a: p, b: p }
          schedule()
          return
        default:
          break
      }

      // 选择工具：空白处开始框选
      if (!e.shiftKey) {
        s.setSelection([])
        s.setStrokeSelection([])
      }
      dragRef.current = { kind: 'marquee', a: p, b: p, additive: e.shiftKey }
      schedule()
    },
    [flushQueuedViewport, store, toWorld, schedule, makeText, makeSticky]
  )

  const eraseAt = useCallback(
    (x: number, y: number) => {
      if (isAgentContentLocked()) return
      const d = dragRef.current
      if (!d || d.kind !== 'erase') return
      const s = store.getState()
      const r = 12 / s.viewport.zoom + 4
      for (const st of s.doc.strokes) {
        if (!d.hit.has(st.id) && strokeHitsCircle(st, x, y, r)) d.hit.add(st.id)
      }
    },
    [store]
  )

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current
      const s = store.getState()
      if (isAgentContentLocked() && d?.kind !== 'pan') {
        dragRef.current = null
        cursorRef.current = null
        schedule()
        return
      }
      if (!d) {
        if (s.tool === 'pen' || s.tool === 'highlighter' || s.tool === 'eraser') {
          const r = hostRef.current?.getBoundingClientRect()
          if (r) {
            cursorRef.current = { x: e.clientX - r.left, y: e.clientY - r.top }
            schedule()
          }
        } else if (cursorRef.current) {
          cursorRef.current = null
          schedule()
        }
        return
      }
      if (d.kind === 'pan') {
        queueViewport((vp) => ({
          ...vp,
          x: d.vx + (e.clientX - d.sx),
          y: d.vy + (e.clientY - d.sy),
        }))
        return
      }

      const p = toWorld(e.clientX, e.clientY)

      switch (d.kind) {
        case 'marquee':
          d.b = p
          break
        case 'move': {
          let dx = p.x - d.start.x
          let dy = p.y - d.start.y
          if (e.shiftKey) {
            if (Math.abs(dx) > Math.abs(dy)) dy = 0
            else dx = 0
          }
          d.guides = []
          if (s.settings.snapEnabled && !e.altKey) {
            const moving = boundsOf(s.doc.elements.filter((el) => d.ids.includes(el.id)))
            if (moving) {
              const shifted: Rect = { ...moving, x: moving.x + dx, y: moving.y + dy }
              const others = s.doc.elements
                .filter((el) => !d.ids.includes(el.id))
                .map((el) => ({ x: el.x, y: el.y, w: el.w, h: el.h }))
              const snap = computeSnap(shifted, others, s.viewport.zoom)
              dx += snap.dx
              dy += snap.dy
              d.guides = snap.guides
            }
          }
          d.dx = dx
          d.dy = dy
          if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) d.moved = true
          break
        }
        case 'resize':
          d.rect = resizeRect(
            d.base,
            d.handle,
            p.x - d.start.x,
            p.y - d.start.y,
            d.ratio || e.shiftKey
          )
          break
        case 'ink': {
          const last = d.points[d.points.length - 1]
          if (Math.hypot(p.x - last[0], p.y - last[1]) > 0.6 / s.viewport.zoom) {
            d.points.push([p.x, p.y, pressureOf(e)])
          }
          break
        }
        case 'erase':
          d.x = p.x
          d.y = p.y
          eraseAt(p.x, p.y)
          break
        case 'lasso':
          d.points.push([p.x, p.y])
          break
        case 'shape':
          d.b = p
          break
      }
      schedule()
    }

    const onUp = (e: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      const s = store.getState()
      dragRef.current = null
      if (isAgentContentLocked() && d.kind !== 'pan') {
        schedule()
        return
      }

      switch (d.kind) {
        case 'pan': {
          if (e.type !== 'pointercancel') {
            queueViewport((vp) => ({
              ...vp,
              x: d.vx + (e.clientX - d.sx),
              y: d.vy + (e.clientY - d.sy),
            }))
          }
          flushQueuedViewport()
          break
        }
        case 'marquee': {
          const r: Rect = {
            x: Math.min(d.a.x, d.b.x),
            y: Math.min(d.a.y, d.b.y),
            w: Math.abs(d.b.x - d.a.x),
            h: Math.abs(d.b.y - d.a.y),
          }
          if (r.w < 3 && r.h < 3) break
          const ids = s.doc.elements
            .filter((el) => rectsIntersect(r, { x: el.x, y: el.y, w: el.w, h: el.h }))
            .map((el) => el.id)
          const strokeIds = s.doc.strokes
            .filter((st) => rectsIntersect(r, strokeBounds(st)))
            .map((st) => st.id)
          if (ids.length > 0) s.setSelection(d.additive ? s.selection.concat(ids) : ids)
          else if (strokeIds.length > 0) s.setStrokeSelection(strokeIds)
          break
        }
        case 'move': {
          if (!d.moved) break
          const { dx, dy } = d
          s.updateDoc((doc0) => {
            for (const el of doc0.elements) {
              if (d.ids.includes(el.id)) {
                el.x = Math.round(el.x + dx)
                el.y = Math.round(el.y + dy)
              }
            }
          })
          break
        }
        case 'resize': {
          const r = d.rect
          s.patchElement(d.id, {
            x: Math.round(r.x),
            y: Math.round(r.y),
            w: Math.round(r.w),
            h: Math.round(r.h),
          })
          break
        }
        case 'ink': {
          if (d.points.length < 2) break
          const st: Stroke = {
            id: newStrokeId(),
            points: d.points,
            color: d.color,
            size: d.size,
            tool: d.tool,
            z: 0,
          }
          s.addStroke(st)
          break
        }
        case 'erase':
          if (d.hit.size > 0) s.removeStrokes([...d.hit])
          break
        case 'lasso': {
          if (d.points.length < 3) break
          const ids = s.doc.strokes
            .filter((st) => st.points.some((p) => pointInPolygon(p[0], p[1], d.points)))
            .map((st) => st.id)
          const elIds = s.doc.elements
            .filter((el) => pointInPolygon(el.x + el.w / 2, el.y + el.h / 2, d.points))
            .map((el) => el.id)
          // 两个 setter 会互相清空，先设笔迹再设元素等于把笔迹选区丢掉。
          // 套索的语义以墨迹为主，命中笔迹时就只选笔迹。
          if (ids.length > 0) s.setStrokeSelection(ids)
          else if (elIds.length > 0) s.setSelection(elIds)
          s.setTool('select')
          break
        }
        case 'shape': {
          const x = Math.min(d.a.x, d.b.x)
          const y = Math.min(d.a.y, d.b.y)
          const w = Math.abs(d.b.x - d.a.x)
          const h = Math.abs(d.b.y - d.a.y)
          if (w < 6 && h < 6) break
          const el: CanvasElement = {
            id: newElementId(),
            type: 'shape',
            x: Math.round(x),
            y: Math.round(y),
            w: Math.round(Math.max(w, 12)),
            h: Math.round(Math.max(h, 12)),
            rotation: 0,
            z: 0,
            shape: d.shape,
            stroke: s.settings.penColor,
            fill: 'transparent',
            strokeWidth: 2,
            dashed: false,
          }
          s.addElement(el)
          if (!e.altKey) s.setTool('select')
          break
        }
      }
      schedule()
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [eraseAt, flushQueuedViewport, queueViewport, schedule, store, toWorld])

  // ───────── 键盘 ─────────

  useEffect(() => {
    const isTyping = () => {
      const a = document.activeElement as HTMLElement | null
      return !!a && (a.isContentEditable || a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')
    }
    const onDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isTyping()) {
        spaceRef.current = true
        return
      }
      if (isTyping()) return
      const s = store.getState()
      const mod = e.metaKey || e.ctrlKey

      if (isAgentContentLocked()) {
        if (e.key === 'Escape') {
          s.setSelection([])
          s.setStrokeSelection([])
          s.setEditing(null)
        } else if (!mod && !e.altKey && e.key.toLowerCase() === 'h') {
          e.preventDefault()
          s.setTool('hand')
        }
        return
      }

      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        s.setSelection(s.doc.elements.map((el) => el.id))
        return
      }
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'd' && s.selection.length > 0) {
        e.preventDefault()
        duplicateSelection()
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (s.selection.length > 0) {
          e.preventDefault()
          s.removeElements(s.selection)
        } else if (s.strokeSelection.length > 0) {
          e.preventDefault()
          s.removeStrokes(s.strokeSelection)
        }
        return
      }
      if (e.key === 'Escape') {
        s.setSelection([])
        s.setStrokeSelection([])
        s.setEditing(null)
        if (s.tool !== 'select') s.setTool('select')
        return
      }
      if (!mod && !e.altKey) {
        const map: Record<string, Tool> = {
          v: 'select',
          h: 'hand',
          t: 'text',
          n: 'sticky',
          p: 'pen',
          m: 'highlighter',
          e: 'eraser',
          l: 'lasso',
          r: 'rect',
          o: 'ellipse',
          a: 'arrow',
        }
        const next = map[e.key.toLowerCase()]
        if (next) {
          e.preventDefault()
          s.setTool(next)
          return
        }
      }
      if (s.selection.length > 0 && e.key.indexOf('Arrow') === 0) {
        e.preventDefault()
        const step = e.shiftKey ? 10 : 1
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
        // 键盘自动重复会以 ~30 次/秒触发；每次都记历史的话，
        // 120 步的撤销栈几秒内就会被 1px 位移填满，把真实操作全挤出去。
        // 只有第一次按下记录快照，连按期间合并为同一条历史。
        s.updateDoc((doc0) => {
          for (const el of doc0.elements) {
            if (s.selection.includes(el.id)) {
              el.x += dx
              el.y += dy
            }
          }
        }, !e.repeat)
      }
    }
    const onUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceRef.current = false
    }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store])

  const duplicateSelection = useCallback(() => {
    if (isAgentContentLocked()) return
    const s = store.getState()
    const copies: CanvasElement[] = s.doc.elements
      .filter((el) => s.selection.includes(el.id))
      .map((el) => ({ ...el, id: newElementId(), x: el.x + 24, y: el.y + 24 }) as CanvasElement)
    if (copies.length === 0) return
    s.updateDoc((d) => {
      let z = 0
      for (const el of d.elements) z = Math.max(z, el.z)
      copies.forEach((c, i) => d.elements.push({ ...c, z: z + i + 1 }))
    })
    s.setSelection(copies.map((c) => c.id))
  }, [store])

  // 公式编辑事件
  useEffect(() => {
    const onMath = (e: Event) => {
      if (isAgentContentLocked()) return
      const detail = (e as CustomEvent<{ id: string; latex: string }>).detail
      store.getState().patchElement(detail.id, { latex: detail.latex } as never, false)
    }
    window.addEventListener('jinyan-notes:math', onMath)
    return () => window.removeEventListener('jinyan-notes:math', onMath)
  }, [store])

  // 外部命令
  useEffect(() => {
    const onCmdEvent = (e: Event) => {
      const cmd = (
        e as CustomEvent<{
          type: string
          factor?: number
          zoom?: number
          text?: string
          latex?: string
          id?: string
          ids?: string[]
        }>
      ).detail
      const contentLocked = isAgentContentLocked()
      switch (cmd.type) {
        case 'zoom':
          zoomAt(cmd.factor ?? 1.2)
          break
        case 'zoom-reset':
          cancelQueuedViewport()
          store.getState().setViewport({ ...store.getState().viewport, zoom: 1 })
          break
        case 'zoom-fit':
          fitToContent()
          break
        case 'reveal-element': {
          const state = store.getState()
          const element = state.doc.elements.find((candidate) => candidate.id === cmd.id)
          const host = hostRef.current
          if (!element || !host) break
          cancelQueuedViewport()
          state.setTool('select')
          state.setSelection([element.id])
          state.setStrokeSelection([])
          state.setEditing(null)
          state.setViewport({
            zoom: state.viewport.zoom,
            x: host.clientWidth / 2 - (element.x + element.w / 2) * state.viewport.zoom,
            y: host.clientHeight / 2 - (element.y + element.h / 2) * state.viewport.zoom,
          })
          break
        }
        case 'reveal-elements': {
          const state = store.getState()
          const requested = new Set(cmd.ids ?? [])
          const elements = state.doc.elements.filter((candidate) => requested.has(candidate.id))
          const host = hostRef.current
          const bounds = boundsOf(elements)
          if (!bounds || !host || host.clientWidth <= 0 || host.clientHeight <= 0) break
          cancelQueuedViewport()
          const pad = 72
          const zoom = clamp(
            Math.min(
              Math.max(1, host.clientWidth - pad * 2) / Math.max(1, bounds.w),
              Math.max(1, host.clientHeight - pad * 2) / Math.max(1, bounds.h)
            ),
            MIN_ZOOM,
            1.4
          )
          state.setTool('select')
          state.setSelection(elements.map((element) => element.id))
          state.setStrokeSelection([])
          state.setEditing(null)
          state.setViewport({
            zoom,
            x: host.clientWidth / 2 - (bounds.x + bounds.w / 2) * zoom,
            y: host.clientHeight / 2 - (bounds.y + bounds.h / 2) * zoom,
          })
          break
        }
        case 'insert-text': {
          if (contentLocked) break
          const c = centerWorld()
          makeText(c.x - 190, c.y - 40)
          break
        }
        case 'insert-sticky': {
          if (contentLocked) break
          const c = centerWorld()
          makeSticky(c.x - 105, c.y - 85)
          break
        }
        case 'insert-math': {
          if (contentLocked) break
          const c = centerWorld()
          const el: CanvasElement = {
            id: newElementId(),
            type: 'math',
            x: Math.round(c.x - 150),
            y: Math.round(c.y - 45),
            w: 300,
            h: 90,
            rotation: 0,
            z: 0,
            latex: cmd.latex?.trim() || 'a^2 + b^2 = c^2',
            color: 'var(--ink-text)',
            display: true,
          }
          store.getState().addElement(el)
          store.getState().setEditing(el.id)
          break
        }
        case 'insert-code': {
          if (contentLocked) break
          const c = centerWorld()
          store.getState().addElement({
            id: newElementId(),
            type: 'code',
            x: Math.round(c.x - 220),
            y: Math.round(c.y - 80),
            w: 440,
            h: 160,
            rotation: 0,
            z: 0,
            code: '// 双击编辑代码\nconsole.log("hello")',
            language: 'javascript',
          })
          break
        }
        case 'insert-ai-text': {
          if (contentLocked) break
          const c = centerWorld()
          makeText(c.x - 190, c.y - 40, cmd.text ?? '')
          store.getState().setEditing(null)
          break
        }
        case 'select-all':
          if (contentLocked) break
          store.getState().setSelection(store.getState().doc.elements.map((el) => el.id))
          break
      }
    }
    window.addEventListener('jinyan-notes:cmd', onCmdEvent)
    return () => window.removeEventListener('jinyan-notes:cmd', onCmdEvent)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cancelQueuedViewport, zoomAt, fitToContent, makeText, makeSticky, store])

  const handleDoubleClickElement = useCallback(
    (target: CanvasElement) => {
      if (isAgentContentLocked()) return
      if (target.type === 'text' || target.type === 'sticky' || target.type === 'math')
        store.getState().setEditing(target.id)
    },
    [store]
  )

  const handleChangeHtml = useCallback(
    (id: string, html: string) => {
      if (isAgentContentLocked()) return
      store.getState().patchElement(id, { html } as never, false)
      autoGrow(id)
    },
    [store]
  )

  const handleStopEditing = useCallback(() => store.getState().setEditing(null), [store])

  const centerWorld = useCallback(() => {
    const host = hostRef.current
    const vp = store.getState().viewport
    if (!host) return { x: 0, y: 0 }
    return screenToWorld(host.clientWidth / 2, host.clientHeight / 2, vp)
  }, [store])

  // ───────── 渲染 ─────────

  const d = dragRef.current
  const moveOffset =
    d?.kind === 'move' ? { dx: d.dx, dy: d.dy, ids: new Set(d.ids) } : null
  const resizing = d?.kind === 'resize' ? d : null

  const sortedElements = useMemo(
    () => renderDoc.elements.slice().sort((a, b) => a.z - b.z),
    [renderDoc.elements]
  )
  const sortedStrokes = useMemo(
    () => renderDoc.strokes.slice().sort((a, b) => a.z - b.z),
    [renderDoc.strokes]
  )

  const selectionRect = useMemo(() => {
    if (agentContentLocked) return null
    const els = renderDoc.elements.filter((el) => selection.includes(el.id))
    const r = boundsOf(els)
    if (!r) return null
    if (moveOffset) return { ...r, x: r.x + moveOffset.dx, y: r.y + moveOffset.dy }
    if (resizing && selection.length === 1) return resizing.rect
    return r
  }, [agentContentLocked, renderDoc.elements, selection, moveOffset, resizing])

  const visibleBackground = renderDoc.background
  const bgClass =
    visibleBackground === 'grid'
      ? 'canvas-grid'
      : visibleBackground === 'dots'
        ? 'canvas-dots'
        : visibleBackground === 'lines'
          ? 'canvas-lines'
          : visibleBackground === 'staff'
            ? 'canvas-staff'
            : ''

  const inkActive = tool === 'pen' || tool === 'highlighter' || tool === 'eraser' || tool === 'lasso'
  const cursor =
    agentContentLocked
      ? tool === 'hand'
        ? 'grab'
        : 'default'
      : tool === 'hand'
      ? 'grab'
      : tool === 'text'
        ? 'text'
        : inkActive
          ? 'none'
          : tool !== 'select'
            ? 'crosshair'
            : 'default'

  const eraseSet = d?.kind === 'erase' ? d.hit : null

  return (
    <div
      ref={hostRef}
      data-canvas-stage
      onPointerDown={onStagePointerDown}
      onDoubleClick={(e) => {
        if (useCanvasAgent.getState().running) return
        if (store.getState().tool !== 'select') return
        const target = e.target as HTMLElement
        if (target.closest('[data-element-id]')) return
        const p = toWorld(e.clientX, e.clientY)
        makeText(p.x - 8, p.y - 18)
      }}
      onContextMenu={(e) => e.preventDefault()}
      style={{ cursor, background: 'var(--ink-canvas)' }}
      className="relative h-full w-full overflow-hidden no-select"
    >
      {/* 背景纹理 */}
      <div
        className={`pointer-events-none absolute inset-0 ${bgClass}`}
        style={{
          backgroundSize: `${GRID * viewport.zoom}px ${GRID * viewport.zoom}px`,
          backgroundPosition: `${viewport.x}px ${viewport.y}px`,
          opacity: viewport.zoom < 0.4 ? 0.4 : 1,
        }}
      />

      {/* 世界坐标容器 */}
      <div
        data-world="1"
        className="absolute left-0 top-0"
        style={{
          transform: `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.zoom})`,
          transformOrigin: '0 0',
          willChange: 'transform',
          width: 0,
          height: 0,
        }}
      >
        <div className={agentContentLocked ? 'pointer-events-none' : undefined}>
          {sortedElements.map((el) => (
            <ElementView
              key={el.id}
              el={el}
              selected={!agentContentLocked && selection.includes(el.id)}
              editing={!agentContentLocked && editingId === el.id}
              editingZoom={
                !agentContentLocked && editingId === el.id && el.type === 'math'
                  ? viewport.zoom
                  : undefined
              }
              offset={moveOffset && moveOffset.ids.has(el.id) ? moveOffset : undefined}
              preview={resizing && resizing.id === el.id ? resizing.rect : undefined}
              onPointerDown={beginElementDrag}
              onDoubleClick={handleDoubleClickElement}
              onChangeHtml={handleChangeHtml}
              onStopEditing={handleStopEditing}
            />
          ))}
        </div>

        {/*
          墨迹层。每条笔迹一个绝对定位的 <svg> 并带上自己的 z-index：
          元素 div 全部带 zIndex(el.z)，一个 z-index:auto 的整体 svg 会被所有元素盖住，
          「在便签 / 图片 / PDF 上批注」就完全看不见笔迹了。
          拆开后与元素共用同一套 z 序，置顶/置底对墨迹同样生效。
        */}
        {sortedStrokes.map((st) => {
          const selected = !agentContentLocked && strokeSelection.includes(st.id)
          return (
            <StrokeView
              key={st.id}
              stroke={st}
              selectedZoom={selected ? viewport.zoom : undefined}
              erasePreview={eraseSet?.has(st.id) ?? false}
              isDark={isDark}
            />
          )
        })}

        <AgentPreviewWorld />

        {/* 进行中的笔迹与套索/图形预览：永远画在最上层 */}
        <svg
          data-overlay="1"
          className="absolute left-0 top-0"
          style={{
            width: 1,
            height: 1,
            overflow: 'visible',
            pointerEvents: 'none',
            zIndex: OVERLAY_Z,
          }}
        >
          {d?.kind === 'ink' && d.points.length > 1 && (
            <path
              d={strokeToPath({ points: d.points, size: d.size, tool: d.tool })}
              fill={d.tool === 'highlighter' ? d.color : adaptInkColor(d.color, isDark)}
              className={d.tool === 'highlighter' ? 'ink-highlighter' : undefined}
              opacity={d.tool === 'highlighter' ? 0.42 : 1}
            />
          )}
          {d?.kind === 'lasso' && d.points.length > 1 && (
            <polygon
              points={d.points.map((p) => `${p[0]},${p[1]}`).join(' ')}
              fill="rgba(91,108,255,.10)"
              stroke="var(--ink-accent)"
              strokeWidth={1.2 / viewport.zoom}
              strokeDasharray={`${6 / viewport.zoom} ${4 / viewport.zoom}`}
            />
          )}
          {d?.kind === 'shape' && (
            <ShapePreview
              shape={d.shape}
              a={d.a}
              b={d.b}
              color={settings.penColor}
              zoom={viewport.zoom}
            />
          )}
        </svg>

        {/* 吸附参考线 */}
        {d?.kind === 'move' &&
          d.guides.map((g, i) => (
            <div
              key={i}
              data-overlay="1"
              className="pointer-events-none absolute bg-[#f43f5e]"
              style={
                g.axis === 'x'
                  ? {
                      left: g.at,
                      top: g.from,
                      width: 1 / viewport.zoom,
                      height: Math.max(1, g.to - g.from),
                      zIndex: OVERLAY_Z,
                    }
                  : {
                      left: g.from,
                      top: g.at,
                      height: 1 / viewport.zoom,
                      width: Math.max(1, g.to - g.from),
                      zIndex: OVERLAY_Z,
                    }
              }
            />
          ))}

        {/* 框选矩形 */}
        {d?.kind === 'marquee' && (
          <div
            data-overlay="1"
            className="pointer-events-none absolute border border-[var(--ink-accent)] bg-[var(--ink-accent)]/10"
            style={{
              left: Math.min(d.a.x, d.b.x),
              top: Math.min(d.a.y, d.b.y),
              width: Math.abs(d.b.x - d.a.x),
              height: Math.abs(d.b.y - d.a.y),
              zIndex: OVERLAY_Z,
            }}
          />
        )}

        {/* 选中框与手柄 */}
        {selectionRect && !editingId && (
          <div
            data-overlay="1"
            className="pointer-events-none absolute border border-[var(--ink-accent)]"
            style={{
              left: selectionRect.x,
              top: selectionRect.y,
              width: selectionRect.w,
              height: selectionRect.h,
              zIndex: OVERLAY_Z,
            }}
          >
            {selection.length === 1 &&
              HANDLES.map((h) => (
                <div
                  key={h.key}
                  onPointerDown={(e) => beginResize(e, h.key)}
                  className="pointer-events-auto absolute rounded-full border-2 border-[var(--ink-accent)] bg-white"
                  style={{
                    width: 9 / viewport.zoom,
                    height: 9 / viewport.zoom,
                    borderWidth: 1.5 / viewport.zoom,
                    left: `calc(${h.sx * 100}% - ${4.5 / viewport.zoom}px)`,
                    top: `calc(${h.sy * 100}% - ${4.5 / viewport.zoom}px)`,
                    cursor: h.cursor,
                  }}
                />
              ))}
          </div>
        )}
      </div>

      {/* 笔尖光标 */}
      {cursorRef.current && inkActive && !agentContentLocked && (
        <div
          className="pointer-events-none absolute rounded-full border"
          style={{
            left: cursorRef.current.x,
            top: cursorRef.current.y,
            width:
              (tool === 'eraser' ? 26 : tool === 'highlighter' ? settings.highlighterSize : settings.penSize + 4) *
              (tool === 'eraser' ? 1 : viewport.zoom),
            height:
              (tool === 'eraser' ? 26 : tool === 'highlighter' ? settings.highlighterSize : settings.penSize + 4) *
              (tool === 'eraser' ? 1 : viewport.zoom),
            transform: 'translate(-50%, -50%)',
            borderColor: tool === 'eraser' ? 'var(--ink-muted)' : 'transparent',
            background:
              tool === 'eraser'
                ? 'rgba(150,150,160,.16)'
                : tool === 'highlighter'
                  ? settings.highlighterColor
                  : adaptInkColor(settings.penColor, isDark),
            opacity: tool === 'highlighter' ? 0.5 : 1,
          }}
        />
      )}

      {/* 元素浮动工具条 */}
      {selectionRect && selection.length > 0 && !editingId && !d && !agentContentLocked && (
        <ElementToolbar
          rect={selectionRect}
          viewport={viewport}
          onDuplicate={duplicateSelection}
        />
      )}

      {/* 墨迹浮动工具条 */}
      {strokeSelection.length > 0 && !d && !agentContentLocked && (
        <StrokeToolbar viewport={viewport} />
      )}

      <AgentPreviewBar />
    </div>
  )
}

function ShapePreview({
  shape,
  a,
  b,
  color,
  zoom,
}: {
  shape: ShapeKind
  a: { x: number; y: number }
  b: { x: number; y: number }
  color: string
  zoom: number
}) {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  const w = Math.abs(b.x - a.x)
  const h = Math.abs(b.y - a.y)
  const common = { stroke: color, strokeWidth: 2, fill: 'none', opacity: 0.85 }
  void zoom
  if (shape === 'line' || shape === 'arrow')
    return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} {...common} />
  if (shape === 'ellipse')
    return <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} {...common} />
  if (shape === 'diamond')
    return (
      <polygon
        points={`${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`}
        {...common}
      />
    )
  return <rect x={x} y={y} width={w} height={h} rx={8} {...common} />
}

function pressureOf(e: PointerEvent | React.PointerEvent) {
  const p = (e as PointerEvent).pressure
  if (e.pointerType === 'pen' && p > 0) return p
  if (p > 0 && p !== 0.5) return p
  return 0.5
}

/** 文本块随内容自动增高 */
function autoGrow(id: string) {
  requestAnimationFrame(() => {
    const host = document.querySelector<HTMLElement>(`[data-element-id="${id}"]`)
    const inner = host?.querySelector<HTMLElement>('.rt')
    if (!host || !inner) return
    const wrapper = inner.parentElement
    const padding = wrapper ? parseFloat(getComputedStyle(wrapper).paddingTop) * 2 : 20
    const needed = inner.scrollHeight + padding + 4
    const cur = host.offsetHeight
    if (needed > cur + 2) {
      useApp.getState().patchElement(id, { h: Math.ceil(needed) } as never, false)
    }
  })
}

export { uid }
