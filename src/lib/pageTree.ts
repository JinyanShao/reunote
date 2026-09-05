import type { PageMeta } from './types'

export interface PageTreeRow {
  page: PageMeta
  depth: number
  hasChildren: boolean
}

/** Builds a stable, cycle-safe page tree while preserving the backend sort order. */
export function buildPageTreeRows(
  pages: PageMeta[],
  query = '',
  collapsedIds: ReadonlySet<string> = new Set()
): PageTreeRow[] {
  const byId = new Map(pages.map((page) => [page.id, page]))
  const parentById = new Map<string, string | null>()
  for (const page of pages) {
    parentById.set(
      page.id,
      page.parentId && page.parentId !== page.id && byId.has(page.parentId)
        ? page.parentId
        : null
    )
  }

  for (const page of pages) {
    const seen = new Set([page.id])
    let parentId = parentById.get(page.id) ?? null
    while (parentId) {
      if (seen.has(parentId)) {
        parentById.set(page.id, null)
        break
      }
      seen.add(parentId)
      parentId = parentById.get(parentId) ?? null
    }
  }

  const normalizedQuery = query.trim().toLocaleLowerCase()
  let included: Set<string> | null = null
  if (normalizedQuery) {
    included = new Set<string>()
    for (const page of pages) {
      const haystack = `${page.title}\n${page.preview}\n${page.tags.join(' ')}`.toLocaleLowerCase()
      if (!haystack.includes(normalizedQuery)) continue
      included.add(page.id)
      let parentId = parentById.get(page.id) ?? null
      while (parentId && !included.has(parentId)) {
        included.add(parentId)
        parentId = parentById.get(parentId) ?? null
      }
    }
  }

  const children = new Map<string | null, PageMeta[]>()
  for (const page of pages) {
    const parentId = parentById.get(page.id) ?? null
    const siblings = children.get(parentId) ?? []
    siblings.push(page)
    children.set(parentId, siblings)
  }

  const rows: PageTreeRow[] = []
  const visited = new Set<string>()
  const visit = (page: PageMeta, depth: number) => {
    if (visited.has(page.id) || (included && !included.has(page.id))) return
    visited.add(page.id)
    const visibleChildren = (children.get(page.id) ?? []).filter(
      (child) => !included || included.has(child.id)
    )
    rows.push({ page, depth, hasChildren: visibleChildren.length > 0 })
    if (!normalizedQuery && collapsedIds.has(page.id)) return
    visibleChildren.forEach((child) => visit(child, depth + 1))
  }

  ;(children.get(null) ?? []).forEach((page) => visit(page, 0))
  return rows
}
