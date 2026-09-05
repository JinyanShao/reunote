/**
 * 浏览器回退后端。
 * 只有在没有 Tauri IPC 的环境（例如直接用 vite dev 打开网页调试 UI）时才会启用。
 * 打包成 App 后永远走真实的 Rust 后端。
 */
import type {
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
import type {
  AgentSectionAdoptResult,
  AgentSectionDuplicateResult,
} from './api'

export const hasTauri = () =>
  typeof window !== 'undefined' &&
  typeof (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ !== 'undefined'

interface Row {
  notebooks: Notebook[]
  sections: Section[]
  pages: (Page & { plainText: string; deletedAt: number | null })[]
  versions: (VersionMeta & { content: string })[]
  /** string 是旧版浏览器数据，保留读取兼容。 */
  attachments: Record<string, MockAttachmentRecord | string>
  settings: Record<string, string>
  recents: string[]
}

interface MockAttachmentRecord {
  pageId: string
  filename: string
  mime: string
  size: number
  createdAt: number
  dataBase64: string
}

const KEY = 'jinyan-notes.mock.v1'

function load(): Row {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return JSON.parse(raw) as Row
  } catch {
    /* ignore */
  }
  return {
    notebooks: [],
    sections: [],
    pages: [],
    versions: [],
    attachments: {},
    settings: {},
    recents: [],
  }
}

let db = load()
const persist = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(db))
  } catch {
    /* 超出配额时忽略 */
  }
}

const now = () => Date.now()
const rid = () => Math.random().toString(36).slice(2, 12)

function extensionOf(filename: string) {
  const ext = filename
    .split('.')
    .pop()
    ?.replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
  return ext && ext.length <= 10 ? ext : 'bin'
}

function guessMime(filename: string) {
  const ext = extensionOf(filename)
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'svg') return 'image/svg+xml'
  if (['png', 'gif', 'webp', 'bmp', 'heic', 'avif'].includes(ext)) return `image/${ext}`
  if (ext === 'pdf') return 'application/pdf'
  if (ext === 'mp3') return 'audio/mpeg'
  if (ext === 'm4a') return 'audio/mp4'
  if (ext === 'wav') return 'audio/wav'
  if (ext === 'aac') return 'audio/aac'
  if (ext === 'mp4') return 'video/mp4'
  if (ext === 'mov') return 'video/quicktime'
  return 'application/octet-stream'
}

function base64Size(value: string) {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding)
}

function attachmentRecord(id: string, value: MockAttachmentRecord | string): MockAttachmentRecord {
  if (typeof value !== 'string') return value
  return {
    pageId: '',
    filename: id,
    mime: guessMime(id),
    size: base64Size(value),
    createdAt: 0,
    dataBase64: value,
  }
}

function attachmentUrl(record: MockAttachmentRecord) {
  return `data:${record.mime};base64,${record.dataBase64}`
}

interface DraftAttachment {
  id: string
  record: MockAttachmentRecord
}

function rewrittenAssetSrc(src: string, attachmentMap: Map<string, DraftAttachment>) {
  for (const [oldId, draft] of attachmentMap) {
    const oldValue = db.attachments[oldId]
    const oldUrl = oldValue ? attachmentUrl(attachmentRecord(oldId, oldValue)) : ''
    const isAsset =
      src === oldUrl ||
      (src.includes('inkasset') && (src.split('/').pop() ?? '') === oldId)
    if (isAsset) return attachmentUrl(draft.record)
  }
  return null
}

function rewriteAttachmentValue(value: unknown, attachmentMap: Map<string, DraftAttachment>): void {
  if (Array.isArray(value)) {
    for (const item of value) rewriteAttachmentValue(item, attachmentMap)
    return
  }
  if (!value || typeof value !== 'object') return

  const object = value as Record<string, unknown>
  const attachmentId = typeof object.attachmentId === 'string' ? object.attachmentId : null
  const mapped = attachmentId ? attachmentMap.get(attachmentId) : null
  if (mapped) {
    object.attachmentId = mapped.id
    if ('src' in object) object.src = attachmentUrl(mapped.record)
  } else if (typeof object.src === 'string') {
    const rewritten = rewrittenAssetSrc(object.src, attachmentMap)
    if (rewritten) object.src = rewritten
  }
  for (const child of Object.values(object)) rewriteAttachmentValue(child, attachmentMap)
}

