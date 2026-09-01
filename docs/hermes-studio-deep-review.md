# Hermes-Studio 源码深度审查与改造方案报告

- 范围：本仓库（`E:\hermes\hermes-studio`），只读审查，未修改任何源码。
- 检索方式：codegraph 索引 + ripgrep 全文检索 + 关键文件逐行核对。
- 传输事实澄清：本项目聊天流式通道是 **Socket.IO**（`/chat-run` 命名空间），并非 SSE/EventSource；SSE 仅存在于 coding-agents 的 claude-code/codex 反代中。因此问题 3、6 的"SSE"相关结论按实际传输层改写。

---

## 0. 架构速览（审查基线）

- 服务端：`packages/server/src`，按 `modules/studio | modules/hermes | modules/ekko | modules/coding-agents` 分域，`bootstrap/` 负责装配（`bootstrap/routes.ts`、`bootstrap/http.ts`）。
- 运行时双轨：
  1. **Hermes Agent（默认）**：Web UI → `ChatRunSocket`（`modules/studio/sockets/chat-run.ts`）→ `AgentBridgeClient`（`modules/hermes/services/bridge/client.ts`）→ Python bridge（`modules/hermes/services/bridge/python/*`）→ Hermes 的 `AIAgent`。
  2. **Ekko Agent（内嵌运行时）**：同一 `ChatRunSocket` 在 `coding_agent_id==='ekko-agent'` 或群聊/工作流场景转交 `modules/ekko/services/manager.ts` 的 `GlobalEkkoAgent` → `packages/ekko-agent` 的 `AgentRuntime`，直接调用模型提供商，**不经 Hermes gateway**。
  3. coding-agents（claude-code/codex/pi）为第三轨，走独立 `coding-agent-run-manager`。
- 数据落地：Web UI 状态 → `~/.hermes-web-ui`（`HERMES_WEB_UI_HOME` 可覆盖，`modules/studio/public/config.ts:54-55`）。Ekko 数据在 `~/.hermes-web-ui/.ekko/ekko.db`（生产）或 `packages/ekko-agent/.ekko`（开发模式）。

---

## 1. 📌 静默 System Prompt / 引导词注入（Prompt 污染）

### 命中点

| # | 文件:行 | 说明 |
|---|---|---|
| 1.1 | `packages/server/src/modules/studio/public/runs/prompt.ts:145-152` | `HERMES_MCP_USAGE_GUIDELINES`：一段 7 条硬编码"Studio MCP usage"引导词 |
| 1.2 | `packages/server/src/modules/studio/public/runs/prompt.ts:167-187` | `getSystemPrompt()`：无条件的把 `MCP_USAGE_GUIDELINES` + 输出格式规范拼入 system prompt |
| 1.3 | `packages/server/src/modules/studio/sockets/chat-run.ts:950-952` | 每次 Hermes bridge 运行把 `getSystemPrompt(...)` 拼到用户 `instructions` 之前 |
| 1.4 | `packages/server/src/modules/studio/services/chat-run/handle-bridge-run.ts:495-500` | 又追加一段 `runPrompt`（要求工具调用带 `X-Hermes-Profile` 头） |
| 1.5 | `packages/server/src/modules/studio/services/chat-run/handle-coding-agent-run.ts:160` | coding-agent 代理模式同样填充 `getSystemPrompt` |
| 1.6 | `packages/ekko-agent/src/runtime/system-prompt.ts:57-118` | Ekko runtime 无条件附加输出格式/工具执行/命令环境三大段常量到每个 system message |

### 当前代码实现与逻辑分析

```ts
// chat-run.ts:950-952  —— 用户不可见、不可关
let fullInstructions = data.instructions
  ? `${getSystemPrompt(undefined, { source })}\n${data.instructions}`
  : getSystemPrompt(undefined, { source })
```

```ts
// prompt.ts:181-184 —— 写入的"引导词"内容（节选）
parts.push(HERMES_MCP_USAGE_GUIDELINES.join('\n'));
parts.push(options?.outputLanguage === 'en' ? AI_OUTPUT_FORMAT_GUIDELINES_EN : AI_OUTPUT_FORMAT_GUIDELINES);
```

分析：
1. `getSystemPrompt()` 是**服务端硬编码注入**，无论用户是否开启 MCP、是否请求，只要走 Hermes bridge（默认聊天通道）就跑。用户只能把自己的 instructions 追加在后面，无法移除。
2. 该段内容包含产品意图（"遇接口文档就调用 X"、"不要用 chat-run/sessions 做内部委托"），会显著改变模型行为风格与上下文占用。
3. Ekko 轨（1.6）注入的是 `EKKO_OUTPUT_FORMAT_GUIDELINES` / `EKKO_TOOL_EXECUTION_GUIDELINES` / `Command Environment`，量大（约 1-2KB+），同为硬编码、用户不可关（Ekko 只有 `config.prompt.instructions` 追加式注入，见 `setup.ts:489 runtimeInstructions`）。
4. `handle-bridge-run.ts:463-465,499` 兜底二次拼接存在重复风险：注释明确说明"chat-run 已拼过"，但 `callbackContext?.instructions` 分支仍会再拼 `runPrompt` —— 由外部调用方不经 chat-run 直接调 `handleBridgeRun` 时会漏掉 MCP 引导。

