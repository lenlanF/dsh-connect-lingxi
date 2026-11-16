# DSH Connect Lingxi

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

**DSH Connect Lingxi** 是将 WPS 灵犀接入 DeepSeek Harness Desktop 的社区插件（v0.5.0）。提供流式模型调用、账号池、余额信息和 DSH 工具协议桥接。非 WPS 或 DeepSeek 官方项目。

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

净化版离线测试 **89/89 通过**。另有 `npm run test:machine` 测试依赖真实 WPS 本机会话与 SQLite；运行可能受登录状态及数据库锁影响。需要兼容的 DSH Desktop，插件入口为 `src/index.mjs`，管理页面 `client.js`。

### 安全限制

插件不会直接执行本机 Bash、PowerShell 或代码，不会绕过宿主审批。WPS 上游可能使用独立云端沙箱，本插件无法控制其内部行为；真实宿主工具授权与上游兼容性仍需实机验证。仓库只包含脱敏源码，无 Cookie、`wps_sid`、个人资料、抓取日志和备份；参见 [SECURITY.md](SECURITY.md)。

**许可：** 本仓库暂未声明开源许可证，公开可读不代表自动授予复制、再发布及商用许可。

## 运行时工具可用性修复（2026-11-16）

真实 DSH 主机返回“工具run_code不存在”后，插件不会换用其他语法重复请求该名称，而是从当前会话工具候选中排除失效项；若仍有主机实际开放的其他工具，可按其原始名称和参数调用。工具不存在的失败返回被明确标记，不会误报成功；用户与模型文本中的同名语句不会触发工具撤销。

**注意：** 此修复只针对插件内可见清单及工具回传行为，不注册、安装或恢复 DSH 主机工具。是否能实际执行取决于 DSH Host 当前授权与已注册工具。

### 工具标记格式恢复（2026-11-16）

当灵犀响应出现不完整或重复的工具标记时，插件先拒绝无效调用，再在不触发任何宿主命令的情况下进行最多 3 轮模型修正；优先使用完整的 JSON 工具调用封装，不再要求模型复制含非法占位符的 XML 示例。Markdown 代码示例中的标记不被当成可执行工具调用。真实 DSH 工具权限及执行仍完全由宿主控制。
