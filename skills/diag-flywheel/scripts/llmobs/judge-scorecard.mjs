#!/usr/bin/env node
// judge-scorecard.mjs — 判官自己的成绩单：产量（两类各几条）、弃判率、无效条目率、复验漏没漏。
//
// ## 为什么 KPI 光看「挖出几条」不够
//
// 这条 loop 的产出是「要修的条目」与「要人定的条目」，但**产量不等于有效**。Tricorder（Google 的静态分析
// 平台）的经验很硬：误报率一过 ~10%，开发者就整体不看那个分析器了。我们有现成的投票——修的人
// 打的 `wont_fix`。把它算出来，「挖出 N 条」才是奖励有效性而不是奖励产量。
//
// 另外两个数同样要单列：
//   · **弃判率**（要人定里「看不出是不是 bug」那一档）：不敢判也能凑出很好看的产量；
//   · **复验覆盖率**：rubric 写着「还没关的一条都不许漏」，但校验器只查每条 check 的形状、
//     不查覆盖率。漏验三条与「这三条真没修好」在页面上长得一模一样。
//
// 用法：
//   node scripts/llmobs/judge-scorecard.mjs --dataset <用例集> [--project default-project] [--record <只看一道题>]
//
// env 同 run-experiment（DBDOG_BASE_URL / DBDOG_API_KEY 或 DBDOG_INTERNAL_TOKEN / DBDOG_ORG）。
import { findProject, findAllAnnotationsByContent, requireCredential } from "./lib/exp-client.mjs";
import { resolveDatasetTraces, asJudgedRuns } from "./lib/dataset-traces.mjs";
import { priorJudgments, FIX_MARK_LABELS } from "./lib/judge-package.mjs";
import { qualityReport, openFindings } from "./lib/judge-quality.mjs";
import { caseHistoryOfRecords } from "./lib/case-diag-client.mjs";

const argOf = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const pct = (v) => (v === null || v === undefined ? "—" : `${(v * 100).toFixed(1)}%`);

const PROJECT = argOf("--project", "default-project");
const DATASET = argOf("--dataset", "");
const ONLY = argOf("--record", "");
if (!DATASET) fail("--dataset 必填");
requireCredential();

const project = await findProject(PROJECT);
if (!project?.id) fail(`project 不存在：${PROJECT}`);
const { runsByRecord } = await resolveDatasetTraces({ project: PROJECT, dataset: DATASET });

// 判题表的快照（同一条诊断判多次时每一次一份，§15.6）与诊断时间；server 还没有这两张表时退回批注表与 trace 开始时刻
const layers = await caseHistoryOfRecords([...runsByRecord.entries()].filter(([id, runs]) => (!ONLY || id === ONLY) && runs.some((r) => r.traceId)).map(([id]) => id));

const perCase = [];
for (const [recordId, runs] of runsByRecord) {
  if (ONLY && recordId !== ONLY) continue;
  const withTrace = runs.filter((r) => r.traceId);
  if (!withTrace.length) continue;
  const interactions = await findAllAnnotationsByContent(withTrace.map((r) => r.traceId));
  const rounds = priorJudgments(asJudgedRuns(withTrace), interactions, layers).filter((r) => r.judged !== false);
  if (!rounds.length) continue;
  perCase.push({ record_id: recordId, report: qualityReport(rounds), open: openFindings(rounds) });
}

if (!perCase.length) fail(`用例集 ${DATASET} 下没有判过的轮次`);

// 跨题汇总：产量、弃判、无效条目、复验漏项，都按条目数加权（不是按题平均——题的大小差很多）
const sum = (f) => perCase.reduce((a, c) => a + f(c.report), 0);
const total = {
  cases: perCase.length,
  rounds: sum((r) => r.rounds),
  items_total: sum((r) => r.items_total),
  abstained: sum((r) => Math.round(r.abstention_rate * r.items_total)),
  // 判官说「这条要人定」的条目数，与修的人打 needs_human 标记的条目数——**分开报，不相加**
  needs_decision_items: sum((r) => r.needs_decision_items),
  needs_human_marks: sum((r) => r.needs_human_marks),
  marked: sum((r) => r.marked),
  wont_fix: sum((r) => r.wont_fix),
  verify_passed: sum((r) => r.verify_passed),
  verify_failed: sum((r) => r.verify_failed),
  check_due: sum((r) => r.check_coverage.due),
  check_missed: sum((r) => r.check_coverage.missed.length),
  open_now: sum((r) => r.open_now),
};
const byClass = {};
const byDecision = {};
for (const c of perCase) {
  for (const [k, n] of Object.entries(c.report.by_class)) byClass[k] = (byClass[k] ?? 0) + n;
  for (const [k, n] of Object.entries(c.report.by_decision)) byDecision[k] = (byDecision[k] ?? 0) + n;
}

process.stdout.write(`${JSON.stringify({ dataset: DATASET, total, by_class: byClass, by_decision: byDecision, cases: perCase }, null, 1)}\n`);

const ZH_CLASS = { true_bug: "确定是 bug", needs_decision: "要人定" };
const ZH_DECISION = { wording: "说法会误导", capability: "缺能力", case: "题目有问题", is_bug: "看不出是不是 bug" };

console.error(`\n== 判官成绩单 · ${DATASET} ==`);
console.error(`· 判过 ${total.cases} 道题 / ${total.rounds} 轮，提出问题 ${total.items_total} 条：`
  + `${Object.entries(byClass).map(([k, n]) => `${ZH_CLASS[k] ?? k} ${n}`).join(" · ")}`
  + `${Object.keys(byDecision).length ? `（要人定拆开：${Object.entries(byDecision).map(([k, n]) => `${ZH_DECISION[k] ?? k} ${n}`).join(" · ")}）` : ""}`);
console.error(`· 弃判率 ${pct(total.items_total ? total.abstained / total.items_total : 0)}（「看不出是不是 bug」那一档：要人去核，不是挖到的 bug）`);
console.error(`· 要人的两个数不相加：判官说要人定 ${total.needs_decision_items} 条 · 修的人说要人协助 ${total.needs_human_marks} 条`);
console.error(`· 无效条目率 ${pct(total.marked ? total.wont_fix / total.marked : null)}（分母是被修的人标过的 ${total.marked} 条；超 10% 就该回头改 rubric，不是催判官多提）`);
console.error(`· 修的人原窗口复测：${FIX_MARK_LABELS.verify_passed} ${total.verify_passed} 条 · ${FIX_MARK_LABELS.verify_failed} ${total.verify_failed} 条（确定是 bug 的复测通过即关）`);
console.error(`· 复验：该验 ${total.check_due} 条，漏验 ${total.check_missed} 条${total.check_missed ? "  ← 漏验与「真没修好」在页面上长得一样" : ""}`);
console.error(`· 现在还开着 ${total.open_now} 条`);
