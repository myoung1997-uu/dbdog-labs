// 这些是明确记录的回放验收，不是 LLM 诊断效果实验或真实数据库归因。
import { describe, expect, it } from "vitest";
import { build } from "./hypothesis-graph.mjs";
const msg = (id, ts, events) => ({ span_id: id, trace_id: "case", kind: "llm", ts,
  output: "```dbdog-investigation\n" + JSON.stringify(events) + "\n```" });
const tool = (id, ts, output) => ({ span_id: id, trace_id: "case", kind: "tool", name: "Read", ts, output, status: "ok" });
const h = (id, claim) => ({ event: "hypothesis", id: `h-${id}`, hypothesis: id, claim });
const branch = (id, parents) => ({ event: "branch", id: `b-${id}`, hypothesis: id, parents, reason: "为解释父节点描述的情况" });
const check = (id, targets = []) => ({ event: "check", id: `c-${id}`, check: id, mode: targets.length ? "test" : "locate",
  hypotheses: targets, purpose: "区分当前原因解释", ...(targets.length ? { expect: "匹配对象、时间与预测条件" } : {}) });
const evidence = (id, ref, quote, targets, effect = "supports", check = "C1") => ({ event: "evidence", id: `o-${id}`, observation: id,
  check, summary: quote, sources: [{ ref: `E:${ref}`, quote }],
  links: targets.map(hypothesis => ({ hypothesis, effect, aspect: "activation", reason: "该观察对本主张的解释" })) });
const update = (id, state, observations) => ({ event: "update", id: `u-${id}-${state}`, hypothesis: id, state,
  evidence: observations, reason: `${id} ${state} 的限定判断` });
const stage = (id, action = "检验持锁原因") => ({ event: "checkpoint", id, question: "SQL 为何慢？", scope: "实例 X、同一执行窗口",
  findings: [], unresolved: [], next: { action, reason: "当前缺口会改变处置" } });
const finish = (outcome, ids, unresolved = []) => ({ event: "finish", id: "end", outcome, conclusion: "按已支持部分回答，保留未知部分",
  reason: outcome === "answered" ? "进一步深度不改变处置" : "关键证据不可取得且无其他有效方向", evidence: ["O1"],
  answer_hypotheses: ids, answer_relations: [], unresolved });
const view = spans => build(spans).investigation;

