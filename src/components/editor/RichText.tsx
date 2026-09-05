import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, useEditor, BubbleMenu, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import Highlight from '@tiptap/extension-highlight'
import TextStyle from '@tiptap/extension-text-style'
import { Color } from '@tiptap/extension-color'
import TextAlign from '@tiptap/extension-text-align'
import Typography from '@tiptap/extension-typography'
import Placeholder from '@tiptap/extension-placeholder'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import Image from '@tiptap/extension-image'
import Subscript from '@tiptap/extension-subscript'
import Superscript from '@tiptap/extension-superscript'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import Mathematics from '@tiptap/extension-mathematics'
import { common, createLowlight } from 'lowlight'
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Code,
  Italic,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  Palette,
  Quote,
  Sparkles,
  Strikethrough,
  Table as TableIcon,
  Underline as UnderlineIcon,
} from 'lucide-react'
import { marked } from 'marked'
import { cn, HIGHLIGHT_PALETTE, PALETTE } from '../../lib/utils'
import { renderRichTextMathHtml } from '../../lib/richTextMath'
import { clearActiveEditor, rememberSelection, setActiveEditor } from '../../lib/activeEditor'
import {
  QUICK_ACTIONS,
  TARGET_LANGUAGES,
  complete,
  translateAction,
  type QuickAction,
} from '../../lib/aiActions'
import { IconButton, Popover, Spinner, Swatches, useTextPrompt, useToast } from '../ui'
import { SlashMenu, type SlashCommand } from './SlashMenu'

const lowlight = createLowlight(common)

