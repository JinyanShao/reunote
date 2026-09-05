import { useCallback, useEffect, useState } from 'react'
import { History, Link2, RotateCcw, Trash2, X } from 'lucide-react'
import { useApp, clone } from '../lib/store'
import * as api from '../lib/api'
import type { Backlink, CanvasDoc, TrashItem, VersionMeta } from '../lib/types'
import { formatBytes, formatTime } from '../lib/utils'
import { Button, IconButton, useToast } from './ui'

export function SidePanel() {
  const panel = useApp((s) => s.panel)
  const store = useApp

  if (!panel || panel === 'tags') return null

  const titles: Record<string, string> = {
    backlinks: '反向链接',
    versions: '版本历史',
    trash: '回收站',
  }

  return (
    <div className="flex h-full w-[288px] shrink-0 flex-col border-l border-[var(--ink-border)] bg-[var(--ink-panel)]">
      <div data-tauri-drag-region className="h-[38px] shrink-0 drag-region" />
      <div className="flex items-center gap-2 px-3 pb-2">
        {panel === 'backlinks' && <Link2 size={15} className="text-[var(--ink-accent)]" />}
        {panel === 'versions' && <History size={15} className="text-[var(--ink-accent)]" />}
        {panel === 'trash' && <Trash2 size={15} className="text-[var(--ink-accent)]" />}
        <span className="flex-1 text-[13px] font-semibold">{titles[panel]}</span>
        <IconButton title="关闭" onClick={() => store.getState().setUI({ panel: null })}>
          <X size={15} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {panel === 'backlinks' && <BacklinksBody />}
        {panel === 'versions' && <VersionsBody />}
        {panel === 'trash' && <TrashBody />}
      </div>
    </div>
  )
}

function BacklinksBody() {
  const pageId = useApp((s) => s.pageId)
  const title = useApp((s) => s.title)
  const store = useApp
  const [links, setLinks] = useState<Backlink[]>([])
  const [outgoing, setOutgoing] = useState<string[]>([])

  useEffect(() => {
    if (!pageId) return
    void api.backlinksOf(pageId).then(setLinks)
    const doc = store.getState().doc
    const text = JSON.stringify(doc)
    const re = /\[\[([^\]\n]{1,120})\]\]/g
    const out = new Set<string>()
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) out.add(m[1])
    setOutgoing([...out])
  }, [pageId, title, store])

  return (
    <div>
      <Section label={`指向本页（${links.length}）`}>
        {links.length === 0 && <Empty>还没有其他页面链接到这里</Empty>}
        {links.map((l) => (
          <button
            key={l.pageId}
            onClick={() => void store.getState().openPage(l.pageId)}
            className="mb-1 block w-full rounded-lg px-2.5 py-1.5 text-left hover:bg-[var(--ink-panel-2)]"
          >
            <div className="truncate text-[13px] font-medium">{l.title || '未命名页面'}</div>
            <div className="text-[11px] text-[var(--ink-muted)]">
              {l.notebookName} / {l.sectionName} · {formatTime(l.updatedAt)}
            </div>
          </button>
        ))}
      </Section>

      <Section label={`本页引用（${outgoing.length}）`}>
        {outgoing.length === 0 && (
          <Empty>
            在文字里写 <code>[[页面标题]]</code> 就能建立链接
          </Empty>
        )}
        {outgoing.map((t) => (
          <div
            key={t}
            className="mb-1 rounded-lg bg-[var(--ink-panel-2)] px-2.5 py-1.5 text-[12.5px]"
          >
            {t}
          </div>
        ))}
      </Section>
    </div>
  )
}