function rewriteCanvasAttachmentRefs(
  content: string,
  attachmentMap: Map<string, DraftAttachment>
) {
  if (attachmentMap.size === 0) return content
  let doc: unknown
  try {
    doc = JSON.parse(content)
  } catch (error) {
    throw new Error(`页面包含附件，但画布内容无法解析，已取消创建 Agent 草稿：${String(error)}`)
  }
  rewriteAttachmentValue(doc, attachmentMap)
  return JSON.stringify(doc)
}

function referencedAttachmentIds(content: string) {
  const ids = new Set<string>()
  let doc: unknown
  try {
    doc = JSON.parse(content)
  } catch {
    return ids
  }
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (!value || typeof value !== 'object') return
    const object = value as Record<string, unknown>
    if (typeof object.attachmentId === 'string') ids.add(object.attachmentId)
    if (typeof object.src === 'string' && object.src.includes('inkasset')) {
      const id = object.src.split('/').pop() ?? ''
      if (id) ids.add(id)
    }
    Object.values(object).forEach(visit)
  }
  visit(doc)
  return ids
}

function purgePages(pageIds: Set<string>) {
  db.pages = db.pages.filter((page) => !pageIds.has(page.id))
  db.versions = db.versions.filter((version) => !pageIds.has(version.pageId))
  db.recents = db.recents.filter((pageId) => !pageIds.has(pageId))
}

function agentSectionSnapshot(sectionId: string) {
  const section = db.sections.find((item) => item.id === sectionId && !item.deletedAt)
  if (!section) throw new Error('分区不存在或已删除')
  const pages = db.pages
    .filter((page) => page.sectionId === sectionId)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((page) => ({
      id: page.id,
      parentId: page.parentId,
      sortOrder: page.sortOrder,
      updatedAt: page.updatedAt,
      deletedAt: page.deletedAt,
    }))
  return JSON.stringify({
    version: 1,
    section: {
      id: section.id,
      notebookId: section.notebookId,
      name: section.name,
      color: section.color,
      sortOrder: section.sortOrder,
      updatedAt: section.updatedAt,
    },
    pages,
  })
}

/** 必须与 Rust 端的 ORDER BY sort_order ASC, created_at ASC 保持一致 */
const bySortOrder = <T extends { sortOrder: number; createdAt: number }>(a: T, b: T) =>
  a.sortOrder - b.sortOrder || a.createdAt - b.createdAt

function meta(p: Row['pages'][number]): PageMeta {
  const section = db.sections.find((s) => s.id === p.sectionId)
  return {
    id: p.id,
    sectionId: p.sectionId,
    notebookId: section?.notebookId ?? '',
    parentId: p.parentId,
    title: p.title,
    preview: (p.plainText || '').slice(0, 140),
    sortOrder: p.sortOrder,
    favorite: p.favorite,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    deletedAt: p.deletedAt,
    tags: p.tags,
  }
}

function hit(p: Row['pages'][number], snippet: string): SearchHit {
  const section = db.sections.find((s) => s.id === p.sectionId)
  const nb = db.notebooks.find((n) => n.id === section?.notebookId)
  return {
    pageId: p.id,
    title: p.title,
    snippet,
    notebookId: nb?.id ?? '',
    notebookName: nb?.name ?? '',
    sectionId: section?.id ?? '',
    sectionName: section?.name ?? '',
    updatedAt: p.updatedAt,
    score: 0,
  }
}

type Args = Record<string, unknown>

