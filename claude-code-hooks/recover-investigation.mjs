#!/usr/bin/env node
// 只读恢复：读取已落盘 span 与主 transcript 游标后的完整行，不推进采集游标，不上报网络。
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { obsDir, readState, scanSpans } from "./lib.mjs";
import { readNewLines, synthesize } from "./synthesize.mjs";
import { build, dedupe, writeGraph } from "./hypothesis-graph.mjs";

export async function investigationSnapshot(sessionId, transcriptPath) {
  const state = readState(sessionId);
  if (!state?.trace_id || state.active === false) throw new Error("No active recorded investigation for this session");
  if (state.transcript_path && transcriptPath && path.resolve(state.transcript_path) !== path.resolve(transcriptPath))
    throw new Error("Supplied transcript does not match the recorded main transcript");
  transcriptPath = state.transcript_path ?? transcriptPath;
  const spans = [];
  await scanSpans(s => { if (s.trace_id === state.trace_id) spans.push(s); });
  if (transcriptPath) {
    if (fs.statSync(transcriptPath).size < (state.cursor ?? 0)) throw new Error("Recorded cursor exceeds the supplied transcript; verify the main transcript identity");
    const { lines } = readNewLines(transcriptPath, state.cursor ?? 0);
    const tail = synthesize({ lines, traceId: state.trace_id, sessionId, parentId: state.root_span_id,
      mlApp: state.ml_app, pendingToolUses: new Map(Object.entries(state.pending_tool_uses ?? {})),
      lastEntryTs: state.last_entry_ts ?? null, partialLlm: state.partial_llm ?? null });
    spans.push(...tail.spans);
  }
  const merged = dedupe(spans);
  if (!merged.length) throw new Error("No persisted investigation records are available yet");
  return { state, spans: merged, graph: build(merged) };
}

export async function recoverInvestigation(sessionId, transcriptPath) {
  const { state, spans: merged, graph } = await investigationSnapshot(sessionId, transcriptPath);
  const out = path.join(obsDir(), "investigations", state.trace_id);
  const files = writeGraph(merged, out, { trace: state.trace_id, session: sessionId, recovery: true });
  // A model repairing a missing E: link needs the actual result identities and
  // text, not only a graph whose unlinked observations were rejected.
  files.evidence_spans = path.join(out, "evidence-spans.jsonl");
  fs.writeFileSync(files.evidence_spans, merged.filter(s => s.kind === "tool").map(s => JSON.stringify({
    ref: `E:${s.span_id}`, span_id: s.span_id, tool: s.name, ts: s.ts,
    input: s.input_local ?? s.input, output: s.output_local ?? s.output,
  })).join("\n") + "\n", { mode: 0o600 });
  return { trace_id: state.trace_id, state: graph.investigation?.state ?? "unrecorded",
    checkpoint: graph.investigation?.checkpoints.at(-1) ?? null,
    hypotheses: graph.investigation?.views?.hypothesis_view ?? null,
    diagnostics: graph.investigation?.diagnostics ?? [], files,
    coverage: "Persisted spans plus the supplied main transcript tail; unfinished child transcript tails may be absent. No hook cursor was advanced." };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  recoverInvestigation(process.argv[2], process.argv[3]).then(result => {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  }).catch(error => { process.stderr.write(error.message + "\n"); process.exitCode = 1; });
}
