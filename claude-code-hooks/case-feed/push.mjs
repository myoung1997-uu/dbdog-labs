#!/usr/bin/env node
// Stop — 把发件箱里的用例推给平台，失败就把平台的错误清单**回灌给模型**让它自己修。
//
// 这一步是"装上就自动干活"的落点：agent 只负责把筛出来的用例写进 <项目>/.dbdog-outbox/<批次>/，
// 推送由这里在每轮结束时做掉。推失败不回灌的话，模型根本不知道推没推成功，下一轮也不会修。
//
// 回灌用 `{"decision":"block","reason":...}`（Stop 事件的结构化阻断），不用 exit 2 + stderr：
// 这套 hook 是 exec form 起 node、stdout 是我们的输出通道，走 JSON 不会被 shell 引号或
// profile 的 echo 污染。
//
// 三条**不许阻断**的情况（阻断会变成每轮卡住模型、把会话拖死）：
//   1. stop_hook_active 为真 —— Claude Code 已经因为本 hook 继续过一轮，再阻断就是死循环；
//   2. 发件箱里没有批次 —— 没东西可推是常态，安静退出；
//   3. 材料包没就位 —— 那是配置问题，不是模型能修的，提示一次就够，别拦它。
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { kitPushScript, kitReady, outboxDir, pendingBatches, readStdinJson, run, warn } from "./lib.mjs";

const RUN_TIMEOUT_MS = 110000; // hooks.json 里这一组给 120s，留出余量
const REASON_CAP = 4000; // 回灌给模型的文本上限——错误清单可能很长，但别把上下文灌爆

/** 让模型看到的那段话：先说要它干什么，再原样附上平台的错误清单。 */
function blockedReason(batches, output) {
  const head =
    `用例推送被平台拒收（批次：${batches.join(", ")}）。` +
    `按下面的清单修正 manifest / 复现文件，下一轮结束会自动重推；` +
    `修好之前不要以为已经推上去了。`;
  const body = (output || "").trim() || "(平台没给出错误清单，可能是网络或地址问题)";
  const text = `${head}\n\n${body}`;
  return text.length > REASON_CAP ? `${text.slice(0, REASON_CAP)}\n…(错误清单已截断)` : text;
}

run(async () => {
  let input = {};
  try {
    input = await readStdinJson();
  } catch {
    return; // 读不到 stdin 就没法判断，安静退出
  }

  if (input?.stop_hook_active) return; // ① 死循环闸

  const projectDir = (input?.cwd && fs.existsSync(input.cwd) ? input.cwd : process.cwd());
  const batches = pendingBatches(projectDir);
  if (!batches.length) return; // ② 没东西可推

  if (!kitReady()) {
    // ③ 配置问题，模型修不了。只在真有批次要推时提示——否则每轮都吵。
    warn(
      "发件箱里有待推的用例，但材料包/平台地址还没就绪，这轮没推。" +
        "确认插件启用时填的平台地址，或重开一个会话让它自举。",
    );
    return;
  }

  const script = kitPushScript();
  const r = spawnSync("bash", [script, "--outbox", outboxDir(projectDir)], {
    cwd: projectDir,
    encoding: "utf8",
    timeout: RUN_TIMEOUT_MS,
  });

  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status === 0) {
    // 推送成功：把 tc-push.sh 自己那句回执透给模型（让它知道推上去了）
    process.stdout.write(output.trim() ? `${output.trim()}\n` : "用例已推送。\n");
    return;
  }

  // 超时（status 为 null 且有 signal）与普通失败都回灌，话术分开
  const timedOut = r.status === null;
  const reason = timedOut
    ? `用例推送超时（>${RUN_TIMEOUT_MS / 1000}s 未返回，批次：${batches.join(", ")}）。` +
      `地址 ${outboxDir(projectDir)} 下的用例这轮没推成功，检查链路后下一轮会自动重试。`
    : blockedReason(batches, output);

  process.stdout.write(`${JSON.stringify({ decision: "block", reason })}\n`);
});
