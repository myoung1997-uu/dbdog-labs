# Cursor Agent Observability hooks

把 Cursor **本机 CLI Agent** 接到 dbdog LLM Observability：以「诊断:」/「diag:」开头的一轮 = 一棵完整 trace 树（root + llm + **tool 全链：intent / input / output**），含 Task/subagent。

设计说明：`../docs/superpowers/specs/2026-08-04-cursor-agent-hooks-design.md`  
对照实现：`../claude-code-hooks/`（Claude Code；本目录为 Cursor 原生事件适配，不复用 Claude transcript 合成）。

## 前提

| 组件 | 验证 |
|------|------|
| Cursor CLI Agent | 能跑 `agent` / 本机 agent 会话 |
| node ≥ 18 | `node --version` |
| jq（仅安装脚本） | `jq --version` |
| 已配置 dbdog MCP | Cursor 里能调 dbdog 工具 |

## 安装（推荐）

```sh
cd /path/to/dbdog-labs/cursor-agent-hooks
./install.sh
# 默认合并进 ~/.cursor/hooks.json（会先备份）
```

配上报（与 Claude kit 相同；不配则只写本地 JSONL）：

```sh
export DBDOG_OBS_REPORT_URL='http://<mcp地址>/api/v2/llmobs/spans'
export DBDOG_OBS_API_KEY='dbdog_xxxxxxxx'
```

也可写进启动 agent 的环境。项目级安装：把渲染后的 `hooks.json` 放到某仓 `.cursor/hooks.json`（须含 `"version": 1`）。

**不要**依赖 Cursor Marketplace 插件装 hooks——本机 CLI 对插件 hooks 不可靠；用文件安装。

## 用法

新开一轮 CLI agent，然后：

```
诊断: 最近 30 分钟数据库整体正常吗？
```

普通消息零足迹。全量记录：`DBDOG_OBS_MODE=always`。关闭：`off`。

## 验收

1. 跑完一轮诊断（尽量让 agent 调 dbdog MCP；可含 Task/subagent）
2. 控制台 **LLM Observability · Traces** 应有一棵树；每条 tool 含 intent/input/output
3. 本地：`~/.cursor/dbdog-obs/<conversation_id>.json` 与 `spans.jsonl`

自检（不依赖 Cursor）：

```sh
node --test hooks.test.mjs
```

## 事件分工

| Cursor 事件 | 脚本 | 作用 |
|-------------|------|------|
| `beforeSubmitPrompt` | `before-submit-prompt.mjs` | 铸号 / 触发门 |
| `preToolUse` (`^MCP:`) | `pre-tool-use.mjs` | 注入 telemetry |
| `afterMCPExecution` | `after-mcp-execution.mjs` | tool span（成功） |
| `postToolUseFailure` | `post-tool-use-failure.mjs` | tool span（失败） |
| `afterAgentResponse` / `afterAgentThought` | 对应脚本 | llm span |
| `stop` | `stop.mjs` + `../claude-code-hooks/case-feed/push.mjs` | root agent span；另推发件箱里的用例（可选能力，见文末） |
| `subagentStart` / `subagentStop` | 对应脚本 | 子代理共用同一 trace |

## 环境变量

| 变量 | 作用 |
|------|------|
| `DBDOG_OBS_REPORT_URL` | `http://<mcp>/api/v2/llmobs/spans` |
| `DBDOG_OBS_API_KEY` | 控制台签发的 `dbdog_` key |
| `DBDOG_OBS_MODE` | `triggered`（默认）/ `always` / `off` |
| `DBDOG_OBS_TRIGGER` | 默认 `诊断:`（全半角冒号都认；`diag:` 恒收） |
| `DBDOG_OBS_ML_APP` | 分桶名；缺省 = workspace 目录名 |
| `DBDOG_OBS_DIR` / `DBDOG_OBS_SPANS` | 状态与 spans 路径 |

## 可选能力：给 dbdog 供题（`case-feed`）

上面那些都是**可观测性**（把诊断过程采成 trace）。这一条是另一个能力：把筛出来的用例推给**用例平台**。
**默认关着** —— 什么都不配就零行为（`push.mjs` 见发件箱空就直接返回，不发任何请求）。

```sh
export DBDOG_CASE_FEED_URL='http://<用例平台地址>:<端口>'    # 内网/外网两套独立部署，填你该连的那套
export DBDOG_CASE_FEED_DATA=~/.cursor/dbdog-case-feed       # 材料包与凭证放哪（不设会落到 ~/.claude/ 下）
node "../claude-code-hooks/case-feed/bootstrap.mjs"         # 手动跑一次：开户 + 取材料包
```

**为什么要手动跑那一次**：Claude Code 侧有 `SessionStart` 钩子替它做这件事，Cursor 这边没有对应的自举钩子。
不跑也能用 —— 等真有批次要推时 `push.mjs` 会提示材料包没就绪，那时再跑即可。

之后每轮结束（`stop`）会把 `<项目>/.dbdog-outbox/<批次>/` 里的用例推出去。

⚠️ **Cursor 侧不保证把钩子的输出喂回模型**，所以"推失败"的表现是**批次留在发件箱**
（成功的会被移进 `sent/`），而不是模型被告知。要确认推没推成功，看那个目录还在不在。

## 与 Claude kit 的差异（读侧须知）

- root `name` = `cursor-agent.task`（Claude 为 `claude-code.task`）
- llm token 字段在 Cursor 侧通常为 null
- tool 名来自 `MCP:<tool>`，不写 Claude 的 `mcp__server__tool`
- 状态目录默认 `~/.cursor/dbdog-obs`（Claude 为 `~/.claude/dbdog-obs`）
