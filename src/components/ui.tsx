import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn } from '../lib/utils'

// ───────────── 按钮 ─────────────

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'soft' | 'danger' | 'outline'
  size?: 'sm' | 'md'
}

export function Button({
  variant = 'soft',
  size = 'md',
  className,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      className={cn(
        'btn no-drag',
        size === 'sm' ? 'h-7 px-2.5 text-[12px]' : 'h-8 px-3',
        variant === 'primary' && 'bg-[var(--ink-accent)] text-white hover:brightness-110',
        variant === 'soft' &&
          'bg-[color-mix(in_srgb,var(--ink-muted)_14%,transparent)] text-[var(--ink-text)] hover:bg-[color-mix(in_srgb,var(--ink-muted)_22%,transparent)]',
        variant === 'ghost' &&
          'text-[var(--ink-muted)] hover:bg-[color-mix(in_srgb,var(--ink-muted)_14%,transparent)] hover:text-[var(--ink-text)]',
        variant === 'outline' &&
          'border border-[var(--ink-border)] text-[var(--ink-text)] hover:bg-[var(--ink-panel-2)]',
        variant === 'danger' && 'bg-red-500 text-white hover:bg-red-600',
        rest.disabled && 'pointer-events-none opacity-45',
        className
      )}
    />
  )
}

export function IconButton({
  active,
  className,
  title,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      {...rest}
      title={title}
      data-active={active ? 'true' : 'false'}
      className={cn('tool-btn no-drag', rest.disabled && 'pointer-events-none opacity-35', className)}
    />
  )
}

// ───────────── 浮层定位 ─────────────

/**
 * 纯客户端应用，直接挂到 body。
 * 注意：这里不能再加 "先渲染 null、useEffect 之后才挂载" 的门，
 * 否则 Popover 在 useLayoutEffect 里定位时浮层还不在 DOM 中，会永远停在左上角。
 */
export function Portal({ children }: { children: React.ReactNode }) {
  if (typeof document === 'undefined') return null
  return createPortal(children, document.body)
}

interface PopoverProps {
  trigger: React.ReactNode
  children: React.ReactNode | ((close: () => void) => React.ReactNode)
  align?: 'start' | 'center' | 'end'
  side?: 'top' | 'bottom'
  className?: string
  width?: number
  /** 返回 false 时这次点击不展开浮层（用于"第一次点只切换工具"这类交互） */
  shouldOpen?: () => boolean
}

export function Popover({
  trigger,
  children,
  align = 'start',
  side = 'bottom',
  className,
  width,
  shouldOpen,
}: PopoverProps) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ top: 0, left: 0 })

  const place = useCallback(() => {
    const a = anchorRef.current
    const p = popRef.current
    if (!a || !p) return
    // 锚点包装层是 display:contents（不生成盒子），必须量它的第一个真实子元素
    const target = (a.firstElementChild as HTMLElement | null) ?? a
    const r = target.getBoundingClientRect()
    const pw = width ?? p.offsetWidth
    const ph = p.offsetHeight
    let left = r.left
    if (align === 'center') left = r.left + r.width / 2 - pw / 2
    if (align === 'end') left = r.right - pw
    let top = side === 'bottom' ? r.bottom + 6 : r.top - ph - 6
    left = Math.max(8, Math.min(left, window.innerWidth - pw - 8))
    top = Math.max(8, Math.min(top, window.innerHeight - ph - 8))
    setPos({ top, left })
  }, [align, side, width])

  useLayoutEffect(() => {
    if (!open) return
    place()
    // 浮层内容（色板、模型列表等）渲染完可能改变高度，下一帧再校准一次
    const id = requestAnimationFrame(place)
    return () => cancelAnimationFrame(id)
  }, [open, place])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (
        !popRef.current?.contains(e.target as Node) &&
        !anchorRef.current?.contains(e.target as Node)
      )
        setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', place)
    }
  }, [open, place])

  return (
    <>
      <div
        ref={anchorRef}
        onClick={() => {
          if (open) {
            setOpen(false)
            return
          }
          if (shouldOpen && !shouldOpen()) return
          setOpen(true)
        }}
        className="contents"
      >
        {trigger}
      </div>
      {open && (
        <Portal>
          <div
            ref={popRef}
            style={{ top: pos.top, left: pos.left, width }}
            className={cn(
              'fixed z-[9999] rounded-xl border border-[var(--ink-border)] bg-[var(--ink-panel)] p-1.5 shadow-float animate-pop-in',
              className
            )}
          >
            {typeof children === 'function' ? children(() => setOpen(false)) : children}
          </div>
        </Portal>
      )}
    </>
  )
}

