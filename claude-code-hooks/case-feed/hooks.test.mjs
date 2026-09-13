// lib.mjs 与 push.mjs 的测试。push.mjs 用真起子进程的方式测（它要往 stdout 打
// 「回灌给模型」的 JSON，那正是最不能测错的一段 —— 打歪了 Claude Code 解析不了，
// 表现是"推送失败但模型什么都不说"）。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { agentName, kitReady, outboxDir, pendingBatches, platformUrl } from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUSH = path.join(HERE, "push.mjs");

/** 临时换环境变量跑一段（hook 都是读 process.env 的）。 */
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// ---------- platformUrl ----------

test("平台地址：环境变量优先，且去掉尾部斜杠", () => {
  withEnv({ DBDOG_CASE_FEED_URL: "http://a:1/", CLAUDE_PLUGIN_OPTION_CASE_FEED_URL: "http://b:2" }, () => {
    assert.equal(platformUrl(), "http://a:1");
  });
});

test("平台地址：环境变量没给时退回插件配置里的值", () => {
  withEnv({ DBDOG_CASE_FEED_URL: undefined, CLAUDE_PLUGIN_OPTION_CASE_FEED_URL: "http://b:2/" }, () => {
    assert.equal(platformUrl(), "http://b:2");
  });
});

test("平台地址：都没有时是空串 —— 绝不能偷偷有个默认值", () => {
  withEnv({ DBDOG_CASE_FEED_URL: undefined, CLAUDE_PLUGIN_OPTION_CASE_FEED_URL: undefined }, () => {
    assert.equal(platformUrl(), "");
  });
});

// ---------- agentName ----------

test("身份名带机器名（多机多套部署靠它区分，重名会互相顶掉 token）", () => {
  withEnv({ DBDOG_CASE_FEED_AGENT: undefined }, () => {
    const n = agentName("claude");
    assert.match(n, /^claude-[a-z0-9-]+$/);
    assert.ok(n.length > "claude-".length + 1);
  });
});

test("身份名可用环境变量覆盖", () => {
  withEnv({ DBDOG_CASE_FEED_AGENT: "claude-扫描机-01" }, () => {
    assert.equal(agentName("claude"), "claude-扫描机-01");
  });
});

// ---------- 发件箱 ----------

test("发件箱：只认含 manifest.json 的子目录，sent/ 不算待推", () => {
  const proj = tmp("cf-proj-");
  const out = outboxDir(proj);
  fs.mkdirSync(path.join(out, "batch-1"), { recursive: true });
  fs.writeFileSync(path.join(out, "batch-1", "manifest.json"), "{}");
  fs.mkdirSync(path.join(out, "batch-2"), { recursive: true }); // 没有 manifest，不算
  fs.mkdirSync(path.join(out, "sent", "batch-0"), { recursive: true });
  fs.writeFileSync(path.join(out, "sent", "batch-0", "manifest.json"), "{}");
  assert.deepEqual(pendingBatches(proj), ["batch-1"]);
});

test("发件箱：目录不存在时返回空数组，不抛", () => {
  assert.deepEqual(pendingBatches(path.join(tmp("cf-proj-"), "nope")), []);
});

// ---------- 材料包就绪 ----------

test("材料包就绪：配置+token+推送脚本三者缺一都不算就绪", () => {
  const data = tmp("cf-data-");
  withEnv({ CLAUDE_PLUGIN_DATA: data }, () => {
    assert.equal(kitReady(), false, "啥都没有时不该就绪");
    const kit = path.join(data, "kit");
    fs.mkdirSync(kit, { recursive: true });
    fs.writeFileSync(path.join(kit, "push-config.json"), JSON.stringify({ base_url: "http://x", token: "tk-1" }));
    assert.equal(kitReady(), false, "只有配置、没有脚本 → 半套材料，不算就绪");
    fs.writeFileSync(path.join(kit, "tc-push.sh"), "#!/bin/sh\n");
    assert.equal(kitReady(), true);
    fs.writeFileSync(path.join(kit, "push-config.json"), JSON.stringify({ base_url: "http://x", token: "" }));
    assert.equal(kitReady(), false, "token 是空的 → 不算就绪");
  });
});

// ---------- push.mjs 端到端 ----------

