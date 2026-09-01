# P0 安全与提示词注入 修复方案

分支：`fix/security-p0-path-traversal-and-prompt-injection`
基线：v0.6.30（initial commit `4ede476`）
状态：**方案文档（待评审），尚未修改源码**

本文档针对 `docs/hermes-studio-deep-review.md` 中确认在 v0.6.30 真实存在的 P0 问题，
列出逐条核对后的证据、修复方案、影响范围与测试计划。改动遵循 AGENTS.md：
路由保持薄、复用现有 helper、单测补齐、不把无关重构混入本次修复。

---

## 0. 问题清单与优先级总览

| # | 问题 | 风险 | 路径位置（v0.6.30 实际） | 优先级 |
|---|---|---|---|---|
| A | Hermes 主聊天 system prompt 双重注入 | 话术污染/上下文膨胀/不可关 | `lib/llm-prompt.ts:102` 定义；`run-chat/index.ts:465-467,612` + `run-chat/handle-bridge-run.ts:338-340,364-367` 双重拼装 | P1（高） |
| B | Ekko 运行时 system prompt 注入 | 同上（Ekko 轨） | `ekko-agent/src/runtime/runtime.ts` 调 `buildSystemPrompt`，runtimeInstructions 默认空；需确认 default 注入 | P1（中） |
| C | download 绝对路径任意读（越根目录） | 🔴 任意登录用户读宿主任意文件（`C:\Windows\...`、`/etc/passwd`、`.env`、`auth.json`） | `routes/hermes/download.ts:84` + `services/hermes/file-provider.ts:82-94` `validatePath` 无根边界 | P0 |
| D | media 任读/任写（越 `appHome`） | 🔴 任意读盘 + 任意路径写入 | `controllers/hermes/media.ts:150/257`（读）、`:467/473/550`（写） | P0 |
| E | upload multipart 文件名路径穿越 | 🔴 任意路径写入 | `controllers/upload.ts:53-55` + `lib/multipart.ts:40` | P0 |
| F | 权限不对称：files 系 super-admin，download/media/upload 仅登录 | 放大 A/C/D/E 可利用面 | `routes/hermes/files.ts`（requireSuperAdmin） vs `routes/hermes/download.ts` / `media.ts` / `upload.ts`（无） | P0（配套） |

---

## 1. 证据核对（v0.6.30 实际代码）

### A. Hermes system prompt 双重注入

定义（`lib/llm-prompt.ts:102-117`）：`getSystemPrompt()` **无条件**拼入 7 条
`HERMES_MCP_USAGE_GUIDELINES` + `AI_OUTPUT_FORMAT_GUIDELINES`：

```ts
export function getSystemPrompt(customPrompt?, options?): string {
  const parts: string[] = []
  if (customPrompt) parts.push(customPrompt)
  if (options?.source === 'workflow') parts.push(WORKFLOW_NODE_SYSTEM_CONTEXT.trim())
  parts.push(HERMES_MCP_USAGE_GUIDELINES.join('\n'))   // 7 条硬编码
  parts.push(AI_OUTPUT_FORMAT_GUIDELINES)              // 输出格式规范
  return parts.join('\n\n')
}
```

**双重拼装**（同一段 MCP 引导 + 格式规范被注入两次）：

1. `run-chat/index.ts:465-467`
   ```ts
   let fullInstructions = data.instructions
     ? `${getSystemPrompt(undefined, { source })}\n${data.instructions}`
     : getSystemPrompt(undefined, { source })
   await handleBridgeRun(this.nsp, socket, { ...data, instructions: fullInstructions }, ...)
   ```
2. `run-chat/handle-bridge-run.ts:338-340`（收到的 `instructions` 已是第 1 步结果，再次前缀）
   ```ts
   const { input, session_id, instructions } = data
   let fullInstructions = instructions
     ? `${getSystemPrompt(undefined, { source: data.session_source || data.source })}\n${instructions}`
     : getSystemPrompt(undefined, { source: data.session_source || data.source })
   ```
