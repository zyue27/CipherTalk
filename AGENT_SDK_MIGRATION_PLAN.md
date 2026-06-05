# Agent 编排迁移到 OpenAI Agents SDK — 执行计划

> 目标：把现有自研的 Agent 编排（`electron/services/aiagent/`）整体迁移到
> **OpenAI Agents SDK（`@openai/agents`，JS/TS）**。用 SDK 的编排能力
> （Agent / tool-loop / handoff / streaming）替换自研的 while 循环，
> **数据层和工具实现照旧复用**，旧代码保留作对照，跑通后再删。
>
> 本文档供另一个 AI / 开发者接手执行。每阶段结束须 `npx tsc --noEmit` 零错误 + 人工冒烟。

---

## 0. 开工前需你拍板（决策点）

这几条直接决定执行路径，**开工前先确认**：

| # | 决策 | 计划默认 | 说明 |
|---|------|---------|------|
| D1 | 先迁哪条线 | **全局线（globalAgent）先行** | 它已是标准 tool-loop，迁移摩擦最小；单会话线的领域编排放最后啃 |
| D2 | 新代码目录 | `electron/services/agent-v2/` | 旧 `aiagent/` 一行不动，留作 A/B 对照 |
| D3 | 首个验证 provider/模型 | **待你指定**（建议挑一个你常用、确认支持 tools 的，如 DeepSeek / 通义 / OpenAI 兼容端点） | 阶段 1 用它把链路跑通 |
| D4 | `openai` 升 v5 | **接受**（见 §1 风险 A，硬前置） | 不升级则 `@openai/agents` 装不进来 |
| D5 | 领域编排逻辑去留 | **砍掉**确定性编排（证据质量评估 / 搜索失败改写重试 / auto-finalize），改由模型自主决策 | 你已确认"多余内容不要了"。代价见 §6 风险 E |
| D6 | 多 provider 容错 | **不做**。模型不支持 tools → 直接报错让用户换 | 你已确认 |

> 若 D1/D5 你有不同想法，先说，整个阶段顺序会变。

---

## 1. 现状摸底（迁移前必须理解的边界）

### 1.1 统一入口

`electron/services/aiagent/engine.ts` 的 `run(request, emit, onProgress, signal)` 是唯一入口，
被 IPC（`electron/main/ipc/aiagentHandlers.ts`）调用。它做 **scope 路由**：

```
run()
 ├─ scopedSessions.length === 1  → aiService.answerSessionQuestion()  → 单会话线
 ├─ scope.kind==='session' & >1  → runGlobalConversation()            → 全局线
 ├─ scope.kind==='session'       → aiService.answerSessionQuestion()  → 单会话线
 └─ 否则（global）                → runGlobalConversation()            → 全局线
```

迁移后，**这套 scope 路由会被 SDK 的 handoff / triage agent 替代**（阶段 5）。

### 1.2 两条线现状（差异巨大）

**全局线** `global/globalAgent.ts` —— **已经是标准 tool-calling agent**：
- `runToolLoop()`：`MAX_TOOL_CALLS=24` 的 while 循环，`provider.streamChatWithTools` + 自动执行工具 + 回填。
- 工具来源：`buildEnabledTools()` = 内置 `ct_*` 工具（`BUILTIN_TOOL_SCHEMAS`）+ 已连接的外部 MCP 工具。
- 工具执行：`mcpCallTool()` → `ct_*` 走 `agentToolWorkerService.run(toolName, args, {readLimit})`；其余走 `mcpClientService.callTool()`。
- **这条线和 SDK 范式一一对应，迁移最简单 → 作为 D1 首迁。**

**单会话线** `engine/orchestrator.ts` —— **领域确定性编排**：
- `answerSessionQuestionWithAgent()`：意图路由（`intent/router.ts` + `intent/aiRouter.ts`）→ 原生 tools 主循环 → 大量本地兜底（证据质量 `evidenceQuality`、搜索 0 命中改写重试、`auto-finalize`、上下文窗口预算 `MAX_CONTEXT_WINDOWS`）。
- 8 个领域工具（`engine/nativeTools.ts` 定义 schema，`orchestrator.ts` 分发执行）：
  `read_summary_facts` / `search_messages` / `read_context` / `read_latest` /
  `read_by_time_range` / `resolve_participant` / `aggregate_messages` / `answer`。
