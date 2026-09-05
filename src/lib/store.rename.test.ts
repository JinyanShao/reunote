import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Notebook, Section } from './types'

vi.mock('./api', () => ({
  updateNotebook: vi.fn(),
  updateSection: vi.fn(),
  updatePageMeta: vi.fn(),
}))

import * as api from './api'
import { useApp } from './store'

const notebook: Notebook = {
  id: 'notebook-1',
  name: '旧笔记本',
  color: '#6C8CFF',
  icon: 'book',
  sortOrder: 1000,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
}

const section: Section = {
  id: 'section-1',
  notebookId: notebook.id,
  name: '旧分区',
  color: '#8B9BB4',
  sortOrder: 1000,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
}

describe('store rename actions', () => {
  beforeEach(() => {
    vi.mocked(api.updateNotebook).mockReset().mockResolvedValue(undefined)
    vi.mocked(api.updateSection).mockReset().mockResolvedValue(undefined)
    vi.mocked(api.updatePageMeta).mockReset().mockResolvedValue(undefined)
    useApp.setState({ notebooks: [notebook], sections: [section] })
  })

  it('trims and persists notebook names before updating local state', async () => {
    await useApp.getState().renameNotebook(notebook.id, '  新笔记本  ')

    expect(api.updateNotebook).toHaveBeenCalledWith({ id: notebook.id, name: '新笔记本' })
    expect(useApp.getState().notebooks[0].name).toBe('新笔记本')
  })

  it('persists section names and keeps the old value when saving fails', async () => {
    vi.mocked(api.updateSection).mockRejectedValueOnce(new Error('保存失败'))

    await expect(useApp.getState().renameSection(section.id, '新分区')).rejects.toThrow('保存失败')
    expect(useApp.getState().sections[0].name).toBe('旧分区')
  })

  it('rejects blank notebook and section names', async () => {
    await expect(useApp.getState().renameNotebook(notebook.id, '   ')).rejects.toThrow(
      '笔记本名称不能为空'
    )
    await expect(useApp.getState().renameSection(section.id, '\n')).rejects.toThrow(
      '分区名称不能为空'
    )
    expect(api.updateNotebook).not.toHaveBeenCalled()
    expect(api.updateSection).not.toHaveBeenCalled()
  })
})