export async function mockInvoke<T>(cmd: string, args: Args = {}): Promise<T> {
  const a = args as Record<string, never>
  // 真实 IPC 会序列化，前端拿到的永远是新对象。
  // 这里也做一次深拷贝，否则前端会拿到 mock 内部的活引用，掩盖只在打包后才出现的别名 bug。
  const out = (v: unknown) =>
    (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v))) as T

  switch (cmd) {
    case 'notebooks_list':
      return out(db.notebooks.filter((n) => !n.deletedAt).sort(bySortOrder))

    case 'notebook_create': {
      const nb: Notebook = {
        id: rid(),
        name: String(a.name),
        color: (a.color as string) ?? '#6C8CFF',
        icon: (a.icon as string) ?? 'book',
        sortOrder: (db.notebooks.length + 1) * 1000,
        createdAt: now(),
        updatedAt: now(),
        deletedAt: null,
      }
      db.notebooks.push(nb)
      persist()
      return out(nb)
    }

    case 'notebook_update': {
      const nb = db.notebooks.find((n) => n.id === a.id)
      if (nb) Object.assign(nb, cleanPatch(args, ['name', 'color', 'icon', 'sortOrder']))
      persist()
      return out(undefined)
    }

    case 'notebook_delete': {
      const nb = db.notebooks.find((n) => n.id === a.id)
      if (nb) nb.deletedAt = now()
      persist()
      return out(undefined)
    }

    case 'sections_list':
      return out(
        db.sections.filter((s) => s.notebookId === a.notebookId && !s.deletedAt).sort(bySortOrder)
      )

    case 'section_create': {
      const sec: Section = {
        id: rid(),
        notebookId: String(a.notebookId),
        name: String(a.name),
        color: (a.color as string) ?? '#8B9BB4',
        sortOrder: (db.sections.length + 1) * 1000,
        createdAt: now(),
        updatedAt: now(),
        deletedAt: null,
      }
      db.sections.push(sec)
      persist()
      return out(sec)
    }

    case 'section_update': {
      const sec = db.sections.find((s) => s.id === a.id)
      if (sec) Object.assign(sec, cleanPatch(args, ['name', 'color', 'sortOrder', 'notebookId']))
      persist()
      return out(undefined)
    }

    case 'section_delete': {
      const sec = db.sections.find((s) => s.id === a.id)
      if (sec) {
        const deletedAt = now()
        for (const page of db.pages) {
          if (page.sectionId === sec.id && page.deletedAt === null) page.deletedAt = deletedAt
        }
        sec.deletedAt = deletedAt
      }
      persist()
      return out(undefined)
    }

    case 'section_duplicate_for_agent': {
      const source = db.sections.find(
        (section) => section.id === a.sourceSectionId && !section.deletedAt
      )
      if (!source) throw new Error('分区不存在或已删除')
      const sourceSnapshot = agentSectionSnapshot(source.id)
      const createdAt = now()
      const draftOrder =
        db.sections
          .filter((section) => section.notebookId === source.notebookId)
          .reduce((highest, section) => Math.max(highest, section.sortOrder), 0) + 1000
      const draft: Section = {
        ...source,
        id: rid(),
        name: `${source.name}（AI 草稿）`,
        sortOrder: draftOrder,
        createdAt,
        updatedAt: createdAt,
        deletedAt: null,
      }

      const sourcePages = db.pages
        .filter((page) => page.sectionId === source.id && !page.deletedAt)
        .sort(bySortOrder)
      const pageIds = new Map(sourcePages.map((page) => [page.id, rid()]))
      const pageMap = sourcePages.map((page) => ({
        sourcePageId: page.id,
        draftPageId: pageIds.get(page.id)!,
      }))

      // 新版记录直接带 pageId；旧版只有 base64 时，从结构化画布引用中恢复归属。
      const legacyOwners = new Map<string, string>()
      for (const page of sourcePages) {
        for (const attachmentId of referencedAttachmentIds(page.content)) {
          if (!legacyOwners.has(attachmentId)) legacyOwners.set(attachmentId, page.id)
        }
      }
      const attachmentMap = new Map<string, DraftAttachment>()
      const draftAttachments: Record<string, MockAttachmentRecord> = {}
      for (const [oldId, value] of Object.entries(db.attachments)) {
        const sourceRecord = attachmentRecord(oldId, value)
        const sourcePageId = sourceRecord.pageId || legacyOwners.get(oldId) || ''
        const draftPageId = pageIds.get(sourcePageId)
        if (!draftPageId) continue
        const draftId = `${rid()}.${extensionOf(oldId)}`
        const record: MockAttachmentRecord = {
          ...sourceRecord,
          pageId: draftPageId,
          createdAt,
        }
        attachmentMap.set(oldId, { id: draftId, record })
        draftAttachments[draftId] = record
      }

      // 先完成全部解析和重写，再提交到 db，模拟 Rust 事务失败时不留半成品。
      const draftPages = sourcePages.map((page) => {
        const content = rewriteCanvasAttachmentRefs(page.content, attachmentMap)
        return {
          ...page,
          id: pageIds.get(page.id)!,
          sectionId: draft.id,
          parentId: page.parentId ? pageIds.get(page.parentId) ?? null : null,
          content,
          tags: [...page.tags],
          createdAt,
          updatedAt: createdAt,
          deletedAt: null,
        }
      })

      db.sections.push(draft)
      db.pages.push(...draftPages)
      Object.assign(db.attachments, draftAttachments)
      persist()
      const currentDraftPageId = a.currentPageId
        ? pageIds.get(String(a.currentPageId)) ?? pageMap[0]?.draftPageId ?? null
        : pageMap[0]?.draftPageId ?? null
      return out({
        sourceSection: source,
        draftSection: draft,
        pageMap,
        currentDraftPageId,
        sourceSnapshot,
      } satisfies AgentSectionDuplicateResult)
    }

    case 'section_adopt_agent_draft': {
      const source = db.sections.find(
        (section) => section.id === a.sourceSectionId && !section.deletedAt
      )
      const draft = db.sections.find(
        (section) => section.id === a.draftSectionId && !section.deletedAt
      )
      if (!source || !draft) throw new Error('原分区或 Agent 工作稿不存在')
      if (source.notebookId !== draft.notebookId) {
        throw new Error('Agent 工作稿必须与原分区属于同一个笔记本')
      }
      if (agentSectionSnapshot(source.id) !== String(a.expectedSnapshot)) {
        throw new Error('原分区在 Agent 处理期间已发生变化，请重新创建工作稿后再采纳')
      }
      const adopted = db.pages
        .filter((page) => page.sectionId === draft.id && !page.deletedAt)
        .sort(bySortOrder)
      const changedAt = now()
      for (const page of db.pages.filter((item) => item.sectionId === source.id)) {
        page.sectionId = draft.id
        if (!page.deletedAt) page.deletedAt = changedAt
      }
      for (const page of adopted) {
        page.sectionId = source.id
        page.updatedAt = changedAt
      }
      draft.name = `${source.name}（AI 替换前）`
      draft.updatedAt = changedAt
      draft.deletedAt = changedAt
      source.updatedAt = changedAt
      persist()
      const requestedPageId = a.currentPageId ? String(a.currentPageId) : null
      const currentPageId =
        adopted.find((page) => page.id === requestedPageId)?.id ?? adopted[0]?.id ?? null
      return out({
        sourceSection: source,
        backupSectionId: draft.id,
        currentPageId,
        adoptedPageIds: adopted.map((page) => page.id),
      } satisfies AgentSectionAdoptResult)
    }

    case 'pages_list':
      return out(
        db.pages
          .filter((p) => p.sectionId === a.sectionId && !p.deletedAt)
          .sort(bySortOrder)
          .map(meta)
      )

    case 'page_get': {
      const p = db.pages.find((x) => x.id === a.id)
      if (!p) return out(null)
      db.recents = [p.id].concat(db.recents.filter((x) => x !== p.id)).slice(0, 30)
      persist()
      const section = db.sections.find((s) => s.id === p.sectionId)
      return out({ ...p, notebookId: section?.notebookId ?? '' } as Page)
    }

    case 'page_create': {
      const p = {
        id: rid(),
        sectionId: String(a.sectionId),
        notebookId: '',
        parentId: (a.parentId as string | null) ?? null,
        title: String(a.title),
        content: String(a.content),
        plainText: '',
        sortOrder: (db.pages.length + 1) * 1000,
        favorite: false,
        createdAt: now(),
        updatedAt: now(),
        deletedAt: null,
        tags: [],
      }
      db.pages.push(p)
      persist()
      return out(meta(p))
    }

    case 'page_save': {
      const payload = a.payload as unknown as {
        id: string
        title: string
        content: string
        plainText: string
        tags: string[]
      }
      const p = db.pages.find((x) => x.id === payload.id)
      if (p) {
        p.title = payload.title
        p.content = payload.content
        p.plainText = payload.plainText
        p.tags = payload.tags
        p.updatedAt = now()
      }
      persist()
      return out(now())
    }

    case 'page_update_meta': {
      const p = db.pages.find((x) => x.id === a.id)
      if (p) {
        Object.assign(
          p,
          cleanPatch(args, ['title', 'favorite', 'sortOrder', 'sectionId', 'parentId'])
        )
        p.updatedAt = now()
      }
      persist()
      return out(undefined)
    }

    case 'page_delete': {
      const p = db.pages.find((x) => x.id === a.id)
      if (p) p.deletedAt = now()
      persist()
      return out(undefined)
    }

    case 'page_duplicate': {
      const p = db.pages.find((x) => x.id === a.id)
      if (!p) return out('')
      const copyId = rid()
      const attachmentMap = new Map<string, DraftAttachment>()
      const referencedAttachments = referencedAttachmentIds(p.content)
      for (const [oldId, value] of Object.entries(db.attachments)) {
        const source = attachmentRecord(oldId, value)
        if (source.pageId !== p.id && !(source.pageId === '' && referencedAttachments.has(oldId))) {
          continue
        }
        const newId = `${rid()}.${extensionOf(source.filename)}`
        const record = { ...source, pageId: copyId, createdAt: now() }
        attachmentMap.set(oldId, { id: newId, record })
      }
      const copy = {
        ...p,
        id: copyId,
        title: `${p.title} 副本`,
        content: rewriteCanvasAttachmentRefs(p.content, attachmentMap),
        tags: [...p.tags],
        createdAt: now(),
        updatedAt: now(),
      }
      db.pages.push(copy)
      for (const attachment of attachmentMap.values()) {
        db.attachments[attachment.id] = attachment.record
      }
      persist()
      return out(copy.id)
    }

    case 'search': {
      const q = String(a.query ?? '')
        .trim()
        .toLowerCase()
      const list = db.pages.filter((p) => !p.deletedAt)
      if (!q) return out(list.slice(0, 20).map((p) => hit(p, p.plainText.slice(0, 120))))
      return out(
        list
          .filter(
            (p) =>
              p.title.toLowerCase().includes(q) || (p.plainText || '').toLowerCase().includes(q)
          )
          .map((p) => hit(p, p.plainText.slice(0, 120)))
      )
    }

    case 'recent_pages':
      return out(
        db.recents
          .map((id) => db.pages.find((p) => p.id === id))
          .filter((p): p is Row['pages'][number] => !!p && !p.deletedAt)
          .map((p) => hit(p, p.plainText.slice(0, 120)))
      )

    case 'backlinks': {
      const target = db.pages.find((p) => p.id === a.pageId)
      if (!target) return out([] as Backlink[])
      // 与 Rust 端一致：links.to_page 存的是标题
      const froms = new Set(
        db.pages
          .filter((p) => !p.deletedAt && p.id !== target.id)
          .filter((p) => (p.plainText || '').includes(`[[${target.title}]]`))
          .map((p) => p.id)
      )
      return out(
        [...froms].map((id) => {
          const p = db.pages.find((x) => x.id === id)!
          const sec = db.sections.find((s) => s.id === p.sectionId)
          const nb = db.notebooks.find((n) => n.id === sec?.notebookId)
          return {
            pageId: p.id,
            title: p.title,
            notebookName: nb?.name ?? '',
            sectionName: sec?.name ?? '',
            updatedAt: p.updatedAt,
          } as Backlink
        })
      )
    }

    case 'page_by_title': {
      const p = db.pages.find((x) => !x.deletedAt && x.title === a.title)
      return out(p ? p.id : null)
    }

    case 'tags_list': {
      const counts = new Map<string, number>()
      for (const p of db.pages) {
        if (p.deletedAt) continue
        for (const t of p.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
      }
      return out(
        [...counts.entries()].map(([name, count]) => ({
          id: name,
          name,
          color: '#8B9BB4',
          count,
        })) as Tag[]
      )
    }

    case 'tag_set_color':
      return out(undefined)

    case 'pages_by_tag':
      return out(
        db.pages
          .filter((p) => !p.deletedAt && p.tags.includes(String(a.tag)))
          .map((p) => hit(p, p.plainText.slice(0, 120)))
      )

    case 'favorites_list':
      return out(
        db.pages.filter((p) => !p.deletedAt && p.favorite).map((p) => hit(p, p.plainText.slice(0, 120)))
      )

    case 'version_create': {
      const p = db.pages.find((x) => x.id === a.pageId)
      const v = {
        id: rid(),
        pageId: String(a.pageId),
        title: p?.title ?? '',
        label: (a.label as string) ?? '手动快照',
        size: (p?.content ?? '').length,
        createdAt: now(),
        content: p?.content ?? '',
      }
      db.versions.unshift(v)
      persist()
      return out(v as VersionMeta)
    }

    case 'versions_list':
      return out(db.versions.filter((v) => v.pageId === a.pageId) as VersionMeta[])

    case 'version_content':
      return out(db.versions.find((v) => v.id === a.id)?.content ?? '')

    case 'attachment_save': {
      const filename = String(a.filename)
      const ext = extensionOf(filename)
      const id = `${rid()}.${ext}`
      const b64 = String(a.dataBase64)
      const mime = guessMime(filename)
      const record: MockAttachmentRecord = {
        pageId: String(a.pageId),
        filename,
        mime,
        size: base64Size(b64),
        createdAt: now(),
        dataBase64: b64,
      }
      db.attachments[id] = record
      persist()
      return out({
        id,
        pageId: record.pageId,
        filename: record.filename,
        mime: record.mime,
        size: record.size,
        url: attachmentUrl(record),
        createdAt: record.createdAt,
      } as Attachment)
    }

    case 'attachment_read': {
      const id = String(a.id)
      const value = db.attachments[id]
      return out(value ? attachmentRecord(id, value).dataBase64 : '')
    }

    case 'attachment_delete':
      delete db.attachments[String(a.id)]
      persist()
      return out(undefined)

    case 'trash_list': {
      const items: TrashItem[] = []
      for (const page of db.pages) {
        if (page.deletedAt === null) continue
        const section = db.sections.find(
          (item) => item.id === page.sectionId && item.deletedAt === null
        )
        if (!section) continue
        items.push({
          id: page.id,
          kind: 'page',
          title: page.title,
          parentLabel: section.name,
          deletedAt: page.deletedAt,
        })
      }
      for (const section of db.sections) {
        if (section.deletedAt === null) continue
        const notebook = db.notebooks.find(
          (item) => item.id === section.notebookId && item.deletedAt === null
        )
        if (!notebook) continue
        items.push({
          id: section.id,
          kind: 'section',
          title: section.name,
          parentLabel: notebook.name,
          deletedAt: section.deletedAt,
        })
      }
      for (const notebook of db.notebooks) {
        if (notebook.deletedAt === null) continue
        items.push({
          id: notebook.id,
          kind: 'notebook',
          title: notebook.name,
          parentLabel: '',
          deletedAt: notebook.deletedAt,
        })
      }
      items.sort((left, right) => right.deletedAt - left.deletedAt)
      return out(items)
    }

    case 'trash_restore': {
      const id = String(a.id)
      switch (String(a.kind)) {
        case 'page': {
          const page = db.pages.find((item) => item.id === id)
          if (page) page.deletedAt = null
          break
        }
        case 'section': {
          const section = db.sections.find((item) => item.id === id)
          const deletedAt = section?.deletedAt ?? null
          if (section) section.deletedAt = null
          if (deletedAt !== null) {
            for (const page of db.pages) {
              if (page.sectionId === id && page.deletedAt === deletedAt) page.deletedAt = null
            }
          }
          break
        }
        case 'notebook': {
          const notebook = db.notebooks.find((item) => item.id === id)
          const deletedAt = notebook?.deletedAt ?? null
          if (notebook) notebook.deletedAt = null
          if (deletedAt !== null) {
            const sectionIds = new Set<string>()
            for (const section of db.sections) {
              if (section.notebookId !== id) continue
              sectionIds.add(section.id)
              if (section.deletedAt === deletedAt) section.deletedAt = null
            }
            for (const page of db.pages) {
              if (sectionIds.has(page.sectionId) && page.deletedAt === deletedAt) {
                page.deletedAt = null
              }
            }
          }
          break
        }
        default:
          throw new Error('未知的回收站条目类型')
      }
      persist()
      return out(undefined)
    }

    case 'trash_purge': {
      const id = String(a.id)
      switch (String(a.kind)) {
        case 'page':
          purgePages(new Set([id]))
          break
        case 'section': {
          const pageIds = new Set(
            db.pages.filter((page) => page.sectionId === id).map((page) => page.id)
          )
          purgePages(pageIds)
          db.sections = db.sections.filter((section) => section.id !== id)
          break
        }
        case 'notebook': {
          const sectionIds = new Set(
            db.sections.filter((section) => section.notebookId === id).map((section) => section.id)
          )
          const pageIds = new Set(
            db.pages
              .filter((page) => sectionIds.has(page.sectionId))
              .map((page) => page.id)
          )
          purgePages(pageIds)
          db.sections = db.sections.filter((section) => !sectionIds.has(section.id))
          db.notebooks = db.notebooks.filter((notebook) => notebook.id !== id)
          break
        }
        default:
          throw new Error('未知的回收站条目类型')
      }
      persist()
      return out(undefined)
    }

    case 'trash_empty': {
      const notebookIds = new Set(
        db.notebooks.filter((notebook) => notebook.deletedAt !== null).map((notebook) => notebook.id)
      )
      const sectionIds = new Set(
        db.sections
          .filter(
            (section) => section.deletedAt !== null || notebookIds.has(section.notebookId)
          )
          .map((section) => section.id)
      )
      const pageIds = new Set(
        db.pages
          .filter((page) => page.deletedAt !== null || sectionIds.has(page.sectionId))
          .map((page) => page.id)
      )
      purgePages(pageIds)
      db.sections = db.sections.filter((section) => !sectionIds.has(section.id))
      db.notebooks = db.notebooks.filter((notebook) => !notebookIds.has(notebook.id))
      persist()
      return out(undefined)
    }

    case 'setting_get':
      return out(db.settings[String(a.key)] ?? null)

    case 'setting_set':
      db.settings[String(a.key)] = String(a.value)
      persist()
      return out(undefined)

    case 'stats':
      return out({
        notebooks: db.notebooks.length,
        sections: db.sections.length,
        pages: db.pages.filter((p) => !p.deletedAt).length,
        words: db.pages.reduce((n, p) => n + (p.plainText || '').length, 0),
        attachments: Object.keys(db.attachments).length,
        dbSize: JSON.stringify(db).length,
        dataDir: '（浏览器预览模式，数据存在 localStorage）',
      } as Stats)

    case 'read_file_base64':
    case 'read_file_text':
      return out('')

    case 'open_data_dir':
    case 'write_file_text':
    case 'write_file_base64':
    case 'attachment_export':
    case 'backup_export':
    case 'backup_import':
    case 'ai_cancel':
      return out(undefined)

    case 'ai_complete':
    case 'ai_test':
      throw new Error('浏览器预览模式不支持真实 AI 请求，请在 App 内使用。')

    case 'ai_models':
      return out([] as string[])

    case 'ai_chat':
      throw new Error('浏览器预览模式不支持真实 AI 请求，请在 App 内使用。')

    default:
      throw new Error(`未实现的命令：${cmd}`)
  }
}

function cleanPatch(args: Args, keys: string[]) {
  const out: Args = {}
  for (const k of keys) if (args[k] !== undefined && args[k] !== null) out[k] = args[k]
  return out
}

export function resetMock() {
  db = {
    notebooks: [],
    sections: [],
    pages: [],
    versions: [],
    attachments: {},
    settings: {},
    recents: [],
  }
  persist()
}
