import katex from 'katex'

export interface RichTextMathMatch {
  from: number
  to: number
  raw: string
  latex: string
  display: boolean
  canonical: boolean
}

export interface EmbedRichTextMathResult {
  html: string
  status: 'embedded' | 'existing' | 'not_found'
  display: boolean
  blockIndex?: number
}

export interface RichTextMathHtmlMatch extends RichTextMathMatch {
  blockIndex: number
  runIndex: number
}

export interface NormalizeRichTextMathResult {
  html: string
  total: number
  normalized: number
}

const TEXT_BLOCK_SELECTOR = 'p,h1,h2,h3,h4,h5,h6,blockquote,pre,li,td,th'
const RENDERED_MATH_SELECTOR = '[data-jinyan-notes-rendered-math],.katex'

function isEscaped(value: string, index: number) {
  let slashes = 0
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor--) slashes++
  return slashes % 2 === 1
}

function findClosing(
  value: string,
  start: number,
  close: string,
  singleLine: boolean
): number {
  for (let cursor = start; cursor <= value.length - close.length; cursor++) {
    if (singleLine && value[cursor] === '\n') return -1
    if (value.startsWith(close, cursor) && !isEscaped(value, cursor)) return cursor
  }
  return -1
}

/** Scan TeX delimiters without treating escaped dollars or code as formulas. */
export function scanRichTextMath(value: string): RichTextMathMatch[] {
  const matches: RichTextMathMatch[] = []
  let cursor = 0
  while (cursor < value.length) {
    let open = ''
    let close = ''
    let display = false
    let canonical = false
    let singleLine = false

    if (value.startsWith('$$', cursor) && !isEscaped(value, cursor)) {
      open = '$$'
      close = '$$'
      display = true
    } else if (value.startsWith('\\[', cursor) && !isEscaped(value, cursor)) {
      open = '\\['
      close = '\\]'
      display = true
      canonical = true
    } else if (value.startsWith('\\(', cursor) && !isEscaped(value, cursor)) {
      open = '\\('
      close = '\\)'
      canonical = true
    } else if (value[cursor] === '$' && !isEscaped(value, cursor)) {
      open = '$'
      close = '$'
      singleLine = true
    }

    if (!open) {
      cursor++
      continue
    }

    const contentStart = cursor + open.length
    const closeAt = findClosing(value, contentStart, close, singleLine)
    if (closeAt < 0) {
      cursor += open.length
      continue
    }
    if (open === '$' && value[closeAt + 1] === '$') {
      cursor++
      continue
    }
    const latex = value.slice(contentStart, closeAt).trim()
    const to = closeAt + close.length
    if (latex) {
      matches.push({
        from: cursor,
        to,
        raw: value.slice(cursor, to),
        latex,
        display,
        canonical,
      })
    }
    cursor = to
  }
  return matches
}

export function normalizeRichTextLatex(value: string) {
  const trimmed = value.trim()
  const match = scanRichTextMath(trimmed).find(
    (candidate) => candidate.from === 0 && candidate.to === trimmed.length
  )
  const latex = match?.latex ?? trimmed
  return latex
    .replace(/^```(?:latex|tex)?\s*/i, '')
    .replace(/```$/i, '')
    .replace(/\\(?:lvert|rvert)\b/g, '|')
    .replace(/\\neq\b/g, '\\ne')
    .replace(/\\tfrac\b/g, '\\frac')
    .replace(/\\(?:left|right|displaystyle|textstyle)\b/g, '')
    .replace(/\\[!,;:]|\\quad|\\qquad/g, '')
    .replace(/[\s{}]/g, '')
}

