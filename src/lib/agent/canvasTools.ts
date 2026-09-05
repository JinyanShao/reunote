import { z } from 'zod'
import type { Rect } from '../geometry'
import { strokeBounds } from '../ink'
import {
  embedLatexInRichTextHtml,
  normalizeAllRichTextMathHtml,
  normalizeRichTextLatex,
} from '../richTextMath'
import { clone, newElementId } from '../store'
import type {
  BackgroundKind,
  CanvasDoc,
  CanvasElement,
  MathElement,
  ShapeElement,
  StickyElement,
  TextElement,
} from '../types'
import { escapeHtml } from '../utils'
import type { CanvasAgentDraft, CanvasAgentScope, CanvasAgentToolName } from './types'

const MIN_SIZE = 40
const MAX_SIZE = 2400
const DEFAULT_GAP = 28
const FORMULA_ANCHOR_GAP = 36
const FORMULA_STACK_GAP = 18
const FORMULA_COLLISION_GAP = 16
const MAX_FORMULA_LANE_RINGS = 12
const INK_PAGE_ID = 'ink:page'
const INK_SELECTION_ID = 'ink:selection'

const idsSchema = z.array(z.string().min(1)).max(160).optional()

const arrangeSchema = z.object({
  ids: idsSchema,
  mode: z.enum(['grid', 'columns', 'rows', 'timeline']),
  columns: z.number().int().min(1).max(8).optional(),
  gap: z.number().min(8).max(180).optional(),
})

const groupLayoutSchema = z.object({
  groups: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(24),
        ids: z.array(z.string().min(1)).min(1).max(80),
      })
    )
    .min(1)
    .max(8),
  direction: z.enum(['columns', 'rows']).default('columns'),
  gap: z.number().min(12).max(180).optional(),
  addHeadings: z.boolean().default(true),
})

const alignSchema = z.object({
  ids: idsSchema,
  alignment: z.enum(['left', 'center', 'right', 'top', 'middle', 'bottom']),
})

const distributeSchema = z.object({
  ids: idsSchema,
  direction: z.enum(['horizontal', 'vertical']),
  gap: z.number().min(8).max(240).optional(),
})

const relativeSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(100),
  anchorId: z.string().min(1),
  side: z.enum(['left', 'right', 'above', 'below']),
  gap: z.number().min(8).max(320).optional(),
})

const resizeSchema = z
  .object({
    ids: idsSchema,
    width: z.number().min(MIN_SIZE).max(MAX_SIZE).optional(),
    height: z.number().min(MIN_SIZE).max(MAX_SIZE).optional(),
    scale: z.number().min(0.25).max(4).optional(),
  })
  .refine((v) => v.width !== undefined || v.height !== undefined || v.scale !== undefined, {
    message: 'width、height、scale 至少提供一项',
  })

const createSchema = z.object({
  type: z.enum(['text', 'sticky', 'shape']),
  content: z.string().trim().max(1600).default(''),
  shape: z.enum(['rect', 'ellipse', 'diamond', 'arrow', 'line', 'star']).optional(),
  x: z.number().min(-100000).max(100000).optional(),
  y: z.number().min(-100000).max(100000).optional(),
  width: z.number().min(MIN_SIZE).max(1600).optional(),
  height: z.number().min(MIN_SIZE).max(1200).optional(),
  relativeTo: z.string().min(1).optional(),
  side: z.enum(['left', 'right', 'above', 'below']).optional(),
})

const styleSchema = z.object({
  ids: idsSchema,
  background: z.string().trim().max(40).optional(),
  border: z.string().trim().max(40).optional(),
  opacity: z.number().min(0.1).max(1).optional(),
  fontScale: z.number().min(0.6).max(2.5).optional(),
})

const createMathSchema = z.object({
  latex: z.string().trim().min(1).max(4000),
  display: z.boolean().default(true),
  uncertain: z.boolean().default(false),
  x: z.number().min(-100000).max(100000).optional(),
  y: z.number().min(-100000).max(100000).optional(),
  width: z.number().min(120).max(1600).optional(),
  height: z.number().min(60).max(1200).optional(),
  relativeTo: z.string().min(1).optional(),
  sourceBlockIndex: z.number().int().min(0).max(1000).optional(),
  side: z.enum(['left', 'right', 'above', 'below']).optional(),
  placement: z.enum(['companion', 'embedded']).default('companion'),
})

const embedMathSchema = z.object({
  elementId: z.string().min(1),
  blockIndex: z.number().int().min(0).max(1000).optional(),
  contentHash: z.string().trim().min(8).max(64).optional(),
  latex: z.string().trim().min(1).max(4000),
  display: z.boolean().default(true),
  formulaId: z.string().min(1).optional(),
})

const normalizeMathSchema = z.object({
  elementId: z.string().min(1),
})

const updateMathSchema = z.object({
  id: z.string().min(1),
  latex: z.string().trim().min(1).max(4000),
  display: z.boolean().optional(),
})

const layoutMathSchema = z.object({
  ids: idsSchema,
  anchors: z.record(z.string(), z.string().min(1)).default({}),
  blockIndices: z.record(z.string(), z.number().int().min(0).max(1000)).default({}),
})

const updateTextSegmentSchema = z.object({
  elementId: z.string().min(1),
  blockIndex: z.number().int().min(0).max(1000),
  contentHash: z.string().trim().min(8).max(64),
  replacementHtml: z.string().trim().min(1).max(12_000),
})

const backgroundSchema = z.object({
  background: z.enum(['blank', 'grid', 'dots', 'lines', 'staff']),
})

interface Target {
  id: string
  rect: Rect
  locked: boolean
  move: (dx: number, dy: number) => void
  resize: (rect: Rect) => void
}

export interface ToolExecutionResult {
  draft: CanvasAgentDraft
  observation: string
  targetElementIds: string[]
  targetStrokeIds: string[]
  changedElementIds: string[]
  createdElementIds: string[]
  deletedElementIds: string[]
  changedStrokeIds: string[]
  backgroundChanged: boolean
}

interface CanvasToolMutationResult {
  draft: CanvasAgentDraft
  observation: string
}

export interface CanvasTextSegment {
  elementId: string
  blockIndex: number
  contentHash: string
  tag: string
  text: string
  html: string
}

export interface CanvasAgentToolTargets {
  elementIds: string[]
  strokeIds: string[]
}

export function createCanvasAgentDraft(
  doc: CanvasDoc,
  scope: CanvasAgentScope,
  selectedElementIds: string[],
  selectedStrokeIds: string[],
  planId: string
): CanvasAgentDraft {
  const knownElements = new Set(doc.elements.map((el) => el.id))
  const allowedElementIds =
    scope === 'page'
      ? doc.elements.map((el) => el.id)
      : selectedElementIds.filter((id) => knownElements.has(id))

  const knownStrokes = new Set(doc.strokes.map((stroke) => stroke.id))
  const strokeIds =
    scope === 'page'
      ? doc.strokes.map((stroke) => stroke.id)
      : selectedStrokeIds.filter((id) => knownStrokes.has(id))
  const inkGroups: Record<string, string[]> = {}
  if (strokeIds.length > 0) {
    inkGroups[scope === 'page' ? INK_PAGE_ID : INK_SELECTION_ID] = strokeIds
  }

  return {
    doc: clone(doc),
    allowedElementIds,
    inkGroups,
    createdElementIds: [],
    deletedElementIds: [],
    planId,
  }
}

export function draftHasTargets(draft: CanvasAgentDraft) {
  return draft.allowedElementIds.length > 0 || Object.keys(draft.inkGroups).length > 0
}

export function canvasInventory(draft: CanvasAgentDraft): string {
  const allowed = new Set(draft.allowedElementIds)
  const lines: string[] = []
  let remainingChars = 14_000
  for (const el of draft.doc.elements.filter((item) => allowed.has(item.id)).slice(0, 140)) {
    if (remainingChars <= 0) {
      lines.push('…其余对象内容已省略')
      break
    }
    const summaryLimit = el.type === 'text' || el.type === 'sticky' ? 1200 : 320
    const line =
      `${el.id} | ${el.type}${el.locked ? ' | LOCKED' : ''} | ` +
      `x=${Math.round(el.x)}, y=${Math.round(el.y)}, w=${Math.round(el.w)}, h=${Math.round(el.h)} | ` +
      (summarizeElement(el, Math.min(summaryLimit, remainingChars)) || '无文字')
    lines.push(line)
    remainingChars -= line.length
  }

  for (const [id, strokeIds] of Object.entries(draft.inkGroups)) {
    const strokes = draft.doc.strokes.filter((stroke) => strokeIds.includes(stroke.id))
    const rect = boundsOfStrokes(strokes)
    if (rect) {
      lines.push(
        `${id} | ink | x=${Math.round(rect.x)}, y=${Math.round(rect.y)}, w=${Math.round(rect.w)}, h=${Math.round(rect.h)} | ${strokes.length} 条手写笔迹`
      )
    }
  }

  const segments = canvasTextSegments(draft).slice(0, 120)
  if (segments.length > 0 && remainingChars > 0) {
    lines.push('可逐段编辑的正文段落：')
    for (const segment of segments) {
      const line =
        `segment | elementId=${segment.elementId} | blockIndex=${segment.blockIndex} | ` +
        `contentHash=${segment.contentHash} | tag=${segment.tag} | ${segment.text.slice(0, 360)}`
      if (remainingChars - line.length <= 0) {
        lines.push('…其余段落已省略')
        break
      }
      lines.push(line)
      remainingChars -= line.length
    }
  }

  return lines.join('\n') || '（作用范围内没有可操作内容）'
}

