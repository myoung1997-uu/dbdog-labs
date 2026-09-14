import { investigationViews } from "./investigation-views.mjs";
// 模型声明调查语义，hook span 提供实际结果身份。只读取 assistant 显式事件。
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const HYPOTHESIS = /^H\d+(?:\.\d+)*$/;
const STATES = new Set(["open", "supported", "refuted", "inconclusive"]);
const PAIRS = new Set(["explains", "alternative", "amplifies", "requires"]);
const GROUPS = new Set(["joint_contribution", "joint_necessity"]);
const EFFECTS = new Set(["supports", "refutes", "inconclusive"]);
const ASPECTS = new Set(["mechanism", "activation", "impact"]);
const isText = v => typeof v === "string" && v.trim().length > 0;
const isId = v => typeof v === "string" && ID.test(v);
const isHypothesis = v => typeof v === "string" && HYPOTHESIS.test(v);
const listOf = (v, f) => Array.isArray(v) && v.every(f);
const optionalList = (v, f) => v === undefined || listOf(v, f);
const bodyOf = s => typeof s.output_local === "string" ? s.output_local : s.output;
const isMcp = s => Boolean(s.tags?.mcp_server) || String(s.name ?? "").startsWith("mcp__");
const unresolvedValid = u => u && isText(u.question) && isText(u.missing) && isText(u.next_step);
const sourceValid = s => s && isText(s.ref) && s.ref.startsWith("E:") && typeof s.quote === "string" &&
  (s.location === undefined || isText(s.location)) && (s.revision === undefined || isText(s.revision));
const targetValid = e => (isHypothesis(e.hypothesis) && e.relation === undefined) ||
  (isId(e.relation) && e.hypothesis === undefined);
const targetKey = e => `${e.hypothesis ? "hypothesis" : "relation"}:${e.hypothesis ?? e.relation}`;
const relationValid = e => isHypothesis(e.to) && (
  (PAIRS.has(e.type) && isHypothesis(e.from) && e.from !== e.to) ||
  (GROUPS.has(e.type) && listOf(e.from, isHypothesis) && e.from.length >= 2 &&
    new Set(e.from).size === e.from.length && !e.from.includes(e.to)));