export function buildExtensions(placeholder: string) {
  return [
    StarterKit.configure({
      codeBlock: false,
      heading: { levels: [1, 2, 3] },
    }),
    Underline,
    Subscript,
    Superscript,
    TextStyle,
    Color,
    Highlight.configure({ multicolor: true }),
    Typography,
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    Link.configure({ openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noreferrer' } }),
    Placeholder.configure({ placeholder }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: true }),
    TableRow,
    TableHeader,
    TableCell,
    Image.configure({ inline: false, allowBase64: true }),
    CodeBlockLowlight.configure({ lowlight }),
    Mathematics.configure({
      // Keep the TeX source editable. Outside the active formula, TipTap replaces it
      // with a KaTeX decoration at the same character position.
      regex: /\$([^$\n]*)\$|\\\(([^\n]*?)\\\)/g,
      katexOptions: { throwOnError: false, strict: 'ignore', output: 'html' },
      shouldRender: (state, pos, node) => {
        const parent = state.doc.resolve(pos).parent
        return (
          parent.type.name !== 'codeBlock' &&
          !node.marks.some((mark) => mark.type.name === 'code')
        )
      },
    }),
  ]
}

interface RichTextProps {
  html: string
  editable: boolean
  onChange?: (html: string) => void
  onBlurEditor?: () => void
  onEscape?: () => void
  placeholder?: string
  className?: string
  autofocus?: boolean
  compact?: boolean
  onEditorReady?: (editor: Editor | null) => void
}

const RichTextReadonly = memo(function RichTextReadonly({
  html,
  compact,
  className,
}: Pick<RichTextProps, 'html' | 'compact' | 'className'>) {
  const renderedHtml = useMemo(() => renderRichTextMathHtml(html || ''), [html])

  return (
    <div
      className={cn('rt', compact && 'text-[13px]', className)}
      dangerouslySetInnerHTML={{ __html: renderedHtml }}
    />
  )
})

/**
 * 只读态直接渲染静态 HTML，**不创建** TipTap 实例。
 * 实测每个空闲编辑器约占 150 KB 堆内存，画布上几十上百个文本块时
 * 会白白吃掉几十 MB 并拖慢首绘。编辑态才挂载真正的编辑器。
 */
export function RichText(props: RichTextProps) {
  if (!props.editable) {
    return (
      <RichTextReadonly
        html={props.html}
        compact={props.compact}
        className={props.className}
      />
    )
  }
  return <RichTextEditable {...props} />
}

function RichTextEditable({
  html,
  editable,
  onChange,
  onBlurEditor,
  onEscape,
  placeholder = "输入内容，按 '/' 唤起命令",
  className,
  autofocus,
  compact,
  onEditorReady,
}: RichTextProps) {
  const [slash, setSlash] = useState<{ x: number; y: number; query: string } | null>(null)
  const lastEmitted = useRef(html)

  const extensions = useMemo(() => buildExtensions(placeholder), [placeholder])

  const editor = useEditor(
    {
      extensions,
      content: html || '',
      editable,
      autofocus: autofocus ? 'end' : false,
      editorProps: {
        attributes: {
          class: cn('rt outline-none', compact && 'text-[13px]'),
          spellcheck: 'true',
        },
        handleKeyDown: (_view, event) => {
          if (event.key === 'Escape') {
            onEscape?.()
            return true
          }
          return false
        },
      },
      onUpdate: ({ editor: ed }) => {
        const next = ed.getHTML()
        lastEmitted.current = next
        onChange?.(next)
        updateSlash(ed)
      },
      onSelectionUpdate: ({ editor: ed }) => {
        updateSlash(ed)
        rememberSelection()
      },
      onFocus: ({ editor: ed }) => setActiveEditor(ed),
      onBlur: ({ editor: ed }) => {
        rememberSelection()
        clearActiveEditor(ed)
        setSlash(null)
        onBlurEditor?.()
      },
    },
    [editable]
  )

  function updateSlash(ed: Editor) {
    const { state } = ed
    const { from, empty } = state.selection
    if (!empty) {
      setSlash(null)
      return
    }
    const textBefore = state.doc.textBetween(Math.max(0, from - 40), from, '\n', '\n')
    const m = /(?:^|\s)\/([^\s/]{0,20})$/.exec(textBefore)
    if (!m) {
      setSlash(null)
      return
    }
    try {
      const coords = ed.view.coordsAtPos(from)
      setSlash({ x: coords.left, y: coords.bottom, query: m[1] })
    } catch {
      setSlash(null)
    }
  }

  useEffect(() => {
    onEditorReady?.(editor ?? null)
    return () => {
      if (editor) clearActiveEditor(editor)
      onEditorReady?.(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

  useEffect(() => {
    if (!editor) return
    if (html !== lastEmitted.current && html !== editor.getHTML()) {
      editor.commands.setContent(html || '', false)
      lastEmitted.current = html
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html])

  useEffect(() => {
    if (!editor) return
    editor.setEditable(editable)
    if (editable && autofocus) {
      // 双击进入编辑后立刻把光标放进去，不用再点一次
      requestAnimationFrame(() => {
        if (!editor.isDestroyed) editor.commands.focus('end')
      })
    }
  }, [editable, autofocus, editor])

  // 只读分支已经在外层 RichText 里短路，这里 editable 必为 true

  const runSlash = (cmd: SlashCommand) => {
    if (!editor) return
    const { from } = editor.state.selection
    const textBefore = editor.state.doc.textBetween(Math.max(0, from - 40), from, '\n', '\n')
    const m = /\/([^\s/]{0,20})$/.exec(textBefore)
    const deleteFrom = m ? from - m[0].length : from
    editor.chain().focus().deleteRange({ from: deleteFrom, to: from }).run()
    cmd.run(editor)
    setSlash(null)
  }

  return (
    <div className={cn('selectable', className)}>
      {editor && (
        <BubbleMenu
          editor={editor}
          tippyOptions={{ duration: 100, placement: 'top', maxWidth: 'none' }}
          shouldShow={({ state, from, to }) => {
            if (from === to) return false
            const text = state.doc.textBetween(from, to).trim()
            return text.length > 0
          }}
        >
          <FormatBar editor={editor} />
        </BubbleMenu>
      )}
      <EditorContent editor={editor} />
      {slash && editor && (
        <SlashMenu
          x={slash.x}
          y={slash.y}
          query={slash.query}
          onPick={runSlash}
          onClose={() => setSlash(null)}
        />
      )}
    </div>
  )
}

function FormatBar({ editor }: { editor: Editor }) {
  const promptText = useTextPrompt()

  return (
    <div className="flex items-center gap-0.5 rounded-xl border border-[var(--ink-border)] bg-[var(--ink-panel)] p-1 shadow-float">
      <IconButton
        title="加粗 ⌘B"
        active={editor.isActive('bold')}
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        <Bold size={15} />
      </IconButton>
      <IconButton
        title="斜体 ⌘I"
        active={editor.isActive('italic')}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        <Italic size={15} />
      </IconButton>
      <IconButton
        title="下划线 ⌘U"
        active={editor.isActive('underline')}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
      >
        <UnderlineIcon size={15} />
      </IconButton>
      <IconButton
        title="删除线"
        active={editor.isActive('strike')}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      >
        <Strikethrough size={15} />
      </IconButton>
      <IconButton
        title="行内代码"
        active={editor.isActive('code')}
        onClick={() => editor.chain().focus().toggleCode().run()}
      >
        <Code size={15} />
      </IconButton>

      <div className="mx-1 h-4 w-px bg-[var(--ink-border)]" />

      <Popover
        width={196}
        trigger={
          <IconButton title="颜色与高亮">
            <Palette size={15} />
          </IconButton>
        }
      >
        <div className="p-2">
          <div className="mb-1.5 text-[11px] font-medium text-[var(--ink-muted)]">文字颜色</div>
          <Swatches
            colors={PALETTE}
            onChange={(c) => editor.chain().focus().setColor(c).run()}
          />
          <div className="mb-1.5 mt-3 text-[11px] font-medium text-[var(--ink-muted)]">高亮</div>
          <Swatches
            colors={HIGHLIGHT_PALETTE}
            onChange={(c) => editor.chain().focus().toggleHighlight({ color: c }).run()}
          />
          <button
            onClick={() =>
              editor.chain().focus().unsetColor().unsetHighlight().run()
            }
            className="mt-3 w-full rounded-lg py-1 text-[12px] text-[var(--ink-muted)] hover:bg-[var(--ink-panel-2)]"
          >
            清除样式
          </button>
        </div>
      </Popover>

      <IconButton
        title="无序列表"
        active={editor.isActive('bulletList')}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      >
        <List size={15} />
      </IconButton>
      <IconButton
        title="有序列表"
        active={editor.isActive('orderedList')}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      >
        <ListOrdered size={15} />
      </IconButton>
      <IconButton
        title="待办清单"
        active={editor.isActive('taskList')}
        onClick={() => editor.chain().focus().toggleTaskList().run()}
      >
        <ListTodo size={15} />
      </IconButton>
      <IconButton
        title="引用"
        active={editor.isActive('blockquote')}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      >
        <Quote size={15} />
      </IconButton>

      <div className="mx-1 h-4 w-px bg-[var(--ink-border)]" />

      <IconButton
        title="左对齐"
        active={editor.isActive({ textAlign: 'left' })}
        onClick={() => editor.chain().focus().setTextAlign('left').run()}
      >
        <AlignLeft size={15} />
      </IconButton>
      <IconButton
        title="居中"
        active={editor.isActive({ textAlign: 'center' })}
        onClick={() => editor.chain().focus().setTextAlign('center').run()}
      >
        <AlignCenter size={15} />
      </IconButton>
      <IconButton
        title="右对齐"
        active={editor.isActive({ textAlign: 'right' })}
        onClick={() => editor.chain().focus().setTextAlign('right').run()}
      >
        <AlignRight size={15} />
      </IconButton>

      <div className="mx-1 h-4 w-px bg-[var(--ink-border)]" />

      <IconButton
        title="插入链接"
        active={editor.isActive('link')}
        onClick={async () => {
          const prev = editor.getAttributes('link').href as string | undefined
          const url = await promptText({
            title: '插入链接',
            label: '链接地址',
            value: prev ?? 'https://',
            allowEmpty: true,
            confirmLabel: '应用',
          })
          if (url === null) return
          if (url === '') editor.chain().focus().unsetLink().run()
          else editor.chain().focus().setLink({ href: url }).run()
        }}
      >
        <Link2 size={15} />
      </IconButton>
      <IconButton
        title="插入表格"
        onClick={() =>
          editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
        }
      >
        <TableIcon size={15} />
      </IconButton>

      <div className="mx-1 h-4 w-px bg-[var(--ink-border)]" />

      <InlineAiMenu editor={editor} />
    </div>
  )
}

/** 选中文字后的内联 AI 菜单：结果直接替换选区 */
function InlineAiMenu({ editor }: { editor: Editor }) {
  const [busy, setBusy] = useState(false)
  const toast = useToast()

  const apply = async (action: QuickAction) => {
    if (busy) return
    const { from, to } = editor.state.selection
    const text = editor.state.doc.textBetween(from, to, '\n', '\n').trim()
    if (!text) {
      toast('请先选中一段文字', 'error')
      return
    }
    setBusy(true)
    try {
      const out = await complete(action.system, action.user(text))
      if (!out) throw new Error('模型没有返回内容')

      // 等待期间用户可能继续编辑，from/to 已经不可信。
      // 校验编辑器仍在、区间仍在范围内、且该段文字没变过，任一不满足就放弃，
      // 绝不拿旧坐标去删一段无关内容。
      if (editor.isDestroyed) throw new Error('编辑器已关闭，结果未写回')
      const size = editor.state.doc.content.size
      if (from > size || to > size || from >= to) {
        throw new Error('原文位置已变化，结果未写回，可复制后手动粘贴')
      }
      const nowText = editor.state.doc.textBetween(from, to, '\n', '\n').trim()
      if (nowText !== text) {
        throw new Error('原文已被修改，结果未写回，可复制后手动粘贴')
      }

      const html = marked.parse(out, { async: false }) as string
      if (action.replaces) {
        editor
          .chain()
          .focus()
          .setTextSelection({ from, to })
          .deleteSelection()
          .insertContent(html)
          .run()
      } else {
        // 解释/续写这类动作不该动原文，把渲染后的结果插到选区之后
        editor
          .chain()
          .focus()
          .setTextSelection({ from: to, to })
          .insertContent(html)
          .run()
      }
      toast(`${action.label}完成`, 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  const inline = QUICK_ACTIONS.filter((a) =>
    ['polish', 'grammar', 'shorter', 'expand', 'formal', 'casual', 'bullets', 'explain'].includes(
      a.key
    )
  )

  return (
    <Popover
      align="end"
      width={168}
      trigger={
        <IconButton title="AI 改写选中文字">
          {busy ? <Spinner /> : <Sparkles size={15} />}
        </IconButton>
      }
    >
      {(close) => (
        <div className="p-1">
          {inline.map((a) => (
            <button
              key={a.key}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                close()
                void apply(a)
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-[var(--ink-panel-2)]"
            >
              {a.label}
            </button>
          ))}
          <div className="my-1 h-px bg-[var(--ink-border)]" />
          {TARGET_LANGUAGES.slice(0, 5).map((l) => (
            <button
              key={l.code}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                close()
                void apply(translateAction(l.label))
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-[var(--ink-panel-2)]"
            >
              译为{l.label}
            </button>
          ))}
        </div>
      )}
    </Popover>
  )
}
