import { describe, expect, it } from "vitest";
import { build, compactGraph } from "./hypothesis-graph.mjs";

const message = (id, ts, events) => ({ span_id: id, trace_id: "trace-a", kind: "llm", ts,
  output: "```dbdog-investigation\n" + JSON.stringify(events) + "\n```" });
const call = (id, ts, output, mcp = true) => ({ span_id: id, trace_id: "trace-a", kind: "tool", ts,
  name: mcp ? "search_dbdog_database_samples" : "Read", status: "ok", output,
  tags: mcp ? { mcp_server: "dbdog" } : {} });
const h = (id, hypothesis, claim, relations = []) => ({ event: "hypothesis", id, hypothesis, claim, relations });
const observation = (id, observationId, ref, quote, hypothesis, effect = "supports", check) => ({
  event: "evidence", id, observation: observationId, ...(check ? { check } : {}),
  sources: [{ ref, quote }], summary: quote,
  links: [{ hypothesis, effect, aspect: "activation", reason: "返回值满足该路径的触发条件" }],
});

describe("结构化调查事件与实际取证关联", () => {
  it("定位取证可以先于假设，同一结果能支持 H1 并反驳 H2，执行顺序不充当因果关系", () => {
    const g = build([
      message("m1", 1, [{ event: "check", id: "n1", check: "C1", mode: "locate", hypotheses: [], purpose: "定位阻塞者" }]),
      call("tool-a", 2, "A waits on B; CPU 12%"),
      message("m2", 3, [h("n2", "H1", "A 被 B 阻塞"), h("n3", "H2", "CPU 饱和导致 A 慢"),
        { ...observation("n4", "O1", "E:tool-a", "A waits on B", "H1", "supports", "C1"),
          links: [
            { hypothesis: "H1", effect: "supports", aspect: "activation", reason: "活动样本给出阻塞边" },
            { hypothesis: "H2", effect: "refutes", aspect: "impact", reason: "CPU 未饱和" },
          ], sources: [{ ref: "E:tool-a", quote: "A waits on B; CPU 12%" }] },
      ]),
    ]);
    expect(g.investigation.checks[0]).toMatchObject({ id: "C1", mode: "locate", hypotheses: [] });
    expect(g.investigation.observations[0]).toMatchObject({ id: "O1", sources: [{ ref: "E:tool-a", span_id: "tool-a", matched: true }] });
    expect(g.investigation.edges.filter(e => e.kind === "evidence")).toMatchObject([
      { from: "O1", to: "H1", effect: "supports" }, { from: "O1", to: "H2", effect: "refutes" },
    ]);
    expect(g.investigation.edges.filter(e => e.kind === "relation")).toEqual([]);
    expect(g.nodes.map(n => n.id)).toEqual(["H1", "H2"]);
    expect(g.nodes.map(n => n.calls[0].span_id)).toEqual(["tool-a", "tool-a"]);
    expect(g.unattached_tools).toHaveLength(0);
  });

  it("源码和遥测使用同一证据引用机制，并行结果按引用绑定而非按最近时间猜测", () => {
    const g = build([
      message("m1", 1, [h("n1", "H1", "逐分区循环产生处理成本")]),
      call("read-a", 2, "for (partition : partitions) vacuum(partition);", false),
      call("metric-a", 3, "partition_count=8000"),
      message("m2", 4, [
        { ...observation("n2", "O1", "E:read-a", "for (partition : partitions)", "H1"),
          sources: [{ ref: "E:read-a", quote: "for (partition : partitions)", location: "vacuum.cpp:42", revision: "abc123" }] },
        observation("n3", "O2", "E:metric-a", "partition_count=8000", "H1"),
      ]),
    ]);
    expect(g.investigation.observations.map(o => o.sources[0].span_id)).toEqual(["read-a", "metric-a"]);
    expect(g.investigation.observations[0].sources[0]).toMatchObject({ basis: "source", revision: "abc123" });
    expect(g.investigation.observations[1].sources[0].basis).toBe("telemetry");
  });

  it("最后一轮可直接更新状态，保留 supported → open 历史，模型声明不等于系统验证", () => {
    const events = [
      h("n1", "H1", "A 等待 B"),
      observation("n2", "O1", "E:tool-a", "A waits on B", "H1"),
      { event: "update", id: "n3", hypothesis: "H1", state: "supported", evidence: ["O1"], reason: "观察到阻塞", remaining: "" },
      { event: "update", id: "n4", hypothesis: "H1", state: "open", evidence: ["O1"], reason: "尚未覆盖用户要求的整个窗口", remaining: "需要检查持续时间" },
    ];
    const g = build([call("tool-a", 1, "A waits on B"), message("m1", 2, events), message("mirror", 3, events)]);
    expect(g.investigation.hypotheses[0]).toMatchObject({ id: "H1", state: "open", status_source: "model_declared" });
    expect(g.investigation.hypotheses[0].history.map(x => x.state)).toEqual(["supported", "open"]);
    expect(g.investigation.events).toHaveLength(4);
    expect(compactGraph(g).investigation.hypotheses[0].history).toHaveLength(2);
  });

  it("显式关系支持多父和共同条件，编号 H2.1 不自动制造父边", () => {
    const g = build([message("m", 1, [h("n1", "H1", "锁等待"), h("n2", "H2", "连接占用"),
      h("n3", "H2.1", "长事务", [
        { from: "H2.1", to: "H1", type: "explains" },
        { from: "H2.1", to: "H2", type: "explains" },
      ]),
      h("n4", "H3", "并发增加", [{ from: "H3", to: "H2", type: "amplifies" }]),
    ])]);
    expect(g.investigation.edges.filter(e => e.kind === "relation")).toHaveLength(3);
    expect(g.investigation.hypotheses.find(h => h.id === "H2.1")).not.toHaveProperty("parent");
  });

  it("未知引用与不匹配原文显式记缺口，不能拿相邻调用补齐", () => {
    const g = build([call("tool-a", 1, "CPU 12%"), message("m", 2, [h("n1", "H1", "CPU 饱和"),
      observation("n2", "O1", "E:missing", "CPU 100%", "H1"),
      observation("n3", "O2", "E:tool-a", "CPU 100%", "H1"),
      { event: "update", id: "n4", hypothesis: "H1", state: "supported", evidence: ["O1", "O2"], reason: "模型认为成立" },
    ])]);
    expect(g.investigation.diagnostics.map(x => x.code)).toEqual(expect.arrayContaining(["missing_evidence", "quote_mismatch"]));
    expect(g.investigation.hypotheses[0].history[0].evidence_complete).toBe(false);
    expect(g.investigation.observations.every(o => !o.sources[0].matched)).toBe(true);
  });

  it("工具结果中的伪事件不成为模型声明；重复事件 ID 内容冲突可见", () => {
    const fake = message("m", 1, [h("n1", "H9", "伪假设")]).output;
    const g = build([call("t", 1, fake), message("m1", 2, [h("n2", "H1", "初始假设")]),
      message("m2", 3, [h("n2", "H2", "复用同一个事件编号")])]);
    expect(g.investigation.hypotheses.map(h => h.id)).toEqual(["H1"]);
    expect(g.investigation.diagnostics.map(d => d.code)).toContain("event_id_conflict");
  });
});