export function canvasTextSegments(draft: CanvasAgentDraft): CanvasTextSegment[] {
  if (typeof DOMParser === 'undefined') return []
  const allowed = new Set(draft.allowedElementIds)
  const segments: CanvasTextSegment[] = []
  for (const element of draft.doc.elements) {
    if (!allowed.has(element.id) || element.locked) continue
    if (element.type !== 'text' && element.type !== 'sticky') continue
    const parsed = parseTextHtml(element.html)
    textBlockElements(parsed).forEach((block, blockIndex) => {
      const html = block === parsed.body ? parsed.body.innerHTML : block.outerHTML
      segments.push({
        elementId: element.id,
        blockIndex,
        contentHash: contentHash(html),
        tag: block === parsed.body ? 'body' : block.tagName.toLowerCase(),
        text: normalizeText(block.textContent ?? ''),
        html,
      })
    })
  }
  return segments
}

export function canvasAgentToolTargets(
  draft: CanvasAgentDraft,
  tool: CanvasAgentToolName,
  rawArgs: unknown
): CanvasAgentToolTargets {
  let ids: string[] = []
  let allowLocked = false
  switch (tool) {
    case 'arrange':
      ids = requestedTargetIds(draft, arrangeSchema.parse(rawArgs).ids)
      break
    case 'group_layout':
      ids = groupLayoutSchema.parse(rawArgs).groups.flatMap((group) => group.ids)
      break
    case 'align':
      ids = requestedTargetIds(draft, alignSchema.parse(rawArgs).ids)
      break
    case 'distribute':
      ids = requestedTargetIds(draft, distributeSchema.parse(rawArgs).ids)
      break
    case 'place_relative': {
      const args = relativeSchema.parse(rawArgs)
      ids = args.ids.concat(args.anchorId)
      break
    }
    case 'resize':
      ids = requestedTargetIds(draft, resizeSchema.parse(rawArgs).ids)
      break
    case 'create': {
      const args = createSchema.parse(rawArgs)
      ids = args.relativeTo ? [args.relativeTo] : []
      break
    }
    case 'create_math': {
      const args = createMathSchema.parse(rawArgs)
      ids = args.relativeTo ? [args.relativeTo] : []
      // The source is only an anchor. A locked source may be inspected but never mutated.
      allowLocked = true
      break
    }
    case 'embed_math': {
      const args = embedMathSchema.parse(rawArgs)
      ids = [args.elementId].concat(args.formulaId ?? [])
      break
    }
    case 'normalize_math':
      ids = [normalizeMathSchema.parse(rawArgs).elementId]
      break
    case 'update_math':
      ids = [updateMathSchema.parse(rawArgs).id]
      break
    case 'layout_math': {
      const args = layoutMathSchema.parse(rawArgs)
      ids = mathTargetIds(draft, args.ids)
      break
    }
    case 'update_text_segment':
      ids = [updateTextSegmentSchema.parse(rawArgs).elementId]
      break
    case 'set_style':
      ids = requestedTargetIds(draft, styleSchema.parse(rawArgs).ids)
      break
    case 'set_background':
      backgroundSchema.parse(rawArgs)
      break
  }
  return activityTargets(draft, Array.from(new Set(ids)), allowLocked)
}

export function executeCanvasTool(
  current: CanvasAgentDraft,
  tool: CanvasAgentToolName,
  rawArgs: unknown
): ToolExecutionResult {
  const draft = clone(current)
  const targets = canvasAgentToolTargets(current, tool, rawArgs)
  let result: CanvasToolMutationResult
  switch (tool) {
    case 'arrange':
      result = arrange(draft, arrangeSchema.parse(rawArgs))
      break
    case 'group_layout':
      result = groupLayout(draft, groupLayoutSchema.parse(rawArgs))
      break
    case 'align':
      result = align(draft, alignSchema.parse(rawArgs))
      break
    case 'distribute':
      result = distribute(draft, distributeSchema.parse(rawArgs))
      break
    case 'place_relative':
      result = placeRelative(draft, relativeSchema.parse(rawArgs))
      break
    case 'resize':
      result = resize(draft, resizeSchema.parse(rawArgs))
      break
    case 'create':
      result = createElement(draft, createSchema.parse(rawArgs))
      break
    case 'create_math':
      result = createMath(draft, createMathSchema.parse(rawArgs))
      break
    case 'embed_math':
      result = embedMath(draft, embedMathSchema.parse(rawArgs))
      break
    case 'normalize_math':
      result = normalizeMath(draft, normalizeMathSchema.parse(rawArgs))
      break
    case 'update_math':
      result = updateMath(draft, updateMathSchema.parse(rawArgs))
      break
    case 'layout_math':
      result = layoutMath(draft, layoutMathSchema.parse(rawArgs))
      break
    case 'update_text_segment':
      result = updateTextSegment(draft, updateTextSegmentSchema.parse(rawArgs))
      break
    case 'set_style':
      result = setStyle(draft, styleSchema.parse(rawArgs))
      break
    case 'set_background': {
      const { background } = backgroundSchema.parse(rawArgs)
      draft.doc.background = background as BackgroundKind
      result = { draft, observation: `页面背景已设为 ${background}` }
      break
    }
  }
  const diff = diffCanvasDocs(current.doc, result.draft.doc)
  return {
    ...result,
    targetElementIds: targets.elementIds,
    targetStrokeIds: targets.strokeIds,
    ...diff,
  }
}

function arrange(draft: CanvasAgentDraft, args: z.infer<typeof arrangeSchema>): CanvasToolMutationResult {
  const targets = resolveTargets(draft, args.ids)
  requireCount(targets, 1)
  const gap = args.gap ?? DEFAULT_GAP
  const originX = Math.min(...targets.map((target) => target.rect.x))
  const originY = Math.min(...targets.map((target) => target.rect.y))
  const ordered = targets.slice().sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)

  if (args.mode === 'rows') {
    let x = originX
    for (const target of ordered) {
      target.move(x - target.rect.x, originY - target.rect.y)
      x += target.rect.w + gap
    }
  } else if (args.mode === 'timeline') {
    const maxW = Math.max(...ordered.map((target) => target.rect.w))
    let y = originY
    ordered.forEach((target, index) => {
      const x = originX + (index % 2 === 0 ? 0 : maxW + gap * 2)
      target.move(x - target.rect.x, y - target.rect.y)
      y += target.rect.h + gap
    })
  } else {
    const columns =
      args.mode === 'columns'
        ? Math.min(args.columns ?? 2, ordered.length)
        : Math.min(args.columns ?? Math.ceil(Math.sqrt(ordered.length)), ordered.length)
    const rows = Math.ceil(ordered.length / columns)
    const colWidths = Array.from({ length: columns }, () => 0)
    const rowHeights = Array.from({ length: rows }, () => 0)
    ordered.forEach((target, index) => {
      const col = index % columns
      const row = Math.floor(index / columns)
      colWidths[col] = Math.max(colWidths[col], target.rect.w)
      rowHeights[row] = Math.max(rowHeights[row], target.rect.h)
    })
    const xs = colWidths.map((_, index) =>
      originX + colWidths.slice(0, index).reduce((sum, width) => sum + width + gap, 0)
    )
    const ys = rowHeights.map((_, index) =>
      originY + rowHeights.slice(0, index).reduce((sum, height) => sum + height + gap, 0)
    )
    ordered.forEach((target, index) => {
      const col = index % columns
      const row = Math.floor(index / columns)
      target.move(xs[col] - target.rect.x, ys[row] - target.rect.y)
    })
  }

  return { draft, observation: `已用 ${args.mode} 布局重排 ${targets.length} 个对象` }
}

