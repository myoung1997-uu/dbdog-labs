// case-diag-client.mjs —— 用例诊断表的客户端（server 蓝图 pg/0025 · ADR-0049 偏离 #21）。
//
// **一行 = 一次复现**，不是一条用例。同一道题复现 N 次就有 N 行，各自诊断、各自判题。
// 行由复现回执创建（另一个系统复现完把窗口推给 server），五态按顺序流转：
//
//   pending_diagnosis → diagnosing → pending_judgement → judging → judged
//
// judging 是 2026-09-11 owner 看页面时补的（蓝图 0026）：判题与诊断同构，也是按周期醒的
// loop、单条判题也会跑过一轮的间隔，没有这一档就分不出「还没轮到」和「正在判」。
//
// ## 为什么两条 loop 要改成抢这张表，而不是继续「每轮现算差集」
//
// 差集算的是「有复现、没 trace」。**它没有在途这一档**：loop 每 30 分钟一轮而单条诊断超时
// 40 分钟，两轮必然重叠——第一轮还在跑，第二轮去算差集，那条还没有 trace，于是被当成待跑
// 又发一遍。同一次复现被诊断两遍，烧两份 agent 预算，还会在判题队列里留下两条互相矛盾的轨迹。
// 2026-09-11 查过：整条链路上没有任何锁，这个重入不是理论上的。
//
// 抢占把「在途」变成库里的一个态，且抢的动作本身是原子的（server 那边是单条带
// FOR UPDATE SKIP LOCKED 的 UPDATE）。两轮同时打进来，后到的那轮拿到的是下一条或者 204。
// 鉴权头复用 exp-client 那一份（DD-API-KEY 优先、内部 token 兜底）——
// 自己再拼一份就是第二个真相源，key 的取法一改就会漏掉这里（军规 3）。
import { baseUrl, authHeaders } from "./exp-client.mjs";

/**
 * 跑这条 loop 的**人**是谁（owner 2026-09-11：「这个环境变量在跑 loop 的时候要求用户给出，
 * 自己的身份是谁，比如我的就是 qinqiang」）。落进诊断表的 status_changed_by，
 * 页面「状态」列底下那行显的就是它。
 *
 * **缺了就拒跑，不给默认值**。能想到的三种默认值都答错了问题：
 *   · loop 实例名 / 机器名 → 那是 claimed_by 已经在记的东西（哪条 loop 占着租约）；
 *   · $USER → 机器上的账户名，跑在共用机器上时人人都是 dbdog；
 *   · 空串 → 页面上显成「—」，与 0026 之前的老行混在一起分不出来。
 * 状态是会被人拿去问「这步谁推的」的东西，宁可当场报错，也不要一个看着像答案的假答案。
 */
export function operator() {
  const v = (process.env.DBDOG_OPERATOR || "").trim();
  if (!v) {
    throw new Error(
      "缺 DBDOG_OPERATOR：跑 loop 要报上自己是谁（如 DBDOG_OPERATOR=qinqiang）。\n" +
      "  它落进诊断表的 status_changed_by，控制台用例表「状态」列显的就是这个串——\n" +
      "  没有它，页面上那一步是谁推的就再也查不出来了。",
    );
  }
  return v;
}

/** 五态，与 server 的 domain 常量同一份口径（值是线缆原文）。 */
export const DIAG_PENDING = "pending_diagnosis";
export const DIAG_DIAGNOSING = "diagnosing";
export const DIAG_PENDING_JUDGEMENT = "pending_judgement";
export const DIAG_JUDGING = "judging";
export const DIAG_JUDGED = "judged";
/**
 * 被挡住（蓝图 0028）。**它不在那条流水线上，是一条旁路**：两条 loop 抢到一条之后、发题
 * 之前要逐条检查依赖的基础环境与代码同步，检查不过就岔到这里，连同理由一起记下来。
 *
 * 此前只有两条路，两条都错：不改状态跳过（页面上看不出来，环境长期不通时只表现为
 * 「队列一直不消」，人得去翻 loop 日志），或推到下一态（撒谎，一次没跑成的诊断被当成跑完了）。
 */
export const DIAG_BLOCKED = "blocked";

/** 挡住的五个理由。分两族，族别决定它能不能自己好——判据见 BLOCK_RECOVERABLE。 */
export const BLOCK_MCP_UNREACHABLE = "mcp_unreachable";
/**
 * 连上了，但这次会话拿到的工具集不是我们要的（点名的工具少了几个）。
 *
 * 与 `mcp_unreachable` 分开记，因为查法完全不同：不通是地址 / bearer / 服务挂了，
 * 少工具是 `DBDOG_MCP_URL` 的 toolsets / skillsets 查询串配歪了。压成一个理由，
 * 页面上看到「MCP 不通」的人会去 ping 地址，而地址是通的。
 */