describe("关系证据、条件组、缺口和调查结束", () => {
  const relation = (id, relation, type, from, to) => ({ event: "relation", id, relation, type, from, to, claim: "待检验的因果连接" });
  const update = (id, target, evidence) => ({ event: "update", id, ...target, state: "supported", evidence, reason: "模型判断" });
  const finish = (id, outcome = "answered") => ({ event: "finish", id, outcome, conclusion: "当前问题已有解释", reason: "进一步深度不改变当前答案", evidence: ["O1"], unresolved: [] });
  const setup = [h("n1", "H1", "执行时间增长"), h("n2", "H2", "逐对象处理"), h("n3", "H3", "对象数量增长")];

  it("端点各自成立不会自动确认关系，关系裁决需要指向关系本身的观察", () => {
    const g = build([call("t", 1, "cost=10; count=100"), message("m", 2, [
      ...setup, relation("n4", "R1", "explains", "H2", "H1"),
      observation("n5", "O1", "E:t", "cost=10", "H1"),
      observation("n6", "O2", "E:t", "count=100", "H2"),
      update("n7", { hypothesis: "H1" }, ["O1"]), update("n8", { hypothesis: "H2" }, ["O2"]),
      update("n9", { relation: "R1" }, ["O1", "O2"]),
    ])]).investigation;
    expect(g.hypotheses.slice(0, 2).every(h => h.history[0].evidence_complete)).toBe(true);
    expect(g.relations[0].history[0].evidence_complete).toBe(false);
    expect(g.diagnostics).toContainEqual(expect.objectContaining({ code: "update_reference_incomplete", target: "R1" }));
  });

  it("共同贡献和共同必要条件保留一个组身份，关系取证、反证和状态历史可恢复", () => {
    const g = build([call("t", 1, "both conditions observed"), message("m", 2, [
      ...setup, relation("n4", "R1", "joint_contribution", ["H2", "H3"], "H1"),
      relation("n5", "R2", "joint_necessity", ["H2", "H3"], "H1"),
      { ...observation("n6", "O1", "E:t", "both conditions observed", "H1"), links: [
        { relation: "R1", effect: "supports", aspect: "activation", reason: "共同作用" },
        { relation: "R2", effect: "inconclusive", aspect: "mechanism", reason: "同时出现不能证明必要性" },
      ] },
      update("n7", { relation: "R1" }, ["O1"]),
      { ...update("n8", { relation: "R2" }, ["O1"]), state: "inconclusive" },
    ])]);
    expect(g.investigation.edges.filter(e => e.kind === "condition_group")).toHaveLength(2);
    expect(g.investigation.relations[0]).toMatchObject({ from: ["H2", "H3"], state: "supported", history: [{ evidence_complete: true }] });
    expect(g.investigation.relations[1].state).toBe("inconclusive");
    expect(g.edges.filter(e => e.kind === "parent")).toHaveLength(0);
    expect(compactGraph(g).investigation.relations).toEqual(g.investigation.relations);
  });

  it("失败取证不随备用路径成功而消失；空原文只匹配实际空返回", () => {
    const g = build([call("empty", 1, ""), call("t", 2, "value=10"), message("m", 3, [
      ...setup,
      { event: "gap", id: "n4", gap: "D1", wanted: "完成态慢 SQL", attempt: "查指定实例和窗口", result: "empty", impact: "活动样本提供了替代证据", sources: [{ ref: "E:empty", quote: "" }] },
      { event: "gap", id: "n5", gap: "D2", wanted: "锁 profile", attempt: "查看客户端可用工具", result: "capability_unavailable", impact: "无法区分锁内部路径" },
      observation("n6", "O1", "E:t", "value=10", "H1"), update("n7", { hypothesis: "H1" }, ["O1"]), finish("n8"),
    ])]);
    expect(g.investigation.gaps).toHaveLength(2);
    expect(g.investigation.gaps[0].sources[0].matched).toBe(true);
    expect(g.investigation.gaps[1].sources).toEqual([]);
    expect(g.investigation.finishes[0].evidence_complete).toBe(true);
    expect(g.investigation.state).toBe("answered");
    const bad = build([call("t", 1, "nonempty"), message("m", 2, [h("n1", "H1", "test"), { ...observation("n2", "O1", "E:t", "", "H1"), summary: "期望空返回" }])]);
    expect(bad.investigation.observations[0].sources[0].matched).toBe(false);
  });

  it("假设支持不隐含调查结束，完成后继续取证会重新激活且保留结束历史", () => {
    const before = [call("t", 1, "value=10"), message("m", 2, [h("n1", "H1", "test"),
      observation("n2", "O1", "E:t", "value=10", "H1"), update("n3", { hypothesis: "H1" }, ["O1"])])];
    expect(build(before).investigation.state).toBe("active");
    const g = build([...before, message("end", 3, [finish("n4")]), message("next", 4, [
      { event: "revise", id: "n5", hypothesis: "H1", claim: "补充到整个窗口", reason: "用户补充了范围" },
    ])]);
    expect(g.investigation.state).toBe("active");
    expect(g.investigation.finishes).toHaveLength(1);
    expect(g.investigation.hypotheses[0].claim_history.map(r => r.claim)).toEqual(["test", "补充到整个窗口"]);
    expect(g.investigation.hypotheses[0].history.map(u => u.state)).toEqual(["supported", "open"]);
  });

  it("根 span 镜像最终消息时采用原始 llm 顺序，不在声明/取证之前提前结束", () => {
    const end = message("end", 5, [finish("n4")]);
    const g = build([{ ...end, kind: "agent", span_id: "root", ts: 0 },
      message("m1", 1, [h("n1", "H1", "test")]), call("t", 2, "value=10"),
      message("m2", 3, [observation("n2", "O1", "E:t", "value=10", "H1")]), end]);
    expect(g.investigation.finishes).toHaveLength(1);
    expect(g.investigation.finishes[0]).toMatchObject({ span_id: "end", evidence_complete: true });
    expect(g.investigation.state).toBe("answered");
  });

  it("证据边界必须说明缺失项，非法组和引用到未来观察不会静默成功", () => {
    const g = build([call("t", 1, "value=10"), message("m", 2, [
      ...setup, relation("n4", "R1", "joint_necessity", ["H2", "H2"], "H1"),
      finish("n5", "evidence_boundary"), update("n6", { hypothesis: "H1" }, ["O1"]),
      observation("n7", "O1", "E:t", "value=10", "H1"),
      { ...finish("n8", "evidence_boundary"), unresolved: [{ question: "为何触发", missing: "历史日志", next_step: "获取归档日志" }] },
    ])]);
    expect(g.investigation.diagnostics.filter(d => d.code === "invalid_event")).toHaveLength(2);
    expect(g.investigation.hypotheses[0].history[0].evidence_complete).toBe(false);
    expect(g.investigation.state).toBe("evidence_boundary");
    expect(g.investigation.finishes).toHaveLength(1);
  });
});


