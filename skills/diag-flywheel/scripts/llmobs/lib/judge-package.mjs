// judge-package.mjs — 判题包的**纯函数**层（形状、渲染、解析），零 I/O、零 fetch。
//
// 单源关系（军规 3）：
//   · label 词表与取值形状 = dbdog-web `docs/design/llmobs-diag-flywheel.md` §7.1（问题只分两类）、
//     条目与闭环 §13.3、修复 loop §14；export 写进 manifest、import 按 manifest 的 id 回写、
//     判题 skill 正文（labs `skills/diag-judge/SKILL.md`）按同一张表判——三处共用本文件。
//   · 探针 outcome 四值与同事 skill `evidence-chain` 同口径（`../dbdog-labs/skills/evidence-chain/scripts/check_chain.py` 是它的守门）。
//   · 新调查图直接消费 hook 生成的明确记录视图，不在判题侧重复解析协议。历史树只认 span tags（`hypothesis_id` / `parent_hypothesis_id` / `hypothesis` / `expect` /
//     `resolve`），不在这里再写一份 intent 解析器——那份在 dbdog-labs 的 `claude-code-hooks/hypothesis.mjs`
//     与 dbdog-web 的 `src/lib/llmobs-hypothesis-tree.ts`，书写约定单源是
//     `clients/diag-workdir-template/HYPOTHESIS.md`。派生图缺失不证明 agent 没有提出假设。

/** 版本章五键（D6）。谁经手谁盖，都在 root span 的 tags 上。 */
export const STAMP_KEYS = ["hooks_version", "mcp_version", "skills_digest", "tools_digest", "server_version"];

/** 判题队列名（每个 project 一个）。 */
export const QUEUE_NAME = "diag-judge";

/**
 * label schema（§7.1，2026-09-11 改版）。每个 label 回答一个不用图例就看得懂的问题；
 * `value_type` 走 server 的枚举（boolean / categorical / string / score / json），投影按 value_type 与值的形状算，
 * 不认 label 名（server ADR-0051 附注）。`options` 只有枚举型才发：nil = 不是枚举，`[]` = 是枚举但没配选项——两档不同，别混。
 *
 * 判题方写前三个 + summary；`finding_kinds` 由 import 从 findings 算出（同一件事不写两遍）；
 * `fix_marks` 由修的人用 fix-mark.mjs 写；`rubric_version` 由 import 从包里记的那份写。
 */
/**
 * `verdict` 五档（2026-09-12 加 `not_reproduced`）。
 *
 * 原先 `unknown` 一档扛两件事：没答案纸（题坏了）与**现场不成立**（窗口里现象根本没出来，
 * 诊断做得再对也定位不到）。两件事找的是两拨人——前者回出题那一侧改题，后者回复现那一侧
 * 重跑——压成一个值，跨轮统计就分不开「题库有问题」和「复现有问题」。
 *
 * 早先没拆是因为改枚举值要整份 PUT，而那会级联删光队列里已有的全部批注。那是 server 的 bug
 * （删光重建 + 换新 id），已按 `(queue_id,label)` upsert 修掉；绕道在别处另记一份是糊纸，不是修。
 */
export const VERDICTS = ["correct", "partial", "wrong", "unknown", "not_reproduced"];

export const LABEL_SCHEMA = [
  { label: "verdict", value_type: "categorical", options: VERDICTS, display: "预期根因命中：全部 / 部分 / 未命中 / 无法判断 / 现场不成立" },
  { label: "evidence", value_type: "categorical", options: ["solid", "weak", "unknown"], display: "证据撑不撑得住结论" },
  { label: "findings", value_type: "json", display: "本次问题、判定依据、行为观察与评价限制" },
  { label: "finding_kinds", value_type: "json", display: "这一次有哪两类问题（由 import 从 findings 算出，筛选用）" },
  { label: "finding_types", value_type: "json", display: "本次问题类型（tool / skill / case，由 import 推导）" },
  { label: "summary", value_type: "string", display: "总评（大白话，≤ 600 字符）" },
  { label: "fix_marks", value_type: "json", display: "修复标记（改了等复测 / 复测通过 / 复测没过 / 要人协助 / 不修；fix-mark.mjs 写）" },
  { label: "rubric_version", value_type: "string", display: "判的是哪一版判卷口径（由 import 从包里记的那份写）" },
];

/** 判题方要写的 label（其余由外部脚本维护）。 */
export const JUDGE_WRITTEN_LABELS = ["verdict", "evidence", "findings", "summary"];

export const EVIDENCE_VALUES = ["solid", "weak", "unknown"];

/** 判定类别与问题类型独立；不据此猜修复仓库。 */
export const FINDING_CLASSES = ["true_bug", "needs_decision"];
export const ISSUE_TYPES = ["tool", "skill", "case"];
/** 旧 kind 只用于保留已有类型，不能从 class 反推。 */
export function issueTypeOf(item) {
  if (ISSUE_TYPES.includes(item?.issue_type)) return item.issue_type;
  return ISSUE_TYPES.includes(item?.kind) ? item.kind : null;
}
/** 要人核实或决定什么；未确认缺陷与已知缺口需取舍都属于 needs_decision。 */
export const DECISIONS = ["wording", "capability", "case", "is_bug"];

/** 判官写不了的旧字段：出现即整包拒（读侧另有 `normalizeFindings` 的宽容映射）。 */
export const RETIRED_ITEM_FIELDS = ["kind", "qualifier", "verified", "rule_ref", "suspected_kind", "suggestion", "layer", "fix_where"];

/** 修复标记三值（§13.3）：改了 / 要人协助 / 不修。显示成什么字看 `fixMarkLabel`。 */
export const FIX_MARK_STATUSES = ["claimed_fixed", "needs_human", "wont_fix"];

/**
 * 修复标记里的**数据情况**（§15.5）：库里的历史数据怎么样了。
 * · `unaffected`   纯读取或查询错，库里数据本来就是对的；
 * · `repaired`     数据错了，按确定的规则改回来了；
 * · `unrepairable` 修不回来（比如当时就没采到）——原窗口里没有对的数据，复测不了，只能等重跑。
 *
 * 为什么要记：它决定修完之后**能不能在原窗口复测**，也决定页面建议点哪一个按钮（§15.4）——
 * 修不回来的要新造现场，旧窗口再诊断一百遍查到的也还是错的数据。
 */
export const FIX_MARK_DATA = ["unaffected", "repaired", "unrepairable"];

/**
 * 修复标记里的**复测结果**（§15.5）：部署后在挖出它的那次诊断的原窗口原样重放 `repro`。
 * 「确定是 bug」的 `passed` 即关（不等重跑），`failed` 仍开着。
 */
export const FIX_MARK_VERIFY = ["passed", "failed"];

/**
 * 修复标记的组合校验（fix-mark.mjs 写口用；纯函数，单测钉住）。回问题清单，空 = 合法。
 *
 * 只钉两条组合规则：
 * · 复测只跟 `claimed_fixed` 走——没改就没有「改完在原窗口重放」这回事；
 * · 数据修不回来的不许带复测——原窗口里的数据本身是错的，重放「通过 / 没过」验的都不是这次修复。
 * 两格都不带的旧写法照样合法（2026-09-14 之前打的标记都没有这两格）。
 */
export function fixMarkProblems({ status, data, verify } = {}) {
  const problems = [];
  if (!FIX_MARK_STATUSES.includes(status)) problems.push(`--status 只能是 ${FIX_MARK_STATUSES.join(" / ")}`);
  const has = (v) => v !== undefined && v !== null && v !== "";
  if (has(data) && !FIX_MARK_DATA.includes(data)) {
    problems.push(`--data 只能是 ${FIX_MARK_DATA.join(" / ")}（数据没受影响 / 数据已修复 / 数据修不回来）`);
  }
  if (has(verify)) {
    if (!FIX_MARK_VERIFY.includes(verify)) problems.push(`--verify 只能是 ${FIX_MARK_VERIFY.join(" / ")}`);
    if (status !== "claimed_fixed") problems.push("--verify 只能跟 --status claimed_fixed 一起用：没改就没有「改完在原窗口重放」这回事");
    if (data === "unrepairable") problems.push("--data unrepairable 不能带 --verify：数据修不回来，原窗口里重放验的不是这次修复，只能等重跑");
  }
  return problems;
}

