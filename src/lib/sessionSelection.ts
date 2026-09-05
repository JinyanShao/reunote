export interface RestoredSession {
  notebookId: string
  sectionId: string
  pageId: string
}

export interface SessionTreePage {
  id: string
}

export interface SessionTreeSection {
  id: string
  pages: readonly SessionTreePage[]
}

export interface SessionTreeNotebook {
  id: string
  sections: readonly SessionTreeSection[]
}

export function selectRestoredSession(
  tree: readonly SessionTreeNotebook[],
  preferred?: Partial<RestoredSession> | null
): RestoredSession | null {
  const preferredNotebook = tree.find((notebook) => notebook.id === preferred?.notebookId)
  const notebook =
    preferredNotebook ?? tree.find((candidate) => candidate.sections.some((section) => section.pages.length))
  if (!notebook) return null

  const preferredSection = notebook.sections.find(
    (section) => section.id === preferred?.sectionId && section.pages.length
  )
  const section = preferredSection ?? notebook.sections.find((candidate) => candidate.pages.length)
  if (!section) {
    const fallbackNotebook = tree.find((candidate) =>
      candidate.sections.some((candidateSection) => candidateSection.pages.length)
    )
    if (!fallbackNotebook || fallbackNotebook.id === notebook.id) return null
    return selectRestoredSession(tree.filter((candidate) => candidate.id !== notebook.id), null)
  }

  const page = section.pages.find((candidate) => candidate.id === preferred?.pageId) ?? section.pages[0]
  if (!page) return null

  return { notebookId: notebook.id, sectionId: section.id, pageId: page.id }
}