3. `run-chat/handle-bridge-run.ts:364-367`（第三次，工具引导）
   ```ts
   const runPrompt = [
     'When calling Hermes Web UI endpoints from tools or skills, include the current Hermes profile as the X-Hermes-Profile header ...',
   ]
   fullInstructions = `\n${runPrompt}\n${fullInstructions}`
   ```
4. 恢复会话路径 `run-chat/index.ts:612` 也调 `getSystemPrompt(...)`。

结论：**同一段内容最多可被拼接 2~3 次**（bug），且用户无法在 UI/配置层面关闭（只有通过
`data.instructions` 追加，无法移除）。

### B. Ekko 运行时

`ekko-agent/src/runtime/system-prompt.ts` 的 `buildSystemPrompt` 已参数化（分块：basePrompt /
Runtime Instructions / Runtime Context / Skills / memoryContext / userSystemMessages），
**无硬编码大段常量**。需要确认 `runtime.ts` 是否默认注入 runtimeInstructions（当前 `runtime.ts`
读取 `options.runtimeInstructions`，默认 `[]`）。倾向：Ekko 轨非本版 P1 重点，仅需在配置层
保证"可关"。

### C. download 未越根（但无边界）

- 相对路径分支：`resolveHermesPath`（`file-provider.ts:124-138`）正确 `isPathWithin` 兜底。
- 绝对路径分支：`rules/hermes/download.ts:84` 走 `validatePath`（`file-provider.ts:82-94`），
  只校验"绝对 + 无 `..`"，**不校验是否在 profile 根 / uploadDir / appHome 内**。
- 因此 `GET /api/hermes/download?path=C:\Windows\win.ini`（或 Linux `/etc/passwd`）可下载任意文件，
  且 `isSensitivePath`（`.env`、`auth.json`）目前只保护写/删，**不保护读**。
- 该路由仅过全局 auth（`routes/index.ts:97` 注册于 `authMiddleware` 之后），非 super-admin。

### D. media 任读/任写

- 读：`controllers/hermes/media.ts:150` `imagePathToDataUri` / `:257` `normalizeImageFile`
  ```ts
  const resolvedPath = isAbsolute(imagePath) ? imagePath : resolve(process.cwd(), imagePath)
  const image = readFileSync(resolvedPath)   // 无根边界
  ```
- 写：`:467/473` `saveGeneratedImages` → `writeFileSync(outputPath, ...)`；
  `:550` `downloadVideo` → `writeFileSync(outputPath, buffer)`。`output_path` 来自请求体，可覆盖
  任意路径（如覆盖 `config.yaml` / 启动项 → 提权面）。
- 仅登录保护（`routes/index.ts:105`），非 super-admin。

### E. upload 文件名穿越

- `lib/multipart.ts:23-41` `parseMultipartFilename` 返回原始 filename（含路径片段），`basename` 未剥离。
- `controllers/upload.ts:53-55`
  ```ts
  const ext = filename.includes('.') ? '.' + filename.split('.').pop() : ''
  const savedName = randomBytes(8).toString('hex') + ext
  const savedPath = join(uploadDir, savedName)
  ```
  恶意 `filename="x.xxx/../../../foo"` → `ext=".xxx/../../../foo"`，`savedPath` 逃出 `uploadDir` 任意写。
- 仅登录保护（`routes/index.ts:76`）。

### F. 权限不对称

`requireSuperAdmin` 定义于 `middleware/user-auth.ts:248`。`routes/hermes/files.ts` 的
read/write/delete/rename/mkdir/copy/upload 全部要求 super-admin，而 `download.ts` / `media.ts` /
`upload.ts` 均未启用。

---

## 2. 修复方案

### A. 提示词注入分层、可配、去重

目标：消除双重/三重注入；让 MCP 引导、输出格式、工作流上下文成为**可独立启停的签名化可选块**；
用户可用 UI 选择"默认 / bare（仅自定 system prompt）/ 自定义"。