function VersionsBody() {
  const pageId = useApp((s) => s.pageId)
  const store = useApp
  const toast = useToast()
  const [list, setList] = useState<VersionMeta[]>([])

  const refresh = useCallback(async () => {
    if (!pageId) return
    setList(await api.listVersions(pageId))
  }, [pageId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <div>
      <Button
        variant="outline"
        className="mb-2 w-full"
        onClick={async () => {
          if (!pageId) return
          if (!(await store.getState().save(true))) {
            toast('当前页面保存失败，已取消创建快照', 'error')
            return
          }
          await api.createVersion(pageId, '手动快照')
          await refresh()
          toast('已保存快照', 'success')
        }}
      >
        保存当前快照
      </Button>

      {list.length === 0 && <Empty>还没有快照。每次打开页面前会自动记录一份。</Empty>}

      {list.map((v) => (
        <div
          key={v.id}
          className="mb-1 rounded-lg border border-[var(--ink-border)] px-2.5 py-2"
        >
          <div className="truncate text-[12.5px] font-medium">{v.title || '未命名页面'}</div>
          <div className="mt-0.5 flex items-center justify-between text-[11px] text-[var(--ink-muted)]">
            <span>
              {v.label} · {formatTime(v.createdAt)}
            </span>
            <span>{formatBytes(v.size)}</span>
          </div>
          <button
            onClick={async () => {
              if (!window.confirm('用这个快照覆盖当前页面内容？当前内容会先自动存为一份快照。')) return
              const content = await api.versionContent(v.id)
              try {
                const doc = JSON.parse(content) as CanvasDoc
                if (!(await store.getState().save(true))) {
                  toast('当前页面保存失败，已取消恢复', 'error')
                  return
                }
                if (pageId) await api.createVersion(pageId, '恢复前自动快照')
                store.getState().replaceDoc(clone(doc))
                if (!(await store.getState().save(true))) {
                  toast('快照已载入，但保存失败，页面仍标记为待保存', 'error')
                  return
                }
                toast('已恢复到该快照', 'success')
                await refresh()
              } catch {
                toast('快照内容解析失败', 'error')
              }
            }}
            className="mt-1.5 flex items-center gap-1 text-[11.5px] text-[var(--ink-accent)] hover:underline"
          >
            <RotateCcw size={11} /> 恢复到此版本
          </button>
        </div>
      ))}
    </div>
  )
}

function TrashBody() {
  const store = useApp
  const toast = useToast()
  const [items, setItems] = useState<TrashItem[]>([])

  const refresh = useCallback(async () => setItems(await api.listTrash()), [])
  useEffect(() => {
    void refresh()
  }, [refresh])

  const kindLabel: Record<string, string> = {
    page: '页面',
    section: '分区',
    notebook: '笔记本',
  }

  return (
    <div>
      {items.length === 0 && <Empty>回收站是空的</Empty>}

      {items.length > 0 && (
        <Button
          variant="ghost"
          className="mb-2 w-full !text-red-500"
          onClick={async () => {
            if (!window.confirm('清空回收站？此操作不可恢复。')) return
            await api.emptyTrash()
            await refresh()
            await store.getState().refreshTree()
            toast('回收站已清空')
          }}
        >
          清空回收站
        </Button>
      )}

      {items.map((it) => (
        <div
          key={`${it.kind}-${it.id}`}
          className="mb-1 rounded-lg border border-[var(--ink-border)] px-2.5 py-2"
        >
          <div className="truncate text-[12.5px] font-medium">{it.title || '未命名'}</div>
          <div className="mt-0.5 text-[11px] text-[var(--ink-muted)]">
            {kindLabel[it.kind]}
            {it.parentLabel ? ` · ${it.parentLabel}` : ''} · {formatTime(it.deletedAt)}
          </div>
          <div className="mt-1.5 flex gap-3">
            <button
              onClick={async () => {
                await api.restoreTrash(it.kind, it.id)
                await refresh()
                await store.getState().refreshTree()
                toast('已恢复', 'success')
              }}
              className="text-[11.5px] text-[var(--ink-accent)] hover:underline"
            >
              恢复
            </button>
            <button
              onClick={async () => {
                if (!window.confirm('彻底删除？此操作不可恢复。')) return
                await api.purgeTrash(it.kind, it.id)
                await refresh()
                toast('已彻底删除')
              }}
              className="text-[11.5px] text-red-500 hover:underline"
            >
              彻底删除
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--ink-muted)]">
        {label}
      </div>
      {children}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 py-4 text-center text-[12px] leading-relaxed text-[var(--ink-muted)]">
      {children}
    </div>
  )
}