describe("阶段交付与验证职责", () => {
  const checkpoint = (id, evidence = []) => ({ event: "checkpoint", id,
    question: "为何等待", scope: "实例 A，10:00–10:10 UTC，版本待核",
    findings: [{ summary: "定位到事务 B，持续时间尚未知", evidence }],
    unresolved: [{ question: "是否解释全部延迟", missing: "持续时间", next_step: "查完成态与活动身份" }],
    next: { action: "量化等待贡献", reason: "对象已定位但影响未量化" } });
  const update = (id, evidence) => ({ event: "update", id, hypothesis: "H1", state: "supported", evidence, reason: "模型声明" });

  it("无假设的阶段结果仍可恢复，阶段结果本身不结束调查", () => {
    const g = build([message("m", 1, [checkpoint("stage1")])]);
    expect(g.investigation.state).toBe("active");
    expect(g.investigation.hypotheses).toEqual([]);
    expect(g.investigation.checkpoints[0].findings[0].reference_check).toBe("not_provided");
    expect(g.summary.investigation_checkpoints).toBe(1);
    expect(compactGraph(g).investigation.checkpoints[0]).toMatchObject(checkpoint("stage1"));
  });

  it("无引用能力单独标示，不把模型声明改成因果失败", () => {
    const g = build([message("m", 1, [h("n1", "H1", "源码机制"), update("n2", []),
      checkpoint("stage1"), { event: "finish", id: "n3", outcome: "answered", conclusion: "基于已给源码回答实现问题",
        reason: "问题范围内已回答", evidence: [], unresolved: [] }])]).investigation;
    expect(g.hypotheses[0]).toMatchObject({ state: "supported", history: [{ reference_check: "not_provided", evidence_complete: false }] });
    expect(g.finishes[0]).toMatchObject({ checkpoint: "stage1", reference_check: "not_provided" });
    expect(g.diagnostics).toEqual([]);
  });

  it("后面的工具结果不能追认先前观察；原文即使相同也拒绝匹配", () => {
    const g = build([message("m", 1, [h("n1", "H1", "A 等 B"), observation("n2", "O1", "E:later", "A waits on B", "H1"),
      update("n3", ["O1"])]), call("later", 2, "A waits on B")]).investigation;
    expect(g.observations[0].sources[0].matched).toBe(false);
    expect(g.diagnostics).toContainEqual(expect.objectContaining({ code: "future_evidence" }));
  });

  it("修订假设使旧解释失效，复用原始结果需针对新主张重新解释", () => {
    const g = build([call("t", 1, "A waits on B"), message("m", 2, [h("n1", "H1", "某次 A 等 B"),
      observation("n2", "O1", "E:t", "A waits on B", "H1"), update("n3", ["O1"]),
      { event: "revise", id: "n4", hypothesis: "H1", claim: "十分钟内 A 始终等 B", reason: "扩大主张范围" },
      update("n5", ["O1"]),
      observation("n6", "O2", "E:t", "A waits on B", "H1", "inconclusive"), update("n7", ["O2"]),
    ])]).investigation;
    const history = g.hypotheses[0].history;
    expect(history.map(u => u.reference_check)).toEqual(["matched", "not_provided", "incomplete", "matched"]);
    expect(g.diagnostics).toContainEqual(expect.objectContaining({ code: "stale_claim_interpretation" }));
    // 对 inconclusive 观察仍声明 supported，是模型的语义判断问题；引用校验不能冒充因果裁决。
    expect(g.hypotheses[0].state).toBe("supported");
  });

  it("阶段结果引用的观察必须已经存在，旧 checkpoint 不被后续范围变更覆盖", () => {
    const g = build([call("t", 1, "A waits on B"), message("m", 2, [checkpoint("stage1", ["O1"]),
      h("n1", "H1", "A 等 B"), observation("n2", "O1", "E:t", "A waits on B", "H1"),
      { ...checkpoint("stage2", ["O1"]), scope: "实例 A，扩展到全天" }])]).investigation;
    expect(g.checkpoints.map(c => c.findings[0].reference_check)).toEqual(["incomplete", "matched"]);
    expect(g.checkpoints.map(c => c.scope)).toEqual(["实例 A，10:00–10:10 UTC，版本待核", "实例 A，扩展到全天"]);
  });

  it("关系端点主张修订后，旧关系证据不能直接用于新连接", () => {
    const g = build([call("t", 1, "A waits on B"), message("m", 2, [h("n1", "H1", "A 等 B"), h("n2", "H2", "B 有未结束事务"),
      { event: "relation", id: "n3", relation: "R1", type: "explains", from: "H2", to: "H1", claim: "事务导致阻塞" },
      { ...observation("n4", "O1", "E:t", "A waits on B", "H1"), links: [{ relation: "R1", effect: "supports", aspect: "activation", reason: "活动边" }] },
      { event: "update", id: "n4u", relation: "R1", state: "supported", evidence: ["O1"], reason: "旧范围的关系" },
      { event: "revise", id: "n5", hypothesis: "H2", claim: "B 全天有未结束事务", reason: "范围改变" },
      { event: "update", id: "n6", relation: "R1", state: "supported", evidence: ["O1"], reason: "复用旧引用" }])]).investigation;
    expect(g.relations[0].history.map(u => u.reference_check)).toEqual(["matched", "incomplete"]);
  });
  it("端点修订不改写历史裁决，同时标出其已不适用于当前主张", () => {
    const g = build([call("t", 1, "A waits on B"), message("m", 2, [h("n1", "H1", "A 等 B"), h("n2", "H2", "B 持有事务"),
      { event: "relation", id: "n3", relation: "R1", type: "explains", from: "H2", to: "H1", claim: "事务导致阻塞" },
      { ...observation("n4", "O1", "E:t", "A waits on B", "H1"), links: [{ relation: "R1", effect: "supports", aspect: "activation", reason: "活动边" }] },
      { event: "update", id: "n5", relation: "R1", state: "supported", evidence: ["O1"], reason: "初始解释" },
      { event: "revise", id: "n6", hypothesis: "H2", claim: "B 全天持有事务", reason: "范围扩大" }])]).investigation;
    expect(g.relations[0]).toMatchObject({ state: "supported", assessment_current: false, history: [{ reference_check: "matched" }] });
  });

});
