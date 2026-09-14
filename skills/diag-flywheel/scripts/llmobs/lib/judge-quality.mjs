// judge-quality.mjs —— 判官自己的质量，以及「哪些条目还没关」这张清单。
//
// ## 为什么把「还没关」做成代码
//
// 规则本身一句话（最后一次有效复验不是 `fixed` 就算没关；说法会误导那一档非确定性、要连续两轮），
// 但跑它的原先是人：判官得自己在几十条历史里跑一遍状态机，而校验器只查每条 check 的形状、不查覆盖率——
// 漏三条没人拦得住，页面上那三个问题就一直开着，分不清是「真没修好」还是「这轮忘了验」。
// 规则确定、输入齐全、跑一遍就有答案：这正是该由代码兜的事（军规 3）。
//
// ## 为什么要量无效条目率
//
// Tricorder（Google 的静态分析平台）的经验：误报率一过 ~10%，开发者就整体不看了。我们有现成的
// 投票——修的人打的 `wont_fix`。不量它，「这一轮挖出 N 条」只奖励产量；量了，才是奖励有效性。
// 弃判率（`decision: is_bug`）同理要单列：两边都不敢判也能凑出很好看的产量。
//
// ## 时间轴是诊断时间（§15.5，2026-09-14 定）
//
// 判题事件按它**所属那次诊断**的时间排，修复标记按 `at` 排。trace 的内容定下来就不会变：
// 修复之前跑出来的诊断，重判几次看到的都是修复前的路径，它的 `still_open` / 同 key 再提
// 不能推翻修复之后的状态；只有诊断时间**晚于**那份标记的，才能重开或推翻复测结果。
//
// 入参统一是 `priorJudgments()` / `case-history.mjs` 的那个形状（按诊断时间排，旧的在前）：
//   `[{round, round_id, created_at, trace_id, diagnosed_at?, judged?, items, checks, fix_marks, diagnosis_id?, judged_at?}]`
//   items / checks 已经过 `normalizeFindings`（旧批注按固定映射读成两类）。
import { FINDING_CLASSES, DECISIONS, FIX_MARK_DATA, FIX_MARK_VERIFY, normalizeFindings, diagnosisTimeOf } from "./judge-package.mjs";

/**
 * 关得松紧按类别（§13.3）：**确定是 bug** 一轮 `fixed` 即关（重放变对就是变对）；
 * **说法会误导**是给模型的话，非确定性——一轮没再犯可能只是这次运气好，要连续两轮；
 * 要人定的其余三档（缺能力 / 题目有问题 / 看不出是不是 bug）拍完板改的是确定的东西，一轮即关。
 */
const REQUIRED_FIXED_ROUNDS = (s) => (s?.class === "needs_decision" && s?.decision === "wording" ? 2 : 1);

/**
 * 修的人标了 `wont_fix` 的不进清单：他已经说了这条不修，再让每一轮判官去复验，
 * 只会让「漏验」的数字随轮次单调上涨，把真正漏掉的那几条淹掉。
 * `needs_human`（要人协助）与 `claimed_fixed`（改了，等复测 / 等下次判题验证）都还留在清单里——前者还没了结，
 * 后者恰恰**必须**复验：标记是声明，复验才是判决。唯一的例外是下面 `closesByVerify` 那一条。
 *
 * 2026-09-13 起**没有「不复验」那一档**了：旧口径里 `model` 只计次、`unsure` 等人核，两类都不进
 * 待复验清单；现在这两种都落进「要人定」，而要人定的东西拍完板照样要改、改完照样要看下一轮还犯不犯。
 */
const MARK_CLOSES = new Set(["wont_fix"]);

/**
 * 确定是 bug 的，**在自己这一层复测闭环**（§15.5，owner 2026-09-14：「我不能容忍这些 true-bug 在呀」）：
 * 修的人部署后在挖出它的那次诊断的原窗口原样重放 `repro`，拿到 `expected` 说的样子，就打
 * `claimed_fixed + verify: passed`——这一条**即关，不等重跑**。
 *
 * 为什么只认确定是 bug：判官核实过它是确定性的错，重放是确定的，重放变对就是变对，和下一轮复验
 * `fixed` 是同一个判据，只是换了个人来跑。要人定的几档（尤其说法会误导）靠重跑才看得出模型变没变，
 * 修的人自己重放一次不算数，照旧由之后的判题复验关。
 * 数据修不回来的没有原窗口可验（写口也拒这个组合），读侧再挡一次。
 */
