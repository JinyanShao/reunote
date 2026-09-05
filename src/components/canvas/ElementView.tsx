import { memo, useEffect, useMemo, useState } from 'react'
import katex from 'katex'
import { FileText, Music, Paperclip } from 'lucide-react'
import * as api from '../../lib/api'
import type { CanvasElement } from '../../lib/types'
import { cn, formatBytes, readableTextColor } from '../../lib/utils'
import { RichText } from '../editor/RichText'

interface Props {
  el: CanvasElement
  selected: boolean
  editing: boolean
  editingZoom?: number
  offset?: { dx: number; dy: number }
  preview?: { x: number; y: number; w: number; h: number }
  onPointerDown: (e: React.PointerEvent, el: CanvasElement) => void
  onDoubleClick: (el: CanvasElement) => void
  onChangeHtml: (id: string, html: string) => void
  onStopEditing: () => void
}

const FONT_CLASS: Record<string, string> = {
  sans: 'font-sans',
  serif: 'font-serif',
  mono: 'font-mono',
  hand: 'font-hand',
}

export const ElementView = memo(function ElementView({
  el,
  selected,
  editing,
  editingZoom,
  offset,
  preview,
  onPointerDown,
  onDoubleClick,
  onChangeHtml,
  onStopEditing,
}: Props) {
  const x = preview ? preview.x : el.x
  const y = preview ? preview.y : el.y
  const w = preview ? preview.w : el.w
  const h = preview ? preview.h : el.h
  const transforms = [
    offset ? `translate3d(${offset.dx}px, ${offset.dy}px, 0)` : '',
    el.rotation ? `rotate(${el.rotation}deg)` : '',
  ].filter(Boolean)

  const style: React.CSSProperties = {
    position: 'absolute',
    left: x,
    top: y,
    width: w,
    height: h,
    zIndex: el.z,
    transform: transforms.length > 0 ? transforms.join(' ') : undefined,
    willChange: offset ? 'transform' : undefined,
    opacity: el.opacity ?? 1,
  }

  return (
    <div
      style={style}
      data-element-id={el.id}
      onPointerDown={(e) => onPointerDown(e, el)}
      onDoubleClick={(e) => {
        e.stopPropagation()
        onDoubleClick(el)
      }}
      className={cn(
        'group',
        el.type === 'shape' && el.visualStyle === 'mind-connector' && 'pointer-events-none',
        el.locked ? 'cursor-not-allowed' : editing ? 'cursor-text' : 'cursor-move',
        selected && !editing && 'ring-2 ring-[var(--ink-accent)] ring-offset-1 rounded-[3px]'
      )}
    >
      <Body
        el={el}
        editing={editing}
        editingZoom={editingZoom}
        onChangeHtml={onChangeHtml}
        onStopEditing={onStopEditing}
      />
    </div>
  )
})

const Body = memo(function ElementBody({
  el,
  editing,
  editingZoom,
  onChangeHtml,
  onStopEditing,
}: {
  el: CanvasElement
  editing: boolean
  editingZoom?: number
  onChangeHtml: (id: string, html: string) => void
  onStopEditing: () => void
}) {
  switch (el.type) {
    case 'text':
      return (
        <div
          className={cn(
            'h-full w-full overflow-hidden rounded-[10px]',
            FONT_CLASS[el.fontFamily] ?? 'font-sans',
            editing && 'ring-2 ring-[var(--ink-accent)]'
          )}
          style={{
            background: el.bg === 'transparent' ? undefined : el.bg,
            color: readableTextColor(el.bg),
            border: el.border === 'transparent' ? '1px solid transparent' : `1px solid ${el.border}`,
            padding: el.padding,
            fontSize: `${el.fontScale}em`,
          }}
        >
          <RichText
            html={el.html}
            editable={editing}
            autofocus={editing}
            onChange={(html) => onChangeHtml(el.id, html)}
            onEscape={onStopEditing}
            placeholder="输入内容，按 / 唤起命令"
          />
        </div>
      )

    case 'sticky':
      return (
        <div
          className={cn(
            'h-full w-full overflow-hidden rounded-[4px] px-3.5 py-3 shadow-card',
            editing && 'ring-2 ring-[var(--ink-accent)]'
          )}
          style={{
            background: el.color,
            color: '#1f2430',
            boxShadow: '0 1px 2px rgba(0,0,0,.08), 0 8px 18px rgba(0,0,0,.06)',
          }}
        >
          <RichText
            html={el.html}
            editable={editing}
            autofocus={editing}
            onChange={(html) => onChangeHtml(el.id, html)}
            onEscape={onStopEditing}
            placeholder="便签…"
            compact
          />
        </div>
      )

    case 'image':
      return (
        <AssetImage
          src={el.src}
          assetId={el.attachmentId}
          alt={el.alt ?? ''}
          className="pointer-events-none h-full w-full select-none object-contain"
          style={{
            borderRadius: el.radius,
            boxShadow: el.shadow ? '0 4px 18px rgba(0,0,0,.16)' : undefined,
          }}
        />
      )

    case 'shape':
      return <ShapeBody el={el} />

    case 'math':
      return <MathBody el={el} editing={editing} editingZoom={editingZoom} />

    case 'code':
      return (
        <pre className="h-full w-full overflow-auto rounded-[10px] bg-[#1e2027] p-3 font-mono text-[12px] leading-relaxed text-[#e6e8ef]">
          <code>{el.code}</code>
        </pre>
      )

    case 'file':
      return (
        <div className="flex h-full w-full items-center gap-3 rounded-[10px] border border-[var(--ink-border)] bg-[var(--ink-panel)] px-3.5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--ink-accent-soft)] text-[var(--ink-accent)]">
            {el.mime.startsWith('audio') ? <Music size={17} /> : el.mime === 'application/pdf' ? <FileText size={17} /> : <Paperclip size={17} />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium">{el.filename}</div>
            <div className="text-[11px] text-[var(--ink-muted)]">{formatBytes(el.size)}</div>
          </div>
        </div>
      )

    case 'audio':
      return (
        <div className="flex h-full w-full flex-col justify-center gap-1.5 rounded-[10px] border border-[var(--ink-border)] bg-[var(--ink-panel)] px-3">
          <div className="truncate text-[12px] font-medium">{el.filename}</div>
          <audio src={el.src} controls className="w-full" style={{ height: 30 }} />
        </div>
      )

    case 'pdf':
      return (
        <div className="h-full w-full overflow-hidden rounded-[6px] border border-[var(--ink-border)] bg-white">
          <AssetImage
            src={el.src}
            assetId={el.attachmentId}
            alt={el.filename}
            className="h-full w-full object-contain"
          />
        </div>
      )

    default:
      return null
  }
})

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
}

