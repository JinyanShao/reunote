import { useEffect, useMemo, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Copy,
  CornerDownRight,
  FilePlus2,
  Search,
  Star,
  Trash2,
  X,
} from 'lucide-react'
import { useApp } from '../lib/store'
import * as api from '../lib/api'
import { duplicatePageSafely } from '../lib/documentCommands'
import { buildPageTreeRows } from '../lib/pageTree'
import { cn, formatTime } from '../lib/utils'
import { Divider, MenuItem, Portal, useTextPrompt, useToast } from './ui'

export function PageList() {
  const pages = useApp((s) => s.pages)
  const pageId = useApp((s) => s.pageId)
  const sections = useApp((s) => s.sections)
  const sectionId = useApp((s) => s.sectionId)
  const store = useApp
  const toast = useToast()
  const promptText = useTextPrompt()

  const [query, setQuery] = useState('')
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set())
  const [ctx, setCtx] = useState<{ x: number; y: number; id: string; title: string } | null>(null)

  useEffect(() => {
    if (!ctx) return
    const close = () => setCtx(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [ctx])

  const section = sections.find((s) => s.id === sectionId)

  /** 与相邻页面交换 sortOrder；如果排序值重复则先重新编号 */
  const movePage = async (id: string, delta: number) => {
    const list = pages.slice()
    const i = list.findIndex((p) => p.id === id)
    const j = i + delta
    if (i < 0 || j < 0 || j >= list.length) return

    // 统一重新编号，既能修掉历史上重复/为 0 的排序值，也避免依赖旧值做交换
    const orders = list.map((_, k) => (k + 1) * 1000)
    const reordered = list.slice()
    const tmp = reordered[i]
    reordered[i] = reordered[j]
    reordered[j] = tmp

    for (let k = 0; k < reordered.length; k++) {
      await api.updatePageMeta({ id: reordered[k].id, sortOrder: orders[k] })
    }
    if (sectionId) useApp.setState({ pages: await api.listPages(sectionId) })
  }

  useEffect(() => {
    if (!pageId) return
    const byId = new Map(pages.map((page) => [page.id, page]))
    setCollapsedIds((current) => {
      const next = new Set(current)
      let parentId = byId.get(pageId)?.parentId ?? null
      let changed = false
      const visited = new Set<string>()
      while (parentId && !visited.has(parentId)) {
        visited.add(parentId)
        changed = next.delete(parentId) || changed
        parentId = byId.get(parentId)?.parentId ?? null
      }
      return changed ? next : current
    })
  }, [pageId, pages])

  const treeRows = useMemo(
    () => buildPageTreeRows(pages, query, collapsedIds),
    [pages, query, collapsedIds]
  )

  return (
    <div className="flex h-full w-[248px] shrink-0 flex-col border-r border-[var(--ink-border)] bg-[var(--ink-panel-2)]">
      <div data-tauri-drag-region className="h-[38px] shrink-0 drag-region" />

      <div className="flex items-center justify-between gap-2 px-3 pb-2">
        <span className="truncate text-[13px] font-semibold">{section?.name ?? '页面'}</span>
        <button
          onClick={() => void store.getState().newPage()}
          title="新建页面 ⌘N"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--ink-panel)] hover:text-[var(--ink-text)]"
        >
          <FilePlus2 size={15} />
        </button>
      </div>

      <div className="px-3 pb-2">
        <div className="relative">
          <Search
            size={13}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--ink-muted)]"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="筛选本分区"
            className="w-full rounded-lg border border-transparent bg-[var(--ink-panel)] py-1 pl-7 pr-6 text-[12px] outline-none focus:border-[var(--ink-accent)]"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[var(--ink-muted)]"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {treeRows.map(({ page: p, depth, hasChildren }) => (
          <div
            key={p.id}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setCtx({ x: e.clientX, y: e.clientY, id: p.id, title: p.title })
            }}
            className={cn(
              'relative mb-1 flex w-full items-start rounded-lg border py-1.5 pr-2 transition',
              p.id === pageId
                ? 'border-[var(--ink-accent)] bg-[var(--ink-panel)] shadow-card'
                : 'border-transparent hover:bg-[var(--ink-panel)]'
            )}
            style={{ marginLeft: Math.min(depth, 5) * 13, width: `calc(100% - ${Math.min(depth, 5) * 13}px)` }}
          >
            {depth > 0 && (
              <CornerDownRight
                size={12}
                className="ml-1 mt-[5px] shrink-0 text-[var(--ink-border)]"
                aria-hidden="true"
              />
            )}
            {hasChildren ? (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  setCollapsedIds((current) => {
                    const next = new Set(current)
                    if (next.has(p.id)) next.delete(p.id)
                    else next.add(p.id)
                    return next
                  })
                }}
                title={collapsedIds.has(p.id) ? '展开子页面' : '折叠子页面'}
                aria-label={collapsedIds.has(p.id) ? `展开“${p.title}”的子页面` : `折叠“${p.title}”的子页面`}
                className="mt-[1px] flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--ink-muted)] hover:bg-black/5 dark:hover:bg-white/10"
              >
                {collapsedIds.has(p.id) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
              </button>
            ) : (
              <span className="h-5 w-5 shrink-0" />
            )}
            <button
              type="button"
              onClick={() => void store.getState().openPage(p.id)}
              className="min-w-0 flex-1 text-left"
            >
              <div className="flex items-start gap-1.5">
              <span
                className={cn(
                  'flex-1 truncate text-[13px]',
                  p.id === pageId ? 'font-semibold' : 'font-medium'
                )}
              >
                {p.title || '未命名页面'}
              </span>
              {p.favorite && (
                <Star size={12} className="mt-[3px] shrink-0 fill-amber-400 text-amber-400" />
              )}
              </div>
              {p.preview && (
                <div className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-[var(--ink-muted)]">
                  {p.preview}
                </div>
              )}
              <div className="mt-1 flex items-center gap-1.5">
                <span className="text-[10.5px] text-[var(--ink-muted)]">
                  {formatTime(p.updatedAt)}
                </span>
                {p.tags.slice(0, 2).map((t) => (
                  <span key={t} className="chip !py-0 !text-[10px]">
                    #{t}
                  </span>
                ))}
              </div>
            </button>
          </div>
        ))}

        {treeRows.length === 0 && (
          <div className="px-3 py-6 text-center text-[12px] text-[var(--ink-muted)]">
            {query ? '没有匹配的页面' : '这个分区还没有页面'}
          </div>
        )}
      </div>

      {ctx && (
        <Portal>
          <div
            style={{ left: Math.min(ctx.x, window.innerWidth - 200), top: ctx.y, width: 190 }}
            className="fixed z-[9999] rounded-xl border border-[var(--ink-border)] bg-[var(--ink-panel)] p-1 shadow-float animate-pop-in"
            onClick={(e) => e.stopPropagation()}
          >
            <MenuItem
              onClick={async () => {
                const target = ctx
                setCtx(null)
                const title = await promptText({
                  title: '重命名页面',
                  label: '页面名称',
                  value: target.title,
                })
                if (title === null) return
                try {
                  await store.getState().renamePage(target.id, title)
                  toast('页面名称已更新', 'success')
                } catch (error) {
                  toast(error instanceof Error ? error.message : String(error), 'error')
                }
              }}
            >
              重命名
            </MenuItem>
            <MenuItem
              icon={<Star size={14} />}
              onClick={async () => {
                setCtx(null)
                await store.getState().toggleFavorite(ctx.id)
              }}
            >
              收藏 / 取消收藏
            </MenuItem>
            <MenuItem
              icon={<Copy size={14} />}
              onClick={async () => {
                const target = ctx
                setCtx(null)
                try {
                  const duplicateId = await duplicatePageSafely(target.id)
                  toast(duplicateId ? '已创建并打开副本' : '无法创建副本', duplicateId ? 'success' : 'error')
                } catch (error) {
                  toast(error instanceof Error ? error.message : String(error), 'error')
                }
              }}
            >
              创建副本
            </MenuItem>
            <Divider />
            <MenuItem
              icon={<ArrowUp size={14} />}
              disabled={pages.findIndex((p) => p.id === ctx.id) <= 0}
              onClick={() => {
                setCtx(null)
                void movePage(ctx.id, -1)
              }}
            >
              上移
            </MenuItem>
            <MenuItem
              icon={<ArrowDown size={14} />}
              disabled={pages.findIndex((p) => p.id === ctx.id) >= pages.length - 1}
              onClick={() => {
                setCtx(null)
                void movePage(ctx.id, 1)
              }}
            >
              下移
            </MenuItem>
            <Divider />
            <MenuItem
              danger
              icon={<Trash2 size={14} />}
              onClick={async () => {
                setCtx(null)
                await store.getState().removePage(ctx.id)
                toast('已移入回收站')
              }}
            >
              移到回收站
            </MenuItem>
          </div>
        </Portal>
      )}
    </div>
  )
}