### 🔎 修复建议

给注入分层、可配、可审计：

```ts
// prompt.ts —— 把常量改为"签名化"的可选块
export const HERMES_MCP_USAGE_GUIDELINES = [...]  // 保留
export type StudioPromptInjection =
  | { kind: 'mcp-usage' }
  | { kind: 'output-format'; lang: 'zh'|'en' }
  | { kind: 'workflow-node' }

// getSystemPrompt(custom, { inject: StudioPromptInjection[] = DEFAULT_INJECT })
//   —— 默认仍全开保持兼容，但允许实例级/profile 级覆盖

// chat-run.ts —— 把注入选项下放到 Profile 配置：
const profileSettings = await getProfilePromptConfig(profile) // 新配置项
let fullInstructions = data.instructions
  ? `${profileSettings.systemPrompt}\n${data.instructions}`
  : profileSettings.systemPrompt
```

2. 提供 UI 开关（`设置 → 模型/人格`）：`studioPromptInjection: 'default' | 'bare' | 'custom'`，`bare` = 只输出用户自定 system prompt。前端设置项需同步到全部 locale（AGENTS.md Hard Rules）。
3. 消除重复拼接：统一由 chat-run 组装一次，`handleBridgeRun` 收到非空 `instructions` 时**禁止再前缀**；把 `runPrompt` 并入注入块并在 `callbackContext` 分支用幂等标志去重。
4. 审计：在 `run.started` 事件里携带 `systemPromptSha256` 与 `injectedBlocks: string[]`，前端可展示"本次 System Prompt 由 X 块组成"。

---

## 2. 📌 Ekko 运行时捆绑与非标准目录持久化（生态劫持）

### 命中点

| # | 文件:行 | 说明 |
|---|---|---|
| 2.1 | `packages/ekko-agent/src/directories.ts:84-93` | `EkkoDirectoryManager` 构造默认 `homedir()` → 裸用库时数据落在 `~/.ekko/`（`ekko.db`、`config`、`skills`、`workspace`、`logs`） |
| 2.2 | `packages/ekko-agent/src/memory/paths.ts:12-18` | `resolveEkkoDataDirectory` 双态：非生产/非测试 → `packages/ekko-agent/.ekko`（**写入仓库目录**）；生产 → `EkkoDirectoryManager(base).rootDirectory` |
| 2.3 | `packages/server/src/modules/ekko/services/manager.ts:255-261` | `setupGlobalEkkoAgent` 传 `baseDirectory: config.appHome`，生产数据落 `~/.hermes-web-ui/.ekko/ekko.db` |
| 2.4 | `packages/server/src/modules/studio/sockets/chat-run.ts:981-998` | `coding_agent_id==='ekko-agent'` 时整个聊天改由 Ekko 直连模型商（不经 Hermes gateway） |
| 2.5 | `packages/server/src/bootstrap/routes.ts:110-113`、`modules/ekko/controllers/*` | `modules/ekko` 暴露 config/memory/skills/mcp 全套 API + 独立 `EkkoConfigStore`（`ekko/config.json`） |
| 2.6 | `packages/server/src/bootstrap/group-chat-agent-runtime-adapter.ts:17-28` | 群聊/工作流代理同时装配 Hermes bridge 与 Ekko runtime，双轨并存 |

### 当前代码实现与逻辑分析

```ts
// directories.ts:84-93 —— 库级默认
constructor(baseDirectory: string = homedir()) {
  this.baseDirectory = resolve(baseDirectory || homedir())
  this.rootDirectory = join(this.baseDirectory, '.ekko')
  this.databasePath = join(this.rootDirectory, 'ekko.db')
  ...
}

// paths.ts:12-18 —— 开发模式"落仓库"
export function resolveEkkoDataDirectory(options: EkkoDataPathOptions = {}): string {
  if (isEkkoDevelopmentEnvironment(options.env ?? process.env)) {
    return join(packageRoot, '.ekko')        // packages/ekko-agent/.ekko
  }
  return new EkkoDirectoryManager(options.baseDirectory || homedir()).rootDirectory
}
```

分析：
1. **存在三处数据目录**：开发 `packages/ekko-agent/.ekko`；生产 `<appHome>/.ekko`；库级默认 `~/.ekko`。同一个用户环境会因运行形态不同而在三处建库 —— 会话/记忆/技能不互通，迁移成本高。
2. 开发模式无视 `HERMES_WEB_UI_HOME` 覆盖（`paths.ts:13` 先判 env），会让"Web UI 状态必须受 `HERMES_WEB_UI_HOME` 管理"这条架构规则（ARCHITECTURE.md:31-35）在 Ekko 维度失效。
3. **并行生态**：Ekko 持有独立的 provider 配置（`ekko/config.json`、OAuth 授权、presets）、独立的会话/记忆力/技能体系，与 Web UI 的 provider 配置（`~/.hermes/config.yaml`）和 sessions 库（sqlite）是两套。用户在 Web UI 里配置模型，可能在 Ekko 轨上完全不生效或需二次配置 —— 这是"生态劫持/降级 Hermes"观感的来源。硬度评估：Hermes 仍是默认聊天执行器（`chat-run.ts:885-886` 默认走 bridge），并未被整体降级为子执行器；但群聊/工作流 agent 大量默认使用 Ekko 轨（见 2.6 装配），且在 Ekko 场景 Hermes 完全缺席。