1. **`lib/llm-prompt.ts` 改造**：把注入块改为"签名化"可选，新增 `buildStudioSystemPrompt(custom, { inject })`：

   ```ts
   export type StudioPromptInjection =
     | { kind: 'mcp-usage' }
     | { kind: 'output-format'; lang: 'zh' | 'en' }
     | { kind: 'workflow-node' }

   // 默认仍全开，保持向后兼容；但允许显式传入空数组 → bare
   export function buildStudioSystemPrompt(
     customPrompt?: string,
     options?: { source?: string | null; inject?: StudioPromptInjection[] },
   ): string
   ```
   保留 `getSystemPrompt(...)` 作为薄封装（默认 inject 全开），不破坏现有调用但新增可控入口。

2. **去重（关键）**：主聊天只允许**一处**组装 system prompt：
   - 删除 `run-chat/handle-bridge-run.ts:338-340` 对已前缀 `instructions` 的二次 `getSystemPrompt`；
     改为：若 `instructions` 已含 system prompt（由 index.ts 传入），handleBridgeRun **只追加** `runPrompt`
     且用幂等标志（如 `alreadyIncludesSystemPrompt`）去重。
   - `handle-bridge-run.ts:364-367` 的 `runPrompt`（X-Hermes-Profile 引导）改为并入注入块，且仅注入一次。
   - `run-chat/index.ts:465-467`、`:612` 统一走 `buildStudioSystemPrompt(undefined, { source, inject })`。

3. **Profile/配置级覆盖**：新增配置项（存于 profile 配置或 Web UI setting）：
   - `studioPromptInjection: 'default' | 'bare' | 'custom'`
     - `default`：全开（现状，向后兼容）
     - `bare`：`inject: []`，只输出用户自定 system prompt（无 MCP 引导/输出格式/工作流块）
     - `custom`：按用户勾选的块集合
   - `customPrompt`：用户自定 system prompt（现有 `instructions` 机制保留）。

4. **审计**：在 `run.started` / `run.reattach` 事件中附带 `systemPromptBlocks: string[]` 与
   `systemPromptSha256`，前端可展示"本次 System Prompt 由哪些块组成"。

5. **前端**（本达成本文档仅原则，落地时同步）：设置 → 模型/人格，新增
   "System Prompt 注入"选项；所有新增 UI 字符串须同步至全部 locale 文件（AGENTS.md 硬规则）。

### C. download 修复（P0）

在 `routes/hermes/download.ts` 增加根目录边界校验，并升级为 super-admin：

```ts
import { requireSuperAdmin } from '../../middleware/user-auth'
import { isPathWithin } from '../../services/hermes/hermes-path'
import { getProfileDir } from '../../services/hermes/hermes-profile'
import { config } from '../../config'

// 校验在允许根内
function assertWithinAllowedRoots(abs: string, profile: string): void {
  const roots = [getProfileDir(profile), config.uploadDir].map(normalize)
  const ok = roots.some(root => isPathWithin(normalize(abs), normalize(root)))
  if (!ok) {
    const err: any = new Error('Access denied')
    err.status = 403; err.code = 'permission_denied'
    throw err
  }
}
```
- `validPath = isAbsolute ? validatePath(filePath) : resolveHermesPath(filePath, profile)`
- 在读取前调用 `assertWithinAllowedRoots(validPath, profile)`
- 路由挂 `requireSuperAdmin`（与 `files/read` 对齐）。

### D. media 修复（P0）

新增统一边界断言（复用 `isPathWithin` + `config.appHome`）：

```ts
function assertWithinHouseRoot(p: string): string {
  const abs = resolve(p)
  if (!isPathWithin(normalize(abs), config.appHome)) {
    const err: any = new Error('Access denied'); err.status = 403; err.code = 'permission_denied'; throw err
  }
  return abs
}
```
- 读：`imagePathToDataUri` / `normalizeImageFile` 中，`image_path` 解析后（不论绝对/相对）经
  `assertWithinHouseRoot` 再 `readFileSync`。
