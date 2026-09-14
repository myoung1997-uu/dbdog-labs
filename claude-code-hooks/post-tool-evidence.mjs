#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { readStdinJson, readState, obsDir, run } from "./lib.mjs";
import { evidenceReferenceOutput } from "./evidence-reference.mjs";
import { investigationSnapshot } from "./recover-investigation.mjs";
import { investigationIssues } from "./investigation-delivery.mjs";

run(async () => {
  const input = await readStdinJson(), state = readState(input.session_id);
  const output = evidenceReferenceOutput(input, state);
  let feedback = "";
  if (state?.trace_id && state.active !== false && state.transcript_path) {
    let graph;
    try { ({ graph } = await investigationSnapshot(input.session_id)); }
    catch { graph = {}; } // Preserve the exact evidence reference even before the transcript tail is flushed.
    const issues = investigationIssues(graph.investigation);
    // Independent file avoids racing main/subagent collection cursors. Repeated
    // feedback is suppressed; changed issues are delivered on the next result.
    const file = path.join(obsDir(), `${state.trace_id}.delivery-feedback.json`);
    let previous = "";
    try { previous = fs.readFileSync(file, "utf8"); } catch { /* first check */ }
    const signature = JSON.stringify(issues);
    if (signature !== previous) {
      fs.mkdirSync(obsDir(), { recursive: true });
      fs.writeFileSync(file, signature);
      if (issues.length) feedback = `\ndbdog investigation record feedback:\n${issues.slice(0, 12).map(x => "- " + x).join("\n")}\nRepair these records from actual known facts before relying on them. Branches do not declare hypotheses. Do not invent E: references or query the database merely to fill fields; use the recovery inputs for existing results.`;
    }
  }
  if (output || feedback) process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: input.hook_event_name,
    additionalContext: (output?.hookSpecificOutput.additionalContext ?? "") + feedback,
  } }) + "\n");
});