### 🔎 修复建议

1. **统一数据目录**：生产路径收敛到 `config.appHome/.ekko`（现状已如此，保留）；开发模式改为 `resolve(appHome, '.ekko')`，删除 `paths.ts:13-16` 的"落仓库"分支，杜绝 git status 噪音与多库漂移：

```ts
export function resolveEkkoDataDirectory(options: EkkoDataPathOptions = {}): string {
  const base = options.baseDirectory || options.homeDir || homedir()
  return new EkkoDirectoryManager(base).rootDirectory
}
// manager.ts 已有 baseDirectory: config.appHome，保持即可
```

2. **平滑迁移**（一次性 CLI/启动任务 `scripts/migrate-ekko-data.mjs`）：
   - 探测 `~/.ekko`、`packages/ekko-agent/.ekko`、`<appHome>/.ekko` 是否存在；
   - 取"最新且数据最全"的 `ekko.db`、`config/`、`skills/`、`workspace/`、`logs/` 复制到 `<appHome>/.ekko`，旧目录重命名为 `*.legacy-<ts>` 不加删除；
   - 迁移后校验 `databasePath` 一致性，写迁移标志文件避免重复执行。

3. **provider 配置单向同步**：把 `config.model` 解析改为"Web UI provider 配置优先，`ekko/config.json` 仅作 fallback"。提供 `GET/POST /api/studio/ekko/provider-sync` 把 Hermes `config.yaml` 的模型/provider 同步进 Ekko，UI 提示"当前运行在 Ekko 轨，会使用其独立模型配置"。
4. **默认执行器白名单**：新增 `runtime.defaultExecutor: 'hermes' | 'ekko-agent'`，`ekko-agent` 仅在用户显式选择或群聊/工作流节点配置时启用；避免隐式降级。

---

## 3. 📌 90 秒 Watchdog 强杀长任务（稳定性暗坑）

### 结论先行

在 `packages/server/src` 与 `packages/ekko-agent/src` 中**不存在写死 90000ms 的"全局任务 watchdog"**。源码中唯一的 90000ms 是 Socket.IO 传输层心跳；真正"写死 90 且会停掉一个 run"的是**迭代数上限 90**（Ekko `maxSteps=90` / Hermes `max_iterations=90`）。以下是证据链与最接近的候选超时。

### 命中点

| # | 文件:行 | 值 | 性质 |
|---|---|---|---|
| 3.1 | `packages/server/src/modules/studio/sockets/group-chat.ts:3246-3252` | `pingTimeout: 90_000`，`pingInterval: 25_000` | **唯一 90000ms**。Socket.IO 心跳，与外层 `activeGroupChatServer.getIO()` 复用同一实例（`bootstrap/http.ts:567`），`/chat-run` 的所有连接同样受约束 |
| 3.2 | `packages/ekko-agent/src/config.ts:20` | `DEFAULT_AGENT_MAX_STEPS = 90` | 迭代上限，非时间 |
| 3.3 | `packages/ekko-agent/src/runtime/runtime.ts:483,634-641` | `for step<=maxSteps`；到达后 `run.max_steps` | 一个 run 最多 90 轮"模型+工具批" |
| 3.4 | `packages/server/src/modules/hermes/services/bridge/python/bridge_runtime.py:929` | `_cfg_max_turns(cfg, 90)` | Hermes `AIAgent(..., max_iterations=90)` |
| 3.5 | `packages/server/src/modules/studio/controllers/chat-run.ts:57-58` | `DEFAULT_TIMEOUT_MS=300_000`（上限 30min 墙钟） | 默认 300s 超时，超时返回 504 并走 `abortSession()` |
| 3.6 | `packages/server/src/modules/hermes/services/bridge/client.ts:22,383-391` | `DEFAULT_AGENT_BRIDGE_TIMEOUT_MS=120000` | 每个 bridge RPC 读超时，120s 无响应判失败 |
| 3.7 | `packages/server/src/modules/studio/services/group-chat/agent-clients.ts:1468` | `bridge.streamOutput(..., { timeoutMs: 120000 })` | 消费流单次 RPC 120s 无输出即失败 |
| 3.8 | `packages/server/src/modules/studio/services/coding-agents/group-chat/agent-relay.ts:59-60` | `RELAY_RUN_TIMEOUT_MS=150_000` | 群聊远程 agent 超时，但 `refreshRunTimeout`（747-752）可由事件刷新 |

### 当前代码实现与逻辑分析

```ts
// group-chat.ts:3246-3252（3.1 —— 表现为"90 秒被断开"的唯一候选）
pingInterval: 25_000,
pingTimeout: 90_000,
connectionStateRecovery: { maxDisconnectionDuration: 2 * 60_000, ... },
```

