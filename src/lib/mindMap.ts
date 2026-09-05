import { hierarchy, tree } from 'd3-hierarchy'
import type { CanvasDoc, CanvasElement, ShapeElement } from './types'

export interface MindMapPlan {
  root: string
  /** 根节点不放在 nodes 中；parent=null 表示根节点的直接分支。 */
  nodes: { id: string; label: string; parent: string | null }[]
}

export interface MindMapBuildResult {
  doc: CanvasDoc
  nodeIds: string[]
  nodeCount: number
}

interface SemanticNode {
  id: string
  label: string
  parentId: string | null
  children: SemanticNode[]
}

interface PositionedNode {
  node: SemanticNode
  depth: number
  branchIndex: number
  x: number
  y: number
  w: number
  h: number
}

const ROOT_ID = '__mindmap_root__'
const MAX_NODES = 24
const MAX_DEPTH = 3
const VERTICAL_STEP = 88
const PAGE_PADDING = 120

const BRANCH_COLORS = ['#14866d', '#d96459', '#347fbd', '#c48a1a', '#8067b3', '#bd557f']

function cleanLabel(value: unknown, maxLength: number) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

function resolveRedirect(
  id: string | null,
  redirects: Map<string, string | null>,
  known: Set<string>
) {
  let current = id
  const seen = new Set<string>()
  while (current && !known.has(current)) {
    if (seen.has(current)) return null
    seen.add(current)
    current = redirects.get(current) ?? null
  }
  return current && known.has(current) ? current : null
}

/**
 * Normalizes imperfect model output into one finite tree. Duplicate roots, duplicate
 * labels, missing parents, cycles and over-deep branches are repaired locally.
 */
export function normalizeMindMapPlan(plan: MindMapPlan): SemanticNode {
  const rootLabel = cleanLabel(plan.root, 24) || '主题'
  const redirects = new Map<string, string | null>()
  const records: Array<{ id: string; label: string; parentId: string | null }> = []
  const seenIds = new Set<string>()
  const seenLabels = new Set([rootLabel.toLocaleLowerCase()])

  for (const raw of Array.isArray(plan.nodes) ? plan.nodes.slice(0, MAX_NODES * 2) : []) {
    const id = cleanLabel(raw?.id, 80)
    const label = cleanLabel(raw?.label, 24)
    const parentId = raw?.parent ? cleanLabel(raw.parent, 80) : null
    if (!id || !label || seenIds.has(id) || id === ROOT_ID) continue
    seenIds.add(id)

    const labelKey = label.toLocaleLowerCase()
    if (labelKey === rootLabel.toLocaleLowerCase() || seenLabels.has(labelKey)) {
      redirects.set(id, parentId)
      continue
    }

    seenLabels.add(labelKey)
    records.push({ id, label, parentId })
    if (records.length >= MAX_NODES - 1) break
  }

  const known = new Set(records.map((record) => record.id))
  for (const record of records) {
    record.parentId = resolveRedirect(record.parentId, redirects, known)
    if (record.parentId === record.id) record.parentId = null
  }

  const byId = new Map(records.map((record) => [record.id, record]))
  for (const record of records) {
    const seen = new Set([record.id])
    let parentId = record.parentId
    while (parentId) {
      if (seen.has(parentId)) {
        record.parentId = null
        break
      }
      seen.add(parentId)
      parentId = byId.get(parentId)?.parentId ?? null
    }
  }

  const depthOf = (record: { id: string; parentId: string | null }) => {
    let depth = 1
    let parentId = record.parentId
    const seen = new Set([record.id])
    while (parentId && depth <= MAX_NODES) {
      if (seen.has(parentId)) return 1
      seen.add(parentId)
      depth += 1
      parentId = byId.get(parentId)?.parentId ?? null
    }
    return depth
  }

  for (const record of records) {
    if (depthOf(record) <= MAX_DEPTH) continue
    let parentId = record.parentId
    while (parentId) {
      const parent = byId.get(parentId)
      if (!parent || depthOf(parent) < MAX_DEPTH) break
      parentId = parent.parentId
    }
    record.parentId = parentId
  }

  const root: SemanticNode = { id: ROOT_ID, label: rootLabel, parentId: null, children: [] }
  const semanticById = new Map<string, SemanticNode>()
  for (const record of records) {
    semanticById.set(record.id, { ...record, children: [] })
  }
  for (const node of semanticById.values()) {
    const parent = node.parentId ? semanticById.get(node.parentId) : null
    ;(parent ?? root).children.push(node)
  }
  return root
}

