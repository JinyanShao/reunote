/**
 * 画布级 AI：让模型理解整页内容，然后由代码把结果落成画布元素。
 * 模型只负责“想”（分组、结构、要点），坐标一律由本地算法计算，
 * 这样即使模型返回的数据不完美，画布也不会被摆得乱七八糟。
 */
import { docToPlainText, newElementId, useApp } from './store'
import { completeJson, complete } from './aiActions'
import { docToMarkdown, markdownToElements } from './exchange'
import { emit } from './bus'
import { buildMindMapDocument, type MindMapPlan } from './mindMap'
import type { CanvasElement, ShapeElement, StickyElement, TextElement } from './types'
import { STICKY_COLORS } from './utils'

const GAP = 28
const COL_GAP = 72

export type AiCanvasProgress = (message: string) => void

function summarizeElement(el: CanvasElement): string {
  switch (el.type) {
    case 'text':
    case 'sticky': {
      const div = document.createElement('div')
      div.innerHTML = el.html
      return (div.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80)
    }
    case 'shape':
      return el.label ? `图形：${el.label}` : `图形（${el.shape}）`
    case 'image':
      return `图片${el.alt ? `：${el.alt}` : ''}`
    case 'pdf':
      return `PDF ${el.filename} 第 ${el.page} 页`
    case 'math':
      return `公式：${el.latex}`
    case 'code':
      return `代码：${el.code.slice(0, 60)}`
    case 'file':
    case 'audio':
      return `附件：${el.filename}`
    default:
      return ''
  }
}

// ───────────── 纯本地：一键整理 ─────────────

/** 不用 AI，按现有阅读顺序把元素排成整齐的列 */
export function tidyLayout(columns = 2) {
  const s = useApp.getState()
  const items = s.doc.elements.filter((e) => !e.locked)
  if (items.length === 0) return 0

  const ordered = items.slice().sort((a, b) => a.y - b.y || a.x - b.x)
  const colWidth = Math.max(...ordered.map((e) => e.w))
  const startX = Math.min(...ordered.map((e) => e.x))
  const startY = Math.min(...ordered.map((e) => e.y))

  const perCol = Math.ceil(ordered.length / columns)
  const positions = new Map<string, { x: number; y: number }>()

  for (let c = 0; c < columns; c++) {
    let y = startY
    const x = startX + c * (colWidth + COL_GAP)
    for (const el of ordered.slice(c * perCol, (c + 1) * perCol)) {
      positions.set(el.id, { x, y })
      y += el.h + GAP
    }
  }

  s.updateDoc((d) => {
    for (const el of d.elements) {
      const p = positions.get(el.id)
      if (p) {
        el.x = Math.round(p.x)
        el.y = Math.round(p.y)
      }
    }
  })
  return ordered.length
}

// ───────────── AI：智能布局 ─────────────

interface LayoutPlan {
  groups: { title: string; ids: string[] }[]
}

