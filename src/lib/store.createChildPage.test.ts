import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasDoc, Page, PageMeta, VersionMeta } from './types'

vi.mock('./api', () => ({
  createPage: vi.fn(),
  createVersion: vi.fn(),
  getPage: vi.fn(),
  listPages: vi.fn(),
  recentPages: vi.fn(),
  savePage: vi.fn(),
  setSetting: vi.fn(),
}))

import * as api from './api'
import { useApp } from './store'

const sourceDoc: CanvasDoc = {
  version: 1,
  background: 'grid',
  elements: [],
  strokes: [],
}

const mindMapDoc: CanvasDoc = {
  version: 1,
  background: 'dots',
  viewport: { x: 48, y: 72, zoom: 0.85 },
  elements: [
    {
      id: 'mind-root',
      type: 'shape',
      x: 120,
      y: 160,
      w: 240,
      h: 96,
      rotation: 0,
      z: 1,
      shape: 'rect',
      stroke: '#2563eb',
      fill: '#eff6ff',
      strokeWidth: 2,
      dashed: false,
      label: '核心主题',
      visualStyle: 'mind-root',
    },
  ],
  strokes: [
    {
      id: 'accent-stroke',
      points: [
        [100, 100, 0.5],
        [160, 120, 0.7],
      ],
      color: '#14b8a6',
      size: 3,
      tool: 'pen',
      z: 2,
    },
  ],
}

const sourcePage: PageMeta = {
  id: 'source-page',
  sectionId: 'section-1',
  notebookId: 'notebook-1',
  parentId: null,
  title: '原笔记',
  preview: '原笔记内容',
  sortOrder: 1000,
  favorite: false,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  tags: [],
}

const childPage: PageMeta = {
  ...sourcePage,
  id: 'mind-map-page',
  parentId: sourcePage.id,
  title: '原笔记 · 思维导图',
  preview: '核心主题',
  sortOrder: 2000,
}

const openedChildPage: Page = {
  ...childPage,
  content: JSON.stringify(mindMapDoc),
}

const sourceVersion: VersionMeta = {
  id: 'version-1',
  pageId: sourcePage.id,
  title: sourcePage.title,
  label: '自动快照',
  size: 0,
  createdAt: 100,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('store.createChildPageWithDoc', () => {
  let initialState: ReturnType<typeof useApp.getState>

  beforeEach(() => {
    initialState = useApp.getState()
    vi.mocked(api.savePage).mockReset().mockResolvedValue(100)
    vi.mocked(api.createVersion).mockReset().mockResolvedValue(sourceVersion)
    vi.mocked(api.createPage).mockReset().mockResolvedValue(childPage)
    vi.mocked(api.listPages).mockReset().mockResolvedValue([sourcePage, childPage])
    vi.mocked(api.getPage).mockReset().mockResolvedValue(openedChildPage)
    vi.mocked(api.setSetting).mockReset().mockResolvedValue(undefined)
    vi.mocked(api.recentPages).mockReset().mockResolvedValue([])

    useApp.setState({
      notebookId: sourcePage.notebookId,
      sectionId: sourcePage.sectionId,
      pageId: sourcePage.id,
      title: sourcePage.title,
      doc: sourceDoc,
      viewport: { x: 0, y: 0, zoom: 1 },
      pages: [sourcePage],
      dirty: true,
      saving: false,
      documentLocked: false,
      rev: 1,
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    useApp.setState(initialState, true)
  })

  it('does not create a child page when saving dirty source data fails', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(api.savePage).mockRejectedValueOnce(new Error('disk full'))

    await expect(
      useApp.getState().createChildPageWithDoc(childPage.title, sourcePage.id, mindMapDoc)
    ).rejects.toThrow('原笔记保存失败，已取消创建思维导图以保护内容')

    expect(api.createPage).not.toHaveBeenCalled()
    expect(useApp.getState().pageId).toBe(sourcePage.id)
    errorLog.mockRestore()
  })

  it('creates the child with its parent and complete document, then opens it', async () => {
    await expect(
      useApp.getState().createChildPageWithDoc(`  ${childPage.title}  `, sourcePage.id, mindMapDoc)
    ).resolves.toBe(childPage.id)

    expect(api.createPage).toHaveBeenCalledOnce()
    const [sectionId, title, content, parentId] = vi.mocked(api.createPage).mock.calls[0]
    expect(sectionId).toBe(sourcePage.sectionId)
    expect(title).toBe(childPage.title)
    expect(parentId).toBe(sourcePage.id)
    expect(JSON.parse(content)).toEqual(mindMapDoc)
    expect(api.getPage).toHaveBeenCalledWith(childPage.id)
    expect(vi.mocked(api.createPage).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.getPage).mock.invocationCallOrder[0]
    )
    expect(useApp.getState()).toMatchObject({
      pageId: childPage.id,
      title: childPage.title,
      doc: mindMapDoc,
      dirty: false,
    })
  })

  it('does not create a child if the active page changes while generation is finishing', async () => {
    const version = deferred<VersionMeta>()
    vi.mocked(api.createVersion).mockReturnValueOnce(version.promise)

    const creating = useApp
      .getState()
      .createChildPageWithDoc(childPage.title, sourcePage.id, mindMapDoc)

    await vi.waitFor(() => {
      expect(api.createVersion).toHaveBeenCalledWith(sourcePage.id, '自动快照')
    })
    useApp.setState({ pageId: 'another-page' })
    version.resolve(sourceVersion)

    await expect(creating).rejects.toThrow('生成期间页面已切换，未创建思维导图子页面')
    expect(api.createPage).not.toHaveBeenCalled()
  })
})