/**
 * 修复标记显示成什么字（2026-09-14 定，脚本里 fix-context / fix-mark / loop-pending / scorecard 统一用这一套）。
 * 字要让人一眼看出**下一步等什么**，所以按类别分：确定是 bug 的在自己这一层复测，别的等下次判题。
 */
export const FIX_MARK_LABELS = {
  awaiting_verify: "改了，等复测",
  verify_passed: "复测通过",
  verify_failed: "复测没过",
  unrepairable: "数据修不回来，等下次诊断和判题时验证",
  awaiting_judge: "改了，等下次判题验证",
  needs_human: "要人协助",
  wont_fix: "不修",
};

/**
 * 一份修复标记 + 它那条问题的类别 → `FIX_MARK_LABELS` 的键；没有标记回 null。
 * 类别认不出按确定是 bug 算（与关单回放的缺省同一条）。
 */
export function fixMarkState(cls, mark) {
  const m = mark && typeof mark === "object" ? mark : (typeof mark === "string" && mark ? { status: mark } : null);
  if (!m?.status) return null;
  if (m.status === "needs_human" || m.status === "wont_fix") return m.status;
  if (m.status !== "claimed_fixed") return null;
  if (cls === "needs_decision") return "awaiting_judge";
  if (m.data === "unrepairable") return "unrepairable";
  if (m.verify === "passed") return "verify_passed";
  if (m.verify === "failed") return "verify_failed";
  return "awaiting_verify";
}

/** 修复标记显示的字；没有标记回空串。 */
export function fixMarkLabel(cls, mark) {
  const st = fixMarkState(cls, mark);
  return st ? FIX_MARK_LABELS[st] : (mark?.status ?? "");
}

/** 探针 outcome 四值（与 evidence-chain 同口径）。 */
export const PROBE_OUTCOMES = ["obtained_match", "obtained_mismatch", "empty_or_error", "no_tool"];

/** 两腿一致性四值。 */
export const PROBE_CONSISTENCY = ["consistent", "tool_bug_suspect", "data_absent", "not_probed"];

// ── span 侧 ────────────────────────────────────────────────────────────────────

/** root 判据与 span-stamp.ts / curate-record.mjs 同一条：没有 parent 且 kind=agent。 */
export function rootSpanOf(spans) {
  return (spans ?? []).find((s) => !s.parent_id && s.kind === "agent") ?? null;
}

/** 版本章：root tags 里那五键，缺的不补（「未盖」是有效结论，不是 0）。 */
export function stampOf(rootSpan) {
  const tags = rootSpan?.tags ?? {};
  const out = {};
  for (const key of STAMP_KEYS) if (tags[key]) out[key] = String(tags[key]);
  return out;
}

const RESOLVE_ZH = { falsified: "证伪", confirmed: "证实", open: "未决" };

