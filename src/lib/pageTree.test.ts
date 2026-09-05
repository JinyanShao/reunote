import { describe, expect, it } from 'vitest'
import { buildPageTreeRows } from './pageTree'
import type { PageMeta } from './types'

function page(id: string, parentId: string | null, title = id): PageMeta {
  return {
    id,
    parentId,
    title,
    sectionId: 'section-1',
    notebookId: 'notebook-1',
    preview: '',
    sortOrder: 1000,
    favorite: false,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    tags: [],
  }
}

describe('page tree rows', () => {
  it('places a generated child immediately under its source page', () => {
    const rows = buildPageTreeRows([
      page('source', null, '原笔记'),
      page('other', null, '其他笔记'),
      page('mindmap', 'source', '原笔记 · 思维导图'),
    ])

    expect(rows.map(({ page: item, depth }) => [item.id, depth])).toEqual([
      ['source', 0],
      ['mindmap', 1],
      ['other', 0],
    ])
  })

  it('supports collapse and keeps ancestors while filtering', () => {
    const pages = [
      page('source', null, '原笔记'),
      page('mindmap', 'source', '量子思维导图'),
    ]

    expect(buildPageTreeRows(pages, '', new Set(['source'])).map((row) => row.page.id)).toEqual([
      'source',
    ])
    expect(buildPageTreeRows(pages, '量子', new Set(['source'])).map((row) => row.page.id)).toEqual([
      'source',
      'mindmap',
    ])
  })

  it('breaks cyclic parent relationships instead of recursing forever', () => {
    const rows = buildPageTreeRows([page('a', 'b'), page('b', 'a')])
    expect(rows.map((row) => row.page.id).sort()).toEqual(['a', 'b'])
  })
})
