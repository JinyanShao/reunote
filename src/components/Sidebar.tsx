import { useEffect, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Book,
  ChevronRight,
  Clock,
  Hash,
  Plus,
  Settings,
  Star,
  Trash2,
} from 'lucide-react'
import { useApp } from '../lib/store'
import * as api from '../lib/api'
import { cn, formatTime, NOTEBOOK_COLORS } from '../lib/utils'
import { Divider, MenuItem, Portal, Swatches, useTextPrompt, useToast } from './ui'

interface Ctx {
  x: number
  y: number
  kind: 'notebook' | 'section'
  id: string
  name: string
}

export function Sidebar() {
  const notebooks = useApp((s) => s.notebooks)
  const sections = useApp((s) => s.sections)
  const notebookId = useApp((s) => s.notebookId)
  const sectionId = useApp((s) => s.sectionId)
  const recents = useApp((s) => s.recents)
  const tags = useApp((s) => s.tags)
  const collapsed = useApp((s) => s.settings.collapsedNotebooks ?? [])
  const store = useApp
  const toast = useToast()
  const promptText = useTextPrompt()

  const [ctx, setCtx] = useState<Ctx | null>(null)
  const [showRecents, setShowRecents] = useState(false)

  const createSectionInNotebook = async (targetNotebookId: string) => {
    try {
      const current = store.getState()
      if (current.notebookId !== targetNotebookId) {
        const selected = await current.selectNotebook(targetNotebookId)
        if (!selected) {
          toast('当前页面保存失败，已取消新建分区', 'error')
          return
        }
      } else if ((current.settings.collapsedNotebooks ?? []).includes(targetNotebookId)) {
        current.toggleNotebookCollapsed(targetNotebookId)
      }
      await store.getState().newSection()
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  /** 与相邻分区交换 sortOrder；排序值有重复时先重新编号 */
  const moveSection = async (id: string, delta: number) => {
    const list = sections.slice()
    const i = list.findIndex((s) => s.id === id)
    const j = i + delta
    if (i < 0 || j < 0 || j >= list.length) return

    // 统一重新编号，既能修掉历史上重复/为 0 的排序值，也避免依赖旧值做交换
    const orders = list.map((_, k) => (k + 1) * 1000)
    const reordered = list.slice()
    const tmp = reordered[i]
    reordered[i] = reordered[j]
    reordered[j] = tmp

    for (let k = 0; k < reordered.length; k++) {
      await api.updateSection({ id: reordered[k].id, sortOrder: orders[k] })
    }
    await store.getState().refreshTree()
  }

  useEffect(() => {
    if (!ctx) return
    const close = () => setCtx(null)
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close)
    }
  }, [ctx])

  return (
    <div className="flex h-full w-[232px] shrink-0 flex-col border-r border-[var(--ink-border)] bg-[var(--ink-panel)]">
      <div data-tauri-drag-region className="h-[38px] shrink-0 drag-region" />

      <div className="flex items-center justify-between px-3 pb-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--ink-muted)]">
          笔记本
        </span>
        <button
          onClick={() => void store.getState().newNotebook()}
          title="新建笔记本"
          className="flex h-5 w-5 items-center justify-center rounded text-[var(--ink-muted)] hover:bg-[var(--ink-panel-2)] hover:text-[var(--ink-text)]"
        >
          <Plus size={14} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {notebooks.map((nb) => {
          const isCurrent = nb.id === notebookId
          const open = isCurrent && !collapsed.includes(nb.id)
          return (
            <div key={nb.id} className="mb-0.5">
              <div
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setCtx({ x: e.clientX, y: e.clientY, kind: 'notebook', id: nb.id, name: nb.name })
                }}
                className={cn(
                  'group flex w-full items-center gap-1 rounded-lg pr-2 text-left text-[13px] transition',
                  isCurrent
                    ? 'bg-[var(--ink-accent-soft)] font-medium text-[var(--ink-accent)]'
                    : 'hover:bg-[var(--ink-panel-2)]'
                )}
              >
                {/* 箭头：只负责展开 / 折叠，不切换笔记本 */}
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    if (isCurrent) store.getState().toggleNotebookCollapsed(nb.id)
                    else void store.getState().selectNotebook(nb.id)
                  }}
                  title={open ? '折叠' : '展开'}
                  className="flex h-[26px] w-[22px] shrink-0 items-center justify-center rounded-md hover:bg-black/5 dark:hover:bg-white/10"
                >
                  <ChevronRight
                    size={13}
                    className={cn('transition-transform', open && 'rotate-90')}
                  />
                </button>

                {/* 名称：点击切换笔记本；已经是当前笔记本时再点则折叠 */}
                <button
                  onClick={() => {
                    if (isCurrent) store.getState().toggleNotebookCollapsed(nb.id)
                    else void store.getState().selectNotebook(nb.id)
                  }}
                  className="flex min-w-0 flex-1 items-center gap-2 py-[6px] text-left"
                >
                  <span
                    className="h-[9px] w-[9px] shrink-0 rounded-[3px]"
                    style={{ background: nb.color }}
                  />
                  <span className="flex-1 truncate">{nb.name}</span>
                </button>

                <button
                  onClick={(event) => {
                    event.stopPropagation()
                    void createSectionInNotebook(nb.id)
                  }}
                  title={`在“${nb.name}”中新建分区`}
                  aria-label={`在“${nb.name}”中新建分区`}
                  className="flex h-[24px] w-[24px] shrink-0 items-center justify-center rounded-md text-[var(--ink-muted)] transition hover:bg-black/5 hover:text-[var(--ink-text)] dark:hover:bg-white/10"
                >
                  <Plus size={13} />
                </button>
              </div>

              {open && (
                <div className="mb-1 ml-[18px] mt-0.5 border-l border-[var(--ink-border)] pl-1.5">
                  {sections.map((sec) => (
                    <button
                      key={sec.id}
                      onClick={() => void store.getState().selectSection(sec.id)}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        setCtx({
                          x: e.clientX,
                          y: e.clientY,
                          kind: 'section',
                          id: sec.id,
                          name: sec.name,
                        })
                      }}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-lg px-2 py-[5px] text-left text-[12.5px] transition',
                        sec.id === sectionId
                          ? 'bg-[var(--ink-panel-2)] font-medium text-[var(--ink-text)]'
                          : 'text-[var(--ink-muted)] hover:bg-[var(--ink-panel-2)] hover:text-[var(--ink-text)]'
                      )}
                    >
                      <span
                        className="h-[7px] w-[7px] shrink-0 rounded-full"
                        style={{ background: sec.color }}
                      />
                      <span className="flex-1 truncate">{sec.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {tags.length > 0 && (
        <div className="border-t border-[var(--ink-border)] px-2 py-2">
          <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--ink-muted)]">
            标签
          </div>
          <div className="flex max-h-[92px] flex-wrap gap-1 overflow-y-auto px-1">
            {tags.slice(0, 18).map((t) => (
              <button
                key={t.id}
                onClick={() => store.getState().openSearch({ mode: 'tag', tag: t.name })}
                title={`查看带 #${t.name} 的全部页面`}
                className="chip transition hover:bg-[var(--ink-accent-soft)] hover:!text-[var(--ink-accent)]"
                style={{ color: t.color }}
              >
                <Hash size={10} />
                {t.name}
                <span className="opacity-60">{t.count}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="border-t border-[var(--ink-border)] p-1.5">
        <SideLink
          icon={<Clock size={14} />}
          label="最近打开"
          onClick={() => setShowRecents((v) => !v)}
          active={showRecents}
        />
        {showRecents && (
          <div className="mb-1 ml-6 max-h-[140px] overflow-y-auto">
            {recents.map((r) => (
              <button
                key={r.pageId}
                onClick={() => void store.getState().openPage(r.pageId)}
                className="block w-full truncate rounded-md px-2 py-1 text-left text-[12px] text-[var(--ink-muted)] hover:bg-[var(--ink-panel-2)] hover:text-[var(--ink-text)]"
                title={`${r.notebookName} / ${r.sectionName} · ${formatTime(r.updatedAt)}`}
              >
                {r.title || '未命名页面'}
              </button>
            ))}
            {recents.length === 0 && (
              <div className="px-2 py-1 text-[12px] text-[var(--ink-muted)]">暂无记录</div>
            )}
          </div>
        )}
        <SideLink
          icon={<Star size={14} />}
          label="收藏"
          onClick={() => store.getState().openSearch({ mode: 'favorites' })}
        />
        <SideLink
          icon={<Trash2 size={14} />}
          label="回收站"
          onClick={() => store.getState().setUI({ panel: 'trash' })}
        />
        <SideLink
          icon={<Settings size={14} />}
          label="设置"
          onClick={() => store.getState().setUI({ settingsOpen: true })}
        />
      </div>

      {ctx && (
        <Portal>
          <div
            style={{ left: Math.min(ctx.x, window.innerWidth - 210), top: ctx.y, width: 200 }}
            className="fixed z-[9999] rounded-xl border border-[var(--ink-border)] bg-[var(--ink-panel)] p-1 shadow-float animate-pop-in"
            onClick={(e) => e.stopPropagation()}
          >
            <MenuItem
              icon={<Book size={14} />}
              onClick={async () => {
                const target = ctx
                setCtx(null)
                const name = await promptText({
                  title: target.kind === 'notebook' ? '重命名笔记本' : '重命名分区',
                  label: target.kind === 'notebook' ? '笔记本名称' : '分区名称',
                  value: target.name,
                })
                if (name === null) return
                try {
                  if (target.kind === 'notebook')
                    await store.getState().renameNotebook(target.id, name)
                  else await store.getState().renameSection(target.id, name)
                  toast('名称已更新', 'success')
                } catch (error) {
                  toast(error instanceof Error ? error.message : String(error), 'error')
                }
              }}
            >
              重命名
            </MenuItem>
            {ctx.kind === 'notebook' && (
              <MenuItem
                icon={<Plus size={14} />}
                onClick={() => {
                  const targetNotebookId = ctx.id
                  setCtx(null)
                  void createSectionInNotebook(targetNotebookId)
                }}
              >
                新建分区
              </MenuItem>
            )}
            {ctx.kind === 'section' && (
              <>
                <MenuItem
                  icon={<ArrowUp size={14} />}
                  disabled={sections.findIndex((s) => s.id === ctx.id) <= 0}
                  onClick={() => {
                    setCtx(null)
                    void moveSection(ctx.id, -1)
                  }}
                >
                  上移
                </MenuItem>
                <MenuItem
                  icon={<ArrowDown size={14} />}
                  disabled={sections.findIndex((s) => s.id === ctx.id) >= sections.length - 1}
                  onClick={() => {
                    setCtx(null)
                    void moveSection(ctx.id, 1)
                  }}
                >
                  下移
                </MenuItem>
              </>
            )}
            <div className="px-2.5 py-2">
              <div className="mb-1.5 text-[11px] text-[var(--ink-muted)]">颜色</div>
              <Swatches
                colors={NOTEBOOK_COLORS}
                size={17}
                onChange={async (color) => {
                  if (ctx.kind === 'notebook') await api.updateNotebook({ id: ctx.id, color })
                  else await api.updateSection({ id: ctx.id, color })
                  await store.getState().refreshTree()
                  setCtx(null)
                }}
              />
            </div>
            <Divider />
            <MenuItem
              danger
              icon={<Trash2 size={14} />}
              onClick={async () => {
                setCtx(null)
                if (!window.confirm(`把「${ctx.name}」移到回收站？`)) return
                if (ctx.kind === 'notebook') await api.deleteNotebook(ctx.id)
                else await api.deleteSection(ctx.id)
                await store.getState().refreshTree()
                const s = store.getState()
                if (ctx.kind === 'notebook' && s.notebooks.length > 0)
                  await s.selectNotebook(s.notebooks.filter((n) => n.id !== ctx.id)[0]?.id ?? '')
                else if (ctx.kind === 'section' && s.notebookId) await s.selectNotebook(s.notebookId)
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

function SideLink({
  icon,
  label,
  onClick,
  active,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  active?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[6px] text-left text-[13px] transition',
        active
          ? 'bg-[var(--ink-panel-2)] text-[var(--ink-text)]'
          : 'text-[var(--ink-muted)] hover:bg-[var(--ink-panel-2)] hover:text-[var(--ink-text)]'
      )}
    >
      {icon}
      {label}
    </button>
  )
}
