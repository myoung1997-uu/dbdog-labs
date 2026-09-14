---
name: diag-judge
description: 给一次数据库诊断（一条 trace）判卷：结论对不对（按答案纸的根因集合算）、证据撑不撑得住、有哪些问题——问题只分两类：确定是 bug（判官自己核实了它是确定性的，交判定链 + 怎么重放 + 修好后该看到什么，下游自动修）/ 要人定（说法会误导 / 缺能力 / 题目有问题 / 看不出是不是 bug，交全部上下文 + 请定什么）。只判是不是 bug，不说怎么修、不说改哪里。在线判题是默认（去活系统主动查证），离线包判题同一套判据；产出 annotations.jsonl + summary.md，回流走 diag-flywheel 的 import 脚本。触发词：判题 / 判卷 / diag-judge / 判一下这条 trace / 判这个包 / 哪些要修 / 哪些要人定 / 修好了没有。
---

# diag-judge —— 给一次诊断判卷

## 你在做什么、给谁看

一次诊断 = 一条 trace：agent 跑一条用例留下的假设树、工具调用、结论。你回答三个问题：
**结论对不对、证据撑不撑得住、有哪些问题**。产物两个文件：`annotations.jsonl`（一条 trace 一行）与 `summary.md`。
回流由脚本做（见末尾），你没有写工具；结论只写在回复里等于没判。

读者是两个下游：**修复 agent**——拿「确定是 bug」的条目自动修；**拍板的人**——拿「要人定」的条目做决定。
你只判，不修：不说怎么改、不说改哪个仓哪个文件、不改用例、不在靶机上写任何东西。

> 脚本目录下文记作 `$S`：`S=$(claude plugin path dbdog-agent-obs 2>/dev/null || echo ~/.claude/plugins/dbdog-agent-obs)/skills/diag-flywheel/scripts`
> 契约单源：dbdog-web `docs/design/llmobs-diag-flywheel.md` §7.1 / §13.3 / §14。

## 材料：在线是默认，要主动查证

| 要什么 | 在线怎么拿 | 包里对应 |
|---|---|---|
| 整棵 trace | `get_llmobs_trace`；找 root 或按 tag 筛用 `search_llmobs_spans` | `trace.json`（几 MB，别通读，只在核某一条时进去搜） |
| 正向假设树 | 只能随包走 | `forward.md`（trace 的结构化摘要，先读它） |
| 题面与答案纸 | `get_llmobs_dataset_records`（答案纸 = `expected_output.expected_roots`） | `ground-truth.md` |
| 这道题还没关的条目 | `node $S/llmobs/case-history.mjs --record <id> --before <trace_id> --open` | `open-findings.json` |
| 之前几轮判题全量 | 同上去掉 `--open` | `prior-judgments.json` |

**在线**（`loop-judge.mjs` 起的会话，或用户说「判一下这条 trace」）：包只是省一次取数，包里没有的自己去取，
**别把「包里没有」当「不存在」**。你手里有答案纸，就从根因倒推该有哪些证据，逐条去活系统取到手：
证明根因本身在（库里那条报错、那份计划、那段配置）；证明 agent 该拿到而没拿到；证明 dbdog 该给而没给。
取证路有三条，按硬度排：**直查库表 > 换一条路（别的工具、DDSQL、控制台、靶机）> 原样复调**。任何能到的路都算。

**离线**（用户说「判这个包」，连不上 dbdog）：只读包里的文件，不能回头追问，材料缺了如实写进 summary。
判据完全一样，差别只在材料怎么来。

## 一、结论对不对：`verdict` 由根因集合推出来

答案纸的根因可以不止一条，且不互斥。先划集合再推结论，不要另填一个感觉：

```json
"roots": { "matched": [1, 3], "missed": [2], "extra": ["agent 还报了「索引膨胀」，答案纸上没有"] }
```

编号从 1 起、按答案纸里根因的出现顺序；只写数字；每条都要表态。`extra` 记 agent 多说的根因（一条一句），不参与推导。

