import { describe, expect, it } from 'vitest'

import { selectRestoredSession } from '@/lib/sessionSelection'

const tree = [
  {
    id: 'notebook-a',
    sections: [
      {
        id: 'section-a1',
        pages: [{ id: 'page-a1-first' }, { id: 'page-a1-last' }],
      },
      {
        id: 'section-a2',
        pages: [{ id: 'page-a2-first' }],
      },
    ],
  },
  {
    id: 'notebook-b',
    sections: [
      {
        id: 'section-b1',
        pages: [{ id: 'page-b1-first' }, { id: 'page-b1-last' }],
      },
    ],
  },
]

describe('selectRestoredSession', () => {
  it('restores the exact preferred notebook, section, and page when they exist', () => {
    const preferred = {
      notebookId: 'notebook-b',
      sectionId: 'section-b1',
      pageId: 'page-b1-last',
    }

    expect(selectRestoredSession(tree, preferred)).toEqual(preferred)
  })

  it('keeps a valid notebook and section when only the preferred page is stale', () => {
    expect(
      selectRestoredSession(tree, {
        notebookId: 'notebook-b',
        sectionId: 'section-b1',
        pageId: 'deleted-page',
      }),
    ).toEqual({
      notebookId: 'notebook-b',
      sectionId: 'section-b1',
      pageId: 'page-b1-first',
    })
  })

  it('keeps a valid notebook when the preferred section is stale', () => {
    expect(
      selectRestoredSession(tree, {
        notebookId: 'notebook-a',
        sectionId: 'deleted-section',
        pageId: 'deleted-page',
      }),
    ).toEqual({
      notebookId: 'notebook-a',
      sectionId: 'section-a1',
      pageId: 'page-a1-first',
    })
  })

  it('falls back to the first valid hierarchy when the preferred notebook is stale', () => {
    expect(
      selectRestoredSession(tree, {
        notebookId: 'deleted-notebook',
        sectionId: 'section-b1',
        pageId: 'page-b1-last',
      }),
    ).toEqual({
      notebookId: 'notebook-a',
      sectionId: 'section-a1',
      pageId: 'page-a1-first',
    })
  })

  it('skips empty hierarchy branches while finding a valid fallback', () => {
    const sparseTree = [
      { id: 'empty-notebook', sections: [] },
      {
        id: 'partly-empty-notebook',
        sections: [
          { id: 'empty-section', pages: [] },
          { id: 'valid-section', pages: [{ id: 'valid-page' }] },
        ],
      },
    ]

    expect(selectRestoredSession(sparseTree, undefined)).toEqual({
      notebookId: 'partly-empty-notebook',
      sectionId: 'valid-section',
      pageId: 'valid-page',
    })
  })

  it('returns null when no valid page exists', () => {
    expect(selectRestoredSession([], undefined)).toBeNull()
    expect(
      selectRestoredSession(
        [{ id: 'empty-notebook', sections: [{ id: 'empty-section', pages: [] }] }],
        undefined,
      ),
    ).toBeNull()
  })
})
