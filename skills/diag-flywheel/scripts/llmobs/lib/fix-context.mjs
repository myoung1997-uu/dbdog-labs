// fix-context.mjs — 修复工作包的**纯函数**层（挑条目、算状态、渲染 markdown），零 I/O、零 fetch。
//
// 单源关系（军规 3）：
//   · 工作包长什么样、给谁看 = dbdog-web `docs/design/llmobs-diag-flywheel.md` §14.3；
//     读它的是 labs `skills/fix-run/SKILL.md` 那条 loop（修复是飞轮第四棒）。
//   · 「哪些还没关」不在这里再算一遍——`judge-quality.mjs` 的 `openFindings` 是唯一那份；
//     旧批注的读法也不在这里——`judge-package.mjs` 的 `normalizeFindings` 是唯一那份。
//   · 渲染给人看的措辞照判卷口径的中文名（确定是 bug / 要人定·说法会误导 …），
//     页面（web `llmobs-fix-items.ts`）与这里叫法一致，修的人两边看到的是同一个词。
import { FINDING_CLASSES, normalizeFindings } from "./judge-package.mjs";
import { openFindings } from "./judge-quality.mjs";

/** 类别与「定的是哪一种」的中文名（页面、终端、工作包三处同一套叫法）。 */
export const CLASS_ZH = { true_bug: "确定是 bug", needs_decision: "要人定" };
export const DECISION_ZH = { wording: "说法会误导", capability: "缺能力", case: "题目有问题", is_bug: "看不出是不是 bug" };
export const MARK_ZH = { claimed_fixed: "改了，等复验", needs_human: "要人协助", wont_fix: "不修" };
const CHECK_ZH = { fixed: "验过：不再出现", still_open: "又撞上了", not_exercised: "这一轮没走到那条路" };

/** 一条问题的标题行：`确定是 bug` / `要人定 · 说法会误导`。 */
export const classLabel = (it) => (it?.class === "needs_decision"
  ? `要人定 · ${DECISION_ZH[it?.decision] ?? it?.decision ?? "（没写定哪一种）"}`
  : CLASS_ZH[it?.class] ?? String(it?.class ?? "（没写类别）"));

const short = (id, n = 8) => String(id ?? "").slice(0, n);

