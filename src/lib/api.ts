import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { Channel } from '@tauri-apps/api/core'
import { hasTauri, mockInvoke } from './mockBackend'
import type {
  AiMessage,
  AiProfile,
  AiStreamEvent,
  Attachment,
  Backlink,
  Notebook,
  Page,
  PageMeta,
  SearchHit,
  Section,
  Stats,
  Tag,
  TrashItem,
  VersionMeta,
} from './types'

export interface AgentPageClone {
  sourcePageId: string
  draftPageId: string
}

export interface AgentSectionDuplicateResult {
  sourceSection: Section
  draftSection: Section
  pageMap: AgentPageClone[]
  currentDraftPageId: string | null
  sourceSnapshot: string
}

export interface AgentSectionAdoptResult {
  sourceSection: Section
  backupSectionId: string
  currentPageId: string | null
  adoptedPageIds: string[]
}

/** 打包成 App 时走 Rust 后端；纯浏览器预览时走内存实现 */
function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (hasTauri()) return tauriInvoke<T>(cmd, args)
  return mockInvoke<T>(cmd, args ?? {})
}

// ───────────── 笔记本 / 分区 / 页面 ─────────────

export const listNotebooks = () => invoke<Notebook[]>('notebooks_list')
export const createNotebook = (name: string, color?: string, icon?: string) =>
  invoke<Notebook>('notebook_create', { name, color, icon })
export const updateNotebook = (args: {
  id: string
  name?: string
  color?: string
  icon?: string
  sortOrder?: number
}) => invoke<void>('notebook_update', args)
export const deleteNotebook = (id: string) => invoke<void>('notebook_delete', { id })

export const listSections = (notebookId: string) =>
  invoke<Section[]>('sections_list', { notebookId })
export const createSection = (notebookId: string, name: string, color?: string) =>
  invoke<Section>('section_create', { notebookId, name, color })
export const updateSection = (args: {
  id: string
  name?: string
  color?: string
  sortOrder?: number
  notebookId?: string
}) => invoke<void>('section_update', args)
export const deleteSection = (id: string) => invoke<void>('section_delete', { id })
export const duplicateSectionForAgent = (sourceSectionId: string, currentPageId?: string | null) =>
  invoke<AgentSectionDuplicateResult>('section_duplicate_for_agent', {
    sourceSectionId,
    currentPageId: currentPageId ?? null,
  })
export const adoptAgentDraft = (
  sourceSectionId: string,
  draftSectionId: string,
  expectedSnapshot: string,
  currentPageId?: string | null
) =>
  invoke<AgentSectionAdoptResult>('section_adopt_agent_draft', {
    sourceSectionId,
    draftSectionId,
    expectedSnapshot,
    currentPageId: currentPageId ?? null,
  })

export const listPages = (sectionId: string) => invoke<PageMeta[]>('pages_list', { sectionId })
export const getPage = (id: string) => invoke<Page | null>('page_get', { id })
export const createPage = (
  sectionId: string,
  title: string,
  content: string,
  parentId?: string | null
) => invoke<PageMeta>('page_create', { sectionId, title, content, parentId: parentId ?? null })
export const savePage = (payload: {
  id: string
  title: string
  content: string
  plainText: string
  links: string[]
  tags: string[]
}) => invoke<number>('page_save', { payload })
export const updatePageMeta = (args: {
  id: string
  title?: string
  favorite?: boolean
  sortOrder?: number
  sectionId?: string
  parentId?: string | null
}) => invoke<void>('page_update_meta', args)
export const deletePage = (id: string) => invoke<void>('page_delete', { id })
export const duplicatePage = (id: string) => invoke<string>('page_duplicate', { id })

// ───────────── 搜索 / 关系 ─────────────