function groupLayout(
  draft: CanvasAgentDraft,
  args: z.infer<typeof groupLayoutSchema>
): CanvasToolMutationResult {
  const used = new Set<string>()
  const groups = args.groups.map((group) => {
    const targets = resolveTargets(draft, group.ids)
    for (const target of targets) {
      if (used.has(target.id)) throw new Error(`对象 ${target.id} 被放进了多个分组`)
      used.add(target.id)
    }
    return { title: group.title, targets }
  })
  const all = groups.flatMap((group) => group.targets)
  requireCount(all, 1)
  const gap = args.gap ?? 64
  const originX = Math.min(...all.map((target) => target.rect.x))
  const originY = Math.min(...all.map((target) => target.rect.y))
  let cursorX = originX
  let cursorY = originY
  const createdIds: string[] = []

  for (const group of groups) {
    const width = Math.max(220, ...group.targets.map((target) => target.rect.w))
    let x = cursorX
    let y = cursorY
    if (args.addHeadings) {
      const heading = makeTextElement(group.title, x, y, width, 46, draft.planId, 'heading')
      draft.doc.elements.push(heading)
      draft.allowedElementIds.push(heading.id)
      draft.createdElementIds.push(heading.id)
      createdIds.push(heading.id)
      y += 58
    }
    for (const target of group.targets) {
      target.move(x - target.rect.x, y - target.rect.y)
      y += target.rect.h + DEFAULT_GAP
    }
    if (args.direction === 'columns') cursorX += width + gap
    else cursorY = Math.max(cursorY + 100, y + gap)
  }

  return {
    draft,
    observation: `已将 ${all.length} 个对象整理为 ${groups.length} 组${createdIds.length ? `，新增 ${createdIds.length} 个标题` : ''}`,
  }
}

function align(draft: CanvasAgentDraft, args: z.infer<typeof alignSchema>): CanvasToolMutationResult {
  const targets = resolveTargets(draft, args.ids)
  requireCount(targets, 2)
  const box = boundsOfRects(targets.map((target) => target.rect))
  for (const target of targets) {
    let dx = 0
    let dy = 0
    if (args.alignment === 'left') dx = box.x - target.rect.x
    if (args.alignment === 'center') dx = box.x + box.w / 2 - (target.rect.x + target.rect.w / 2)
    if (args.alignment === 'right') dx = box.x + box.w - (target.rect.x + target.rect.w)
    if (args.alignment === 'top') dy = box.y - target.rect.y
    if (args.alignment === 'middle') dy = box.y + box.h / 2 - (target.rect.y + target.rect.h / 2)
    if (args.alignment === 'bottom') dy = box.y + box.h - (target.rect.y + target.rect.h)
    target.move(dx, dy)
  }
  return { draft, observation: `已将 ${targets.length} 个对象执行 ${args.alignment} 对齐` }
}

function distribute(
  draft: CanvasAgentDraft,
  args: z.infer<typeof distributeSchema>
): CanvasToolMutationResult {
  const targets = resolveTargets(draft, args.ids)
  requireCount(targets, 3)
  const horizontal = args.direction === 'horizontal'
  const ordered = targets
    .slice()
    .sort((a, b) => (horizontal ? a.rect.x - b.rect.x : a.rect.y - b.rect.y))
  const first = ordered[0].rect
  const last = ordered[ordered.length - 1].rect
  const occupied = ordered.reduce(
    (sum, target) => sum + (horizontal ? target.rect.w : target.rect.h),
    0
  )
  const span = horizontal ? last.x + last.w - first.x : last.y + last.h - first.y
  const gap = args.gap ?? Math.max(8, (span - occupied) / (ordered.length - 1))
  let cursor = horizontal ? first.x : first.y
  for (const target of ordered) {
    const dx = horizontal ? cursor - target.rect.x : 0
    const dy = horizontal ? 0 : cursor - target.rect.y
    target.move(dx, dy)
    cursor += (horizontal ? target.rect.w : target.rect.h) + gap
  }
  return { draft, observation: `已将 ${targets.length} 个对象${horizontal ? '横向' : '纵向'}均匀分布` }
}

function placeRelative(
  draft: CanvasAgentDraft,
  args: z.infer<typeof relativeSchema>
): CanvasToolMutationResult {
  if (args.ids.includes(args.anchorId)) throw new Error('参照对象不能同时作为移动对象')
  const moving = resolveTargets(draft, args.ids)
  const anchor = resolveTargets(draft, [args.anchorId])[0]
  const box = boundsOfRects(moving.map((target) => target.rect))
  const gap = args.gap ?? 36
  let dx = 0
  let dy = 0
  if (args.side === 'left') {
    dx = anchor.rect.x - gap - (box.x + box.w)
    dy = anchor.rect.y + anchor.rect.h / 2 - (box.y + box.h / 2)
  } else if (args.side === 'right') {
    dx = anchor.rect.x + anchor.rect.w + gap - box.x
    dy = anchor.rect.y + anchor.rect.h / 2 - (box.y + box.h / 2)
  } else if (args.side === 'above') {
    dx = anchor.rect.x + anchor.rect.w / 2 - (box.x + box.w / 2)
    dy = anchor.rect.y - gap - (box.y + box.h)
  } else {
    dx = anchor.rect.x + anchor.rect.w / 2 - (box.x + box.w / 2)
    dy = anchor.rect.y + anchor.rect.h + gap - box.y
  }
  moving.forEach((target) => target.move(dx, dy))
  return { draft, observation: `已将 ${moving.length} 个对象放到 ${args.anchorId} 的${args.side}` }
}

function resize(draft: CanvasAgentDraft, args: z.infer<typeof resizeSchema>): CanvasToolMutationResult {
  const targets = resolveTargets(draft, args.ids)
  requireCount(targets, 1)
  for (const target of targets) {
    const scale = args.scale ?? 1
    const w = clampSize(args.width ?? target.rect.w * scale)
    const h = clampSize(args.height ?? target.rect.h * scale)
    target.resize({ ...target.rect, w, h })
  }
  return { draft, observation: `已调整 ${targets.length} 个对象的尺寸` }
}

function createElement(
  draft: CanvasAgentDraft,
  args: z.infer<typeof createSchema>
): CanvasToolMutationResult {
  const allRects = draft.doc.elements.map((el) => ({ x: el.x, y: el.y, w: el.w, h: el.h }))
  const pageBounds = allRects.length ? boundsOfRects(allRects) : { x: 120, y: 120, w: 0, h: 0 }
  let x = args.x ?? pageBounds.x
  let y = args.y ?? pageBounds.y + pageBounds.h + 60
  const width = args.width ?? (args.type === 'sticky' ? 220 : 320)
  const height = args.height ?? (args.type === 'sticky' ? 170 : 130)

  if (args.relativeTo) {
    const anchor = resolveTargets(draft, [args.relativeTo])[0].rect
    const side = args.side ?? 'below'
    if (side === 'left') {
      x = anchor.x - width - 36
      y = anchor.y
    } else if (side === 'right') {
      x = anchor.x + anchor.w + 36
      y = anchor.y
    } else if (side === 'above') {
      x = anchor.x
      y = anchor.y - height - 36
    } else {
      x = anchor.x
      y = anchor.y + anchor.h + 36
    }
  }

  const zIndex = nextZ(draft.doc)
  let element: CanvasElement
  if (args.type === 'sticky') {
    element = {
      id: newElementId(),
      type: 'sticky',
      x,
      y,
      w: width,
      h: height,
      rotation: 0,
      z: zIndex,
      html: `<p>${escapeHtml(args.content || '新便签')}</p>`,
      color: '#fff3a3',
    } satisfies StickyElement
  } else if (args.type === 'shape') {
    element = {
      id: newElementId(),
      type: 'shape',
      x,
      y,
      w: width,
      h: height,
      rotation: 0,
      z: zIndex,
      shape: args.shape ?? 'rect',
      stroke: '#5b6cff',
      fill: 'transparent',
      strokeWidth: 2,
      dashed: false,
      label: args.content || undefined,
    } satisfies ShapeElement
  } else {
    element = makeTextElement(args.content || '新文本', x, y, width, height, draft.planId, 'created')
    element.z = zIndex
  }

  draft.doc.elements.push(element)
  draft.allowedElementIds.push(element.id)
  draft.createdElementIds.push(element.id)
  return { draft, observation: `已创建 ${args.type}，对象 ID 为 ${element.id}` }
}

