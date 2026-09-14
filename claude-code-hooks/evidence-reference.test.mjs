import { describe, expect, it } from "vitest";
import { evidenceReferenceOutput } from "./evidence-reference.mjs";
import { synthesize } from "./synthesize.mjs";

describe("hook 返回的引用与 transcript 实际 span 对齐", () => {
  it.each(["Read", "mcp__dbdog__get_dbdog_metric"])("%s 返回的证据引用准确指向该次结果", name => {
    const input = { tool_name: name, tool_use_id: "toolu_123", hook_event_name: "PostToolUse" };
    const output = evidenceReferenceOutput(input, { trace_id: "trace-a", active: true });
    const lines = [
      { type: "assistant", uuid: "msg-1", timestamp: "2026-09-13T00:00:00Z", message: { usage: {}, content: [
        { type: "tool_use", id: "toolu_123", name, input: { file_path: "vacuum.cpp" } },
      ] } },
      { type: "user", timestamp: "2026-09-13T00:00:01Z", message: { content: [
        { type: "tool_result", tool_use_id: "toolu_123", content: "vacuum(partition);" },
      ] } },
    ].map(x => JSON.stringify(x));
    const result = synthesize({ lines, traceId: "trace-a", sessionId: "session", parentId: "root", pendingToolUses: new Map() });
    const tool = result.spans.find(s => s.kind === "tool");
    expect(output.hookSpecificOutput.additionalContext).toContain(`evidence_ref=E:${tool.span_id};`);
    expect(tool.output).toBe("vacuum(partition);");
  });
  it("并发两次相同工具使用不同引用，失败也能被准确引用", () => {
    const make = id => evidenceReferenceOutput({ tool_name: "Read", tool_use_id: id, hook_event_name: "PostToolUseFailure" }, { trace_id: "t" });
    expect(make("one")).not.toEqual(make("two"));
    expect(make("one").hookSpecificOutput.hookEventName).toBe("PostToolUseFailure");
  });
  it("无 trace、未激活、缺调用 ID、代理启动都不产生伪引用", () => {
    const input = { tool_name: "Read", tool_use_id: "one", hook_event_name: "PostToolUse" };
    expect(evidenceReferenceOutput(input, null)).toBeNull();
    expect(evidenceReferenceOutput(input, { trace_id: "t", active: false })).toBeNull();
    expect(evidenceReferenceOutput({ ...input, tool_use_id: "" }, { trace_id: "t" })).toBeNull();
    expect(evidenceReferenceOutput({ ...input, tool_name: "Agent" }, { trace_id: "t" })).toBeNull();
  });
});