describe("调查步骤与假设树的共同记录验收", () => {
  it("中间解释成立后定位事务不造子假设，真正的原因解释才进入主树", () => {
    const g = view([msg("m1", 1, [stage("start"), h("H1", "主要耗时来自锁等待"), branch("H1", ["question"]), check("C1", ["H1"])]),
      tool("t1", 2, "A waits on transaction B"), msg("m2", 3, [evidence("O1", "t1", "A waits on transaction B", ["H1"]),
        update("H1", "supported", ["O1"]), check("C2"), h("H2", "事务 B 因等待外部响应未结束"), branch("H2", ["H1"]), stage("deeper")])]);
    expect(g.state).toBe("active");
    expect(g.views.hypothesis_view.nodes.map(n => n.claim)).toEqual(["主要耗时来自锁等待", "事务 B 因等待外部响应未结束"]);
    expect(g.views.hypothesis_view.edges).toMatchObject([{ from: "question", to: "H1" }, { from: "H1", to: "H2" }]);
    expect(g.relations).toEqual([]); // 追问边不是已证实的因果边。
    expect(g.views.investigation_steps.find(s => s.id === "o-O1").detail.effects[0].to).toBe("H1");
  });

  it("显眼异常留在原始结果/定位详情中，不因严重程度自动生成原因节点", () => {
    const g = view([msg("m1", 1, [stage("start"), h("H1", "锁等待导致 SQL 慢"), branch("H1", ["question"]), check("C1")]),
      tool("noise", 2, "CRITICAL unrelated database Y"), msg("m2", 3, [evidence("O1", "noise", "CRITICAL unrelated database Y", []), stage("keep-direction")])]);
    expect(g.views.hypothesis_view.nodes).toHaveLength(1);
    expect(g.views.hypothesis_view.nodes[0].key_evidence).toEqual([]);
    expect(g.views.investigation_steps.find(s => s.id === "o-O1").detail.sources[0].ref).toBe("E:noise");
  });

  it("反证保留旧分支并更新方向；父假设尚未确认也允许探索子原因", () => {
    const g = view([msg("m1", 1, [stage("start"), h("H1", "锁等待"), branch("H1", ["question"]),
      h("H2", "事务在等待网络"), branch("H2", ["H1"]), check("C1", ["H2"])]), tool("t", 2, "B is executing locally, no client wait"),
      msg("m2", 3, [evidence("O1", "t", "B is executing locally", ["H2"], "refutes"), update("H2", "refuted", ["O1"]),
        h("H3", "B 的本地执行过慢"), branch("H3", ["H1"]), stage("redirect", "分析 B 的本地执行成本")])]);
    expect(g.views.hypothesis_view.nodes.map(n => [n.id, n.state])).toEqual([["H1", "open"], ["H2", "refuted"], ["H3", "open"]]);
    expect(g.views.hypothesis_view.nodes.find(n => n.id === "H2").details.decisions).toHaveLength(1);
  });

  it("共同原因与共享证据不被单父布局改写，最终答案引用与节点判断同源", () => {
    const g = view([msg("m1", 1, [stage("start"), h("H1", "SQL 慢"), branch("H1", ["question"]), h("H2", "输入量增大"),
      branch("H2", ["H1"]), h("H3", "每项处理成本增大"), branch("H3", ["H1", "H2"]), check("C1", ["H2", "H3"])]),
      tool("t", 2, "count and unit cost increased"), msg("m2", 3, [evidence("O1", "t", "count and unit cost increased", ["H2", "H3"]),
        update("H2", "supported", ["O1"]), update("H3", "supported", ["O1"]),
        { event: "relation", id: "r1", relation: "R1", type: "joint_contribution", from: ["H2", "H3"], to: "H1", claim: "两者共同增加总成本" },
        finish("answered", ["H2", "H3"])])]);
    const v = g.views.hypothesis_view;
    expect(v.nodes.find(n => n.id === "H3").parents).toEqual(["H1", "H2"]);
    expect(v.nodes.filter(n => ["H2", "H3"].includes(n.id)).map(n => n.key_evidence[0].sources[0].ref)).toEqual(["E:t", "E:t"]);
    expect(v.relations[0]).toMatchObject({ type: "joint_contribution", state: "open" });
    expect(v.conclusion.answer_hypotheses).toEqual(["H2", "H3"]);
    expect(v.answer_linkage).toBe("explicit");
  });

  it("证据不足以边界结束，inconclusive 不被改成 refuted，未解内容可恢复", () => {
    const g = view([msg("m1", 1, [stage("start"), h("H1", "锁等待"), branch("H1", ["question"]), check("C1", ["H1"])]),
      tool("t", 2, "wait observed; cause not recorded"), msg("m2", 3, [evidence("O1", "t", "wait observed", ["H1"], "inconclusive"),
        update("H1", "inconclusive", ["O1"]), finish("evidence_boundary", ["H1"], [{ question: "持锁为何持续", missing: "事务生命周期日志", next_step: "取得归档日志" }])])]);
    expect(g.views.hypothesis_view.root.state).toBe("evidence_boundary");
    expect(g.views.hypothesis_view.nodes[0].state).toBe("inconclusive");
    expect(g.views.hypothesis_view.conclusion.unresolved[0].missing).toBe("事务生命周期日志");
  });

  it("编号与 explains 不能补全缺失父关联；追问环显式诊断", () => {
    const g = view([msg("m", 1, [stage("start"), h("H1", "A"), h("H2.1", "B"),
      { event: "relation", id: "r", relation: "R1", type: "explains", from: "H2.1", to: "H1", claim: "候选因果" }])]);
    expect(g.views.hypothesis_view.edges).toEqual([]);
    expect(g.views.hypothesis_view.unplaced).toEqual(["H1", "H2.1"]);
    const cycle = view([msg("m", 1, [stage("start"), h("H1", "A"), h("H2", "B"), branch("H1", ["H2"]), branch("H2", ["H1"])])]);
    expect(cycle.views.hypothesis_view.edges).toEqual([]);
    expect(cycle.diagnostics.filter(d => d.code === "investigation_parent_cycle")).toHaveLength(2);
  });
});
