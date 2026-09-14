#!/usr/bin/env node
// 返回精确证据引用，不改变结果、权限或工具参数。诊断 trace 未开启时静默。
import { readStdinJson, run } from "./lib.mjs";
import { evidenceReferenceOutput } from "./evidence-reference.mjs";

run(async () => {
  const output = evidenceReferenceOutput(await readStdinJson());
  if (output) process.stdout.write(JSON.stringify(output) + "\n");
});
