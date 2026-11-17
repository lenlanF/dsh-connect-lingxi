# DSH Connect Lingxi

## 0.5.9：输入框模型选择旁的灵犀智点余额（2026-11-17）

- 参考 WorkBuddy 的 `conversation.input.right`（模型选择器前、按 provider 限制渲染）和 `modelSelection` 投影，实现 **“✦ 灵犀 N 智点”**。只在当前会话选择 `lingxi` 时显示；选择 WorkBuddy/其他提供商时自动隐藏，不干扰原模型倍率徽标。
- 新增仅本机环回可访问的 `GET /plugins/dsh-connect-lingxi/credits`，以及用户点击刷新时才调用的 `POST /plugins/dsh-connect-lingxi/credits/refresh`。前者使用已有余额缓存，后者强制重读上游余额。普通显示每五分钟自动轮询，实际缓存周期仍尊重用户设置。
- 余额读取复用真实 `credit_type=total` 接口，经现有 `pool` 账号选择规则确定当前使用账号；只显示该账号剩余智点，不把不同账号余额相加，也不把模型倍率或促销标识当成余额。未知余额显示 `—`，合法零余额显示 `0`。
- 点击余额徽标可查看脱敏的多账号余额明细，标记当前使用账号并手动刷新。返回内容不包含 `wps_sid`、账号 ID、Cookie、逐笔授权数据及诊断路径。新增组件与接口自动化测试，真实本机余额接口读取得到有效数字（不在日志/文档写具体值）。
- 本版本源码、离线测试及上游只读验收完成后，仍需用户在 DSH Desktop 安装 0.5.9 并目视确认本机插槽显示效果。不会热修改正在使用的 0.5.8。

## 0.5.8：DSH 工具声明同步与可用能力发现（2026-11-17）
- **根因方向已核实：** DSH Desktop 已安装源代码 `@deepseek-ai/dsh-llm/src/content.ts` 的 `projectToolUpdates()` 在 `toolUpdate` 缺失时，会发送即时可用的完整工具定义并过滤不支持的 developer 工具更新；此前本插件声明 `addition-only`，却没有消费 `tool-addition` 历史内容。新版本取消不实声明，采用 DSH 官方即时声明路径。
- DSH 的 `dsh-tool-todo` 确实注册 `todo_write`，桌面 Profile 的 `tool-todo` 配置已启用；**尚没有失败当轮原始工具快照**，因此不能断言工具在哪一层丢失或此改动能百分百消除该问题。
- 仅对本轮实际收到的工具提供原生 JSON Schema。缺少可选计划工具时允许文本规划，不阻塞主任务；如任务确实需要新能力，模型只可通过本轮已提供的 `plugin_market` 搜索、`plugin_manager` 查看已安装插件。新增安装/启用必须先由用户明确授权；插件本身不会搜索外部仓库、下载、安装或改变权限。
- 无效的未知工具调用仍由适配器拒绝，并在安全续跑中向模型返回当前允许的工具；仅在遇到未知工具时记录受限诊断（工具名、当轮数量、todo/market/manager 是否可用），绝不记录工具参数、账号凭据、聊天内容。
- 本地新增工具清单跨轮变化、原生有效 `todo_write`、发现能力限制、诊断脱敏测试。真实 Lingxi API 已返回结构正确的 DSH `run_code` 请求（没有本机执行）。**发布不代表已通过完整 DSH Agent 开发任务验收**。

DSH Desktop provider adapter for WPS Lingxi (local 0.5.0 source snapshot).

## Features
- Model catalog and WPS Lingxi cowork streaming provider integration.
- DSH-native tool-call blocks from host-visible tool schemas and model tool-call envelopes.
- Permission and command execution remain the responsibility of DSH host.
- Structured tool results are forwarded into the next conversation turn.
- Error finishes always return a nonempty `failure.code`; no cloud sandbox action is treated as an authorized local execution.

## Tests
Run `npm test` for offline tests. `npm run test:machine` performs environment-dependent credential/SQLite tests and may require WPS installation, login and a supported Node.js version.

## Security
See [SECURITY.md](SECURITY.md). Local sessions, logs, archives, evidence and user-specific paths are intentionally excluded.

## Note
WPS upstream behavior varies; tool-call compatibility is verified with offline fixtures. Production DSH permission approval and execution must be validated separately.

---

## 中文说明

**工具参数校验补丁（2026-11-16）**：提交 DSH 工具调用之前，校验 JSON Schema 的必填字段、类型、枚举及嵌套属性；对漏填的参数提供至多 3 轮模型纠错机会，持续失败则安全拒绝。工具结果的错误状态会明确标记，避免将失败误报为成功。

**DSH Connect Lingxi** 是将 WPS 灵犀接入 DeepSeek Harness Desktop 的社区插件（v0.5.9）。提供流式模型调用、账号池、余额信息和 DSH 工具协议桥接。非 WPS 或 DeepSeek 官方项目。

### 核心功能