function createMath(
  draft: CanvasAgentDraft,
  args: z.infer<typeof createMathSchema>
): CanvasToolMutationResult {
  const source = args.relativeTo
    ? draft.doc.elements.find((element) => element.id === args.relativeTo)
    : undefined
  if (
    args.placement === 'embedded' &&
    source &&
    !source.locked &&
    (source.type === 'text' || source.type === 'sticky')
  ) {
    const embedded = applyEmbeddedMath(draft, {
      elementId: source.id,
      blockIndex: args.sourceBlockIndex,
      latex: args.latex,
      display: args.display,
    })
    if (embedded) return embedded
  }

  const allRects = draft.doc.elements.map((el) => ({ x: el.x, y: el.y, w: el.w, h: el.h }))
  const pageBounds = allRects.length ? boundsOfRects(allRects) : { x: 120, y: 120, w: 0, h: 0 }
  const estimated = estimateFormulaSize(args.latex, args.display)
  const width = args.width ?? estimated.w
  const height = args.height ?? estimated.h
  const initialPlacement = findFormulaPlacement(draft, args, width, height, pageBounds)

  const element: MathElement = {
    id: newElementId(),
    type: 'math',
    x: Math.round(initialPlacement.x),
    y: Math.round(initialPlacement.y),
    w: Math.round(width),
    h: Math.round(height),
    rotation: 0,
    z: nextZ(draft.doc),
    latex: args.latex,
    color: args.uncertain ? '#d97706' : 'var(--ink-text)',
    display: args.display,
    agentMeta: {
      planId: draft.planId,
      role: 'created',
      sourceId: args.relativeTo,
      sourceBlockIndex: args.sourceBlockIndex,
      skill: 'formula_companion',
    },
  }
  draft.doc.elements.push(element)
  draft.allowedElementIds.push(element.id)
  draft.createdElementIds.push(element.id)

  let placementLabel = initialPlacement.label
  if (args.relativeTo) {
    // Reflow every movable formula for this source together. This keeps later formulas in the
    // same reading lane instead of letting each model call choose a different free side.
    const groupIds = draft.doc.elements
      .filter(
        (item): item is MathElement =>
          item.type === 'math' &&
          !item.locked &&
          item.agentMeta?.sourceId === args.relativeTo &&
          draft.allowedElementIds.includes(item.id)
      )
      .map((item) => item.id)
    const establishedSide = establishedFormulaSide(
      draft,
      groupIds.filter((id) => id !== element.id),
      args.relativeTo
    )
    const sideOverrides = new Map<string, FormulaSide>([
      [
        element.id,
        establishedSide ??
          args.side ??
          defaultFormulaSide(draft, args.relativeTo, args.sourceBlockIndex),
      ],
    ])
    const labels = layoutFormulaTargets(draft, groupIds, sideOverrides)
    placementLabel = labels.get(element.id) ?? placementLabel
  }

  return {
    draft,
    observation: `已创建 LaTeX 公式块并放在${placementLabel}，对象 ID 为 ${element.id}`,
  }
}

function embedMath(
  draft: CanvasAgentDraft,
  args: z.infer<typeof embedMathSchema>
): CanvasToolMutationResult {
  resolveTargets(draft, [args.elementId].concat(args.formulaId ?? []))
  const source = draft.doc.elements.find((element) => element.id === args.elementId)
  if (!source || (source.type !== 'text' && source.type !== 'sticky')) {
    throw new Error(`对象 ${args.elementId} 不是可嵌入公式的正文`)
  }

  if (args.contentHash && args.blockIndex !== undefined) {
    const segment = canvasTextSegments(draft).find(
      (item) => item.elementId === args.elementId && item.blockIndex === args.blockIndex
    )
    if (!segment || segment.contentHash !== args.contentHash) {
      throw new Error(`对象 ${args.elementId} 的第 ${args.blockIndex + 1} 段内容已变化，请重新读取后再修改`)
    }
  }

  if (args.formulaId) {
    const formula = draft.doc.elements.find((element) => element.id === args.formulaId)
    if (!formula || formula.type !== 'math') throw new Error(`对象 ${args.formulaId} 不是公式块`)
    if (
      formula.agentMeta?.skill !== 'formula_companion' ||
      formula.agentMeta.sourceId !== source.id ||
      normalizeRichTextLatex(formula.latex) !== normalizeRichTextLatex(args.latex)
    ) {
      throw new Error(`公式 ${args.formulaId} 不是可安全迁回该正文的 Agent 伴随公式`)
    }
  }

  const result = applyEmbeddedMath(draft, args)
  if (!result) throw new Error(`在对象 ${args.elementId} 中找不到对应的 LaTeX 源码`)

  if (args.formulaId) {
    const formulaIndex = draft.doc.elements.findIndex((element) => element.id === args.formulaId)
    if (formulaIndex >= 0) draft.doc.elements.splice(formulaIndex, 1)
    draft.allowedElementIds = draft.allowedElementIds.filter((id) => id !== args.formulaId)
    draft.createdElementIds = draft.createdElementIds.filter((id) => id !== args.formulaId)
    if (!draft.deletedElementIds.includes(args.formulaId)) {
      draft.deletedElementIds.push(args.formulaId)
    }
    result.observation += `；已移除重复的旧伴随公式 ${args.formulaId}`
  }
  return result
}

function normalizeMath(
  draft: CanvasAgentDraft,
  args: z.infer<typeof normalizeMathSchema>
): CanvasToolMutationResult {
  resolveTargets(draft, [args.elementId])
  const source = draft.doc.elements.find((element) => element.id === args.elementId)
  if (!source || (source.type !== 'text' && source.type !== 'sticky')) {
    throw new Error(`对象 ${args.elementId} 不是可嵌入公式的正文`)
  }

  const result = normalizeAllRichTextMathHtml(source.html)
  if (result.total === 0) throw new Error(`对象 ${args.elementId} 中没有可识别的 LaTeX 公式`)
  if (result.normalized > 0) source.html = result.html
  return {
    draft,
    observation:
      result.normalized > 0
        ? `已扫描 ${result.total} 个公式候选并在原文位置规范化 ${result.normalized} 个`
        : `已回读 ${result.total} 个公式候选，均已绑定在原文位置`,
  }
}

function applyEmbeddedMath(
  draft: CanvasAgentDraft,
  args: {
    elementId: string
    blockIndex?: number
    latex: string
    display: boolean
    formulaId?: string
  }
): CanvasToolMutationResult | null {
  const source = draft.doc.elements.find((element) => element.id === args.elementId)
  if (!source || source.locked || (source.type !== 'text' && source.type !== 'sticky')) return null
  const embedded = embedLatexInRichTextHtml(source.html, args.latex, {
    blockIndex: args.blockIndex,
    display: args.display,
  })
  if (embedded.status === 'not_found') return null

  if (embedded.status === 'embedded') source.html = embedded.html
  if (embedded.status === 'embedded') {
    const estimated = estimateFormulaSize(args.latex, embedded.display)
    const heightDelta = embedded.display
      ? Math.max(48, estimated.h - 12)
      : Math.max(0, estimated.h - 64)
    if (heightDelta > 0) source.h = Math.min(100_000, source.h + heightDelta)
  }
  const location = embedded.blockIndex !== undefined ? `第 ${embedded.blockIndex + 1} 段` : '原文位置'
  return {
    draft,
    observation:
      embedded.status === 'existing'
        ? `公式已经嵌入对象 ${source.id} 的${location}`
        : `已把公式嵌入对象 ${source.id} 的${location}，正文将随内容自动回流`,
  }
}

type FormulaSide = NonNullable<z.infer<typeof createMathSchema>['side']>

interface FormulaLayoutItem {
  element: MathElement
  sourceId: string
  blockIndex?: number
  order: number
  size: { w: number; h: number }
}

function mathTargetIds(draft: CanvasAgentDraft, ids?: string[]) {
  const explicit = !!ids?.length
  const requested = explicit
    ? Array.from(new Set(ids))
    : draft.allowedElementIds.filter((id) => {
        const element = draft.doc.elements.find((item) => item.id === id)
        return element?.type === 'math' && !element.locked
      })
  if (requested.length === 0) throw new Error('作用范围内没有可重排的公式块')

  const allowed = new Set(draft.allowedElementIds)
  const unknown = requested.filter((id) => !allowed.has(id))
  if (unknown.length > 0) throw new Error(`对象不在允许的作用范围内：${unknown.join('、')}`)
  const nonMath = requested.filter(
    (id) => draft.doc.elements.find((element) => element.id === id)?.type !== 'math'
  )
  if (nonMath.length > 0) throw new Error(`对象不是公式块：${nonMath.join('、')}`)
  if (explicit) resolveTargets(draft, requested)
  return requested
}

function layoutMath(
  draft: CanvasAgentDraft,
  args: z.infer<typeof layoutMathSchema>
): CanvasToolMutationResult {
  const ids = mathTargetIds(draft, args.ids)
  const idSet = new Set(ids)
  const unrelatedOverrides = Array.from(
    new Set([...Object.keys(args.anchors), ...Object.keys(args.blockIndices)])
  ).filter((id) => !idSet.has(id))
  if (unrelatedOverrides.length > 0) {
    throw new Error(`公式布局参数包含未选中的对象：${unrelatedOverrides.join('、')}`)
  }

  for (const id of ids) {
    const element = draft.doc.elements.find(
      (item): item is MathElement => item.id === id && item.type === 'math'
    )!
    const previousSourceId = element.agentMeta?.sourceId
    const sourceId = args.anchors[id] ?? previousSourceId ?? inferFormulaSource(draft, element)
    const sourceChanged = args.anchors[id] !== undefined && args.anchors[id] !== previousSourceId
    const blockIndex =
      args.blockIndices[id] ?? (sourceChanged ? undefined : element.agentMeta?.sourceBlockIndex)
    if (sourceId === id) throw new Error(`公式 ${id} 不能以自身作为来源`)
    if (sourceId) resolveFormulaAnchor(draft, sourceId, blockIndex)

    element.agentMeta = {
      ...element.agentMeta,
      planId: element.agentMeta?.planId ?? draft.planId,
      role: element.agentMeta?.role ?? 'positioned',
      sourceId,
      sourceBlockIndex: sourceId ? blockIndex : undefined,
      skill: 'formula_companion',
    }
  }

  const before = new Map(
    ids.map((id) => {
      const item = draft.doc.elements.find((element) => element.id === id)!
      return [id, `${item.x}:${item.y}:${item.w}:${item.h}`]
    })
  )
  layoutFormulaTargets(draft, ids)
  const moved = ids.filter((id) => {
    const item = draft.doc.elements.find((element) => element.id === id)!
    return before.get(id) !== `${item.x}:${item.y}:${item.w}:${item.h}`
  }).length

  return {
    draft,
    observation:
      moved > 0
        ? `已按来源和阅读顺序重排 ${ids.length} 个公式块，其中 ${moved} 个位置或尺寸已修正`
        : `已检查 ${ids.length} 个公式块，当前位置与尺寸无需调整`,
  }
}

