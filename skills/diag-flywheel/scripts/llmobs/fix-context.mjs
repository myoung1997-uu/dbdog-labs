#!/usr/bin/env node
// fix-context.mjs — 把一道题挖出来的问题导成**修复工作包**（飞轮 §14.3，修复是第四棒）。
//
// 上游是判题：问题挂在某一轮的批注上，开没开由后续轮次的复验说了算（§13.3）。
// 这个脚本只做「把材料摆到本地」：题面 / 答案纸 / 最新判过那轮的结论与过程分析 / 逐条问题 /
// 每个指针指到的那次调用。**不改任何判题结果**，也不替修的人做决定。
//
// 为什么要落成文件而不是让 agent 现查：修一道题要来回翻十几处（题面、答案纸、总账、条目、span），
// 现查一次烧一轮工具调用，而这些东西在这一轮里是不变的——导一次，之后都是读本地文件。
//
// 用法：
//   node scripts/llmobs/fix-context.mjs --record <record id（前 8 位也行）>
//     [--dataset <用例集名>] [--project default-project] [--out fix-work]
//
//   --dataset 给了就直奔那个集合（快）；不给就翻一遍 project 下的集合按 record id 找。
//   产物：<out>/<用例集>-<record 前 8 位>/{README.md,true-bugs.md,needs-decision.md,items.json,spans/*.md}
//
// env 同 run-experiment（DBDOG_BASE_URL / DBDOG_API_KEY 或 DBDOG_INTERNAL_TOKEN / DBDOG_ORG）。
import fs from "node:fs";
import path from "node:path";
import {
  findProject, findDataset, listDatasets, listRecords, listCPExperiments,
  findAllAnnotationsByContent, getTrace, requireCredential,
} from "./lib/exp-client.mjs";
import { runsOfRecords } from "./lib/dataset-traces.mjs";
import { priorJudgments } from "./lib/judge-package.mjs";
import {
  collectItems, pointerSpanIds, findSpanByPrefix, renderSpanDoc,
  renderReadme, renderTrueBugs, renderNeedsDecision, itemsJson, workDirName, classLabel,
} from "./lib/fix-context.mjs";

const argOf = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };

const RECORD = argOf("--record", "");
const DATASET = argOf("--dataset", "");
const PROJECT = argOf("--project", "default-project");
const OUT = argOf("--out", "fix-work");
if (!RECORD) fail("--record 必填（用例的 record id，前 8 位也行）");
requireCredential();

const project = await findProject(PROJECT);
if (!project?.id) fail(`project 不存在：${PROJECT}`);

// ── ① 找到这道题 ──────────────────────────────────────────────────────────────
let datasets = [];
if (DATASET) {
  const one = await findDataset(project.id, DATASET);
  if (!one?.id) fail(`dataset 不存在：${DATASET}（project ${PROJECT}）`);
  datasets = [one];
} else {
  datasets = await listDatasets(project.id);
  if (!datasets.length) fail(`project ${PROJECT} 下一个用例集都没有`);
}

let record = null;
let datasetName = DATASET;
for (const ds of datasets) {
  const rows = await listRecords(project.id, ds.id);
  // 前缀匹配要**唯一**才算：配到两条就挑错题，而挑错题的代价是照着另一道题的条目去改代码
  const hits = rows.filter((r) => r.id === RECORD || String(r.id).startsWith(RECORD));
  if (hits.length > 1) fail(`--record ${RECORD} 在用例集 ${ds.name} 里配到 ${hits.length} 条，写全一点`);
  if (hits.length === 1) { record = hits[0]; datasetName = ds.name ?? datasetName; break; }
}
if (!record) fail(`找不到 record ${RECORD}${DATASET ? `（用例集 ${DATASET}）` : "（翻遍了这个 project 下的用例集）"}`);

// ── ② 历次运行 → 历次判题 ────────────────────────────────────────────────────
const runs = ((await runsOfRecords({ projectID: project.id, recordIDs: [record.id] })).get(record.id) ?? [])
  .filter((r) => r.traceId)
  .sort((a, b) => String(a.experimentCreatedAt).localeCompare(String(b.experimentCreatedAt)));
if (!runs.length) fail(`这道题还没跑过（没有任何 trace）：${record.id}`);

const interactions = await findAllAnnotationsByContent(runs.map((r) => r.traceId));
const rounds = priorJudgments(
  runs.map((r) => ({ experiment: { id: r.experimentId, name: r.experimentName, created_at: r.experimentCreatedAt }, traceId: r.traceId })),
  interactions,
);
const judged = rounds.filter((r) => r.judged !== false);
if (!judged.length) fail(`这道题跑过 ${runs.length} 轮但一轮都没判过——没判就没有条目可修，先跑判题那一棒`);
const latest = judged[judged.length - 1];
const items = collectItems(rounds);

// ── ③ 最新判过那轮的 trace 与判题过程分析 ────────────────────────────────────
let spans = [];
try {
  const trace = await getTrace(latest.trace_id);
  spans = trace?.spans ?? [];
} catch (e) {
  console.error(`⚠ 取 trace ${latest.trace_id} 失败（${e.message || e}）：spans/ 会全部写「找不到」`);
}

// 判题的过程分析在那一轮 run 的 metadata 里，按 event id 分格（import 一例一格写，见 §7.3）。
let judgeSummary = "";
const eventId = runs.find((r) => r.traceId === latest.trace_id)?.eventId ?? "";
try {
  const [exp] = await listCPExperiments({ ids: [latest.round_id] });
  const bucket = exp?.metadata?.judge_summaries;
  if (bucket && typeof bucket === "object") judgeSummary = bucket[eventId] ?? bucket[latest.trace_id] ?? "";
} catch (e) {
  console.error(`⚠ 读轮次 metadata 失败（${e.message || e}）：README 里那段过程分析会缺`);
}

// ── ④ 落盘 ──────────────────────────────────────────────────────────────────
const dir = path.join(OUT, workDirName(datasetName, record.id));
fs.mkdirSync(path.join(dir, "spans"), { recursive: true });

const spanIds = pointerSpanIds(items);
for (const id of spanIds) {
  fs.writeFileSync(path.join(dir, "spans", `${id.slice(0, 8)}.md`), renderSpanDoc(id, findSpanByPrefix(spans, id)));
}
fs.writeFileSync(path.join(dir, "README.md"), renderReadme({ dataset: datasetName, record, latest, judgeSummary, items, spanCount: spanIds.length }));
fs.writeFileSync(path.join(dir, "true-bugs.md"), renderTrueBugs(items));
fs.writeFileSync(path.join(dir, "needs-decision.md"), renderNeedsDecision(items));
fs.writeFileSync(path.join(dir, "items.json"), `${JSON.stringify(itemsJson({ dataset: datasetName, record, latest, items }), null, 1)}\n`);

const open = items.filter((it) => it.open);
console.error(`✓ 修复工作包 → ${path.resolve(dir)}`);
console.error(`  ${datasetName} / ${record.id}　判过 ${judged.length} 轮，最新那轮 ${latest.round}（trace ${latest.trace_id}）`);
console.error(`  还没关的问题 ${open.length} 条${items.length > open.length ? `（另有 ${items.length - open.length} 条已关，留着做参照）` : ""}：`);
for (const it of open) {
  console.error(`   · ${it.key}　${classLabel(it)}${it.fix_mark?.status ? `　[已有标记：${it.fix_mark.status}]` : ""}`);
}
console.error("  先读 README.md 里那段判题过程分析，再读条目。");