- 这些工具**直接调数据层函数**（见 §1.4）。
- 按 D5：迁移时**只保留工具，丢弃确定性编排**，让模型自主决定调用顺序。

### 1.3 两个事件契约（UI 依赖，迁移后必须保持）

**a) `AIStreamEvent`**（`src/types/ai.ts`，回答内容流，两条线都用）：
`content_delta` / `reasoning_delta` / `tool_call_delta` / `tool_call_done` /
`tool_result` / `round_start` / `message_done`。经 `emit` 回调送前端。

**b) `SessionQAProgressEvent`**（`engine/types.ts`，进度时间线，**仅单会话线发**）：
`stage`(intent/thought/tool/context/answer) + `status`(running/completed/failed) +
`nodeName`/`displayName`/`source`，由 `engine/progress.ts` 的 `emitProgress` 构建，经 `onProgress` 送前端 ProgressTimeline。

> ⚠️ 迁移核心难点之一：SDK 的运行事件（`RunStreamEvent`）要**适配映射**回这两个契约，
> 否则前端要大改。见阶段 3。

### 1.4 要原样复用的"真资产"（**不要重写**）

| 资产 | 文件 | 关键函数 |
|------|------|---------|
| 单会话检索 | `engine/tools/search.ts` | `searchSessionMessages` / `loadLatestContext` / `loadContextAroundMessage` |
| 时间范围读取 | `engine/tools/timeRange.ts` | `loadMessagesByTimeRange(All)` |
| 参与者解析 | `engine/tools/participant.ts` | `resolveParticipantName` |
| 消息聚合 | `engine/tools/aggregate.ts` | `aggregateMessages` |
| 数据访问 | `engine/data/repository.ts`、`engine/data/retriever.ts` | — |
| 全局 `ct_*` 工具 | `agentToolWorkerService` | `.run(toolName, args, {readLimit})` |
| Provider（含代理） | `ai/providers/base.ts` | `BaseAIProvider.getClient()`（注入 `proxyService` 代理） |

新架构里，SDK 的 `tool({ execute })` 函数体**直接调上面这些函数**，迁移的只是"外壳编排"。

### 1.5 依赖 / 构建现状

- `package.json`：`openai ^4.70.0`，`electron ^39.6.0`，**无 `@openai/agents`、无 `zod`（需确认）**。
- 构建：`tsc && vite build && electron-builder`；dev：`vite`。
- Agent 代码全部在 **Electron 主进程**（Node 环境）运行 → SDK 跑在主进程，无浏览器限制。

### 1.6 ⚠️ 三个必须先认清的风险

**风险 A（硬前置）—— `openai` v4 → v5。**
`@openai/agents` 依赖 `openai` v5+。但 `ai/providers/base.ts` 及各 provider 直接用 v4 API
（`new OpenAI(...)`、`client.chat.completions.create(...)`、类型 `OpenAI.Chat.ChatCompletionMessageParam`）。
升级会牵动**所有 provider 文件**。→ 必须先做阶段 0。

**风险 B —— 复用代理。**
SDK 默认用自己的 OpenAI client。要让它走用户配置的 `baseURL` / `apiKey` / **代理**，
须用 `setDefaultOpenAIClient(new OpenAI({ baseURL, apiKey, httpAgent }))` +
`setOpenAIAPI('chat_completions')`（国产 provider 多数只支持 chat completions，不支持 Responses API）。
代理 agent 复用 `proxyService.createProxyAgent(baseURL)`。

**风险 C —— Tracing 隐私。**
SDK 默认开启 tracing 并上报 OpenAI。处理本地隐私聊天记录，**初始化第一步必须
`setTracingDisabled(true)`**（或换自定义 exporter）。

> 📌 本文档涉及的 SDK API 名称（`Agent`/`run`/`tool`/`handoff`/`setDefaultOpenAIClient`/
> `setOpenAIAPI`/`setTracingDisabled` 等）以**安装版本的官方文档为准**，开工前用
> context7 或 https://openai.github.io/openai-agents-js/ 校对一遍，避免版本差异。

---

## 2. 目标架构

从「双线（确定性编排 + tool-loop）」收敛为「**SDK Agents + Tools (+ Handoff)**」：