/** 工作包目录名：`<用例集>-<record 前 8 位>`（§14.3）。用例集名缺了也要有个落点，不然覆盖别人的包。 */
export function workDirName(datasetName, recordId) {
  const ds = String(datasetName ?? "").trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${ds || "dataset"}-${short(recordId)}`;
}

const asObj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

/**
 * 历次判题 → 这道题的问题清单（每条带开关状态、来龙去脉、已有修复标记）。
 *
 * @param {{round:string, created_at:string, trace_id:string, judged?:boolean, items?:any[], checks?:any[], fix_marks?:object}[]} rounds
 *   `priorJudgments()` 的形状，旧的在前（items / checks 已经过 normalizeFindings）。
 * @returns 按「没关的在前 → 确定是 bug 在前 → 提出得早的在前」排好序的条目
 */
export function collectItems(rounds) {
  const judged = (rounds ?? []).filter((r) => r && r.judged !== false);
  const state = new Map(openFindings(judged).map((s) => [s.key, s]));
  const byKey = new Map();
  judged.forEach((r, idx) => {
    // 再折一次是幂等的（新形状原样过），但**入口不能只认折过的**：这里也收直接从批注读出来的
    // 原始 items，旧批注照样按同一张表折——两条入口两种结果才是真的坏。
    const { items, checks } = normalizeFindings({ items: r.items, checks: r.checks });
    for (const it of items) {
      const key = String(it?.key ?? "");
      if (!key) continue;
      const prev = byKey.get(key);
      // 同一个 key 被提过好几轮：**留最后一次的正文**（判官后一轮写得更准），但首次提出的轮次要留住
      byKey.set(key, {
        ...it,
        key,
        first_round: prev?.first_round ?? r.round,
        round: r.round,
        trace_id: r.trace_id,
        order: prev?.order ?? idx * 1000 + byKey.size,
        history: [...(prev?.history ?? []), { round: r.round, status: "proposed", note: "" }],
      });
    }
    for (const c of checks) {
      const cur = byKey.get(String(c?.key ?? ""));
      if (!cur) continue;   // 复验的是更早轮次提的、而这份材料没带到的条目：只能跳过，不编一条
      cur.history.push({ round: r.round, status: String(c?.status ?? ""), note: String(c?.note ?? "") });
    }
    for (const [key, m] of Object.entries(asObj(r.fix_marks))) {
      const cur = byKey.get(key);
      if (cur) cur.fix_mark = { ...asObj(m), status: m?.status ?? String(m ?? "") };
    }
  });
  const classRank = (c) => {
    const i = FINDING_CLASSES.indexOf(c);
    return i < 0 ? FINDING_CLASSES.length : i;
  };
  return [...byKey.values()]
    .map((it) => {
      const st = state.get(it.key);
      return { ...it, open: Boolean(st), last_status: st?.last_status ?? "closed", fix_mark: it.fix_mark ?? null };
    })
    .sort((a, b) => Number(b.open) - Number(a.open) || classRank(a.class) - classRank(b.class) || a.order - b.order);
}

/** pointers 里的 span 前缀，去重（工作包要为每个指针导一份 span 详情）。 */
export function pointerSpanIds(items) {
  const out = [];
  for (const it of items ?? []) {
    for (const pt of Array.isArray(it?.pointers) ? it.pointers : []) {
      const id = typeof pt?.span_id === "string" ? pt.span_id.trim() : "";
      if (id && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

/** 按前缀在 trace 里找 span：原样命中优先，唯一前缀命中也算，配到两条以上不算（与回流那道闸同一条判据）。 */
export function findSpanByPrefix(spans, id) {
  const want = String(id ?? "").trim();
  if (!want) return null;
  const list = spans ?? [];
  const exact = list.find((s) => String(s?.span_id ?? "") === want);
  if (exact) return exact;
  const hits = list.filter((s) => String(s?.span_id ?? "").startsWith(want));
  return hits.length === 1 ? hits[0] : null;
}

const clip = (v, n) => {
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 1) ?? "";
  return s.length > n ? `${s.slice(0, n)}\n…（截到前 ${n} 字，完整的在 trace 里）` : s;
};

/**
 * 一个指针指到的那次调用：工具名、入参、返回前 2000 字（§14.3）。
 * 找不到也要出一份，写清「这条 trace 里没有」——静默少一个文件，修的人会以为自己看漏了。
 */
export function renderSpanDoc(spanId, span, { maxOutput = 2000 } = {}) {
  if (!span) {
    return `# span ${spanId}\n\n这条 trace 里找不到它（或前缀配到了两条）。判题的指针可能写错了，或这一轮的 trace 不是挖出它的那一轮。\n`;
  }
  const tags = asObj(span.tags);
  const hyp = tags.hypothesis_id ? `${tags.hypothesis_id}${tags.hypothesis ? ` ${tags.hypothesis}` : ""}` : "";
  return [
    `# ${span.name ?? "(无名)"} · span ${span.span_id}`,
    "",
    `- 类型：${span.kind ?? "?"}　状态：${span.status ?? "?"}　耗时：${span.duration_ms ?? "?"} ms`,
    span.intent ? `- 这一步想干什么：${span.intent}` : "",
    hyp ? `- 挂在哪条假设下：${hyp}` : "",
    "",
    "## 入参",
    "",
    "```json",
    clip(span.input ?? "（没有）", maxOutput),
    "```",
    "",
    "## 返回",
    "",
    "```",
    clip(span.output ?? "（没有）", maxOutput),
    "```",
    "",
  ].filter((l) => l !== "").join("\n");
}

const pointerLine = (pt) => (pt?.span_id
  ? `span ${pt.span_id}（详情见 \`spans/${short(pt.span_id)}.md\`）`
  : `在线取证：${pt?.probe ?? "?"}`);

function markLine(it) {
  if (!it.fix_mark?.status) return "";
  const m = it.fix_mark;
  const who = [m.by, m.at].filter(Boolean).join(" · ");
  return `> 已有修复标记：**${MARK_ZH[m.status] ?? m.status}**${who ? `（${who}）` : ""}${m.note ? `——${m.note}` : ""}\n>\n> 标记是声明不是判决：改没改好由下一轮复验说了算。`;
}