function estimateFormulaSize(latex: string, display: boolean): { w: number; h: number } {
  const source = latex.trim()
  const rows = source
    .replace(/\\begin\{(?:aligned|align\*?|gather\*?|cases|matrix|pmatrix|bmatrix|vmatrix|Vmatrix)\}/g, '')
    .replace(/\\end\{(?:aligned|align\*?|gather\*?|cases|matrix|pmatrix|bmatrix|vmatrix|Vmatrix)\}/g, '')
    .split(/\\\\(?:\[[^\]]*\])?|\\cr\b/)
  const fractionCount = (source.match(/\\(?:d|t)?frac\b/g) ?? []).length
  const rootCount = (source.match(/\\sqrt(?:\[[^\]]*\])?/g) ?? []).length
  const tallOperatorCount = (source.match(/\\(?:sum|prod|int|iint|iiint|lim)\b/g) ?? []).length
  const matrixLike = /\\begin\{(?:cases|matrix|pmatrix|bmatrix|vmatrix|Vmatrix)\}/.test(source)

  let widestUnits = 0
  let matrixColumns = 1
  for (const row of rows) {
    matrixColumns = Math.max(matrixColumns, row.split('&').length)
    const readable = row
      .replace(/\\(?:begin|end)\{[^}]+\}/g, '')
      .replace(/\\(?:left|right|big|Big|bigg|Bigg)\b/g, '')
      .replace(/\\(?:text|operatorname|mathrm|mathbf|mathit|mathsf|mathtt)\{([^}]*)\}/g, '$1')
      .replace(/\\[a-zA-Z]+\*?/g, 'x')
      .replace(/\\./g, 'x')
      .replace(/[{}_^&]/g, '')
    const units = Array.from(readable).reduce((sum, char) => {
      if (/\s/.test(char)) return sum + 0.35
      if (/[.,:;'|!]/.test(char)) return sum + 0.45
      if (/[il1()\[\]]/.test(char)) return sum + 0.6
      if (/[MW@#]/.test(char)) return sum + 1.25
      return sum + 1
    }, 0)
    widestUnits = Math.max(widestUnits, units)
  }

  const structuralWidth = Math.min(180, fractionCount * 10 + rootCount * 8)
  const matrixWidth = matrixLike ? Math.max(0, matrixColumns - 1) * 36 : 0
  const minWidth = display ? 180 : 140
  const w = Math.round(Math.max(minWidth, Math.min(1200, 64 + widestUnits * 14 + structuralWidth + matrixWidth)))
  const visualRows = Math.max(rows.length, matrixLike ? rows.length + 1 : 1)
  const structuralHeight =
    Math.min(96, fractionCount * 12 + rootCount * 5 + tallOperatorCount * 8) +
    Math.max(0, visualRows - 1) * 32
  const minHeight = display ? 84 : 64
  const h = Math.round(Math.max(minHeight, Math.min(420, minHeight + structuralHeight)))
  return { w, h }
}

function findFormulaPlacement(
  draft: CanvasAgentDraft,
  args: z.infer<typeof createMathSchema>,
  width: number,
  height: number,
  pageBounds: Rect
) {
  if (args.x !== undefined && args.y !== undefined && !args.relativeTo) {
    return { x: args.x, y: args.y, label: '指定位置' }
  }

  if (!args.relativeTo) {
    return {
      x: args.x ?? pageBounds.x,
      y: args.y ?? pageBounds.y + pageBounds.h + 60,
      label: '现有内容下方',
    }
  }

  const anchor = resolveFormulaAnchor(draft, args.relativeTo, args.sourceBlockIndex).rect
  const occupied = draft.doc.elements
    .filter((element) => element.id !== args.relativeTo)
    .map((element) => ({ x: element.x, y: element.y, w: element.w, h: element.h }))
  const preferred = args.side ?? 'below'
  const sides = Array.from(new Set<FormulaSide>([preferred, 'below', 'right', 'above', 'left']))

  for (let ring = 0; ring < MAX_FORMULA_LANE_RINGS; ring++) {
    for (const side of sides) {
      const candidate = formulaCandidate(anchor, width, height, side, ring)
      if (!occupied.some((rect) => rectsOverlapWithGap(candidate, rect, 16))) {
        return { ...candidate, label: formulaSideLabel(side) }
      }
    }
  }

  const fallback = formulaCandidate(anchor, width, height, preferred, MAX_FORMULA_LANE_RINGS)
  return { ...fallback, label: formulaSideLabel(preferred) }
}

function formulaCandidate(
  anchor: Rect,
  width: number,
  height: number,
  side: FormulaSide,
  ring: number
): Rect {
  if (side === 'left' || side === 'right') {
    const distance = FORMULA_ANCHOR_GAP + ring * (width + FORMULA_ANCHOR_GAP)
    return {
      x: side === 'left' ? anchor.x - width - distance : anchor.x + anchor.w + distance,
      y: anchor.y + anchor.h / 2 - height / 2,
      w: width,
      h: height,
    }
  }
  const distance = FORMULA_ANCHOR_GAP + ring * (height + FORMULA_ANCHOR_GAP)
  return {
    x: anchor.x + anchor.w / 2 - width / 2,
    y: side === 'above' ? anchor.y - height - distance : anchor.y + anchor.h + distance,
    w: width,
    h: height,
  }
}

function layoutFormulaTargets(
  draft: CanvasAgentDraft,
  ids: string[],
  sideOverrides = new Map<string, FormulaSide>()
) {
  const labels = new Map<string, string>()
  const ignoredIds = new Set(ids)
  const documentOrder = new Map(draft.doc.elements.map((element, index) => [element.id, index]))
  const groups = new Map<string, FormulaLayoutItem[]>()
  const unanchored: MathElement[] = []

  for (const id of ids) {
    const element = draft.doc.elements.find(
      (item): item is MathElement => item.id === id && item.type === 'math'
    )
    if (!element) throw new Error(`对象 ${id} 不是公式块`)
    if (element.locked) throw new Error(`对象 ${id} 已锁定，Agent 不能修改`)
    const sourceId = element.agentMeta?.sourceId ?? inferFormulaSource(draft, element)
    if (!sourceId) {
      unanchored.push(element)
      continue
    }
    const blockIndex = element.agentMeta?.sourceBlockIndex
    resolveFormulaAnchor(draft, sourceId, blockIndex)
    if (!element.agentMeta?.sourceId) {
      element.agentMeta = {
        ...element.agentMeta,
        planId: draft.planId,
        role: element.agentMeta?.role ?? 'positioned',
        sourceId,
        sourceBlockIndex: blockIndex,
        skill: 'formula_companion',
      }
    }
    const item: FormulaLayoutItem = {
      element,
      sourceId,
      blockIndex,
      order: documentOrder.get(element.id) ?? Number.MAX_SAFE_INTEGER,
      size: estimateFormulaSize(element.latex, element.display),
    }
    const group = groups.get(sourceId) ?? []
    group.push(item)
    groups.set(sourceId, group)
  }

  const occupied = draft.doc.elements
    .filter((element) => !ignoredIds.has(element.id))
    .map((element) => ({ id: element.id, rect: elementRect(element) }))
  const occupiedStrokes = draft.doc.strokes
    .filter((stroke) => stroke.points.length > 0)
    .map((stroke) => ({ id: stroke.id, rect: strokeBounds(stroke) }))
  const placed: Rect[] = []

  for (const [sourceId, items] of groups) {
    items.sort(
      (a, b) =>
        (a.blockIndex ?? Number.MAX_SAFE_INTEGER) -
          (b.blockIndex ?? Number.MAX_SAFE_INTEGER) ||
        a.order - b.order
    )
    const explicitSide = items
      .map((item) => sideOverrides.get(item.element.id))
      .find((side): side is FormulaSide => !!side)
    const side = explicitSide ?? defaultFormulaSide(
      draft,
      sourceId,
      items.find((item) => item.blockIndex !== undefined)?.blockIndex
    )
    const anchor = resolveFormulaAnchor(draft, sourceId)
    const obstacles = occupied
      .filter((item) => item.id !== sourceId)
      .map((item) => item.rect)
      .concat(
        occupiedStrokes
          .filter((item) => !draft.inkGroups[sourceId]?.includes(item.id))
          .map((item) => item.rect)
      )
    let chosen = formulaLaneCandidates(draft, items, anchor.containerRect, side, 0)

    for (let ring = 0; ring < MAX_FORMULA_LANE_RINGS; ring++) {
      const candidates = formulaLaneCandidates(draft, items, anchor.containerRect, side, ring)
      const collides = candidates.some((candidate) =>
        obstacles.concat(placed).some((rect) =>
          rectsOverlapWithGap(candidate, rect, FORMULA_COLLISION_GAP)
        )
      )
      chosen = candidates
      if (!collides) break
    }

    items.forEach((item, index) => {
      const next = chosen[index]
      item.element.x = Math.round(next.x)
      item.element.y = Math.round(next.y)
      item.element.w = Math.round(next.w)
      item.element.h = Math.round(next.h)
      labels.set(item.element.id, formulaSideLabel(side))
      placed.push(next)
    })
  }

  for (const element of unanchored.sort(
    (a, b) => (documentOrder.get(a.id) ?? 0) - (documentOrder.get(b.id) ?? 0)
  )) {
    const size = estimateFormulaSize(element.latex, element.display)
    element.w = size.w
    element.h = size.h
    labels.set(element.id, '原位置')
    placed.push(elementRect(element))
  }

  return labels
}

function formulaLaneCandidates(
  draft: CanvasAgentDraft,
  items: FormulaLayoutItem[],
  sourceRect: Rect,
  side: FormulaSide,
  ring: number
): Rect[] {
  const totalHeight =
    items.reduce((sum, item) => sum + item.size.h, 0) +
    Math.max(0, items.length - 1) * FORMULA_STACK_GAP
  const maxWidth = Math.max(...items.map((item) => item.size.w))

  if (side === 'below' || side === 'above') {
    const laneDistance = ring * (totalHeight + FORMULA_ANCHOR_GAP)
    let y =
      side === 'below'
        ? sourceRect.y + sourceRect.h + FORMULA_ANCHOR_GAP + laneDistance
        : sourceRect.y - FORMULA_ANCHOR_GAP - totalHeight - laneDistance
    return items.map((item) => {
      const rect = {
        x: sourceRect.x + sourceRect.w / 2 - item.size.w / 2,
        y,
        w: item.size.w,
        h: item.size.h,
      }
      y += item.size.h + FORMULA_STACK_GAP
      return rect
    })
  }

  const laneDistance = ring * (maxWidth + FORMULA_ANCHOR_GAP)
  const laneEdge =
    side === 'right'
      ? sourceRect.x + sourceRect.w + FORMULA_ANCHOR_GAP + laneDistance
      : sourceRect.x - FORMULA_ANCHOR_GAP - laneDistance
  const hasParagraphAnchors = items.some((item) => item.blockIndex !== undefined)
  let cursorY = hasParagraphAnchors
    ? Number.NEGATIVE_INFINITY
    : sourceRect.y + sourceRect.h / 2 - totalHeight / 2

  return items.map((item) => {
    const focus = resolveFormulaAnchor(draft, item.sourceId, item.blockIndex).rect
    const desiredY = focus.y + focus.h / 2 - item.size.h / 2
    const y = hasParagraphAnchors ? Math.max(desiredY, cursorY) : cursorY
    cursorY = y + item.size.h + FORMULA_STACK_GAP
    return {
      x: side === 'right' ? laneEdge : laneEdge - item.size.w,
      y,
      w: item.size.w,
      h: item.size.h,
    }
  })
}

function defaultFormulaSide(
  draft: CanvasAgentDraft,
  sourceId: string,
  sourceBlockIndex?: number
): FormulaSide {
  const source = draft.doc.elements.find((element) => element.id === sourceId)
  if (source?.type === 'image' || source?.type === 'pdf') return 'right'
  if (
    sourceBlockIndex !== undefined &&
    (source?.type === 'text' || source?.type === 'sticky' || source?.type === 'code')
  ) {
    return 'right'
  }
  return 'below'
}

function establishedFormulaSide(
  draft: CanvasAgentDraft,
  formulaIds: string[],
  sourceId: string
): FormulaSide | undefined {
  if (formulaIds.length === 0) return undefined
  const source = resolveFormulaAnchor(draft, sourceId).containerRect
  const counts = new Map<FormulaSide, number>()
  const order: FormulaSide[] = []
  for (const id of formulaIds) {
    const formula = draft.doc.elements.find(
      (element): element is MathElement => element.id === id && element.type === 'math'
    )
    if (!formula) continue
    const side = formulaSideFromPosition(elementRect(formula), source)
    counts.set(side, (counts.get(side) ?? 0) + 1)
    if (!order.includes(side)) order.push(side)
  }
  return order.sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0))[0]
}