```ts
// runtime.ts:483, 634-641（3.3 —— 真正"停止 run"的 90）
for (let step = 1; step <= maxSteps; step += 1) { ... }
emit({ type: 'run.max_steps', runId, maxSteps })
output.content = `Stopped after reaching maxSteps (${maxSteps}).`
```

分析：
1. `pingTimeout:90s` 只负责"长静默思考期间客户端断连"，**不会杀服务端任务**（无 `disconnect→abort` 接线），但前端表现为连接丢失/重连，用户感知为"被强杀"。心跳不被流式增量刷新（只有 pong 刷新）。
2. 多步 Tool 调用的"被 90 卡住"最可能是 **maxSteps=90 / max_iterations=90**：长 workflow 一遍遍循环工具超过 90 步即被 `run.max_steps` 终止，且日志给出误导性"maxSteps(90)"。
3. 若用户遇到"90 秒级强杀"，更贴近 3.5/3.6/3.7 的 **120s 或 300s 无输出判定**，但都不是 90s。仓库外（Hermes Python 包内）仍可能有独立 watchdog，需另行核查 runtime 包。

### 🔎 修复建议

1. **心跳对行为敏感（3.1）切到长静默只降级不断连**：
   - 把 `pingInterval`/`pingTimeout` 提升到 `60_000/180_000`（或配置化），并为"静默思考"事件（`run.started`、`model.started` 期间的 reasoning）做服务端 `socket` 级 keepalive 或 `connectionStateRecovery` 兼容。
   - 更优：在 `ChatRunSocket` 对 `disconnect` 只标记、不 abort（已如此），并让客户端在 `reconnect_attempt` 后自动 `resume`（现有 resume 通道已具备）。
2. **迭代上限可配置且分层（3.2-3.4）**：
```ts
// config.ts —— 默认保持 90 但允许 per-profile 覆盖
maxSteps: number            // 沿用
```
   - 暴露 `runtime.maxSteps`（UI：设置→运行时）；群聊/工作流节点允许节点级 `maxSteps`。
   - 为 `run.max_steps` 事件在前端显示"已达步数上限（可调）"，而非静默终止。
3. **墙钟超时（3.5-3.7）**：把 `chat-run` 默认 300s 提升为可配置 `HERMES_CHAT_RUN_TIMEOUT_MS`，并对**长思考**（reasoning 阶段）与工具执行阶段分别计时：任何模型/tool 事件都重置"无输出时钟"，真正无输出才超时。
4. **群聊 relay（3.8）**：保持 `refreshRunTimeout` 的事件刷新机制，并把默认值提到 300s+。

---

## 4. 📌 全量 Tools 强行注入导致小参数/本地模型崩溃（请求体膨胀）

### 命中点

| # | 文件:行 | 说明 |
|---|---|---|
| 4.1 | `packages/ekko-agent/src/runtime/runtime.ts:1051-1058` | `modelRequest`：`tools = this.tools.definitions()` → 全部工具 Schema 进入每个请求 |
| 4.2 | `packages/ekko-agent/src/tools/registry.ts:115-139` | `createDefaultToolRegistry` 无条件注册 file/image/terminal/browser/delegation/recovery/skill/code_exec/clarify/mcp |
| 4.3 | `packages/ekko-agent/src/tools/browser.ts:56-159` | browser 一族 10 个工具（navigate/snapshot/click/type/scroll/back/press/get_images/vision/console），参数 schema 大 |
| 4.4 | `packages/ekko-agent/src/setup.ts:424` | 仅有全局 `config.tools.enabled` 布尔开关，无按模型/按 profile 的细粒度过滤 |
| 4.5 | `packages/ekko-agent/src/setup.ts:445-457,582-609` | 唯一过滤点是 `disabledSkillNames` 与 `codeExec` 开关，未覆盖 browser/terminal/files |

### 当前代码实现与逻辑分析

```ts
// runtime.ts:1051-1058 —— 一次请求携带的全部定义
const toolDefinitions = this.toolsEnabled
  ? this.tools.definitions().filter(...).map(...)
  : []
const tools = toolDefinitions.length > 0 ? toolDefinitions : undefined
```

```ts
// registry.ts:115-128 —— 默认全量注册
for (const tool of [
  ...createFileTools(),     // read_file/write_file/list_dir/delete_file/...
  ...createImageTools(),    // view_image
  ...createTerminalTools(), // terminal_exec
  ...createBrowserTools(),  // browser_* ×10
  ...createDelegationTools(), // delegate_task
  ...(recovery tools),
  ...createSkillTools(...), // skill_list/skill_view/skill_manage
]) { registry.register(tool) }
// + code_exec, clarify(provider), mcp(provider)
```

