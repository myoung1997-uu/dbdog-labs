#!/usr/bin/env node
// SessionStart — 首次自举：开户（拿推送凭证）+ 把材料包取回本地。幂等：装好之后每次开会话
// 只做一个本地文件检查就返回，不碰网络。
//
// 为什么要自举而不是让用户手工跑一个安装脚本：这套东西要分发给别人用，"装完还要记得跑一步"
// 就一定会有人漏。开户接口本身不需要任何身份（平台认的是 X-Auth-Token，开户就是发那个 token），
// 所以给一个地址就能全自动办完。用户唯一要提供的是**地址**（内网/外网两套部署，只有装的人
// 知道该连哪套）。
//
// 为什么不阻断会话：材料包没拿到不等于不能用 Claude Code。所有失败都只往 stderr 说一句人话，
// 然后 exit 0。但"平台临时不可达"不能变成"每次开会话都卡十几秒"——失败后写一个冷却标记，
// 10 分钟内不再重试。
import fs from "node:fs";
import path from "node:path";
import {
  agentName,
  dataDir,
  httpJson,
  kitDir,
  kitReady,
  platformUrl,
  readStdinJson,
  run,
  warn,
} from "./lib.mjs";
import { readZip, stripTopDir } from "./zip.mjs";

const RETRY_COOLDOWN_MS = 10 * 60 * 1000;

function failMarker() {
  return path.join(dataDir(), "bootstrap-failed-at");
}

/** 刚失败过就先别试了——不然平台挂着的时候每次开会话都要等一次超时。 */
function inCooldown() {
  try {
    const t = Number(fs.readFileSync(failMarker(), "utf8").trim());
    return Number.isFinite(t) && Date.now() - t < RETRY_COOLDOWN_MS;
  } catch {
    return false;
  }
}

function markFailed() {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(failMarker(), String(Date.now()));
  } catch {
    /* 标记写不下去也不影响主流程 */
  }
}

function clearFailed() {
  try {
    fs.rmSync(failMarker(), { force: true });
  } catch {
    /* 同上 */
  }
}

/** 开户：拿一个新凭证。已有 DBDOG_CASE_FEED_TOKEN 就用它（已经接好的机器别重开号）。 */
async function obtainToken(url) {
  const preset = process.env.DBDOG_CASE_FEED_TOKEN?.trim();
  if (preset) return { token: preset, name: agentName(), minted: false };

  const name = agentName();
  const res = await httpJson(`${url}/api/push-agents`, {
    method: "POST",
    body: { agent_name: name, agent_kind: "claude" },
  });
  if (!res.ok) throw new Error(`开户失败（HTTP ${res.status}）：${res.text.slice(0, 200)}`);
  let data;
  try {
    data = JSON.parse(res.text);
  } catch {
    throw new Error(`开户响应不是 JSON：${res.text.slice(0, 200)}`);
  }
  if (!data?.token) throw new Error(`开户响应里没有 token：${res.text.slice(0, 200)}`);
  return { token: data.token, name, minted: true };
}

/** 取材料包并解到本地（剥掉 zip 最外层目录）。 */
async function fetchKit(url, token) {
  let res;
  try {
    res = await fetch(`${url}/api/testcases/push-kit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new Error(`取材料包失败：${err?.message ?? err}`);
  }
  if (!res.ok) throw new Error(`取材料包失败（HTTP ${res.status}）`);

  const entries = stripTopDir(readZip(Buffer.from(await res.arrayBuffer())));
  if (!entries.size) throw new Error("材料包是空的（zip 里没有预期目录）");

  const dir = kitDir();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, data] of entries) {
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, data);
    if (rel.endsWith(".sh")) fs.chmodSync(dst, 0o755); // 平台打的包里脚本是 755，这里自己来
  }
}

run(async () => {
  // 先把 stdin 读掉，免得写侧拿 EPIPE；hook 不关心内容
  try {
    await readStdinJson();
  } catch {
    /* 忽略 */
  }

  if (kitReady()) return; // 幂等：装好之后这一路是纯本地检查，不碰网络

  // 没配地址 = 这个功能没启用。**静默返回**：绝大多数 agent-obs 用户根本不用它
  // （他们的地址是 mcp 那套，见 DBDOG_OBS_*），不能因为加了供题能力就每次开会话去吵他们。
  // 想用的照 README 填 case_feed_url 或 DBDOG_CASE_FEED_URL。
  const url = platformUrl();
  if (!url) return;

  if (inCooldown()) return; // 刚失败过，这轮不重试（免得每次开会话都等一次超时）

  try {
    const { token, name } = await obtainToken(url);
    await fetchKit(url, token);
    if (!kitReady()) throw new Error("材料包落地后自检没过（配置或推送脚本缺失）");
    clearFailed();
    process.stdout.write(`✅ [dbdog-case-feed] 已接入 ${url}（身份 ${name}），材料包就位。\n`);
  } catch (err) {
    markFailed();
    warn(`${err?.message ?? err}；10 分钟内不再重试。可用 DBDOG_CASE_FEED_URL 改地址。`);
  }
});
