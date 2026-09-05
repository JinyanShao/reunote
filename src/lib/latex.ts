const FENCED_LATEX = /^```(?:latex|tex)\s*([\s\S]*?)```$/i

export function parseLatexInput(input: string): string | null {
  let text = input.trim()
  if (!text || text.length > 4000) return null

  const fenced = FENCED_LATEX.exec(text)
  if (fenced) text = fenced[1].trim()

  const wrappers: RegExp[] = [
    /^\$\$([\s\S]+)\$\$$/,
    /^\\\[([\s\S]+)\\\]$/,
    /^\\\(([\s\S]+)\\\)$/,
    /^\$([^\n$]+)\$$/,
  ]
  for (const wrapper of wrappers) {
    const match = wrapper.exec(text)
    if (match?.[1]?.trim()) return match[1].trim()
  }

  if (/\b(?:const|let|var|function|class|return|import|export)\b/.test(text) || /[;`]/.test(text)) {
    return null
  }
  const hasLatexCommand = /\\[a-zA-Z]+(?:\s*\{|\b)/.test(text)
  const hasStructuredScript = /(?:\^[{A-Za-z0-9]|_\{)[^\n]*/.test(text)
  const hasEquation = /(?:=|≈|≠|≤|≥|<|>)/.test(text)
  return hasLatexCommand || (hasStructuredScript && hasEquation) ? text : null
}