function richTextMathTokens(value: string) {
  const structural = stripRichTextMathDelimiters(value)
    .toLowerCase()
    .replace(/\\(?:lvert|rvert)\b/g, '|')
    .replace(/\\neq\b/g, '\\ne')
    .replace(/\\tfrac\b/g, '\\frac')
    .replace(
      /\\(?:left|right|displaystyle|textstyle|mathrm|mathbf|boldsymbol|mathcal|operatorname)\b/g,
      ''
    )
    .replace(/\\[!,;:]|\\quad|\\qquad/g, '')
    .replace(/[\\{}$`\s|()[\].,&:;]/g, '')
  return structural.match(/[a-z]+|\d+(?:\.\d+)?|[=+\-*/^_]/g) ?? []
}

/** Match conservative TeX spelling variants without relying on model-generated coordinates. */
export function equivalentRichTextLatex(left: string, right: string) {
  if (normalizeRichTextLatex(left) === normalizeRichTextLatex(right)) return true

  const leftTokens = richTextMathTokens(left)
  const rightTokens = richTextMathTokens(right)
  if (leftTokens.length < 6 || rightTokens.length < 6) return false

  const remaining = rightTokens.slice()
  let overlap = 0
  for (const token of leftTokens) {
    const index = remaining.indexOf(token)
    if (index < 0) continue
    overlap++
    remaining.splice(index, 1)
  }
  const shorterCoverage = overlap / Math.min(leftTokens.length, rightTokens.length)
  const longerCoverage = overlap / Math.max(leftTokens.length, rightTokens.length)
  return overlap >= 6 && shorterCoverage >= 0.78 && longerCoverage >= 0.58
}

export function canonicalRichTextMath(latex: string, display: boolean) {
  const source = stripRichTextMathDelimiters(latex)
  return display ? `\\[${source}\\]` : `\\(${source}\\)`
}

export function stripRichTextMathDelimiters(value: string) {
  const trimmed = value.trim()
  const match = scanRichTextMath(trimmed).find(
    (candidate) => candidate.from === 0 && candidate.to === trimmed.length
  )
  return (match?.latex ?? trimmed)
    .replace(/^```(?:latex|tex)?\s*/i, '')
    .replace(/```$/i, '')
    .trim()
}

function parseHtml(html: string) {
  if (typeof DOMParser === 'undefined') return null
  return new DOMParser().parseFromString(html || '', 'text/html')
}

function textBlocks(doc: Document) {
  const candidates = Array.from(doc.body.querySelectorAll<HTMLElement>(TEXT_BLOCK_SELECTOR))
  const leaves = candidates.filter((candidate) => !candidate.querySelector(TEXT_BLOCK_SELECTOR))
  return leaves.length > 0 ? leaves : [doc.body]
}

interface RichTextRunSegment {
  from: number
  to: number
  node: Text
}

interface RichTextRun {
  value: string
  segments: RichTextRunSegment[]
}

function richTextRuns(container: HTMLElement): RichTextRun[] {
  if (container.matches(`pre,code,${RENDERED_MATH_SELECTOR}`)) return []

  const runs: RichTextRun[] = []
  let value = ''
  let segments: RichTextRunSegment[] = []

  const flush = () => {
    if (segments.length > 0) runs.push({ value, segments })
    value = ''
    segments = []
  }
  const visit = (node: Node) => {
    if (node.nodeType === node.TEXT_NODE) {
      const text = node as Text
      if (!text.data) return
      const from = value.length
      value += text.data
      segments.push({ from, to: value.length, node: text })
      return
    }
    if (node.nodeType !== node.ELEMENT_NODE) return
    const element = node as HTMLElement
    if (element.matches(`pre,code,${RENDERED_MATH_SELECTOR}`)) {
      flush()
      return
    }
    if (element.tagName === 'BR') {
      value += '\n'
      return
    }
    Array.from(element.childNodes).forEach(visit)
  }

  Array.from(container.childNodes).forEach(visit)
  flush()
  return runs
}

function replaceRunRange(
  run: RichTextRun,
  from: number,
  to: number,
  replacement: string | Node
) {
  const start = run.segments.find((segment) => from >= segment.from && from < segment.to)
  const end = [...run.segments]
    .reverse()
    .find((segment) => to > segment.from && to <= segment.to)
  if (!start || !end) return false

  const range = start.node.ownerDocument.createRange()
  range.setStart(start.node, from - start.from)
  range.setEnd(end.node, to - end.from)
  range.deleteContents()
  range.insertNode(
    typeof replacement === 'string'
      ? start.node.ownerDocument.createTextNode(replacement)
      : replacement
  )
  return true
}

function blockMathMatches(block: HTMLElement) {
  return richTextRuns(block).flatMap((run, runIndex) =>
    scanRichTextMath(run.value).map((match) => ({ match, run, runIndex }))
  )
}

export function scanRichTextMathHtml(html: string): RichTextMathHtmlMatch[] {
  const doc = parseHtml(html)
  if (!doc) return []
  return textBlocks(doc).flatMap((block, blockIndex) =>
    blockMathMatches(block).map(({ match, runIndex }) => ({
      ...match,
      blockIndex,
      runIndex,
    }))
  )
}

/**
 * Canonicalize one formula at its original text occurrence. Existing markup around the
 * text node is preserved, and no canvas coordinates are involved.
 */
export function embedLatexInRichTextHtml(
  html: string,
  latex: string,
  options: { blockIndex?: number; display?: boolean } = {}
): EmbedRichTextMathResult {
  const doc = parseHtml(html)
  if (!doc) return { html, status: 'not_found', display: !!options.display }
  const blocks = textBlocks(doc)
  const requestedBlock = options.blockIndex
  const order = requestedBlock !== undefined && blocks[requestedBlock]
    ? [requestedBlock, ...blocks.map((_, index) => index).filter((index) => index !== requestedBlock)]
    : blocks.map((_, index) => index)
  const source = stripRichTextMathDelimiters(latex)
  const normalized = normalizeRichTextLatex(source)
  let existing: { display: boolean; blockIndex: number } | undefined

  for (const blockIndex of order) {
    const block = blocks[blockIndex]
    const runs = richTextRuns(block)

    for (const run of runs) {
      for (const match of scanRichTextMath(run.value)) {
        if (
          normalizeRichTextLatex(match.latex) !== normalized &&
          !equivalentRichTextLatex(match.latex, source)
        ) continue
        if (match.canonical) {
          existing ??= { display: match.display, blockIndex }
          continue
        }
        if (!replaceRunRange(
          run,
          match.from,
          match.to,
          canonicalRichTextMath(source, match.display)
        )) continue
        return {
          html: doc.body.innerHTML,
          status: 'embedded',
          display: match.display,
          blockIndex,
        }
      }
    }

    for (const run of runs) {
      const delimitedRanges = scanRichTextMath(run.value)
      let from = run.value.indexOf(source)
      while (from >= 0) {
        const to = from + source.length
        const insideDelimiter = delimitedRanges.some(
          (match) => from >= match.from && to <= match.to
        )
        if (!insideDelimiter) {
          const blockOnlyContainsFormula = normalizeRichTextLatex(block.textContent ?? '') === normalized
          const display = !!options.display && blockOnlyContainsFormula
          if (!replaceRunRange(run, from, to, canonicalRichTextMath(source, display))) {
            break
          }
          return {
            html: doc.body.innerHTML,
            status: 'embedded',
            display,
            blockIndex,
          }
        }
        from = run.value.indexOf(source, from + Math.max(1, source.length))
      }
    }
  }

  if (existing) {
    return {
      html,
      status: 'existing',
      display: existing.display,
      blockIndex: existing.blockIndex,
    }
  }
  return { html, status: 'not_found', display: !!options.display }
}

export function richTextContainsLatex(html: string, latex?: string) {
  if (!html.includes('$') && !html.includes('\\(') && !html.includes('\\[')) return false
  const normalized = latex ? normalizeRichTextLatex(latex) : ''
  return scanRichTextMathHtml(html).some(
    (match) =>
      !normalized ||
      normalizeRichTextLatex(match.latex) === normalized ||
      (!!latex && equivalentRichTextLatex(match.latex, latex))
  )
}

/** Canonicalize every recognizable formula while preserving its rich-text block position. */
export function normalizeAllRichTextMathHtml(html: string): NormalizeRichTextMathResult {
  const doc = parseHtml(html)
  if (!doc) return { html, total: 0, normalized: 0 }
  let total = 0
  let normalized = 0
  const blocks = textBlocks(doc)

  for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex--) {
    const runs = richTextRuns(blocks[blockIndex])
    for (let runIndex = runs.length - 1; runIndex >= 0; runIndex--) {
      const run = runs[runIndex]
      const matches = scanRichTextMath(run.value)
      total += matches.length
      for (let matchIndex = matches.length - 1; matchIndex >= 0; matchIndex--) {
        const match = matches[matchIndex]
        if (match.canonical) continue
        if (
          replaceRunRange(
            run,
            match.from,
            match.to,
            canonicalRichTextMath(match.latex, match.display)
          )
        ) {
          normalized++
        }
      }
    }
  }

  return {
    html: normalized > 0 ? doc.body.innerHTML : html,
    total,
    normalized,
  }
}

/** Render-only transformation. The stored HTML continues to contain editable TeX source. */
export function renderRichTextMathHtml(html: string) {
  if (!html.includes('$') && !html.includes('\\(') && !html.includes('\\[')) return html
  const doc = parseHtml(html)
  if (!doc) return html
  let renderedCount = 0
  const blocks = textBlocks(doc)
  for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex--) {
    const runs = richTextRuns(blocks[blockIndex])
    for (let runIndex = runs.length - 1; runIndex >= 0; runIndex--) {
      const run = runs[runIndex]
      const matches = scanRichTextMath(run.value)
      for (let matchIndex = matches.length - 1; matchIndex >= 0; matchIndex--) {
        const match = matches[matchIndex]
        const rendered = doc.createElement('span')
        rendered.className = match.display ? 'jinyan-notes-math-display' : 'jinyan-notes-math-inline'
        rendered.setAttribute('data-jinyan-notes-rendered-math', match.display ? 'block' : 'inline')
        rendered.setAttribute('data-latex', match.latex)
        try {
          rendered.innerHTML = katex.renderToString(match.latex, {
            displayMode: match.display,
            throwOnError: false,
            strict: 'ignore',
            output: 'html',
          })
        } catch {
          rendered.textContent = match.raw
        }
        if (replaceRunRange(run, match.from, match.to, rendered)) renderedCount++
      }
    }
  }
  return renderedCount > 0 ? doc.body.innerHTML : html
}
