import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  Attachment,
  Notebook,
  Page,
  PageMeta,
  Section,
  Stats,
  TrashItem,
} from './types'
import type { AgentSectionAdoptResult, AgentSectionDuplicateResult } from './api'
import { mockInvoke, resetMock } from './mockBackend'

async function createSectionFixture() {
  const notebook = await mockInvoke<Notebook>('notebook_create', { name: '测试笔记本' })
  const section = await mockInvoke<Section>('section_create', {
    notebookId: notebook.id,
    name: '原始分区',
  })
  const firstPage = await mockInvoke<PageMeta>('page_create', {
    sectionId: section.id,
    parentId: null,
    title: '第一页',
    content: JSON.stringify({ version: 1, elements: [], strokes: [] }),
  })
  const secondPage = await mockInvoke<PageMeta>('page_create', {
    sectionId: section.id,
    parentId: firstPage.id,
    title: '第二页',
    content: JSON.stringify({ version: 1, elements: [], strokes: [] }),
  })
  return { notebook, section, firstPage, secondPage }
}

describe('browser mock backend parity', () => {
  beforeEach(() => resetMock())

  afterEach(() => vi.restoreAllMocks())

  it('soft-deletes section pages and restores only pages deleted with that section', async () => {
    const { notebook, section, firstPage, secondPage } = await createSectionFixture()
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(100)
    await mockInvoke<void>('page_delete', { id: firstPage.id })
    dateNow.mockReturnValue(200)
    await mockInvoke<void>('section_delete', { id: section.id })

    expect(await mockInvoke<TrashItem[]>('trash_list')).toEqual([
      expect.objectContaining({
        id: section.id,
        kind: 'section',
        title: section.name,
        parentLabel: notebook.name,
        deletedAt: 200,
      }),
    ])

    await mockInvoke<void>('trash_restore', { kind: 'section', id: section.id })

    const activePages = await mockInvoke<PageMeta[]>('pages_list', { sectionId: section.id })
    expect(activePages.map((page) => page.id)).toEqual([secondPage.id])
    expect(await mockInvoke<TrashItem[]>('trash_list')).toEqual([
      expect.objectContaining({
        id: firstPage.id,
        kind: 'page',
        parentLabel: section.name,
        deletedAt: 100,
      }),
    ])
  })

  it('purges a trashed section together with its page records', async () => {
    const { section, firstPage, secondPage } = await createSectionFixture()
    await mockInvoke<void>('section_delete', { id: section.id })
    await mockInvoke<void>('trash_purge', { kind: 'section', id: section.id })

    expect(await mockInvoke<Page | null>('page_get', { id: firstPage.id })).toBeNull()
    expect(await mockInvoke<Page | null>('page_get', { id: secondPage.id })).toBeNull()
    expect(await mockInvoke<TrashItem[]>('trash_list')).toEqual([])
  })

  it('empties trashed sections and their page records', async () => {
    const { section, firstPage } = await createSectionFixture()
    await mockInvoke<void>('section_delete', { id: section.id })
    await mockInvoke<void>('trash_empty')

    expect(await mockInvoke<Page | null>('page_get', { id: firstPage.id })).toBeNull()
    expect(await mockInvoke<TrashItem[]>('trash_list')).toEqual([])
  })

  it('duplicates attachment records and structurally rewrites canvas references', async () => {
    const { section, firstPage } = await createSectionFixture()
    const attachment = await mockInvoke<Attachment>('attachment_save', {
      pageId: firstPage.id,
      filename: 'formula.png',
      dataBase64: 'aW1hZ2U=',
    })
    const canvas = {
      version: 1,
      elements: [
        {
          id: 'image-1',
          kind: 'image',
          attachmentId: attachment.id,
          src: attachment.url,
          metadata: { src: `inkasset://localhost/${attachment.id}` },
        },
      ],
      strokes: [],
    }
    await mockInvoke<number>('page_save', {
      payload: {
        id: firstPage.id,
        title: firstPage.title,
        content: JSON.stringify(canvas),
        plainText: '',
        tags: [],
      },
    })

    const duplicate = await mockInvoke<AgentSectionDuplicateResult>(
      'section_duplicate_for_agent',
      { sourceSectionId: section.id, currentPageId: firstPage.id }
    )
    const draftPage = await mockInvoke<Page>('page_get', {
      id: duplicate.currentDraftPageId,
    })
    const draftCanvas = JSON.parse(draftPage.content) as typeof canvas
    const draftAttachmentId = draftCanvas.elements[0].attachmentId

    expect(draftAttachmentId).not.toBe(attachment.id)
    expect(draftAttachmentId.endsWith('.png')).toBe(true)
    expect(draftCanvas.elements[0].src).toBe(attachment.url)
    expect(draftCanvas.elements[0].metadata.src).toBe(attachment.url)
    expect(
      await mockInvoke<string>('attachment_read', { id: draftAttachmentId })
    ).toBe('aW1hZ2U=')
    expect(await mockInvoke<string>('attachment_read', { id: attachment.id })).toBe('aW1hZ2U=')
    expect((await mockInvoke<Stats>('stats')).attachments).toBe(2)
  })

  it('does not leave a partial Agent draft when attachment content cannot be parsed', async () => {
    const { notebook, section, firstPage, secondPage } = await createSectionFixture()
    await mockInvoke<Attachment>('attachment_save', {
      pageId: firstPage.id,
      filename: 'formula.png',
      dataBase64: 'aW1hZ2U=',
    })
    await mockInvoke<number>('page_save', {
      payload: {
        id: secondPage.id,
        title: secondPage.title,
        content: 'not-json',
        plainText: '',
        tags: [],
      },
    })

    await expect(
      mockInvoke<AgentSectionDuplicateResult>('section_duplicate_for_agent', {
        sourceSectionId: section.id,
        currentPageId: firstPage.id,
      })
    ).rejects.toThrow('画布内容无法解析')

    expect(await mockInvoke<Section[]>('sections_list', { notebookId: notebook.id })).toEqual([
      expect.objectContaining({ id: section.id }),
    ])
    expect(await mockInvoke<PageMeta[]>('pages_list', { sectionId: section.id })).toHaveLength(2)
    expect((await mockInvoke<Stats>('stats')).attachments).toBe(1)
  })

  it('keeps the requested draft page active after adoption', async () => {
    const { section, firstPage, secondPage } = await createSectionFixture()
    const duplicate = await mockInvoke<AgentSectionDuplicateResult>(
      'section_duplicate_for_agent',
      { sourceSectionId: section.id, currentPageId: firstPage.id }
    )
    const currentDraftPageId = duplicate.pageMap.find(
      (page) => page.sourcePageId === secondPage.id
    )?.draftPageId
    expect(currentDraftPageId).toBeTruthy()

    const adopted = await mockInvoke<AgentSectionAdoptResult>('section_adopt_agent_draft', {
      sourceSectionId: section.id,
      draftSectionId: duplicate.draftSection.id,
      expectedSnapshot: duplicate.sourceSnapshot,
      currentPageId: currentDraftPageId,
    })

    expect(adopted.currentPageId).toBe(currentDraftPageId)
    expect(adopted.adoptedPageIds).toContain(currentDraftPageId)
    expect((await mockInvoke<Page>('page_get', { id: currentDraftPageId })).sectionId).toBe(
      section.id
    )
  })
})
