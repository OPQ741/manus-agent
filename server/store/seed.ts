/**
 * 出厂示例。
 *
 * 首页下面那个项目**不是 mock**：它是用真实模型（默认免 Key 通道）跑完整链路
 * ——firstTurnMessages → NWF 协议 → assemble——产出后固化下来的产物，
 * 连同 prompt、提供方、模型、耗时、token 一起入库，可追溯、可复现。
 *
 * 为什么不在启动时现调模型生成：
 *  - 部署环境出不了网就会把整个服务卡死在启动阶段；
 *  - 免 Key 通道 30 秒 1 次请求，容器每次重建都烧掉一次配额；
 *  - 访客第一次打开首页，看到的应该是"已经有个能点的东西"，不是转圈。
 *
 * 想换示例：跑 `npm run make:factory`，它会用当前配置的真实模型重新生成并覆盖
 * factory-example.json（走的是产品自己的 HTTP 链路，所以排队/故障转移/修复轮/自检
 * 全部生效；产物不合格时脚本会拒绝写入）。
 */

import { assemble } from '../preview/assemble'
import type { Plan, ProviderInfo } from '../../shared/types'
import type { Store } from './store'
import factory from './factory-example.json'

export interface FactoryExample {
  schema: number
  prompt: string
  provider: ProviderInfo
  /** 生成耗时（毫秒）与上游回报的 token，用于展示"这是真的调了模型" */
  usage: { ms: number; chars: number; tokens?: number }
  generatedAt: number
  modelOutput?: string
  plan?: Plan | null
  files: { path: string; content: string }[]
}

const example = factory as FactoryExample

export function loadFactory(): FactoryExample {
  return example
}

/**
 * 空库时载入出厂示例。
 *
 * 返回新建的项目数：0 表示库里已经有东西（包括访客自己建的项目），绝不再塞。
 */
export async function seedDatabase(store: Store): Promise<number> {
  if (store.listProjects().length > 0) return 0
  if (!example?.files?.length) return 0

  const now = Date.now()
  const files = example.files.map((file) => ({ path: file.path, content: file.content, updatedAt: now }))
  const { checks } = assemble(files)

  const project = await store.createProject({
    prompt: example.prompt,
    design: store.getSettings().design,
    createdBy: 'nucleus',
    provider: example.provider.id,
    providerLabel: example.provider.label,
  })

  await store.appendMessage({ projectId: project.id, role: 'user', kind: 'text', content: example.prompt })
  await store.appendMessage({
    projectId: project.id,
    role: 'agent',
    kind: 'notice',
    content:
      `出厂示例由真实模型生成：${example.provider.label}（${example.provider.model}）· ` +
      `${files.length} 个文件 · 耗时 ${(example.usage.ms / 1000).toFixed(1)}s` +
      (example.usage.tokens ? ` · ${example.usage.tokens} tokens` : '') +
      '。可以直接预览、改需求、导出。',
    meta: {
      factory: true,
      provider: example.provider,
      generatedAt: example.generatedAt,
      usage: example.usage,
    },
  })

  await store.commit(project.id, {
    files,
    plan: example.plan ?? null,
    checks,
    prompt: example.prompt,
    usage: { ms: example.usage.ms, provider: example.provider.id, chars: example.usage.chars, tokens: example.usage.tokens },
    label: '真实模型生成 · 初始版本',
  })

  await store.flush()
  return 1
}