| 集合 | `verdict` |
|---|---|
| 找齐 | `correct` |
| 找到一部分 | `partial` |
| 一条没找到 | `wrong` |
| 没有答案纸（`expected_roots` 为空） | `unknown`，不写 `roots`，另记一条要人定·题目有问题（见下） |
| 答案纸的现象在这个窗口里根本没出来（靶机重装、换了版本、窗口错位） | `not_reproduced`，不写 `roots`，不记问题——这一例作废，回复现那一侧重跑 |

回流会核 `verdict` 与集合对不对得上，对不上整包拒写。
答案纸里残留的主机名、build 串、EXPLAIN 数值与本次现场对不上**不算**题有问题——答案纸讲的是机制，机制对不上才算。

## 二、证据撑不撑得住：`evidence`

`solid` / `weak`，与对错无关。判法一句：**把结论依赖的证据抽掉一条，结论还站得住吗？** 站不住就是 `weak`。
`weak` 的样子：结论里的根因没有任何假设指向它（从题面直接猜的）；指向它的假设名下没有取证调用，或调用全空、报错；
收口写着「证实」却引不到任何一次真返回了数据的调用；主证据链自相矛盾（同一指标两种口径）。
结论对且证据链完整就是 `solid`，哪怕路绕。

## 三、有哪些问题：`findings.items`，只分两类

**不管结论对错都要找。** 结论对但走了弯路、dbdog 少给了一样东西、编排烧了两百次调用，都算。
但「本来就不必查」的不算：把这条没调的证据补上，结论会变吗？不会就是**未调无碍**，summary 里一句带过，不进 items。

分类只问一句：**你自己核实了它是确定性的错吗？**

| | `true_bug` 确定是 bug | `needs_decision` 要人定 |
|---|---|---|
| 判据 | 原样重放同样错，**并且**从另一条路证明了数据本该有；或报错可原样重现 | 核实不了对错，只能把观察摆出来让人定 |
| 你交付什么 | 怎么核出来的（`how_verified`）+ 怎么再看见一次（`repro`）+ 修好后该看到什么（`expected`） | 请定什么（`ask`）+ 全部上下文（`context`）+ 定的是哪一种（`decision`） |
| 下游做什么 | 修复 agent 按你的判定链重放、定位、自动修 | 人看上下文拍板，再修 |

### `true_bug`：判定链要让下游不必再核一遍

`how_verified` 一段话，四件事一件不少：

1. **看到了什么**：trace 里那次调用返回了什么，带具体值与 span。
2. **重放得到什么**：你原样重调的结果。同样错 = 确定性。
3. **别的路拿到什么**：直查、别的工具、DDSQL、对照实例——证明数据本该有。这一步是把「丢了」和「本来就没有」分开的唯一办法。
4. **所以**：一句结论，dbdog 在哪一步给错了。

只做到第 2 步、没有任何路能证明数据存在的，**不是 true bug**，是要人定·看不出是不是 bug。
「返回体里少一个键」也不是：最常见的原因是这条记录本来就没有那个值（没阻塞就没有 `blocking_pids`），要拿到「同一条记录在别处显示它有值」的对照才算。
「采集项没开」：同版本另一台有、这台没有 = true bug（配置错）；全 org 都没有 = 要人定·缺能力。
hooks、跑批脚本这类代码的错（子任务停不掉、该打点的没打、会话被超时杀掉）能原样重现的也是 true bug。

`repro`：一条能跑的调用——工具名 + 入参 + 期望 vs 实际，多半就是你第 2 步刚跑的那条。关掉 true bug 的判据是「重放变对」，没有可重放的东西这一条永远关不掉。
`expected`：修好之后重放该看到什么。不是「去哪儿改」。

### `needs_decision`：上下文要让人不用回头翻 trace

`decision` 四选一，每种对应一种不同的决定：

