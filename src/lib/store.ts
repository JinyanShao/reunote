import { create } from 'zustand'
import * as api from './api'
import {
  DEFAULT_SETTINGS,
  EMPTY_DOC,
  type AppSettings,
  type CanvasDoc,
  type CanvasElement,
  type Notebook,
  type PageMeta,
  type SearchHit,
  type SearchPreset,
  type Section,
  type Stroke,
  type Tag,
  type Tool,
} from './types'
import { debounce, extractHashTags, extractWikiLinks, htmlToText, uid } from './utils'
import { buildWelcome } from './seed'
import { selectRestoredSession, type RestoredSession } from './sessionSelection'

const SETTINGS_KEY = 'app.settings'
const LAST_OPEN_KEY = 'app.lastOpen'

export const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T

export interface Viewport {
  x: number
  y: number
  zoom: number
}

type PanelKind = 'backlinks' | 'versions' | 'trash' | 'tags' | null

interface AppStore {
  ready: boolean
  notebooks: Notebook[]
  sections: Section[]
  pages: PageMeta[]
  tags: Tag[]
  recents: SearchHit[]

  notebookId: string | null
  sectionId: string | null
  pageId: string | null

  title: string
  doc: CanvasDoc
  viewport: Viewport
  tool: Tool
  selection: string[]
  strokeSelection: string[]
  editingId: string | null

  past: CanvasDoc[]
  future: CanvasDoc[]

  dirty: boolean
  saving: boolean
  documentLocked: boolean
  lastSaved: number
  /** 单调递增的修订号：每次编辑 +1，用于识别「保存期间又产生了新编辑」 */
  rev: number

  settings: AppSettings

  sidebarOpen: boolean
  aiOpen: boolean
  searchOpen: boolean
  findOpen: boolean
  settingsOpen: boolean
  shortcutsOpen: boolean
  panel: PanelKind
  /** 打开搜索面板时的预设筛选条件（点标签、点收藏时用） */
  searchPreset: SearchPreset | null

  bootstrap: () => Promise<void>
  refreshTree: () => Promise<void>
  selectNotebook: (id: string) => Promise<boolean>
  selectSection: (id: string) => Promise<boolean>
  openPage: (id: string) => Promise<void>

  newNotebook: (name?: string) => Promise<void>
  newSection: (name?: string) => Promise<void>
  newPage: (title?: string, parentId?: string | null) => Promise<string | null>
  createChildPageWithDoc: (
    title: string,
    parentId: string,
    doc: CanvasDoc
  ) => Promise<string | null>
  renameNotebook: (id: string, name: string) => Promise<void>
  renameSection: (id: string, name: string) => Promise<void>
  renamePage: (id: string, title: string) => Promise<void>
  removePage: (id: string) => Promise<void>
  toggleFavorite: (id: string) => Promise<void>

  setTitle: (t: string) => void
  updateDoc: (fn: (d: CanvasDoc) => void, record?: boolean) => void
  replaceDoc: (d: CanvasDoc, record?: boolean) => void
  addElement: (el: CanvasElement) => void
  patchElement: (id: string, patch: Partial<CanvasElement>, record?: boolean) => void
  removeElements: (ids: string[]) => void
  addStroke: (s: Stroke) => void
  removeStrokes: (ids: string[]) => void
  bringToFront: (ids: string[]) => void
  sendToBack: (ids: string[]) => void

  undo: () => void
  redo: () => void

  setSelection: (ids: string[]) => void
  setStrokeSelection: (ids: string[]) => void
  setEditing: (id: string | null) => void
  setTool: (t: Tool) => void
  setViewport: (v: Viewport | ((prev: Viewport) => Viewport)) => void

  save: (force?: boolean) => Promise<boolean>
  scheduleSave: () => void

  patchSettings: (patch: Partial<AppSettings>) => void

  setUI: (
    patch: Partial<
      Pick<
        AppStore,
        | 'sidebarOpen'
        | 'aiOpen'
        | 'searchOpen'
        | 'findOpen'
        | 'settingsOpen'
        | 'shortcutsOpen'
        | 'panel'
        | 'searchPreset'
      >
    >
  ) => void
  openSearch: (preset?: SearchPreset) => void
  toggleNotebookCollapsed: (id: string) => void
  refreshTags: () => Promise<void>
}