function historyLines(it) {
  if (!it.history?.length) return [];
  const out = [`- 来龙去脉：${it.first_round} 提出`];
  for (const h of it.history) {
    if (h.status === "proposed") continue;
    out.push(`  - ${h.round}：${CHECK_ZH[h.status] ?? h.status}${h.note ? `——${h.note}` : ""}`);
  }
  return out;
}

const section = (it, bodyLines) => [
  `## ${it.open ? "" : "（已关）"}${it.title ?? it.key}`,
  "",
  `- \`key\`：\`${it.key}\`（打修复标记时用它）`,
  `- 类别：${classLabel(it)}`,
  `- 状态：${it.open ? `还没关（最近一次：${it.last_status}）` : "已经关了，下面留着做参照"}`,
  ...historyLines(it),
  ...(it.legacy ? ["- ⚠ 这条来自 2026-09-13 之前的旧批注，是按固定映射读成两类的，字段可能不全"] : []),
  "",
  ...bodyLines,
  "",
  ...(it.pointers?.length ? ["- 指针：", ...it.pointers.map((pt) => `  - ${pointerLine(pt)}`), ""] : []),
  ...(markLine(it) ? [markLine(it), ""] : []),
].join("\n");

const para = (title, text) => [`### ${title}`, "", String(text ?? "").trim() || "（判题没写）", ""];

/** `true-bugs.md`：确定是 bug 的，逐条摆判定链 / 怎么重放 / 修好后该看到什么。 */
export function renderTrueBugs(items) {
  const list = (items ?? []).filter((it) => it.class === "true_bug");
  const head = [
    "# 确定是 bug（判官核实过，可以直接动手）",
    "",
    "判官核实的意思是：原样重放同样错，**并且**从另一条路证明了数据本该有。",
    "动手前仍要**先按 `repro` 重放一遍**——判定链是你信它的依据，不是替你验过了。",
    "重放不复现就别改代码，打 `needs_human` 标记写清你看到了什么。",
    "落点判题方故意不给（它手上没有源码）：拿 `how_verified` 里的工具名、字段名、错误串去五仓里 grep。",
    "",
  ];
  if (!list.length) return `${head.join("\n")}这道题这一档一条都没有。\n`;
  return [
    ...head,
    ...list.map((it) => section(it, [
      ...para("怎么核出来的", it.how_verified),
      ...para("怎么再看见一次（先跑这个）", it.repro),
      ...para("修好之后重放该看到什么", it.expected),
    ])),
  ].join("\n");
}

/** `needs-decision.md`：要人定的，逐条摆请定什么 / 全部上下文。 */
export function renderNeedsDecision(items) {
  const list = (items ?? []).filter((it) => it.class === "needs_decision");
  const head = [
    "# 要人定（先讨论，拍板后再动手）",
    "",
    "把下面每条的「请定什么」与「全部上下文」**原样**摆给人看——不缩写、不换词、不替它总结。",
    "一条摆完等拍板，再摆下一条。拍板三种结果：改（改完打 `claimed_fixed`）/ 不改（`wont_fix`，理由用对方原话）/ 再看看（`needs_human`）。",
    "",
  ];
  if (!list.length) return `${head.join("\n")}这道题这一档一条都没有。\n`;
  return [
    ...head,
    ...list.map((it) => section(it, [
      ...para("请定什么", it.ask),
      ...para("全部上下文", it.context),
    ])),
  ].join("\n");
}

/**
 * `README.md`：修的人开工读的第一份。顺序是有讲究的——**先读判题对整个诊断过程的分析，再读条目**：
 * 知道 agent 是怎么走到那一步的，才知道一条问题在整个诊断里有多要紧。
 */