```
新入口 run()（agent-v2/engine.ts）
   │  初始化：setDefaultOpenAIClient + setOpenAIAPI('chat_completions') + setTracingDisabled(true)
   │
   ├─ Triage / 路由（替代旧 scope 路由）
   │     ├─ 命中单个会话 ─ handoff ─▶ SessionQA Agent
   │     └─ 全局 / 多会话 ──────────▶ Global Agent
   │
   ├─ Global Agent
   │     instructions: 原 buildDefaultAgentSystemPrompt
   │     tools: ct_* 工具（execute → agentToolWorkerService.run）+ 外部 MCP 工具
   │
   └─ SessionQA Agent（绑定 sessionId，经 RunContext 注入）
         instructions: 原 prompts/decision + answer 精简合并
         tools: search_messages / read_context / read_latest / read_by_time_range /
                resolve_participant / aggregate_messages / read_summary_facts
                （execute → §1.4 数据层函数）
```

关键点：
- **不再有** `evidenceQuality` / 搜索改写重试 / `auto-finalize` / `pickFallbackToolAction` 等确定性兜底（D5）。
- 运行用 `run(agent, input, { stream: true, context: { sessionId, ... } })`，
  流式事件经**适配器**转成 `AIStreamEvent` + `SessionQAProgressEvent`。

---

## 3. 分阶段执行

> 行号/函数名执行前先 `grep` 重新定位。每阶段 `tsc --noEmit` 通过 + 冒烟后再进下一阶段。

### 阶段 0：前置 —— 升级 `openai` v4 → v5（隔离风险 A）

1. `npm i openai@^5` （锁定一个 v5 小版本）。
2. 全量 `tsc --noEmit`，逐个修 `ai/providers/*.ts` 和 `base.ts` 的类型/调用差异
   （v5 主要变化：部分类型路径、`stream` 返回类型、少量参数命名；`chat.completions.create` 主体兼容）。
3. **冒烟**：现有 AI 总结、单会话问答、全局 Agent 全部跑通一遍（用旧 `aiagent/`，此阶段不碰编排）。
4. ✅ 验收：`tsc` 零错误 + 三个 AI 功能行为与升级前一致。**这一阶段独立可回退，先单独提交。**

> 若 v5 升级影响面过大无法接受 → 回到 D4 重新决策（备选：放弃 SDK，或用其它兼容 v4 的编排库）。

### 阶段 1：装 SDK + 建骨架 + 跑通最小 agent

1. `npm i @openai/agents zod`（确认 zod 版本符合 SDK 要求，通常 `zod@^3`）。
2. 建目录 `electron/services/agent-v2/`，新建 `sdkSetup.ts`：
   ```ts
   import OpenAI from 'openai'
   import { setDefaultOpenAIClient, setOpenAIAPI, setTracingDisabled } from '@openai/agents'
   import { proxyService } from '../ai/proxyService'

   let inited = false
   export async function initAgentSdk(baseURL: string, apiKey: string) {
     setTracingDisabled(true)                 // 风险 C：隐私，必须
     setOpenAIAPI('chat_completions')         // 风险 B：兼容国产 provider
     const httpAgent = await proxyService.createProxyAgent(baseURL)  // 风险 B：复用代理
     setDefaultOpenAIClient(new OpenAI({ baseURL, apiKey, httpAgent, timeout: 300000 }))
     inited = true
   }
   ```
   > 注意：`setDefaultOpenAIClient` 是全局单例。若一次运行内要切换 provider，需在每次 `run` 前重设；
   > 或评估用 SDK 的 per-agent `model` 实例方案（开工时按官方文档确认哪种更稳）。
3. 写一个最小 demo：一个 `Agent` + 一个 `tool`（如返回当前时间），用 D3 指定的 provider
   `run(agent, 'test')`，确认 ① 能连上 ② tool 被调用 ③ 拿到 finalOutput。
4. ✅ 验收：demo 跑通，控制台无 tracing 上报、无代理报错。

### 阶段 2：迁全局线（D1 首迁，最像 SDK）