function subtreeWeight(node: SemanticNode): number {
  if (node.children.length === 0) return 1
  return Math.max(1, node.children.reduce((sum, child) => sum + subtreeWeight(child), 0))
}

function splitRootBranches(branches: SemanticNode[]) {
  const left: SemanticNode[] = []
  const right: SemanticNode[] = []
  let leftWeight = 0
  let rightWeight = 0

  branches.forEach((branch, index) => {
    const weight = subtreeWeight(branch)
    const putRight =
      branches.length === 1 || rightWeight < leftWeight || (rightWeight === leftWeight && index % 2 === 0)
    if (putRight) {
      right.push(branch)
      rightWeight += weight
    } else {
      left.push(branch)
      leftWeight += weight
    }
  })
  return { left, right }
}

function nodeSize(label: string, depth: number) {
  const chars = Array.from(label).length
  if (depth === 0) return { w: Math.min(286, Math.max(226, chars * 15 + 62)), h: 74 }
  if (depth === 1) return { w: Math.min(238, Math.max(178, chars * 14 + 50)), h: chars > 12 ? 64 : 58 }
  if (depth === 2) return { w: Math.min(218, Math.max(158, chars * 13 + 44)), h: chars > 14 ? 58 : 52 }
  return { w: Math.min(202, Math.max(146, chars * 12 + 40)), h: chars > 14 ? 54 : 48 }
}

function centerDistance(depth: number, width: number) {
  const rootWidth = nodeSize('', 0).w
  if (depth === 1) return rootWidth / 2 + 118 + width / 2
  const firstWidth = 208
  const leafWidth = 184
  return (
    rootWidth / 2 +
    118 +
    firstWidth +
    (depth - 2) * (leafWidth + 82) +
    82 +
    width / 2
  )
}

function placeSide(
  branches: SemanticNode[],
  direction: -1 | 1,
  branchIndexes: Map<string, number>
) {
  if (branches.length === 0) return []
  const virtual: SemanticNode = {
    id: direction < 0 ? '__left__' : '__right__',
    label: '',
    parentId: null,
    children: branches,
  }
  const layout = tree<SemanticNode>()
    .nodeSize([VERTICAL_STEP, 1])
    .separation((a, b) => (a.parent === b.parent ? 1 : 1.22))
  const laidOut = layout(hierarchy(virtual, (node) => node.children))

  return laidOut
    .descendants()
    .filter((entry) => entry.depth > 0)
    .map((entry): PositionedNode => {
      const depth = entry.depth
      const size = nodeSize(entry.data.label, depth)
      const branch = entry.ancestors().find((ancestor) => ancestor.depth === 1)?.data.id
      return {
        node: entry.data,
        depth,
        branchIndex: branchIndexes.get(branch ?? entry.data.id) ?? 0,
        x: direction * centerDistance(depth, size.w) - size.w / 2,
        y: entry.x - size.h / 2,
        ...size,
      }
    })
}

