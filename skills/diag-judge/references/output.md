# 单次判题输出契约

一条 trace 一行 JSON，写到包根 `annotations.jsonl`。同 trace 重判替换该行，不追加重复行。
同时写 `summary.md`。一个包有多条 trace 时分别评价，摘要按完整 trace_id 分段，互不引用判题结论。

## 顶层

`{"trace_id":"<完整 trace_id>","labels":{"verdict":"…","evidence":"…","findings":{…},"summary":"…"}}`

这是结构模板，不是真实判题示例。四个 label 都填写；`summary` 不超过 600 字符。
`finding_kinds`、`finding_types`、`fix_marks`、`rubric_version` 由外部脚本维护，判官不填写。

## 根因与证据

- `verdict` 是预期根因覆盖：`correct` 全命中，`partial` 部分命中，`wrong` 全未命中。
- `unknown`：无答案纸，或材料不足/答案纸争议导致不能可靠划分根因；必须在 `limitations` 说明原因。
- `not_reproduced`：有证据证明诊断窗口内现场不成立，在 `rationale` 说明依据。
- `evidence`：`solid` / `weak` / `unknown`；`unknown` 必须说明缺什么。缺少证据与无法检查按正文区分。

## findings

| 字段 | 内容 |
|---|---|
| `scope` | 固定 `current`，标识只评价本次诊断；新版导包会据此校验，旧判题仍可读取。 |
| `roots` | 可判时必填 `{matched:[编号],missed:[编号],extra:[说明]}`。编号从 1 起，与答案纸根因顺序一致，不重不漏。每条 extra 写根因、支持/矛盾/无法判断及依据。`unknown` / `not_reproduced` 不写 roots。 |
| `rationale` | 非空文字，逐条说明根因命中理由与重要结论的证据判定；引用本次 span 或具体返回。 |
| `items` | 本次工具、skill、用例问题的数组，无则 `[]`。 |
| `observations` | 纯 agent 行为偏差的数组，无则 `[]`。每项为 `{title,detail,pointers}`，detail 写事实和影响，不生成修复任务。 |
| `limitations` | 评价限制的非空字符串数组，无限制则 `[]`，说明缺少什么以及影响哪项判断。 |

不写 `checks`。旧记录里的 checks 由读侧兼容，单次判题不生成、不消费。

## 每条 item

| 字段 | 要求 |
|---|---|
| `key` | 当前 trace 内唯一，3–80 字符，小写字母、数字及 `._-`，按现象命名。 |
| `issue_type` | `tool` / `skill` / `case`，不代表修复仓库；旧记录缺失时不根据 class 猜测类型。 |
| `class` | `true_bug` / `needs_decision`。本版 `true_bug` 只用于已核实的 tool 缺陷；skill/case 问题进入 needs_decision。 |
| `title` | 一句说明问题，≤ 40 字符。 |
| `pointers` | 至少一个 `{span_id:"完整 ID 或唯一前缀"}` 或 `{probe:"online:调用、条件、结果"}`。span 必须属于当前 trace。 |
| `how_verified` | true_bug 必填：看到什么、核实得到什么、预期依据及排除正常差异的理由；写出影响。 |
| `repro` | true_bug 必填文字：条件、工具/操作、关键入参、实际表现。不要求脚本。 |
| `expected` | true_bug 必填文字：预期行为及依据；不是修复方案。 |
| `decision` | needs_decision 必填：`wording` / `capability` / `case` / `is_bug`。 |
| `ask` | needs_decision 必填：需要核实或决定的具体问题，不要求拟修复方案。 |
| `context` | needs_decision 必填：当前材料、具体偏差、已知与未知、对本次诊断的影响。 |

不输出旧字段 `kind / qualifier / verified / rule_ref / suspected_kind / suggestion / layer / fix_where`。
`issue_type` 是独立类型轴，不能用旧 kind 替代；class 也不能改成 tool/skill。