/** 让模型按语义给元素分组，再由本地排版成带标题的列 */
export async function smartLayout(
  addHeadings = true,
  onProgress?: AiCanvasProgress
): Promise<string> {
  const s = useApp.getState()
  const items = s.doc.elements.filter((e) => !e.locked)
  if (items.length < 2) throw new Error('画布上至少要有两个元素才能整理')

  onProgress?.('读取并整理画布元素清单')
  const inventory = items
    .map((e) => `${e.id} | ${e.type} | ${summarizeElement(e) || '（无文字）'}`)
    .join('\n')

  onProgress?.('请求模型按语义规划分组')
  const plan = await completeJson<LayoutPlan>(
    '你是信息架构师。给定画布上的元素清单，把它们按主题分成 2–5 组，给每组起一个不超过 8 个字的中文小标题。' +
      '每个元素必须且只能出现在一组里。返回格式：{"groups":[{"title":"标题","ids":["元素id"]}]}',
    `元素清单（格式：id | 类型 | 内容摘要）：\n${inventory}`
  )

  const known = new Set(items.map((e) => e.id))
  const used = new Set<string>()
  const groups = (plan.groups ?? [])
    .map((g) => ({
      title: String(g.title ?? '').slice(0, 12) || '未命名',
      ids: (g.ids ?? []).filter((id) => known.has(id) && !used.has(id) && used.add(id) !== null),
    }))
    .filter((g) => g.ids.length > 0)

  // 模型漏掉的元素统一放进最后一组
  const leftovers = items.filter((e) => !used.has(e.id)).map((e) => e.id)
  if (leftovers.length > 0) groups.push({ title: '其他', ids: leftovers })
  if (groups.length === 0) throw new Error('模型没有给出有效的分组')

  onProgress?.('校验分组并计算列布局')
  const byId = new Map(items.map((e) => [e.id, e]))
  const startX = Math.min(...items.map((e) => e.x))
  const startY = Math.min(...items.map((e) => e.y))
  const headingH = addHeadings ? 52 : 0

  const positions = new Map<string, { x: number; y: number }>()
  const headings: TextElement[] = []
  let x = startX

  for (const g of groups) {
    const colWidth = Math.max(...g.ids.map((id) => byId.get(id)?.w ?? 320))
    let y = startY
    if (addHeadings) {
      headings.push({
        id: newElementId(),
        type: 'text',
        x: Math.round(x),
        y: Math.round(y),
        w: Math.round(colWidth),
        h: 44,
        rotation: 0,
        z: 0,
        html: `<h2>${g.title}</h2>`,
        bg: 'transparent',
        border: 'transparent',
        fontFamily: 'sans',
        fontScale: 1,
        padding: 4,
      })
      y += headingH
    }
    for (const id of g.ids) {
      const el = byId.get(id)
      if (!el) continue
      positions.set(id, { x, y })
      y += el.h + GAP
    }
    x += colWidth + COL_GAP
  }

  onProgress?.('写入新的画布位置和分组标题')
  useApp.getState().updateDoc((d) => {
    for (const el of d.elements) {
      const p = positions.get(el.id)
      if (p) {
        el.x = Math.round(p.x)
        el.y = Math.round(p.y)
      }
    }
    let z = 0
    for (const el of d.elements) z = Math.max(z, el.z)
    headings.forEach((h, i) => d.elements.push({ ...h, z: z + i + 1 }))
  })

  return `已分成 ${groups.length} 组：${groups.map((g) => g.title).join('、')}`
}

// ───────────── AI：思维导图 ─────────────

function canUseLocalDiagramFallback(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return /json|结构化|解析|agent\s*指令|message\.content|最终答案/i.test(message)
}

