// fix-context.mjs — 修复工作包的**纯函数**层（挑条目、算状态、渲染 markdown），零 I/O、零 fetch。
//
// 单源关系（军规 3）：
//   · 工作包长什么样、给谁看 = dbdog-web `docs/design/llmobs-diag-flywheel.md` §14.3；
//     读它的是 labs `skills/fix-run/SKILL.md` 那条 loop（修复是飞轮第四棒）。
//   · 「哪些还没关」不在这里再算一遍——`judge-quality.mjs` 的 `openFindings` 是唯一那份；
//     旧批注的读法也不在这里——`judge-package.mjs` 的 `normalizeFindings` 是唯一那份。
//   · 渲染给人看的措辞照判卷口径的中文名（确定是 bug / 要人定·说法会误导 …），
//     页面（web `llmobs-fix-items.ts`）与这里叫法一致，修的人两边看到的是同一个词。
import { FINDING_CLASSES, normalizeFindings, fixMarkLabel, fixMarkState } from "./judge-package.mjs";
import { openFindings, latestFixMarks } from "./judge-quality.mjs";

/** 类别与「定的是哪一种」的中文名（页面、终端、工作包三处同一套叫法）。 */
export const CLASS_ZH = { true_bug: "确定是 bug", needs_decision: "要人定" };
export const DECISION_ZH = { wording: "说法会误导", capability: "缺能力", case: "题目有问题", is_bug: "看不出是不是 bug" };
/** 修复标记里的数据情况（§15.5），大白话。标记本身显示成什么字只住 judge-package 的 `fixMarkLabel`。 */
export const DATA_ZH = { unaffected: "数据没受影响", repaired: "数据已修复", unrepairable: "数据修不回来" };
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
  // 修复标记按时间取每个 key 最新的那份（同一个 key 可能在几条 trace 上各打过），挑法只住 judge-quality 一处
  const marks = latestFixMarks(judged);
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
  });
  const classRank = (c) => {
    const i = FINDING_CLASSES.indexOf(c);
    return i < 0 ? FINDING_CLASSES.length : i;
  };
  return [...byKey.values()]
    .map((it) => {
      const st = state.get(it.key);
      return {
        ...it,
        open: Boolean(st),
        last_status: st?.last_status ?? "closed",
        fix_mark: marks.get(it.key) ?? null,
        // 标记之后又有判题复验过或重提过它：标记被盖掉了（关着的条目不看这一格）
        fix_mark_superseded: Boolean(st?.fix_mark_superseded),
      };
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

/** 一条问题的修复标记显示成什么字（终端与工作包同一句；字表单源 judge-package 的 `FIX_MARK_LABELS`）。 */
export const markText = (it) => fixMarkLabel(it?.class, it?.fix_mark);

/** 标记之后这条问题会怎么走——按标记的内容说一句，别让修的人以为打完标记就了事了。 */
function markConsequence(it) {
  if (it.open && it.fix_mark_superseded) return "这份标记之后，又有更晚跑出来的诊断撞上了这条，标记已经不作数，按上面的状态接着修。";
  switch (fixMarkState(it.class, it.fix_mark)) {
    case "verify_passed": return "复测通过即关；之后更晚跑出来的诊断又撞上它，会自动重新打开。";
    case "verify_failed": return "这条还开着。";
    case "unrepairable": return "原窗口里的数据是错的，没法在原窗口复测。";
    case "awaiting_verify": return "部署后在原窗口原样重放 `repro`，用 `--verify` 记下结果。";
    case "awaiting_judge": return "模型会不会换个走法只能靠重跑看，自己重放一次不算数。";
    default: return "";
  }
}

function markLine(it) {
  if (!it.fix_mark?.status) return "";
  const m = it.fix_mark;
  const who = [m.by, m.at].filter(Boolean).join(" · ");
  const data = m.data && m.data !== "unrepairable" && DATA_ZH[m.data] ? `\n>\n> 数据情况：${DATA_ZH[m.data]}` : "";
  const tail = markConsequence(it);
  return `> 已有修复标记：**${markText(it)}**${who ? `（${who}）` : ""}${m.note ? `——${m.note}` : ""}${data}${tail ? `\n>\n> ${tail}` : ""}`;
}

/**
 * 诊断行（诊断表 `case-diagnosis-runs`，或老表 `case-diagnoses`）→ 每个 trace 的复现窗口。
 * 复测就在挖出问题的那次诊断的窗口上原样重放（§15.5），所以工作包得把窗口摆出来，不让修的人去页面上翻。
 * @returns {Map<string,{window_start:string,window_end:string,instance:string|null,expires_at:string|null}>}
 */
export function diagnosisWindows(rows) {
  const out = new Map();
  for (const row of rows ?? []) {
    if (!row?.trace_id || !row.window_start || !row.window_end || out.has(row.trace_id)) continue;
    out.set(row.trace_id, {
      window_start: row.window_start, window_end: row.window_end,
      instance: row.instance || null, expires_at: row.expires_at || null,
    });
  }
  return out;
}

/** 给条目挂上挖出它的那次诊断的窗口，并按 `now` 算好过没过保留期（纯函数：现在几点由调用方给）。 */
export function attachWindows(items, windows, now = Date.now()) {
  return (items ?? []).map((it) => {
    const w = windows?.get?.(it.trace_id);
    if (!w) return { ...it, window: null };
    const exp = Date.parse(w.expires_at ?? "");
    return { ...it, window: { ...w, expired: !Number.isNaN(exp) && exp <= now } };
  });
}

/** 一个窗口的一句话：起止、实例、保留期，以及能不能在上面复测。 */
export function windowText(w) {
  if (!w) return "没找到挖出它的那次诊断的记录（可能是手工发起的诊断），窗口得去页面这道题的「历次」里按 trace 找";
  const where = `${w.window_start} ~ ${w.window_end}${w.instance ? `，实例 ${w.instance}` : ""}`;
  if (w.expired) return `${where}，保留到 ${w.expires_at}——**现场已过期，没法在原窗口复测**`;
  if (!w.expires_at) return `${where}，保留期没记——**复测就在这个窗口上重放**，重放前先确认现场还在`;
  return `${where}，保留到 ${w.expires_at}——**复测就在这个窗口上重放**`;
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

const closedByVerify = (it) => fixMarkState(it.class, it.fix_mark) === "verify_passed";

const section = (it, bodyLines) => [
  `## ${it.open ? "" : "（已关）"}${it.title ?? it.key}`,
  "",
  `- \`key\`：\`${it.key}\`（打修复标记时用它）`,
  `- 类别：${classLabel(it)}`,
  ...(it.issue_type ? [`- 问题类型：${it.issue_type}`] : []),
  `- 状态：${it.open ? `还没关（最近一次：${it.last_status}）` : `${closedByVerify(it) ? "复测通过，" : ""}已经关了，下面留着做参照`}`,
  ...historyLines(it),
  ...(it.window !== undefined ? [`- 挖出它的那次诊断的窗口（trace \`${short(it.trace_id)}\`）：${windowText(it.window)}`] : []),
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
    "判官已核实适用条件下的实际偏差，并说明预期依据及排除正常差异的理由。",
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
 * README 的「复测窗口」一节：还没关的问题按挖出它的 trace 分组，每组一句窗口。
 * 条目没挂过窗口（调用方没取诊断行）就整节不出——不出比出一节「全都没找到」诚实。
 */
function windowSection(open) {
  const withWindow = open.filter((it) => it.window !== undefined);
  if (!withWindow.length) return [];
  const byTrace = new Map();
  for (const it of withWindow) {
    const g = byTrace.get(it.trace_id) ?? { window: it.window, keys: [] };
    g.keys.push(it.key);
    byTrace.set(it.trace_id, g);
  }
  return [
    "## 复测窗口（挖出问题的那次诊断）",
    "",
    ...[...byTrace].map(([trace, g]) => `- trace \`${trace}\`（${g.keys.length} 条：${g.keys.join("、")}）：${windowText(g.window)}`),
    "",
  ];
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
        `- 轮次：${latest.round}（${latest.created_at ?? "?"}）${latest.judged_at ? `　判完：${latest.judged_at}` : ""}`,
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
    ...windowSection(open),
    "## 顺序",
    "",
    "1. 先读上面那段过程分析，再读条目——不知道 agent 怎么走到那一步，就判不出一条问题有多要紧。",
    "2. 确定是 bug 的，逐条：",
    "   1. 按 `repro` 重放，确认还在（不复现就别改代码，打 `needs_human` 写清看到了什么）；",
    "   2. 在五仓里 grep 定位 → 改 → 跑该仓测试 → 一条一个提交；",
    "   3. **部署**：改了哪个仓就部署哪个仓（家族军规 9）——没部署，线上还是旧的；",
    "   4. **判断数据**：直查底层存储，看挖出它的那个窗口里的历史数据对不对——",
    "      本来就对（纯读取或查询错）= `unaffected`；错了、能按确定的规则改回来就改回来 = `repaired`；改不回来（比如当时就没采到）= `unrepairable`；",
    "   5. **原窗口复测**：数据不是 `unrepairable` 的，在挖出它的那次诊断的窗口（见「复测窗口」一节；没有这一节就去页面「历次」里按 trace 找）上原样重放 `repro`，看是不是变成了「修好之后该看到什么」；现场已过期的没法复测，照实写进 `--note`；",
    "   6. **打标记**，带上数据情况与复测结果，`--note` 写重放拿到了什么。",
    "3. 要人定的：把 `ask` 与 `context` 原样摆给人，等拍板；拍板改了的，同第 2 步从「改」往下走。",
    "4. 收尾：告诉人修了几条、复测几条通过、数据修不回来几条，建议他在页面上点哪几个按钮、为什么（飞轮设计 §15.4）。**不自己触发任何重跑**——跑不跑、从哪一步跑由人定。",
    "",
    "```sh",
    `node scripts/llmobs/fix-mark.mjs --trace ${latest?.trace_id ?? "<trace_id>"} --key <key> --status claimed_fixed \\`,
    `  --data unaffected|repaired|unrepairable [--verify passed|failed] --note "改了什么；原窗口重放拿到什么" --by $DBDOG_OPERATOR`,
    "```",
    "",
    "确定是 bug 的，`--verify passed` 即关；复测没过（`failed`）的还开着；数据修不回来的不带 `--verify`，等下次诊断和判题时验证。",
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
      issue_type: it.issue_type ?? null,
      title: it.title ?? null,
      open: it.open,
      last_status: it.last_status,
      first_round: it.first_round ?? null,
      round: it.round ?? null,
      trace_id: it.trace_id ?? null,
      fix_mark: it.fix_mark ?? null,
      fix_mark_label: it.fix_mark?.status ? markText(it) : null,
      fix_mark_superseded: Boolean(it.fix_mark_superseded),
      ...(it.window !== undefined ? { window: it.window } : {}),
      pointers: it.pointers ?? [],
      ...(it.class === "true_bug"
        ? { how_verified: it.how_verified ?? null, repro: it.repro ?? null, expected: it.expected ?? null }
        : { ask: it.ask ?? null, context: it.context ?? null }),
      ...(it.legacy ? { legacy: true } : {}),
    })),
  };
}
