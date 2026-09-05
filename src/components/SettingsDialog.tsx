import { useEffect, useState } from 'react'
import {
  Check,
  Cpu,
  Database,
  Eye,
  EyeOff,
  Palette,
  Plus,
  RefreshCw,
  Trash2,
  Zap,
} from 'lucide-react'
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'
import { useApp } from '../lib/store'
import * as api from '../lib/api'
import type { AiProfile, BackgroundKind, Stats } from '../lib/types'
import { cn, formatBytes, uid } from '../lib/utils'
import { Button, Dialog, Field, Input, Select, Spinner, Swatches, Toggle, useToast } from './ui'
import { NOTEBOOK_COLORS } from '../lib/utils'

const PRESETS: { name: string; baseUrl: string; model: string; style: 'openai' | 'anthropic' }[] = [
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', style: 'openai' },
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', style: 'openai' },
  {
    name: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    style: 'openai',
  },
  { name: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', style: 'openai' },
  { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', style: 'openai' },
  { name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct', style: 'openai' },
  { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini', style: 'openai' },
  { name: 'Ollama（本地）', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5', style: 'openai' },
  { name: 'LM Studio（本地）', baseUrl: 'http://localhost:1234/v1', model: 'local-model', style: 'openai' },
  { name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5', style: 'anthropic' },
]

type Tab = 'ai' | 'appearance' | 'canvas' | 'data'

export function SettingsDialog() {
  const open = useApp((s) => s.settingsOpen)
  const settings = useApp((s) => s.settings)
  const patchSettings = useApp((s) => s.patchSettings)
  const store = useApp
  const toast = useToast()

  const [tab, setTab] = useState<Tab>('ai')
  const [stats, setStats] = useState<Stats | null>(null)

  useEffect(() => {
    if (open && tab === 'data') void api.getStats().then(setStats)
  }, [open, tab])

  return (
    <Dialog
      open={open}
      onClose={() => store.getState().setUI({ settingsOpen: false })}
      title="设置"
      width={680}
    >
      <div className="flex gap-1 border-b border-[var(--ink-border)] pb-3">
        {(
          [
            ['ai', 'AI 服务', <Cpu size={14} key="a" />],
            ['appearance', '外观', <Palette size={14} key="b" />],
            ['canvas', '画布', <Zap size={14} key="c" />],
            ['data', '数据与备份', <Database size={14} key="d" />],
          ] as [Tab, string, React.ReactNode][]
        ).map(([k, label, icon]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={cn(
              'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] transition',
              tab === k
                ? 'bg-[var(--ink-accent-soft)] font-medium text-[var(--ink-accent)]'
                : 'text-[var(--ink-muted)] hover:bg-[var(--ink-panel-2)]'
            )}
          >
            {icon}
            {label}
          </button>
        ))}
      </div>

      <div className="pt-4">
        {tab === 'ai' && <AITab />}

        {tab === 'appearance' && (
          <div>
            <Field label="主题">
              <Select
                value={settings.theme}
                onChange={(e) =>
                  patchSettings({ theme: e.target.value as 'system' | 'light' | 'dark' })
                }
              >
                <option value="system">跟随系统</option>
                <option value="light">浅色</option>
                <option value="dark">深色</option>
              </Select>
            </Field>
            <div className="mt-2 rounded-xl border border-[var(--ink-border)] p-3">
              <Toggle
                checked={settings.autoTitle}
                onChange={(v) => patchSettings({ autoTitle: v })}
                label="新页面写下第一行文字后自动生成标题"
              />
            </div>
          </div>
        )}

        {tab === 'canvas' && (
          <div>
            <Field label="新页面默认背景">
              <Select
                value={settings.defaultBackground}
                onChange={(e) =>
                  patchSettings({ defaultBackground: e.target.value as BackgroundKind })
                }
              >
                <option value="grid">方格</option>
                <option value="dots">点阵</option>
                <option value="lines">横线</option>
                <option value="staff">窄横线</option>
                <option value="blank">空白</option>
              </Select>
            </Field>
            <Field label="默认画笔颜色">
              <Swatches
                colors={NOTEBOOK_COLORS.concat(['#1f2937', '#ef4444'])}
                value={settings.penColor}
                onChange={(c) => patchSettings({ penColor: c })}
              />
            </Field>
            <div className="mt-2 rounded-xl border border-[var(--ink-border)] p-3">
              <Toggle
                checked={settings.snapEnabled}
                onChange={(v) => patchSettings({ snapEnabled: v })}
                label="拖动元素时显示对齐参考线并吸附"
              />
            </div>
          </div>
        )}

        {tab === 'data' && <DataTab stats={stats} onRefresh={() => void api.getStats().then(setStats)} />}
      </div>
    </Dialog>
  )
}

// ───────────── AI 设置 ─────────────

function emptyProfile(): AiProfile {
  return {
    id: uid('ai'),
    name: '我的服务',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    apiStyle: 'openai',
    temperature: 0.6,
    maxTokens: 4096,
    timeoutSecs: 180,
    supportsVision: false,
  }
}

function AITab() {
  const settings = useApp((s) => s.settings)
  const patchSettings = useApp((s) => s.patchSettings)
  const toast = useToast()

  const [editingId, setEditingId] = useState<string | null>(
    settings.aiProfiles[0]?.id ?? null
  )
  const [showKey, setShowKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [loadingModels, setLoadingModels] = useState(false)
  const [models, setModels] = useState<string[]>([])

  const profiles = settings.aiProfiles
  const current = profiles.find((p) => p.id === editingId) ?? null

  const update = (patch: Partial<AiProfile>) => {
    if (!current) return
    patchSettings({
      aiProfiles: profiles.map((p) => (p.id === current.id ? { ...p, ...patch } : p)),
    })
  }

  const addProfile = (preset?: (typeof PRESETS)[number]) => {
    const p = emptyProfile()
    if (preset) {
      p.name = preset.name
      p.baseUrl = preset.baseUrl
      p.model = preset.model
      p.apiStyle = preset.style
    }
    patchSettings({
      aiProfiles: profiles.concat([p]),
      activeProfileId: settings.activeProfileId ?? p.id,
    })
    setEditingId(p.id)
    setModels([])
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {profiles.map((p) => (
          <button
            key={p.id}
            onClick={() => {
              setEditingId(p.id)
              setModels([])
            }}
            className={cn(
              'flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12.5px] transition',
              p.id === editingId
                ? 'border-[var(--ink-accent)] bg-[var(--ink-accent-soft)] text-[var(--ink-accent)]'
                : 'border-[var(--ink-border)] hover:bg-[var(--ink-panel-2)]'
            )}
          >
            {settings.activeProfileId === p.id && <Check size={12} />}
            {p.name}
          </button>
        ))}
        <button
          onClick={() => addProfile()}
          className="flex items-center gap-1 rounded-lg border border-dashed border-[var(--ink-border)] px-2.5 py-1 text-[12.5px] text-[var(--ink-muted)] hover:border-[var(--ink-accent)] hover:text-[var(--ink-accent)]"
        >
          <Plus size={12} /> 新增
        </button>
      </div>

      {profiles.length === 0 && (
        <div className="rounded-xl border border-dashed border-[var(--ink-border)] p-4">
          <div className="mb-2 text-[13px] font-medium">从常见服务快速添加</div>
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.name}
                onClick={() => addProfile(p)}
                className="rounded-lg border border-[var(--ink-border)] px-2.5 py-1 text-[12px] hover:border-[var(--ink-accent)] hover:text-[var(--ink-accent)]"
              >
                {p.name}
              </button>
            ))}
          </div>
          <div className="mt-3 text-[11.5px] leading-relaxed text-[var(--ink-muted)]">
            也可以点「新增」手动填写任意 OpenAI 兼容服务的地址、密钥和模型名。
            密钥只保存在本机 <code>~/Library/Application Support/com.jinyanshao.reunote</code> 的数据库里。
          </div>
        </div>
      )}

      {current && (
        <div>
          <div className="grid grid-cols-2 gap-x-3">
            <Field label="名称">
              <Input value={current.name} onChange={(e) => update({ name: e.target.value })} />
            </Field>
            <Field label="协议">
              <Select
                value={current.apiStyle}
                onChange={(e) => update({ apiStyle: e.target.value as 'openai' | 'anthropic' })}
              >
                <option value="openai">OpenAI 兼容（大多数服务）</option>
                <option value="anthropic">Anthropic Messages</option>
              </Select>
            </Field>
          </div>

          <Field
            label="接口地址 Base URL"
            hint="填到 /v1 即可，例如 https://api.deepseek.com/v1；也可以直接粘贴完整的 /chat/completions 地址。"
          >
            <Input
              value={current.baseUrl}
              placeholder="https://api.openai.com/v1"
              onChange={(e) => update({ baseUrl: e.target.value })}
              spellCheck={false}
            />
          </Field>

          <Field label="API Key" hint="仅保存在本机，不会上传到除你填写的服务之外的任何地方。">
            <div className="relative">
              <Input
                type={showKey ? 'text' : 'password'}
                value={current.apiKey}
                placeholder="sk-…"
                onChange={(e) => update({ apiKey: e.target.value })}
                spellCheck={false}
                className="pr-9"
              />
              <button
                onClick={() => setShowKey((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--ink-muted)]"
                type="button"
              >
                {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </Field>

          <Field label="模型">
            <div className="flex gap-2">
              <Input
                value={current.model}
                placeholder="gpt-4o-mini"
                onChange={(e) => update({ model: e.target.value })}
                spellCheck={false}
                list="jinyan-notes-models"
              />
              <datalist id="jinyan-notes-models">
                {models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              <Button
                variant="outline"
                onClick={async () => {
                  setLoadingModels(true)
                  try {
                    const list = await api.aiModels(current)
                    setModels(list)
                    toast(`拉取到 ${list.length} 个模型，点输入框可选择`, 'success')
                  } catch (e) {
                    toast(e instanceof Error ? e.message : String(e), 'error')
                  } finally {
                    setLoadingModels(false)
                  }
                }}
                className="shrink-0"
              >
                {loadingModels ? <Spinner /> : <RefreshCw size={13} />}
                模型列表
              </Button>
            </div>
          </Field>

          <div className="grid grid-cols-3 gap-x-3">
            <Field label="温度">
              <Input
                type="number"
                step="0.1"
                min="0"
                max="2"
                value={current.temperature}
                onChange={(e) => update({ temperature: Number(e.target.value) })}
              />
            </Field>
            <Field label="最大输出 tokens">
              <Input
                type="number"
                min="256"
                step="256"
                value={current.maxTokens}
                onChange={(e) => update({ maxTokens: Number(e.target.value) })}
              />
            </Field>
            <Field label="超时（秒）">
              <Input
                type="number"
                min="10"
                max="900"
                value={current.timeoutSecs}
                onChange={(e) => update({ timeoutSecs: Number(e.target.value) })}
              />
            </Field>
          </div>

          <div className="rounded-xl border border-[var(--ink-border)] p-3">
            <Toggle
              checked={current.supportsVision}
              onChange={(v) => update({ supportsVision: v })}
              label="该模型支持读图（用于手写与图片文字识别）"
            />
          </div>

          <div className="mt-4 flex items-center gap-2">
            <Button
              variant="primary"
              onClick={async () => {
                setTesting(true)
                try {
                  const reply = await api.aiTest(current)
                  toast(`连接成功：${reply}`, 'success')
                } catch (e) {
                  toast(e instanceof Error ? e.message : String(e), 'error')
                } finally {
                  setTesting(false)
                }
              }}
            >
              {testing ? <Spinner /> : <Zap size={13} />}
              测试连接
            </Button>
            <Button
              variant={settings.activeProfileId === current.id ? 'soft' : 'outline'}
              onClick={() => patchSettings({ activeProfileId: current.id })}
            >
              {settings.activeProfileId === current.id ? '当前正在使用' : '设为默认'}
            </Button>
            <div className="flex-1" />
            <Button
              variant="ghost"
              onClick={() => {
                if (!window.confirm(`删除服务「${current.name}」？`)) return
                const next = profiles.filter((p) => p.id !== current.id)
                patchSettings({
                  aiProfiles: next,
                  activeProfileId:
                    settings.activeProfileId === current.id ? (next[0]?.id ?? null) : settings.activeProfileId,
                })
                setEditingId(next[0]?.id ?? null)
              }}
              className="!text-red-500"
            >
              <Trash2 size={13} />
              删除
            </Button>
          </div>

          <div className="mt-4 flex flex-wrap gap-1.5 border-t border-[var(--ink-border)] pt-3">
            <span className="mr-1 text-[11.5px] text-[var(--ink-muted)]">快速填入预设：</span>
            {PRESETS.map((p) => (
              <button
                key={p.name}
                onClick={() =>
                  update({ baseUrl: p.baseUrl, model: p.model, apiStyle: p.style, name: p.name })
                }
                className="rounded-md border border-[var(--ink-border)] px-2 py-[2px] text-[11.5px] text-[var(--ink-muted)] hover:border-[var(--ink-accent)] hover:text-[var(--ink-accent)]"
              >
                {p.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ───────────── 数据设置 ─────────────

function DataTab({ stats, onRefresh }: { stats: Stats | null; onRefresh: () => void }) {
  const toast = useToast()
  const store = useApp
  const [busy, setBusy] = useState(false)

  return (
    <div>
      <div className="mb-4 grid grid-cols-3 gap-2">
        {[
          ['笔记本', stats?.notebooks],
          ['分区', stats?.sections],
          ['页面', stats?.pages],
          ['字符数', stats?.words],
          ['附件', stats?.attachments],
          ['数据库', stats ? formatBytes(stats.dbSize) : undefined],
        ].map(([label, value]) => (
          <div
            key={String(label)}
            className="rounded-xl border border-[var(--ink-border)] px-3 py-2.5"
          >
            <div className="text-[11px] text-[var(--ink-muted)]">{label}</div>
            <div className="mt-0.5 text-[16px] font-semibold">
              {value === undefined ? '—' : typeof value === 'number' ? value.toLocaleString() : value}
            </div>
          </div>
        ))}
      </div>

      {stats && (
        <div className="mb-4 rounded-xl bg-[var(--ink-panel-2)] px-3 py-2 text-[11.5px] leading-relaxed text-[var(--ink-muted)]">
          数据目录：<span className="selectable">{stats.dataDir}</span>
          <br />
          所有笔记、附件与设置都只保存在这台 Mac 上，没有账号，也不会联网同步。
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              if (!(await store.getState().save(true))) {
                toast('当前页面保存失败，已取消备份', 'error')
                return
              }
              const path = await saveDialog({
                title: '备份到…',
                defaultPath: `reunote备份-${new Date().toISOString().slice(0, 10)}.reunotebak`,
                filters: [{ name: 'reunote备份', extensions: ['reunotebak'] }],
              })
              if (!path) return
              const size = await api.backupExport(path, true)
              toast(`备份完成（${formatBytes(size)}）`, 'success')
            } catch (e) {
              toast(e instanceof Error ? e.message : String(e), 'error')
            } finally {
              setBusy(false)
              onRefresh()
            }
          }}
        >
          导出完整备份
        </Button>

        <Button
          variant="outline"
          disabled={busy}
          onClick={async () => {
            const path = await openDialog({
              title: '选择备份文件',
              multiple: false,
              filters: [{ name: '笔记备份', extensions: ['reunotebak', 'jinyanbak', 'json'] }],
            })
            if (!path || Array.isArray(path)) return
            if (!window.confirm('从备份恢复会覆盖同 ID 的内容，确定继续？')) return
            setBusy(true)
            try {
              if (!(await store.getState().save(true))) {
                toast('当前页面保存失败，已取消恢复', 'error')
                return
              }
              const n = await api.backupImport(path)
              toast(`已恢复 ${n} 条记录`, 'success')
              await store.getState().refreshTree()
              const s = store.getState()
              if (s.notebookId) await s.selectNotebook(s.notebookId)
            } catch (e) {
              toast(e instanceof Error ? e.message : String(e), 'error')
            } finally {
              setBusy(false)
              onRefresh()
            }
          }}
        >
          从备份恢复
        </Button>

        <Button variant="ghost" onClick={onRefresh}>
          <RefreshCw size={13} />
          刷新统计
        </Button>
      </div>
    </div>
  )
}