function localDiagramLabels(material: string, limit: number, maxLength: number) {
  const candidates = material
    .split(/[\n。！？!?；;，,]+/)
    .map((item) =>
      item
        .replace(/^\s*(?:[-+*#>]|\d+[.)、])\s*/, '')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter(Boolean)
  const labels: string[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const label = candidate.slice(0, maxLength)
    const key = label.toLocaleLowerCase()
    if (!label || seen.has(key)) continue
    seen.add(key)
    labels.push(label)
    if (labels.length >= limit) break
  }
  return labels
}

function localDiagramTitle(pageTitle: string, labels: string[], fallback: string) {
  const title = pageTitle.trim()
  if (title && !/^未命名/.test(title)) return title.slice(0, 32)
  return labels[0]?.slice(0, 32) || fallback
}

export async function generateMindMap(
  topicOverride?: string,
  onProgress?: AiCanvasProgress
): Promise<string> {
  const source = useApp.getState()
  const sourcePageId = source.pageId
  const sourceSectionId = source.sectionId
  if (!sourcePageId || !sourceSectionId) throw new Error('请先打开一篇笔记，再生成思维导图')
  const material = topicOverride?.trim() || docToPlainText(source.doc).slice(0, 7000)
  if (!material) throw new Error('当前页面还没有内容，可以先写点东西或直接输入一个主题')

  onProgress?.('读取当前页面并提取主题材料')
  const localPlan = (): MindMapPlan => {
    const labels = localDiagramLabels(material, 16, 20)
    const root =
      topicOverride?.trim().slice(0, 20) || localDiagramTitle(source.title, labels, '主题')
    const pool = labels.filter((label) => label !== root)
    const branchCount = Math.max(1, Math.min(5, Math.ceil(pool.length / 3)))
    const branches = pool.slice(0, branchCount)
    const nodes: MindMapPlan['nodes'] = branches.map((label, index) => ({
      id: `local-branch-${index + 1}`,
      label,
      parent: null,
    }))
    pool.slice(branchCount).forEach((label, index) => {
      nodes.push({
        id: `local-leaf-${index + 1}`,
        label,
        parent: nodes[index % Math.max(1, branches.length)]?.id ?? null,
      })
    })
    return {
      root,
      nodes:
        nodes.length > 0
          ? nodes
          : [{ id: 'local-branch-1', label: material.trim().slice(0, 20), parent: null }],
    }
  }
  let usedLocalFallback = false
  let plan: MindMapPlan
  try {
    onProgress?.('请求模型生成思维导图层级')
    plan = await completeJson<MindMapPlan>(
      '你是结构化思维专家。根据给定内容生成一张单根思维导图：3–6 个一级分支，' +
        '每个一级分支下提炼 2–4 个要点，最多三层，总节点数不超过 24 个。' +
        'root 是唯一根节点；nodes 里绝对不要重复 root。nodes 中 parent=null 表示 root 的直接子节点，' +
        '其余 parent 必须引用 nodes 中另一个节点的 id。避免重复、空泛和近义节点，每个 label 不超过 20 个汉字。' +
        '返回格式：{"root":"根节点文字","nodes":[{"id":"n1","label":"文字","parent":null}]}',
      material
    )
  } catch (error) {
    if (!canUseLocalDiagramFallback(error)) throw error
    usedLocalFallback = true
    onProgress?.('模型结构无法解析，改用本地提纲')
    plan = localPlan()
  }

  if (!Array.isArray(plan.nodes) || plan.nodes.length === 0 || !String(plan.root ?? '').trim()) {
    usedLocalFallback = true
    plan = localPlan()
  }

  onProgress?.('校验层级并计算左右分支布局')
  let built = buildMindMapDocument(plan, newElementId)
  if (built.nodeCount < 2) {
    usedLocalFallback = true
    plan = localPlan()
    built = buildMindMapDocument(plan, newElementId)
  }

  const baseTitle = `${
    source.title.trim() && !/^未命名/.test(source.title) ? source.title.trim() : plan.root
  } · 思维导图`
  const siblingTitles = new Set(
    source.pages.filter((page) => page.parentId === sourcePageId).map((page) => page.title)
  )
  let childTitle = baseTitle
  for (let suffix = 2; siblingTitles.has(childTitle); suffix += 1) {
    childTitle = `${baseTitle} ${suffix}`
  }

  onProgress?.('保存原笔记并创建思维导图子页面')
  const targetPageId = await useApp
    .getState()
    .createChildPageWithDoc(childTitle, sourcePageId, built.doc)
  if (!targetPageId) throw new Error('无法创建思维导图子页面')

  const target = useApp.getState()
  if (target.pageId !== targetPageId) throw new Error('思维导图已创建，但目标页面未能打开')
  target.setSelection(built.nodeIds)
  onProgress?.('打开子页面并定位思维导图')
  emit({ type: 'reveal-elements', ids: built.nodeIds })

  return `${
    usedLocalFallback ? '模型结构化输出不可用，已用本地提纲生成' : '已生成'
  } ${built.nodeCount} 个节点，并保存到子页面「${childTitle}」；原笔记保持不变`
}

// ───────────── AI：流程图 / 关系示意图 ─────────────

interface FlowchartPlan {
  title?: string
  nodes: { id: string; label: string; type?: 'start' | 'process' | 'decision' | 'end' }[]
  edges: { from: string; to: string; label?: string }[]
}

interface ConceptDiagramPlan {
  title?: string
  nodes: { id: string; label: string; kind?: 'core' | 'person' | 'system' | 'idea' }[]
  links: { from: string; to: string; label?: string }[]
}

type PositionedNode = { x: number; y: number; w: number; h: number }

function diagramOrigin(elements: CanvasElement[]) {
  return {
    x: elements.length ? Math.min(...elements.map((element) => element.x)) : 120,
    y: elements.length ? Math.max(...elements.map((element) => element.y + element.h)) + 90 : 120,
  }
}

function connector(
  from: PositionedNode,
  to: PositionedNode,
  shape: 'line' | 'arrow',
  stroke = '#64748b'
): ShapeElement {
  const ax = from.x + from.w / 2
  const ay = from.y + from.h / 2
  const bx = to.x + to.w / 2
  const by = to.y + to.h / 2
  const startsLeft = ax <= bx
  const startsTop = ay <= by
  return {
    id: newElementId(),
    type: 'shape',
    shape,
    x: Math.round(Math.min(ax, bx)),
    y: Math.round(Math.min(ay, by)),
    w: Math.max(4, Math.round(Math.abs(bx - ax))),
    h: Math.max(4, Math.round(Math.abs(by - ay))),
    rotation: startsLeft ? 0 : 180,
    z: 0,
    stroke,
    fill: 'transparent',
    strokeWidth: 1.8,
    dashed: false,
    flipped: startsLeft === startsTop,
  }
}

function heading(text: string, x: number, y: number, width: number): TextElement {
  return {
    id: newElementId(),
    type: 'text',
    x: Math.round(x),
    y: Math.round(y),
    w: Math.round(width),
    h: 52,
    rotation: 0,
    z: 0,
    html: `<h2>${escapeHtml(text)}</h2>`,
    bg: 'transparent',
    border: 'transparent',
    fontFamily: 'sans',
    fontScale: 1,
    padding: 4,
  }
}

function appendDiagram(elements: CanvasElement[], selectableIds: string[]) {
  useApp.getState().updateDoc((doc) => {
    let z = Math.max(0, ...doc.elements.map((element) => element.z))
    for (const element of elements) doc.elements.push({ ...element, z: ++z })
  })
  useApp.getState().setSelection(selectableIds)
  if (selectableIds.length > 0) emit({ type: 'reveal-elements', ids: selectableIds })
}

export async function generateFlowchart(onProgress?: AiCanvasProgress): Promise<string> {
  const state = useApp.getState()
  const material = docToPlainText(state.doc).slice(0, 8000)
  if (!material.trim()) throw new Error('当前页面还没有可整理的文字内容')

  onProgress?.('读取当前页面并提取流程信息')
  const localPlan = (): FlowchartPlan => {
    const labels = localDiagramLabels(material, 10, 24)
    const steps = labels.length ? labels : [material.trim().slice(0, 24)]
    const nodes = steps.map((label, index) => ({
      id: `local-${index + 1}`,
      label,
      type: (index === 0
        ? 'start'
        : index === steps.length - 1
          ? 'end'
          : /如果|是否|判断|否则|\?$|？$/.test(label)
            ? 'decision'
            : 'process') as 'start' | 'process' | 'decision' | 'end',
    }))
    return {
      title: localDiagramTitle(state.title, labels, '流程图'),
      nodes,
      edges: nodes.slice(1).map((node, index) => ({ from: nodes[index].id, to: node.id })),
    }
  }
  let usedLocalFallback = false
  let plan: FlowchartPlan
  try {
    onProgress?.('请求模型生成流程节点与关系')
    plan = await completeJson<FlowchartPlan>(
      '你是业务流程分析师。把笔记整理成一张自上而下的流程图，总节点不超过 14 个。' +
        '节点 type 只能是 start、process、decision、end；节点文字不超过 18 个汉字。' +
        '判断节点可通过边的 label 标注条件。返回格式：' +
        '{"title":"流程名称","nodes":[{"id":"n1","label":"开始","type":"start"}],' +
        '"edges":[{"from":"n1","to":"n2","label":"条件"}]}',
      material
    )
  } catch (error) {
    if (!canUseLocalDiagramFallback(error)) throw error
    usedLocalFallback = true
    onProgress?.('模型结构无法解析，改用本地流程提纲')
    plan = localPlan()
  }

  const seen = new Set<string>()
  let nodes = (plan.nodes ?? [])
    .filter((node) => node?.id && node?.label && !seen.has(node.id) && seen.add(node.id))
    .slice(0, 14)
    .map((node, index) => ({
      id: node.id,
      label: String(node.label).slice(0, 24),
      type: node.type ?? (index === 0 ? 'start' : index === (plan.nodes?.length ?? 1) - 1 ? 'end' : 'process'),
    }))
  if (nodes.length === 0) {
    usedLocalFallback = true
    plan = localPlan()
    nodes = plan.nodes.map((node) => ({
      id: node.id,
      label: String(node.label).slice(0, 24),
      type: node.type ?? 'process',
    }))
  }

  onProgress?.('校验流程并计算节点层级')
  const known = new Set(nodes.map((node) => node.id))
  let edges = (plan.edges ?? [])
    .filter((edge) => known.has(edge.from) && known.has(edge.to) && edge.from !== edge.to)
    .slice(0, 24)
  if (edges.length === 0) {
    edges = nodes.slice(1).map((node, index) => ({ from: nodes[index].id, to: node.id }))
  }

  const indegree = new Map(nodes.map((node) => [node.id, 0]))
  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]))
  for (const edge of edges) {
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1)
    outgoing.get(edge.from)?.push(edge.to)
  }
  const levels = new Map(nodes.map((node) => [node.id, 0]))
  const queue = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id)
  if (queue.length === 0) queue.push(nodes[0].id)
  const processed = new Set<string>()
  while (queue.length > 0) {
    const id = queue.shift()!
    if (processed.has(id)) continue
    processed.add(id)
    for (const next of outgoing.get(id) ?? []) {
      levels.set(next, Math.max(levels.get(next) ?? 0, (levels.get(id) ?? 0) + 1))
      indegree.set(next, (indegree.get(next) ?? 1) - 1)
      if (indegree.get(next) === 0) queue.push(next)
    }
  }
  for (const node of nodes) {
    if (!processed.has(node.id)) levels.set(node.id, Math.max(...levels.values()) + 1)
  }

  const origin = diagramOrigin(state.doc.elements)
  const nodeW = 220
  const nodeH = 78
  const xGap = 76
  const yGap = 104
  const byLevel = new Map<number, typeof nodes>()
  for (const node of nodes) {
    const level = levels.get(node.id) ?? 0
    byLevel.set(level, (byLevel.get(level) ?? []).concat(node))
  }
  const maxWidth = Math.max(
    ...Array.from(byLevel.values()).map((items) => items.length * nodeW + (items.length - 1) * xGap)
  )
  const positions = new Map<string, PositionedNode>()
  for (const [level, items] of Array.from(byLevel.entries()).sort((a, b) => a[0] - b[0])) {
    const rowWidth = items.length * nodeW + (items.length - 1) * xGap
    const rowX = origin.x + (maxWidth - rowWidth) / 2
    items.forEach((node, index) =>
      positions.set(node.id, {
        x: rowX + index * (nodeW + xGap),
        y: origin.y + 70 + level * (nodeH + yGap),
        w: nodeW,
        h: nodeH,
      })
    )
  }

  const created: CanvasElement[] = []
  const title = String(plan.title ?? '流程图').slice(0, 32)
  created.push(heading(title, origin.x, origin.y, Math.max(420, maxWidth)))
  for (const edge of edges) {
    const from = positions.get(edge.from)
    const to = positions.get(edge.to)
    if (from && to) created.push(connector(from, to, 'arrow'))
  }

  const nodeIds: string[] = []
  for (const node of nodes) {
    const position = positions.get(node.id)!
    const style =
      node.type === 'start'
        ? { shape: 'ellipse' as const, stroke: '#059669', fill: '#ecfdf5' }
        : node.type === 'decision'
          ? { shape: 'diamond' as const, stroke: '#d97706', fill: '#fffbeb' }
          : node.type === 'end'
            ? { shape: 'ellipse' as const, stroke: '#dc2626', fill: '#fef2f2' }
            : { shape: 'rect' as const, stroke: '#2563eb', fill: '#eff6ff' }
    const id = newElementId()
    nodeIds.push(id)
    created.push({
      id,
      type: 'shape',
      ...position,
      rotation: 0,
      z: 0,
      ...style,
      strokeWidth: 2,
      dashed: false,
      label: node.label,
    })
  }
  onProgress?.('写入流程图节点并准备定位')
  appendDiagram(created, nodeIds)
  return `${usedLocalFallback ? '模型结构化输出不可用，已用本地提纲生成' : '已生成'} ${nodes.length} 个节点的流程图「${title}」`
}