function connectorBetween(
  parent: PositionedNode,
  child: PositionedNode,
  color: string,
  id: string,
  planId: string
): ShapeElement {
  const childIsRight = child.x > parent.x
  const parentPoint = {
    x: childIsRight ? parent.x + parent.w : parent.x,
    y: parent.y + parent.h / 2,
  }
  const childPoint = {
    x: childIsRight ? child.x : child.x + child.w,
    y: child.y + child.h / 2,
  }
  const left = parentPoint.x <= childPoint.x ? parentPoint : childPoint
  const right = parentPoint.x <= childPoint.x ? childPoint : parentPoint
  const top = Math.min(left.y, right.y)

  return {
    id,
    type: 'shape',
    shape: 'curve',
    x: Math.round(left.x),
    y: Math.round(top - 2),
    w: Math.max(8, Math.round(right.x - left.x)),
    h: Math.max(4, Math.round(Math.abs(right.y - left.y) + 4)),
    rotation: 0,
    z: 0,
    stroke: color,
    fill: 'transparent',
    strokeWidth: child.depth === 1 ? 2.6 : 1.8,
    dashed: false,
    flipped: right.y >= left.y,
    opacity: child.depth === 1 ? 0.72 : 0.48,
    visualStyle: 'mind-connector',
    agentMeta: { planId, role: 'created', skill: 'mindmap_hierarchy' },
  }
}

export function buildMindMapDocument(
  plan: MindMapPlan,
  idFactory: () => string
): MindMapBuildResult {
  const root = normalizeMindMapPlan(plan)
  const rootSize = nodeSize(root.label, 0)
  const rootPosition: PositionedNode = {
    node: root,
    depth: 0,
    branchIndex: 0,
    x: -rootSize.w / 2,
    y: -rootSize.h / 2,
    ...rootSize,
  }

  const branchIndexes = new Map<string, number>()
  root.children.forEach((branch, index) => branchIndexes.set(branch.id, index))
  const sides = splitRootBranches(root.children)
  const positioned = [
    rootPosition,
    ...placeSide(sides.left, -1, branchIndexes),
    ...placeSide(sides.right, 1, branchIndexes),
  ]

  const minX = Math.min(...positioned.map((item) => item.x))
  const minY = Math.min(...positioned.map((item) => item.y))
  const shiftX = PAGE_PADDING - minX
  const shiftY = PAGE_PADDING - minY
  positioned.forEach((item) => {
    item.x += shiftX
    item.y += shiftY
  })

  const bySemanticId = new Map(positioned.map((item) => [item.node.id, item]))
  const canvasIds = new Map(positioned.map((item) => [item.node.id, idFactory()]))
  const planId = `mindmap-${canvasIds.get(ROOT_ID)}`
  const elements: CanvasElement[] = []

  for (const child of positioned) {
    if (!child.node.parentId && child.depth !== 1) continue
    const parent = child.depth === 1 ? rootPosition : bySemanticId.get(child.node.parentId ?? '')
    if (!parent) continue
    const color = BRANCH_COLORS[child.branchIndex % BRANCH_COLORS.length]
    elements.push(connectorBetween(parent, child, color, idFactory(), planId))
  }

  const nodeIds: string[] = []
  for (const item of positioned) {
    const id = canvasIds.get(item.node.id)!
    const color = BRANCH_COLORS[item.branchIndex % BRANCH_COLORS.length]
    nodeIds.push(id)
    elements.push({
      id,
      type: 'shape',
      shape: 'rect',
      x: Math.round(item.x),
      y: Math.round(item.y),
      w: Math.round(item.w),
      h: Math.round(item.h),
      rotation: 0,
      z: 0,
      stroke: item.depth === 0 ? 'var(--mind-root-stroke)' : color,
      fill:
        item.depth === 0
          ? 'var(--mind-root-fill)'
          : item.depth === 1
            ? `color-mix(in srgb, ${color} 13%, var(--mind-node-fill))`
            : `color-mix(in srgb, ${color} 4%, var(--mind-node-fill))`,
      strokeWidth: item.depth === 0 ? 0 : item.depth === 1 ? 2 : 1.25,
      dashed: false,
      label: item.node.label,
      visualStyle:
        item.depth === 0 ? 'mind-root' : item.depth === 1 ? 'mind-branch' : 'mind-leaf',
      agentMeta: { planId, role: 'created', skill: 'mindmap_hierarchy' },
    })
  }

  elements.forEach((element, index) => {
    element.z = index + 1
  })

  return {
    doc: { version: 1, background: 'dots', elements, strokes: [] },
    nodeIds,
    nodeCount: positioned.length,
  }
}
