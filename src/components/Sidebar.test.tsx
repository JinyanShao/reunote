// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useApp } from '../lib/store'
import type { Notebook } from '../lib/types'
import { Sidebar } from './Sidebar'

const notebooks: Notebook[] = [
  {
    id: 'notebook-a',
    name: 'Alpha',
    color: '#6c8cff',
    icon: 'book',
    sortOrder: 1000,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  },
  {
    id: 'notebook-b',
    name: 'Beta',
    color: '#7b9cff',
    icon: 'book',
    sortOrder: 2000,
    createdAt: 2,
    updatedAt: 2,
    deletedAt: null,
  },
]

describe('Sidebar notebook section controls', () => {
  let container: HTMLDivElement
  let root: Root
  let appState: ReturnType<typeof useApp.getState>

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    appState = useApp.getState()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    useApp.setState(appState, true)
    container.remove()
    document.body.innerHTML = ''
  })

  it('renders one right-aligned add button per notebook and creates in its notebook', async () => {
    const selectNotebook = vi.fn(async () => true)
    const newSection = vi.fn(async () => undefined)
    useApp.setState({
      notebooks,
      notebookId: 'notebook-a',
      sections: [],
      sectionId: null,
      recents: [],
      tags: [],
      settings: { ...appState.settings, collapsedNotebooks: [] },
      selectNotebook,
      newSection,
    })

    await act(async () => root.render(<Sidebar />))

    const addButtons = container.querySelectorAll<HTMLButtonElement>(
      'button[aria-label$="中新建分区"]'
    )
    expect(addButtons).toHaveLength(2)
    expect(container.textContent).not.toContain('新建分区')

    const addToBeta = container.querySelector<HTMLButtonElement>(
      'button[aria-label="在“Beta”中新建分区"]'
    )!
    await act(async () => {
      addToBeta.click()
      await Promise.resolve()
    })

    expect(selectNotebook).toHaveBeenCalledWith('notebook-b')
    expect(newSection).toHaveBeenCalledOnce()
    expect(selectNotebook.mock.invocationCallOrder[0]).toBeLessThan(
      newSection.mock.invocationCallOrder[0]
    )
  })

  it('expands the current notebook before creating from its add button', async () => {
    const selectNotebook = vi.fn(async () => true)
    const toggleNotebookCollapsed = vi.fn()
    const newSection = vi.fn(async () => undefined)
    useApp.setState({
      notebooks,
      notebookId: 'notebook-a',
      sections: [],
      sectionId: null,
      recents: [],
      tags: [],
      settings: { ...appState.settings, collapsedNotebooks: ['notebook-a'] },
      selectNotebook,
      toggleNotebookCollapsed,
      newSection,
    })

    await act(async () => root.render(<Sidebar />))
    const addToAlpha = container.querySelector<HTMLButtonElement>(
      'button[aria-label="在“Alpha”中新建分区"]'
    )!

    await act(async () => {
      addToAlpha.click()
      await Promise.resolve()
    })

    expect(selectNotebook).not.toHaveBeenCalled()
    expect(toggleNotebookCollapsed).toHaveBeenCalledWith('notebook-a')
    expect(newSection).toHaveBeenCalledOnce()
  })
})