export async function generateConceptDiagram(onProgress?: AiCanvasProgress): Promise<string> {
  const state = useApp.getState()
  const material = docToPlainText(state.doc).slice(0, 8000)
  if (!material.trim()) throw new Error('当前页面还没有可整理的文字内容')

  onProgress?.('读取当前页面并提取核心概念')
  const localPlan = (): ConceptDiagramPlan => {
    const labels = localDiagramLabels(material, 9, 20)
    const core = localDiagramTitle(state.title, labels, '中心主题').slice(0, 20)
    const related = labels.filter((label) => label !== core).slice(0, 8)
    const nodes = [
      { id: 'local-core', label: core, kind: 'core' as const },
      ...(related.length ? related : [material.trim().slice(0, 20)]).map((label, index) => ({
        id: `local-${index + 1}`,
        label,
        kind: 'idea' as const,
      })),
    ]
    return {
      title: core,
      nodes,
      links: nodes.slice(1).map((node) => ({ from: nodes[0].id, to: node.id })),
    }
  }
  let usedLocalFallback = false
  let plan: ConceptDiagramPlan
  try {
    onProgress?.('请求模型分析概念之间的关系')
    plan = await completeJson<ConceptDiagramPlan>(
      '你是信息可视化设计师。把笔记总结为一张关系示意图：第一个节点是中心主题，其余是关键对象、' +
        '系统或概念，总节点不超过 11 个。节点文字不超过 16 个汉字，关系标签不超过 8 个汉字。' +
        '返回格式：{"title":"图名","nodes":[{"id":"n1","label":"中心主题","kind":"core"}],' +
        '"links":[{"from":"n1","to":"n2","label":"关系"}]}',
      material
    )
  } catch (error) {
    if (!canUseLocalDiagramFallback(error)) throw error
    usedLocalFallback = true
    onProgress?.('模型结构无法解析，改用本地关系提纲')
    plan = localPlan()
  }

  const seen = new Set<string>()
  let nodes = (plan.nodes ?? [])
    .filter((node) => node?.id && node?.label && !seen.has(node.id) && seen.add(node.id))
    .slice(0, 11)
    .map((node, index) => ({ ...node, label: String(node.label).slice(0, 20), kind: index === 0 ? 'core' : node.kind }))
  if (nodes.length < 2) {
    usedLocalFallback = true
    plan = localPlan()
    nodes = plan.nodes.map((node, index) => ({
      ...node,
      label: String(node.label).slice(0, 20),
      kind: index === 0 ? ('core' as const) : node.kind,
    }))
  }

  onProgress?.('计算中心节点、关系连线和环形布局')
  const known = new Set(nodes.map((node) => node.id))
  let links = (plan.links ?? [])
    .filter((link) => known.has(link.from) && known.has(link.to) && link.from !== link.to)
    .slice(0, 22)
  if (links.length === 0) {
    links = nodes.slice(1).map((node) => ({ from: nodes[0].id, to: node.id }))
  }

  const origin = diagramOrigin(state.doc.elements)
  const center = { x: origin.x + 470, y: origin.y + 300 }
  const nodeW = 190
  const nodeH = 72
  const radiusX = Math.max(320, (nodes.length - 1) * 42)
  const radiusY = Math.max(210, (nodes.length - 1) * 24)
  const positions = new Map<string, PositionedNode>()
  positions.set(nodes[0].id, { x: center.x - 115, y: center.y - 45, w: 230, h: 90 })
  nodes.slice(1).forEach((node, index, others) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / others.length
    positions.set(node.id, {
      x: center.x + Math.cos(angle) * radiusX - nodeW / 2,
      y: center.y + Math.sin(angle) * radiusY - nodeH / 2,
      w: nodeW,
      h: nodeH,
    })
  })

  const created: CanvasElement[] = []
  const title = String(plan.title ?? '关系示意图').slice(0, 32)
  created.push(heading(title, origin.x, origin.y, 940))
  for (const link of links) {
    const from = positions.get(link.from)
    const to = positions.get(link.to)
    if (from && to) created.push(connector(from, to, 'line', '#94a3b8'))
  }

  const palette = [
    { stroke: '#0891b2', fill: '#ecfeff' },
    { stroke: '#16a34a', fill: '#f0fdf4' },
    { stroke: '#d97706', fill: '#fffbeb' },
    { stroke: '#db2777', fill: '#fdf2f8' },
  ]
  const nodeIds: string[] = []
  nodes.forEach((node, index) => {
    const position = positions.get(node.id)!
    const style = index === 0 ? { stroke: '#4f46e5', fill: '#eef2ff' } : palette[(index - 1) % palette.length]
    const id = newElementId()
    nodeIds.push(id)
    created.push({
      id,
      type: 'shape',
      shape: index === 0 ? 'rect' : node.kind === 'idea' ? 'ellipse' : node.kind === 'system' ? 'diamond' : 'rect',
      ...position,
      rotation: 0,
      z: 0,
      ...style,
      strokeWidth: index === 0 ? 2.4 : 1.8,
      dashed: false,
      label: node.label,
    })
  })
  onProgress?.('写入关系示意图并准备定位')
  appendDiagram(created, nodeIds)
  return `${usedLocalFallback ? '模型结构化输出不可用，已用本地提纲生成' : '已生成'} ${nodes.length} 个节点的关系示意图「${title}」`
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ───────────── AI：便签墙 ─────────────