分析：
1. 除 `toolsEnabled` 全局开关外，**没有任何"按模型上下文窗口/按 profile 启用工具"的过滤**。对 Ollama / LM Studio 的小模型（如 4-8K 上下文），约 15-25 个完整 JSON Schema（含 browser 10 项大 schema + 可选 mcp/clarify provider 动态工具）会占据数千 token，显著挤占对话上下文，易触发 context length 错误。
2. `toolsEnabled` 是全有或全无：关掉则连 `read_file`/`view_image` 也消失，不可用；用户没有"只用基础文件工具"的中间档。
3. estimateContext（`runtime.ts:321-329` 与 bridge 端 `bridge_pool.py:897-908`）已把 tools 计入上下文估算，说明作者知晓膨胀问题，却未做注入侧裁剪。

### 🔎 修复建议

按 Profile 提供**工具白名单 + 按模型能力自动裁剪**：

```ts
// config —— 新增 per-profile 配置
tools: {
  enabled: false,
  profiles: {
    default: {
      allowed: [          // 白名单空 = 全部
        'read_file','write_file','list_dir','view_image',
        // 排除 browser_* / terminal_exec / code_exec 等重工具
      ],
    },
  },
  autoTrimForSmallContext: { enabled: true, maxTools: 12 }, // 见下
}
```

```ts
// setup.ts:createRuntime —— 组装按 profile 过滤的 registry
const allowTools = new Set(profileToolsAllowed(profileLayout.profile))
// registry.definitions() 时按 allowTools 过滤；tools.execute 同样校验 allowTools
```

2. **上下文预算裁剪**（`runtime.ts:modelRequest` 内）：
```ts
const budgetForTools = estimateToolTokenBudget(modelClient, maxContextTokens)
let enabled = toolDefinitions
if (budget > budgetForTools) {
  // 优先级：文件/原子工具 > blur 大 schema：裁剪 browser_* 与 document-heavy tools
  enabled = prioritizedNiceToHave(toolDefinitions)
}
```
   在 `estimateContext` 中同步执行，使 UI 能展示"已裁剪 N 个工具（×KB）"。
3. **默认档位**：新建 Profile 默认只启用 `read_file/write_file/list_dir/view_image/terminal_exec` + `code_exec`；重工具（browser）默认关闭，用户显式开启。这同时降低 `toolsEnabled=false` 时无工具可用的极端情况。
4. 前端 `ekko-config` views 增加"工具白名单"编辑（同步所有 locale）并默认展示估算 token。

---

## 5. 📌 工作区文件查看器路径穿越漏洞（Path Traversal）—— 🔴 高危

### 命中点（漏洞）

| # | 等级 | 文件:行 | 问题 |
|---|---|---|---|
| 5.1 | 🔴 HIGH-1 | `packages/server/src/modules/studio/controllers/download.ts:83-92` + `file-provider.ts:77-89` (`validatePath`) | 绝对路径分支绕过根目录边界，任意读盘 |
| 5.2 | 🔴 HIGH-2 | `packages/server/src/modules/studio/controllers/media.ts:284-299,327-338,396-421`（读）`619-630,716-723`（写） | `image_path` 无边界任读 + `output_path` 无边界任写 |
| 5.3 | 🔴 HIGH-3 | `packages/server/src/modules/studio/controllers/upload.ts:76-79` + `http/multipart.ts:23-41` | multipart 文件名未清洗，写入路径穿越 |
| 5.4 | 🟠 MEDIUM-4 | `packages/server/src/modules/studio/services/files/file-provider.ts:110-126` | 无 realpath/symlink 逃逸防护（对照 group-chat 有防护） |

### 当前代码实现与逻辑分析

```ts
// download.ts:83 —— 只校验"绝对 + 无 .."，不校验"在根内"
const validPath = isAbsolute(filePath) ? validatePath(filePath) : resolveProfileFilePath(filePath, profile)
...
data = await provider.readFile(validPath)   // 任意绝对路径直接读盘

// file-provider.ts:77-89
export function validatePath(filePath: string): string {
  const platformPath = normalizePlatformPath(filePath)
  if (hasTraversalSegment(platformPath)) throw ...invalid_path
  const resolved = resolve(platformPath)
  if (!isAbsolute(normalize(resolved))) throw ... 
  return resolved   // ← 没有任何 include-root 校验
}
```

```ts
// media.ts:284-286 —— body.image_path 任意读
const resolvedPath = isAbsolute(imagePath) ? imagePath : resolve(process.cwd(), imagePath)
const image = readFileSync(resolvedPath)
// media.ts:621-627 —— body.output_path 任意写
const outputPath = requestedOutputPath && images.length === 1 ? requestedOutputPath : ...
mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, Buffer.from(image, 'base64'))
```

```ts
// upload.ts:76-79 —— 扩展名取自未清洗文件名，join 后无包含性复核
const ext = filename.includes('.') ? '.' + filename.split('.').pop() : ''
const savedName = randomBytes(8).toString('hex') + ext
const savedPath = join(uploadDir, savedName)
await writeFile(savedPath, data)
```