export const BLOCK_MCP_TOOLSET_MISMATCH = "mcp_toolset_mismatch";
export const BLOCK_PLUGIN_SYNC_FAILED = "plugin_sync_failed";
export const BLOCK_DATA_EXPIRED = "data_expired";
export const BLOCK_NO_TELEMETRY = "no_telemetry";

/**
 * 「会自己好」那一族：环境类是全局的、暂时的，下一轮探活通过就该把这些行放回队列。
 * 数据类（现场过期 / 窗口里没遥测）好不了——现场已经不存在了，只能重新复现。
 */
export const BLOCK_RECOVERABLE = [BLOCK_MCP_UNREACHABLE, BLOCK_MCP_TOOLSET_MISMATCH, BLOCK_PLUGIN_SYNC_FAILED];

const path = (p) => `${baseUrl().replace(/\/+$/, "")}/api/v1/llm-obs/case-diagnoses${p}`;

async function call(url, init) {
  const res = await fetch(url, {
    ...init,
    headers: { ...authHeaders(), "content-type": "application/json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  });
  // 204 = 没活干。它是**正常态**不是错误：loop 每 30 分钟醒一次，绝大多数轮都是空的。
  if (res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`${init?.method ?? "GET"} ${url} → HTTP ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

/**
 * 解析 `--diagnosis rec=diagId,...` 这组参数，回 record → 诊断行 id 的表。
 *
 * 为什么要 loop **显式传**，不让 run-experiment 自己去查「这个 record 当前 diagnosing 的是哪行」：
 * 同一道题可以有多行复现（一次复现一行），现查只能猜一个，猜错就把 trace 记到另一次复现头上，
 * 而页面上看不出来——那正是 2026-09-11 那次「四行」里最难查的一半。
 *
 * 畸形项一律丢掉，不许变成 key 为空串或 value 为 undefined 的条目：那种条目会让
 * `map.get(record.id)` 拿到一个假 id，往 server 发一条改不动任何行的请求，然后静静地什么也没发生。
 */
export function parseDiagnosisMap(values) {
  const out = new Map();
  for (const raw of values ?? []) {
    for (const pair of String(raw).split(",")) {
      const i = pair.indexOf("=");
      if (i <= 0) continue;
      const rec = pair.slice(0, i).trim();
      const id = pair.slice(i + 1).trim();
      if (rec && id) out.set(rec, id);
    }
  }
  return out;
}

/**
 * 抢一条待诊断的复现，原子改成诊断中并占住租约。没有可抢的回 null。
 *
 * `staleAfterSec` 是**租约时长**：claimed_at 早于「现在减去它」的 diagnosing 行一并算作候选。
 * 由调用方给而不是服务端猜——只有调用方知道自己的诊断超时配了多少。给小了会把正在跑的那条
 * 抢走（两个进程同时诊断同一条），给大了卡住的行要等更久才被捞回来，所以按
 * **诊断超时 × 2** 取，留一倍余量给收尾与上报。
 */
export async function claimDiagnosis({ claimedBy, staleAfterSec, from, to }) {
  // claimed_by 记**哪条 loop** 占着租约（卡住时去哪台机器看），by 记**谁在跑**（出了事问谁）。
  const body = { claimed_by: claimedBy, by: operator() };
  if (staleAfterSec > 0) body.stale_after_sec = staleAfterSec;
  // from/to 留空 = 诊断那一档（pending_diagnosis → diagnosing）。判题那条 loop 传
  // pending_judgement → judging 走同一条抢占；租约回收捞的也是 to 态，两边对称。
  if (from) body.from = from;
  if (to) body.to = to;
  const out = await call(path("/claim"), { method: "POST", body: JSON.stringify(body) });
  return out?.data ?? null;
}

/**
 * 推进一条的状态。`from` 是**断言**不是摆设：只有当前正处于 from 才改得动，
 * 否则 server 回 409、这里回 null。
 *
 * 没有这个断言，一条被租约回收后重新诊断的行，会被上一个已经死掉的进程改成 pending_judgement
 * ——一次没跑完的诊断就这样被当成跑完了。所以**吞掉 409 不算错**，它正是断言在生效：
 * 本轮放弃这一条就好，下轮重抢。
 *
 * 经手人（status_changed_by）由 DBDOG_OPERATOR 给出，不用调用方传——它是**人**，
 * 整条 loop 从头到尾同一个值，让每个调用点各传一次只会漏掉某一处。server 侧必填。
 */
export async function advanceDiagnosis({ id, from, to, traceId, reason }) {
  const body = { from, to, by: operator() };
  if (traceId) body.trace_id = traceId;
  // reason 只在 to=blocked 时给；给错了 server 会 400 而不是静默忽略——
  // 静默忽略的话调用方以为自己记下了理由，而它哪儿都没落。
  if (reason) body.reason = reason;
  try {
    const out = await call(path(`/${encodeURIComponent(id)}/advance`), { method: "POST", body: JSON.stringify(body) });
    return out?.data ?? null;
  } catch (e) {
    if (e.status === 409) return null;
    throw e;
  }
}

/**
 * 把一条**已经抢到手**的行挡住（蓝图 0028）。开跑前的检查不过就走这里。
 *
 * 走的是同一条 advance，不是另一条路：挡住本身就是一次带 from 断言的状态变更，而那条断言
 * 正是防「已经死掉的进程改活任务」的东西。`from` 只能是 diagnosing / judging——loop 是
 * **先抢到手再检查**的，server 侧也照这条挡（从别的态挡进来它算不出解除时该回哪一步）。
 *
 * 解除不用另写函数：把行上的 `resume_status` 原样当 `to` 传给 advanceDiagnosis 就行。
 */
export async function blockDiagnosis({ id, from, reason }) {
  return advanceDiagnosis({ id, from, to: DIAG_BLOCKED, reason });
}

const llmobsPath = (resource, qs) => `${baseUrl().replace(/\/+$/, "")}/api/v1/llm-obs/${resource}${qs ? `?${qs}` : ""}`;
const rowsOf = (out) => (Array.isArray(out) ? out : (out?.data ?? []));

/**
 * 列判题行（§15.6 / §15.8：复现、诊断、判题三张表，这是判题那张）。一行 = 对某次诊断判的一次卷，
 * 判完的带 `judgement` 快照 `{labels, annotator, rubric_version}` 与 `judged_at`。
 *
 * 为什么判题历史要读它而不是批注表：同一条 trace 可以判好几次，批注表只放最近一次判完的
 * （D5「投影覆盖、历史保留」），之前每一次判成什么只留在各自那一行的快照里。
 *
 * 过滤参数一个值一个请求，不拼逗号——那几个参数收不收多值没有对照过，拼错了 server 回空，
 * 看起来就像「这道题没判过」。
 */
export async function listJudgements({ recordId, diagnosisId, traceId, statuses, limit } = {}) {
  const q = new URLSearchParams();
  if (recordId) q.set("record_id", recordId);
  if (diagnosisId) q.set("diagnosis_id", diagnosisId);
  if (traceId) q.set("trace_id", traceId);
  if (statuses?.length) q.set("status", statuses.join(","));
  if (limit) q.set("limit", String(limit));
  return rowsOf(await call(llmobsPath("case-judgements", q.toString())));
}

/**
 * 列诊断行（§15.8 三张表里的诊断那张）。一行 = 在某次复现窗口上跑的一次诊断，带 `trace_id`、
 * 诊断记录建行时刻 `created_at`，以及从复现带出来的窗口（`window_start` / `window_end` / `instance` / `expires_at`）。
 * 窗口字段名照老表 `case-diagnoses` 的写（推的，server 上线后按真响应核）。
 */
export async function listDiagnosisRuns({ recordId, reproductionId, statuses, limit } = {}) {
  const q = new URLSearchParams();
  if (recordId) q.set("record_id", recordId);
  if (reproductionId) q.set("reproduction_id", reproductionId);
  if (statuses?.length) q.set("status", statuses.join(","));
  if (limit) q.set("limit", String(limit));
  return rowsOf(await call(llmobsPath("case-diagnosis-runs", q.toString())));
}

/**
 * 一道题一个请求、并发几个，行合在一起回；接口 404 回 `null`（server 还没有这张表）。
 * 一道题的行数顶到 `limit` 就抛：server 按时间倒序截断，截掉的是**最早**的几行，
 * 待复验清单会把早就关掉的条目算成还开着（§13.2 #2 那种静默截断，不许再来一次）。
 */
async function perRecord(recordIds, fetchOne, { limit = 1000, concurrency = 6, what }) {
  const ids = [...new Set([...(recordIds ?? [])].filter(Boolean))];
  const rows = [];
  let next = 0;
  let missing = false;
  const worker = async () => {
    while (!missing && next < ids.length) {
      const id = ids[next++];
      let got;
      try {
        got = await fetchOne(id, limit);
      } catch (e) {
        if (e.status === 404) { missing = true; return; }
        throw e;
      }
      if (got.length >= limit) {
        throw new Error(`用例 ${id} 的${what}顶到了 limit=${limit}：server 截掉的是最早的几行，待复验清单会算错——调大 limit 再跑`);
      }
      rows.push(...got);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
  return missing ? null : rows;
}

/**
 * 一批题的全部判题行，给 `priorJudgments` 读快照用。回 `null` = server 还没有判题表（接口 404），
 * 调用方退回读批注表那条老路（那时每条 trace 只看得到最近一次判题）——脚本不因此失败，但要说出来。
 */
export async function judgementsOfRecords(recordIds, { limit = 1000, concurrency = 6, onFallback } = {}) {
  const rows = await perRecord(recordIds, (id, lim) => listJudgements({ recordId: id, limit: lim }), { limit, concurrency, what: "判题行" });
  if (!rows) {
    (onFallback ?? ((m) => console.error(m)))(
      "⚠ server 还没有判题表接口（GET /api/v1/llm-obs/case-judgements 回 404）：判题历史退回读批注表，同一条诊断判过几次也只看得到最近一次",
    );
  }
  return rows;
}

/** 一批题的全部诊断行（新表）。回 `null` = server 还没有诊断表（接口 404）。 */
export async function diagnosisRunsOfRecords(recordIds, { limit = 1000, concurrency = 6 } = {}) {
  return perRecord(recordIds, (id, lim) => listDiagnosisRuns({ recordId: id, limit: lim }), { limit, concurrency, what: "诊断行" });
}

/**
 * 读判题历史要的两样一次取齐：判题表的快照（每一次判题一份）与诊断表的诊断时刻（复验的时间轴，§15.5）。
 * 哪样的接口 404 就给空数组并说一句退回了什么——脚本不因 server 还没上线三张表而失败。
 */
export async function caseHistoryOfRecords(recordIds, { onFallback } = {}) {
  const say = onFallback ?? ((m) => console.error(m));
  const [judgements, diagnosisRuns] = await Promise.all([
    judgementsOfRecords(recordIds, { onFallback: say }),
    diagnosisRunsOfRecords(recordIds),
  ]);
  if (!diagnosisRuns) {
    say("⚠ server 还没有诊断表接口（GET /api/v1/llm-obs/case-diagnosis-runs 回 404）：诊断时间退回用 trace 的开始时刻");
  }
  return { judgements: judgements ?? [], diagnosisRuns: diagnosisRuns ?? [], hasDiagnosisRuns: Boolean(diagnosisRuns) };
}

/**
 * 老表 `case-diagnoses` 的行（一行 = 复现 + 诊断 + 判题，带 `trace_id` 与窗口）。修复工作包要复现窗口时，
 * 诊断表 `case-diagnosis-runs` 404 就退回读它；它也 404 回 `null`。
 *
 * 只拿它的窗口，不拿它的 `created_at` 当诊断时间：老表那一格是复现回执落地的时刻，诊断是之后才跑的，
 * 拿它排时间轴会把修复之后才跑的诊断排到修复之前。
 */
export async function legacyDiagnosesOfRecords(recordIds, { limit = 1000 } = {}) {
  return perRecord(recordIds, (id, lim) => listDiagnoses({ recordIds: [id], limit: lim }), { limit, concurrency: 6, what: "诊断行（老表）" });
}

/** 列诊断行（看积压用）。statuses 为空 = 不筛。 */
export async function listDiagnoses({ statuses, recordIds, blockedReasons, limit } = {}) {
  const q = new URLSearchParams();
  if (statuses?.length) q.set("status", statuses.join(","));
  if (recordIds?.length) q.set("record_id", recordIds.join(","));
  // 只捞「会自己好」那一族（环境族）时用它。数据族捞回来也没用——现场已经不存在了，
  // 再探一百次也不会变出来，放回队列只会被下一轮再挡一次。
  if (blockedReasons?.length) q.set("blocked_reason", blockedReasons.join(","));
  if (limit) q.set("limit", String(limit));
  const qs = q.toString();
  const out = await call(path(qs ? `?${qs}` : ""));
  return out?.data ?? [];
}

/**
 * 连着抢，最多 max 条，直到没得抢为止。
 *
 * 一轮抢多条再一起跑，是为了保住「一轮 = 一个 experiment」这条既有口径（重测挂 --parent
 * 才有对照物）。代价是进程被杀时有 max 条卡在 diagnosing——那正是租约要兜的事。
 */
export async function claimBatch({ claimedBy, staleAfterSec, max }) {
  const out = [];
  for (let i = 0; i < max; i++) {
    const row = await claimDiagnosis({ claimedBy, staleAfterSec });
    if (!row) break;
    out.push(row);
  }
  return out;
}
