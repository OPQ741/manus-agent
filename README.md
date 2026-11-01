# Nucleus · 用一句话生成可运行的网页应用

> ROOT AI Native 全栈工程师笔试 · **Atoms-Demo** 实现
> 说一段需求 → Agent 实时流式产出代码 → 右侧立刻能点、能存、能改、能带走。

Nucleus 不是一个套壳聊天框。它把「Agent 生成应用」拆成一条**可观察、可中断、可回滚**的流水线：左侧是方案与文件流（精确到每个文件写了多少行），右侧是挂进沙箱的运行中应用，中间每一次修改都沉淀成一个可回滚的版本。

```
┌───────────── 输入一句话 ─────────────┐
│ 做一个记账应用，叫「小账本」，主色墨绿   │
└──────────────┬───────────────────────┘
               ▼
   ┌───────────────────────┐        ┌──────────────────────┐
   │  Agent 引擎（双引擎）   │  NWF   │  Studio 工作台        │
   │  Local 编译器 / Cloud  │ ─────▶ │  方案卡 · 文件流 · 检查 │
   └───────────────────────┘  事件流  └──────────┬───────────┘
                                                 ▼
                            ┌────────────────────────────────┐
                            │ 沙箱 iframe：真实可交互 + 错误桥  │
                            │ 版本时间线 · 回滚 · 导出 · 分享    │
                            └────────────────────────────────┘
```

![工作台](docs/screenshots/studio.png)

<sub>左：对话与文件流；右：生成的应用在沙箱里真实运行，可切换代码 / 版本视图。</sub>

---

## 快速开始

```bash
git clone <repo> && cd nucleus-studio
npm install
npm start          # 自动 build，监听 http://localhost:8787
```

> 无需注册、无需 API Key、无需数据库——打开即可用。默认走**本地引擎**（确定性的真编译器），在 `/settings` 里填入任意 OpenAI 兼容的 Key 即可切到**云端引擎**。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口 |
| `NUCLEUS_DATA_DIR` | `./data` | 数据目录（单文件 JSON，可直接删除重置） |
| `NUCLEUS_LLM_KEY` | — | 云端引擎 Key（也可在设置页填写） |
| `NUCLEUS_LLM_BASE_URL` | `https://api.openai.com/v1` | 兼容 Ollama / DeepSeek / 通义等 |
| `NUCLEUS_LLM_MODEL` | `gpt-4o-mini` | 模型名 |

---

## 能做什么

![首页](docs/screenshots/home.png)

| 能力 | 说明 |
| --- | --- |
| **流式生成** | 方案先出，再逐个文件落字；每行代码你都能看见它写下来 |
| **真实沙箱预览** | 生成完自动挂载，应用内的按钮、表单、列表**真的能点** |
| **数据持久化** | 应用写入的数据在刷新预览后仍在；项目与版本落在服务端 |
| **对话迭代** | 「主色改成墨绿」→ 只重写受影响的文件，不重来一遍 |
| **运行时自愈** | 应用内报错被桥接回宿主 → 一条浮条 → 一键让 Agent 修 |
| **版本时间线** | 每次生成/回滚都是新版本，可 diff、可回滚，历史不可变 |
| **导出 ZIP** | 解压后**双击 index.html 就能跑**，不依赖本服务 |
| **免登录分享** | `/p/:slug` 生成公开链接，无痕窗口可直接使用 |
| **双引擎切换** | 本地编译器保证「打开即用」；云端 LLM 保证「上限可期」 |

---

## 技术要点

