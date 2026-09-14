import { deriveSpanId, readState } from "./lib.mjs";

// 与 synthesize 的普通工具 span 使用同一个身份函数；不把代理启动的 span 当作源码证据。
export function toolUseSpanId(traceId, toolUseId) {
  return deriveSpanId(traceId, `tool_use:${toolUseId}`);
}

export function evidenceReferenceOutput(input, state = readState(input?.session_id)) {
  if (!state?.trace_id || state.active === false || !input?.tool_use_id) return null;
  if (!/^(Read|Grep|Glob|Bash|mcp__dbdog.*)$/.test(String(input.tool_name ?? ""))) return null;
  const event = input.hook_event_name;
  if (!["PostToolUse", "PostToolUseFailure"].includes(event)) return null;
  const ref = `E:${toolUseSpanId(state.trace_id, input.tool_use_id)}`;
  return { hookSpecificOutput: { hookEventName: event,
    additionalContext: `dbdog evidence_ref=${ref}; tool=${input.tool_name}. This identifies this exact tool result, including an error. If you use it in a dbdog-investigation evidence event, copy this reference and quote the observed result. It does not establish that any hypothesis is supported.` } };
}
