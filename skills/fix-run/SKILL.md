---
name: fix-run
description: 修一道题挖出的问题——上游是 judge-run 的判题结果。一次一道用例：拉下判题对整个诊断过程的分析和按条展开的问题；「确定是 bug」的按判题给的判定链重放、在五仓里定位、自动修、打 claimed_fixed 标记；「要人定」的把上下文原样摆给用户，逐条拍板后再动手。改完部署，页面上这道题显「已修待复现」，人点「重复现」进入下一轮。触发词：fix-run / 修这道题 / 修一轮 / 修复 / 修这批 / 哪些等我定。
---

# fix-run —— 修一道题挖出的问题

诊断飞轮的第四棒。`judge-run` 判完一条 trace，问题挂在那一轮的判题里；你这一棒把它们修掉。
修完不是终点：人点「重复现」，`diag-run` / `judge-run` 再跑一轮，**复验出 `fixed` 才算关**。修没修好不由你说了算。

**工作单位是用例**：一次修一道题挖出的全部问题，不是一次修一条。

## 口令

- `fix-run <用例集>/<record id 前 8 位>`：修这道题。
- `fix-run`（不带参数）：领「判过、有没关的问题、且没打过标记」的用例里最新判过的那道。
- `/loop /fix-run`：自定节奏反复领。每一 tick 一道题；要人定的摆出来等回答，下一 tick 接着。

在**交互会话**里跑——要人定的必须讨论，headless 起不了。不需要租约：一个人跑、一次一道题，`claimed_fixed` 标记就是「有人接了」。

## 开跑前确认

| 要什么 | 是什么 |
|---|---|
| `DBDOG_BASE_URL` | dbdog server 的 API 面（不是 MCP 口） |
| `DBDOG_API_KEY` | 控制台签发的 key；已配 `DBDOG_OBS_API_KEY` 就复用那个值 |
| `DBDOG_OPERATOR` | 你是谁（如 `qinqiang`），落进修复标记的 `by`。没有就问用户，别编 |
| MCP | 会话挂着 dbdog 的 MCP：重放 `repro` 要用 |
| 五仓兄弟检出 | `../dbdog-server`、`../dbdog-mcp`、`../dbdog-agent*`、`../dbdog-web`、`../dbdog-labs` 平级 checkout——判题不给落点，定位靠你在这里 grep |

脚本目录记作 `$S`：`S=$(claude plugin path dbdog-agent-obs 2>/dev/null || echo ~/.claude/plugins/dbdog-agent-obs)/skills/diag-flywheel/scripts`。

## 一道题怎么修

### 1. 拉材料

```sh
node $S/llmobs/loop-pending.mjs --dataset <用例集> --kind fix --json     # 不带参数时先看有哪些题等着修
node $S/llmobs/fix-context.mjs --record <record id> [--out fix-work]     # 导出这道题的修复工作包
```

工作包 `fix-work/<用例集>-<record 前 8 位>/`：

| 文件 | 是什么 |
|---|---|
| `README.md` | 题面、引擎、答案纸、最新判过那轮的 trace / 结论 / 证据，**判题对整个诊断过程的分析**（走了什么路、从哪步开始偏） |
| `true-bugs.md` | 确定是 bug 的，逐条：怎么核出来的、怎么重放、修好后该看到什么、指针 |
| `needs-decision.md` | 要人定的，逐条：定的是哪一种、请定什么、全部上下文、指针 |
| `items.json` | 机器读的同一份，含每条的开关状态与已有修复标记 |
| `spans/<span 前 8 位>.md` | 每个指针指到的那次调用：工具名、入参、返回前 2000 字 |

**先读 `README.md` 的过程分析，再读条目。** 知道 agent 是怎么走到那一步的，才知道一条问题在整个诊断里有多要紧。

### 2. 确定是 bug 的，逐条

1. **先重放**：照 `repro` 那条调用在 MCP 上跑一遍。还错 → 往下走；**不复现** → 不改代码，打标记：
   ```sh
   node $S/llmobs/fix-mark.mjs --trace <trace_id> --key <key> --status needs_human --note "重放没复现：<你看到什么>" --by $DBDOG_OPERATOR
   ```
2. **定位**：拿 `how_verified` 里的工具名、字段名、错误串在五仓里 grep。判题方故意不给落点——它手上没有源码；你有。
3. **改**：改代码或配置。一条问题一个提交，提交信息带 `key`。风格照各仓 git log；schema 改动只走各仓自己的迁移。
4. **验**：跑该仓的测试；再照 `repro` 重放一次，看是不是变成了 `expected` 说的样子（本地能起就本地验，起不了就等部署后验）。
5. **标记**：
   ```sh
   node $S/llmobs/fix-mark.mjs --trace <trace_id> --key <key> --status claimed_fixed --note "改了什么（一句）" --by $DBDOG_OPERATOR
   ```

判题给的判定链要是站不住（你重放发现它核错了），不要硬修：打 `needs_human`，`note` 写你看到的和它写的哪里不一样。

### 3. 要人定的，逐条

把 `ask` 和 `context` **原样**摆给用户——不缩写、不换词、不替它总结。一条摆完等拍板，再摆下一条。

拍板结果三种：
- **改**：按拍板的方案动手，之后与第 2 步的 3–5 一样（改 → 验 → `claimed_fixed`）。`decision` 是 `case` 的，改用例集的题面或答案纸也只在拍板后做。
- **不改**：`--status wont_fix --note "<理由，用用户的原话>"`。
- **再看看**：`--status needs_human --note "<还要核什么>"`，留在清单里。

### 4. 部署

改了哪个仓就「部署」哪个仓（家族军规 9：到 `../dbdog-build` 仓执行 `publish` skill 的快升级）。**没部署的修复在下一轮复现里看不见**，等于没修。

### 5. 收尾

告诉用户：修了几条、几条等拍板、几条不修；改了哪几个仓、部署了没有。
然后说明：页面上这道题会显「已修待复现」，请他点「重复现」——那就是下一轮的起点。

## 纪律

- 只改代码、配置、给模型的话、（拍板后的）用例；**不改判题结果、不删批注、不碰诊断表状态**。
- 一条问题一个提交；push 前必 `fetch`（五仓都有并发 agent）。
- 判题写的判定链是你信它的依据，不是替你验的：**先重放再动手**。
- 修复标记是声明。关不关看下一轮复验，别跟用户说「修好了」，说「改了、等复现」。
- 不要为了让清单变短把问题标成 `wont_fix`；理由要能让下一个人同意。

## 用户怎么说，你怎么接

- 「修这道题」「fix-run opengauss/8947f5f6」→ 第 1 步起走完。
- 「哪些等我定」→ 只导包、把 `needs-decision.md` 逐条摆出来，不动 bug 类。
- 「先修 bug 的，要人定的放着」→ 第 2 步走完就收尾，第 3 步留给下一次。
- 「X 修好了没有」→ 不由你说了算：看页面上那条问题最近一轮复验是不是 `fixed`；没复验过就请他点「重复现」。
