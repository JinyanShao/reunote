// ───────────── 后端数据模型 ─────────────

export interface Notebook {
  id: string
  name: string
  color: string
  icon: string
  sortOrder: number
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

export interface Section {
  id: string
  notebookId: string
  name: string
  color: string
  sortOrder: number
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

export interface PageMeta {
  id: string
  sectionId: string
  notebookId: string
  parentId: string | null
  title: string
  preview: string
  sortOrder: number
  favorite: boolean
  createdAt: number
  updatedAt: number
  deletedAt: number | null
  tags: string[]
}

export interface Page {
  id: string
  sectionId: string
  notebookId: string
  parentId: string | null
  title: string
  content: string
  sortOrder: number
  favorite: boolean
  createdAt: number
  updatedAt: number
  tags: string[]
}

export interface Tag {
  id: string
  name: string
  color: string
  count: number
}

export interface SearchHit {
  pageId: string
  title: string
  snippet: string
  notebookId: string
  notebookName: string
  sectionId: string
  sectionName: string
  updatedAt: number
  score: number
}

export interface VersionMeta {
  id: string
  pageId: string
  title: string
  label: string
  size: number
  createdAt: number
}

export interface Attachment {
  id: string
  pageId: string
  filename: string
  mime: string
  size: number
  url: string
  createdAt: number
}

export interface Backlink {
  pageId: string
  title: string
  notebookName: string
  sectionName: string
  updatedAt: number
}

export interface TrashItem {
  id: string
  kind: 'page' | 'section' | 'notebook'
  title: string
  parentLabel: string
  deletedAt: number
}

export interface Stats {
  notebooks: number
  sections: number
  pages: number
  words: number
  attachments: number
  dbSize: number
  dataDir: string
}

// ───────────── 画布文档 ─────────────

export type ElementKind =
  | 'text'
  | 'sticky'
  | 'image'
  | 'shape'
  | 'file'
  | 'math'
  | 'pdf'
  | 'code'
  | 'audio'

export interface ElementBase {
  id: string
  type: ElementKind
  x: number
  y: number
  w: number
  h: number
  rotation: number
  z: number
  locked?: boolean
  opacity?: number
  /** 标记由画布 Agent 创建的辅助元素，便于后续重排时识别来源。 */
  agentMeta?: {
    planId: string
    role: 'heading' | 'created' | 'positioned'
    sourceId?: string
    sourceBlockIndex?: number
    skill?: string
  }
}

export interface TextElement extends ElementBase {
  type: 'text'
  html: string
  bg: string
  border: string
  fontFamily: 'sans' | 'serif' | 'mono' | 'hand'
  fontScale: number
  padding: number
}

export interface StickyElement extends ElementBase {
  type: 'sticky'
  html: string
  color: string
}

export interface ImageElement extends ElementBase {
  type: 'image'
  src: string
  attachmentId?: string
  alt?: string
  radius: number
  shadow: boolean
}

export type ShapeKind = 'rect' | 'ellipse' | 'diamond' | 'line' | 'curve' | 'arrow' | 'star'

export interface ShapeElement extends ElementBase {
  type: 'shape'
  shape: ShapeKind
  stroke: string
  fill: string
  strokeWidth: number
  dashed: boolean
  label?: string
  /** 语义化外观只影响渲染；旧文档未设置时仍使用普通图形样式。 */
  visualStyle?: 'mind-root' | 'mind-branch' | 'mind-leaf' | 'mind-connector'
  /** 直线 / 箭头：true 表示从左上画到右下，false 表示从左下画到右上 */
  flipped?: boolean
}

export interface FileElement extends ElementBase {
  type: 'file'
  attachmentId: string
  filename: string
  mime: string
  size: number
}

export interface MathElement extends ElementBase {
  type: 'math'
  latex: string
  color: string
  display: boolean
}

export interface PdfElement extends ElementBase {
  type: 'pdf'
  src: string
  attachmentId: string
  page: number
  total: number
  filename: string
}

export interface CodeElement extends ElementBase {
  type: 'code'
  code: string
  language: string
}

export interface AudioElement extends ElementBase {
  type: 'audio'
  attachmentId: string
  src: string
  filename: string
  duration?: number
}

export type CanvasElement =
  | TextElement
  | StickyElement
  | ImageElement
  | ShapeElement
  | FileElement
  | MathElement
  | PdfElement
  | CodeElement
  | AudioElement

export type InkTool = 'pen' | 'highlighter'

export interface Stroke {
  id: string
  points: number[][] // [x, y, pressure]
  color: string
  size: number
  tool: InkTool
  z: number
}

export type BackgroundKind = 'blank' | 'grid' | 'dots' | 'lines' | 'staff'

export interface CanvasDoc {
  version: 1
  background: BackgroundKind
  elements: CanvasElement[]
  strokes: Stroke[]
  viewport?: { x: number; y: number; zoom: number }
}

export const EMPTY_DOC: CanvasDoc = {
  version: 1,
  background: 'grid',
  elements: [],
  strokes: [],
}

export type Tool =
  | 'select'
  | 'hand'
  | 'text'
  | 'sticky'
  | 'pen'
  | 'highlighter'
  | 'eraser'
  | 'lasso'
  | 'rect'
  | 'ellipse'
  | 'diamond'
  | 'line'
  | 'arrow'

// ───────────── AI ─────────────

export interface AiProfile {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
  apiStyle: 'openai' | 'anthropic'
  temperature: number
  maxTokens: number
  timeoutSecs: number
  supportsVision: boolean
}

export interface AiMessage {
  role: 'system' | 'user' | 'assistant'
  content: unknown
}

export interface AiOperationStep {
  id: string
  label: string
  status: 'running' | 'done' | 'error'
}

export interface AiOperationTrace {
  label: string
  status: 'running' | 'done' | 'error'
  steps: AiOperationStep[]
  targetPageId?: string
  targetElementIds?: string[]
}

export interface ChatTurn {
  id: string
  role: 'user' | 'assistant'
  text: string
  reasoning?: string
  pending?: boolean
  stopped?: boolean
  error?: string
  attachments?: { name: string; kind: 'image' | 'document' }[]
  operation?: AiOperationTrace
  createdAt: number
}

export type AiStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'done'; finish: string }
  | { type: 'error'; message: string }

export interface AppSettings {
  theme: 'system' | 'light' | 'dark'
  aiProfiles: AiProfile[]
  activeProfileId: string | null
  autoTitle: boolean
  penColor: string
  penSize: number
  highlighterColor: string
  highlighterSize: number
  defaultBackground: BackgroundKind
  snapEnabled: boolean
  aiContextScope: 'page' | 'section' | 'notebook'
  /** 被手动折叠起来的笔记本 id */
  collapsedNotebooks: string[]
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  aiProfiles: [],
  activeProfileId: null,
  autoTitle: true,
  penColor: '#1f2937',
  penSize: 3,
  highlighterColor: '#facc15',
  highlighterSize: 22,
  defaultBackground: 'grid',
  snapEnabled: true,
  aiContextScope: 'page',
  collapsedNotebooks: [],
}

export interface SearchPreset {
  mode: 'all' | 'favorites' | 'tag'
  tag?: string
}
