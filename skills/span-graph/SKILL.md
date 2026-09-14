---
name: span-graph
description: 从 dbdog hook 的明确调查记录生成假设视图与调查步骤，或恢复进行中的阶段状态；支持 spans.jsonl、server 导出与历史 intent 记录。保持追问关系、因果关系和引用检查的语义边界，不重新诊断或猜测缺失关联。
---

# 从记录还原调查

本能力负责重建与交付视图。调查推进由当前引擎的托管 investigate skill 定义，事件格式由 当前引擎的 `dbdog/dbm-<engine>/investigation-recording` 定义；本 skill 不另立假设协议、不宣布根因。

## 选择记录

用户给定 trace、session 或文件时使用该范围。输入支持 `spans.jsonl`、包含它的目录，以及 server 导出的 span JSON。整库日志包含多个调查时先确认目标，不能把不同 trace 拼成一棵树。

安装插件后，SessionEnd 会生成 `<DBDOG_OBS_DIR>/graphs/<trace_id>/forward-path.md`；未设置目录时使用 `~/.claude/dbdog-obs/`。已有产物可直接读取，但需对照其覆盖时间，不能把上次产物当成最新状态。

进行中的长调查或上下文丢失时，用 hook 提供的真实 session/transcript 路径调用 `claude-code-hooks/recover-investigation.mjs`。它读取已持久化 span 与主 transcript 未处理尾部，不推进 hook 游标、不查询数据库、不上报网络。返回最新阶段结果、假设状态、记录缺口和产物路径；尚未落盘的子代理尾部可能不完整，应保留这项覆盖限制。

## 构建与交付

本 skill 的脚本目录记为 `S`；通过现有入口执行：

```bash
node S/from_spans.mjs 路径/spans.jsonl --trace 实际trace_id --out 输出目录
```

输出 `forward-path.json` / `forward-path.md` 及实际最终回答 `forward-conclusion.md`。显式事件记录另生成：

- `hypothesis-view.json`：调查问题根、假设内容/状态/判定摘要/关键证据入口、明确追问边、单独的因果/条件关系、最终答案引用。
- `investigation-steps.json`：检查目的与目标、结果及引用、对假设的影响、状态变化、阶段交付和结束事件。

两份视图来自同一事件模型。交付时指出记录的覆盖范围、未解问题及结构/引用缺口；不要以树更深、节点更多或没有 diagnostics 作为诊断成功的证据。

## 呈现边界

主树中只有问题和可检验解释；检查、原始结果、解释与缺口放在可展开详情。追问父子边不代表已证明因果，兄弟不默认互斥。共享节点可从多个父方向引用，仍共用身份、状态和证据；不能为了单父布局删掉关系。

不从编号、自由文本 intent、调用顺序、agent 嵌套或因果 explains 边补造追问边。缺失关联显示为未关联节点；被反驳或修订的节点和原文记录保留。模型声明与 reference_check、assessment_current 分开显示，引用匹配不等于归因正确。

具体 schema 不在此重复；读取 `references/hypothesis-format.md` 了解协议入口与历史兼容边界。实现由插件 `claude-code-hooks/investigation-events.mjs`、`investigation-views.mjs` 与 `hypothesis-graph.mjs` 共同提供；不另写一个自由文本推断器。