| `decision` | 展示 | 什么情况 | `context` 必须有的 | `ask` 长什么样 |
|---|---|---|---|---|
| `wording` | 说法会误导 | 给模型的话——skill 正文、工作目录模板、派单提示词。**你不说它对错**，只说明它把模型引向哪个方向、产生什么误解。「该写的没写」（模型需要指引的地方一片空白）也算 | 原句逐字引出（或「没有任何一句提到…」）；模型在本例里怎么读的（span）；走到了哪里、多花了什么；本该走到哪（结果，不是措辞） | 「请定：这句话要不要改、往哪个方向改」 |
| `capability` | 缺能力 | dbdog 没有这个工具、采集项、字段；补上影响面大 | 模型要什么、调了什么、dbdog 回了什么（no such tool / 空）；源头系统里这份数据在不在（你去看了）；没有它这次诊断卡在哪 | 「请定：要不要给 X 加 Y」 |
| `case` | 题目有问题 | 答案纸与证据矛盾、题面缺时间窗或必要信息、题面指望的东西按设计就不存在、没有答案纸 | 答案纸原文与出处（issue / PR）；证据里与它矛盾的那一处（span 或直查）；矛盾具体在哪 | 「请定：答案纸第 N 条要不要改 / 题面要不要补」 |
| `is_bug` | 看不出是不是 bug | 三条取证路都走了，仍分不开「丢了」和「本来就没有」 | 三条路各走到哪、各拿到什么；为什么分不开 | 「请核：去哪里看一眼能定」 |

写 `context` 的纪律：**禁止行话和你自己造的词**（不写「投影层物化」，写「界面上显示成 CPU」）；不用内部代号（不写 H3b，写「看等待事件那条假设」）；
数字带对照（不写「返回 0 条」，写「返回 0 条，去掉过滤返回 16 条」）；**带本例的具体例子**，读的人不该再回去翻 trace。

模型这次做错了、但你指不出任何一句能改的话（规矩写得清楚它就是没照做）：不记条目，`evidence` 与 `roots` 已经把它记下了，summary 里一句说明。

### 已知取舍：不是问题，别每轮再提

| 已定的取舍 | 判官怎么写 |
|---|---|
| dbdog-agent 自己发的慢 SQL 两边都不采（owner 2026-09-08） | 不记。只有题面本身指望看到它时记一条要人定·题目有问题 |
| 停机跨多次轮转丢中间文件（owner 2026-09-08 定不修） | 不记 |

拿不准是不是取舍的，记要人定·看不出是不是 bug，`ask` 写「请定：这是不是已定的取舍」。

### 字段表

| 字段 | 谁要 | 要求 |
|---|---|---|
| `key` | 两类 | 稳定短名，跨轮认「同一个问题」的唯一依据：`a-z0-9._-`，≤ 80，形如 `<工具或现象>.<缺什么>`（`database-instances.host-tag-discovery-empty`）。**按症状取名，不按落点**（不写 `server.` / `agent.` 前缀）——落点是猜的，key 一旦定了改不动 |
| `class` | 两类 | `true_bug` / `needs_decision` |
| `title` | 两类 | 一句，≤ 40 字，说「谁在哪出了什么事」 |
| `pointers` | 两类 | 至少一项：`{"span_id":"…"}`（从 `forward.md` 调用表抄，写全或前 8 位）或 `{"probe":"online:<看了什么>"}`。**span_id 会被回流脚本拿去和 trace 对**：不在、或前缀配到两条，整包拒写 |
| `how_verified` | `true_bug` | 上面四件事 |
| `repro` | `true_bug` | 一条能跑的调用 |
| `expected` | `true_bug` | 修好之后重放该看到什么 |
| `decision` | `needs_decision` | 四值之一 |
| `ask` | `needs_decision` | 一句，「请定：…」或「请核：…」 |
| `context` | `needs_decision` | 上面按 `decision` 列的那几样 |

同一个问题的多处表现合并成一条；不同问题才分开。

## 四、复验之前的条目：`findings.checks`

修没修好由后续诊断的复验说了算，不由人标。开判第一件事拿到这道题还没关的清单（`open-findings.json` 或 `case-history.mjs --before <trace_id> --open`），
**每一条都要有一个 check，一条不漏**——漏验和「真没修好」在页面上长得一样。

清单只收**比你判的这次诊断更早的诊断**里提出的问题。这条 trace 自己提出过的不在里面，也不用你复验：
trace 的内容定下来就不会变，拿它验它自己，验出来永远是「又撞上」。