const HISTORY_LIMIT = 120

function nextZ(doc: CanvasDoc) {
  let max = 0
  for (const e of doc.elements) max = Math.max(max, e.z)
  for (const s of doc.strokes) max = Math.max(max, s.z)
  return max + 1
}

/** 把画布内容压成可搜索 / 可喂给 AI 的纯文本 */
export function docToPlainText(doc: CanvasDoc): string {
  const parts: string[] = []
  const sorted = doc.elements.slice().sort((a, b) => a.y - b.y || a.x - b.x)
  for (const el of sorted) {
    switch (el.type) {
      case 'text':
      case 'sticky':
        parts.push(htmlToText(el.html))
        break
      case 'shape':
        if (el.label) parts.push(el.label)
        break
      case 'math':
        parts.push(el.latex)
        break
      case 'code':
        parts.push(el.code)
        break
      case 'file':
        parts.push(el.filename)
        break
      case 'image':
        if (el.alt) parts.push(el.alt)
        break
      case 'pdf':
        parts.push(`${el.filename} 第 ${el.page} 页`)
        break
      default:
        break
    }
  }
  return parts.filter(Boolean).join('\n\n')
}

export const useApp = create<AppStore>((set, get) => {
  let saveQueue = Promise.resolve(true)

  /** 返回是否保存成功。强制保存只会在最新修订已落盘后返回 true。 */
  const persistCurrentPage = async (force = false): Promise<boolean> => {
    if (force) debouncedSave.cancel()
    let mustWrite = force

    for (;;) {
      const snapshot = get()
      if (!snapshot.pageId) {
        set({ saving: false })
        return true
      }
      if (!snapshot.dirty && !mustWrite) {
        set({ saving: false })
        return true
      }
      mustWrite = false

      const pageId = snapshot.pageId
      const revision = snapshot.rev
      set({ saving: true })

      try {
        const plain = docToPlainText(snapshot.doc)
        const links = extractWikiLinks(plain)
        const tags = extractHashTags(plain)
        const docToStore: CanvasDoc = { ...snapshot.doc, viewport: snapshot.viewport }
        const savedAt = await api.savePage({
          id: pageId,
          title: snapshot.title,
          content: JSON.stringify(docToStore),
          plainText: plain,
          links,
          tags,
        })
        const current = get()
        const pages = current.pages.map((page) =>
          page.id === pageId
            ? {
                ...page,
                title: snapshot.title,
                preview: plain.slice(0, 140),
                updatedAt: savedAt,
                tags,
              }
            : page
        )

        if (current.pageId !== pageId) {
          set({ pages, saving: false })
          return false
        }
        if (current.rev === revision) {
          set({ pages, dirty: false, saving: false, lastSaved: savedAt })
          return true
        }

        set({ pages, lastSaved: savedAt })
        if (force) continue
        set({ saving: false })
        debouncedSave()
        return false
      } catch (e) {
        console.error('保存失败', e)
        set({ saving: false })
        return false
      }
    }
  }

  const doSave = (force = false): Promise<boolean> => {
    const run = () => persistCurrentPage(force)
    const queued = saveQueue.then(run, run)
    saveQueue = queued
    return queued
  }

  const debouncedSave = debounce(() => {
    void doSave()
  }, 700)

  /**
   * 离开当前页面前的统一收尾：保存 + 自动快照。
   * 返回 false 表示保存失败，调用方必须中止导航，否则脏数据会被下一页覆盖。
   */
  const flushCurrentPage = async (): Promise<boolean> => {
    const cur = get()
    if (!cur.pageId || !cur.dirty) return true
    debouncedSave.cancel()
    const leaving = cur.pageId
    const ok = await doSave(true)
    if (!ok) return false
    try {
      await api.createVersion(leaving, '自动快照')
    } catch {
      /* 快照失败不阻塞导航 */
    }
    return true
  }

  const pushHistory = (prev: CanvasDoc) => {
    const past = get().past.slice()
    past.push(clone(prev))
    if (past.length > HISTORY_LIMIT) past.shift()
    set({ past, future: [] })
  }

  return {
    ready: false,
    notebooks: [],
    sections: [],
    pages: [],
    tags: [],
    recents: [],

    notebookId: null,
    sectionId: null,
    pageId: null,

    title: '',
    doc: clone(EMPTY_DOC),
    viewport: { x: 0, y: 0, zoom: 1 },
    tool: 'select',
    selection: [],
    strokeSelection: [],
    editingId: null,

    past: [],
    future: [],

    dirty: false,
    saving: false,
    documentLocked: false,
    lastSaved: 0,
    rev: 0,

    settings: DEFAULT_SETTINGS,

    sidebarOpen: true,
    aiOpen: false,
    searchOpen: false,
    findOpen: false,
    settingsOpen: false,
    shortcutsOpen: false,
    panel: null,
    searchPreset: null,

    async bootstrap() {
      // 设置
      try {
        const raw = await api.getSetting(SETTINGS_KEY)
        if (raw) {
          const parsed = JSON.parse(raw) as Partial<AppSettings>
          set({ settings: { ...DEFAULT_SETTINGS, ...parsed } })
        }
      } catch {
        /* 使用默认设置 */
      }

      let notebooks = await api.listNotebooks()
      if (notebooks.length === 0) {
        await buildWelcome()
        notebooks = await api.listNotebooks()
      }
      set({ notebooks })

      let preferred: Partial<RestoredSession> | null = null
      try {
        const last = await api.getSetting(LAST_OPEN_KEY)
        if (last) preferred = JSON.parse(last) as Partial<RestoredSession>
      } catch {
        /* 忽略 */
      }

      const tree = await Promise.all(
        notebooks.map(async (notebook) => {
          const sections = await api.listSections(notebook.id)
          return {
            id: notebook.id,
            sections: await Promise.all(
              sections.map(async (section) => ({
                id: section.id,
                pages: (await api.listPages(section.id)).map((page) => ({ id: page.id })),
              }))
            ),
          }
        })
      )
      const restored = selectRestoredSession(tree, preferred)
      if (restored) {
        const sections = await api.listSections(restored.notebookId)
        const pages = await api.listPages(restored.sectionId)
        set({
          notebookId: restored.notebookId,
          sections,
          sectionId: restored.sectionId,
          pages,
        })
        await get().openPage(restored.pageId)
      } else if (notebooks[0]) {
        await get().selectNotebook(notebooks[0].id)
      }
      // bootstrap 结束后 doc 尚是初始空文档，rev/dirty 归零
      await get().refreshTags()
      set({ ready: true, recents: await api.recentPages(12) })
    },

    async refreshTree() {
      const notebooks = await api.listNotebooks()
      set({ notebooks })

      // 当前选中的笔记本/分区可能刚被删掉；若不校正，
      // 后续编辑会继续写进已在回收站里的页面，清空回收站时被静默硬删。
      const cur = get()
      if (!cur.notebookId || !notebooks.some((n) => n.id === cur.notebookId)) {
        if (notebooks.length > 0) {
          await get().selectNotebook(notebooks[0].id)
        } else {
          set({
            notebookId: null,
            sections: [],
            sectionId: null,
            pages: [],
            pageId: null,
            doc: clone(EMPTY_DOC),
            title: '',
            dirty: false,
          })
        }
        return
      }

      const sections = await api.listSections(cur.notebookId)
      set({ sections })
      if (cur.sectionId && sections.some((s) => s.id === cur.sectionId)) {
        const pages = await api.listPages(cur.sectionId)
        set({ pages })
        const currentPageId = get().pageId
        if (currentPageId && pages.some((page) => page.id === currentPageId)) return
        if (pages.length > 0) {
          await get().openPage(pages[0].id)
        } else {
          set({
            pageId: null,
            doc: clone(EMPTY_DOC),
            title: '',
            dirty: false,
            past: [],
            future: [],
            selection: [],
            strokeSelection: [],
            editingId: null,
          })
        }
      } else if (sections.length > 0) {
        await get().selectSection(sections[0].id)
      } else {
        set({ sectionId: null, pages: [], pageId: null, doc: clone(EMPTY_DOC), title: '', dirty: false })
      }
    },

    async selectNotebook(id) {
      if (!(await flushCurrentPage())) return false
      const sections = await api.listSections(id)
      set({ notebookId: id, sections })
      // 主动切换到某个笔记本时，把它展开
      const collapsed = get().settings.collapsedNotebooks ?? []
      if (collapsed.includes(id)) {
        get().patchSettings({ collapsedNotebooks: collapsed.filter((x) => x !== id) })
      }
      if (sections.length > 0) {
        return get().selectSection(sections[0].id)
      } else {
        set({
          sectionId: null,
          pages: [],
          pageId: null,
          doc: clone(EMPTY_DOC),
          title: '',
          dirty: false,
          past: [],
          future: [],
          selection: [],
          strokeSelection: [],
          editingId: null,
        })
        return true
      }
    },

    async selectSection(id) {
      if (!(await flushCurrentPage())) return false
      const pages = await api.listPages(id)
      set({ sectionId: id, pages })
      if (pages.length > 0) {
        await get().openPage(pages[0].id)
      } else {
        set({
          pageId: null,
          doc: clone(EMPTY_DOC),
          title: '',
          dirty: false,
          past: [],
          future: [],
          selection: [],
          strokeSelection: [],
          editingId: null,
        })
      }
      return true
    },

    async openPage(id) {
      if (!(await flushCurrentPage())) {
        console.error('当前页面保存失败，已取消切换以保护未保存内容')
        return
      }
      const page = await api.getPage(id)
      if (!page) return
      let doc: CanvasDoc = clone(EMPTY_DOC)
      try {
        if (page.content) doc = { ...clone(EMPTY_DOC), ...(JSON.parse(page.content) as CanvasDoc) }
      } catch {
        doc = clone(EMPTY_DOC)
      }
      if (!Array.isArray(doc.elements)) doc.elements = []
      if (!Array.isArray(doc.strokes)) doc.strokes = []
      const viewport = doc.viewport ?? { x: 0, y: 0, zoom: 1 }
      set({
        pageId: id,
        title: page.title,
        doc,
        viewport,
        selection: [],
        strokeSelection: [],
        editingId: null,
        past: [],
        future: [],
        dirty: false,
        lastSaved: page.updatedAt,
      })
      if (page.sectionId !== get().sectionId) {
        set({ sectionId: page.sectionId, pages: await api.listPages(page.sectionId) })
      }
      if (page.notebookId !== get().notebookId) {
        set({ notebookId: page.notebookId, sections: await api.listSections(page.notebookId) })
      }
      try {
        await api.setSetting(
          LAST_OPEN_KEY,
          JSON.stringify({
            notebookId: page.notebookId,
            sectionId: page.sectionId,
            pageId: page.id,
          } satisfies RestoredSession)
        )
      } catch {
        /* 页面已打开；设置持久化失败不应阻塞编辑 */
      }
      void api.recentPages(12).then((recents) => set({ recents }))
    },

    async newNotebook(name = '新笔记本') {
      if (get().documentLocked) return
      const nb = await api.createNotebook(name)
      const sec = await api.createSection(nb.id, '第一分区')
      await api.createPage(sec.id, '未命名页面', JSON.stringify(EMPTY_DOC))
      set({ notebooks: await api.listNotebooks() })
      await get().selectNotebook(nb.id)
    },

    async newSection(name = '新分区') {
      if (get().documentLocked) return
      const { notebookId } = get()
      if (!notebookId) return
      const sec = await api.createSection(notebookId, name)
      await api.createPage(sec.id, '未命名页面', JSON.stringify(EMPTY_DOC))
      set({ sections: await api.listSections(notebookId) })
      await get().selectSection(sec.id)
    },

    async newPage(title = '未命名页面', parentId = null) {
      if (get().documentLocked) return null
      const { sectionId, settings } = get()
      if (!sectionId) return null
      const fresh: CanvasDoc = { ...clone(EMPTY_DOC), background: settings.defaultBackground }
      const page = await api.createPage(sectionId, title, JSON.stringify(fresh), parentId)
      set({ pages: await api.listPages(sectionId) })
      await get().openPage(page.id)
      return page.id
    },

    async createChildPageWithDoc(title, parentId, doc) {
      if (get().documentLocked) return null
      const source = get()
      if (!source.pageId || source.pageId !== parentId || !source.sectionId) {
        throw new Error('源页面已切换，未创建思维导图子页面')
      }
      const sourceSectionId = source.sectionId
      if (!(await flushCurrentPage())) {
        throw new Error('原笔记保存失败，已取消创建思维导图以保护内容')
      }

      const current = get()
      if (current.pageId !== parentId || current.sectionId !== sourceSectionId) {
        throw new Error('生成期间页面已切换，未创建思维导图子页面')
      }

      const normalizedTitle = title.trim() || '思维导图'
      const page = await api.createPage(
        sourceSectionId,
        normalizedTitle,
        JSON.stringify(clone(doc)),
        parentId
      )
      set({ pages: await api.listPages(sourceSectionId) })
      await get().openPage(page.id)
      if (get().pageId !== page.id) {
        throw new Error('思维导图已创建，但无法自动打开目标子页面')
      }
      return page.id
    },

    async renameNotebook(id, name) {
      const normalized = name.trim()
      if (!normalized) throw new Error('笔记本名称不能为空')
      await api.updateNotebook({ id, name: normalized })
      set({
        notebooks: get().notebooks.map((notebook) =>
          notebook.id === id ? { ...notebook, name: normalized } : notebook
        ),
      })
    },

    async renameSection(id, name) {
      const normalized = name.trim()
      if (!normalized) throw new Error('分区名称不能为空')
      await api.updateSection({ id, name: normalized })
      set({
        sections: get().sections.map((section) =>
          section.id === id ? { ...section, name: normalized } : section
        ),
      })
    },

    async renamePage(id, title) {
      const normalized = title.trim()
      if (!normalized) throw new Error('页面名称不能为空')
      await api.updatePageMeta({ id, title: normalized })
      set({
        pages: get().pages.map((p) => (p.id === id ? { ...p, title: normalized } : p)),
        title: get().pageId === id ? normalized : get().title,
      })
    },

    async removePage(id) {
      await api.deletePage(id)
      const { sectionId } = get()
      if (!sectionId) return
      const pages = await api.listPages(sectionId)
      set({ pages })
      if (get().pageId === id) {
        // 被删的是当前页：它已经进了回收站，脏内容不再挽留，但状态必须一并清干净
        set({ dirty: false, past: [], future: [], selection: [], strokeSelection: [], editingId: null })
        if (pages.length > 0) await get().openPage(pages[0].id)
        else set({ pageId: null, doc: clone(EMPTY_DOC), title: '' })
      }
    },

    async toggleFavorite(id) {
      const p = get().pages.find((x) => x.id === id)
      const next = !(p?.favorite ?? false)
      await api.updatePageMeta({ id, favorite: next })
      set({ pages: get().pages.map((x) => (x.id === id ? { ...x, favorite: next } : x)) })
    },

    setTitle(t) {
      if (get().documentLocked) return
      set({ title: t, dirty: true, rev: get().rev + 1 })
      get().scheduleSave()
    },

    updateDoc(fn, record = true) {
      if (get().documentLocked) return
      const prev = get().doc
      if (record) pushHistory(prev)
      const next = clone(prev)
      fn(next)
      set({ doc: next, dirty: true, rev: get().rev + 1 })
      get().scheduleSave()
    },

    replaceDoc(d, record = true) {
      if (get().documentLocked) return
      if (record) pushHistory(get().doc)
      set({ doc: d, dirty: true, rev: get().rev + 1 })
      get().scheduleSave()
    },

    addElement(el) {
      get().updateDoc((d) => {
        const withZ = { ...el, z: el.z || nextZ(d) }
        d.elements.push(withZ as CanvasElement)
      })
      set({ selection: [el.id], strokeSelection: [] })
    },

    patchElement(id, patch, record = true) {
      get().updateDoc((d) => {
        const idx = d.elements.findIndex((e) => e.id === id)
        if (idx >= 0) d.elements[idx] = { ...d.elements[idx], ...patch } as CanvasElement
      }, record)
    },

    removeElements(ids) {
      if (ids.length === 0) return
      const set0 = new Set(ids)
      get().updateDoc((d) => {
        d.elements = d.elements.filter((e) => !set0.has(e.id))
      })
      set({ selection: [], editingId: null })
    },

    addStroke(s) {
      get().updateDoc((d) => {
        d.strokes.push({ ...s, z: s.z || nextZ(d) })
      })
    },

    removeStrokes(ids) {
      if (ids.length === 0) return
      const set0 = new Set(ids)
      get().updateDoc((d) => {
        d.strokes = d.strokes.filter((s) => !set0.has(s.id))
      })
      set({ strokeSelection: [] })
    },

    bringToFront(ids) {
      get().updateDoc((d) => {
        let z = nextZ(d)
        for (const id of ids) {
          const el = d.elements.find((e) => e.id === id)
          if (el) el.z = z++
          const st = d.strokes.find((e) => e.id === id)
          if (st) st.z = z++
        }
      })
    },

    sendToBack(ids) {
      get().updateDoc((d) => {
        let z = -1
        for (const id of ids) {
          const el = d.elements.find((e) => e.id === id)
          if (el) el.z = z--
          const st = d.strokes.find((e) => e.id === id)
          if (st) st.z = z--
        }
      })
    },

    undo() {
      if (get().documentLocked) return
      const { past, doc, future } = get()
      if (past.length === 0) return
      const prev = past[past.length - 1]
      set({
        past: past.slice(0, -1),
        future: [clone(doc)].concat(future).slice(0, HISTORY_LIMIT),
        doc: prev,
        dirty: true,
        rev: get().rev + 1,
        selection: [],
        strokeSelection: [],
        editingId: null,
      })
      get().scheduleSave()
    },

    redo() {
      if (get().documentLocked) return
      const { past, doc, future } = get()
      if (future.length === 0) return
      const next = future[0]
      set({
        future: future.slice(1),
        past: past.concat([clone(doc)]).slice(-HISTORY_LIMIT),
        doc: next,
        dirty: true,
        rev: get().rev + 1,
        selection: [],
        strokeSelection: [],
        editingId: null,
      })
      get().scheduleSave()
    },

    setSelection(ids) {
      set({ selection: ids, strokeSelection: ids.length ? [] : get().strokeSelection })
    },
    setStrokeSelection(ids) {
      set({ strokeSelection: ids, selection: ids.length ? [] : get().selection })
    },
    setEditing(id) {
      set({ editingId: id })
    },
    setTool(t) {
      set({ tool: t, editingId: null })
      if (t !== 'select') set({ selection: [], strokeSelection: [] })
    },
    setViewport(v) {
      const next = typeof v === 'function' ? v(get().viewport) : v
      set({ viewport: next })
    },

    async save(force = false) {
      debouncedSave.cancel()
      return doSave(force)
    },
    scheduleSave() {
      debouncedSave()
    },

    patchSettings(patch) {
      const settings = { ...get().settings, ...patch }
      set({ settings })
      void api.setSetting(SETTINGS_KEY, JSON.stringify(settings))
    },

    setUI(patch) {
      set(patch as Partial<AppStore>)
    },

    openSearch(preset) {
      set({ searchOpen: true, searchPreset: preset ?? null })
    },

    toggleNotebookCollapsed(id) {
      const cur = get().settings.collapsedNotebooks ?? []
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : cur.concat([id])
      get().patchSettings({ collapsedNotebooks: next })
    },

    async refreshTags() {
      set({ tags: await api.listTags() })
    },
  }
})

export const newElementId = () => uid('el')
export const newStrokeId = () => uid('st')
