#!/usr/bin/env node
// case-history.mjs — 一道题之前几轮的判题（问题 items、复验 checks、修复标记 fix_marks），给**取数判题**做复验用。
//
// 判题跟着轮次走（飞轮设计 §13）：一道题会跑很多轮，某一轮提的改进点修没修好，
// 由后续轮次的判题逐条复验说了算，不由人标。判下一轮之前，判题方要先拿到这道题之前几轮提过的条目——
// 包判题读包里的 `cases/<event_id>/prior-judgments.json`，取数判题跑这个脚本，两者同一个形状。
// 同一条诊断判过几次就出几个元素（每一次取判题表那一行的快照，按判题时刻排；§15.6）。
//
// 用法：
//   node scripts/llmobs/case-history.mjs --record <record_id> [--before <trace_id>] [--project default-project] [--open]
//
//   --before  只要比这条 trace 那次诊断**更早**的诊断（判哪次诊断就传它的 trace）；同一条 trace 自己的判题不算——
//             trace 内容不会变，拿它验它自己没有意义（§15.5，时间轴是诊断时间）。不给 = 全部
//   --open    不出全量历史，只出**这一轮该逐条复验的清单**（还没关的条目，每条带 class / decision）。
//             「哪些算还没关」那条规则（最后一次有效复验不是 fixed；「说法会误导」要连续两轮）
//             原先要判官自己在几十条历史里手算，漏一条没人拦得住——现在由代码给出（lib/judge-quality.mjs）。
//
// env 同 run-experiment（DBDOG_BASE_URL / DBDOG_API_KEY 或 DBDOG_INTERNAL_TOKEN / DBDOG_ORG）。
// 输出：stdout 一个 JSON 数组，旧的在前；空数组 = 这道题之前没判过，checks 省略。
import { findProject, findAllAnnotationsByContent, requireCredential } from "./lib/exp-client.mjs";
import { runsOfRecords, asJudgedRuns } from "./lib/dataset-traces.mjs";
import { caseHistoryOfRecords } from "./lib/case-diag-client.mjs";
import { priorJudgments, diagnosisTimeOf } from "./lib/judge-package.mjs";
import { openFindings, isBeforeDiagnosis } from "./lib/judge-quality.mjs";

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };

const RECORD = argOf("--record", "");
const BEFORE = argOf("--before", "");
const PROJECT = argOf("--project", "default-project");
const ONLY_OPEN = process.argv.includes("--open");
if (!RECORD) fail("--record 必填（用例的 record id）");
requireCredential();

const project = await findProject(PROJECT);
if (!project?.id) fail(`project 不存在：${PROJECT}`);
const runs = asJudgedRuns((await runsOfRecords({ projectID: project.id, recordIDs: [RECORD] })).get(RECORD) ?? []);
if (BEFORE && !runs.some((r) => r.traceId === BEFORE)) fail(`--before ${BEFORE} 不是这道题的任何一次运行`);
const interactions = await findAllAnnotationsByContent(runs.map((r) => r.traceId));
// 判题表的快照（每一次判题一份）与诊断表的诊断时间；server 还没有这两张表时退回批注表与 trace 开始时刻
const rounds = priorJudgments(runs, interactions, await caseHistoryOfRecords([RECORD]));
// 修复标记不因 --before 截掉：标记打在哪条 trace 上都作数，由回放按 `at` 排进时间轴
const target = BEFORE ? { traceId: BEFORE, diagnosedAt: diagnosisTimeOf(rounds.find((r) => r.trace_id === BEFORE)) } : null;
const out = ONLY_OPEN
  ? openFindings(rounds, target ? { before: target } : undefined)
  : (target ? rounds.filter((r) => isBeforeDiagnosis(r, target)) : rounds);
process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
