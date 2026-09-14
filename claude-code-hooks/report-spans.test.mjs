import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reportSpans, spanForUpload, spanUploadBodies } from "./lib.mjs";
import { buildInvestigation } from "./investigation-events.mjs";

afterEach(() => vi.unstubAllEnvs());

async function sink(reply = () => 202) {
  const received = [], sizes = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    sizes.push(body.length);
    const payload = JSON.parse(body.toString());
    const status = reply(received.length, payload, body.length);
    received.push(payload);
    res.writeHead(status).end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  vi.stubEnv("DBDOG_OBS_REPORT_URL", `http://127.0.0.1:${server.address().port}/api/v2/llmobs/spans`);
  vi.stubEnv("DBDOG_OBS_API_KEY", "test-key");
  return { received, sizes, close: () => new Promise(resolve => server.close(resolve)) };
}

describe("原始 span 完整上报", () => {
  it("恢复原始字段，保留身份及图，不上传本地辅助键或修改原记录", () => {
    const raw = { span_id: "s1", input: "short", input_local: "完整输入",
      output: "short", output_local: "完整输出", thinking: "short", thinking_local: "完整记录",
      cache_local: "not a server field", graph: { nodes: [{ id: "H1" }] } };
    const wire = spanForUpload(raw);
    expect(wire).toEqual({ span_id: "s1", input: "完整输入", output: "完整输出",
      thinking: "完整记录", graph: raw.graph });
    expect(raw.output).toBe("short");
  });

  it("按实际 UTF-8 JSON 字节和数量分批，超目标单条仍完整发送", () => {
    const spans = Array.from({ length: 5 }, (_, i) => ({ span_id: String(i), output: '锁\\"'.repeat(i + 1) }));
    const bodies = [...spanUploadBodies(spans, { targetBytes: 90, maxCount: 2 })];
    const batches = bodies.map(JSON.parse);
    expect(batches.flatMap(batch => batch.spans)).toEqual(spans);
    for (let i = 0; i < bodies.length; i++) {
      expect(batches[i].spans.length).toBeLessThanOrEqual(2);
      expect(Buffer.byteLength(bodies[i]) <= 90 || batches[i].spans.length === 1).toBe(true);
    }
  });

  it("完整请求超过 5 MiB 时分批送达，接收端得到每条原文", async () => {
    const receiver = await sink((_index, _payload, bytes) => bytes > (5 << 20) ? 413 : 202);
    const spans = Array.from({ length: 10 }, (_, i) => ({ span_id: `s${i}`, output: "preview",
      output_local: "原始".repeat(100_000) + i }));
    try {
      expect(Buffer.byteLength(JSON.stringify({ spans: spans.map(spanForUpload) }))).toBeGreaterThan(5 << 20);
      expect(await reportSpans(spans)).toBe(true);
      expect(receiver.received.length).toBeGreaterThan(1);
      expect(receiver.received.flatMap(batch => batch.spans)).toEqual(spans.map(spanForUpload));
      expect(Math.max(...receiver.sizes)).toBeLessThanOrEqual(1 << 20);
    } finally { await receiver.close(); }
  });

  it("部分拒绝不宣称全量送达，不截断被拒绝的单条", async () => {
    const receiver = await sink(index => index === 0 ? 413 : 202);
    const spans = [
      { span_id: "big", output_local: "X".repeat((1 << 20) + 1) },
      { span_id: "small", output: "完整" },
    ];
    try {
      expect(await reportSpans(spans)).toBe(false);
      expect(receiver.received.flatMap(batch => batch.spans)).toEqual(spans.map(spanForUpload));
      expect(spans[0].output_local.length).toBe((1 << 20) + 1);
    } finally { await receiver.close(); }
  });

  it("事件和证据落在预览截断之后，仍能仅由上报 spans 还原相同节点、边和引用", async () => {
    const msg = (span_id, ts, events) => ({ span_id, trace_id: "tr1", kind: "llm", ts,
      output: "preview", output_local: "说明\n".repeat(5000) + "```dbdog-investigation\n" + JSON.stringify(events) + "\n```" });
    const spans = [
      msg("m1", 1, [
        { event: "checkpoint", id: "e0", question: "Why does A wait?", scope: "instance X, window W", findings: [], unresolved: [], next: { action: "inspect", reason: "find blocker" } },
        { event: "hypothesis", id: "e1", hypothesis: "H1", claim: "A waits for B on X in W" },
        { event: "branch", id: "e2", hypothesis: "H1", parents: ["question"], reason: "Explain A's wait" },
      ]),
      { span_id: "tool1", trace_id: "tr1", kind: "tool", ts: 2, name: "search_dbdog_database_samples",
        output: "preview", output_local: "其他样本\n".repeat(5000) + "A waits on B" },
      msg("m2", 3, [
        { event: "evidence", id: "e3", observation: "O1", summary: "B blocks A",
          sources: [{ ref: "E:tool1", quote: "A waits on B" }],
          links: [{ hypothesis: "H1", effect: "supports", aspect: "activation", reason: "Observed blocking relationship" }] },
        { event: "update", id: "e4", hypothesis: "H1", state: "supported", evidence: ["O1"], reason: "Actual samples identify B" },
      ]),
    ];
    const receiver = await sink();
    try {
      expect(await reportSpans(spans)).toBe(true);
      const rebuilt = buildInvestigation(receiver.received.flatMap(batch => batch.spans));
      expect(rebuilt).toEqual(buildInvestigation(spans));
      expect(rebuilt.views.hypothesis_view.edges).toMatchObject([{ from: "question", to: "H1" }]);
      expect(rebuilt.hypotheses[0].history.at(-1).reference_check).toBe("matched");
    } finally { await receiver.close(); }
  });
});