分级分析：
- **5.1**：`download` 路由在 `bootstrap/routes.ts:133` 注册于总 auth 中间件之后，**任意登录用户**可用 `GET /api/studio/files/download?path=C:\Windows\win.ini`（Win）或 `/etc/passwd`（Linux）下载宿主任意文件（上限 200MB，`file-provider.ts:138`）。对比：同族 `files.ts` 的 read/write 都是 `requireSuperAdmin`（`routes/files.ts:11-17`），download 却未限 super-admin。相对分支走 `resolveProfileFilePath` 相对安全，但绝对分支完全失守，且可跨 profile 读 `.env/auth.json`（`isSensitivePath` 只保护写/删，不保护读，`file-policy`）。
- **5.2**：`/api/studio/media/*` 三条路由同样仅需登录（`routes/media.ts:6-8`）。`image_path` 直接 `readFileSync`（PNG/JPEG/WebP magic 限制只能挡挡格式，`media.ts:292`）；`output_path` 允许把攻击者可控字节写到任意路径（可覆盖 `config.yaml`/`.env`/启动项 → 提权面）。`resolveMediaProfile` 对单 profile 普通用户自动放行（`media.ts:71-80`）。
- **5.3**：`parseMultipartFilename`（`multipart.ts:40`）返回原始 filename，`upload.ts:76` 取最后一个 `.` 之后做扩展名拼入 `join(uploadDir, ...)`。如 `filename="x.xxx/../../../foo"` → `ext=".xxx/../../../foo"`，`savedPath` 越界到 `uploadDir` 之外实现任意写。此路由不需要 super-admin（`routes.ts:100` 之后）。对比 `files.ts` 的 upload（`files.ts:271-278`）走 `resolveProfileFilePath` 有防护，注意代码歧义：`files.ts` import 的是 `public/multipart`（`files.ts:7`），`upload.ts` import 的是 `http/multipart`，两套解析器实现一致但入口不同。
- **5.4**：`isPathWithin`（`path.ts:69-75`）是纯字面比较，不解析 symlink。profile 目录内若存在指向外部的链接（`secret -> C:\Users\...\.ssh\id_rsa`），`readFile/writeFile` 会沿链接落盘到 home 外。Group-chat/session 解析器已加 `isNearestExistingRealPathWithin`（`group-chat/workspace-files.ts:54`、`sessions.ts:781`），此路径缺失，属于对称性缺口。

### 已受保护对照（确认有效）

- `group-chat/workspace-files.ts:54`、`group-chat-workspace.ts:44-66`：`isPathWithin` + `isNearestExistingRealPathWithin`（含 symlink）。
- `sessions.ts:781,807`：同。
- `remote-workspace-files.ts:145-147,203`：`O_NOFOLLOW`。
- `kanban.ts:884,925`；`app-upload.ts/chunked-upload.ts`：随机存储名 + 扩展名白名单。
- `files.ts` upload 走 `resolveProfileFilePath`：`..`/绝对路径均被拒。
- 静态 SPA 兜底 `bootstrap/http.ts:515`：固定 `index.html`，不可控。

### 🔎 修复建议（务必以小步安全修复上线）

1. **download（5.1）**：严格根目录校验 + super-admin 门槛：
```ts
const roots = [homeDirForProfile(profile), config.uploadDir]
const abs = isAbsolute(filePath) ? validatePath(filePath) : resolveProfileFilePath(filePath, profile)
let ok = false
for (const root of roots) {
  if (isPathWithin(normalize(abs), normalize(root))) { ok = true; break }
}
if (!ok) { ctx.status = 403; ctx.body = { error: 'Access denied', code: 'permission_denied' }; return }
```
   并把该路由升级为 `requireSuperAdmin`（与 `files/read` 对齐）。
2. **media（5.2）**：`image_path` 读、`output_path` 写都必须限定在以 `config.appHome` 为根的目录内：
```ts
function assertWithinHouseRoot(p: string) {
  const abs = resolve(p)
  if (!isPathWithin(abs, config.appHome)) throw 403
  return abs
}
```
   且 `output_path` 强制扩展名白名单（`.png/.jpg/.webp/.mp4`）。
