import {
  Circle,
  Code2,
  Diamond,
  Eraser,
  Hand,
  Highlighter,
  Image as ImageIcon,
  Lasso,
  MousePointer2,
  MoveUpRight,
  Paperclip,
  Pen,
  Shapes,
  Sigma,
  Square,
  StickyNote,
  Type,
} from 'lucide-react'
import { useApp } from '../../lib/store'
import type { Tool } from '../../lib/types'
import { IconButton, Popover, Swatches } from '../ui'
import { PALETTE, HIGHLIGHT_PALETTE, cn } from '../../lib/utils'
import { emit } from '../../lib/bus'

const SHAPE_TOOLS: { key: Tool; icon: React.ReactNode; label: string }[] = [
  { key: 'rect', icon: <Square size={15} />, label: '矩形 R' },
  { key: 'ellipse', icon: <Circle size={15} />, label: '椭圆 O' },
  { key: 'diamond', icon: <Diamond size={15} />, label: '菱形' },
  { key: 'arrow', icon: <MoveUpRight size={15} />, label: '箭头 A' },
  { key: 'line', icon: <span className="block h-[15px] w-[15px] rotate-45 border-t-2" />, label: '直线' },
]

export function Toolbar({ onInsertImage, onInsertFile }: { onInsertImage: () => void; onInsertFile: () => void }) {
  const tool = useApp((s) => s.tool)
  const setTool = useApp((s) => s.setTool)
  const settings = useApp((s) => s.settings)
  const patchSettings = useApp((s) => s.patchSettings)

  const shapeActive = SHAPE_TOOLS.some((s) => s.key === tool)
  const activeShape = SHAPE_TOOLS.find((s) => s.key === tool) ?? SHAPE_TOOLS[0]

  return (
    <div className="pointer-events-auto absolute left-3 top-1/2 z-30 flex -translate-y-1/2 flex-col gap-0.5 rounded-2xl border border-[var(--ink-border)] bg-[var(--ink-panel)]/95 p-1 shadow-panel backdrop-blur">
      <IconButton title="选择 V" active={tool === 'select'} onClick={() => setTool('select')}>
        <MousePointer2 size={16} />
      </IconButton>
      <IconButton title="抓手 H（或按住空格）" active={tool === 'hand'} onClick={() => setTool('hand')}>
        <Hand size={16} />
      </IconButton>

      <Divider />

      <IconButton title="文本 T" active={tool === 'text'} onClick={() => setTool('text')}>
        <Type size={16} />
      </IconButton>
      <IconButton title="便签 N" active={tool === 'sticky'} onClick={() => setTool('sticky')}>
        <StickyNote size={16} />
      </IconButton>

      <Divider />

      <Popover
        side="bottom"
        align="start"
        width={210}
        shouldOpen={() => tool === 'pen'}
        trigger={
          <IconButton
            title="画笔 P（已选中时再点一次可调颜色和粗细）"
            active={tool === 'pen'}
            onClick={() => setTool('pen')}
          >
            <Pen size={16} />
          </IconButton>
        }
      >
        <div className="p-2">
          <div className="mb-1.5 text-[11px] text-[var(--ink-muted)]">画笔颜色</div>
          <Swatches
            colors={PALETTE}
            value={settings.penColor}
            onChange={(c) => {
              patchSettings({ penColor: c })
              setTool('pen')
            }}
          />
          <div className="mb-1.5 mt-3 text-[11px] text-[var(--ink-muted)]">笔尖粗细</div>
          <div className="flex items-center gap-1">
            {[1.5, 3, 5, 8, 14].map((s) => (
              <button
                key={s}
                onClick={() => {
                  patchSettings({ penSize: s })
                  setTool('pen')
                }}
                className={cn(
                  'flex h-8 flex-1 items-center justify-center rounded-lg transition',
                  settings.penSize === s
                    ? 'bg-[var(--ink-accent)] text-white'
                    : 'hover:bg-[var(--ink-panel-2)]'
                )}
              >
                <span
                  className="rounded-full bg-current"
                  style={{ width: Math.max(4, s * 1.6), height: Math.max(4, s * 1.6) }}
                />
              </button>
            ))}
          </div>
        </div>
      </Popover>

      <Popover
        side="bottom"
        align="start"
        width={210}
        shouldOpen={() => tool === 'highlighter'}
        trigger={
          <IconButton
            title="荧光笔 M（已选中时再点一次可调颜色和宽度）"
            active={tool === 'highlighter'}
            onClick={() => setTool('highlighter')}
          >
            <Highlighter size={16} />
          </IconButton>
        }
      >
        <div className="p-2">
          <div className="mb-1.5 text-[11px] text-[var(--ink-muted)]">荧光笔颜色</div>
          <Swatches
            colors={HIGHLIGHT_PALETTE.concat(['#86efac', '#93c5fd'])}
            value={settings.highlighterColor}
            onChange={(c) => {
              patchSettings({ highlighterColor: c })
              setTool('highlighter')
            }}
          />
          <div className="mb-1.5 mt-3 text-[11px] text-[var(--ink-muted)]">宽度</div>
          <div className="flex items-center gap-1">
            {[12, 18, 24, 34].map((s) => (
              <button
                key={s}
                onClick={() => {
                  patchSettings({ highlighterSize: s })
                  setTool('highlighter')
                }}
                className={cn(
                  'h-8 flex-1 rounded-lg text-[12px] transition',
                  settings.highlighterSize === s
                    ? 'bg-[var(--ink-accent)] text-white'
                    : 'hover:bg-[var(--ink-panel-2)]'
                )}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      </Popover>

      <IconButton title="橡皮 E" active={tool === 'eraser'} onClick={() => setTool('eraser')}>
        <Eraser size={16} />
      </IconButton>
      <IconButton title="套索选择 L" active={tool === 'lasso'} onClick={() => setTool('lasso')}>
        <Lasso size={16} />
      </IconButton>

      <Divider />

      <Popover
        side="bottom"
        align="start"
        width={168}
        shouldOpen={() => shapeActive}
        trigger={
          <IconButton
            title="图形（已选中时再点一次可换形状）"
            active={shapeActive}
            onClick={() => setTool(activeShape.key)}
          >
            {shapeActive ? activeShape.icon : <Shapes size={16} />}
          </IconButton>
        }
      >
        {(close) => (
          <div className="p-1">
            {SHAPE_TOOLS.map((s) => (
              <button
                key={s.key}
                onClick={() => {
                  setTool(s.key)
                  close()
                }}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px]',
                  tool === s.key
                    ? 'bg-[var(--ink-accent)] text-white'
                    : 'hover:bg-[var(--ink-panel-2)]'
                )}
              >
                {s.icon}
                {s.label}
              </button>
            ))}
          </div>
        )}
      </Popover>

      <IconButton title="插入图片" onClick={onInsertImage}>
        <ImageIcon size={16} />
      </IconButton>
      <IconButton title="插入文件 / PDF" onClick={onInsertFile}>
        <Paperclip size={16} />
      </IconButton>
      <IconButton title="插入公式" onClick={() => emit({ type: 'insert-math' })}>
        <Sigma size={16} />
      </IconButton>
      <IconButton title="插入代码块" onClick={() => emit({ type: 'insert-code' })}>
        <Code2 size={16} />
      </IconButton>
    </div>
  )
}

function Divider() {
  return <div className="my-1 h-px bg-[var(--ink-border)]" />
}