1. 新建 `agent-v2/globalAgent.ts`。把 `ct_*` 工具逐个包成 SDK `tool`：
   ```ts
   import { tool } from '@openai/agents'
   import { z } from 'zod'
   const ctSearchMessages = tool({
     name: 'ct_search_messages',
     description: '…（沿用 BUILTIN_TOOL_SCHEMAS 里的描述）',
     parameters: z.object({ sessionId: z.string(), keyword: z.string(), /* … */ }),
     execute: async (args) => {
       const { agentToolWorkerService } = await import('../agentToolWorkerService')
       return agentToolWorkerService.run('ct_search_messages', args, { readLimit })
     },
   })
   ```
   - 工具清单对齐旧 `buildEnabledTools()`：所有 `ct_*` + 外部 MCP 工具。
   - 外部 MCP 工具：评估用 SDK 的 MCP 接入（`hostedMcpTool` / MCP server 配置），或继续用
     `mcpClientService.callTool` 包成普通 `tool`。**优先后者，改动小。**
   - 参数 schema 从旧的 JSON schema 翻成 zod（`BUILTIN_TOOL_SCHEMAS` 里有现成 JSON schema 可逐字段对照）。
2. 建 `Global Agent`：`instructions` 用旧 `buildDefaultAgentSystemPrompt` 的内容；
   `systemPromptSuffix`（会话范围 / commandHint / skill 内容，来自旧 `buildSystemPromptSuffix`）
   拼进 instructions 或用动态 instructions。
3. 先用**非流式** `run()` 跑通：同一个问题，新 Global Agent vs 旧 `runGlobalConversation` 结果对照。
4. ✅ 验收：典型全局问题（"找 X 的会话并看最近聊了啥"、"导出和 X 的聊天"）能正确多步调用 `ct_*` 工具、结果合理。

### 阶段 3：流式 / 进度事件适配器（UI 不改的关键）

1. 新建 `agent-v2/streamAdapter.ts`。用 `run(agent, input, { stream: true })`，
   遍历 `RunStreamEvent`，映射到现有契约：
   - 模型文本增量 → `AIStreamEvent.content_delta`
   - 推理增量 → `reasoning_delta`
   - 工具调用开始/结束 → `tool_call_done`
   - 工具返回 → `tool_result`
   - agent 切换 / 新一轮 → `round_start`
   - 结束 → `message_done`
   - （SessionQA 线额外）阶段性节点 → `SessionQAProgressEvent`（stage/status/nodeName）
2. ⚠️ SDK 的事件结构（`raw_model_stream_event` / `run_item_stream_event` /
   `agent_updated_stream_event`）以安装版本为准，先打印一遍真实事件再写映射。
3. 全局线接上适配器，前端 AiAgentPanel / MessageList **不改代码**也能正常流式显示。
4. ✅ 验收：前端打字机效果、工具调用气泡、（若适用）进度时间线表现与旧线一致。

### 阶段 4：迁单会话线（啃硬骨头，按 D5 简化）

1. 新建 `agent-v2/sessionAgent.ts`。把 9 个领域工具包成 SDK `tool`，
   `execute` 直接调 §1.4 的数据层函数（`searchSessionMessages` / `loadSessionStatistics` / …）。
   - `sessionId` 不放进每个工具参数，而是通过 `run(..., { context: { sessionId } })` +
     `execute(args, runContext)` 注入，避免模型瞎填 sessionId。
2. `instructions`：把旧 `prompts/decision.ts` + `prompts/answer.ts` 精简合并成一份系统提示词
   （这就是你说的"系统提示词自己写不难"那部分）。**强调**：事实类问题证据不足要继续查或明说不足。
3. **不迁移**：`evidenceQuality`、`generateAlternativeQueries` 重试、`auto-finalize`、
   `pickFallbackToolAction`、`MAX_CONTEXT_WINDOWS` 预算等确定性逻辑（D5）。
4. 接阶段 3 的适配器，补 `SessionQAProgressEvent`。
5. ✅ 验收：用一批**真实问题**（建议从旧线日志里捞 20~30 条）让新旧两条线并答，人工对比质量。
   **这是质量回归的关键关卡**——若新线明显变差（少查、早答、漏证据），回到 D5 决定是否保留部分兜底。

### 阶段 5：Handoff / Triage（替代 scope 路由）

1. 在 `agent-v2/engine.ts` 重写 `run()` 入口：
   - 单会话 scope → 直接跑 SessionQA Agent（注入 sessionId）。
   - 全局 scope → 跑 Global Agent；当它定位到**单个会话**时，`handoff` 给 SessionQA Agent
     （对应旧 `engine.ts` 中 `scopedSession.length===1 → 切到会话编排` 的逻辑）。
