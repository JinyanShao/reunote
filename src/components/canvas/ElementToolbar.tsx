import { useState } from 'react'
import {
  ArrowDownToLine,
  ArrowUpToLine,
  Copy,
  Lock,
  Palette,
  PaintBucket,
  ScanText,
  Trash2,
  Type,
  Unlock,
} from 'lucide-react'
import { useApp, newElementId } from '../../lib/store'
import type { Viewport } from '../../lib/store'
import type { Rect } from '../../lib/geometry'
import type { CanvasElement } from '../../lib/types'
import { attachmentDataUrl, recognizeText } from '../../lib/ocr'
import { IconButton, Popover, Spinner, Swatches, useTextPrompt, useToast } from '../ui'
import { PALETTE, STICKY_COLORS } from '../../lib/utils'

const FILLS = ['transparent', '#eef2ff', '#dcfce7', '#fef3c7', '#fee2e2', '#f1f5f9', '#ffffff']
const TEXT_BG = ['transparent', '#ffffff', '#fef9c3', '#eff6ff', '#f0fdf4', '#fdf2f8']

export function ElementToolbar({
  rect,
  viewport,
  onDuplicate,
}: {
  rect: Rect
  viewport: Viewport
  onDuplicate: () => void
}) {
  const selection = useApp((s) => s.selection)
  const elements = useApp((s) => s.doc.elements)
  const store = useApp
  const toast = useToast()
  const promptText = useTextPrompt()
  const [ocrBusy, setOcrBusy] = useState(false)

  const selected = elements.filter((e) => selection.includes(e.id))
  if (selected.length === 0) return null

  const left = rect.x * viewport.zoom + viewport.x + (rect.w * viewport.zoom) / 2
  const top = rect.y * viewport.zoom + viewport.y - 46

  const first = selected[0]
  const allLocked = selected.every((e) => e.locked)

  const patchAll = (patch: Record<string, unknown>) => {
    for (const el of selected) store.getState().patchElement(el.id, patch as never)
  }

  return (
    <div
      className="absolute z-40 flex -translate-x-1/2 items-center gap-0.5 rounded-xl border border-[var(--ink-border)] bg-[var(--ink-panel)] p-1 shadow-float animate-pop-in"
      style={{ left, top: Math.max(8, top) }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {first.type === 'shape' && (
        <>
          <Popover
            width={180}
            trigger={
              <IconButton title="描边颜色">
                <Palette size={15} />
              </IconButton>
            }
          >
            <div className="p-2">
              <div className="mb-1.5 text-[11px] text-[var(--ink-muted)]">描边</div>
              <Swatches colors={PALETTE} onChange={(c) => patchAll({ stroke: c })} />
              <div className="mb-1.5 mt-3 text-[11px] text-[var(--ink-muted)]">线宽</div>
              <div className="flex gap-1">
                {[1, 2, 3, 5, 8].map((w) => (
                  <button
                    key={w}
                    onClick={() => patchAll({ strokeWidth: w })}
                    className="flex h-7 flex-1 items-center justify-center rounded-md hover:bg-[var(--ink-panel-2)]"
                  >
                    <span
                      className="rounded-full bg-current"
                      style={{ width: 18, height: w }}
                    />
                  </button>
                ))}
              </div>
              <button
                onClick={() =>
                  patchAll({ dashed: !(first as { dashed?: boolean }).dashed })
                }
                className="mt-2 w-full rounded-md py-1 text-[12px] hover:bg-[var(--ink-panel-2)]"
              >
                切换虚线
              </button>
            </div>
          </Popover>
          <Popover
            width={180}
            trigger={
              <IconButton title="填充">
                <PaintBucket size={15} />
              </IconButton>
            }
          >
            <div className="p-2">
              <div className="mb-1.5 text-[11px] text-[var(--ink-muted)]">填充</div>
              <Swatches colors={FILLS} onChange={(c) => patchAll({ fill: c })} />
            </div>
          </Popover>
          <button
            onClick={async () => {
              const label = await promptText({
                title: '编辑图形文字',
                label: '文字',
                value: (first as { label?: string }).label ?? '',
                allowEmpty: true,
                confirmLabel: '应用',
              })
              if (label !== null) patchAll({ label })
            }}
            className="tool-btn"
            title="添加文字"
          >
            <Type size={15} />
          </button>
        </>
      )}

      {first.type === 'sticky' && (
        <Popover
          width={180}
          trigger={
            <IconButton title="便签颜色">
              <Palette size={15} />
            </IconButton>
          }
        >
          <div className="p-2">
            <Swatches colors={STICKY_COLORS} onChange={(c) => patchAll({ color: c })} />
          </div>
        </Popover>
      )}

      {first.type === 'text' && (
        <>
          <Popover
            width={196}
            trigger={
              <IconButton title="外观">
                <Palette size={15} />
              </IconButton>
            }
          >
            <div className="p-2">
              <div className="mb-1.5 text-[11px] text-[var(--ink-muted)]">背景</div>
              <Swatches colors={TEXT_BG} onChange={(c) => patchAll({ bg: c })} />
              <div className="mb-1.5 mt-3 text-[11px] text-[var(--ink-muted)]">边框</div>
              <Swatches
                colors={['transparent', '#e4e7ee', '#c7d2fe', '#fecaca', '#bbf7d0']}
                onChange={(c) => patchAll({ border: c })}
              />
              <div className="mb-1.5 mt-3 text-[11px] text-[var(--ink-muted)]">字体</div>
              <div className="flex gap-1">
                {(
                  [
                    ['sans', '黑体'],
                    ['serif', '宋体'],
                    ['mono', '等宽'],
                    ['hand', '手写'],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    onClick={() => patchAll({ fontFamily: k })}
                    className="flex-1 rounded-md py-1 text-[12px] hover:bg-[var(--ink-panel-2)]"
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="mb-1.5 mt-3 text-[11px] text-[var(--ink-muted)]">字号</div>
              <div className="flex gap-1">
                {[0.85, 1, 1.2, 1.5].map((s) => (
                  <button
                    key={s}
                    onClick={() => patchAll({ fontScale: s })}
                    className="flex-1 rounded-md py-1 text-[12px] hover:bg-[var(--ink-panel-2)]"
                  >
                    {s === 1 ? '标准' : `${s}×`}
                  </button>
                ))}
              </div>
            </div>
          </Popover>
        </>
      )}

      {first.type === 'image' && (
        <Popover
          width={180}
          trigger={
            <IconButton title="图片样式">
              <Palette size={15} />
            </IconButton>
          }
        >
          <div className="p-2 text-[12px]">
            <button
              onClick={() => patchAll({ radius: (first as { radius: number }).radius > 0 ? 0 : 12 })}
              className="w-full rounded-md py-1.5 hover:bg-[var(--ink-panel-2)]"
            >
              切换圆角
            </button>
            <button
              onClick={() => patchAll({ shadow: !(first as { shadow?: boolean }).shadow })}
              className="w-full rounded-md py-1.5 hover:bg-[var(--ink-panel-2)]"
            >
              切换阴影
            </button>
          </div>
        </Popover>
      )}

      {(first.type === 'image' || first.type === 'pdf') && (
        <IconButton
          title="识别图中文字（需要支持读图的 AI 模型）"
          disabled={ocrBusy}
          onClick={async () => {
            setOcrBusy(true)
            try {
              const source =
                (first as { attachmentId?: string }).attachmentId ??
                (first as { src: string }).src
              const dataUrl = await attachmentDataUrl(source)
              if (!dataUrl) throw new Error('读取图片失败')
              toast('正在识别…')
              const text = await recognizeText(dataUrl)
              const el: CanvasElement = {
                id: newElementId(),
                type: 'text',
                x: Math.round(first.x + first.w + 32),
                y: Math.round(first.y),
                w: 380,
                h: Math.max(120, Math.min(520, 40 + text.length * 0.9)),
                rotation: 0,
                z: 0,
                html: text
                  .split(/\n{2,}/)
                  .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
                  .join(''),
                bg: 'transparent',
                border: '#e4e7ee',
                fontFamily: 'sans',
                fontScale: 1,
                padding: 12,
              }
              store.getState().addElement(el)
              toast('识别完成', 'success')
            } catch (e) {
              toast(e instanceof Error ? e.message : String(e), 'error')
            } finally {
              setOcrBusy(false)
            }
          }}
        >
          {ocrBusy ? <Spinner /> : <ScanText size={15} />}
        </IconButton>
      )}

      <div className="mx-0.5 h-4 w-px bg-[var(--ink-border)]" />

      <IconButton title="置顶" onClick={() => store.getState().bringToFront(selection)}>
        <ArrowUpToLine size={15} />
      </IconButton>
      <IconButton title="置底" onClick={() => store.getState().sendToBack(selection)}>
        <ArrowDownToLine size={15} />
      </IconButton>
      <IconButton title="复制 ⌘D" onClick={onDuplicate}>
        <Copy size={15} />
      </IconButton>
      <IconButton
        title={allLocked ? '解锁' : '锁定'}
        onClick={() => patchAll({ locked: !allLocked })}
      >
        {allLocked ? <Lock size={15} /> : <Unlock size={15} />}
      </IconButton>
      <IconButton
        title="删除 ⌫"
        onClick={() => store.getState().removeElements(selection)}
        className="hover:!bg-red-500/12 hover:!text-red-500"
      >
        <Trash2 size={15} />
      </IconButton>
    </div>
  )
}
