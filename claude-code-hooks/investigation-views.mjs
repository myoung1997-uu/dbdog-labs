// 一个事件模型的两种读法：追问边不承担因果证明；步骤不成为假设节点。
export function investigationViews(inv) {
  const checkpoint = inv.checkpoints.at(-1) ?? null;
  const branchByHypothesis = new Map(inv.branches.map(b => [b.hypothesis, b]));
  const observationById = new Map(inv.observations.map(o => [o.id, o]));
  const diagnostics = [];
  const known = new Set(inv.hypotheses.map(h => h.id));
  if (!checkpoint) diagnostics.push({ code: "missing_investigation_question" });
  const parentEdges = [];
  for (const [id, b] of branchByHypothesis) {
    if (!known.has(id)) { diagnostics.push({ code: "unknown_branch_hypothesis", event_id: b.id, hypothesis: id }); continue; }
    for (const parent of b.parents) {
      if (parent !== "question" && !known.has(parent)) {
        diagnostics.push({ code: "unknown_investigation_parent", event_id: b.id, hypothesis: id, parent });
        continue;
      }
      parentEdges.push({ from: parent, to: id, reason: b.reason, event_id: b.id, kind: "investigation_parent" });
    }
  }
  // 保留非法追问边的诊断，但不给树消费者环。因果关系在独立集合中原样保留。
  const reaches = (from, to, seen = new Set()) => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return parentEdges.some(e => e.from === from && reaches(e.to, to, seen));
  };
  const safeEdges = parentEdges.filter(e => {
    if (!reaches(e.to, e.from)) return true;
    diagnostics.push({ code: "investigation_parent_cycle", event_id: e.event_id, from: e.from, to: e.to });
    return false;
  });
  const nodes = inv.hypotheses.map(h => {
    if (!branchByHypothesis.has(h.id)) diagnostics.push({ code: "missing_investigation_parent", hypothesis: h.id });
    const effects = inv.edges.filter(e => e.kind === "evidence" && e.target_kind === "hypothesis" && e.to === h.id);
    const observationIds = [...new Set(effects.map(e => e.from))];
    const last = h.history.at(-1);
    return { id: h.id, claim: h.claim, state: h.state, status_source: h.status_source,
      assessment_current: h.assessment_current, decision_summary: last?.reason ?? null,
      reference_check: last?.reference_check ?? "not_provided",
      parents: safeEdges.filter(e => e.to === h.id).map(e => e.from),
      key_evidence: (last?.evidence ?? observationIds).map(id => ({ observation: id,
        sources: (observationById.get(id)?.sources ?? []).map(s => ({ ref: s.ref, matched: s.matched, location: s.location ?? null })) })),
      details: { checks: inv.checks.filter(c => c.hypotheses.includes(h.id)).map(c => c.id), observations: observationIds,
        effects, gaps: inv.gaps.filter(g => g.hypotheses?.includes(h.id)).map(g => g.id),
        revisions: h.claim_history, decisions: h.history,
        branches: inv.branches.filter(b => b.hypothesis === h.id) } };
  });
  const steps = inv.events.map(e => {
    const detail = e.event === "check" ? inv.checks.find(c => c.event_id === e.id)
      : e.event === "evidence" ? inv.observations.find(o => o.event_id === e.id)
      : e.event === "checkpoint" ? inv.checkpoints.find(c => c.id === e.id)
      : e.event === "gap" ? inv.gaps.find(g => g.event_id === e.id)
      : e.event === "finish" ? inv.finishes.find(f => f.id === e.id) : e;
    return { id: e.id, event: e.event, span_id: e.span_id, ts: e.ts,
      detail: e.event === "evidence" && detail ? { ...detail,
        effects: inv.edges.filter(edge => edge.kind === "evidence" && edge.from === detail.id) } : detail ?? e };
  });
  const finish = inv.finishes.at(-1) ?? null;
  return {
    hypothesis_view: { root: { id: "question", question: checkpoint?.question ?? null, scope: checkpoint?.scope ?? null,
      state: inv.state, checkpoint: checkpoint?.id ?? null }, nodes, edges: safeEdges,
      unplaced: nodes.filter(n => !n.parents.length).map(n => n.id),
      relations: inv.relations, conclusion: finish,
      answer_linkage: finish && Array.isArray(finish.answer_hypotheses) && Array.isArray(finish.answer_relations) ? "explicit" : "not_provided" },
    investigation_steps: steps, diagnostics,
  };
}