interface StickyPlan {
  notes: { text: string }[]
}

export async function generateStickyWall(onProgress?: AiCanvasProgress): Promise<string> {
  const s = useApp.getState()
  const material = docToPlainText(s.doc).slice(0, 6000)
  if (!material.trim()) throw new Error('当前页面还没有内容')

  onProgress?.('读取当前页面并收集可拆分要点')
  onProgress?.('请求模型拆分独立便签')
  const plan = await completeJson<StickyPlan>(
    '你是笔记整理助手。把内容拆成 4–10 条互相独立的要点便签，每条不超过 40 个汉字。' +
      '返回格式：{"notes":[{"text":"要点"}]}',
    material
  )

  const notes = (plan.notes ?? []).map((n) => String(n.text ?? '').trim()).filter(Boolean)
  if (notes.length === 0) throw new Error('模型没有生成有效的便签')

  onProgress?.('计算便签墙网格与颜色')
  const existing = s.doc.elements
  const baseX = existing.length > 0 ? Math.min(...existing.map((e) => e.x)) : 120
  const baseY = existing.length > 0 ? Math.max(...existing.map((e) => e.y + e.h)) + 80 : 120

  const W = 210
  const H = 170
  const perRow = 4
  const created: StickyElement[] = notes.map((text, i) => ({
    id: newElementId(),
    type: 'sticky',
    x: Math.round(baseX + (i % perRow) * (W + 24)),
    y: Math.round(baseY + Math.floor(i / perRow) * (H + 24)),
    w: W,
    h: H,
    rotation: (i % 3) - 1,
    z: 0,
    html: `<p>${text.replace(/</g, '&lt;')}</p>`,
    color: STICKY_COLORS[i % STICKY_COLORS.length],
  }))

  onProgress?.('写入便签并准备定位')
  useApp.getState().updateDoc((d) => {
    let z = 0
    for (const el of d.elements) z = Math.max(z, el.z)
    created.forEach((el, i) => d.elements.push({ ...el, z: z + i + 1 }))
  })

  return `已生成 ${created.length} 张便签`
}