/**
 * 图片渲染，带兜底：自定义协议若因任何原因加载失败，
 * 就直接从后端读取附件字节改用 data URL，保证画布上的图不会变成裂图。
 */
function AssetImage({
  src,
  assetId,
  alt,
  className,
  style,
}: {
  src: string
  assetId?: string
  alt: string
  className?: string
  style?: React.CSSProperties
}) {
  const [current, setCurrent] = useState(src)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setCurrent(src)
    setFailed(false)
  }, [src])

  const recover = async () => {
    const id = assetId ?? src.split('/').pop()
    if (!id || current.indexOf('data:') === 0) {
      setFailed(true)
      return
    }
    try {
      const b64 = await api.readAttachment(id)
      if (!b64) {
        setFailed(true)
        return
      }
      const ext = id.split('.').pop()?.toLowerCase() ?? 'png'
      setCurrent(`data:${MIME_BY_EXT[ext] ?? 'image/png'};base64,${b64}`)
    } catch {
      setFailed(true)
    }
  }

  if (failed) {
    return (
      <div className="flex h-full w-full items-center justify-center rounded-[8px] border border-dashed border-[var(--ink-border)] text-[12px] text-[var(--ink-muted)]">
        图片已丢失
      </div>
    )
  }

  return (
    <img
      src={current}
      alt={alt}
      draggable={false}
      onError={() => void recover()}
      className={className}
      style={style}
    />
  )
}

