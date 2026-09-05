import { useApp } from '../lib/store'
import { Dialog } from './ui'

const GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: '工具',
    items: [
      ['V', '选择'],
      ['H', '抓手（也可按住空格拖动）'],
      ['T', '文本块'],
      ['N', '便签'],
      ['P', '画笔'],
      ['M', '荧光笔'],
      ['E', '橡皮（整笔擦除）'],
      ['L', '套索选择墨迹'],
      ['R / O / A', '矩形 / 椭圆 / 箭头'],
    ],
  },
  {
    title: '画布',
    items: [
      ['双击空白处', '新建文本块'],
      ['⌘ + 滚轮 / 触控板捏合', '缩放'],
      ['滚轮 / 双指滑动', '平移'],
      ['⌘ =  /  ⌘ -', '放大 / 缩小'],
      ['⌘ 0  /  ⌘ 9', '实际大小 / 适应内容'],
      ['拖动时按 ⇧', '锁定水平或垂直方向'],
      ['拖动时按 ⌥', '临时关闭吸附'],
    ],
  },
  {
    title: '编辑',
    items: [
      ['⌘ Z  /  ⇧⌘ Z', '撤销 / 重做'],
      ['⌘ A', '全选元素'],
      ['⌘ D', '复制选中元素'],
      ['⇧⌘ D', '创建当前页面副本'],
      ['⌫', '删除选中'],
      ['方向键 / ⇧方向键', '微调 1px / 10px'],
      ['⌘ S', '立即保存'],
      ['在文本里输入 /', '唤起块命令菜单'],
    ],
  },
  {
    title: '导航与面板',
    items: [
      ['⌘ K', '全局搜索'],
      ['⌘ F', '在本页查找'],
      ['⌘ G  /  ⇧⌘ G', '下一个 / 上一个匹配'],
      ['⌘ J', 'AI 助手'],
      ['⌘ \\', '显示 / 隐藏边栏'],
      ['⌘ N', '新建页面'],
      ['⇧⌘ N', '新建分区'],
      ['⇧⌘ L', '切换深色模式'],
      ['⇧⌘ E', '导出当前页为 Markdown'],
    ],
  },
  {
    title: '语法',
    items: [
      ['#标签', '自动收集为标签'],
      ['[[页面标题]]', '建立双向链接'],
      ['# / ## / ###', '标题'],
      ['- 或 1.', '列表'],
      ['```', '代码块'],
      ['> ', '引用'],
    ],
  },
]

export function ShortcutsDialog() {
  const open = useApp((s) => s.shortcutsOpen)
  const store = useApp
  return (
    <Dialog
      open={open}
      onClose={() => store.getState().setUI({ shortcutsOpen: false })}
      title="键盘快捷键"
      width={720}
    >
      <div className="grid grid-cols-2 gap-x-8">
        {GROUPS.map((g) => (
          <div key={g.title} className="mb-5">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--ink-muted)]">
              {g.title}
            </div>
            {g.items.map(([key, label]) => (
              <div
                key={key}
                className="flex items-center justify-between border-b border-[var(--ink-border)]/60 py-[5px] text-[12.5px] last:border-0"
              >
                <span className="text-[var(--ink-muted)]">{label}</span>
                <kbd className="ml-3 shrink-0 rounded border border-[var(--ink-border)] bg-[var(--ink-panel-2)] px-1.5 py-[1px] font-mono text-[11px]">
                  {key}
                </kbd>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Dialog>
  )
}
