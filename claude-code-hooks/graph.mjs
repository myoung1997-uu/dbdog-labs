#!/usr/bin/env node
// graph.mjs — 假设图命令行入口（span-graph skill 与人手都用它）。
//   node graph.mjs <spans.jsonl | 导出 JSON | 含 spans.jsonl 的目录> [--out 目录] [--trace id] [--session id]
// 显式记录另输出 hypothesis-view.json / investigation-steps.json / investigation.html。
import { run } from "./hypothesis-graph.mjs";

function parseArgs(argv) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out" || a === "--trace" || a === "--session") {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${a} 缺少参数`);
      opts[a.slice(2)] = argv[++i];
    }
    else if (a.startsWith('--')) throw new Error(`未知参数：${a}`);
    else rest.push(a);
  }
  if (rest.length !== 1) throw new Error('用法: node graph.mjs <spans.jsonl|导出JSON|目录> [--out 目录] [--trace id] [--session id]');
  return { input: rest[0], opts };
}

try {
  const { input, opts } = parseArgs(process.argv.slice(2));
  const result = run(input, opts);
  const { md, summary: s } = result;
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.investigation_summary) {
    const v = result.investigation_summary;
    process.stderr.write(`调查记录: 假设 ${v.hypotheses} · 追问边 ${v.investigation_parent_edges} · 因果/条件关系 ${v.relations} · 记录缺口 ${v.diagnostics} → ${result.html}\n`);
  } else process.stderr.write(
    `forward-path: 假设 ${s.hypotheses} · 假设边 ${s.parent_edges} · 工具边 ${s.tool_edges} · 收口 ${s.resolve_edges} · 未挂 ${s.unattached_tools}` +
      (s.source_hypotheses ? ` · 源码假设 ${s.source_hypotheses}（无现场证据 ${s.source_without_evidence}）` : "") +
      ` → ${md}\n`,
  );
} catch (err) {
  process.stderr.write(`${err?.message ?? err}\n`);
  process.exit(1);
}