const closesByVerify = (cls, m) => cls === "true_bug" && m.status === "claimed_fixed" && m.verify === "passed" && m.data !== "unrepairable";

const roundsOf = (rounds) => (rounds ?? []).filter((r) => r && (r.items || r.checks));

const classOf = (x, fallback) => (FINDING_CLASSES.includes(x?.class) ? x.class : fallback);
const decisionOf = (x, fallback) => (DECISIONS.includes(x?.decision) ? x.decision : fallback);
const asObj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

/** 一轮判题在时间轴上的位置：它所属那次诊断的时间。解析不了回 NaN。 */
const timeOf = (r) => Date.parse(diagnosisTimeOf(r));

/**
 * 给**某次诊断**判题时，哪些轮次算「之前」：诊断时间比它早的，且不是同一条 trace。
 * 同一条 trace 自己提出的问题不复验——trace 内容不会变，拿它验它自己，验出来的永远是「又撞上」。
 * 时刻比不出先后的（缺时间）不算之前：宁可少验一条，也不拿一条先后不明的诊断去复验。
 */
export function isBeforeDiagnosis(round, { traceId, diagnosedAt }) {
  if (!round || round.trace_id === traceId) return false;
  const t = timeOf(round);
  const cut = Date.parse(diagnosedAt ?? "");
  return !Number.isNaN(t) && !Number.isNaN(cut) && t < cut;
}

/** 一份修复标记读成统一形状；词表外的 data / verify 当没写（不猜它是什么意思）。 */
function markOf(raw) {
  const m = asObj(raw);
  return {
    status: m.status ?? (typeof raw === "string" && raw ? raw : null),
    data: FIX_MARK_DATA.includes(m.data) ? m.data : null,
    verify: FIX_MARK_VERIFY.includes(m.verify) ? m.verify : null,
  };
}

/**
 * 全部修复标记摊到时间轴上：有 `at` 的按 `at`，没有的（2026-09-11 之前的老标记）排在它所在那一轮的时刻上。
 * 同时刻按轮次先后。回 `[{key, raw, t, idx}]`，已排好序。
 */
function markEvents(list) {
  const out = [];
  list.forEach((r, idx) => {
    for (const [key, raw] of Object.entries(asObj(r.fix_marks))) {
      out.push({ key, raw, t: Date.parse(asObj(raw).at ?? ""), idx });
    }
  });
  const eff = (e) => (Number.isNaN(e.t) ? timeOf(list[e.idx]) : e.t);
  return out.sort((a, b) => {
    const ea = eff(a); const eb = eff(b);
    if (!Number.isNaN(ea) && !Number.isNaN(eb) && ea !== eb) return ea - eb;
    return a.idx - b.idx;
  });
}

/**
 * 每个 key 的**最新**一份修复标记（原样对象）。同一个 key 可能在几条 trace 上各打过一份，按时间取最后一份。
 * 工作包（`fix-context.mjs`）与质量账都吃这一份，别各自按轮次顺序再挑一遍。
 * @returns {Map<string, object>}
 */
export function latestFixMarks(rounds) {
  const out = new Map();
  for (const e of markEvents(roundsOf(rounds))) {
    const m = asObj(e.raw);
    out.set(e.key, Object.keys(m).length ? m : { status: String(e.raw ?? "") });
  }
  return out;
}

/**
 * 走一遍历史，算出每个 key 的当前状态。判题按所属诊断的时间先后吃；修复标记按 `at` 插进它该在的位置——
 * 诊断时间晚于标记的那次判题排在标记后面，它撞上才能把复测通过重新打开；早于标记的排在前面，撞上也不作数。
 *
 * @param {object} [opts]
 * @param {number} [opts.asOf] 只认这个时刻之前打的标记（算「最后一次判题开判前该验哪几条」时用）
 * @param {{traceId:string, diagnosedAt:string}} [opts.before] 只吃这次诊断之前的判题（`isBeforeDiagnosis`）；
 *   修复标记不受它限制——标记打在哪条 trace 上都作数
 * @returns {Map<string,{key:string,class:string,decision:string|null,open:boolean,streak:number,last_status:string,since:string,
 *   fix_mark:string|null,fix_data:string|null,fix_verify:string|null,fix_mark_superseded:boolean,closed_by:string|null}>}
 */