- 从 WPS 灵犀本机登录态读取可用会话，访问 cowork WebSocket 和模型目录。
- 支持宿主传入的工具 schema，解析 `<dsh_tool>…</dsh_tool>` 与完整 `{"type":"tool-call",…}` JSON。
- 校验工具名称与 JSON 参数，生成 DSH 原生 `tool-call-delta` 及工具结果回传；**工具执行及权限审批完全由 DSH 宿主负责**。
- 对凭据、限流、网络、上游及工具协议异常返回明确的非空 `failure.code`。

### 使用与测试

```bash
# 在 GitHub 仓库页面点击 Code → HTTPS 获取并复制克隆地址
git clone REPOSITORY_HTTPS_URL
cd dsh-connect-lingxi
npm test
```

净化版离线测试 **离线测试通过（发布副本）**。另有 `npm run test:machine` 测试依赖真实 WPS 本机会话与 SQLite；运行可能受登录状态及数据库锁影响。需要兼容的 DSH Desktop，插件入口为 `src/index.mjs`，管理页面 `client.js`。

### 安全限制

插件不会直接执行本机 Bash、PowerShell 或代码，不会绕过宿主审批。WPS 上游可能使用独立云端沙箱，本插件无法控制其内部行为；真实宿主工具授权与上游兼容性仍需实机验证。仓库只包含脱敏源码，无 Cookie、`wps_sid`、个人资料、抓取日志和备份；参见 [SECURITY.md](SECURITY.md)。

**许可：** 本仓库暂未声明开源许可证，公开可读不代表自动授予复制、再发布及商用许可。

## 运行时工具可用性修复（2026-11-16）

真实 DSH 主机返回“工具run_code不存在”后，插件不会换用其他语法重复请求该名称，而是从当前会话工具候选中排除失效项；若仍有主机实际开放的其他工具，可按其原始名称和参数调用。工具不存在的失败返回被明确标记，不会误报成功；用户与模型文本中的同名语句不会触发工具撤销。

**注意：** 此修复只针对插件内可见清单及工具回传行为，不注册、安装或恢复 DSH 主机工具。是否能实际执行取决于 DSH Host 当前授权与已注册工具。

### 工具标记格式恢复（2026-11-16）

当灵犀响应出现不完整或重复的工具标记时，插件先拒绝无效调用，再在不触发任何宿主命令的情况下进行最多 3 轮模型修正；优先使用完整的 JSON 工具调用封装，不再要求模型复制含非法占位符的 XML 示例。Markdown 代码示例中的标记不被当成可执行工具调用。真实 DSH 工具权限及执行仍完全由宿主控制。

### DSH 原生工具结果兼容（0.5.5）

与 DSH Desktop 实际的工具消息结构对齐：宿主工具结果采用 role:tool，并通过消息级 isError 标识失败；现在灵犀会显式展示 status=FAILED / status=SUCCESS 与 toolCallId，并仅依据真正的宿主失败结果识别不存在的工具。PTC 模式下 run_code 是唯一直接执行入口；bash 等子工具应由 run_code 内部调用，不能作为独立的 PTC 顶层请求。安装包升级需要在 DSH Desktop 中手动操作，此补丁不会修改现有会话或账号配置。

### 0.5.6：灵犀原生工具调用通道

当 DSH 本轮提供可用工具 Schema 时，插件优先使用灵犀 agent-runtime 的原生 HTTP/SSE tool_calls 接口，将受控的工具请求交回 DSH 宿主执行，替代此前 Cowork 文本提示生成 JSON 标记的脆弱桥接。没有宿主工具的普通对话继续走 Cowork。原生通道采用会话、run、completion 三步请求；只在会话建立阶段尝试两个灵犀服务域名，不重复提交可能产生费用的 completion。所有工具名与参数仍按照 DSH 本轮授权 Schema 校验，未知调用和云端沙箱结果不能替代宿主授权执行。

协议实现独立编写，开发时参考公开的社区项目 [xinstart-1/dsh-connect-lingxi](https://github.com/xinstart-1/dsh-connect-lingxi) 中的原生接口规格说明；该仓库采用 MIT 许可证。本版本的离线测试会覆盖 SSE 分片、工具 Schema、历史工具结果、错误及回退域名。真正的 DSH 工具执行与权限批准仍由 DSH 决定。

## 0.5.7 Native unavailable-tool recovery (2026-11-17)

DSH may expose fewer tools in an individual model turn than its overall UI tool inventory. In 0.5.6, Lingxi sometimes requested an unoffered planning tool such as todo_write; the bridge correctly rejected it but treated it as a terminal protocol error.

0.5.7 maintains the same strict host-tool boundary: unoffered tool names and invalid argument schemas are never dispatched to DSH. For a repairable native request, the adapter sends the validation failure and current-turn tool inventory to the next native API attempt. After three attempts, it fails closed. Mixed batches with valid and invalid names are rejected atomically.

Offline regression tests cover todo_write rejection, successful recovery to an offered run_code, repeated failures, and mixed-batch atomicity. Live Lingxi native API protocol was verified without executing local tools. Full DSH host task recovery requires a user-installed smoke test.