function ShapeBody({ el }: { el: Extract<CanvasElement, { type: 'shape' }> }) {
  const sw = el.strokeWidth
  const dash = el.dashed ? `${sw * 3} ${sw * 2.4}` : undefined
  const common = {
    stroke: el.stroke,
    strokeWidth: sw,
    fill: el.fill === 'transparent' ? 'none' : el.fill,
    strokeDasharray: dash,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  }
  const w = el.w
  const h = el.h
  const p = sw / 2 + 1
  const isMindNode =
    el.visualStyle === 'mind-root' ||
    el.visualStyle === 'mind-branch' ||
    el.visualStyle === 'mind-leaf'
  const radius =
    el.visualStyle === 'mind-root' ? 18 : el.visualStyle === 'mind-branch' ? 14 : 11
  const shadowId = `mind-shadow-${el.id}`

  return (
    <div className="relative h-full w-full">
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        className={cn(isMindNode && 'overflow-visible')}
      >
        {isMindNode && (
          <defs>
            <filter id={shadowId} x="-20%" y="-35%" width="140%" height="170%">
              <feDropShadow
                dx="0"
                dy={el.visualStyle === 'mind-root' ? 5 : 3}
                stdDeviation={el.visualStyle === 'mind-root' ? 6 : 4}
                floodColor="var(--mind-shadow)"
                floodOpacity={el.visualStyle === 'mind-leaf' ? 0.1 : 0.18}
              />
            </filter>
          </defs>
        )}
        {el.shape === 'rect' && (
          <rect
            x={p}
            y={p}
            width={Math.max(0, w - p * 2)}
            height={Math.max(0, h - p * 2)}
            rx={isMindNode ? radius : 8}
            filter={isMindNode ? `url(#${shadowId})` : undefined}
            {...common}
          />
        )}
        {el.shape === 'ellipse' && (
          <ellipse cx={w / 2} cy={h / 2} rx={Math.max(0, w / 2 - p)} ry={Math.max(0, h / 2 - p)} {...common} />
        )}
        {el.shape === 'diamond' && (
          <polygon points={`${w / 2},${p} ${w - p},${h / 2} ${w / 2},${h - p} ${p},${h / 2}`} {...common} />
        )}
        {el.shape === 'star' && <polygon points={starPoints(w, h, p)} {...common} />}
        {el.shape === 'line' && (
          <line
            x1={p}
            y1={el.flipped ? p : h - p}
            x2={w - p}
            y2={el.flipped ? h - p : p}
            {...common}
            fill="none"
          />
        )}
        {el.shape === 'curve' && (
          <path
            d={
              el.flipped
                ? `M ${p} ${p} C ${w * 0.42} ${p}, ${w * 0.58} ${h - p}, ${w - p} ${h - p}`
                : `M ${p} ${h - p} C ${w * 0.42} ${h - p}, ${w * 0.58} ${p}, ${w - p} ${p}`
            }
            {...common}
            fill="none"
          />
        )}
        {el.shape === 'arrow' && (
          <>
            <defs>
              <marker
                id={`ah-${el.id}`}
                markerWidth="10"
                markerHeight="8"
                refX="9"
                refY="4"
                orient="auto"
              >
                <path d="M0,0 L10,4 L0,8 z" fill={el.stroke} />
              </marker>
            </defs>
            <line
              x1={p}
              y1={el.flipped ? p : h - p}
              x2={w - p - sw * 2}
              y2={el.flipped ? h - p - sw * 1.6 : p + sw * 1.6}
              {...common}
              fill="none"
              markerEnd={`url(#ah-${el.id})`}
            />
          </>
        )}
      </svg>
      {el.label && (
        <div
          className={cn(
            'pointer-events-none absolute inset-0 flex items-center justify-center px-3 text-center leading-snug',
            el.visualStyle === 'mind-root'
              ? 'text-[15px] font-semibold'
              : el.visualStyle === 'mind-branch'
                ? 'text-[13px] font-semibold'
                : el.visualStyle === 'mind-leaf'
                  ? 'text-[12px] font-medium'
                  : 'text-[13px] font-medium'
          )}
          style={{
            color:
              el.visualStyle === 'mind-root'
                ? 'var(--mind-root-text)'
                : readableTextColor(el.fill) ?? 'var(--ink-text)',
          }}
        >
          {el.label}
        </div>
      )}
    </div>
  )
}

function starPoints(w: number, h: number, p: number) {
  const cx = w / 2
  const cy = h / 2
  const R = Math.min(w, h) / 2 - p
  const r = R * 0.42
  const pts: string[] = []
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? R : r
    const a = (Math.PI / 5) * i - Math.PI / 2
    pts.push(`${cx + Math.cos(a) * rad},${cy + Math.sin(a) * rad}`)
  }
  return pts.join(' ')
}

function MathBody({
  el,
  editing,
  editingZoom,
}: {
  el: Extract<CanvasElement, { type: 'math' }>
  editing: boolean
  editingZoom?: number
}) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(el.latex || '\\text{双击输入公式}', {
        displayMode: el.display,
        throwOnError: false,
        output: 'html',
      })
    } catch {
      return `<span style="color:#ef4444">公式语法有误</span>`
    }
  }, [el.latex, el.display])

  if (editing) {
    return (
      <div className="flex h-full w-full flex-col gap-1.5 rounded-[10px] border-2 border-[var(--ink-accent)] bg-[var(--ink-panel)] p-2">
        <div
          className="flex-1 overflow-auto text-center"
          style={{ color: el.color }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
        <textarea
          autoFocus
          defaultValue={el.latex}
          onChange={(e) => {
            const ev = new CustomEvent('jinyan-notes:math', {
              detail: { id: el.id, latex: e.target.value },
            })
            window.dispatchEvent(ev)
          }}
          onPointerDown={(e) => e.stopPropagation()}
          className="h-[52px] w-full resize-none rounded-md border border-[var(--ink-border)] bg-[var(--ink-panel-2)] px-2 py-1 font-mono text-[12px] outline-none"
          placeholder="LaTeX，例如 \\frac{a}{b}"
          style={{
            fontSize: 12 / Math.max(0.5, editingZoom ?? 1) > 18 ? 18 : undefined,
          }}
        />
      </div>
    )
  }

  return (
    <div
      className="flex h-full w-full items-center justify-center overflow-hidden px-2"
      style={{ color: el.color }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
