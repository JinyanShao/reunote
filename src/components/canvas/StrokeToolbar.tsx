import { useState } from 'react'
import { Palette, ScanText, Trash2 } from 'lucide-react'
import { useApp, newElementId } from '../../lib/store'
import type { Viewport } from '../../lib/store'
import type { CanvasElement } from '../../lib/types'
import { strokeBounds } from '../../lib/ink'
import { recognizeText, strokesToDataUrl } from '../../lib/ocr'
import { IconButton, Popover, Spinner, Swatches, useToast } from '../ui'
import { PALETTE } from '../../lib/utils'

export function StrokeToolbar({ viewport }: { viewport: Viewport }) {
  const strokeSelection = useApp((s) => s.strokeSelection)
  const strokes = useApp((s) => s.doc.strokes)
  const store = useApp
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  const selected = strokes.filter((s) => strokeSelection.includes(s.id))
  if (selected.length === 0) return null

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  for (const st of selected) {
    const b = strokeBounds(st)
    minX = Math.min(minX, b.x)
    minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.w)
  }

  const left = ((minX + maxX) / 2) * viewport.zoom + viewport.x
  const top = minY * viewport.zoom + viewport.y - 46

  return (
    <div
      className="absolute z-40 flex -translate-x-1/2 items-center gap-0.5 rounded-xl border border-[var(--ink-border)] bg-[var(--ink-panel)] p-1 shadow-float animate-pop-in"
      style={{ left, top: Math.max(8, top) }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span className="px-1.5 text-[11.5px] text-[var(--ink-muted)]">
        {selected.length} 段墨迹
      </span>

      <Popover
        width={180}
        trigger={
          <IconButton title="改颜色">
            <Palette size={15} />
          </IconButton>
        }
      >
        <div className="p-2">
          <Swatches
            colors={PALETTE}
            onChange={(c) =>
              store.getState().updateDoc((d) => {
                for (const st of d.strokes) if (strokeSelection.includes(st.id)) st.color = c
              })
            }
          />
        </div>
      </Popover>

      <IconButton
        title="识别手写文字（需要支持读图的 AI 模型）"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          try {
            const dataUrl = strokesToDataUrl(selected)
            if (!dataUrl) throw new Error('这些笔迹无法生成图片')
            toast('正在识别手写…')
            const text = await recognizeText(dataUrl)
            const el: CanvasElement = {
              id: newElementId(),
              type: 'text',
              x: Math.round(maxX + 32),
              y: Math.round(minY),
              w: 360,
              h: Math.max(110, Math.min(480, 40 + text.length * 0.9)),
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
            setBusy(false)
          }
        }}
      >
        {busy ? <Spinner /> : <ScanText size={15} />}
      </IconButton>

      <IconButton
        title="删除 ⌫"
        onClick={() => store.getState().removeStrokes(strokeSelection)}
        className="hover:!bg-red-500/12 hover:!text-red-500"
      >
        <Trash2 size={15} />
      </IconButton>
    </div>
  )
}
