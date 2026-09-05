export interface PageFindMatch {
  elementId: string
  text: string
}

type FindableElement = {
  id: string
  type: string
  x?: number
  y?: number
  z?: number
  html?: string
  content?: string
  latex?: string
  code?: string
  label?: string
  filename?: string
  name?: string
  alt?: string
}

type FindableDocument = {
  elements?: readonly FindableElement[]
}

function htmlText(value: string) {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
}

function searchableText(element: FindableElement) {
  switch (element.type) {
    case 'text':
    case 'sticky':
      return htmlText(String(element.html ?? element.content ?? ''))
    case 'math':
      return String(element.latex ?? '')
    case 'code':
      return String(element.code ?? '')
    case 'shape':
      return String(element.label ?? '')
    case 'file':
    case 'pdf':
    case 'audio':
      return String(element.filename ?? element.name ?? '')
    case 'image':
      return String(element.alt ?? '')
    default:
      return ''
  }
}

export function findCanvasMatches(doc: FindableDocument, query: string): PageFindMatch[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return []

  return (doc.elements ?? [])
    .slice()
    .sort(
      (a, b) =>
        (a.y ?? 0) - (b.y ?? 0) ||
        (a.x ?? 0) - (b.x ?? 0) ||
        (a.z ?? 0) - (b.z ?? 0)
    )
    .flatMap((element) => {
      const text = searchableText(element).trim()
      if (!text.toLocaleLowerCase().includes(needle)) return []
      return [{ elementId: element.id, text }]
    })
}

export function stepMatchIndex(
  current: number,
  total: number,
  direction: 'next' | 'previous'
) {
  if (total <= 0) return -1
  if (current < 0 || current >= total) return direction === 'next' ? 0 : total - 1
  return direction === 'next' ? (current + 1) % total : (current - 1 + total) % total
}
