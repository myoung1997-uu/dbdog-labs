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
// 入参统一是 `priorJudgments()` / `case-history.mjs` 的那个形状（旧的在前）：
//   `[{round, round_id, created_at, trace_id, judged?, items, checks, fix_marks}]`
//   items / checks 已经过 `normalizeFindings`（旧批注按固定映射读成两类）。
import { FINDING_CLASSES, DECISIONS, normalizeFindings } from "./judge-package.mjs";

/**
 * 关得松紧按类别（§13.3）：**确定是 bug** 一轮 `fixed` 即关（重放变对就是变对）；
 * **说法会误导**是给模型的话，非确定性——一轮没再犯可能只是这次运气好，要连续两轮；
 * 要人定的其余三档（缺能力 / 题目有问题 / 看不出是不是 bug）拍完板改的是确定的东西，一轮即关。
 */
const REQUIRED_FIXED_ROUNDS = (s) => (s?.class === "needs_decision" && s?.decision === "wording" ? 2 : 1);

/**
 * 修的人标了 `wont_fix` 的不进清单：他已经说了这条不修，再让每一轮判官去复验，
 * 只会让「漏验」的数字随轮次单调上涨，把真正漏掉的那几条淹掉。
 * `needs_human`（要人协助）与 `claimed_fixed`（改了等复验）都还留在清单里——前者还没了结，
 * 后者恰恰**必须**复验：标记是声明，复验才是判决。
 *
 * 2026-09-13 起**没有「不复验」那一档**了：旧口径里 `model` 只计次、`unsure` 等人核，两类都不进
 * 待复验清单；现在这两种都落进「要人定」，而要人定的东西拍完板照样要改、改完照样要看下一轮还犯不犯。
 */
const MARK_CLOSES = new Set(["wont_fix"]);

const roundsOf = (rounds) => (rounds ?? []).filter((r) => r && (r.items || r.checks));

const classOf = (x, fallback) => (FINDING_CLASSES.includes(x?.class) ? x.class : fallback);
const decisionOf = (x, fallback) => (DECISIONS.includes(x?.decision) ? x.decision : fallback);

/**
 * 走一遍历史，算出每个 key 的当前状态。
 * @returns {Map<string,{key:string,class:string,decision:string|null,open:boolean,streak:number,last_status:string,since:string,fix_mark:string|null}>}
 */
function replay(rounds) {
  const state = new Map();
  for (const r of roundsOf(rounds)) {
    const items = Array.isArray(r.items) ? r.items : normalizeFindings(r).items;
    const checks = Array.isArray(r.checks) ? r.checks : [];
    for (const it of items) {
      const key = String(it?.key ?? "");
      if (!key) continue;
      // 关了之后又被当新条目提出来 = 重新算没关（判卷口径：换个 key 把老问题当新的提更不行）。
      // **修复标记要留着**：它跟的是这个问题，不是某一轮——上一轮打的 claimed_fixed，
      // 这一轮重提时清掉的话，判官就不知道「有人说改过了，该特意走那条路去验」。
      const prev = state.get(key);
      state.set(key, {
        key,
        class: classOf(it, "true_bug"),
        decision: decisionOf(it, null),
        open: true, streak: 0, last_status: "proposed",
        since: prev?.since ?? r.round, fix_mark: prev?.fix_mark ?? null,
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
        state.set(key, { ...next, streak, last_status: "fixed", open: streak < REQUIRED_FIXED_ROUNDS(next) });
      } else if (c.status === "still_open") {
        state.set(key, { ...next, streak: 0, last_status: "still_open", open: true });
      } else if (c.status === "not_exercised") {
        // 不算数：那一条维持原状（既不关，也不算又撞上）。**也不打断「说法会误导」那一档的连胜**——
        // 「连续两轮 fixed」数的是两次**有效复验**，中间夹一轮没走到那条路不该把计数清零，
        // 否则一条走得少的路永远关不掉。
        state.set(key, { ...next, last_status: "not_exercised" });
      }
    }
    const marks = r.fix_marks && typeof r.fix_marks === "object" ? r.fix_marks : {};
    for (const [key, m] of Object.entries(marks)) {
      const cur = state.get(key);
      if (cur) state.set(key, { ...cur, fix_mark: m?.status ?? (String(m ?? "") || null) });
    }
  }
  return state;
}

/**
 * 还没关的条目 = 下一轮**必须逐条复验**的清单。判题会话开判前先拿它，判完对着它点名，
 * 比让判官自己从 `prior-judgments.json` 里推可靠。修复 loop（`fix-run`）也吃这一份。
 */
export function openFindings(rounds) {
  return [...replay(rounds).values()]
    .filter((s) => s.open && !MARK_CLOSES.has(s.fix_mark))
    .map(({ key, class: cls, decision, last_status, since, fix_mark }) => ({ key, class: cls, decision, last_status, since, fix_mark }));
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
  let marked = 0; let wontFix = 0; let needsHumanMark = 0;
  const markByKey = new Map();
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
    for (const [key, m] of Object.entries(r.fix_marks && typeof r.fix_marks === "object" ? r.fix_marks : {})) {
      const st = m?.status ?? m;
      if (st) markByKey.set(key, st);   // 同一个 key 被标了好几轮，只算最后一次（见下）
    }
  }
  // 无效条目率的分母是**条目**，不是「轮次 × 条目」：一个 key 在三轮里都带着标记，
  // 按轮次数会把它算三次，把比率算歪。
  for (const st of markByKey.values()) {
    marked += 1;
    if (st === "wont_fix") wontFix += 1;
    if (st === "needs_human") needsHumanMark += 1;
  }

  const last = list[list.length - 1];
  const due = last ? openFindings(list.slice(0, -1)) : [];
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
    check_coverage: { due: due.length, checked: due.length - missed.length, missed },
    open_now: openFindings(list).length,
  };
}