// ───────────── 对话框 ─────────────

export function Dialog({
  open,
  onClose,
  title,
  children,
  width = 560,
  footer,
}: {
  open: boolean
  onClose: () => void
  title: React.ReactNode
  children: React.ReactNode
  width?: number
  footer?: React.ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  if (!open) return null
  return (
    <Portal>
      <div className="fixed inset-0 z-[9998] flex items-start justify-center bg-black/25 p-8 pt-[9vh] animate-fade-in backdrop-blur-[2px]">
        <div className="absolute inset-0" onClick={onClose} />
        <div
          role="dialog"
          aria-modal="true"
          style={{ width, maxHeight: '82vh' }}
          className="relative flex flex-col overflow-hidden rounded-2xl border border-[var(--ink-border)] bg-[var(--ink-panel)] shadow-float animate-pop-in"
        >
          <div className="flex items-center justify-between border-b border-[var(--ink-border)] px-5 py-3.5">
            <div className="text-[15px] font-semibold">{title}</div>
            <IconButton onClick={onClose} title="关闭">
              <X size={16} />
            </IconButton>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && (
            <div className="flex items-center justify-end gap-2 border-t border-[var(--ink-border)] px-5 py-3">
              {footer}
            </div>
          )}
        </div>
      </div>
    </Portal>
  )
}

// ───────────── 文本输入对话框 ─────────────

export interface TextPromptOptions {
  title: string
  value?: string
  label?: string
  placeholder?: string
  confirmLabel?: string
  allowEmpty?: boolean
}

interface TextPromptRequest {
  options: TextPromptOptions
  resolve: (value: string | null) => void
}

type TextPromptFn = (options: TextPromptOptions) => Promise<string | null>

const TextPromptCtx = createContext<TextPromptFn>(async () => null)

export const useTextPrompt = () => useContext(TextPromptCtx)

/**
 * 用应用内弹窗代替 window.prompt。后者在 macOS Tauri WebView 中不会显示，
 * 会直接返回 null，导致重命名等操作静默失败。
 */
export function TextPromptHost({ children }: { children: React.ReactNode }) {
  const activeRef = useRef<TextPromptRequest | null>(null)
  const [request, setRequest] = useState<TextPromptRequest | null>(null)
  const [value, setValue] = useState('')

  const finish = useCallback((result: string | null) => {
    const active = activeRef.current
    if (!active) return
    activeRef.current = null
    setRequest(null)
    active.resolve(result)
  }, [])

  const prompt = useCallback<TextPromptFn>((options) => {
    return new Promise((resolve) => {
      activeRef.current?.resolve(null)
      const next = { options, resolve }
      activeRef.current = next
      setValue(options.value ?? '')
      setRequest(next)
    })
  }, [])

  useEffect(
    () => () => {
      activeRef.current?.resolve(null)
      activeRef.current = null
    },
    []
  )

  const options = request?.options
  const canSubmit = !!options && (options.allowEmpty || value.trim().length > 0)

  return (
    <TextPromptCtx.Provider value={prompt}>
      {children}
      <Dialog
        open={!!request}
        onClose={() => finish(null)}
        title={options?.title ?? ''}
        width={420}
        footer={
          <>
            <Button type="button" variant="ghost" onClick={() => finish(null)}>
              取消
            </Button>
            <Button
              type="submit"
              form="jinyan-notes-text-prompt"
              variant="primary"
              disabled={!canSubmit}
            >
              {options?.confirmLabel ?? '保存'}
            </Button>
          </>
        }
      >
        <form
          id="jinyan-notes-text-prompt"
          onSubmit={(event) => {
            event.preventDefault()
            if (canSubmit) finish(value)
          }}
        >
          <Field label={options?.label ?? '名称'}>
            <Input
              autoFocus
              aria-label={options?.label ?? '名称'}
              value={value}
              placeholder={options?.placeholder}
              onChange={(event) => setValue(event.target.value)}
              onFocus={(event) => event.currentTarget.select()}
            />
          </Field>
        </form>
      </Dialog>
    </TextPromptCtx.Provider>
  )
}

