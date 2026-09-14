---
name: diag-flywheel
description: 诊断飞轮的客户端脚本——把一次诊断沉淀成用例、跑探针、出判题包、判完回流、导训练语料、批量重测对比。用自己的 dbdog API key 直连 server,不需要内部凭证也不需要仓库检出。触发词:飞轮 / diag-flywheel / 沉淀用例 / 判题包 / 探针 / 训练语料 / 重测对比 / curate / judge-package / probe。
---

# diag-flywheel —— 让一次诊断变成能反复用的资产

装完 `dbdog-agent-obs` 插件、在 Claude Code 里发过「诊断: …」之后,你已经有 trace 了。
这个 skill 管的是**接下来那几步**:把那次诊断沉淀成带答案的用例 → 判它做得对不对 →
看 dbdog 该修什么 → 改完重测对比。

**这些脚本是 dbdog-mcp 仓 `scripts/llmobs/` 的镜像**(由母版的 `sync-flywheel-kit.mjs` 同步,
一致性有守门测试钉着)。之所以镜像进来,是因为 mcp 的发布产物只有一个 `index.js`,
`scripts/` 不在里面——而你手上有的是这个插件。判卷口径(`diag-judge` skill)**只住在本插件**,mcp 不再下发。

## 先备两样

1. **API key**:控制台 `/settings/api-keys` 签发。跟 hooks 上报 span 用的是同一把,
   已经配过 `DBDOG_OBS_API_KEY` 的话直接复用那个值。
2. **两个环境变量**:

```bash
export DBDOG_BASE_URL=http://<你的 dbdog-server>      # 控制台「设置」里能看到
export DBDOG_API_KEY=<上面那把 key>
```

> key 自带租户,不用再配 org。下面 `S` 指本 skill 的 `scripts` 目录。

## 全流程

### ① 沉淀用例:把刚才那次诊断变成一道题

```bash
node $S/llmobs/curate-record.mjs --dataset daily-diag \
  --trace <trace_id> \
  --roots "会话 A 持锁未提交阻塞 B/C" \
  --tags kind:blocking --create-dataset "日常诊断行为基准"
```

`--trace` 从真实诊断沉淀(当时的结论存进 `observed_output` 当参照物,答案由你补);
也可以 `--prompt "<题面>"` 直接构造。判定基准三选一:`--roots`(期望根因)/
`--behaviors`(行为基准,时间无关的题推荐)/ `--notes`。

**答案纸整个可缺** —— 不写 `--roots`/`--behaviors` 就是一道无参照题,后面判的是「自洽/不自洽」
而不是「对/错」。

### ② 探针:把「模型没想到查」和「查了也没有」分开

前提是这条用例有反向证据链(用 `evidence-chain` skill 生成,产物进 record 的 `metadata.reverse_chain`)。

```bash
node $S/llmobs/probe.mjs --case <判题包>/cases/<event_id> --mcp-http
```

探针拿反向链里每条证据,**用固定代码、固定参数**去调同一批 dbdog 工具重放一遍:
探针结果用于核实偏差，脚本也拿不到并不直接证明 dbdog 有缺陷，还要排除权限、窗口和数据本来不存在等条件。四种结果:
有 / 无 / 工具没注册 / 无权限——后两种正是 dbdog 的需求信号。

需要 `DBDOG_MCP_URL`(你连的那个 MCP 地址)与 `DBDOG_MCP_BEARER`。

### ③ 出判题包 → 判 → 回流

```bash
node $S/llmobs/judge-package-export.mjs --experiment <run 名或 uuid> --out ./pkg
```

包内含 `manifest.json`、判题 skill 正文及 `references/output.md`，每例的
`trace.json` / `forward.md` / `reverse.md` / `ground-truth.md` / 可选 `probe.json`。
不带历史判题、修复标记或未关闭问题；trace 去掉已有 `evaluation.*` 标签。

按本插件 **`diag-judge`** 的方法与输出契约评价本次诊断，必要时只读核实。
产出 `annotations.jsonl` + `summary.md`，然后回流：

