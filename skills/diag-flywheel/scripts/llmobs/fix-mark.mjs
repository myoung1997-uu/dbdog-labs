#!/usr/bin/env node
// fix-mark.mjs — 修的人给一条改进点打标记（飞轮设计 §13.3「修复标记」）。
//
// owner 2026-09-11：「一条一条列出来，大模型修复后可以给他们打上标记，比如是否修复了，是否需要人类协助」。
// 标记是**声明，不是判决**：它只说「我改了 / 我改不动 / 我不修」，修没修好仍由后续判题的复验说了算——
// `claimed_fixed` 之后一次复验 `still_open`，标记就被复验盖掉；复验 `fixed` 才算关。
//
// **唯一的例外是确定是 bug 的复测**（§15.5，2026-09-14）：修的人部署后判断数据、在挖出它的那次诊断的
// 原窗口原样重放 `repro`，结果记进 `--verify`。`passed` 即关、不等重跑；之后**更晚跑出来的诊断**又撞上它，自动重新打开
// （修复之前跑出来的诊断重判几次都不作数——trace 内容不会变）。
// 数据修不回来的（`--data unrepairable`）原窗口里没有对的数据，不复测，等下次诊断和判题时验证。
//
// 用法：
//   node scripts/llmobs/fix-mark.mjs --trace <trace_id> --key <改进点 key> --status claimed_fixed|needs_human|wont_fix \
//     [--data unaffected|repaired|unrepairable] [--verify passed|failed] \
//     --note "改了什么 / 原窗口重放拿到什么 / 要人做什么 / 为什么不修" --by <谁：模型名或人名> [--project default-project]
//
//   --trace   挖出这条改进点的那次诊断（控制台待修卡片上的「修这一条」命令带着它）
//   --key     改进点的 key（跨轮次认同一个缺口的唯一依据）
//   --data    数据情况：unaffected 纯读取或查询错、库里数据本来就对 / repaired 修过了 / unrepairable 修不回来
//   --verify  原窗口重放 repro 的复测结果：passed / failed。只跟 --status claimed_fixed 走；--data unrepairable 时不许带
//   两格都不带也能打（旧写法），那样的 claimed_fixed 关不关全看之后的判题复验。
//
// 落点：该 trace 在 diag-judge 队列里的 interaction 上，label `fix_marks`（json：`{ "<key>": {status, note, by, at, data?, verify?} }`）。
// 先读回已有的 map 合并再写——label 值是整体覆盖的，不合并会把别的 key 的标记冲掉。
// server 收到后照常投影（json 对象只进 experiment metric，不上 root tag）。
//
// env 同 run-experiment（DBDOG_BASE_URL / DBDOG_API_KEY 或 DBDOG_INTERNAL_TOKEN / DBDOG_ORG）。
import {
  findProject, listAnnotationQueues, listAnnotationLabels, addAnnotationInteractions,
  findAllAnnotationsByContent, upsertAnnotations, requireCredential,
} from "./lib/exp-client.mjs";
import { FIX_KEY_RE, QUEUE_NAME, fixMarkProblems, fixMarkLabel, fixMarkState } from "./lib/judge-package.mjs";

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };

const TRACE = argOf("--trace", "");
const KEY = argOf("--key", "");
const STATUS = argOf("--status", "");
const NOTE = argOf("--note", "");
const BY = argOf("--by", "");
const DATA = argOf("--data", "");
const VERIFY = argOf("--verify", "");
const PROJECT = argOf("--project", "default-project");
// 带了开关却没给值（写在最后、或后面紧跟另一个开关）：当成没带会悄悄写出一份没有复测结果的标记
for (const flag of ["--data", "--verify"]) {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && (!process.argv[i + 1] || process.argv[i + 1].startsWith("--"))) fail(`${flag} 带了但没给值`);
}

if (!TRACE) fail("--trace 必填（挖出这条改进点的那次诊断的 trace_id）");
if (!FIX_KEY_RE.test(KEY)) fail(`--key ${JSON.stringify(KEY)} 不合规（小写 ascii，<层>.<模块>.<缺什么>，照改进点卡片上的写）`);
const markProblems = fixMarkProblems({ status: STATUS, data: DATA || undefined, verify: VERIFY || undefined });
if (markProblems.length) fail(markProblems.join("\n  "));
if (!NOTE.trim()) fail("--note 必填：改了什么 / 要人做什么 / 为什么不修——空标记没人看得懂");
if (!BY.trim()) fail("--by 必填：谁打的标记（模型名或人名）");
requireCredential();

