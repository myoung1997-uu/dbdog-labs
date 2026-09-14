import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recoverInvestigation } from "./recover-investigation.mjs";
// transcript envelope follows the same Claude Code shape exercised in hooks.test.mjs.
const oldDir = process.env.DBDOG_OBS_DIR;
let dir;
afterEach(() => { if (oldDir === undefined) delete process.env.DBDOG_OBS_DIR; else process.env.DBDOG_OBS_DIR = oldDir;
  if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
describe("调查上下文恢复", () => {
  it("从尚未 Stop 的 transcript 尾部恢复阶段与追问树，不推进采集状态", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "investigation-recovery-"));
    process.env.DBDOG_OBS_DIR = dir;
    const statePath = path.join(dir, "session.json");
    const state = JSON.stringify({ active: true, trace_id: "case", root_span_id: "root", cursor: 0, pending_tool_uses: {} });
    fs.writeFileSync(statePath, state);
    const events = [{ event: "checkpoint", id: "stage1", question: "为什么 SQL 慢", scope: "实例 X", findings: [], unresolved: [],
      next: { action: "定位阻塞者", reason: "检验锁等待" } },
      { event: "hypothesis", id: "h1", hypothesis: "H1", claim: "锁等待解释耗时" },
      { event: "branch", id: "b1", hypothesis: "H1", parents: ["question"], reason: "解释题面现象" }];
    const entry = { type: "assistant", uuid: "a1", timestamp: "2026-09-13T10:00:00.000Z",
      message: { role: "assistant", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "```dbdog-investigation\n" + JSON.stringify(events) + "\n```" }] } };
    const transcript = path.join(dir, "transcript.jsonl");
    fs.writeFileSync(transcript, JSON.stringify(entry) + "\n" + '{"incomplete":');
    const first = await recoverInvestigation("session", transcript);
    expect(first.checkpoint.question).toBe("为什么 SQL 慢");
    expect(first.hypotheses.edges).toMatchObject([{ from: "question", to: "H1" }]);
    expect(fs.readFileSync(statePath, "utf8")).toBe(state);
    expect(fs.existsSync(path.join(dir, "spans.jsonl"))).toBe(false);
    const second = await recoverInvestigation("session", transcript);
    expect(second.hypotheses.nodes).toEqual(first.hypotheses.nodes);
    const out = path.dirname(first.files.json);
    expect(JSON.parse(fs.readFileSync(path.join(out, "investigation-steps.json"), "utf8"))).toHaveLength(3);
    expect(JSON.parse(fs.readFileSync(path.join(out, "hypothesis-view.json"), "utf8")).root.question).toBe("为什么 SQL 慢");
  });
  it("缺少当前调查状态时暴露恢复缺口，不构造一个替代问题", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "investigation-recovery-"));
    process.env.DBDOG_OBS_DIR = dir;
    await expect(recoverInvestigation("missing")).rejects.toThrow("No active recorded investigation");
  });
});
