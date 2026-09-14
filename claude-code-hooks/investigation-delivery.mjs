import { buildInvestigation } from "./investigation-events.mjs";

export const REPORT_HEADINGS = ["What happened", "Why that broke things", "How do we know", "The root cause", "What to do to fix"];
// Presentation only: retain unmodified originals in spans. An unfinished record block
// consumes the remaining text, so a truncated JSON prefix never becomes a report.
export function reportText(value = "") {
  return value.replace(/^([ \t]*)(`{3,}|~{3,})dbdog-investigation[^\n]*\r?\n[\s\S]*?(?:^\1\2[ \t]*(?=\r?$)|$(?![\s\S]))/gm, "").trim();
}
export function missingReportSections(value) {
  const prose = reportText(value);
  const headings = [...prose.matchAll(/^##[ \t]+(.+?)[ \t]*\r?$/gm)];
  return REPORT_HEADINGS.filter(title => {
    const at = headings.findIndex(h => h[1] === title);
    return at < 0 || !prose.slice(headings[at].index + headings[at][0].length, headings[at + 1]?.index).trim();
  });
}

/** Current delivery obligations, not a proof of database causality. Historical
 * rejected/obsolete judgments stay in diagnostics but cannot permanently block repair. */
export function investigationIssues(inv, { final = false, report = "" } = {}) {
  if (!inv) return [];
  const issues = [], add = value => { if (!issues.includes(value)) issues.push(value); };
  const hs = new Map(inv.hypotheses.map(h => [h.id, h]));
  const rs = new Map(inv.relations.map(r => [r.id, r]));
  const os = new Map(inv.observations.map(o => [o.id, o]));
  const branch = new Map(inv.branches.map(b => [b.hypothesis, b]));
  const declared = new Set(inv.events.map(e => e.id));
  for (const d of inv.diagnostics) if (d.code === "invalid_event" && !declared.has(d.event_id)) add(`${d.event_id}: ${d.problem ?? "invalid event; inspect the recording schema"}`);
  if (!final) {
    for (const d of inv.diagnostics) {
      if (d.code === "invalid_event_json") add(`${d.span_id}: investigation block is not valid JSON; none of its records were accepted. Correct its JSON using the original intended records.`);
      if (d.code === "duplicate_observation") add(`${d.observation}: this observation ID is already saved; repeating it does not replace its sources. Use a new observation ID, then new updates and finish referencing the correction.`);
      if (d.code === "unknown_check") add(`${d.observation}: referenced check ${d.check} is undeclared; record the actual check purpose or correct the association.`);
    }
    for (const o of os.values()) for (const s of o.sources.filter(s => !s.matched)) add(`${o.id}/${s.ref}: quote was not verified in the original result. Copy a short contiguous exact excerpt, without paraphrase, calculations or added ellipses. This observation is already saved: use a NEW observation ID for corrected sources and point subsequent judgments to it. Put interpretation in summary/links, not quote.`);
  }
  for (const b of branch.values()) {
    if (!hs.has(b.hypothesis)) add(`${b.hypothesis}: branch exists but hypothesis is undeclared; emit hypothesis with its actual scoped claim`);
    for (const p of b.parents) if (p !== "question" && !hs.has(p)) add(`${p}: undeclared parent hypothesis`);
  }
  for (const h of hs.values()) if (!branch.has(h.id)) add(`${h.id}: missing branch with explicit parents and reason`);
  for (const c of inv.checks) for (const id of c.hypotheses) if (!hs.has(id)) add(`${id}: check ${c.id} targets an undeclared hypothesis`);
  for (const r of rs.values()) if (!r.endpoints_resolved) add(`${r.id}: relation has undeclared endpoints`);
  for (const d of inv.diagnostics) if (d.code === "investigation_parent_cycle") add("branch: investigation parents form a cycle; correct the explicit parents");
  if (!final) return issues;
  if (!inv.checkpoints.length) add("checkpoint: record the actual investigation question and scope");
  const finish = inv.finishes.at(-1);
  if (!finish || inv.state === "active") add("finish: record the current conclusion, stopping reason, answer claim IDs and remaining evidence boundaries after the last change");
  for (const h of [...hs.values(), ...rs.values()]) {
    const decision = h.history.at(-1);
    if (!decision) { add(`${h.id}: no current judgment; record supported/refuted/inconclusive/open and explain what remains`); continue; }
    if (h.assessment_current === false) add(`${h.id}: judgment predates the current claim; reassess its observations`);
    // Explicit evidence boundaries may explain unavailable linkage; they are not a pass on causality.
    const boundary = inv.gaps.some(g => (g.hypotheses ?? []).includes(h.id) || (g.relations ?? []).includes(h.id));
    if (!decision.evidence.length && !boundary) add(`${h.id}: judgment has no observations; record evidence or a scoped gap describing unavailable linkage`);
    for (const id of decision.evidence) {
      const o = os.get(id);
      if (!o) add(`${h.id}: missing observation ${id}`);
      else if ((!o.sources.length || o.sources.some(s => !s.matched)) && !boundary) add(`${h.id}/${id}: source linkage is unverified; repair from the actual result or record a scoped gap`);
      if (o?.check && !inv.checks.some(c => c.id === o.check)) add(`${h.id}/${id}: referenced check ${o.check} is undeclared; record the actual check or use a corrected observation with the right association`);
    }
    if (decision.reference_check === "incomplete" && !boundary) add(`${h.id}: latest judgment has incomplete references or interpretations; re-link evidence to the current claim and emit a new update`);
  }
  if (finish) {
    if (!Array.isArray(finish.answer_hypotheses) || !Array.isArray(finish.answer_relations)) add("finish: explicitly list answer_hypotheses and answer_relations (empty only where not used)");
    for (const id of finish.answer_hypotheses ?? []) if (!hs.has(id)) add(`${id}: finish references an undeclared hypothesis`);
    for (const id of finish.answer_relations ?? []) if (!rs.has(id)) add(`${id}: finish references an undeclared relation`);
    for (const id of finish.evidence) if (!os.has(id)) add(`${id}: finish references a missing observation`);
  }
  for (const title of missingReportSections(report)) add(`report: missing or empty "## ${title}"`);
  return issues;
}

export function deliveryFeedback(spans, report, previous = {}) {
  let inv = buildInvestigation(spans);
  if (!inv && spans.some(s => s.kind === "tool" && /dbm-(?:opengauss|postgres)[^"\n]*investigate/.test(typeof s.input === "string" ? s.input : JSON.stringify(s.input)))) {
    inv = { events: [], diagnostics: [], hypotheses: [], relations: [], observations: [], branches: [], checks: [], gaps: [], finishes: [], checkpoints: [], state: "active" };
  }
  if (!inv) return { state: previous, output: null };
  const issues = investigationIssues(inv, { final: true, report });
  if (!issues.length) return { state: { status: "complete", attempts: previous.attempts ?? 0, issues: [] }, output: null };
  const attempts = previous.attempts ?? 0;
  // Bound automatic correction. A failed delivery remains explicitly incomplete;
  // the runner must surface it rather than accepting it as a normal completed run.
  const state = { status: "incomplete", attempts: attempts + 1, issues };
  const reason = `dbdog investigation delivery needs repair (structure/references/report only; this does not verify causality).\n${issues.slice(0, 20).map(x => "- " + x).join("\n")}\nRepair using existing actual results and the recovery command; do not repeat database calls just to fill fields, invent references/claims, or erase contradictory history. A branch is not a hypothesis declaration. Re-emit schema-rejected events with the same id. An accepted observation is immutable even when its quote fails: use a NEW observation ID with a short contiguous exact quote from the original result (no paraphrase, calculations or added ellipses), then NEW updates and finish referencing it. Repeating the old observation ID cannot repair it. Interpretation belongs in summary/links. Return the five-section human report separately from record blocks. If evidence/linkage is actually unavailable, record the specific gap and limit the answer; a mismatched quote does not make available tool text unavailable. Reassess whether answered or evidence_boundary is appropriate.`;
  return { state, output: attempts < 3 ? { decision: "block", reason } : { systemMessage: `dbdog: automatic delivery repair exhausted; delivery is INCOMPLETE. ${reason}` } };
}