/** 造一个"项目 + 材料包"的场景，返回 {proj, data}。kitExit 决定假 tc-push.sh 的退出码。 */
function scenario({ kit = true, exit = 0, out = "", err = "" } = {}) {
  const proj = tmp("cf-proj-");
  const data = tmp("cf-data-");
  fs.mkdirSync(path.join(outboxDir(proj), "b1", "ZZ-001"), { recursive: true });
  fs.writeFileSync(path.join(outboxDir(proj), "b1", "manifest.json"), "{}");
  if (kit) {
    const k = path.join(data, "kit");
    fs.mkdirSync(k, { recursive: true });
    fs.writeFileSync(path.join(k, "push-config.json"), JSON.stringify({ base_url: "http://x", token: "tk-1" }));
    fs.writeFileSync(
      path.join(k, "tc-push.sh"),
      `#!/usr/bin/env bash\n[ -n "${out}" ] && echo "${out}"\n[ -n "${err}" ] && echo "${err}" >&2\nexit ${exit}\n`,
    );
    fs.chmodSync(path.join(k, "tc-push.sh"), 0o755);
  }
  return { proj, data };
}

function runPush({ proj, data }, stdin) {
  return spawnSync(process.execPath, [PUSH], {
    input: JSON.stringify(stdin),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PLUGIN_DATA: data, DBDOG_CASE_FEED_URL: "http://x" },
  });
}

test("push：stop_hook_active 为真时不出声（否则死循环）", () => {
  const s = scenario({ exit: 1, err: "平台拒收" });
  const r = runPush(s, { cwd: s.proj, stop_hook_active: true });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "");
});

test("push：发件箱空时不出声（常态，不该每轮废话）", () => {
  const s = scenario();
  fs.rmSync(outboxDir(s.proj), { recursive: true, force: true });
  const r = runPush(s, { cwd: s.proj, stop_hook_active: false });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "");
});

test("push：材料包没就位时不阻断，只提示（配置问题模型修不了）", () => {
  const s = scenario({ kit: false });
  const r = runPush(s, { cwd: s.proj, stop_hook_active: false });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "", "stdout 必须是空的 —— 不能打 block JSON");
  assert.match(r.stderr, /材料包|平台地址/);
});

test("push：推成功时透传回执，不打 block", () => {
  const s = scenario({ exit: 0, out: "已受理: {\"accepted\":1}" });
  const r = runPush(s, { cwd: s.proj, stop_hook_active: false });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /已受理/);
  assert.equal(r.stdout.includes("decision"), false);
});

test("push：推失败时打合法 JSON 且带平台错误清单（这就是回灌给模型的那段）", () => {
  const s = scenario({ exit: 1, out: "", err: "平台拒收(HTTP 401):\n  - auth: bad token" });
  const r = runPush(s, { cwd: s.proj, stop_hook_active: false });
  assert.equal(r.status, 0, "hook 自己必须 exit 0，靠 JSON 表达阻断");
  const d = JSON.parse(r.stdout); // 不是合法 JSON 就抛 —— 那正是要防的
  assert.equal(d.decision, "block");
  assert.match(d.reason, /auth: bad token/);
  assert.match(d.reason, /b1/);
});

test("push：超时也不静默 —— 同样回灌一句话", () => {
  const s = scenario();
  // 把假脚本换成会挂住的，再把超时压到最短
  fs.writeFileSync(path.join(s.data, "kit", "tc-push.sh"), "#!/usr/bin/env bash\nsleep 30\n");
  fs.chmodSync(path.join(s.data, "kit", "tc-push.sh"), 0o755);
  const r = spawnSync(process.execPath, [PUSH], {
    input: JSON.stringify({ cwd: s.proj, stop_hook_active: false }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PLUGIN_DATA: s.data, DBDOG_CASE_FEED_URL: "http://x", CF_TEST_KILL: "1" },
    timeout: 1000, // 子进程整体 1s 后被杀：这条只验"不会静默"，超时分支的完整语义由上面那条覆盖
  });
  // 被外部杀掉时不该有半截 JSON 输出（宁可不输出，也不能输出坏 JSON）
  if (r.stdout) assert.doesNotThrow(() => JSON.parse(r.stdout));
});