function valid(e) {
  if (!e || typeof e !== "object" || !isId(e.id)) return false;
  switch (e.event) {
    case "branch": return isHypothesis(e.hypothesis) && isText(e.reason) &&
      listOf(e.parents, p => p === "question" || isHypothesis(p)) && e.parents.length > 0 &&
      new Set(e.parents).size === e.parents.length && !e.parents.includes(e.hypothesis);
    case "checkpoint": return isText(e.question) && isText(e.scope) &&
      listOf(e.findings, f => f && isText(f.summary) && listOf(f.evidence, isId)) &&
      listOf(e.unresolved, unresolvedValid) && e.next && isText(e.next.action) && isText(e.next.reason);
    case "hypothesis": return isHypothesis(e.hypothesis) && isText(e.claim) &&
      optionalList(e.relations, r => r && PAIRS.has(r.type) && relationValid(r)) && optionalList(e.based_on, isId);
    case "revise": return isHypothesis(e.hypothesis) && isText(e.claim) && isText(e.reason);
    case "relation": return isId(e.relation) && isText(e.claim) && relationValid(e);
    case "check": return isId(e.check) && ["locate", "test"].includes(e.mode) && isText(e.purpose) &&
      listOf(e.hypotheses, isHypothesis) && optionalList(e.relations, isId) &&
      (e.mode === "locate" || ((e.hypotheses.length + (e.relations?.length ?? 0)) > 0 && isText(e.expect)));
    case "evidence": return isId(e.observation) && isText(e.summary) &&
      (e.check === undefined || isId(e.check)) && Array.isArray(e.sources) && e.sources.length > 0 &&
      e.sources.every(sourceValid) && listOf(e.links, l => l && targetValid(l) && EFFECTS.has(l.effect) &&
        ASPECTS.has(l.aspect) && isText(l.reason));
    case "update": return targetValid(e) && STATES.has(e.state) && listOf(e.evidence, isId) &&
      isText(e.reason) && (e.remaining === undefined || typeof e.remaining === "string");
    case "gap": return isId(e.gap) && isText(e.wanted) && isText(e.attempt) && isText(e.impact) &&
      ["empty", "error", "capability_unavailable", "outside_retention", "inaccessible", "inconclusive"].includes(e.result) &&
      (e.check === undefined || isId(e.check)) && optionalList(e.sources, sourceValid) &&
      optionalList(e.hypotheses, isHypothesis) && optionalList(e.relations, isId);
    case "finish": return ["answered", "evidence_boundary"].includes(e.outcome) &&
      isText(e.reason) && isText(e.conclusion) && listOf(e.evidence, isId) &&
      optionalList(e.answer_hypotheses, isHypothesis) && optionalList(e.answer_relations, isId) &&
      listOf(e.unresolved, unresolvedValid) &&
      (e.outcome !== "evidence_boundary" || e.unresolved.length > 0);
    default: return false;
  }
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
export function extractInvestigationEvents(spans) {
  const events = [], diagnostics = [], seen = new Map();
  const position = new Map(spans.map((span, i) => [span.span_id, i]));
  // agent/root 输出可能镜像最后一条 llm 输出；采用原始 llm 事件的位置。
  const candidates = [...spans.filter(s => s.kind === "llm"), ...spans.filter(s => s.kind === "agent")];
  for (const span of candidates) {
    const output = bodyOf(span);
    if (typeof output !== "string") continue;
    for (const block of output.matchAll(/^```dbdog-investigation\s*\r?\n([\s\S]*?)^```\s*$/gm)) {
      let parsed;
      try { parsed = JSON.parse(block[1]); }
      catch { diagnostics.push({ code: "invalid_event_json", span_id: span.span_id }); continue; }
      for (const e of Array.isArray(parsed) ? parsed : [parsed]) {
        if (!valid(e)) { diagnostics.push({ code: "invalid_event", span_id: span.span_id, event_id: typeof e?.id === "string" ? e.id : null }); continue; }
        const signature = JSON.stringify(canonical(e));
        if (seen.has(e.id)) {
          if (seen.get(e.id) !== signature) diagnostics.push({ code: "event_id_conflict", event_id: e.id, span_id: span.span_id });
          continue;
        }
        seen.set(e.id, signature);
        events.push({ ...e, span_id: span.span_id, trace_id: span.trace_id, ts: span.ts,
          actor: span.tags?.agent_id ?? span.parent_id ?? "main" });
      }
    }
  }
  events.sort((a, b) => position.get(a.span_id) - position.get(b.span_id));
  return { events, diagnostics };
}

/** 允许先声明关系后声明端点；裁决只能引用当时已记录的观察，不由后来事件追认。 */
export function buildInvestigation(spans) {
  const { events, diagnostics } = extractInvestigationEvents(spans);
  if (!events.length && !diagnostics.length) return null;
  const traceIds = new Set(spans.map(s => s.trace_id).filter(Boolean));
  const empty = { version: 1, events, state: "active", branches: [], checkpoints: [], hypotheses: [], relations: [], checks: [], observations: [], gaps: [], finishes: [], edges: [] };
  if (traceIds.size !== 1) return { ...empty, diagnostics: [...diagnostics, { code: "ambiguous_trace_scope" }] };
  const traceId = [...traceIds][0];
  const tools = new Map(spans.filter(s => s.kind === "tool" && s.trace_id === traceId).map(s => [`E:${s.span_id}`, s]));
  const hypotheses = new Map(), relations = new Map(), checks = new Map(), observations = new Map(), gaps = new Map(), edges = [], finishes = [];
  let state = "active";
  const checkpoints = [], branches = [];
  const position = new Map(spans.map((s, i) => [s.span_id, i]));
  const note = (code, e, details = {}) => diagnostics.push({ code, event_id: e.id, span_id: e.span_id, ...details });
  const resolveSources = (sources, e) => sources.map(ref => {
    const s = tools.get(ref.ref);
    const source = { ...ref, span_id: s?.span_id ?? null, tool: s?.name ?? null,
      basis: s ? (isMcp(s) ? "telemetry" : ref.location ? "source" : "local") : null, matched: false };
    if (!s) note("missing_evidence", e, { ref: ref.ref });
    else if (position.get(s.span_id) >= position.get(e.span_id)) {
      note("future_evidence", e, { ref: ref.ref });
    } else {
      const raw = bodyOf(s);
      const output = typeof raw === "string" ? raw : JSON.stringify(raw);
      source.matched = typeof output === "string" && (ref.quote === "" ? output === "" : output.includes(ref.quote));
      source.status = s.status ?? null;
      if (!source.matched) note("quote_mismatch", e, { ref: ref.ref });
    }
    return source;
  });
  const claimRevision = target => {
    if (!target) return null;
    if (!target.from) return target.claim_history.at(-1).event_id;
    const endpoints = [...(Array.isArray(target.from) ? target.from : [target.from]), target.to];
    return JSON.stringify([target.event_id, ...endpoints.map(id => hypotheses.get(id)?.claim_history.at(-1).event_id ?? null)]);
  };
  // 这里只查记录依赖与适用的声明版本，不替模型判断因果或证据效力。
  const referenceCheck = (ids, e, target = null) => {
    if (!ids.length) return "not_provided";
    let complete = true;
    for (const id of ids) {
      const o = observations.get(id);
      if (!o) { note("missing_observation", e, { observation: id }); complete = false; continue; }
      if (!o.sources.every(s => s.matched)) complete = false;
      if (target) {
        const links = edges.filter(edge => edge.kind === "evidence" && edge.from === id &&
          `${edge.target_kind}:${edge.to}` === targetKey(e));
        const revision = claimRevision(target);
        if (!links.length) { note("missing_target_link", e, { observation: id }); complete = false; }
        else if (!links.some(edge => edge.claim_event_id === revision)) {
          note("stale_claim_interpretation", e, { observation: id, target: e.hypothesis ?? e.relation });
          complete = false;
        }
      }
    }
    return complete ? "matched" : "incomplete";
  };
  const addRelation = (r, e, id) => {
    if (relations.has(id)) { note("duplicate_relation", e, { relation: id }); return; }
    relations.set(id, { id, from: r.from, to: r.to, type: r.type, claim: r.claim ?? `${r.from} ${r.type} ${r.to}`,
      state: "open", status_source: "model_declared", event_id: e.id, proposed_in: e.span_id, history: [] });
  };
  for (const e of events) {
    if (e.event !== "finish") state = "active";
    if (e.event === "branch") branches.push(e);
    else if (e.event === "checkpoint") {
      checkpoints.push({ ...e, findings: e.findings.map(f => ({ ...f,
        reference_check: referenceCheck(f.evidence, e) })) });
    } else if (e.event === "hypothesis") {
      if (hypotheses.has(e.hypothesis)) { note("duplicate_hypothesis", e, { hypothesis: e.hypothesis }); continue; }
      hypotheses.set(e.hypothesis, { id: e.hypothesis, claim: e.claim, state: "open", status_source: "model_declared",
        proposed_in: e.span_id, event_id: e.id, based_on: e.based_on ?? [], history: [],
        claim_history: [{ claim: e.claim, event_id: e.id, span_id: e.span_id }] });
      // 兼容早期草稿的内嵌关系，给每条稳定身份；新 skill 只教独立 relation 事件。
      (e.relations ?? []).forEach((r, i) => addRelation(r, e, `${e.id}:relation:${i}`));
    } else if (e.event === "revise") {
      const h = hypotheses.get(e.hypothesis);
      if (!h) { note("unknown_hypothesis", e, { hypothesis: e.hypothesis }); continue; }
      h.claim = e.claim;
      h.state = "open";
      h.claim_history.push({ claim: e.claim, reason: e.reason, event_id: e.id, span_id: e.span_id });
      h.history.push({ state: "open", reason: e.reason, evidence: [], reference_check: "not_provided", evidence_complete: false, event_id: e.id, span_id: e.span_id, ts: e.ts });
    } else if (e.event === "relation") addRelation(e, e, e.relation);
    else if (e.event === "check") {
      if (checks.has(e.check)) { note("duplicate_check", e, { check: e.check }); continue; }
      checks.set(e.check, { id: e.check, mode: e.mode, hypotheses: e.hypotheses, relations: e.relations ?? [], purpose: e.purpose,
        expect: e.expect ?? null, event_id: e.id, span_id: e.span_id });
    } else if (e.event === "evidence") {
      if (observations.has(e.observation)) { note("duplicate_observation", e, { observation: e.observation }); continue; }
      observations.set(e.observation, { id: e.observation, summary: e.summary, check: e.check ?? null,
        sources: resolveSources(e.sources, e), event_id: e.id, span_id: e.span_id });
      for (const link of e.links) {
        const target = link.hypothesis ? hypotheses.get(link.hypothesis) : relations.get(link.relation);
        edges.push({ kind: "evidence", from: e.observation, to: link.hypothesis ?? link.relation,
        target_kind: link.hypothesis ? "hypothesis" : "relation", effect: link.effect, aspect: link.aspect,
        reason: link.reason, claim_event_id: claimRevision(target),
        event_id: e.id, span_id: e.span_id });
      }
    } else if (e.event === "update") {
      const target = e.hypothesis ? hypotheses.get(e.hypothesis) : relations.get(e.relation);
      if (!target) { note(e.hypothesis ? "unknown_hypothesis" : "unknown_relation", e, { target: e.hypothesis ?? e.relation }); continue; }
      const checked = referenceCheck(e.evidence, e, target);
      const complete = checked === "matched";
      target.state = e.state;
      target.history.push({ state: e.state, evidence: e.evidence, reference_check: checked, evidence_complete: complete,
        claim_event_id: claimRevision(target),
        reason: e.reason, remaining: e.remaining ?? "", event_id: e.id, span_id: e.span_id, ts: e.ts });
      if (checked === "incomplete") note("update_reference_incomplete", e, { target: e.hypothesis ?? e.relation });
    } else if (e.event === "gap") {
      if (gaps.has(e.gap)) { note("duplicate_gap", e, { gap: e.gap }); continue; }
      gaps.set(e.gap, { ...e, id: e.gap, event_id: e.id, sources: resolveSources(e.sources ?? [], e), status_source: "model_declared" });
    } else if (e.event === "finish") {
      for (const [ids, targets, kind] of [[e.answer_hypotheses ?? [], hypotheses, "hypothesis"], [e.answer_relations ?? [], relations, "relation"]]) {
        for (const id of ids) {
          const target = targets.get(id);
          if (!target) note("unknown_answer_claim", e, { target: id, kind });
          else if (target.history.length && target.history.at(-1).claim_event_id !== claimRevision(target))
            note("finish_stale_assessment", e, { target: id, kind });
        }
      }
      const checked = referenceCheck(e.evidence, e);
      finishes.push({ ...e, checkpoint: checkpoints.at(-1)?.id ?? null, reference_check: checked,
        evidence_complete: checked === "matched", status_source: "model_declared" });
      state = e.outcome;
      if (checked === "incomplete") note("finish_reference_incomplete", e);
    }
  }
  for (const target of [...hypotheses.values(), ...relations.values()]) {
    const last = target.history.at(-1);
    target.assessment_current = Boolean(last && last.claim_event_id === claimRevision(target));
  }
  const linkedEdges = edges.filter(edge => {
    const known = (edge.target_kind === "hypothesis" ? hypotheses : relations).has(edge.to);
    if (!known) diagnostics.push({ code: "unresolved_relation", event_id: edge.event_id, from: edge.from, to: edge.to });
    return known;
  });
  for (const r of relations.values()) {
    const from = Array.isArray(r.from) ? r.from : [r.from];
    r.endpoints_resolved = hypotheses.has(r.to) && from.every(id => hypotheses.has(id));
    if (!r.endpoints_resolved) diagnostics.push({ code: "unresolved_relation", event_id: r.event_id, relation: r.id });
    else linkedEdges.push({ kind: GROUPS.has(r.type) ? "condition_group" : "relation", ...r, relation: r.id, span_id: r.proposed_in });
  }
  for (const o of [...observations.values(), ...gaps.values()]) if (o.check && !checks.has(o.check)) diagnostics.push({ code: "unknown_check", observation: o.id, check: o.check });
  for (const c of [...checks.values(), ...gaps.values()]) {
    for (const id of c.hypotheses ?? []) if (!hypotheses.has(id)) diagnostics.push({ code: "unknown_hypothesis", event_id: c.event_id, hypothesis: id });
    for (const id of c.relations ?? []) if (!relations.has(id)) diagnostics.push({ code: "unknown_relation", event_id: c.event_id, relation: id });
  }
  for (const h of hypotheses.values()) for (const id of h.based_on) {
    if (observations.has(id)) linkedEdges.push({ kind: "basis", from: id, to: h.id, event_id: h.event_id, span_id: h.proposed_in });
    else diagnostics.push({ code: "missing_observation", event_id: h.event_id, observation: id });
  }
  const result = { version: 1, trace_id: traceId, events, state, branches, checkpoints, hypotheses: [...hypotheses.values()], relations: [...relations.values()],
    checks: [...checks.values()], observations: [...observations.values()], gaps: [...gaps.values()], finishes, edges: linkedEdges, diagnostics };
  const views = investigationViews(result);
  result.diagnostics.push(...views.diagnostics);
  result.views = { hypothesis_view: views.hypothesis_view, investigation_steps: views.investigation_steps };
  return result;
}

/** 老消费者仍能看到节点与取证；完整多对多关系和状态历史以 investigation 为准。 */
export function projectInvestigation(graph, spans) {
  const inv = graph.investigation;
  if (!inv) return graph;
  const declared = new Set(inv.hypotheses.map(h => h.id));
  const nodes = new Map(graph.nodes.map(n => [n.id, n]));
  const tools = new Map(spans.filter(s => s.kind === "tool").map(s => [s.span_id, s]));
  const sequence = new Map();
  let seq = 0;
  for (const s of spans) if (s.kind === "tool" && isMcp(s)) sequence.set(s.span_id, ++seq);
  // 新事件声明的节点不继承旧编号推导出的父或旧正文解析器裁决。
  graph.edges = graph.edges.filter(e => !(e.kind === "parent" && (declared.has(e.from) || declared.has(e.to))) &&
    !(e.kind === "resolve" && declared.has(e.to)) &&
    !(["tool", "source"].includes(e.kind) && declared.has(e.from)));
  const verdict = { supported: "confirmed", refuted: "falsified", inconclusive: "open", open: "open" };
  for (const h of inv.hypotheses) {
    const last = h.history.at(-1);
    const node = { id: h.id, text: h.claim, type: "cause", parent: null, declared: true, calls: [],
      proposed_in: { span_id: h.proposed_in, in: "investigation_event" }, first_seq: null,
      verdict: verdict[h.state], status_source: "model_declared", state_history: h.history,
      closed_by: last ? { from: last.reason, span_id: last.span_id, in: "investigation_event" } : null,
      unsupported_close: h.state !== "open" && h.state !== "inconclusive" && last?.reference_check === "incomplete" };
    const calls = new Set();
    for (const edge of inv.edges.filter(e => e.kind === "evidence" && e.target_kind === "hypothesis" && e.to === h.id)) {
      const o = inv.observations.find(o => o.id === edge.from);
      for (const source of o.sources) {
        const tool = tools.get(source.span_id);
        if (!tool || !source.matched) continue;
        if (source.basis === "source") {
          node.has_source_evidence = true;
          graph.edges.push({ kind: "source", basis: "source", from: h.id, title: `${edge.effect}: ${edge.reason}`,
            refs: [source.location], span_id: source.span_id, observation: o.id });
        }
        if (isMcp(tool) && !calls.has(tool.span_id)) {
          calls.add(tool.span_id);
          const n = sequence.get(tool.span_id);
          node.first_seq = node.first_seq === null ? n : Math.min(node.first_seq, n);
          node.calls.push({ seq: n, span_id: tool.span_id, tool: tool.name, status: tool.status,
            ts: tool.ts, agent: tool.tags?.agent_id ?? "main", purpose: edge.reason,
            input: tool.input_local ?? tool.input ?? null, output: bodyOf(tool) ?? null });
          graph.edges.push({ kind: "tool", from: h.id, tool: tool.name, seq: n, span_id: tool.span_id });
        }
      }
    }
    if (last) graph.edges.push({ kind: "resolve", from: last.reason, to: h.id, verdict: node.verdict, span_id: last.span_id });
    nodes.set(h.id, node);
  }
  // 旧树只投影显式追问边；因果 explains 不能反向制造调查父子关系。
  for (const h of inv.hypotheses) {
    const parents = inv.views.hypothesis_view.edges.filter(e => e.to === h.id);
    if (parents.length === 1 && parents[0].from !== "question" && nodes.has(parents[0].from)) {
      nodes.get(h.id).parent = parents[0].from;
      graph.edges.push({ kind: "parent", from: parents[0].from, to: h.id, relationship: "investigation_parent" });
    }
  }
  graph.nodes = [...nodes.values()];
  const recorded = new Set([...inv.observations, ...(inv.gaps ?? [])].flatMap(o => o.sources.filter(s => s.matched).map(s => s.span_id).filter(Boolean)));
  graph.unattached_tools = graph.unattached_tools.filter(c => !recorded.has(c.span_id));
  Object.assign(graph.summary, {
    hypotheses: graph.nodes.length,
    undeclared: graph.nodes.filter(n => !n.declared).length,
    parent_edges: graph.edges.filter(e => e.kind === "parent").length,
    tool_edges: graph.edges.filter(e => e.kind === "tool").length,
    source_edges: graph.edges.filter(e => e.kind === "source").length,
    resolve_edges: graph.edges.filter(e => e.kind === "resolve").length,
    unsupported_closes: graph.nodes.filter(n => n.unsupported_close).length,
    unattached_tools: graph.unattached_tools.length,
    investigation_events: inv.events.length,
    investigation_checkpoints: inv.checkpoints.length,
    investigation_gaps: inv.gaps.length,
    investigation_diagnostics: inv.diagnostics.length,
    source_hypotheses: graph.nodes.filter(n => n.has_source_evidence).length,
    source_without_evidence: graph.nodes.filter(n => n.has_source_evidence && !n.calls.length).length,
  });
  return graph;
}

/** 完整关系/条件组、证据、失败尝试和结束原因都在本地可读报告里保留。 */
export function renderInvestigation(g) {
  if (!g) return "";
  const lines = ["## 结构化调查记录", "", "状态由调查模型声明；引用匹配只证明原文存在，不代表因果判断已被系统验证。", "", `调查状态：${g.state}`, ""];
  for (const c of g.checkpoints ?? []) {
    lines.push(`### 阶段结果 ${c.id}`, "", `问题：${c.question}`, `范围：${c.scope}`, "");
    for (const f of c.findings) lines.push(`- ${f.summary}；观察 ${f.evidence.join(", ") || "未提供精确引用"}；引用检查 ${f.reference_check}`);
    for (const u of c.unresolved) lines.push(`- 未解：${u.question}；缺少：${u.missing}；下一步：${u.next_step}`);
    lines.push("", `下一动作：${c.next.action}；理由：${c.next.reason}`, "");
  }
  if (g.views) {
    lines.push("### 假设路径", "", `调查问题：${g.views.hypothesis_view.root.question ?? "缺少显式问题记录"}`, "");
    for (const edge of g.views.hypothesis_view.edges) lines.push(`- ${edge.from} → ${edge.to}：${edge.reason}（追问关系，非因果裁决）`);
    if (g.views.hypothesis_view.unplaced.length) lines.push(`- 缺少可用父关联：${g.views.hypothesis_view.unplaced.join(", ")}`);
    lines.push("");
  }
  for (const target of [...g.hypotheses, ...(g.relations ?? [])]) {
    const kind = target.from ? "relation" : "hypothesis";
    lines.push(`### ${target.id} · ${target.claim}`, "", `当前状态：${target.state}；裁决适用于当前主张：${target.assessment_current ? "是" : "尚未确认"}`, "");
    if (kind === "relation") lines.push(`关系：${JSON.stringify(target.from)} — ${target.type} → ${target.to}`, "");
    for (const revision of target.claim_history ?? []) lines.push(`- 声明 ${revision.event_id}：${revision.claim}${revision.reason ? `；${revision.reason}` : ""}`);
    for (const edge of g.edges.filter(e => e.kind === "evidence" && e.target_kind === kind && e.to === target.id)) {
      const o = g.observations.find(o => o.id === edge.from);
      lines.push(`- ${o.id} · ${edge.effect} · ${edge.aspect}：${edge.reason}`);
      for (const source of o.sources) lines.push(`  - \`${source.ref}\`（${source.tool ?? "未找到调用"}，原文${source.matched ? "匹配" : "未匹配"}）${source.location ? ` · ${source.location}` : ""}：${JSON.stringify(source.quote)}`);
    }
    for (const u of target.history) lines.push(`- 更新 ${u.event_id}：${u.state}，依据 ${u.evidence.join(", ") || "未引用"}；${u.reason}${u.remaining ? `；仍缺：${u.remaining}` : ""}`);
    lines.push("");
  }
  const locating = g.observations.filter(o => !g.edges.some(e => e.kind === "evidence" && e.from === o.id));
  if (locating.length) lines.push("### 定位观察", "", ...locating.map(o => `- ${o.id}：${o.summary}；${o.sources.map(s => `${s.ref}（${s.matched ? "匹配" : "未匹配"}）：${JSON.stringify(s.quote)}`).join("；")}`), "");
  if (g.checks.length) lines.push("### 定位与取证目的", "", ...g.checks.map(c => `- ${c.id} · ${c.mode} · ${[...c.hypotheses, ...(c.relations ?? [])].join(", ") || "定位阶段，无原因假设"}：${c.purpose}`), "");
  if (g.gaps?.length) lines.push("### 未取得的观察", "", ...g.gaps.map(d => `- ${d.id}：希望观察 ${d.wanted}；尝试 ${d.attempt}；返回 ${d.result}；影响 ${d.impact}；引用 ${d.sources.map(s => s.ref + (s.matched ? "（匹配）" : "（未匹配）")).join(", ") || "客户端未提供"}`), "");
  if (g.finishes?.length) {
    lines.push("### 调查结束历史", "");
    for (const f of g.finishes) {
      lines.push(`- ${f.id} · ${f.outcome}：${f.conclusion}；结束原因：${f.reason}`);
      for (const u of f.unresolved) lines.push(`  - 未解：${u.question}；缺少：${u.missing}；下一步：${u.next_step}`);
    }
    lines.push("");
  }
  if (g.diagnostics.length) lines.push("### 记录诊断", "", ...g.diagnostics.map(d => `- ${JSON.stringify(d)}`), "");
  return lines.join("\n");
}