function formulaSideFromPosition(formula: Rect, source: Rect): FormulaSide {
  if (formula.x >= source.x + source.w) return 'right'
  if (formula.x + formula.w <= source.x) return 'left'
  if (formula.y >= source.y + source.h) return 'below'
  if (formula.y + formula.h <= source.y) return 'above'
  const dx = formula.x + formula.w / 2 - (source.x + source.w / 2)
  const dy = formula.y + formula.h / 2 - (source.y + source.h / 2)
  if (Math.abs(dx) > Math.abs(dy)) return dx < 0 ? 'left' : 'right'
  return dy < 0 ? 'above' : 'below'
}

function inferFormulaSource(draft: CanvasAgentDraft, formula: MathElement): string | undefined {
  const allowed = new Set(draft.allowedElementIds)
  const sourceCenter = { x: formula.x + formula.w / 2, y: formula.y + formula.h / 2 }
  const candidates = draft.doc.elements.filter(
    (element) => allowed.has(element.id) && element.id !== formula.id && element.type !== 'math'
  )
  const preferredTypes = new Set<CanvasElement['type']>([
    'text',
    'sticky',
    'code',
    'image',
    'pdf',
  ])
  candidates.sort((a, b) => {
    const score = (element: CanvasElement) => {
      const rect = elementRect(element)
      const dx = Math.max(rect.x - sourceCenter.x, sourceCenter.x - (rect.x + rect.w), 0)
      const dy = Math.max(rect.y - sourceCenter.y, sourceCenter.y - (rect.y + rect.h), 0)
      const centerDistance = Math.hypot(
        sourceCenter.x - (rect.x + rect.w / 2),
        sourceCenter.y - (rect.y + rect.h / 2)
      )
      return Math.hypot(dx, dy) + centerDistance * 0.05 + (preferredTypes.has(element.type) ? 0 : 240)
    }
    return score(a) - score(b)
  })
  return candidates[0]?.id
}

function resolveFormulaAnchor(
  draft: CanvasAgentDraft,
  id: string,
  blockIndex?: number
): { rect: Rect; containerRect: Rect; element?: CanvasElement } {
  const allowed = new Set(allTargetIds(draft))
  if (!allowed.has(id)) throw new Error(`对象不在允许的作用范围内：${id}`)
  const strokeIds = draft.inkGroups[id]
  if (strokeIds) {
    if (blockIndex !== undefined) throw new Error(`手写来源 ${id} 不支持段落锚点`)
    const rect = boundsOfStrokes(draft.doc.strokes.filter((stroke) => strokeIds.includes(stroke.id)))
    if (!rect) throw new Error(`${id} 中没有有效笔迹`)
    return { rect, containerRect: rect }
  }

  const element = draft.doc.elements.find((item) => item.id === id)
  if (!element) throw new Error(`找不到对象 ${id}`)
  const containerRect = elementRect(element)
  if (blockIndex === undefined) return { rect: containerRect, containerRect, element }
  if (element.type !== 'text' && element.type !== 'sticky') {
    throw new Error(`对象 ${id} 不是可使用段落锚点的正文`)
  }
  return { rect: textBlockAnchorRect(element, blockIndex), containerRect, element }
}

function textBlockAnchorRect(element: TextElement | StickyElement, blockIndex: number): Rect {
  const parsed = parseTextHtml(element.html)
  const blocks = textBlockElements(parsed)
  if (!blocks[blockIndex]) throw new Error(`对象 ${element.id} 中找不到第 ${blockIndex + 1} 段`)
  const padding = element.type === 'text' ? Math.max(0, element.padding) : 12
  const usableWidth = Math.max(40, element.w - padding * 2)
  const usableHeight = Math.max(32, element.h - padding * 2)
  const fontScale = element.type === 'text' ? element.fontScale : 1
  const charsPerLine = Math.max(8, Math.floor(usableWidth / Math.max(7, fontScale * 8)))
  const weights = blocks.map((block) => {
    const text = normalizeText(block.textContent ?? '')
    const lineUnits = Array.from(text).reduce(
      (sum, char) => sum + (/[^\x00-\xff]/.test(char) ? 1 : 0.55),
      0
    )
    const lines = Math.max(1, Math.ceil(lineUnits / charsPerLine))
    const headingScale = /^H[1-6]$/.test(block.tagName) ? 1.35 : 1
    return lines * headingScale + 0.35
  })
  const totalWeight = Math.max(1, weights.reduce((sum, weight) => sum + weight, 0))
  const beforeWeight = weights.slice(0, blockIndex).reduce((sum, weight) => sum + weight, 0)
  const y = element.y + padding + (beforeWeight / totalWeight) * usableHeight
  const h = Math.max(24, (weights[blockIndex] / totalWeight) * usableHeight)
  return { x: element.x + padding, y, w: usableWidth, h }
}

