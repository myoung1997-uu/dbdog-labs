// 共用工具：平台地址、运行时目录、发件箱、身份名、HTTP。零依赖（node 内建）。
//
// 纪律与 claude-code-hooks/lib.mjs（dbdog-agent-obs）一致：**hook 绝不打断会话** ——
// 错误一律吞掉、exit 0。唯一的例外是 push.mjs 往 stdout 打「回灌给模型」的 JSON，
// 那是它要的语义（见该文件），不是破坏纪律。
//
// 配置从哪来（先环境变量、后插件弹窗填的 userConfig）：
//   DBDOG_CASE_FEED_URL    平台地址，脚本化安装/覆盖用，优先级更高
//   CLAUDE_PLUGIN_OPTION_PLATFORM_URL   plugin.json 的 userConfig 在启用时问到的值
//   DBDOG_CASE_FEED_TOKEN  已有的推送凭证：给了就跳过自动开户（已经接好的机器别重开号）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 平台地址（去掉尾部斜杠）。空串 = 没配。 */
export function platformUrl() {
  const raw = process.env.DBDOG_CASE_FEED_URL?.trim() || process.env.CLAUDE_PLUGIN_OPTION_PLATFORM_URL?.trim() || "";
  return raw.replace(/\/+$/, "");
}

/**
 * 运行时目录（材料包 + 凭证配置都放这儿）。三级优先：
 *   1. DBDOG_CASE_FEED_DATA —— 非 Claude 的 agent（cursor/codex/裸机）显式指定，别把它塞进 .claude/
 *   2. ${CLAUDE_PLUGIN_DATA} —— 插件机制给的、跨插件升级保留的运行时目录
 *   3. ~/.claude/dbdog-case-feed —— 兜底
 * ⚠ 绝不用 ${CLAUDE_PLUGIN_ROOT}：那个路径每次插件升级都会换。
 */
export function dataDir() {
  const d = process.env.DBDOG_CASE_FEED_DATA?.trim() || process.env.CLAUDE_PLUGIN_DATA?.trim();
  return d || path.join(os.homedir(), ".claude", "dbdog-case-feed");
}

export function kitDir() {
  return path.join(dataDir(), "kit");
}
/** 材料包里的推送配置（平台按调用方地址 + token 现生成）。 */
export function kitPushConfig() {
  return path.join(kitDir(), "push-config.json");
}
/** 材料包里的推送脚本。 */
export function kitPushScript() {
  return path.join(kitDir(), "tc-push.sh");
}

/** 发件箱：项目目录下的 .dbdog-outbox（与 tc-push.sh --outbox 的约定一致）。 */
export function outboxDir(projectDir) {
  return path.join(projectDir, ".dbdog-outbox");
}

/**
 * 数一下发件箱里还有几批没推（含 manifest.json 的子目录）。
 * 跳过 sent/ —— tc-push.sh 推成功会把批次挪进去，那不是待推的。
 */
export function pendingBatches(projectDir) {
  const dir = outboxDir(projectDir);
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of names) {
    if (!e.isDirectory() || e.name === "sent") continue;
    if (fs.existsSync(path.join(dir, e.name, "manifest.json"))) out.push(e.name);
  }
  return out.sort();
}

/**
 * 材料包就绪没。**三个都要**：配置在、token 非空、推送脚本在。
 * 只查配置是不够的——解压到一半就失败的话，"半套材料"会被误判成就绪，
 * 之后每轮 Stop 都安静地推不出去。
 */
export function kitReady() {
  try {
    const cfg = JSON.parse(fs.readFileSync(kitPushConfig(), "utf8"));
    return Boolean(cfg?.token && cfg?.base_url) && fs.existsSync(kitPushScript());
  } catch {
    return false;
  }
}

/**
 * 默认身份名：`<类别>-<机器名>`。对齐平台现有习惯（claude-mac-3db / claude-scan-young），
 * 关键是把机器名带上 —— 多台机器、内外网两套部署都往里推，重名会被"同名换发"互相顶掉
 * token，事后极难查。可用 DBDOG_CASE_FEED_AGENT 覆盖。
 */
export function agentName(kind = "claude") {
  const override = process.env.DBDOG_CASE_FEED_AGENT?.trim();
  if (override) return override;
  const host = os.hostname().split(".")[0].toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return `${kind}-${host}`;
}

/** 请求超时：默认 15s。链路挂隧道/代理时首字节可能 1–4s 抖动，可用 env 放宽。 */
export function timeoutMs() {
  const n = Number(process.env.DBDOG_CASE_FEED_TIMEOUT_MS ?? "");
  return Number.isFinite(n) && n > 0 ? n : 15000;
}

/** 把网络层异常翻译成人话——「连不上 <地址>」是这套东西最常见也最该一眼看懂的故障。 */
export function humanNetError(url, err) {
  const cause = err?.cause?.code || err?.code || err?.name || "";
  const why =
    cause === "ENOTFOUND" ? "域名解析不了"
    : cause === "ECONNREFUSED" ? "对方端口没在听"
    : cause === "TimeoutError" || cause === "AbortError" ? "超时（链路慢或地址不通）"
    : cause || (err?.message ?? "未知错误");
  return `连不上 ${url}（${why}）`;
}

/**
 * 发一个 JSON 请求。返回 { status, ok, text }。**网络层错误直接抛**（带人话），
 * 由调用方决定怎么呈现——bootstrap 只提示、push 回灌给模型。
 */
export async function httpJson(url, { method = "GET", body, headers = {} } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs()),
    });
  } catch (err) {
    throw new Error(humanNetError(url, err));
  }
  const text = await res.text().catch(() => "");
  return { status: res.status, ok: res.ok, text };
}

/** 统一的前缀 stderr 警告（hook 只提示、不阻断）。 */
export function warn(msg) {
  process.stderr.write(`[dbdog-case-feed] ${msg}\n`);
}

export async function readStdinJson() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** 顶层包装：出错只写 stderr、永远 exit 0（hook 不得打断会话）。 */
export function run(main) {
  main().catch((err) => {
    warn(err?.stack ?? String(err));
    process.exit(0);
  });
}