2. 保持 `run(request, emit, onProgress, signal)` **签名不变**，IPC 层（`aiagentHandlers.ts`）零改动。
3. `signal`（取消）映射到 SDK 的中断机制（`run` 的 abort/signal 选项，按官方文档）。
4. ✅ 验收：全局问题能在定位到具体会话后无缝交接、答案连贯；取消按钮能中断运行。

### 阶段 6：切换入口 + 灰度对照

1. 加一个开关（config 字段，如 `agentEngineV2: boolean`），让 IPC 层在 v1 / v2 间切。
   默认先 v1，自己用 v2 对照。
2. 旧 `aiagent/` **完全保留**。
3. ✅ 验收：v2 跑一段时间（你日常使用），覆盖单会话 / 全局 / 多会话 / 导出 / 取消 等场景无回归。

### 阶段 7：清理

1. v2 稳定后，IPC 入口固定指向 v2，删除开关。
2. 删除旧 `electron/services/aiagent/` 中**仅被旧编排使用**的文件
   （`orchestrator.ts`、`agentContext.ts`、`agentDecision.ts`、`evidence.ts`、
   `intent/*`、`nativeTools.ts`、`global/globalAgent.ts`、`global/builtinTools.ts` 等）。
   > ⚠️ §1.4 的**数据层函数若被 v2 复用，不能删** —— 删前 `grep` 确认无 agent-v2 引用。
3. 更新 `aiagent/index.ts` 导出 / 引用方。
4. ✅ 验收：`tsc` 零错误，全功能冒烟通过，包体无残留死代码。

---

## 4. 通用注意事项 / 坑

1. **阶段 0 必须先单独完成并提交**：openai v5 升级和 SDK 迁移是两件事，混在一起出问题难定位。
2. **数据层零改动**：迁移只动"编排外壳"，`tools/*.ts`、`data/*.ts`、`agentToolWorkerService` 函数体不重写。
3. **代理别丢**：`setDefaultOpenAIClient` 的 client 必须带 `proxyService` 的 httpAgent，否则国内直连失败。
4. **Tracing 必关**：`setTracingDisabled(true)` 放在任何 `run()` 之前，CI/启动时校验它被调用。
5. **事件契约保持**：`AIStreamEvent` / `SessionQAProgressEvent` 的字段不要改，前端才不用动。
6. **sessionId 用 context 注入**，不要做成工具参数让模型填。
7. **provider 全局单例问题**：`setDefaultOpenAIClient` 是全局的；多 provider/多会话并发时注意串扰，
   必要时串行化或评估 per-run client 方案。
8. **每阶段 `npx tsc --noEmit` 零错误**；仓库无自动化 UI 测试，靠人工冒烟。
9. **不改** IPC 签名、前端组件、`src/services/config.ts` 持久化层（除阶段 6 加一个开关字段）。

---

## 5. 验收标准（整体）

- `npx tsc --noEmit` 零错误。
- `run()` 入口签名不变，IPC / 前端零改动即可工作（除阶段 6 的开关字段）。
- 全局线：多步 `ct_*` 工具调用、外部 MCP、导出等行为与旧线一致。
- 单会话线：20~30 条真实问题人工对比，**质量不低于旧线**（这是 go/no-go 关卡）。
- 流式打字机、工具气泡、进度时间线 UI 表现一致。
- 取消（abort）有效。
- Tracing 确认未上报；代理生效。
- 旧 `aiagent/` 在阶段 7 前可随时回退。

---

## 6. 诚实的预期管理

- **换 SDK 不会让回答变"更聪明"**：自主决策能力在模型里，不在框架。新线质量 = 模型 + 你的提示词 + 工具描述。
- **真正的收益**：编排标准化、handoff 现成、代码量下降、长期可维护性提升、可观测性（若日后需要）。
- **真正的成本**：阶段 0（openai v5）+ 阶段 3（事件适配器）+ 阶段 4 质量回归，是三个最花时间的地方。
- **风险 E（D5 的代价）**：丢掉确定性兜底后，弱模型可能"少查几步就回答"。阶段 4 的对照测试就是用来量化这个风险的；若不可接受，再考虑把"搜索 0 命中改写重试"这一条最有价值的兜底以 guardrail 形式加回。
```