- **NWF 协议**：自定义流式生成协议 `<note> / <plan> / <file path="..."> / <delete>`，字符级状态机增量解析，任意位置断流都能恢复，解析器**永不抛异常**（异常一律降级为 `warning` 事件）。
- **统一事件模型**：`AgentEvent`（stage / note / plan / file_start / file_delta / file_end / delete / check / warning / done / error）是后端、SSE 传输、前端 reducer、测试断言共用的唯一契约。
- **双引擎**：`AgentEngine` 接口 + `LocalEngine`（意图分类 → 槽位抽取 → 配方发射，7 个 archetype，确定性字节一致）+ `CloudEngine`（OpenAI 兼容 SSE，带超时、SSRF 防护、错误码归一）。
- **沙箱**：`srcdoc` + 内联组装，`sandbox="allow-scripts allow-forms ..."` 且**不给** `allow-same-origin`；内层内存 storage shim + 宿主种子回灌，实现「刷新数据还在」又不暴露宿主源。
- **持久化**：单文件 JSON，写 tmp + `rename` 原子落盘，串行写队列；版本为整份快照，回滚 O(1)。
- **零依赖**：运行时只有 `react` / `react-dom`；hash 路由、语法高亮、ZIP、diff 均为自研（合计 <300 行）。

```
shared/types.ts          全系统唯一契约（AgentEvent / Project / Version）
server/agent/protocol.ts NWF 增量状态机
server/agent/composer.ts 本地编译器（7 个 archetype）
server/agent/llm.ts      OpenAI 兼容 SSE + SSRF 防护
server/agent/runner.ts   引擎编排，事件归一
server/preview/assemble.ts 内联组装 + 沙箱桥 + storage shim
server/store/store.ts    原子写 + 版本 + 回滚
server/index.ts          路由 / SSE / 导出 / 分享
src/pages/Studio.tsx     工作台（对话流 + 预览 + 代码 + 版本）
```

---

## 测试

```bash
npm test        # 单元 + 集成：101 passed
npm run e2e     # 真实 Chrome 浏览器 10 步（需先 npm start）
```

| 层 | 覆盖 | 结果 |
| --- | --- | --- |
| 单元 | 协议解析 22 · 编译器 23 · 组装 19 · ZIP 7 · 存储 14 | ✅ 85 |
| 集成 | HTTP 全链路 16（含假上游验证云链路、并发 409、回滚、导出、分享） | ✅ 16 |
| E2E | 生成 → 交互 → 刷新持久 → 迭代 → 自愈 → 回滚 → 导出 → 分享 → 移动端 | ✅ 10/10 |
| 类型 | `tsc --noEmit`（strict + noUnusedLocals） | ✅ 0 error |

真实执行输出见 [`docs/05-测试用例.md`](docs/05-测试用例.md) §9。

---

## 文档

| 文件 | 内容 |
| --- | --- |
| [`docs/01-需求调研与竞品分析.md`](docs/01-需求调研与竞品分析.md) | Atoms 观察、v0/Bolt/Lovable 对标、约束与路线选择 |
| [`docs/02-产品需求文档-PRD.md`](docs/02-产品需求文档-PRD.md) | 信息架构、F1–F9 规格、状态异常矩阵、验收清单 |
| [`docs/03-技术架构文档.md`](docs/03-技术架构文档.md) | 架构图、选型与被否理由、数据模型、接口契约、安全边界 |
| [`docs/04-技术设计文档.md`](docs/04-技术设计文档.md) | 协议状态机、编排与漂移纠正、编译器三阶段、一致性设计 |
| [`docs/05-测试用例.md`](docs/05-测试用例.md) | 用例设计 + 真实执行报告 |
| [`docs/06-交付说明.md`](docs/06-交付说明.md) | **推荐先读**：实现思路、关键取舍、完成程度、后续优先级 |
| [`docs/00-笔试题目原文.md`](docs/00-笔试题目原文.md) | 题目存档 |

---

## 目录结构

```
server/     Agent 内核 · 预览组装 · 存储 · HTTP 接口
shared/     前后端共享类型契约
src/        React 工作台（首页 / Studio / 分享页 / 设置）
tests/      Vitest 单元 + 集成
scripts/    Playwright E2E
docs/       需求 · 架构 · 设计 · 测试 · 交付说明
```

## License

MIT
