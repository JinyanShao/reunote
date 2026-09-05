import { useCallback, useEffect, useRef, useState } from 'react'
import { Clock, FileText, Hash, Search, Star } from 'lucide-react'
import { useApp } from '../lib/store'
import * as api from '../lib/api'
import type { SearchHit } from '../lib/types'
import { cn, debounce, formatTime } from '../lib/utils'
import { Portal } from './ui'

type Mode = 'all' | 'favorites' | 'tag'

export function SearchPalette() {
  const open = useApp((s) => s.searchOpen)
  const notebooks = useApp((s) => s.notebooks)
  const tags = useApp((s) => s.tags)
  const store = useApp

  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [active, setActive] = useState(0)
  const [scope, setScope] = useState<string>('')
  const [mode, setMode] = useState<Mode>('all')
  const [tag, setTag] = useState<string>('')
  const inputRef = useRef<HTMLInputElement>(null)

  const runSearch = useCallback(
    async (q: string, notebookId: string, m: Mode, t: string) => {
      try {
        if (m === 'favorites') {
          setHits(await api.listFavorites())
          return
        }
        if (m === 'tag' && t) {
          setHits(await api.pagesByTag(t))
          return
        }
        if (!q.trim()) {
          setHits(await api.recentPages(20))
          return
        }
        setHits(
          await api.search({
            query: q,
            notebookId: notebookId || null,
            limit: 60,
          })
        )
      } catch {
        setHits([])
      }
    },
    []
  )

  const debounced = useRef(
    debounce((...args: never[]) => {
      const [q, nb, m, t] = args as unknown as [string, string, Mode, string]
      void runSearch(q, nb, m, t)
    }, 130)
  ).current

  useEffect(() => {
    if (!open) return
    setActive(0)
    debounced(query as never, scope as never, mode as never, tag as never)
  }, [query, scope, mode, tag, open, debounced])

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 40)
      void store.getState().refreshTags()
      const preset = store.getState().searchPreset
      if (preset) {
        setQuery('')
        setMode(preset.mode)
        setTag(preset.tag ?? '')
        store.getState().setUI({ searchPreset: null })
      }
    } else {
      setQuery('')
      setMode('all')
      setTag('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        store.getState().setUI({ searchOpen: false })
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((v) => Math.min(v + 1, hits.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((v) => Math.max(v - 1, 0))
      } else if (e.key === 'Enter' && hits[active]) {
        e.preventDefault()
        void store.getState().openPage(hits[active].pageId)
        store.getState().setUI({ searchOpen: false })
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, hits, active, store])

  if (!open) return null

  return (
    <Portal>
      <div className="fixed inset-0 z-[9997] flex items-start justify-center bg-black/25 pt-[12vh] backdrop-blur-[2px] animate-fade-in">
        <div
          className="absolute inset-0"
          onClick={() => store.getState().setUI({ searchOpen: false })}
        />
        <div className="relative flex max-h-[68vh] w-[640px] flex-col overflow-hidden rounded-2xl border border-[var(--ink-border)] bg-[var(--ink-panel)] shadow-float animate-pop-in">
          <div className="flex items-center gap-2.5 border-b border-[var(--ink-border)] px-4 py-3">
            <Search size={17} className="shrink-0 text-[var(--ink-muted)]" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                if (e.target.value) setMode('all')
              }}
              placeholder={
                mode === 'favorites'
                  ? '收藏的页面'
                  : mode === 'tag'
                    ? `标签 #${tag} 下的页面`
                    : '搜索全部笔记…'
              }
              className="flex-1 bg-transparent text-[15px] outline-none placeholder:text-[var(--ink-muted)]"
            />
            <kbd className="rounded border border-[var(--ink-border)] px-1.5 py-0.5 text-[10px] text-[var(--ink-muted)]">
              esc
            </kbd>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 border-b border-[var(--ink-border)] px-3 py-2">
            <Pill active={mode === 'all'} onClick={() => setMode('all')}>
              全部
            </Pill>
            <Pill
              active={mode === 'favorites'}
              onClick={() => setMode(mode === 'favorites' ? 'all' : 'favorites')}
            >
              <Star size={11} /> 收藏
            </Pill>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              className="rounded-full border border-[var(--ink-border)] bg-transparent px-2 py-[3px] text-[11.5px] outline-none"
            >
              <option value="">所有笔记本</option>
              {notebooks.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                </option>
              ))}
            </select>
            {tags
              .slice()
              .sort((a, b) => (a.name === tag ? -1 : b.name === tag ? 1 : 0))
              .slice(0, 6)
              .map((t) => (
                <Pill
                  key={t.id}
                  active={mode === 'tag' && tag === t.name}
                  onClick={() => {
                    if (mode === 'tag' && tag === t.name) {
                      setMode('all')
                      setTag('')
                    } else {
                      setMode('tag')
                      setTag(t.name)
                    }
                  }}
                >
                  <Hash size={10} />
                  {t.name}
                </Pill>
              ))}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {hits.length === 0 && (
              <div className="px-4 py-10 text-center text-[13px] text-[var(--ink-muted)]">
                {query ? '没有找到匹配的内容' : '开始输入以搜索'}
              </div>
            )}
            {hits.map((h, i) => (
              <button
                key={h.pageId}
                onMouseEnter={() => setActive(i)}
                onClick={() => {
                  void store.getState().openPage(h.pageId)
                  store.getState().setUI({ searchOpen: false })
                }}
                className={cn(
                  'flex w-full items-start gap-2.5 rounded-xl px-3 py-2 text-left transition',
                  i === active ? 'bg-[var(--ink-accent-soft)]' : 'hover:bg-[var(--ink-panel-2)]'
                )}
              >
                <FileText
                  size={14}
                  className={cn(
                    'mt-[3px] shrink-0',
                    i === active ? 'text-[var(--ink-accent)]' : 'text-[var(--ink-muted)]'
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-medium">
                    {h.title || '未命名页面'}
                  </div>
                  {h.snippet && (
                    <div className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-[var(--ink-muted)]">
                      {h.snippet}
                    </div>
                  )}
                  <div className="mt-1 flex items-center gap-1.5 text-[10.5px] text-[var(--ink-muted)]">
                    <span>{h.notebookName}</span>
                    <span>/</span>
                    <span>{h.sectionName}</span>
                    <Clock size={9} className="ml-1" />
                    {formatTime(h.updatedAt)}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </Portal>
  )
}

function Pill({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode
  active?: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-1 rounded-full border px-2.5 py-[3px] text-[11.5px] transition',
        active
          ? 'border-[var(--ink-accent)] bg-[var(--ink-accent-soft)] text-[var(--ink-accent)]'
          : 'border-[var(--ink-border)] text-[var(--ink-muted)] hover:text-[var(--ink-text)]'
      )}
    >
      {children}
    </button>
  )
}