export const search = (args: {
  query: string
  notebookId?: string | null
  tag?: string | null
  favoritesOnly?: boolean
  limit?: number
}) => invoke<SearchHit[]>('search', args)
export const recentPages = (limit = 20) => invoke<SearchHit[]>('recent_pages', { limit })
export const backlinksOf = (pageId: string) => invoke<Backlink[]>('backlinks', { pageId })
export const pageByTitle = (title: string) => invoke<string | null>('page_by_title', { title })
export const listTags = () => invoke<Tag[]>('tags_list')
export const setTagColor = (id: string, color: string) => invoke<void>('tag_set_color', { id, color })
export const pagesByTag = (tag: string) => invoke<SearchHit[]>('pages_by_tag', { tag })
export const listFavorites = () => invoke<SearchHit[]>('favorites_list')

// ───────────── 版本 ─────────────

export const createVersion = (pageId: string, label?: string) =>
  invoke<VersionMeta>('version_create', { pageId, label })
export const listVersions = (pageId: string) => invoke<VersionMeta[]>('versions_list', { pageId })
export const versionContent = (id: string) => invoke<string>('version_content', { id })

// ───────────── 附件 / 文件 ─────────────

export const saveAttachment = (pageId: string, filename: string, dataBase64: string) =>
  invoke<Attachment>('attachment_save', { pageId, filename, dataBase64 })
export const readAttachment = (id: string) => invoke<string>('attachment_read', { id })
export const deleteAttachment = (id: string) => invoke<void>('attachment_delete', { id })
export const exportAttachment = (id: string, targetPath: string) =>
  invoke<void>('attachment_export', { id, targetPath })

export const readFileBase64 = (path: string) => invoke<string>('read_file_base64', { path })
export const readFileText = (path: string) => invoke<string>('read_file_text', { path })
export const writeFileText = (path: string, contents: string) =>
  invoke<void>('write_file_text', { path, contents })
export const writeFileBase64 = (path: string, dataBase64: string) =>
  invoke<void>('write_file_base64', { path, dataBase64 })

// ───────────── 回收站 / 设置 / 备份 ─────────────

export const listTrash = () => invoke<TrashItem[]>('trash_list')
export const restoreTrash = (kind: string, id: string) => invoke<void>('trash_restore', { kind, id })
export const purgeTrash = (kind: string, id: string) => invoke<void>('trash_purge', { kind, id })
export const emptyTrash = () => invoke<void>('trash_empty')

export const getSetting = (key: string) => invoke<string | null>('setting_get', { key })
export const setSetting = (key: string, value: string) => invoke<void>('setting_set', { key, value })
export const getStats = () => invoke<Stats>('stats')
export const openDataDir = () => invoke<void>('open_data_dir')
export const completeAppExit = () => invoke<void>('complete_exit')
export const isExitRequestPending = () => invoke<boolean>('exit_request_pending')

export const backupExport = (path: string, includeAttachments: boolean) =>
  invoke<number>('backup_export', { path, includeAttachments })
export const backupImport = (path: string) => invoke<number>('backup_import', { path })

// ───────────── AI ─────────────

function toConfig(p: AiProfile, jsonMode = false) {
  return {
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    model: p.model,
    temperature: p.temperature,
    maxTokens: p.maxTokens,
    apiStyle: p.apiStyle,
    timeoutSecs: p.timeoutSecs,
    ...(jsonMode ? { jsonMode: true } : {}),
  }
}

export function aiChat(
  profile: AiProfile,
  messages: AiMessage[],
  requestId: string,
  onEvent: (e: AiStreamEvent) => void
) {
  const channel = new Channel<AiStreamEvent>()
  channel.onmessage = onEvent
  return invoke<void>('ai_chat', {
    config: toConfig(profile),
    messages,
    requestId,
    onEvent: channel,
  })
}

export const aiCancel = (requestId: string) => invoke<void>('ai_cancel', { requestId })
export const aiComplete = (profile: AiProfile, messages: AiMessage[], jsonMode = false) =>
  invoke<string>('ai_complete', { config: toConfig(profile, jsonMode), messages })
export const aiModels = (profile: AiProfile) =>
  invoke<string[]>('ai_models', { config: toConfig(profile) })
export const aiTest = (profile: AiProfile) => invoke<string>('ai_test', { config: toConfig(profile) })
