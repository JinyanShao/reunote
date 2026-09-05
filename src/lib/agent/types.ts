import type { AiChatAttachment } from '../aiAttachments'
import type { CanvasDoc } from '../types'

export type CanvasAgentScope = 'selection' | 'page'

export type CanvasAgentSkillId =
  | 'balanced_grid'
  | 'reading_columns'
  | 'kanban_board'
  | 'timeline'
  | 'formula_companion'

export type CanvasAgentToolName =
  | 'arrange'
  | 'group_layout'
  | 'align'
  | 'distribute'
  | 'place_relative'
  | 'resize'
  | 'create'
  | 'create_math'
  | 'normalize_math'
  | 'embed_math'
  | 'update_math'
  | 'layout_math'
  | 'update_text_segment'
  | 'set_style'
  | 'set_background'

export interface CanvasAgentStage {
  id: string
  index: number
  title: string
  objective: string
  targetElementIds: string[]
  skill?: CanvasAgentSkillId
}

export interface CanvasAgentWorkflow {
  id: string
  title: string
  summary: string
  stages: CanvasAgentStage[]
}

export interface CanvasAgentStep {
  index: number
  tool: CanvasAgentToolName
  reason: string
  observation: string
  stageId?: string
  stageIndex?: number
}

export interface CanvasAgentStepStart {
  workflowId: string
  stage: CanvasAgentStage
  stepIndex: number
  tool: CanvasAgentToolName
  reason: string
  activeElementIds: string[]
  activeStrokeIds: string[]
}

export interface CanvasAgentStepDelta extends CanvasAgentStepStart {
  doc: CanvasDoc
  step: CanvasAgentStep
  changedElementIds: string[]
  createdElementIds: string[]
  deletedElementIds: string[]
  changedStrokeIds: string[]
  backgroundChanged: boolean
}

export interface CanvasAgentProgress {
  id: string
  phase: 'thinking' | 'inspect' | 'plan' | 'tool' | 'done' | 'error'
  text: string
}

export interface CanvasAgentDraft {
  doc: CanvasDoc
  allowedElementIds: string[]
  inkGroups: Record<string, string[]>
  createdElementIds: string[]
  deletedElementIds: string[]
  planId: string
}

export interface CanvasAgentPreview {
  pageId: string
  baseRev: number
  prompt: string
  scope: CanvasAgentScope
  before: CanvasDoc
  after: CanvasDoc
  summary: string
  steps: CanvasAgentStep[]
  changedElementIds: string[]
  createdElementIds: string[]
  deletedElementIds: string[]
  changedStrokeIds: string[]
  backgroundChanged: boolean
  workflow?: CanvasAgentWorkflow
}

export interface CanvasAgentHistoryMessage {
  role: 'user' | 'assistant'
  content: string
  createdAt?: number
}

export interface CanvasAgentRunInput {
  pageId: string
  baseRev: number
  prompt: string
  scope: CanvasAgentScope
  doc: CanvasDoc
  selectedElementIds: string[]
  selectedStrokeIds: string[]
  history?: CanvasAgentHistoryMessage[]
  attachments?: AiChatAttachment[]
}

export interface CanvasAgentRunOptions {
  onProgress?: (progress: CanvasAgentProgress) => void
  onWorkflow?: (workflow: CanvasAgentWorkflow) => void
  onStepStart?: (step: CanvasAgentStepStart) => void
  onStepCommitted?: (delta: CanvasAgentStepDelta) => void
  onLiveDoc?: (doc: CanvasDoc, delta: CanvasAgentStepDelta) => void
  onAttachmentContext?: (context: string) => void
  isCancelled?: () => boolean
}
