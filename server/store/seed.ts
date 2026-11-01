/**
 * 种子数据。
 *
 * 容器重建 / 首次启动时 data/ 是空的，如果首页什么都没有，访客会以为坏了。
 * 这里预生成三个项目（走和线上完全一样的编译管线，不是写死的 HTML），
 * 顺带证明"持久化"是真的：刷新后它们还在。
 */

import { compose } from '../agent/composer'
import { parseProtocol } from '../agent/protocol'
import { assemble } from '../preview/assemble'
import type { DesignPrefs, FileEntry, Plan } from '../../shared/types'
import type { Store } from './store'

interface Sample {
  prompt: string
  design: DesignPrefs
}

const SAMPLES: Sample[] = [
  { prompt: '做一个记账应用，叫「随手记账」，主色用墨绿，记录金额、分类和备注', design: { accent: '#12715B', theme: 'light', locale: 'zh' } },
  { prompt: '做一个番茄钟，专注 25 分钟，深色风格', design: { accent: '#4B3BFF', theme: 'dark', locale: 'zh' } },
  { prompt: '做一个轻量看板，待办 / 进行中 / 已完成三列', design: { accent: '#C2703A', theme: 'light', locale: 'zh' } },
]

export async function seedDatabase(store: Store): Promise<number> {
  if (store.listProjects().length > 0) return 0

  let created = 0
  for (const sample of SAMPLES) {
    const project = await store.createProject({
      prompt: sample.prompt,
      engine: 'local',
      design: sample.design,
      createdBy: 'nucleus',
    })

    const { text } = compose(sample.prompt, sample.design)
    const files: FileEntry[] = []
    let plan: Plan | null = null
    for (const event of parseProtocol(text)) {
      if (event.type === 'file_end') {
        files.push({ path: event.path, content: event.content, updatedAt: Date.now() })
      } else if (event.type === 'plan') {
        plan = event.plan
      }
    }
    const { checks } = assemble(files)

    await store.appendMessage({
      projectId: project.id,
      role: 'user',
      kind: 'text',
      content: sample.prompt,
    })
    await store.appendMessage({
      projectId: project.id,
      role: 'agent',
      kind: 'text',
      content: `已生成 ${files.length} 个文件：${files.map((file) => file.path).join('、')}。可以直接预览或继续提需求。`,
    })
    await store.commit(project.id, {
      files,
      plan,
      checks,
      prompt: sample.prompt,
      usage: { ms: 0, engine: 'local', chars: text.length },
      label: '初始版本',
    })

    created++
  }
  await store.flush()
  return created
}