export function renderReadme({ dataset, record, latest, judgeSummary, items, spanCount }) {
  const meta = asObj(record?.metadata ?? record?.attributes?.metadata);
  const expected = record?.expected_output ?? record?.attributes?.expected_output;
  const roots = Array.isArray(expected?.expected_roots) ? expected.expected_roots : [];
  const open = (items ?? []).filter((it) => it.open);
  const bugs = open.filter((it) => it.class === "true_bug");
  const decide = open.filter((it) => it.class === "needs_decision");
  const marked = open.filter((it) => it.fix_mark?.status);
  return [
    `# 修这道题：${dataset ?? "?"} / ${short(record?.id, 8)}`,
    "",
    "## 题面",
    "",
    String(record?.input?.prompt ?? record?.attributes?.input?.prompt ?? "（用例里没有题面）").trim(),
    "",
    `- 引擎：${meta.engine ?? "（没记）"}　用例编号：${meta.source ?? "（没记）"}　record：\`${record?.id ?? "?"}\``,
    "",
    "## 答案纸（根因）",
    "",
    ...(roots.length ? roots.map((r, i) => `${i + 1}. ${r}`) : ["（这道题没有答案纸——那本身就是一条要人定·题目有问题）"]),
    ...(expected?.notes ? ["", `备注：${expected.notes}`] : []),
    "",
    "## 最新判过的那一轮",
    "",
    latest
      ? [
        `- 轮次：${latest.round}（${latest.created_at ?? "?"}）`,
        `- trace：\`${latest.trace_id}\`　← **修复标记要打在这条 trace 上**`,
        `- 结论：${latest.verdict ?? "?"}　证据：${latest.evidence ?? "?"}`,
        `- 总评：${latest.summary ?? "（判题没写 summary label）"}`,
      ].join("\n")
      : "- 这道题还没判过——没判过就没有条目可修，先跑判题那一棒。",
    "",
    "## 判题对这次诊断过程的分析",
    "",
    String(judgeSummary ?? "").trim() || "（这一轮的 `summary.md` 没回流到 run metadata 的 `judge_summaries` 里——判题那一棒可能没跑 import）",
    "",
    "## 这道题还没关的问题",
    "",
    `- 确定是 bug：${bugs.length} 条 → \`true-bugs.md\``,
    `- 要人定：${decide.length} 条 → \`needs-decision.md\``,
    ...(marked.length ? [`- 其中 ${marked.length} 条已经有修复标记（别重复修，看清标记是谁打的）`] : []),
    `- 机器读的同一份：\`items.json\`（含每条的开关状态与修复标记）`,
    `- 指针指到的调用：\`spans/\`（${spanCount ?? 0} 份）`,
    "",
    "## 顺序",
    "",
    "1. 先读上面那段过程分析，再读条目——不知道 agent 怎么走到那一步，就判不出一条问题有多要紧。",
    "2. 确定是 bug 的：按 `repro` 重放 → 在五仓里 grep 定位 → 改 → 跑该仓测试 → 一条一个提交 → 打 `claimed_fixed`。",
    "3. 要人定的：把 `ask` 与 `context` 原样摆给人，等拍板。",
    "4. 改了哪个仓就部署哪个仓（家族军规 9）——没部署的修复在下一轮复现里看不见。",
    "5. 收尾：页面上这道题会显「已修待复现」，请人点「重复现」。",
    "",
    "```sh",
    `node scripts/llmobs/fix-mark.mjs --trace ${latest?.trace_id ?? "<trace_id>"} --key <key> --status claimed_fixed --note "改了什么" --by $DBDOG_OPERATOR`,
    "```",
    "",
  ].join("\n");
}

/** `items.json`：机器读的同一份（含开关状态与修复标记）。 */
export function itemsJson({ dataset, record, latest, items }) {
  return {
    dataset: dataset ?? null,
    record_id: record?.id ?? null,
    latest_judged: latest ? { round: latest.round, round_id: latest.round_id, trace_id: latest.trace_id, verdict: latest.verdict ?? null, evidence: latest.evidence ?? null } : null,
    open_count: (items ?? []).filter((it) => it.open).length,
    items: (items ?? []).map((it) => ({
      key: it.key,
      class: it.class ?? null,
      decision: it.decision ?? null,
      title: it.title ?? null,
      open: it.open,
      last_status: it.last_status,
      first_round: it.first_round ?? null,
      round: it.round ?? null,
      trace_id: it.trace_id ?? null,
      fix_mark: it.fix_mark ?? null,
      pointers: it.pointers ?? [],
      ...(it.class === "true_bug"
        ? { how_verified: it.how_verified ?? null, repro: it.repro ?? null, expected: it.expected ?? null }
        : { ask: it.ask ?? null, context: it.context ?? null }),
      ...(it.legacy ? { legacy: true } : {}),
    })),
  };
}
