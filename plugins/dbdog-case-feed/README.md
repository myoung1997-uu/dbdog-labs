# dbdog-case-feed · 给 dbdog 供题

把**筛出来的、用来考验 dbdog 系统能力的用例**（复现脚本 + manifest）推给 dbdog 用例平台。
装上就不用管：首次开会话自动开户并把材料包取回本地，之后**每轮结束自动推**发件箱里的批次；
推失败会把平台的错误清单回灌给 agent 让它自己修。

> **默认没有——要装（两条命令）**。装完的唯一前提是：**知道你要连哪套平台的地址**。

## 前提

| 组件 | 验证命令 |
|------|---------|
| Claude Code | `claude --version` |
| node ≥ 18 | `node --version` |

## 安装

```sh
claude plugin marketplace add zlxtqbdgdgd/dbdog-labs
claude plugin install dbdog-case-feed@dbdog-labs
claude plugin list                                  # 应看到 dbdog-case-feed@dbdog-labs
```

启用时会问一次**用例平台地址**（见下）。hooks 在**下一个会话**生效。

### 不是 Claude Code？（Cursor / codex / 裸机）

推送逻辑三边**共用同一份代码**，差别只在"什么时候触发"：

| 你的 agent | 装法 | 每轮自动推 | 自动开户+取材料包 |
|---|---|---|---|
| Claude Code | 上面两条命令 | ✅（`Stop` 钩子） | ✅（`SessionStart`） |
| Cursor（本机 CLI） | `cursor-agent-hooks/install.sh`（文件安装，不走 Marketplace 插件） | ✅（`stop` 事件） | ❌ 自己跑一次 `node install.mjs --kind cursor` |
| codex / 裸机 / 其它 | `node install.mjs --server <地址> --kind codex` | ❌ 自己每轮结束跑一次 `<落地目录>/tc-push.sh --outbox <项目>/.dbdog-outbox` | ❌ 同一个命令里做了 |

```sh
# 通用安装器：开户 + 取材料包 + 落地 + 告诉你接下来怎么用
node plugins/dbdog-case-feed/install.mjs --server http://10.0.0.5:18888 --kind codex
```



## 配置：只有一个值——平台地址

**内网、外网是两套独立部署**：不同机器、不同端口、各有各的库和凭证。
所以地址**没有默认值**，必须你给——填错不会报错，只会把用例推到另一个平台。

| 怎么给 | 用法 |
|--------|------|
| 插件配置（推荐） | 启用插件时弹出的「用例平台地址」 |
| 环境变量（脚本化 / 覆盖） | `DBDOG_CASE_FEED_URL=http://10.0.0.5:18888` —— **优先级更高**，会盖过插件里填的 |

填**一个完整地址**（带端口），形如 `http://10.0.0.5:18888` 或 `http://<域名>:23234`。
端口别单独填——地址里带着它，少一个填错的机会。

其余可选变量（一般用不上）：

| 变量 | 作用 |
|------|------|
| `DBDOG_CASE_FEED_TOKEN` | **已有凭证**时直接给它，跳过自动开户——已经接好的机器别重开号 |
| `DBDOG_CASE_FEED_AGENT` | 覆盖身份名（默认 `<类别>-<机器名>`，如 `claude-mac`） |
| `DBDOG_CASE_FEED_TIMEOUT_MS` | 请求超时，默认 15000。链路挂隧道/代理时放宽 |

## 装完会发生什么

1. **第一次开会话**：自动 `POST /api/push-agents` 开一个身份（拿推送凭证），再把材料包
   （规范 + 推用例的脚本）取回本地。失败**不阻断会话**，只在 stderr 说一句人话，并且
   10 分钟内不再重试（免得平台挂着时每次开会话都卡一次超时）。
2. **之后每轮结束**：把项目下 `.dbdog-outbox/` 里的批次推出去。推成功批次移进 `sent/`；
   推失败把平台的错误清单**回灌给 agent**，它修完下一轮自动重推。

## 东西放在哪

| 东西 | 位置 |
|------|------|
| 材料包（规范 + `tc-push.sh` + 凭证配置） | `${CLAUDE_PLUGIN_DATA}/kit/`（没这个变量时 `~/.claude/dbdog-case-feed/kit/`） |
| 发件箱 | `<你的项目>/.dbdog-outbox/<批次>/`（推成功的进 `sent/`） |

材料**不随插件分发**——用的时候现从平台取最新一份。所以平台改规矩，你不用等插件发新版。

## 排查

| 症状 | 先看什么 |
|------|---------|
| 什么都没推 | 会话里跑 `cat "$CLAUDE_PLUGIN_DATA/kit/push-config.json"` 看连的是哪套；地址不对就改 `DBDOG_CASE_FEED_URL` 并删掉 `kit/` 让它重新自举 |
| 提示"连不上 <地址>" | 地址给错、或那台机器到不了那个地址（内网地址在外网机上不可达，反之亦然） |
| 一直推不动 | 确认你要连的那套平台**已经放行了推送接口**（内网/外网各自都要放行一次） |

## 与 `dbdog-agent-obs` 的关系

两个插件互不依赖，可以只装一个：

- `dbdog-agent-obs`：把**诊断过程**采成 trace，给 dbdog 的可观测性用。
- `dbdog-case-feed`（本插件）：把**筛出来的用例**推给用例平台，给 dbdog 供题。