function elementRect(element: CanvasElement): Rect {
  const angle = ((element.rotation % 360) * Math.PI) / 180
  if (Math.abs(angle) < 0.0001) {
    return { x: element.x, y: element.y, w: element.w, h: element.h }
  }
  const cos = Math.abs(Math.cos(angle))
  const sin = Math.abs(Math.sin(angle))
  const w = element.w * cos + element.h * sin
  const h = element.w * sin + element.h * cos
  return {
    x: element.x + element.w / 2 - w / 2,
    y: element.y + element.h / 2 - h / 2,
    w,
    h,
  }
}

function rectsOverlapWithGap(a: Rect, b: Rect, gap: number) {
  return !(
    a.x + a.w + gap <= b.x ||
    b.x + b.w + gap <= a.x ||
    a.y + a.h + gap <= b.y ||
    b.y + b.h + gap <= a.y
  )
}

function formulaSideLabel(side: FormulaSide) {
  if (side === 'left') return '来源左侧'
  if (side === 'right') return '来源右侧'
  if (side === 'above') return '来源上方'
  return '来源下方'
}

function updateMath(
  draft: CanvasAgentDraft,
  args: z.infer<typeof updateMathSchema>
): CanvasToolMutationResult {
  resolveTargets(draft, [args.id])
  const element = draft.doc.elements.find((item) => item.id === args.id)
  if (!element || element.type !== 'math') throw new Error(`对象 ${args.id} 不是公式块`)
  element.latex = args.latex
  if (args.display !== undefined) element.display = args.display
  return { draft, observation: `已更新公式块 ${args.id} 的 LaTeX 内容` }
}

function updateTextSegment(
  draft: CanvasAgentDraft,
  args: z.infer<typeof updateTextSegmentSchema>
): CanvasToolMutationResult {
  resolveTargets(draft, [args.elementId])
  const element = draft.doc.elements.find((item) => item.id === args.elementId)
  if (!element || (element.type !== 'text' && element.type !== 'sticky')) {
    throw new Error(`对象 ${args.elementId} 不是可逐段编辑的正文`)
  }

  const parsed = parseTextHtml(element.html)
  const blocks = textBlockElements(parsed)
  const block = blocks[args.blockIndex]
  if (!block) throw new Error(`对象 ${args.elementId} 中找不到第 ${args.blockIndex + 1} 段`)
  const currentHtml = block === parsed.body ? parsed.body.innerHTML : block.outerHTML
  const currentHash = contentHash(currentHtml)
  if (currentHash !== args.contentHash) {
    throw new Error(`对象 ${args.elementId} 的第 ${args.blockIndex + 1} 段内容已变化，请重新读取后再修改`)
  }

  const replacement = sanitizeReplacementHtml(args.replacementHtml)
  block.innerHTML = replacement
  element.html = parsed.body.innerHTML
  return {
    draft,
    observation: `已安全更新对象 ${args.elementId} 的第 ${args.blockIndex + 1} 段`,
  }
}

function setStyle(draft: CanvasAgentDraft, args: z.infer<typeof styleSchema>): CanvasToolMutationResult {
  const targets = resolveTargets(draft, args.ids)
  const elementIds = new Set(targets.filter((target) => !target.id.startsWith('ink:')).map((t) => t.id))
  if (elementIds.size === 0) throw new Error('手写笔迹暂不支持此样式工具')
  for (const element of draft.doc.elements) {
    if (!elementIds.has(element.id)) continue
    if (args.opacity !== undefined) element.opacity = args.opacity
    if (element.type === 'text') {
      if (args.background !== undefined) element.bg = args.background
      if (args.border !== undefined) element.border = args.border
      if (args.fontScale !== undefined) element.fontScale = args.fontScale
    } else if (element.type === 'sticky') {
      if (args.background !== undefined) element.color = args.background
    } else if (element.type === 'shape') {
      if (args.background !== undefined) element.fill = args.background
      if (args.border !== undefined) element.stroke = args.border
    }
  }
  return { draft, observation: `已修改 ${elementIds.size} 个对象的样式` }
}

function requestedTargetIds(draft: CanvasAgentDraft, ids?: string[]) {
  return ids && ids.length > 0 ? Array.from(new Set(ids)) : allTargetIds(draft)
}

function activityTargets(
  draft: CanvasAgentDraft,
  ids: string[],
  allowLocked = false
): CanvasAgentToolTargets {
  if (ids.length === 0) return { elementIds: [], strokeIds: [] }
  if (allowLocked) {
    const allowed = new Set(allTargetIds(draft))
    const unknown = ids.filter((id) => !allowed.has(id))
    if (unknown.length > 0) throw new Error(`对象不在允许的作用范围内：${unknown.join('、')}`)
  } else {
    resolveTargets(draft, ids)
  }
  const elementIds: string[] = []
  const strokeIds: string[] = []
  for (const id of ids) {
    const ink = draft.inkGroups[id]
    if (ink) strokeIds.push(...ink)
    else elementIds.push(id)
  }
  return {
    elementIds: Array.from(new Set(elementIds)),
    strokeIds: Array.from(new Set(strokeIds)),
  }
}

function resolveTargets(draft: CanvasAgentDraft, ids?: string[]): Target[] {
  const requested = ids && ids.length > 0 ? Array.from(new Set(ids)) : allTargetIds(draft)
  if (requested.length === 0) throw new Error('没有可操作的对象')
  const allowed = new Set(allTargetIds(draft))
  const unknown = requested.filter((id) => !allowed.has(id))
  if (unknown.length > 0) throw new Error(`对象不在允许的作用范围内：${unknown.join('、')}`)

  return requested.map((id) => {
    const strokeIds = draft.inkGroups[id]
    if (strokeIds) return inkTarget(draft.doc, id, strokeIds)
    const element = draft.doc.elements.find((el) => el.id === id)
    if (!element) throw new Error(`找不到对象 ${id}`)
    if (element.locked) throw new Error(`对象 ${id} 已锁定，Agent 不能修改`)
    return elementTarget(element)
  })
}

function elementTarget(element: CanvasElement): Target {
  return {
    id: element.id,
    rect: { x: element.x, y: element.y, w: element.w, h: element.h },
    locked: !!element.locked,
    move(dx, dy) {
      element.x = Math.round(element.x + dx)
      element.y = Math.round(element.y + dy)
    },
    resize(rect) {
      element.x = Math.round(rect.x)
      element.y = Math.round(rect.y)
      element.w = Math.round(rect.w)
      element.h = Math.round(rect.h)
    },
  }
}

function inkTarget(doc: CanvasDoc, id: string, strokeIds: string[]): Target {
  const selected = doc.strokes.filter((stroke) => strokeIds.includes(stroke.id))
  const rect = boundsOfStrokes(selected)
  if (!rect) throw new Error(`${id} 中没有有效笔迹`)
  return {
    id,
    rect,
    locked: false,
    move(dx, dy) {
      for (const stroke of selected) {
        stroke.points = stroke.points.map(([x, y, pressure]) => [x + dx, y + dy, pressure])
      }
    },
    resize(next) {
      const sx = next.w / Math.max(1, rect.w)
      const sy = next.h / Math.max(1, rect.h)
      for (const stroke of selected) {
        stroke.points = stroke.points.map(([x, y, pressure]) => [
          next.x + (x - rect.x) * sx,
          next.y + (y - rect.y) * sy,
          pressure,
        ])
      }
    },
  }
}

function allTargetIds(draft: CanvasAgentDraft) {
  return draft.allowedElementIds.concat(Object.keys(draft.inkGroups))
}

function boundsOfStrokes(strokes: CanvasDoc['strokes']): Rect | null {
  const rects = strokes.filter((stroke) => stroke.points.length > 0).map(strokeBounds)
  return rects.length ? boundsOfRects(rects) : null
}

function boundsOfRects(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((rect) => rect.x))
  const y = Math.min(...rects.map((rect) => rect.y))
  const right = Math.max(...rects.map((rect) => rect.x + rect.w))
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.h))
  return { x, y, w: right - x, h: bottom - y }
}

function requireCount(targets: Target[], count: number) {
  if (targets.length < count) throw new Error(`此操作至少需要 ${count} 个对象`)
}

function clampSize(value: number) {
  return Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(value)))
}

function nextZ(doc: CanvasDoc) {
  return Math.max(0, ...doc.elements.map((el) => el.z), ...doc.strokes.map((stroke) => stroke.z)) + 1
}