// ───────────── 表单控件 ─────────────

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <label className="mb-3.5 block">
      <div className="mb-1 text-[12px] font-medium text-[var(--ink-muted)]">{label}</div>
      {children}
      {hint && <div className="mt-1 text-[11px] leading-relaxed text-[var(--ink-muted)]">{hint}</div>}
    </label>
  )
}

export const inputClass =
  'w-full rounded-lg border border-[var(--ink-border)] bg-[var(--ink-panel-2)] px-2.5 py-1.5 text-[13px] text-[var(--ink-text)] outline-none transition focus:border-[var(--ink-accent)] focus:bg-[var(--ink-panel)] placeholder:text-[var(--ink-muted)]'

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(inputClass, props.className)} />
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cn(inputClass, 'cursor-pointer', props.className)} />
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cn(inputClass, 'resize-y', props.className)} />
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between rounded-lg px-1 py-1.5 text-[13px] hover:bg-[var(--ink-panel-2)]"
    >
      <span>{label}</span>
      <span
        className={cn(
          'relative h-[20px] w-[34px] rounded-full transition',
          checked ? 'bg-[var(--ink-accent)]' : 'bg-[color-mix(in_srgb,var(--ink-muted)_35%,transparent)]'
        )}
      >
        <span
          className={cn(
            'absolute top-[2px] h-4 w-4 rounded-full bg-white shadow transition-all',
            checked ? 'left-[16px]' : 'left-[2px]'
          )}
        />
      </span>
    </button>
  )
}

export function Swatches({
  colors,
  value,
  onChange,
  size = 20,
}: {
  colors: string[]
  value?: string
  onChange: (c: string) => void
  size?: number
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {colors.map((c) => (
        <button
          key={c}
          onClick={() => onChange(c)}
          style={{ background: c, width: size, height: size }}
          className={cn(
            'rounded-full border transition hover:scale-110',
            value === c
              ? 'border-[var(--ink-accent)] ring-2 ring-[var(--ink-accent)] ring-offset-1 ring-offset-[var(--ink-panel)]'
              : 'border-black/10'
          )}
          title={c}
        />
      ))}
    </div>
  )
}

export function MenuItem({
  icon,
  children,
  onClick,
  danger,
  shortcut,
  disabled,
}: {
  icon?: React.ReactNode
  children: React.ReactNode
  onClick?: () => void
  danger?: boolean
  shortcut?: string
  disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left text-[13px] transition',
        disabled
          ? 'cursor-default opacity-40'
          : danger
            ? 'text-red-500 hover:bg-red-500/10'
            : 'hover:bg-[color-mix(in_srgb,var(--ink-muted)_14%,transparent)]'
      )}
    >
      {icon && <span className="flex w-4 justify-center text-[var(--ink-muted)]">{icon}</span>}
      <span className="flex-1 truncate">{children}</span>
      {shortcut && <span className="text-[11px] text-[var(--ink-muted)]">{shortcut}</span>}
    </button>
  )
}

export function Divider() {
  return <div className="my-1 h-px bg-[var(--ink-border)]" />
}

// ───────────── 轻量提示 ─────────────

interface ToastItem {
  id: number
  text: string
  kind: 'info' | 'error' | 'success'
}
const ToastCtx = createContext<(text: string, kind?: ToastItem['kind']) => void>(() => {})
export const useToast = () => useContext(ToastCtx)

export function ToastHost({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const push = useCallback((text: string, kind: ToastItem['kind'] = 'info') => {
    const id = Date.now() + Math.random()
    setItems((v) => v.concat([{ id, text, kind }]))
    setTimeout(() => setItems((v) => v.filter((t) => t.id !== id)), 3600)
  }, [])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-5 left-1/2 z-[10000] flex -translate-x-1/2 flex-col items-center gap-2">
        {items.map((t) => (
          <div
            key={t.id}
            className={cn(
              'pointer-events-auto max-w-[520px] rounded-xl px-3.5 py-2 text-[13px] shadow-float animate-pop-in',
              t.kind === 'error'
                ? 'bg-red-500 text-white'
                : t.kind === 'success'
                  ? 'bg-emerald-600 text-white'
                  : 'bg-[var(--ink-text)] text-[var(--ink-bg)]'
            )}
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <span
      style={{ width: size, height: size }}
      className="inline-block animate-spin rounded-full border-2 border-current border-t-transparent opacity-70"
    />
  )
}
