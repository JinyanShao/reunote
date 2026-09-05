import { useEffect, useMemo, useState } from 'react'
import type { Editor } from '@tiptap/react'
import {
  CheckSquare,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Minus,
  Quote,
  Table,
  Type,
} from 'lucide-react'
import { Portal } from '../ui'
import { cn } from '../../lib/utils'

export interface SlashCommand {
  key: string
  label: string
  keywords: string
  icon: React.ReactNode
  run: (editor: Editor) => void
}

const COMMANDS: SlashCommand[] = [
  {
    key: 'p',
    label: '正文',
    keywords: 'text p paragraph zhengwen 正文 文本',
    icon: <Type size={15} />,
    run: (e) => e.chain().focus().setParagraph().run(),
  },
  {
    key: 'h1',
    label: '一级标题',
    keywords: 'h1 heading title 标题 大标题',
    icon: <Heading1 size={15} />,
    run: (e) => e.chain().focus().toggleHeading({ level: 1 }).run(),
  },
  {
    key: 'h2',
    label: '二级标题',
    keywords: 'h2 heading 标题',
    icon: <Heading2 size={15} />,
    run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    key: 'h3',
    label: '三级标题',
    keywords: 'h3 heading 小标题',
    icon: <Heading3 size={15} />,
    run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run(),
  },
  {
    key: 'ul',
    label: '无序列表',
    keywords: 'ul bullet list 列表 项目符号',
    icon: <List size={15} />,
    run: (e) => e.chain().focus().toggleBulletList().run(),
  },
  {
    key: 'ol',
    label: '有序列表',
    keywords: 'ol number list 有序 编号',
    icon: <ListOrdered size={15} />,
    run: (e) => e.chain().focus().toggleOrderedList().run(),
  },
  {
    key: 'todo',
    label: '待办清单',
    keywords: 'todo task checkbox 待办 任务 清单',
    icon: <CheckSquare size={15} />,
    run: (e) => e.chain().focus().toggleTaskList().run(),
  },
  {
    key: 'quote',
    label: '引用',
    keywords: 'quote blockquote 引用',
    icon: <Quote size={15} />,
    run: (e) => e.chain().focus().toggleBlockquote().run(),
  },
  {
    key: 'code',
    label: '代码块',
    keywords: 'code pre 代码',
    icon: <Code2 size={15} />,
    run: (e) => e.chain().focus().toggleCodeBlock().run(),
  },
  {
    key: 'table',
    label: '表格',
    keywords: 'table 表格',
    icon: <Table size={15} />,
    run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    key: 'hr',
    label: '分割线',
    keywords: 'hr divider 分割线 横线',
    icon: <Minus size={15} />,
    run: (e) => e.chain().focus().setHorizontalRule().run(),
  },
]

export function SlashMenu({
  x,
  y,
  query,
  onPick,
  onClose,
}: {
  x: number
  y: number
  query: string
  onPick: (cmd: SlashCommand) => void
  onClose: () => void
}) {
  const items = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return COMMANDS
    return COMMANDS.filter(
      (c) => c.label.toLowerCase().includes(q) || c.keywords.toLowerCase().includes(q)
    )
  }, [query])

  const [active, setActive] = useState(0)
  useEffect(() => setActive(0), [query])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 中文输入法组字期间的回车是「确认候选词」，不能被当成执行命令。
      // keyCode 229 是部分浏览器在组字时的表现，一并挡掉。
      if (e.isComposing || e.keyCode === 229) return
      if (items.length === 0) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        setActive((v) => (v + 1) % items.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        setActive((v) => (v - 1 + items.length) % items.length)
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        e.stopPropagation()
        onPick(items[active])
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [items, active, onPick, onClose])

  if (items.length === 0) return null

  const top = Math.min(y + 6, window.innerHeight - 340)
  const left = Math.min(x, window.innerWidth - 240)

  return (
    <Portal>
      <div
        style={{ top, left, width: 224 }}
        className="fixed z-[9999] max-h-[320px] overflow-y-auto rounded-xl border border-[var(--ink-border)] bg-[var(--ink-panel)] p-1 shadow-float animate-pop-in"
      >
        {items.map((c, i) => (
          <button
            key={c.key}
            onMouseEnter={() => setActive(i)}
            onMouseDown={(e) => {
              e.preventDefault()
              onPick(c)
            }}
            className={cn(
              'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left text-[13px]',
              i === active
                ? 'bg-[var(--ink-accent)] text-white'
                : 'text-[var(--ink-text)] hover:bg-[var(--ink-panel-2)]'
            )}
          >
            <span className={cn(i === active ? 'text-white' : 'text-[var(--ink-muted)]')}>
              {c.icon}
            </span>
            {c.label}
          </button>
        ))}
      </div>
    </Portal>
  )
}
