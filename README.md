# dbdog-labs · 客户端分发仓

dbdog 面向**最终用户**的客户端组件固定分发点。用户不需要任何 dbdog 私有仓库——本仓公开、
位置稳定，文档与安装命令永远指这里。当前内容：**Claude Code Agent Observability hooks**
（`claude-code-hooks/`，研发说明见其中 README）。

> **默认没有——要装（插件，两条命令）**。装完后：普通消息零足迹；以「诊断:」/「diag:」开头的
> 消息自动记录成可检查的 trace 树（配 `DBDOG_OBS_MODE=always` 则全量记录）。完整用户文档见
> dbdog 控制台 **/docs/llmobs 第三部分（接入与命令参考）**。

## 前提

| 组件 | 验证命令 |
|------|---------|
| Claude Code | `claude --version` |
| node ≥ 18 | `node --version` |
| 已连接 dbdog-mcp | `claude mcp list`（没有就 `claude mcp add --transport http dbdog-mcp http://<mcp地址>/mcp`） |

## 安装（插件，2026-07-14 起唯一推荐方式）

```sh
claude plugin marketplace add zlxtqbdgdgd/dbdog-labs
claude plugin install dbdog-agent-obs@dbdog-labs        # 或会话里 /plugin install dbdog-agent-obs@dbdog-labs
claude plugin list                                  # 应看到 dbdog-agent-obs@dbdog-labs
```

hooks 路径由插件机制（`${CLAUDE_PLUGIN_ROOT}`）自动解析，不改任何文件；升级随 marketplace
自动更新；hooks 在**下一个会话**生效。无插件环境或研发调试需要手动接线时，clone 本仓后按
`claude-code-hooks/README.md` 操作（settings-snippet 合并法，历史方式，不再出现在用户文档）。

## 配置（环境变量）

| 变量 | 作用 | 必须？ |
|------|------|--------|
| `DBDOG_OBS_REPORT_URL` | 上报口：`http://<mcp地址>/api/v2/llmobs/spans` | 想在控制台看树就必须 |
| `DBDOG_OBS_API_KEY` | 个人 key（控制台 settings → api-keys 签发，`dbdog_` 前缀，只显示一次） | 同上 |
| `DBDOG_OBS_MODE` | `triggered`（默认，「诊断:」触发）/ `always`（全记）/ `off` | 否 |
| `DBDOG_OBS_ML_APP` | trace 分桶名，缺省 = 目录名 | 否 |
| `DBDOG_OBS_REPORT_TIMEOUT_MS` | 上报超时，默认 3000。**机器挂透明代理/隧道时放宽到 10000–15000**——那类链路首字节 1–4s 抖动，卡在 3s 上会表现成「本地 spans.jsonl 有、控制台空」 | 否 |

前两个放进个人 `~/.claude/settings.json` 的 `env` 块（个人文件，不进 git）：

```json
{ "env": { "DBDOG_OBS_REPORT_URL": "http://<mcp地址>/api/v2/llmobs/spans", "DBDOG_OBS_API_KEY": "dbdog_xxxxxxxx" } }
```

某个目录要全量记录：该目录 `.claude/settings.json` 加 `{ "env": { "DBDOG_OBS_MODE": "always" } }`。

## 验证（端到端）

**开新会话** → 问题以「诊断:」开头正常提问 → 别中途打断 → 控制台
LLM Observability · Traces 刷新，应看到完整的树（根 🌳 + 推理 🧠 + 工具 🔧）。
排查见控制台 /docs/llmobs（第三部分与附录）或 `claude-code-hooks/README.md`。

## 仓库结构

```
.claude-plugin/     marketplace.json + plugin.json（插件安装通道）
hooks/hooks.json    插件 hooks 定义（${CLAUDE_PLUGIN_ROOT} 引用脚本）
claude-code-hooks/  脚本本体 + 研发 README（含手动接线的历史方式与自检命令）
skills/span-graph/     span-graph skill：hook span → 假设图 markdown（零模型），入口 scripts/from_spans.mjs（实现在 claude-code-hooks/hypothesis-graph.mjs，SessionEnd 自动出图同一实现）
skills/evidence-chain/ evidence-chain skill：现象 + 根因 + 修复 diff + 源码树 → 应有证据链与 dbdog 工具缺口 markdown，入口 scripts/run.py（调 claude -p）
skills/diag-flywheel/  diag-flywheel skill：诊断飞轮客户端脚本（沉淀用例 / 探针 / 判题包导出回流 / 重测对比 / 训练语料），scripts/ 是 dbdog-mcp scripts/llmobs 的镜像
skills/diag-run/       diag-run skill：口令「dbdog test loop N」，领待诊断的复现跑盲诊断（第二棒）
skills/judge-run/      judge-run skill：领待判题的诊断，按 diag-judge 判完回流（第三棒；`/loop 30m /judge-run`）
skills/diag-judge/     diag-judge skill：单次判题——根因命中、证据、当前问题；class 与 tool/skill/case 两轴独立；正文和 references/output.md 分别定义方法与输出
skills/fix-run/        fix-run skill：修一道题挖出的问题（第四棒）——bug 类自动修、部署、原窗口复测后打标记（复测通过即关），要人定的逐条拍板；不自己触发重跑
skills/diag-compare/   diag-compare skill：正反两份产物对比 → 六类结论(无工具/应有结果但没有/结果不对/假设没提到/工具没调或调错/调对了但推理错)+ dbdog 改进清单,批次跨单号聚合 improvements.md
```

母版历史：2026-07-14 从 dbdog-mcp `clients/claude-code-hooks/` 迁入并固定于此。
