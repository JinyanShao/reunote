import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  Bot,
  Check,
  Cloud,
  Download,
  Grid3x3,
  History,
  Link2,
  Maximize2,
  Minus,
  PanelLeft,
  Plus,
  Redo2,
  Search,
  Star,
  Undo2,
} from 'lucide-react'
import { useApp } from '../lib/store'
import { useCanvasAgent } from '../lib/agent/store'
import { emit } from '../lib/bus'
import {
  canRedoDocument,
  canUndoDocument,
  redoDocument,
  undoDocument,
} from '../lib/documentCommands'
import {
  getActiveEditorHistory,
  subscribeActiveEditorHistory,
} from '../lib/activeEditor'
import type { BackgroundKind } from '../lib/types'
import { cn, formatTime } from '../lib/utils'
import { IconButton, MenuItem, Popover, Divider } from './ui'

const BACKGROUNDS: [BackgroundKind, string][] = [
  ['grid', '方格'],
  ['dots', '点阵'],
  ['lines', '横线'],
  ['staff', '窄横线'],
  ['blank', '空白'],
]

export function TopBar({
  onExport,
}: {
  onExport: (kind: 'md' | 'png' | 'pdf' | 'backup') => void
}) {
  const title = useApp((s) => s.title)
  const setTitle = useApp((s) => s.setTitle)
  const pageId = useApp((s) => s.pageId)
  const pages = useApp((s) => s.pages)
  const saving = useApp((s) => s.saving)
  const dirty = useApp((s) => s.dirty)
  const lastSaved = useApp((s) => s.lastSaved)
  const viewport = useApp((s) => s.viewport)
  const doc = useApp((s) => s.doc)
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const aiOpen = useApp((s) => s.aiOpen)
  const panel = useApp((s) => s.panel)
  useApp((s) => s.past.length)
  useApp((s) => s.future.length)
  const historyLocked = useCanvasAgent((s) => s.running || s.finalizing)
  useSyncExternalStore(
    subscribeActiveEditorHistory,
    getActiveEditorHistory,
    getActiveEditorHistory
  )
  const canUndo = canUndoDocument()
  const canRedo = canRedoDocument()
  const store = useApp

  const [local, setLocal] = useState(title)
  useEffect(() => setLocal(title), [title, pageId])

  const current = pages.find((p) => p.id === pageId)

  return (
    <div
      data-tauri-drag-region
      className="flex h-[52px] shrink-0 items-center gap-1.5 border-b border-[var(--ink-border)] bg-[var(--ink-panel)] px-3 drag-region"
      style={{ paddingLeft: sidebarOpen ? undefined : 82 }}
    >
      <IconButton
        title="显示/隐藏边栏 ⌘\"
        active={sidebarOpen}
        onClick={() => store.getState().setUI({ sidebarOpen: !sidebarOpen })}
      >
        <PanelLeft size={16} />
      </IconButton>

      <IconButton
        title="撤回 ⌘Z"
        aria-label="撤回"
        disabled={!pageId || !canUndo || historyLocked}
        onPointerDown={(event) => event.preventDefault()}
        onMouseDown={(event) => event.preventDefault()}
        onClick={undoDocument}
      >
        <Undo2 size={15} />
      </IconButton>
      <IconButton
        title="恢复 ⌘⇧Z"
        aria-label="恢复"
        disabled={!pageId || !canRedo || historyLocked}
        onPointerDown={(event) => event.preventDefault()}
        onMouseDown={(event) => event.preventDefault()}
        onClick={redoDocument}
      >
        <Redo2 size={15} />
      </IconButton>

      <input
        value={local}
        onChange={(e) => {
          setLocal(e.target.value)
          setTitle(e.target.value)
        }}
        disabled={!pageId}
        placeholder="未命名页面"
        className="no-drag mx-1 min-w-0 flex-1 bg-transparent text-[15px] font-semibold outline-none placeholder:font-normal placeholder:text-[var(--ink-muted)] disabled:opacity-50"
      />

      {pageId && (
        <IconButton
          title={current?.favorite ? '取消收藏' : '收藏'}
          onClick={() => void store.getState().toggleFavorite(pageId)}
        >
          <Star
            size={15}
            className={cn(current?.favorite && 'fill-amber-400 text-amber-400')}
          />
        </IconButton>
      )}

      <div className="no-drag flex w-[112px] shrink-0 items-center justify-end gap-1 text-[11px] text-[var(--ink-muted)]">
        {saving ? (
          <>
            <Cloud size={12} className="animate-pulse" /> 保存中…
          </>
        ) : dirty ? (
          <>
            <Cloud size={12} /> 待保存
          </>
        ) : lastSaved ? (
          <>
            <Check size={12} /> {formatTime(lastSaved)}
          </>
        ) : null}
      </div>

      <div className="mx-1 h-5 w-px bg-[var(--ink-border)]" />

      {/* 缩放 */}
      <div className="no-drag flex items-center rounded-lg bg-[var(--ink-panel-2)]">
        <IconButton title="缩小 ⌘-" onClick={() => emit({ type: 'zoom', factor: 1 / 1.2 })}>
          <Minus size={14} />
        </IconButton>
        <button
          onClick={() => emit({ type: 'zoom-reset' })}
          className="w-[46px] text-center text-[11.5px] tabular-nums text-[var(--ink-muted)] hover:text-[var(--ink-text)]"
          title="实际大小 ⌘0"
        >
          {Math.round(viewport.zoom * 100)}%
        </button>
        <IconButton title="放大 ⌘=" onClick={() => emit({ type: 'zoom', factor: 1.2 })}>
          <Plus size={14} />
        </IconButton>
        <IconButton title="适应内容 ⌘9" onClick={() => emit({ type: 'zoom-fit' })}>
          <Maximize2 size={13} />
        </IconButton>
      </div>

      {/* 背景 */}
      <Popover
        align="end"
        width={150}
        trigger={
          <IconButton title="页面背景">
            <Grid3x3 size={16} />
          </IconButton>
        }
      >
        {(close) => (
          <div className="p-1">
            {BACKGROUNDS.map(([k, label]) => (
              <button
                key={k}
                onClick={() => {
                  store.getState().updateDoc((d) => {
                    d.background = k
                  })
                  close()
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px]',
                  doc.background === k
                    ? 'bg-[var(--ink-accent)] text-white'
                    : 'hover:bg-[var(--ink-panel-2)]'
                )}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </Popover>

      <IconButton
        title="全局搜索 ⌘K"
        onClick={() => store.getState().setUI({ searchOpen: true })}
      >
        <Search size={16} />
      </IconButton>

      <IconButton
        title="反向链接"
        active={panel === 'backlinks'}
        onClick={() =>
          store.getState().setUI({ panel: panel === 'backlinks' ? null : 'backlinks' })
        }
      >
        <Link2 size={16} />
      </IconButton>

      <IconButton
        title="版本历史"
        active={panel === 'versions'}
        onClick={() => store.getState().setUI({ panel: panel === 'versions' ? null : 'versions' })}
      >
        <History size={16} />
      </IconButton>

      <Popover
        align="end"
        width={190}
        trigger={
          <IconButton title="导出">
            <Download size={16} />
          </IconButton>
        }
      >
        {(close) => (
          <div className="p-1">
            <MenuItem
              onClick={() => {
                close()
                onExport('md')
              }}
            >
              导出为 Markdown
            </MenuItem>
            <MenuItem
              onClick={() => {
                close()
                onExport('png')
              }}
            >
              导出为图片 PNG
            </MenuItem>
            <MenuItem
              onClick={() => {
                close()
                onExport('pdf')
              }}
            >
              打印 / 存为 PDF
            </MenuItem>
            <Divider />
            <MenuItem
              onClick={() => {
                close()
                onExport('backup')
              }}
            >
              备份整个笔记库
            </MenuItem>
          </div>
        )}
      </Popover>

      <IconButton
        title="AI 助手 ⌘J"
        active={aiOpen}
        onClick={() => store.getState().setUI({ aiOpen: !aiOpen })}
      >
        <Bot size={16} />
      </IconButton>
    </div>
  )
}