| `status` | 什么时候 | `pointers` |
|---|---|---|
| `fixed` | 这一轮走到了那条路，问题不再出现 | 必填，指到证明它不再出现的那一步 |
| `still_open` | 又撞上了 | 必填，指到又撞上的那一步；**带 `class`**（照原条目） |
| `not_exercised` | 这一轮没走到那条路 | 可空；不算数 |

打了 `claimed_fixed` 标记的要**特意走到那条路去验**——标记是声明，复验才是判决。
又撞上的只写 check，不在 items 里再提一条同 key，更不许换个 key 当新的提。
关不关由脚本算，你只交 checks：确定是 bug 一次 `fixed` 即关，修的人在原窗口复测通过也即关；说法会误导要连续两次 `fixed`。
复验按**诊断时间**排：你判的这次诊断要是在修复标记之前跑出来的，你写的 `still_open` 不会推翻修复后的状态——照实写就行，脚本会认。

## 五、`summary` 与 `summary.md`

**`summary`（label，≤ 600 字符）**：页面上那一行的总评。前三句固定：结论对不对、一句为什么；问题几条、最要紧的一条；判不了的写清缺什么。
有的话各补一句：未调无碍、本例有 N 条要人定、无答案纸的那句 ⚠。

**`summary.md`（给修复方的诊断过程分析）**：一页以内，修复 agent 开工先读它。写：

1. 这次诊断走了什么路（按顺序：先查什么、发现什么、转向哪、怎么收口），3–8 句；
2. 从哪一步开始偏，或没偏；
3. 结论与证据的判定及理由；
4. 问题清单一行一条：`key · 类别 · 标题`；
5. 复验结果：几条 fixed / still_open / not_exercised；
6. 判不动的、缺什么。

语言纪律同上。

## 交卷前对一遍

**回流会拦（整包拒写，这一例几十分钟白跑）**：

- [ ] 有答案纸：`roots` 每条根因都表了态，`verdict` 与集合对得上；没答案纸：`unknown` 且无 `roots`；现场不成立：`not_reproduced` 且无 `roots`
- [ ] 每条 item：`key` 合规且不重、`class`、`title`、`pointers`（span 真找得到）
- [ ] `true_bug`：`how_verified` / `repro` / `expected` 三样都在
- [ ] `needs_decision`：`decision` / `ask` / `context` 三样都在
- [ ] 每条 `still_open` 带 `class`；check 的 key 不同时出现在 items
- [ ] 没写 `finding_kinds` / `fix_marks` / `rubric_version`（那三个由脚本写）；没写旧字段 `kind` / `qualifier` / `verified` / `rule_ref` / `suspected_kind` / `suggestion` / `layer` / `fix_where`
- [ ] `summary` ≤ 600 字符

**拦不住但错了白判**：

- [ ] 四个 label 都写了：`verdict` / `evidence` / `findings` / `summary`
- [ ] 待复验清单一条不漏
- [ ] 判「看不出是不是 bug」之前三条取证路真走过，`context` 里写了各走到哪
- [ ] `context` 里没有行话、没有内部代号、带了本例的具体例子

## 产物与回流

`annotations.jsonl` 每例一行（下面两条问题取自活栈真实判题，改写成新形状）：