function makeTextElement(
  text: string,
  x: number,
  y: number,
  w: number,
  h: number,
  planId: string,
  role: 'heading' | 'created'
): TextElement {
  return {
    id: newElementId(),
    type: 'text',
    x: Math.round(x),
    y: Math.round(y),
    w: Math.round(w),
    h: Math.round(h),
    rotation: 0,
    z: 0,
    html: role === 'heading' ? `<h2>${escapeHtml(text)}</h2>` : `<p>${escapeHtml(text)}</p>`,
    bg: 'transparent',
    border: 'transparent',
    fontFamily: 'sans',
    fontScale: 1,
    padding: 8,
    agentMeta: { planId, role },
  }
}

function summarizeElement(element: CanvasElement, maxChars = 100): string {
  if (element.type === 'text' || element.type === 'sticky') {
    return element.html
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxChars)
  }
  if (element.type === 'shape') return element.label || `图形 ${element.shape}`
  if (element.type === 'image') return element.alt || '图片'
  if (element.type === 'pdf') return `${element.filename} 第 ${element.page} 页`
  if (element.type === 'math') return element.latex.slice(0, maxChars)
  if (element.type === 'code') return element.code.replace(/\s+/g, ' ').slice(0, maxChars)
  return element.filename
}

const TEXT_BLOCK_SELECTOR = 'p,h1,h2,h3,h4,h5,h6,blockquote,pre,li,td,th'
const UNSAFE_REPLACEMENT_SELECTOR = 'script,style,iframe,object,embed,link,meta,svg,math'
const SAFE_INLINE_TAGS = new Set([
  'A',
  'B',
  'BR',
  'CODE',
  'DEL',
  'EM',
  'I',
  'MARK',
  'S',
  'SPAN',
  'STRONG',
  'SUB',
  'SUP',
  'U',
])

function parseTextHtml(html: string): Document {
  if (typeof DOMParser === 'undefined') {
    throw new Error('当前环境不支持安全的 HTML 段落解析')
  }
  return new DOMParser().parseFromString(html || '', 'text/html')
}

function textBlockElements(doc: Document): HTMLElement[] {
  const candidates = Array.from(doc.body.querySelectorAll<HTMLElement>(TEXT_BLOCK_SELECTOR))
  const leaves = candidates.filter((candidate) => !candidate.querySelector(TEXT_BLOCK_SELECTOR))
  return leaves.length > 0 ? leaves : [doc.body]
}

function normalizeText(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

function contentHash(value: string) {
  const hash32 = (input: string, seed: number) => {
    let hash = seed >>> 0
    for (let index = 0; index < input.length; index++) {
      hash ^= input.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193)
    }
    return (hash >>> 0).toString(16).padStart(8, '0')
  }
  return `${hash32(value, 0x811c9dc5)}${hash32(Array.from(value).reverse().join(''), 0x9e3779b9)}`
}

function sanitizeReplacementHtml(value: string) {
  const doc = parseTextHtml(value)
  doc.body.querySelectorAll(UNSAFE_REPLACEMENT_SELECTOR).forEach((element) => element.remove())
  const elements = Array.from(doc.body.querySelectorAll<HTMLElement>('*')).reverse()
  for (const element of elements) {
    if (!SAFE_INLINE_TAGS.has(element.tagName)) {
      element.replaceWith(...Array.from(element.childNodes))
      continue
    }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase()
      const allowedLinkAttribute =
        element.tagName === 'A' && ['href', 'title', 'target', 'rel'].includes(name)
      const allowedMarkAttribute =
        (element.tagName === 'MARK' || element.tagName === 'SPAN') && name === 'data-color'
      if (!allowedLinkAttribute && !allowedMarkAttribute) element.removeAttribute(attribute.name)
    }
    if (element.tagName === 'A') {
      const href = element.getAttribute('href')?.trim() ?? ''
      if (/^(?:javascript|data):/i.test(href)) element.removeAttribute('href')
      if (element.getAttribute('target') === '_blank') element.setAttribute('rel', 'noopener noreferrer')
    }
  }
  const sanitized = doc.body.innerHTML.trim()
  if (!normalizeText(doc.body.textContent ?? '') && !doc.body.querySelector('br')) {
    throw new Error('替换后的段落不能为空')
  }
  return sanitized
}

function diffCanvasDocs(before: CanvasDoc, after: CanvasDoc) {
  const beforeElements = new Map(before.elements.map((element) => [element.id, element]))
  const afterElementIds = new Set(after.elements.map((element) => element.id))
  const beforeStrokes = new Map(before.strokes.map((stroke) => [stroke.id, stroke]))
  const createdElementIds = after.elements
    .filter((element) => !beforeElements.has(element.id))
    .map((element) => element.id)
  const changedElementIds = after.elements
    .filter((element) => {
      const previous = beforeElements.get(element.id)
      return previous && JSON.stringify(previous) !== JSON.stringify(element)
    })
    .map((element) => element.id)
  const deletedElementIds = before.elements
    .filter((element) => !afterElementIds.has(element.id))
    .map((element) => element.id)
  const changedStrokeIds = after.strokes
    .filter((stroke) => {
      const previous = beforeStrokes.get(stroke.id)
      return previous && JSON.stringify(previous) !== JSON.stringify(stroke)
    })
    .map((stroke) => stroke.id)
  return {
    changedElementIds,
    createdElementIds,
    deletedElementIds,
    changedStrokeIds,
    backgroundChanged: before.background !== after.background,
  }
}

export const CANVAS_AGENT_TOOL_GUIDE = `可用工具（一次只调用一个）：
1. arrange: {"ids"?:string[],"mode":"grid|columns|rows|timeline","columns"?:number,"gap"?:number}
2. group_layout: {"groups":[{"title":string,"ids":string[]}],"direction":"columns|rows","gap"?:number,"addHeadings"?:boolean}
3. align: {"ids"?:string[],"alignment":"left|center|right|top|middle|bottom"}
4. distribute: {"ids"?:string[],"direction":"horizontal|vertical","gap"?:number}
5. place_relative: {"ids":string[],"anchorId":string,"side":"left|right|above|below","gap"?:number}
6. resize: {"ids"?:string[],"width"?:number,"height"?:number,"scale"?:number}
7. create: {"type":"text|sticky|shape","content":string,"shape"?:string,"x"?:number,"y"?:number,"width"?:number,"height"?:number,"relativeTo"?:string,"side"?:string}
8. create_math: {"latex":string,"display"?:boolean,"uncertain"?:boolean,"relativeTo"?:string,"sourceBlockIndex"?:number,"side"?:string}
9. embed_math: {"elementId":string,"blockIndex"?:number,"contentHash"?:string,"latex":string,"display"?:boolean,"formulaId"?:string}
10. update_math: {"id":string,"latex":string,"display"?:boolean}
11. layout_math: {"ids"?:string[],"anchors"?:{[formulaId:string]:string},"blockIndices"?:{[formulaId:string]:number}}
12. update_text_segment: {"elementId":string,"blockIndex":number,"contentHash":string,"replacementHtml":string}
13. set_style: {"ids"?:string[],"background"?:string,"border"?:string,"opacity"?:number,"fontScale"?:number}
14. set_background: {"background":"blank|grid|dots|lines|staff"}

规则：
- ids 省略表示作用范围内的全部对象。
- LOCKED 对象绝不能修改；但可作为 create_math/layout_math 的只读来源锚点。
- 不允许删除普通对象。embed_math 只能在本地候选绑定与回读校验确认公式已位于来源正文后，移除带 formula_companion 来源标记的重复 Agent 公式；用户手工公式绝不能删除。改写正文时必须使用 update_text_segment，一次只改一个“可逐段编辑的正文段落”，并原样传回段落清单中的 elementId、blockIndex 和 contentHash。
- replacementHtml 只写该段内部的安全 HTML；不得加入脚本、图片、iframe 或整页 HTML。段落内容发生变化导致 hash 校验失败时，重新读取清单后再操作，绝不能覆盖新内容。
- 用户要求提取、转换或修改公式时，可编辑正文和便签优先使用 embed_math 原位嵌入；图片、PDF、代码或锁定正文才使用 create_math 创建伴随公式块。已有独立公式内容用 update_math，独立公式位置不正确时用 layout_math；latex 只写 KaTeX 可渲染的公式源码，不要包含 $$、\\[ 或 Markdown 围栏。
- embed_math 必须使用段落清单中的 elementId、blockIndex 和 contentHash，工具会按稳定 DOM 候选在原 LaTeX 字符位置替换，公式随正文移动和回流，不需要任何坐标。迁移旧 Agent 公式时允许匹配保守的等价 TeX 写法，但 formulaId 只能指向同一来源且带 formula_companion 标记的公式。
- 从图片、PDF、代码或锁定正文创建伴随公式时，create_math 必须传 relativeTo 指向来源对象。工具会确定尺寸、排列并避让已有对象，不要传或猜测绝对坐标。
- 公式只有局部符号无法确认时，不要拒绝整个任务；保留已识别结构，把不确定位置写成 \\boxed{\\text{?}}，并在 create_math 中传 uncertain:true，生成可编辑的琥珀色草稿。
- 优先使用 arrange/group_layout 等确定性工具，不要自行计算大量坐标。
- 当用户要求已经满足时返回 finish。`