const project = await findProject(PROJECT);
if (!project?.id) fail(`project 不存在：${PROJECT}`);
const queue = (await listAnnotationQueues({ projectID: project.id })).find((q) => q.name === QUEUE_NAME);
if (!queue) fail(`project ${PROJECT} 里没有判题队列 ${QUEUE_NAME}——这条 trace 还没判过，没有可标记的改进点`);
const queueID = queue.queue_id ?? queue.id;
const label = (await listAnnotationLabels(queueID)).find((l) => l.label === "fix_marks");
if (!label?.id) fail(`队列 ${QUEUE_NAME} 没有 fix_marks 这个 label——队列是 2026-09-11 之前建的，先按设计 §7.1 重建 label schema`);

// 这条 trace 现有的批注：核 key 真在这一次判题的改进点里，顺便读回已有的标记合并
const existing = (await findAllAnnotationsByContent([TRACE])).get(TRACE) ?? [];
const mine = existing.find((it) => String(it.queue_id ?? "") === String(queueID)) ?? existing[0] ?? null;
const labelsHere = new Map();
for (const an of mine?.annotations ?? []) if (an.label && !labelsHere.has(an.label)) labelsHere.set(an.label, an.value);
let findings = labelsHere.get("findings");
if (typeof findings === "string") { try { findings = JSON.parse(findings); } catch { findings = null; } }
const keysHere = new Set([...(findings?.items ?? []).map((it) => it?.key), ...(findings?.checks ?? []).map((c) => c?.key)].filter(Boolean));
if (!keysHere.has(KEY)) {
  console.error(`⚠ 这次判题（trace ${TRACE.slice(0, 8)}…）的改进点里没有 ${KEY}（有的是：${[...keysHere].join(", ") || "无"}）——照样写，但核一眼 trace 是不是给错了`);
}
const itemHere = (findings?.items ?? []).find((it) => it?.key === KEY);
if (VERIFY === "passed" && itemHere?.class && itemHere.class !== "true_bug") {
  console.error(`⚠ ${KEY} 是「要人定」不是「确定是 bug」：复测通过照样记下，但不会因此关——模型行为只能靠重跑看，由之后的判题复验关`);
}
let marks = labelsHere.get("fix_marks") ?? {};
if (typeof marks === "string") { try { marks = JSON.parse(marks); } catch { marks = {}; } }
if (!marks || typeof marks !== "object" || Array.isArray(marks)) marks = {};

const [interaction] = await addAnnotationInteractions(queueID, [{ content_id: TRACE, content_kind: "trace" }]);
if (!interaction?.id) fail("排队后没拿到 interaction id");
const at = new Date().toISOString();
const mark = { status: STATUS, note: NOTE.trim(), by: BY.trim(), at, ...(DATA ? { data: DATA } : {}), ...(VERIFY ? { verify: VERIFY } : {}) };
const next = { ...marks, [KEY]: mark };
await upsertAnnotations([{ interaction_id: interaction.id, label_id: label.id, value: next, annotator: BY.trim() }]);
// 类别取这次判题里那条的；找不到按确定是 bug 算（与关单回放的缺省同一条）
const cls = itemHere?.class;
console.error(`✓ ${KEY} ←「${fixMarkLabel(cls, mark)}」（${[STATUS, DATA, VERIFY].filter(Boolean).join(" · ")}；${BY}，${at}）`);
const NEXT = {
  verify_passed: "这条关了；之后更晚跑出来的诊断又撞上它，会自动重新打开",
  verify_failed: "这条还开着",
  unrepairable: "原窗口里的数据是错的，没法复测；建议人点「复现」造新现场",
  awaiting_verify: "部署后在原窗口原样重放 repro，再打一次标记带上 --verify",
  awaiting_judge: "关不关看下次判题的复验",
  needs_human: "判题弹窗里这条会带上这条 note",
  wont_fix: "判题弹窗里这条会带上理由，退出待复验清单",
};
console.error(`  ${NEXT[fixMarkState(cls, mark)] ?? ""}`);