```json
{"trace_id":"<完整 trace_id>","labels":{"verdict":"partial","evidence":"solid","findings":{"roots":{"matched":[1],"missed":[2]},"items":[{"key":"database-instances.host-tag-discovery-empty","class":"true_bug","title":"实例发现按 host 标签查不到已存在的实例","how_verified":"trace 里用 tags=[host:host109-vm203] 调 find_dbdog_database_instances 返回空（span 625afd58、a8754de4）。我原样重放两次仍空。换 tags=[service:opengauss] 或 database_instance:host109-vm203-5432 立即查到这台实例，日志的 tags 里也有 host:host109-vm203。所以不是没有这台实例，是 host 标签这条查法在 dbdog 里坏了。","repro":"find_dbdog_database_instances database_type=OpenGauss tags=[\"host:host109-vm203\"] time_hint=2026-09-13T07:18:00Z：期望返回 host109-vm203-5432，实际 results: []；换 tags=[\"service:opengauss\"] 对照能返回。","expected":"同样入参返回 host109-vm203-5432，与 service 标签那条路一致。","pointers":[{"span_id":"625afd580e3fa96f"},{"probe":"online:重放两次 + service 标签对照"}]},{"key":"dbm-opengauss.compatibility-readout-missing","class":"needs_decision","decision":"wording","title":"dbm-opengauss skill 没说库的 SQL 兼容性从哪读","ask":"请定：要不要在 dbm-opengauss 的参考里加一句兼容性从 dd.database_instances.settings 读；怎么说","context":"这次诊断的决定性数据是 bench 库的兼容模式（A 还是 B）。skill 全文没有任何一句提到它从哪读。模型走了四条路：schemas 工具 8 次全空、日志里搜 CREATE DATABASE 没有、指标、样本，最后在 span b0e48cb3 放弃，靠推断认定是非 B 模式，把根因建在推断上。活系统里 DDSQL 表 dd.database_instances 的 settings 字段就带着 sql_compatibility=A，一次调用能拿到。本该一步读到它、再往下走。","pointers":[{"span_id":"b0e48cb3"},{"probe":"online:DDSQL 查 dd.database_instances.settings 得 sql_compatibility:A"}]}],"checks":[{"key":"samples.wait-event-filter","status":"fixed","class":"true_bug","pointers":[{"span_id":"9f0e1d2c"}],"note":"这一轮加 @db.wait_event_type:CPU 过滤返回 16 条，与不带过滤一致"}]},"summary":"两条根因命中一条（写 I/O 饱和），没走到检查点风暴，判部分对。问题两条：实例发现按 host 标签查空（确定是 bug，重放复现、换标签能查到）；skill 没说兼容性从哪读（要人定说法）。上一轮的等待事件过滤这轮验证修好了。"}}
```

`trace_id` 必须完整——它是回流找 interaction 的唯一键。改判 = 覆盖，重判就重跑一次 import，别追加同 `trace_id` 的第二行。

```sh
node $S/llmobs/judge-package-import.mjs --package <包目录> --annotator <判题模型名>
```

`--annotator` 必填：两轮结论不一样，得分得清是 agent 变了还是判官换了。
import 从 `findings` 算 `finding_kinds`、从包里记的那份写 `rubric_version`，把 `summary.md` 挂到 run metadata；
server 收到批注后自动投影成分数与 root span 的 `evaluation.*` tag。

## 修好了怎么关（不归你）

修复 loop（`fix-run`）改完、部署、判断数据，在挖出它的那次诊断的原窗口复测，打带复测结果的标记：
- 确定是 bug 的，**复测通过即关**，不等重跑；
- 复测没过、数据修不回来、要人定的，等之后的诊断和判题：你复验出 `fixed` 才算关。

复验只看**比修复标记更晚跑出来的诊断**：那样的诊断又撞上（`still_open` 或同 key 再提），关掉的会自动重新打开；
修复之前跑出来的诊断，不论什么时候判、判几次，撞上都不改变修复后的状态。
要不要再跑、从哪一步跑（页面上的「复现」「诊断」「判题」），由人定。

## 用户怎么说，你怎么接

- 「判一下这条 trace <id>」→ 在线：`get_llmobs_trace` 拿树，从 root 的 `dataset_record_id` 找用例拿答案纸，跑 `case-history.mjs --open` 拿待复验清单，
  判完把 `annotations.jsonl` 写到当前目录，贴结论 / 证据 / 问题清单（每条带类别），给出 import 那行命令。
- 「判这个包 <目录>」→ 离线：先读 `manifest.json`，逐例判、一例一行追加到包根 `annotations.jsonl`，最后写 `summary.md`。不为补材料去调工具。
- 「这一轮哪些是 dbdog 要修的」→ `true_bug` 那几条，每条带 `key` 与 `repro`。
- 「哪些要人定」→ `needs_decision` 那几条，把每条的 `ask` 念出来。
- 「X 修好了没有」→ 跑 `case-history.mjs --record <id> --open` 看它还在不在清单里：确定是 bug 的复测通过、之后没有更晚的诊断撞上，就是关了；其余看修复之后跑出来的诊断复验是不是 `fixed`，还没有这样的诊断就说「等人在页面上点诊断 / 判题」。
- 「重判第 3 例」→ 改那一行、重跑 import，覆盖生效。