function parseResolve(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * 从 span tags 重建假设树。返回 `{ nodes, calls, unlabeled }`：
 *   · nodes：`Map<id, {id, parent, text, expect, type, calls:[], resolves:[]}>`，缺席的父节点补占位；
 *   · calls：全体带 intent 的工具调用，按时间升序，带全局 seq（与控制台的「第几步」同义）；
 *   · unlabeled：没有 `hypothesis_id` tag 的工具调用数。
 */
export function hypothesisTreeFromSpans(spans) {
  const tools = (spans ?? [])
    .filter((s) => s.kind === "tool")
    .sort((a, b) => (a.ts_ms ?? 0) - (b.ts_ms ?? 0) || String(a.span_id).localeCompare(String(b.span_id)));
  const nodes = new Map();
  const calls = [];
  let unlabeled = 0;
  const ensure = (id) => {
    if (!nodes.has(id)) nodes.set(id, { id, parent: undefined, text: "", expect: "", type: "", calls: [], resolves: [] });
    return nodes.get(id);
  };
  tools.forEach((span, i) => {
    const tags = span.tags ?? {};
    const call = {
      seq: i + 1,
      span_id: String(span.span_id ?? ""),
      ts_ms: span.ts_ms ?? 0,
      tool: String(span.name ?? ""),
      intent: String(span.intent ?? ""),
      status: String(span.status ?? ""),
    };
    calls.push(call);
    const id = tags.hypothesis_id;
    if (!id) {
      unlabeled += 1;
      return;
    }
    const node = ensure(String(id));
    if (tags.parent_hypothesis_id) {
      node.parent = String(tags.parent_hypothesis_id);
      ensure(node.parent);
    }
    if (tags.hypothesis && !node.text) node.text = String(tags.hypothesis);
    if (tags.expect) node.expect = String(tags.expect);
    if (tags.hypothesis_type && !node.type) node.type = String(tags.hypothesis_type);
    for (const r of parseResolve(tags.resolve)) {
      node.resolves.push({ ...r, seq: call.seq });
      ensure(String(r.id));
    }
    node.calls.push(call);
  });
  return { nodes, calls, unlabeled };
}

function childrenOf(nodes, parent) {
  return [...nodes.values()]
    .filter((n) => (n.parent ?? undefined) === parent)
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

/**
 * 按父子关系深度优先摊平成 `[{node, depth}]`（同层按编号自然序）。
 * **树的形状只在这一处定义**：`forward.md` 的缩进列表与训练语料的 `hypothesis_tree`
 * 走同一条遍历，两边的节点顺序天然一致（军规 3：同一事实一个 owning path）。
 * 父节点不在本 trace 里的（`ensure` 补过占位就不会有；防御性保留）单独跟在后面，depth=0。
 */
export function orderedHypothesisNodes(nodes) {
  const out = [];
  const walk = (parent, depth) => {
    for (const node of childrenOf(nodes, parent)) {
      out.push({ node, depth });
      walk(node.id, depth + 1);
    }
  };
  walk(undefined, 0);
  const seen = new Set(out.map(({ node }) => node.id));
  for (const node of nodes.values()) {
    if (!seen.has(node.id)) out.push({ node, depth: 0 });
  }
  return out;
}

/** 某个假设被哪次调用收了口：原样的 verdict（`confirmed` / `falsified` / `open` / …），没收口回 null。 */
export function resolveVerdictOf(nodes, id) {
  for (const node of nodes.values()) {
    for (const r of node.resolves) if (String(r.id) === String(id)) return String(r.verdict);
  }
  return null;
}

function verdictOf(nodes, id) {
  const raw = resolveVerdictOf(nodes, id);
  if (raw === null) return "未收口";
  return RESOLVE_ZH[raw] ?? raw;
}

/**
 * 假设树的**结构化形**（`hypothesisTreeFromSpans` 的 JSON 投影，零 I/O）。
 * `forward.md` 给人读、这份给训练语料读，**同一份树、同一个遍历**——不是第二份解析器。
 * 节点里 `parent` 缺席写 null（顶层），`resolve` 是这个编号被收口的记录（可能来自别的节点名下）。
 */
export function hypothesisTreeJson(spans) {
  const { nodes, calls, unlabeled } = hypothesisTreeFromSpans(spans);
  return {
    // false = 那次会话没按 `clients/diag-workdir-template/HYPOTHESIS.md` 写假设，
    // 只有调用序列。判题/训练时别把它当成「agent 没想」（军规 1：分不清就如实说）。
    written: nodes.size > 0,
    tool_calls: calls.length,
    unlabeled_calls: unlabeled,
    nodes: orderedHypothesisNodes(nodes).map(({ node, depth }) => ({
      id: node.id,
      parent: node.parent ?? null,
      depth,
      hypothesis: node.text || null,
      expect: node.expect || null,
      type: node.type || null,
      resolve: resolveVerdictOf(nodes, node.id),
      calls: node.calls.map((c) => ({
        seq: c.seq, span_id: c.span_id, name: c.tool, intent: c.intent || null, status: c.status || null,
      })),
    })),
  };
}

function clip(s, n) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * `forward.md`：正向假设树 + 按时间的工具调用 + root 结论。
 * 与 span-graph 的 `forward-path.md` 同构（假设树 / 出现顺序 / 收口 / 未挂到假设的调用）。
 */
export function renderForward(spans, { eventId = "", traceId = "", investigationGraph = null } = {}) {
  const root = rootSpanOf(spans);
  const { nodes, calls, unlabeled } = hypothesisTreeFromSpans(spans);
  const lines = [];
  lines.push(`# 正向：这次诊断实际走的路`);
  lines.push("");
  lines.push(`- 用例（event）：\`${eventId || "—"}\`　trace：\`${traceId || root?.trace_id || "—"}\``);
  lines.push(`- span 合计 ${(spans ?? []).length}，工具调用 ${calls.length}，其中挂到假设的 ${calls.length - unlabeled}`);
  const stamp = stampOf(root);
  lines.push(`- 版本章：${STAMP_KEYS.map((k) => `${k}=${stamp[k] ?? "未盖"}`).join("　")}`);
  lines.push("");

  const response = investigationGraph;
  const inv = response?.graph?.investigation;
  const view = inv?.views?.hypothesis_view;
  const currentTrace = traceId || root?.trace_id;
  const explicitSpans = (spans ?? []).filter(s => ["llm", "agent"].includes(s.kind) && /```dbdog-investigation\s/.test(s.output_local ?? s.output ?? ""));
  const usable = response?.status === "ok" && response.trace_id === currentTrace && response.stale === false &&
    inv?.version === 1 && Array.isArray(view?.nodes) && Array.isArray(view?.edges) && Array.isArray(view?.relations);
  if (usable) {
    lines.push("## 明确调查记录", "", "以下为当前 trace 的派生视图。节点状态由诊断模型声明；引用匹配不等于归因正确。原文见 trace.json，完整记录与覆盖信息见 investigation.json。", "");
    lines.push(`- 问题：${view.root?.question ?? "未记录"}；状态：${view.root?.state ?? "未记录"}`);
    for (const n of view.nodes) {
      lines.push(`- **[${n.id}]** ${n.claim} — ${n.state}`);
      lines.push(`  - 判定：${n.decision_summary ?? "未记录"}；引用检查：${n.reference_check ?? "未记录"}`);
      const refs = (n.key_evidence ?? []).flatMap(o => (o.sources ?? []).map(s => `${o.observation}: ${s.ref}`));
      if (refs.length) lines.push(`  - 证据入口：${refs.join("；")}`);
    }
    lines.push("", "### 追问方向（不表示因果已证明）");
    for (const e of view.edges) lines.push(`- ${e.from} → ${e.to}：${e.reason}`);
    if (view.unplaced?.length) lines.push(`- 未关联：${view.unplaced.join("、")}`);
    lines.push("", "### 独立因果与条件关系");
    for (const r of view.relations) lines.push(`- ${r.id}: ${[r.from].flat().join(" + ")} → ${r.to}；${r.type}；${r.state}；${r.claim ?? ""}`);
    if (view.root?.state !== "active" && view.conclusion) lines.push("", `记录的结束理由：${view.conclusion.reason}`, `结论采用假设：${(view.conclusion.answer_hypotheses ?? []).join("、")}`);
    else lines.push("", "当前没有有效结束记录；不能把此前 finish 当作当前结束。");
    if (inv.diagnostics?.length) lines.push(`记录检查存在 ${inv.diagnostics.length} 项缺口；见 investigation.json。这不自动构成 agent 或 skill 缺陷。`);
  } else if (explicitSpans.length || inv) {
    lines.push("## 明确调查记录", "", "派生调查图缺失、版本不支持、范围不匹配或覆盖落后；不以旧 hypothesis_id 判断新协议是否记录了假设。请核对 trace.json 中的实际声明及工具返回。", "");
    for (const s of explicitSpans) lines.push(`- 明确事件入口：span \`${s.span_id}\``);
  } else if (nodes.size === 0) {
    lines.push("## 假设树");
    lines.push("");
    lines.push("没有可用的派生假设记录，以下保留调用序列。核对 trace.json 中的原始声明；缺少旧 hypothesis_id 本身不能证明 agent 没有提出假设，也不能自动归为 skill 缺陷。");
  } else {
    lines.push("## 假设树");
    lines.push("");
    for (const { node, depth } of orderedHypothesisNodes(nodes)) {
      const pad = "  ".repeat(depth);
      const type = node.type === "cause" ? "根因" : node.type === "confirm" ? "现象确认" : "类型未写";
      lines.push(`${pad}- **[${node.id}]** ${node.text || "（假设正文缺失：该编号第一次出现时没写 假设=）"}`);
      lines.push(`${pad}  - 类型 ${type}　结论 ${verdictOf(nodes, node.id)}　取证 ${node.calls.length} 次`);
      if (node.expect) lines.push(`${pad}  - 判据：${clip(node.expect, 200)}`);
      if (node.calls.length) {
        lines.push(`${pad}  - 调用：${node.calls.map((c) => `#${c.seq} \`${c.tool}\`（span \`${c.span_id ?? "—"}\`）`).join("、")}`);
      }
    }
    const orphan = [...nodes.values()].filter((n) => n.parent && !nodes.has(n.parent));
    for (const node of orphan) lines.push(`- **[${node.id}]**（父 ${node.parent} 在本 trace 里没出现过）`);
    lines.push("");
    lines.push("## 假设收口");
    lines.push("");
    const closings = [...nodes.values()].flatMap((n) => n.resolves.map((r) => ({ ...r, by: n.id })));
    if (closings.length === 0) lines.push("（没有任何一次调用写了 `关=`——所有假设都没在取证里收口。）");
    for (const c of closings.sort((a, b) => a.seq - b.seq)) {
      lines.push(`- 第 ${c.seq} 步（[${c.by}] 名下）把 **${c.id}** 判成 **${RESOLVE_ZH[c.verdict] ?? c.verdict}**`);
    }
  }
  lines.push("");

  lines.push("## 工具调用（按时间）");
  if (usable || explicitSpans.length || inv) lines.push("新协议的检查与证据关联见调查记录；下表的假设列仅为历史 tags，不用于补造关联。");
  lines.push("");
  // span 列不是装饰：每条问题的 pointers 要指到 span_id，回流会拿它跟 trace.json 对。
  // 而判官被告知「trace.json 几 MB 不要通读，看 forward.md」——摘要里不打 span_id，
  // 就等于逼他去翻几 MB 原文，或者编一个（编的会被整包拒）。
  lines.push("| # | span | 工具 | 假设 | 状态 | 意图 |");
  lines.push("|---|---|---|---|---|---|");
  const idOf = new Map();
  for (const node of nodes.values()) for (const c of node.calls) idOf.set(c.seq, node.id);
  for (const c of calls) {
    lines.push(`| ${c.seq} | \`${c.span_id ?? "—"}\` | \`${c.tool}\` | ${idOf.get(c.seq) ? `[${idOf.get(c.seq)}]` : "未挂"} | ${c.status || "—"} | ${clip(c.intent, 160) || "—"} |`);
  }
  if (calls.length === 0) lines.push("| — | （这条 trace 一次工具都没调） | — | — | — |");
  lines.push("");

  lines.push("## 结论（root span output 原文）");
  lines.push("");
  lines.push(root?.output ? String(root.output) : "（root span 没有 output——多半是超时被杀后收尸补的 root。）");
  lines.push("");
  return lines.join("\n");
}

// ── 反向链 / 答案纸 ────────────────────────────────────────────────────────────

/** `reverse.md`：反向证据链（record.metadata.reverse_chain）。`.json` 原样另存，本函数只渲染。 */
export function renderReverse(chain, { recordId = "" } = {}) {
  const lines = [`# 反向：这个根因本该留下哪些痕迹`, ""];
  if (recordId) lines.push(`- 用例 record：\`${recordId}\``, "");
  if (typeof chain === "string") return `${lines.join("\n")}\n${chain}\n`;
  const c = chain ?? {};
  for (const [heading, key] of [["What happened", "what_happened"], ["Why that broke things", "why"], ["The root cause", "root_cause"], ["What to do to fix", "fix"]]) {
    if (c[key]) lines.push(`## ${heading}`, "", typeof c[key] === "string" ? c[key] : JSON.stringify(c[key], null, 1), "");
  }
  const evidence = Array.isArray(c.evidence_chain) ? c.evidence_chain : [];
  lines.push("## How do we know（证据）", "");
  if (evidence.length === 0) {
    lines.push("（反向链里没有 `evidence_chain`——这份链是残的，判题时按「材料不全」写进 summary。）", "");
  } else {
    lines.push("| E | 档 | 该用的工具 | 入参 | 取证结果 | 推论 |");
    lines.push("|---|---|---|---|---|---|");
    for (const e of evidence) {
      lines.push(`| ${e.id ?? "?"} | ${e.tier ?? "—"} | ${e.tool ? `\`${e.tool}\`` : (e.source === "unavailable" ? "**无工具**" : "—")} | ${clip(e.params, 90) || "—"} | ${e.outcome ?? "—"} | ${clip(e.inference, 120) || "—"} |`);
    }
    lines.push("");
  }
  const findings = Array.isArray(c.dbdog_findings) ? c.dbdog_findings : [];
  lines.push("## 附录：dbdog 侧发现", "");
  if (findings.length === 0) lines.push("（无。）", "");
  for (const f of findings) lines.push(`- **${f.evidence_id ?? "?"}** ${f.kind ?? ""}：${clip(f.detail, 240)}（影响：${f.impact ?? "—"}）`);
  if (c.consistency?.verdict) {
    lines.push("", "## 讲不讲得通", "", `结论 **${c.consistency.verdict}**：${clip(c.consistency.verdict_why, 400)}`, "");
  }
  return `${lines.join("\n")}\n`;
}

/** `ground-truth.md`：答案纸（experiment event 的 expected_output；整个可缺 = 无参照题）。 */
export function renderGroundTruth(expected, { eventId = "", corrected = false } = {}) {
  const lines = [`# 答案纸`, ""];
  if (eventId) lines.push(`- 用例（event）：\`${eventId}\``, "");
  // 答案纸在这一轮跑完之后被改过：判官得知道自己按的是哪一份，否则「agent 当时对着的那份说 X、
  // 你手上这份说 Y」会被读成 agent 判错。
  if (corrected) lines.push("- ⚠ **这份答案纸在这一轮诊断跑完之后被更正过**（判题按现在这份判：答案纸是我们对这个 bug 的判断，更正后回溯适用）", "");
  if (typeof expected === "string") return `${lines.join("\n")}\n${expected}\n`;
  const e = expected ?? {};
  if (Array.isArray(e.expected_roots) && e.expected_roots.length) {
    // 有序列表不是排版偏好：判题方要按**这个顺序**把命中的根因编号写进 `findings.roots`，
    // 用无序列表他得自己数，数错就是整包拒。
    lines.push("## 期望根因", "", ...e.expected_roots.map((r, i) => `${i + 1}. ${r}`), "");
  }
  // 修复**单独一段**（owner 2026-09-11 定）：判题只拿「期望根因」那一组算命中，修复是给人复核用的。
  // 混在根因里时，判官面对 PR 链接只有两个选择——标成命中（分数虚高）或标成没命中（把对的诊断判成 partial）。
  if (Array.isArray(e.expected_fix) && e.expected_fix.length) {
    lines.push("## 修复（不参与判分）", "", ...e.expected_fix.map((r) => `- ${r}`), "");
  }
  if (Array.isArray(e.expected_phenomena) && e.expected_phenomena.length) {
    lines.push("## 期望现象", "", ...e.expected_phenomena.map((r) => `- ${r}`), "");
  }
  if (Array.isArray(e.expected_behaviors) && e.expected_behaviors.length) {
    lines.push("## 行为基准", "", ...e.expected_behaviors.map((r) => `- ${r}`), "");
  }
  if (e.notes) lines.push("## 附注", "", String(e.notes), "");
  const known = new Set(["expected_roots", "expected_fix", "expected_phenomena", "expected_behaviors", "notes"]);
  const rest = Object.fromEntries(Object.entries(e).filter(([k]) => !known.has(k)));
  if (Object.keys(rest).length) lines.push("## 其余字段（原样）", "", "```json", JSON.stringify(rest, null, 1), "```", "");
  return `${lines.join("\n")}\n`;
}

/** 答案纸整个可缺（无参照题，不另设标志字段）——空对象也算缺。 */
export function hasGroundTruth(expected) {
  if (expected === null || expected === undefined) return false;
  if (typeof expected === "string") return expected.trim() !== "";
  if (typeof expected !== "object") return false;
  return Object.keys(expected).length > 0;
}

// ── 回传件解析 ────────────────────────────────────────────────────────────────

/**
 * 解析 `annotations.jsonl`：每行一个 `{trace_id, labels:{…}}`。
 * 返回 `{rows, problems}`——**格式错不静默丢**：丢一行 = 少判一例，而 import 会「成功」退出。
 * 同一 trace_id 出现多次时后写赢（改判是覆盖，D5），并记一条 problem 提示。
 */
export function parseAnnotationsJsonl(text) {
  const rows = [];
  const problems = [];
  const seen = new Map();
  const lines = String(text ?? "").split("\n");
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      problems.push(`第 ${i + 1} 行不是合法 JSON：${e.message}`);
      return;
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      problems.push(`第 ${i + 1} 行不是 JSON 对象`);
      return;
    }
    const traceId = typeof obj.trace_id === "string" ? obj.trace_id.trim() : "";
    if (!traceId) {
      problems.push(`第 ${i + 1} 行缺 trace_id——回流时找不到 interaction`);
      return;
    }
    const labels = obj.labels && typeof obj.labels === "object" && !Array.isArray(obj.labels) ? obj.labels : null;
    if (!labels) {
      problems.push(`第 ${i + 1} 行（${traceId}）缺 labels 对象`);
      return;
    }
    const labelProblems = validateLabels(labels);
    problems.push(...labelProblems.map((p) => `第 ${i + 1} 行（${traceId}）${p}`));
    // 形状不合契约的行照样交回去（import 据此整包拒写，不是悄悄丢一行）
    const row = { trace_id: traceId, labels, line: i + 1, ...(labelProblems.length ? { invalid: labelProblems } : {}) };
    if (seen.has(traceId)) {
      problems.push(`第 ${i + 1} 行：trace_id ${traceId} 重复，按后写赢覆盖第 ${seen.get(traceId)} 行`);
      rows[rows.findIndex((r) => r.trace_id === traceId)] = row;
    } else {
      seen.set(traceId, i + 1);
      rows.push(row);
    }
  });
  return { rows, problems };
}

/* ── 问题条目与复验（飞轮设计 §13.3：「每次改哪里拆成一条一条」「修没修好看实际效果，不依赖人的反馈」） ── */

/** 复验结果：修好了 / 又撞上了 / 这一轮没走到那条路（不算数）。 */
export const FIX_CHECK_STATUSES = ["fixed", "still_open", "not_exercised"];

/**
 * 条目 key：小写 ascii，形如 `<工具或现象>.<缺什么>`。它是跨轮次认「同一个问题」的唯一依据——
 * 换个说法再提一遍就数不清修没修，所以要短、要稳、要能 grep。
 * **按症状取名，不按落点**（不写 `server.` / `agent.` 前缀）：落点是猜的，key 一旦定了改不动。
 */
export const FIX_KEY_RE = /^[a-z0-9][a-z0-9._-]{2,79}$/;

function pointerProblems(where, pointers, required) {
  const out = [];
  const list = Array.isArray(pointers) ? pointers : [];
  if (required && list.length === 0) out.push(`${where}.pointers 为空（每条都得指到 span_id 或在线取证行）`);
  for (const pt of list) {
    if (!pt || typeof pt !== "object" || (!pt.span_id && !pt.probe)) {
      out.push(`${where}.pointers 里的 ${JSON.stringify(pt)} 既不是 {span_id} 也不是 {probe}`);
    }
  }
  return out;
}

const nonEmpty = (v) => typeof v === "string" && v.trim().length > 0;

/** 当前输出契约在 diag-judge/references/output.md；无 scope 的旧包沿用历史校验以兼容在途产物。
 * 新包必须 scope=current，禁止 checks。读取旧字段的转换只住 normalizeFindings。
 */
export function validateFindings(a) {
  const problems = [];
  if (!a || typeof a !== "object" || Array.isArray(a)) return ["findings 必须是对象"];
  if ("fix_where" in a && !("items" in a)) {
    return ["findings 是旧形状（顶层一段 fix_where）——改成当前输出契约：items[] 一条一个问题"];
  }
  if (a.scope !== undefined && a.scope !== "current") problems.push("findings.scope 只能是 current");
  if (a.scope === "current") {
    if (a.checks !== undefined) problems.push("单次判题不输出 findings.checks，不读取或复验历史问题");
    if (typeof a.rationale !== "string" || !a.rationale.trim()) problems.push("findings.rationale 必填：本次根因与证据判定依据");
    if (!Array.isArray(a.items)) problems.push("findings.items 必须是数组");
    if (!Array.isArray(a.limitations) || a.limitations.some((x) => typeof x !== "string" || !x.trim())) {
      problems.push("findings.limitations 必须是非空字符串的数组（无限制写 []）");
    }
    if (!Array.isArray(a.observations)) problems.push("findings.observations 必须是数组");
    for (const [i, observation] of (Array.isArray(a.observations) ? a.observations : []).entries()) {
      const w = `findings.observations[${i}]`;
      if (!nonEmpty(observation?.title) || !nonEmpty(observation?.detail)) problems.push(`${w} 需要 title 和 detail（事实及影响）`);
      problems.push(...pointerProblems(w, observation?.pointers, true));
    }
  }
  const items = a.items ?? [];
  const checks = a.checks ?? [];
  if (!Array.isArray(items)) problems.push("findings.items 必须是数组");
  if (!Array.isArray(checks)) problems.push("findings.checks 必须是数组");
  const keys = new Set();
  (Array.isArray(items) ? items : []).forEach((it, i) => {
    const w = `findings.items[${i}]`;
    if (!it || typeof it !== "object") return problems.push(`${w} 必须是对象`);
    if (!FIX_KEY_RE.test(String(it.key ?? ""))) problems.push(`${w}.key ${JSON.stringify(it.key)} 不合规（小写 ascii，形如 <工具或现象>.<缺什么>，按症状取名不按落点）`);
    else if (keys.has(it.key)) problems.push(`${w}.key ${it.key} 重复——一个问题只提一条`);
    else keys.add(it.key);
    if (!FINDING_CLASSES.includes(it.class)) {
      problems.push(`${w}.class ${JSON.stringify(it.class)} 只能是 ${FINDING_CLASSES.join(" / ")}` +
        "（判据只有一句：你自己核实了它是确定性的错吗）");
    }
    if (!nonEmpty(it.title)) problems.push(`${w}.title 缺失（一句话，≤ 40 字，说谁在哪出了什么事）`);
    // 旧口径的字段出现即拒，一个一个点名：报「未知字段」判官改不动，它得知道这一栏搬去了哪。
    for (const f of RETIRED_ITEM_FIELDS) {
      if (it[f] === undefined) continue;
      problems.push(`${w}.${f} 是 2026-09-13 之前的旧字段，已经没有了：` +
        "问题只分两类（true_bug / needs_decision），确定是 bug 的写 how_verified / repro / expected，" +
        "要人定的写 decision / ask / context；判题不说怎么修、不说改哪里");
    }
    if (it.issue_type !== undefined && !ISSUE_TYPES.includes(it.issue_type)) problems.push(`${w}.issue_type 只能是 tool / skill / case`);
    if (a.scope === "current") {
      if (!ISSUE_TYPES.includes(it.issue_type)) problems.push(`${w}.issue_type 必填`);
      if (it.class === "true_bug" && it.issue_type !== "tool") problems.push(`${w}：true_bug 只用于已核实的工具或相关数据链路缺陷`);
      if (it.issue_type === "skill" && it.decision !== "wording") problems.push(`${w}：skill 问题应说明 wording 决定`);
      if (it.issue_type === "case" && it.decision !== "case") problems.push(`${w}：case 问题应说明 case 决定`);
    }
    if (it.class === "true_bug") {
      // 判定链、重放、修好后该看到什么——三样是**下游不必再核一遍**的最小集合。
      // 缺 how_verified 就退化成「我觉得它错了」；缺 repro 这一条永远关不掉（关单判据就是重放变对）。
      if (!nonEmpty(it.how_verified)) {
        problems.push(`${w}.how_verified 缺失（确定是 bug 必填：实际偏差 / 核实结果 / 预期依据 / 为什么不是正常条件差异）`);
      }
      if (!nonEmpty(it.repro)) problems.push(`${w}.repro 缺失（确定是 bug 必填：文字说明条件、工具或操作、关键入参、实际表现；不要求脚本）`);
      if (!nonEmpty(it.expected)) problems.push(`${w}.expected 缺失（确定是 bug 必填：修好之后重放该看到什么，不是「去哪儿改」）`);
    }
    if (it.class === "needs_decision") {
      if (!DECISIONS.includes(it.decision)) {
        problems.push(`${w}.decision ${JSON.stringify(it.decision)} 只能是 ${DECISIONS.join(" / ")}` +
          "（说法会误导 / 缺能力 / 题目有问题 / 看不出是不是 bug）");
      }
      if (!nonEmpty(it.ask)) problems.push(`${w}.ask 缺失（要人定必填：一句「请定：…」或「请核：…」）`);
      // 上下文要让人不用回头翻 trace：缺了它，人只能自己去查一遍，那这条分诊就白做了。
      if (!nonEmpty(it.context)) {
        problems.push(`${w}.context 缺失（要人定必填：原句 / 原调用逐字、模型在本例里怎么读的、走到哪、本该到哪；禁行话与自造词，带本例例子）`);
      }
    }
    problems.push(...pointerProblems(w, it.pointers, true));
  });
  (Array.isArray(checks) ? checks : []).forEach((c, i) => {
    const w = `findings.checks[${i}]`;
    if (!c || typeof c !== "object") return problems.push(`${w} 必须是对象`);
    if (!FIX_KEY_RE.test(String(c.key ?? ""))) problems.push(`${w}.key ${JSON.stringify(c.key)} 不合规`);
    if (!FIX_CHECK_STATUSES.includes(c.status)) problems.push(`${w}.status 只能是 ${FIX_CHECK_STATUSES.join(" / ")}`);
    // `still_open` 的 class 必填：`finding_kinds` 只把**带 class** 的 still_open 算进去，
    // 缺了这条问题就不进页面的类别筛选——「又撞上了」却在类别里查无此人。
    if (c.status === "still_open" && !FINDING_CLASSES.includes(c.class)) {
      problems.push(`${w}.class 缺失或不在词表里（${FINDING_CLASSES.join(" / ")}）：又撞上的那条要带类别（照原条目），否则页面上这个问题不显形`);
    } else if (c.class !== undefined && !FINDING_CLASSES.includes(c.class)) {
      problems.push(`${w}.class ${JSON.stringify(c.class)} 不在词表里（${FINDING_CLASSES.join(" / ")}）`);
    }
    if (c.kind !== undefined) problems.push(`${w}.kind 是旧字段：复验带的是 class（${FINDING_CLASSES.join(" / ")}），照原条目写`);
    problems.push(...pointerProblems(w, c.pointers, c.status === "fixed" || c.status === "still_open"));
    if (keys.has(c.key)) problems.push(`${w}.key ${c.key} 同时出现在 items 里——又撞上的只写 still_open 复验，不要再提一条`);
  });
  // `roots.extra`：agent 报了答案纸上**没有**的根因（2026-09-12 加）。
  // 可能是它对（答案纸不全 → 该记一条要人定·题目有问题），也可能是它编的（→ 归 evidence 与 roots 记下）；
  // 两种都值钱，而此前 roots 只有 matched / missed 两格，这一类观察连落脚处都没有。
  // **不参与 verdict 推导**：verdict 只按答案纸上那几条算，多说的另算，否则口径一改就没法重算历史。
  const extra = a.roots?.extra;
  if (extra !== undefined) {
    if (!Array.isArray(extra) || extra.some((x) => typeof x !== "string" || !x.trim())) {
      problems.push("findings.roots.extra 只能是非空字符串的数组（agent 多说的每条根因写一句话）");
    }
  }
  return problems;
}

/**
 * 这一条批注里的**弃判** = `decision: is_bug` 的条目：已做必要取证，仍分不开「丢了」和「本来就没有」。
 *
 * 单独算是因为弃判与「挖到一个问题」不是一回事（Autorubric 的 `CANNOT_ASSESS`、以及 rubric 判题
 * 一致性测量的惯例：弃判率要与一致率分开报）。混在产量里看，会让「这轮挖到几条确定的 bug」
 * 和「这轮有几条没敢定」长得一样；而这两件事要采取的动作完全相反——前者去修，后者去核。
 */
export function deriveAbstention(findings) {
  const { items } = normalizeFindings(findings);
  const keys = [];
  let count = 0;
  for (const it of items) {
    if (it?.class !== "needs_decision" || it?.decision !== "is_bug") continue;
    count += 1;
    if (it?.key && !keys.includes(it.key)) keys.push(String(it.key));
  }
  return { count, keys };
}

/**
 * 根因集合 → 三值。**verdict 是推出来的，不是判官填的**：答案纸里的根因不止一条时
 * （`expected_roots` 本来就是数组），「命中一条算不算对」原先没有口径，各判各的。
 * 口径按 owner 2026-09-06 定的那句：找齐 / 找到一部分 / 没找到。
 *
 * 记集合还有第二个好处：**口径以后再改，历史轮次能重算，不用重判**——AIOps 的根因评测
 * （RCAEval 等）用 precision / recall / AC@k 也是同一个理由：先留下命中集合，再谈怎么折算。
 */
export function deriveVerdictFromRoots(roots) {
  const matched = Array.isArray(roots?.matched) ? roots.matched : [];
  const missed = Array.isArray(roots?.missed) ? roots.missed : [];
  if (matched.length === 0) return "wrong";
  return missed.length === 0 ? "correct" : "partial";
}

/**
 * 跟**这道题的材料**对一遍——`validateLabels` 只看得见批注自己，这一层看得见答案纸与轨迹。
 *
 * 两件事：
 * ① 根因集合与答案纸对得上，且 `verdict` 与集合推导的一致（判官把「命中一条」写成 `correct`
 *    是这条 loop 最贵的错：分数是它的主产出之一）；
 * ② **指针能在轨迹里找到**。原先只校验形状（是不是 `{span_id}`），而 TRAIL 的结论是长轨迹下
 *    模型的错误定位准确率极低、部分模型连完整轨迹都读不下——只校验形状等于在鼓励编 span id。
 *    判官常写前 8 位，所以前缀唯一命中也算数；配到两条以上不算（指到「某几步之一」等于没指）。
 *
 * @param {object} labels 一行批注的 labels
 * @param {{ expectedRoots?: string[], spanIds?: string[] }} ctx 这道题的答案纸根因（顺序即编号）与这条 trace 的 span 清单。
 *   **给不出就不查**：蓝区离线包可能没带 trace.json，宁可不拦，也不假装校验过。
 */
export function validateAgainstCase(labels, ctx = {}) {
  const problems = [];
  const f = labels?.findings;
  if (ctx.scope === "current" && f?.scope !== "current") problems.push("本包只判当前诊断，findings.scope 必须是 current");
  const roots = (f && typeof f === "object" && !Array.isArray(f)) ? f.roots : undefined;
  const expected = ctx.expectedRoots;

  if (Array.isArray(expected)) {
    if (expected.length === 0) {
      // 无答案纸 = 题坏了（不是「判不出」）：verdict 只能 unknown，也没有集合可记。
      if (labels?.verdict !== undefined && labels.verdict !== "unknown") {
        problems.push(`这道题没有答案纸，verdict 只能是 unknown（现在是 ${JSON.stringify(labels.verdict)}）——没有答案纸就没有「对」这个判断`);
      }
      if (roots !== undefined) problems.push("这道题没有答案纸，findings.roots 不该有值——先回建用例那一步补根因");
    } else if (f?.scope === "current" && labels?.verdict === "unknown") {
      if (!Array.isArray(f.limitations) || !f.limitations.length) problems.push("有答案纸但无法判根因，必须说明 limitations");
      if (roots !== undefined) problems.push("verdict=unknown 不填写 roots，不把未判强行记为未命中");
    } else if (labels?.verdict === "not_reproduced") {
      // 现场不成立：现象根本没出来，「agent 找没找到根因」这件事本身就不成立，不要求划集合。
      // 也不拿集合去核 verdict——这一档的下一步是回复现那一侧重跑，不是算分。
      if (roots !== undefined) problems.push("这次现场不成立（verdict=not_reproduced），findings.roots 不该有值——现象都没出来，谈不上命中");
    } else if (!roots || typeof roots !== "object" || Array.isArray(roots)) {
      problems.push(`findings.roots 缺失：答案纸有 ${expected.length} 条根因，要按顺序编号划进 matched / missed`);
    } else {
      const matched = Array.isArray(roots.matched) ? roots.matched : [];
      const missed = Array.isArray(roots.missed) ? roots.missed : [];
      const all = [...matched, ...missed];
      const seen = new Set();
      for (const n of all) {
        if (!Number.isInteger(n)) {
          // 最常见的写法错误是把根因原文抄进来。说「越界」会让人往数字上找问题，说不到点子上。
          problems.push(`findings.roots 里的 ${JSON.stringify(n)} 不是编号：这里只写数字（答案纸里根因的出现序号，1..${expected.length}），不写根因原文`);
          continue;
        }
        if (n < 1 || n > expected.length) {
          problems.push(`findings.roots 里的 ${JSON.stringify(n)} 越界：答案纸只有 ${expected.length} 条根因，编号 1..${expected.length}`);
          continue;
        }
        if (seen.has(n)) problems.push(`findings.roots 里第 ${n} 条根因重复：一条根因只能算命中或没命中之一`);
        seen.add(n);
      }
      const absent = [];
      for (let i = 1; i <= expected.length; i++) if (!seen.has(i)) absent.push(i);
      if (absent.length) problems.push(`findings.roots 漏了第 ${absent.join(" / ")} 条根因：答案纸上每一条都要表态（命中或没命中）`);
      // 集合本身有问题时不拿它推 verdict（推出来的没意义），但**要说一句**——
      // 不说的话判官改完集合、下一轮才撞上 verdict 这条，又白烧一次判题会话。
      if (labels?.verdict !== undefined) {
        if (problems.length) {
          problems.push(`verdict 这次没核：上面的根因集合先改对（改完请自查——找齐 correct / 找到一部分 partial / 一条没找到 wrong）`);
        } else {
          const derived = deriveVerdictFromRoots({ matched, missed });
          if (labels.verdict !== derived) {
            problems.push(`verdict ${JSON.stringify(labels.verdict)} 与根因集合对不上：命中 ${matched.length}/${expected.length} 条，按口径是 ${derived}`);
          }
        }
      }
    }
  }

  const spanIds = Array.isArray(ctx.spanIds) ? ctx.spanIds.filter(Boolean).map(String) : [];
  if (spanIds.length) {
    const { items, checks } = normalizeFindings(f);
    for (const [where, list] of [["items", items], ["checks", checks], ["observations", Array.isArray(f?.observations) ? f.observations : []]]) {
      list.forEach((entry, i) => {
        for (const pt of Array.isArray(entry?.pointers) ? entry.pointers : []) {
          const id = typeof pt?.span_id === "string" ? pt.span_id.trim() : "";
          if (!id) continue;
          if (spanIds.includes(id)) continue;
          const hits = spanIds.filter((s) => s.startsWith(id));
          if (hits.length === 0) problems.push(`findings.${where}[${i}].pointers 的 span ${id} 不在这条 trace 里——指不到就说明证据还没找到，写进 summary，别编一个`);
          else if (hits.length > 1) problems.push(`findings.${where}[${i}].pointers 的 span ${id} 配到 ${hits.length} 条，指到「某几步之一」等于没指：写全一点`);
        }
      });
    }
  }
  return problems;
}

/** 当前类型聚合只依赖本次 items；历史 kind 可保留类型，缺失不猜。 */
export function deriveFindingTypes(findings) {
  const types = new Set((normalizeFindings(findings).items).map(issueTypeOf).filter(Boolean));
  return ISSUE_TYPES.filter((type) => types.has(type));
}

/**
 * `finding_kinds` = items 的 class ∪ still_open 复验的 class，去重、按词表顺序（`true_bug` 在前）。
 * **算出来的，判题方不写**——写了也被这个覆盖（军规 3：能推导的值不许再钉一份）。
 */
export function deriveFindingKinds(findings) {
  const f = normalizeFindings(findings);
  const present = new Set();
  for (const it of f.items) if (FINDING_CLASSES.includes(it?.class)) present.add(it.class);
  for (const c of f.checks) if (c?.status === "still_open" && FINDING_CLASSES.includes(c?.class)) present.add(c.class);
  return FINDING_CLASSES.filter((k) => present.has(k));
}

/**
 * 2026-09-13 之前那一版六类批注 → 两类。**读侧宽容只住这一处**（web 侧是 `llmobs-fix-items.ts`，
 * 同一张表），写侧照旧整包拒（`validateFindings`）。
 *
 * 映射的依据是各旧类**当初的判据**，不是名字像不像：
 *   · `tool` + `verified: online` —— 判官当初真去活系统核过 ⇒ 现在的「确定是 bug」；
 *   · `tool` 其余（只看轨迹 / 核不到）—— 没有第二条路证明数据本该有 ⇒ 看不出是不是 bug；
 *   · `skill` / `model` —— 都是「给模型的话」这一侧（旧口径靠「规矩写没写」分这两类，那道分界本身最易判错，D4 已合并）⇒ 说法会误导；
 *   · `case` —— 题目有问题；
 *   · `unsure` —— 当初就是弃判 ⇒ 看不出是不是 bug；
 *   · `env` —— 现场不成立已经不是条目了（是 `verdict: not_reproduced`）⇒ 丢弃。
 *
 * 活栈 27 条旧判题重判后整段删。
 */
const LEGACY_CLASS = {
  skill: { class: "needs_decision", decision: "wording" },
  model: { class: "needs_decision", decision: "wording" },
  case: { class: "needs_decision", decision: "case" },
  unsure: { class: "needs_decision", decision: "is_bug" },
};

const joinParts = (...parts) => parts.map((p) => (typeof p === "string" ? p.trim() : "")).filter(Boolean).join("\n\n");

function fromLegacyItem(it) {
  const mapped = it.kind === "tool"
    ? (it.verified === "online" ? { class: "true_bug" } : { class: "needs_decision", decision: "is_bug" })
    : LEGACY_CLASS[it.kind];
  if (!mapped) return null;  // env：丢弃
  const { kind, qualifier, verified, rule_ref: ruleRef, suspected_kind: suspectedKind, suggestion, layer, fix_where: fixWhere, evidence, expected, ...rest } = it;
  if (mapped.class === "true_bug") {
    // 旧 `evidence` 就是判定链那段话；旧 `expected` 与新的同义，原样留。
    return { ...rest, ...(issueTypeOf(it) ? { issue_type: issueTypeOf(it) } : {}), class: "true_bug", how_verified: joinParts(evidence), ...(expected === undefined ? {} : { expected }), legacy: true };
  }
  // 要人定这一侧：旧的三段（证据 / 修好该看到什么 / 建议）合起来才是「全部上下文」。
  return {
    ...rest,
    ...(issueTypeOf(it) ? { issue_type: issueTypeOf(it) } : {}),
    class: "needs_decision",
    decision: mapped.decision,
    context: joinParts(evidence, expected, suggestion, ruleRef && `规矩写在：${ruleRef}`),
    legacy: true,
  };
}

/**
 * 读侧把一条批注里的 `findings` 摊成 `{items, checks}`（双重编码也认），顺带把旧批注按上表读成新形状。
 */
export function normalizeFindings(value) {
  let v = value;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { return { items: [], checks: [] }; }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { items: [], checks: [] };
  const items = [];
  for (const it of Array.isArray(v.items) ? v.items : []) {
    if (!it || typeof it !== "object") continue;
    if (it.class !== undefined || it.kind === undefined) { items.push(it); continue; }
    const mapped = fromLegacyItem(it);
    if (mapped) items.push(mapped);
  }
  const checks = [];
  for (const c of Array.isArray(v.checks) ? v.checks : []) {
    if (!c || typeof c !== "object") continue;
    if (c.class !== undefined || c.kind === undefined) { checks.push(c); continue; }
    // 复验条目只带一个 `kind`，没有 `verified`——比原条目少一维，折出来的类别会比原条目粗。
    // 所以旧 check 一律**不带类别**，让算状态那一步退回原条目的 class（`judge-quality.mjs`），
    // 那份是按全字段折的。丢掉整条 check 更不行：那等于把「这一轮验过了」抹掉。
    const { kind, ...rest } = c;
    checks.push({ ...rest, legacy: true });
  }
  return { items, checks };
}

/**
 * 一道题之前几轮的判题，交给判下一轮的判题方做复验的材料（`prior-judgments.json` / `case-history.mjs`）。
 *
 * **只给原料，不替判题方算「哪些还没关」**：规则就一句（最后一次有效复验不是 fixed、或 fixed 之后又被提出来，
 * 都算没关），写在 skill 里；web 读侧另有一份算状态的实现给人看。这里多算一遍就是第三份副本。
 * 修复标记（`fix_marks`）也原样带上：修的人说「改了」，判题方复验时该走到那条路去验。
 *
 * ## 一次诊断可以判多次（§15.6）
 *
 * 复现、诊断、判题是三张表：人点「判题」是在那次诊断下**加一条判题**。于是同一条 trace 可能挂着
 * 好几次判题，而批注表只放最近一次判完的（D5「投影覆盖、历史保留」）。所以每一次判题的全文取自
 * 判题表那一行的 `judgement` 快照，一次一个元素，按 `judged_at` 排；这条 trace 一行快照都没有
 * （迁移前的老数据、或 server 还没有判题表）才退回读批注表——那时它只看得到一次判题。
 *
 * **修复标记不取快照里的那份**：标记是判完之后修的人打在 trace 上的，快照抄的是判完那一刻的批注，
 * 抄不到之后打的标记。标记按 key 取 `at` 最新的一份（快照里的旧份与批注表里的现份合起来比），
 * 挂在这条 trace 最后一次判题上；它在时间轴上排在哪由 `judge-quality.mjs` 按 `at` 定。
 *
 * ## 时间轴是诊断时间，不是判题时间（§15.5，2026-09-14 定）
 *
 * 每个元素带 `diagnosed_at`：这条 trace 是什么时候跑出来的。取诊断表那一行的 `created_at`，
 * 拿不到（server 还没有诊断表、或手工发起的诊断）退回运行的开始时刻 `startedAt`（trace root 起跑时刻）。
 * 两个都没有就不带这一格，排序退回运行建行时刻。元素按诊断时间排，同一次诊断的几次判题按判完时刻排。
 * 为什么：trace 的内容定下来就不会变——修复之前跑出来的诊断，今天重判一百次看到的也还是修复前的路径，
 * 它的「又撞上」不能推翻修复之后的复测（见 `judge-quality.mjs`）。
 *
 * @param {{ experiment: {id:string,name:string,created_at:string}, traceId: string, startedAt?: string }[]} runs
 *   这道题的运行（`dataset-traces.mjs` 的 `asJudgedRuns`）
 * @param {Map<string, any[]>} interactionsByTrace `findAllAnnotationsByContent` 的返回
 * @param {{ judgements?: any[], diagnosisRuns?: any[] }} [layers] 判题表行与诊断表行（`case-diag-client.mjs` 的
 *   `caseHistoryOfRecords`）；不给 = 只读批注表、诊断时间用 `startedAt`
 * @returns 旧的在前；快照来的元素多带 `judgement_id` / `diagnosis_id` / `judged_at`
 */
export function priorJudgments(runs, interactionsByTrace, { judgements = [], diagnosisRuns = [] } = {}) {
  const diagnosedAtByTrace = new Map();
  for (const row of diagnosisRuns ?? []) {
    if (row?.trace_id && row.created_at && !diagnosedAtByTrace.has(row.trace_id)) diagnosedAtByTrace.set(row.trace_id, row.created_at);
  }
  const snapshotsByTrace = new Map();
  for (const row of judgements ?? []) {
    const snap = judgementSnapshotOf(row);
    if (!snap) continue;
    const list = snapshotsByTrace.get(row.trace_id) ?? [];
    list.push(snap);
    snapshotsByTrace.set(row.trace_id, list);
  }

  const out = [];
  for (const { experiment, traceId, startedAt } of [...runs].sort((a, b) => compareTime(a.experiment.created_at, b.experiment.created_at))) {
    const diagnosedAt = diagnosedAtByTrace.get(traceId) || startedAt || "";
    const base = {
      round: experiment.name, round_id: experiment.id, created_at: experiment.created_at, trace_id: traceId,
      ...(diagnosedAt ? { diagnosed_at: diagnosedAt } : {}),
    };
    const live = new Map();
    for (const it of interactionsByTrace.get(traceId) ?? []) {
      for (const an of it.annotations ?? []) if (an.label && !live.has(an.label)) live.set(an.label, an.value);
    }
    const snaps = (snapshotsByTrace.get(traceId) ?? []).sort((a, b) => compareTime(a.judged_at, b.judged_at));
    if (snaps.length) {
      const marks = latestMarksOf([...snaps.map((s) => s.labels.fix_marks), live.get("fix_marks")]);
      snaps.forEach((s, i) => {
        out.push({
          ...judgedRound(base, (label) => s.labels[label], i === snaps.length - 1 ? marks : {}),
          judgement_id: s.id,
          diagnosis_id: s.diagnosis_id,
          judged_at: s.judged_at,
        });
      });
      continue;
    }
    if (!live.size) { out.push({ ...base, judged: false }); continue; }
    out.push(judgedRound(base, (label) => live.get(label), latestMarksOf([live.get("fix_marks")])));
  }
  // 按**诊断时间**排，同一次诊断的几次判题按判完时刻排。数组 sort 是稳定的，同时刻保持上面的次序。
  return out.sort((a, b) => compareTime(diagnosisTimeOf(a), diagnosisTimeOf(b)) || compareTime(a.judged_at ?? "", b.judged_at ?? ""));
}

/** 一轮判题在复验时间轴上的位置：它所属那次诊断的时间，没有就退回运行建行时刻。 */
export function diagnosisTimeOf(round) {
  return round?.diagnosed_at || round?.created_at || "";
}

function judgedRound(base, labelOf, fixMarks) {
  const { items, checks } = normalizeFindings(labelOf("findings"));
  return {
    ...base,
    judged: true,
    verdict: labelOf("verdict") ?? null,
    evidence: labelOf("evidence") ?? null,
    items,
    checks,
    fix_marks: fixMarks,
  };
}

const parseJsonObject = (v) => {
  let x = v;
  if (typeof x === "string") { try { x = JSON.parse(x); } catch { return null; } }
  return x && typeof x === "object" && !Array.isArray(x) ? x : null;
};

/**
 * 判题表一行（`GET /api/v1/llm-obs/case-judgements`）→ `{id, diagnosis_id, judged_at, labels}`；不算一次判完的判题回 null。
 *
 * 两个闸：行得在 `judged` 态（快照是推到判完时抄的；待判题 / 判题中 / 被挡住的行还没有这一次判题）；
 * 快照里得有判题方写的 label（只剩修复标记的不是一次判题）。
 */
export function judgementSnapshotOf(row) {
  if (!row || row.status !== "judged" || !row.trace_id) return null;
  const snap = parseJsonObject(row.judgement);
  const labels = parseJsonObject(snap?.labels);
  if (!labels || !JUDGE_WRITTEN_LABELS.some((l) => labels[l] !== undefined)) return null;
  return { id: row.id ?? null, diagnosis_id: row.diagnosis_id ?? null, judged_at: row.judged_at ?? null, labels };
}

/**
 * 几份 `fix_marks` 合成一份：同一个 key 取 `at` 最新的；`at` 比不出先后（缺 / 坏）时后给的赢——
 * 调用方把批注表里的现份放在最后，它是 fix-mark.mjs 读回合并后写的全量。
 */
function latestMarksOf(maps) {
  const out = {};
  for (const m of maps) {
    const obj = parseJsonObject(m);
    if (!obj) continue;
    for (const [key, mark] of Object.entries(obj)) {
      const prev = out[key];
      const tp = Date.parse(prev?.at ?? "");
      const tn = Date.parse(mark?.at ?? "");
      if (!prev || Number.isNaN(tp) || Number.isNaN(tn) || tn >= tp) out[key] = mark;
    }
  }
  return out;
}

/**
 * 按时刻比，不按串比：诊断表的时刻带 `+08:00` 偏移、修复标记的 `at` 是 `Z`，串比会把两者排反。
 * 解析不了的退回串比（老夹具里有「x」这种占位）。
 */
export function compareTime(a, b) {
  const ta = Date.parse(a ?? "");
  const tb = Date.parse(b ?? "");
  if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta - tb;
  return String(a ?? "").localeCompare(String(b ?? ""));
}

/** label 值的形状校验（只判形状，不判判得对不对）。 */
export function validateLabels(labels) {
  const problems = [];
  if (labels.verdict !== undefined && !VERDICTS.includes(labels.verdict)) {
    problems.push(`verdict 只能是 ${VERDICTS.join(" / ")}`);
  }
  if (labels.evidence !== undefined && !EVIDENCE_VALUES.includes(labels.evidence)) {
    problems.push(`evidence 只能是 ${EVIDENCE_VALUES.join(" / ")}`);
  }
  if (labels.findings !== undefined) problems.push(...validateFindings(labels.findings));
  if (labels.summary !== undefined && typeof labels.summary !== "string") problems.push("summary 必须是字符串");
  if (labels.summary !== undefined && typeof labels.summary === "string" && labels.summary.length > 600) {
    problems.push(`summary 太长（${labels.summary.length} 字，上限 600）——总评三句以内，细节写进各条问题`);
  }
  if (labels.findings?.scope === "current") {
    for (const label of ["verdict", "evidence", "findings", "summary"]) {
      if (labels[label] === undefined) problems.push(`单次判题缺少 ${label}`);
    }
    if ((labels.verdict === "unknown" || labels.evidence === "unknown") && !labels.findings.limitations?.length) {
      problems.push("无法判断时必须在 findings.limitations 说明缺什么及影响");
    }
  }
  for (const k of ["finding_kinds", "finding_types", "fix_marks", "rubric_version"]) {
    if (labels[k] !== undefined) {
      problems.push(`${k} 不由判题方写（finding_kinds / finding_types 由 import 从 findings 算出；fix_marks 由 fix-mark.mjs 写；` +
        `rubric_version 由 import 从包里记的那份写——判官自己填多半会填错自己跑的是哪一版）`);
    }
  }
  for (const k of ["trustworthy", "needs_fix", "lucky_guess", "attribution_tags", "attribution"]) {
    if (labels[k] !== undefined) problems.push(`${k} 是 2026-09-11 之前的旧词表——结论看 verdict，证据看 evidence，其余都是 findings 里一条条的问题`);
  }
  const unknown = Object.keys(labels).filter((k) => !LABEL_SCHEMA.some((l) => l.label === k) && !["trustworthy", "needs_fix", "lucky_guess", "attribution_tags", "attribution"].includes(k));
  if (unknown.length) problems.push(`未知 label：${unknown.join(", ")}（词表见 §7.1）`);
  return problems;
}

/**
 * 一行 labels → POST annotations 的条目。label id **只从 manifest 取**：包里那份是导出当时
 * 对齐过的，照它写就不会因为词表期间又变过而错挂。
 * （2026-09-12 之前这里还有一条更硬的理由——「重发 PUT labels 会把该队列已有的 annotation
 * 级联删光」。那是 server 把整份替换实现成「删光重建 + 换新 id」造成的，已按
 * `(queue_id,label)` upsert 修掉，PUT 现在幂等且安全。）
 *
 * `finding_kinds` 在这里从 findings 算出来一起发：判题方写的那份（如果有）被覆盖。
 * `rubric_version` 同理由调用方给（export 记在 manifest 里）——**判的是哪一版口径**要跟着批注走：
 * 开跑前守门逐例同步 plugin，一轮里前后几例可能用的不是同一版 rubric，不记就分不清
 * 「判官变了」还是「口径变了」，而 `annotator` 当初存在的理由正是要把这两件事分开。
 */
export function annotationPayload({ interactionId, labels, labelIds, annotator, rubricVersion }) {
  const withKinds = labels.findings !== undefined ? { ...labels, finding_kinds: deriveFindingKinds(labels.findings), ...(labelIds.finding_types ? { finding_types: deriveFindingTypes(labels.findings) } : {}) } : labels;
  // 老包的 manifest 里没有这一格：不写，也不编一个——一个猜出来的版本号比没有更坏。
  const withRubric = rubricVersion ? { ...withKinds, rubric_version: String(rubricVersion) } : withKinds;
  const out = [];
  for (const { label } of LABEL_SCHEMA) {
    if (withRubric[label] === undefined) continue;
    const labelId = labelIds[label];
    if (!labelId) throw new Error(`manifest 里没有 label ${label} 的 id——包过期了，重跑 export`);
    out.push({
      interaction_id: interactionId,
      label_id: labelId,
      value: withRubric[label],
      ...(annotator ? { annotator } : {}),
    });
  }
  return out;
}