3. **upload（5.3）**：先 `basename` 剥路径，再随机 ID 拼接，最后 `isPathWithin` 兜底：
```ts
const safeName = basename(String(filename).replace(/\0/g, ''))
const ext = /(?:\.[a-z0-9]{1,16})$/i.test(safeName) ? safeName.slice(safeName.lastIndexOf('.')) : ''
const savedPath = join(uploadDir, randomBytes(8).toString('hex') + ext)
if (!isPathWithin(savedPath, uploadDir)) { ctx.status = 400; return }
```
4. **symlink（5.4）**：在 `resolveProfileFilePath` 读/写前追加 `isNearestExistingRealPathWithin(resolved, homeDir)`（可复用 group-chat 已实现的 helper），写前对父目录 `realpath` + `O_NOFOLLOW`。
5. 补单测：`files-routes.test.ts` 增加绝对路径/`..\`/盘符/URL 编码 `%2e%2e%2f`/symlink 用例；`upload-controller.test.ts` 增加恶意 filename 写入用例；`media-controller.test.ts` 增加 `image_path`/`output_path` 越界用例。

---

## 6. 📌 流式刷新导致的界面抖动与滚动条跳跃（体验暗坑）

> 传输层为 Socket.IO（`message.delta` / `message_stream_delta`），非 SSE，结论与修复思路一致。

### 6.1 Markdown 解析无节流 → 高频重排（主聊天缺失、群聊有 50ms 批处理）

命中点：
- `packages/client/src/stores/hermes/chat.ts:4024-4030`（以及 `:4684-4689` 后台/被动监听路径）：每个 `message.delta` 立即 `last.content += evt.delta`，**无聚合缓冲**。
- 对照：群聊实现正确批处理 —— `stores/hermes/group-chat.ts:95` `GROUP_CHAT_STREAM_FLUSH_INTERVAL_MS = 50`，`queueStreamDelta()`（290-307）加 `scheduleStreamDeltaFlush()`（282-288）。
- `components/chat/MarkdownRenderer.vue:187-282`：`renderedHtml` 是同步 computed，逐条 delta 都全量 `md.render()` + 4 趟正则 + 高亮（`highlight.ts`）＋ `watch(renderedHtml)` 重跑 `renderMermaidDiagrams()`（413-415）。
- 上游 `MessageItem.vue:1139-1142` 与 `MessageList.vue:584-595` 每 delta watch `content` → auto-scroll。长消息流式 O(n²)，表现即抖动/卡顿。

修复（仿群聊 store 批处理 or 渲染层 rAF）：
```ts
// 方案A（store 层，对齐 group-chat）
case 'message.delta': {
  pending.set(last.id, (pending.get(last.id) || '') + (evt.delta || ''))
  if (timer === null) timer = setTimeout(flush, 50)
}
// 方案B（渲染层 trailing rAF）
watch(() => props.content, () => {
  cancelAnimationFrame(raf); raf = requestAnimationFrame(() => renderContent.value = props.content)
})
```

### 6.2 自动吸底粗暴，上滚读历史被拽回

命中点：
- `components/chat/VirtualMessageList.vue:109-126,128-133`：主聊天正确维护 `userDetachedFromBottom`。
- **群聊忽略该锁**：`components/group-chat/GroupMessageList.vue:137-140` 用裸 `isNearBottom(200)`（不看 `userDetachedFromBottom`），且 `scrollToBottom`（`VirtualMessageList.vue:153-161`）无条件 `userDetachedFromBottom = false`。
- **Resize 兜底强拉**：`VirtualMessageList.vue:135-141` `handleResize`：流式每次 flush 高度变化 → `isNearBottom(64)` 内被拉回底部。
- `keepBottomUntil` 冷却（156）在流式高频下常被重置。

修复：
```ts
// GroupMessageList.vue —— 复用锁
const shouldScroll = shouldForceInitialBottom || (listRef.value?.shouldAutoFollowBottom(200) ?? true)
// VirtualMessageList.vue handleResize —— 仅在用户确实贴底时吸，否则保留锁
if (!userDetachedFromBottom || Date.now() < keepBottomUntil) scheduleScrollToBottom(2)
// scrollToBottom —— 仅在用户贴底(96px)时才解锁
if (userDetachedFromBottom && !isNearBottom(96)) { keepBottomUntil = Date.now(); return }
```

### 6.3 Tool Call 卡片 key 稳定性

命中点与现状：
- 各 v-for 的 key 均稳定：`MessageList.vue:794 :key="tc.id"`；`VirtualMessageList.vue:563 :key="messageKey(item)"`（`tool-run:${runId}`）；`ToolRunCard.vue:81 :key="tool.id"`；`MessageItem.vue:1217 :key="change.change_id"`；群聊 `GroupAgentRunCard.vue:120,137 :key="item.id"`。
- `groupCompletedToolsByRun` 每次重算生成新对象但同 id → v-for key 不变，普通流式**不重置折叠态**（主/群聊默认 `virtualized=false`，`MessageList.vue:641`）。
- 真正的重置风险点：
  1. 工具"运行中→完成"从实时工具条 `currentToolCalls`（`MessageList.vue:111-115`）转移为全新 `ToolRunCard` 行（285-292），折叠态无持久化目标；
  2. 断线重连时 `findToolMessageForEvent` 未命中则 `addMessage` 新 `uid()`（`chat.ts:2431-2443`），重放错位产生重复行且 key 漂移。

修复：
```ts
// 折叠态上提到列表级，按稳定 key 持久（覆盖"运行中→时间线"转移与重连重键）
const expandedRunIds = ref(new Set<string>())
<ToolRunCard :expanded="expandedRunIds.has(m.toolRunId)" @update:expanded="toggle" />
// 重连合并：store 内以 runMarker+toolCallId+toolName 精确合并，避免重复 uid 行
```

---

## 7. 📌 冗余硬件与打包构建检查（工程瘦身）

### 7.1 esp32/MCU 硬件控制

- **存在**：`packages/esp32-c3/v1`、`packages/esp32-c3/v2` 完整 PlatformIO 固件工程（`platformio.ini`、`manifest.json`），根 `package.json:56-58` 提供 `mcu:v1:flash:clean`/`mcu:v2:flash:clean`/`mcu:flash:clean` 脚本（依赖 `pio`/platformio CLI）。
- 服务端**活跃保留**全套 MCU 面：`routes/mcu-devices.ts`、`routes/mcu-firmware.ts`、`bootstrap/mcu-voice-adapter.ts`、`modules/studio/controllers/mcu-*`（firmware/devices/login/speech-segmenter/adpcm/prompts），`routes/auth.ts` 还挂 `/api/auth/mcu-login`。固件会构建进 `dist/mcu/v2/firmware.bin`（`README` 说明）。
- **评估**：MCU 生态（宠物/语音/设备）是产品功能而非死代码，**不建议移除功能**。但工程层面可瘦身：
  - Esp32 固件构建与 Web UI 发布解耦：`mcu:*` 脚本从根 `package.json` 下沉到 `packages/esp32-c3/package.json`（或独立 repo/CI），避免 `npm ci`/harness 必须依赖 pio。
  - 检查 `bootstrap/routes.ts` 中 mcu-voice/adapter 是否按 `HERMES_MCU_ENABLED` 环境开关惰性装配（当前为无条件 `import`，见 `routes.ts:3,101,140`）。

### 7.2 遥测（Telemetry）

- **未发现 PostHog/Sentry/MixPanel/自研 telemetry/analytics 采集**（全仓 `rg -i telemetry|posthog|sentry|mixpanel` 无命中）。`modules/studio/repositories/usage-store.ts` 等是**本地用量统计**（模型用量/token/成本），不对外上报，保留即可。可补充说明：`provider-audit-store.ts`、`skill-usage-store.ts` 均为本地落库。

### 7.3 依赖与构建任务瘦身

| 项 | 现状 | 建议 |
|---|---|---|
| `agent-browser`（dependencies:87） | 浏览器自动化运行库，与 `browser_*` 工具共用 | 若产品未启用 browser 工具则属可裁剪运行时；至少保持 optional |
| `sherpa-onnx-node` + 7 个平台 optionalDependencies:94-105,171-178 | 本地 STT 引擎（约数百 MB 原生二进制） | 保留功能，但确认 `overrides` 与 optional 平台包版本一致；若本地 STT 非常用可改为 lazy/按需安装（当前 `local-stt-model-manager` 已显式接管模型下载） |
| `node-pty`、`sharp`（dependencies:92-93） | 终端/图片处理，核心功能 | 保留 |
| `mcu` 相关 npm scripts（package.json:56-58） | 依赖 pio | 下沉/与 harness 解耦 |
| `numbers`：esp32-c3 在 `docker-compose.yml`/Dockerfile 是否打进去 | 需确认 | Docker 镜像应排除 `packages/esp32-c3`（无需 Node 运行） |
| `claude` script（package.json:68） | 开发辅助 | 保留 dev-only，不发布 |
| devDependencies 误用 | 大量运行时依赖（koa/socket.io 等）在 `devDependencies` 是因为 esbuild 打包 | 现状可行；注意 `node-pty`/`sharp`/`sherpa` 等 native 模块必须留在 `dependencies`（打包时 externals） |

建议为一揽子核查提供 `scripts/slim-audit.mjs`：检查产物 `dist/` 是否混入 `packages/esp32-c3`、`sherpa` 平台包、`speech` 模型与 `node_modules` 未用依赖，输出发布体积 TOP20。

---

## 8. 总体结论与修复优先级

| 优先级 | 问题 | 影响 | 建议动作 |
|---|---|---|---|
| P0 | 5.1/5.2/5.3 路径穿越（读任意文件/写任意路径） | 任意登录用户读宿主敏感文件、任意代码执行面 | 立即上线边界修复 + super-admin 收紧 + 单测 |
| P1 | 4 全量 Tools 注入 | 小模型上下文溢出、请求膨胀 | per-profile 白名单 + 上下文预算裁剪 |
| P1 | 1 System Prompt 静默注入 | 风格受限/上下文污染、不可审计 | 注入分层可配 + 幂等去重 + 审计事件 |
| P1 | 2 Ekko 数据目录三处漂移 | 会话/记忆不互通、迁移困难、生态并行 | 统一目录 + 一次性迁移工具 + provider 同步 |
| P2 | 3 90s 心跳断连 + 90 步迭代上限 | 长任务体验断裂、误导性日志 | 心跳降级不断连 + maxSteps 可配 + 事件刷新超时 |
| P2 | 5.4 symlink 逃逸 | 读/写越界（低利用门槛） | realpath 防护对齐 group-chat |
| P3 | 6 流式抖动/滚动/折叠 | 体验问题 | store 批处理(50ms)/rAF + 滚动锁 + 折叠上提 |
| P3 | 7 esp32/依赖瘦身 | 工程负担、发布体积 | mcu 解耦 + 发布审计脚本 |

### 后续推进建议

1. 按 P0→P3 逐一建立 issue/PR 小步落地（每项独立改动，遵守 AGENTS.md"不要把无关重构混入 bugfix"）。
2. 修复同时补 Vitest 单测（对应 `tests/server/*` 现有测试文件扩展）与 1-2 个 e2e 安全用例。
3. 每次落地前执行：`npm run harness:check`、针对测试、`npm run build`。