- 写：`output_path`（`saveGeneratedImages`、`grokImageToVideo::downloadVideo`）同样经
  `assertWithinHouseRoot`，并强制扩展名白名单（`.png/.jpg/.jpeg/.webp/.mp4/.mov`）。
- 路由升级：`routes/hermes/media.ts` 挂 `requireSuperAdmin`（或至少对含文件读写语义的接口启用）。

### E. upload 修复（P0）

在 `controllers/upload.ts` 先剥离路径再拼接，并做包含性兜底：

```ts
import { basename, join } from 'path'
import { isPathWithin } from '../services/hermes/hermes-path'

const safeName = basename(String(filename).replace(/\0/g, '').replace(/\\/g, '/'))
const ext = /(?:\.[a-z0-9]{1,16})$/i.test(safeName) ? safeName.slice(safeName.lastIndexOf('.')) : ''
const savedPath = join(uploadDir, randomBytes(8).toString('hex') + ext)
if (!isPathWithin(savedPath, uploadDir)) { ctx.status = 400; ctx.body = { error: 'Invalid upload' }; return }
```
同时在 `lib/multipart.ts` 的 `parseMultipartFilename` 返回处保持原样（解析语义不变），
清洗逻辑收敛于 `controllers/upload.ts`（写路径唯一入口）。

### F. 权限（配套）

将 `download` / `media`（含文件读/写语义）路由升级为 `requireSuperAdmin`，与 `files.ts` 对齐；
upload 保留在登录层（路径已由 E 修复则可保留，若仍担心提权面可一并升级）。

### 其他（本次评估，不在本次改动范围，列为后续）
- `§5.4` symlink 逃逸（`isNearestExistingRealPathWithin` 复用 group-chat 已有实现，单独 PR）。
- B（Ekko）确认 runtimeInstructions 是否可关，单独 PR。
- 中低优先级（§3/§6/§7）按 deep-review 另立任务。

---

## 3. 测试计划

在 `tests/server/` 下补/扩展单测（路径已在 v0.6.30 存在的同名测试文件）：

1. **download** → `tests/server/files-routes.test.ts` 或新增 `download-routes.test.ts`
   - 绝对路径读宿主任意文件 → 403
   - `..\` / 盘符 / URL 编码 `%2e%2e%2f` / symlink → 403
   - 相对路径在 profile 根内 → 正常下载
   - 未登录 → 401；非 super-admin 登录 → 403
2. **media** → `tests/server/media-controller.test.ts`
   - `image_path` 指向 appHome 外 → 403
   - `output_path` 指向 appHome 外 / 非法扩展名 → 403
   - 合法 appHome 内路径 → 正常
3. **upload** → `tests/server/upload-controller.test.ts`
   - `filename="x.xxx/../../../foo"` / `..\foo` / 空字节 → 400 且不越界写入
   - 正常文件名 → 落在 uploadDir，随机原名
4. **prompt 注入** → `tests/server/llm-prompt.test.ts`（已有）扩展；新增 `run-chat` 去重用例
   - `buildStudioSystemPrompt(undefined, { inject: [] })` → 不含 MCP 引导 / 格式规范
   - 自定义 inject 子集 → 仅含对应块
   - 断言主聊天组装结果中 `HERMES_MCP_USAGE_GUIDELINES` **仅出现一次**

落地每项后执行：`npm run harness:check`、`npm run test`、`npm run build`。

---

## 4. 落地顺序建议

1. **E（upload）**：改动小、风险低，先落地 + 单测。
2. **C（download）**：根边界 + super-admin + 单测。
3. **D（media）**：根边界 + 扩展名白名单 + 单测。
4. **A（prompt 注入）**：去重（最影响言行，优先）→ 分层可配 → 审计。去重可先行，UI 开关后续。
5. **F（权限）**：随 C/D 同步收紧。

每项独立成提交（不混入无关重构），并另起小步安全上线（P0 补丁优先）。