function replay(rounds, { asOf = NaN, before } = {}) {
  const list = roundsOf(rounds);
  const state = new Map();

  // 有 `at` 的标记进待插队列（按时间排好）；没有 `at` 的跟在它那一轮后面。
  const timed = [];
  const untimed = list.map(() => []);
  for (const e of markEvents(list)) {
    if (Number.isNaN(e.t)) untimed[e.idx].push(e);
    else if (Number.isNaN(asOf) || e.t < asOf) timed.push(e);
  }

  const applyMark = (e) => {
    const cur = state.get(e.key);
    const m = markOf(e.raw);
    let next = { ...cur, fix_mark: m.status || null, fix_data: m.data, fix_verify: m.verify, fix_mark_superseded: false };
    if (closesByVerify(cur.class, m)) next = { ...next, open: false, closed_by: "verify" };
    // 之前是靠复测关的，现在最新那份标记不再是「复测通过」（改打了没过 / 要人协助）：复测那一票作废，重新打开。
    // 靠复验 `fixed` 关的不受标记影响——复验才是判决。
    else if (cur.closed_by === "verify") next = { ...next, open: true, closed_by: null };
    state.set(e.key, next);
  };
  // 时刻早于 `limit` 的标记插进来。key 还没被提出过的（时钟有偏差、标记比判题早几秒）先留着，等它出现再挂。
  const flushBefore = (limit) => {
    for (let j = 0; j < timed.length;) {
      const e = timed[j];
      if (!(e.t < limit)) break;
      if (state.has(e.key)) { applyMark(e); timed.splice(j, 1); } else j += 1;
    }
  };

  list.forEach((r, idx) => {
    const t = timeOf(r);
    if (!Number.isNaN(t)) flushBefore(t);
    const counted = !before || isBeforeDiagnosis(r, before);
    const items = !counted ? [] : Array.isArray(r.items) ? r.items : normalizeFindings(r).items;
    const checks = !counted ? [] : Array.isArray(r.checks) ? r.checks : [];
    for (const it of items) {
      const key = String(it?.key ?? "");
      if (!key) continue;
      // 关了之后又被当新条目提出来 = 重新算没关（判卷口径：换个 key 把老问题当新的提更不行）。
      // 靠复测关的也一样：又撞上了就说明没修好，复测那一票被这一轮判题盖掉。
      // **修复标记要留着**：它跟的是这个问题，不是某一轮——上一轮打的 claimed_fixed，
      // 这一轮重提时清掉的话，判官就不知道「有人说改过了，该特意走那条路去验」。
      // 但它已经被这一轮盖过了（`fix_mark_superseded`），不再算「有人接了」。
      const prev = state.get(key);
      state.set(key, {
        key,
        class: classOf(it, "true_bug"),
        decision: decisionOf(it, null),
        open: true, streak: 0, last_status: "proposed", closed_by: null,
        since: prev?.since ?? r.round,
        fix_mark: prev?.fix_mark ?? null, fix_data: prev?.fix_data ?? null, fix_verify: prev?.fix_verify ?? null,
        fix_mark_superseded: Boolean(prev?.fix_mark),
      });
    }
    for (const c of checks) {
      const key = String(c?.key ?? "");
      const cur = state.get(key);
      if (!key || !cur) continue;
      // 复验带的类别照原条目写；旧批注的 check 不带类别（比原条目少一维），退回原条目的。
      const next = { ...cur, class: classOf(c, cur.class) };
      if (c.status === "fixed") {
        const streak = cur.streak + 1;
        const open = streak < REQUIRED_FIXED_ROUNDS(next);
        state.set(key, { ...next, streak, last_status: "fixed", open, closed_by: open ? null : "check", fix_mark_superseded: Boolean(cur.fix_mark) });
      } else if (c.status === "still_open") {
        state.set(key, { ...next, streak: 0, last_status: "still_open", open: true, closed_by: null, fix_mark_superseded: Boolean(cur.fix_mark) });
      } else if (c.status === "not_exercised") {
        // 不算数：那一条维持原状（既不关，也不算又撞上）。**也不打断「说法会误导」那一档的连胜**——
        // 「连续两轮 fixed」数的是两次**有效复验**，中间夹一轮没走到那条路不该把计数清零，
        // 否则一条走得少的路永远关不掉。
        state.set(key, { ...next, last_status: "not_exercised" });
      }
    }
    for (const e of untimed[idx]) if (state.has(e.key)) applyMark(e);
  });
  flushBefore(Infinity);
  return state;
}

/**
 * 还没关的条目 = 下一轮**必须逐条复验**的清单。判题会话开判前先拿它，判完对着它点名，
 * 比让判官自己从 `prior-judgments.json` 里推可靠。修复 loop（`fix-run`）也吃这一份。
 * 给某次诊断判题时传 `{ before: {traceId, diagnosedAt} }`：只收比它更早的诊断里提出的问题。
 *
 * 每条带修复标记的三格：`fix_mark`（状态）/ `fix_data`（数据情况）/ `fix_verify`（复测结果），
 * 以及 `fix_mark_superseded`：标记之后又有判题复验过或重提过它——标记被盖掉了，不再算「有人接了」。
 */