// ───────────── AI：整页翻译成新页面 ─────────────

export async function translatePageToNewPage(
  langLabel: string,
  onProgress?: AiCanvasProgress
): Promise<string> {
  const s = useApp.getState()
  onProgress?.('读取当前页面并转换为结构化文本')
  const md = docToMarkdown(s.doc, s.title)
  if (md.trim().length < 10) throw new Error('当前页面内容太少')

  onProgress?.(`请求模型翻译为${langLabel}`)
  const translated = await complete(
    `你是专业译者。把用户给的 Markdown 文档翻译成${langLabel}，保持所有 Markdown 结构与格式不变。只输出译文。`,
    md
  )

  onProgress?.('创建译文页面并恢复画布结构')
  const newTitle = `${s.title || '未命名页面'}（${langLabel}）`
  const id = await useApp.getState().newPage(newTitle)
  if (!id) throw new Error('创建新页面失败')

  useApp.getState().updateDoc((d) => {
    d.elements = markdownToElements(translated)
  })
  await useApp.getState().save(true)
  return `已生成新页面「${newTitle}」`
}

// ───────────── AI：把整页扩写成文章 ─────────────

export async function draftFromPage(onProgress?: AiCanvasProgress): Promise<string> {
  const s = useApp.getState()
  onProgress?.('读取当前页面并提取文章素材')
  const material = docToPlainText(s.doc).slice(0, 8000)
  if (!material.trim()) throw new Error('当前页面还没有内容')

  onProgress?.('请求模型组织文章结构和正文')
  const article = await complete(
    '你是写作助手。请始终使用简体中文。把用户提供的零散笔记整理成一篇结构完整、可以直接阅读的文章，' +
      '使用 Markdown 标题和段落。不要编造事实，只对已有信息做组织和衔接。只输出正文。',
    material
  )

  onProgress?.('创建成稿页面并恢复画布结构')
  const newTitle = `${s.title || '未命名页面'} · 成稿`
  const id = await useApp.getState().newPage(newTitle)
  if (!id) throw new Error('创建新页面失败')
  useApp.getState().updateDoc((d) => {
    d.elements = markdownToElements(article)
  })
  await useApp.getState().save(true)
  return `已生成新页面「${newTitle}」`
}
