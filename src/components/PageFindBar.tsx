import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { emit, onCmd } from '../lib/bus'
import { findCanvasMatches, stepMatchIndex } from '../lib/pageFind'
import { useApp } from '../lib/store'
import { IconButton } from './ui'

export function PageFindBar() {
  const open = useApp((state) => state.findOpen)
  const pageId = useApp((state) => state.pageId)
  const doc = useApp((state) => state.doc)
  const store = useApp
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(-1)

  const matches = useMemo(() => findCanvasMatches(doc, query), [doc, query])
  const displayIndex = matches.length
    ? Math.min(Math.max(active, 0), matches.length - 1) + 1
    : 0
  const statusText = !query.trim()
    ? '输入关键词'
    : matches.length > 0
      ? `第 ${displayIndex} 项，共 ${matches.length} 项`
      : '没有匹配结果'

  const reveal = useCallback(
    (index: number) => {
      const match = matches[index]
      if (match) emit({ type: 'reveal-element', id: match.elementId })
    },
    [matches]
  )

  const step = useCallback(
    (direction: 'next' | 'previous') => {
      setActive((current) => {
        const next = stepMatchIndex(current, matches.length, direction)
        reveal(next)
        return next
      })
    },
    [matches.length, reveal]
  )

  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [open])

  useEffect(() => {
    setQuery('')
    setActive(-1)
  }, [pageId])

  useEffect(() => {
    const next = matches.length ? 0 : -1
    setActive(next)
    if (open) reveal(next)
  }, [matches, open, reveal])

  useEffect(
    () =>
      onCmd((command) => {
        if (command.type !== 'find-next' && command.type !== 'find-previous') return
        if (!store.getState().findOpen) store.getState().setUI({ findOpen: true })
        step(command.type === 'find-next' ? 'next' : 'previous')
      }),
    [step, store]
  )

  if (!open || !pageId) return null

  return (
    <div
      className="absolute right-4 top-3 z-40 flex h-10 w-[calc(100%-2rem)] max-w-[440px] items-center gap-1 border border-[var(--ink-border)] bg-[var(--ink-panel)] px-2 shadow-float"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault()
          store.getState().setUI({ findOpen: false })
        }
      }}
    >
      <Search size={14} className="shrink-0 text-[var(--ink-muted)]" />
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            store.getState().setUI({ findOpen: false })
          } else if (event.key === 'Enter') {
            event.preventDefault()
            step(event.shiftKey ? 'previous' : 'next')
          }
        }}
        aria-label="在本页查找"
        placeholder="在本页查找"
        className="h-8 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-[var(--ink-muted)]"
      />
      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="w-[136px] shrink-0 whitespace-nowrap text-center text-[11px] tabular-nums text-[var(--ink-muted)]"
      >
        {statusText}
      </span>
      <IconButton
        title="上一个 ⇧↩"
        aria-label="上一个匹配"
        disabled={matches.length === 0}
        onClick={() => step('previous')}
      >
        <ChevronUp size={14} />
      </IconButton>
      <IconButton
        title="下一个 ↩"
        aria-label="下一个匹配"
        disabled={matches.length === 0}
        onClick={() => step('next')}
      >
        <ChevronDown size={14} />
      </IconButton>
      <IconButton
        title="关闭 Esc"
        aria-label="关闭查找"
        onClick={() => store.getState().setUI({ findOpen: false })}
      >
        <X size={14} />
      </IconButton>
    </div>
  )
}