export function openFindings(rounds, opts) {
  return [...replay(rounds, opts).values()]
    .filter((s) => s.open && !MARK_CLOSES.has(s.fix_mark))
    .map(({ key, class: cls, decision, last_status, since, fix_mark, fix_data, fix_verify, fix_mark_superseded }) => (
      { key, class: cls, decision, last_status, since, fix_mark, fix_data, fix_verify, fix_mark_superseded }
    ));
}

/**
 * 这道题（或这一批）的判题质量账。`check_coverage` 算的是**最后一轮**：开判前该验几条、实际验了几条。
 *
 * 「要人」的两个数**分开报，不相加**：判官说这条要人定（分诊结果）与修的人说这条要人协助
 * （修到一半卡住了）是两件事，找的也是不同的人；加在一起那个数谁也解释不了。
 */
export function qualityReport(rounds) {
  const list = roundsOf(rounds);
  const byClass = {};
  const byDecision = {};
  let itemsTotal = 0; let abstained = 0; let needsDecisionItems = 0;
  let marked = 0; let wontFix = 0; let needsHumanMark = 0; let verifyPassed = 0; let verifyFailed = 0;
  for (const r of list) {
    const items = Array.isArray(r.items) ? r.items : normalizeFindings(r).items;
    for (const it of items) {
      itemsTotal += 1;
      const cls = classOf(it, "unknown");
      byClass[cls] = (byClass[cls] ?? 0) + 1;
      if (cls !== "needs_decision") continue;
      needsDecisionItems += 1;
      const d = decisionOf(it, "unknown");
      byDecision[d] = (byDecision[d] ?? 0) + 1;
      if (d === "is_bug") abstained += 1;
    }
  }
  // 无效条目率的分母是**条目**，不是「轮次 × 条目」：一个 key 在三轮里都带着标记，
  // 按轮次数会把它算三次，把比率算歪。同一个 key 被标了好几次，只算时间上最后一次。
  for (const raw of latestFixMarks(list).values()) {
    const m = markOf(raw);
    if (!m.status) continue;
    marked += 1;
    if (m.status === "wont_fix") wontFix += 1;
    if (m.status === "needs_human") needsHumanMark += 1;
    if (m.status === "claimed_fixed" && m.verify === "passed") verifyPassed += 1;
    if (m.status === "claimed_fixed" && m.verify === "failed") verifyFailed += 1;
  }

  const last = list[list.length - 1];
  // 最后一次判题开判前该验哪几条：只收比它那次诊断更早的诊断里提出的问题，只认**判之前**打的标记——
  // 之后才打的「复测通过」不能倒回去把它从该验清单里拿掉，否则漏验会被算成没漏。
  const judgedAt = Date.parse(last?.judged_at ?? "");
  const due = last
    ? openFindings(list, { before: { traceId: last.trace_id, diagnosedAt: diagnosisTimeOf(last) }, asOf: Number.isNaN(judgedAt) ? timeOf(last) : judgedAt })
    : [];
  const checkedKeys = new Set((last?.checks ?? []).map((c) => String(c?.key ?? "")));
  const missed = due.filter((d) => !checkedKeys.has(d.key)).map((d) => d.key);

  return {
    rounds: list.length,
    items_total: itemsTotal,
    by_class: byClass,
    by_decision: byDecision,
    // 弃判单列：它不是一条「挖到的问题」，动作也相反（去核，不是去修）
    abstention_rate: itemsTotal ? abstained / itemsTotal : 0,
    // 判官分诊说「这条要人定」的条目数
    needs_decision_items: needsDecisionItems,
    // 修的人打 `needs_human` 标记的条目数（修到一半要人协助）——与上面那个不是一回事，别相加
    needs_human_marks: needsHumanMark,
    // 无效条目率：分母只算**被修的人标过的**条目——没人标过的不能当成都有效
    marked,
    wont_fix: wontFix,
    wont_fix_rate: marked ? wontFix / marked : null,
    // 修的人在原窗口复测的结果（§15.5），按条目的最新标记数：通过的对确定是 bug 即关，没过的还开着
    verify_passed: verifyPassed,
    verify_failed: verifyFailed,
    check_coverage: { due: due.length, checked: due.length - missed.length, missed },
    open_now: openFindings(list).length,
  };
}