```bash
node $S/llmobs/judge-package-import.mjs --package ./pkg --annotator <判题模型名>
```

`--annotator` 必填。判题只交根因命中、证据、当前问题和限制；`class` 表示确定是 bug / 要人定，
`issue_type` 表示 tool / skill / case。判题不提供修复方案、不复验历史条目，具体字段只看输出契约。

修完一条问题(修复走 `fix-run` skill,以用例为维度):部署、判断历史数据、在挖出它的那次诊断的原窗口复测,再打标记。
确定是 bug 的复测通过即关；其余保留修复状态，统一审视由外部流程负责，不派给单次判题:

```bash
node $S/llmobs/fix-mark.mjs --trace <挖出它的 trace_id> --key <改进点 key> --status claimed_fixed \
  --data unaffected|repaired|unrepairable [--verify passed|failed] --note "改了什么;原窗口重放拿到什么" --by <谁>
# --data:数据没受影响 / 已修复 / 修不回来;--verify 只跟 claimed_fixed 走,数据修不回来的不带
# 改不动:--status needs_human --note "要人做什么";决定不修:--status wont_fix --note "为什么"
```

导入后 server 自动把批注投影成三处:批注原件、experiment 的分数、trace root 上的
`evaluation.*` 标签。**判题方只交一次**。

> 历史查询供修复与汇总流程使用，不是单次判题的输入。
> 包是给「判题模型在连不上 dbdog 的环境里」准备的。

### ④ 去控制台看

- **用例集**:「历次」一次运行一行,「判题」同一行写那一次判成什么;点开看这道题的**改进点**——
  每条带类别、状态(没修好 / 改了，等复测 / 复测通过 / 复测没过 / 数据修不回来，等下次诊断和判题时验证 / 改了，等下次判题验证 / 要人协助 / 不修 / 修好了),
  修没修好看修复方复测；旧判题的复验记录仍可展示；要不要再跑、从哪一步跑,在页面上点「复现 / 诊断 / 判题」
- **用例诊断日志**:每行带判题结果 chip 与所属轮次,可筛「只看未判 / 只看有 dbdog 要修的 / 只看要人看的」
- **跑批页**:run 列表与对比

### ⑤ 改完重测,看变好还是变坏

```bash
node $S/llmobs/run-experiment.mjs --experiment blocking-b --parent blocking-a \
  --model opus --concurrency 2 --timeout-sec 900
```

会对数据集里每条用例起一个 headless 会话跑一遍。挂了 `--parent` 之后,控制台对比页默认
拿它跟基线比:覆盖 N/M、版本章 diff、**退步**(红字最顶)、修好、dbdog 侧计数、本轮总账。

> 这一步要本机装着 Claude CLI 且已登录。日常自己做诊断用不上它——你在 Claude Code 里
> 发的每句「诊断: …」本来就已经被 hooks 采成 trace 了,批跑是做**成批评测**时才需要的。

### ⑥ 攒训练语料

```bash
node $S/llmobs/training-corpus-export.mjs --out ./corpus [--from ... --to ...]
```

只收「判过、证据撑得住、且没有确定是 bug 的问题」的 trace——不论结论对错,那都是模型 + prompt 行为的样本。
有 bug 的要收就加 `--include-tool-errors`(打成 dbdog_gap)。被排除的理由会写进 manifest。

## 几个会踩的点

- **探针要反向链**:没有 `metadata.reverse_chain` 的用例跑不了探针,判题时「缺采集」这一类
  只能靠 trace 自证,判官分不清「没有数据」和「丢了数据」。
- **重判 = 覆盖**:`annotations.jsonl` 同一条 trace 不要追加第二行,改完重跑 import 即可。
- **子集重测不许说总分**:只跑了一部分用例时,页面会印「覆盖 N/M,非全量」——没重跑的那些
  改坏了没人知道。
- **成本**:一条完整体检用 opus 跑过 $21.69 / 821s / 264 次工具调用。批跑前先想清楚跑几条。
