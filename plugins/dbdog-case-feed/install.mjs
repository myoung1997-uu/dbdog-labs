#!/usr/bin/env node
// 通用安装器 —— 给**没有插件机制、或没有可用钩子**的 agent（codex / 裸机 / 任何愿意跑一条命令的东西）。
// Claude Code 用户不需要它：插件装上就自己自举了。这里是同一套自举逻辑的手动版。
//
//   node install.mjs --server http://10.0.0.5:18888
//   node install.mjs --server http://10.0.0.5:18888 --kind codex --dir ~/dbdog-push-kit
//
// 干三件事：开户（拿推送凭证）→ 取材料包 → 落到本地并报告接下来怎么用。
//
// 与钩子不同，这是**人主动跑的 CLI**：失败要大声、要有退出码（钩子那边才需要"永不打断"）。
import fs from "node:fs";
import path from "node:path";
import { agentName, dataDir, humanNetError, kitDir, kitReady, platformUrl, timeoutMs } from "./scripts/lib.mjs";
import { readZip, stripTopDir } from "./scripts/zip.mjs";

function parseArgs(argv) {
  const o = { server: "", token: "", dir: "", kind: "other", agent: "", help: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--server": o.server = argv[++i] ?? ""; break;
      case "--token": o.token = argv[++i] ?? ""; break;
      case "--dir": o.dir = argv[++i] ?? ""; break;
      case "--kind": o.kind = argv[++i] ?? "other"; break;
      case "--agent": o.agent = argv[++i] ?? ""; break;
      case "-h": case "--help": o.help = true; break;
      default: throw new Error(`不认识的参数：${argv[i]}`);
    }
  }
  return o;
}

function usage() {
  console.log(`dbdog-case-feed 通用安装器

用法：
  node install.mjs --server <平台地址> [选项]

选项：
  --server <url>   用例平台地址，带端口。形如 http://10.0.0.5:18888
                   （内网/外网是两套独立部署，填错会把用例推到另一个平台，所以必填、无默认值）
  --token <tk-...> 已有的推送凭证：给了就跳过开户（已经接好的机器别重开号）
  --dir <目录>     材料包落地目录，默认 <运行时目录>/kit
  --kind <类别>    claude | cursor | codex | other（写进平台的身份类别，默认 other）
  --agent <名字>   身份名，默认 <类别>-<机器名>
  -h, --help       本帮助

环境变量（等价、供无人值守用）：DBDOG_CASE_FEED_URL / DBDOG_CASE_FEED_TOKEN /
DBDOG_CASE_FEED_DATA（运行时目录）/ DBDOG_CASE_FEED_AGENT / DBDOG_CASE_FEED_TIMEOUT_MS`);
}

async function post(url, body, headers = {}) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs()),
    });
  } catch (err) {
    throw new Error(humanNetError(url, err));
  }
  return res;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) return usage();

  const server = (o.server || platformUrl()).replace(/\/+$/, "");
  if (!server) {
    console.error("缺少平台地址。用法：node install.mjs --server http://<地址>:<端口>");
    console.error("（内网、外网是两套独立部署，各有各的库和凭证——地址必须你给，没有默认值。）");
    process.exit(2);
  }

  const dir = o.dir ? path.resolve(o.dir) : kitDir();
  const name = o.agent || agentName(o.kind);
  const preset = (o.token || process.env.DBDOG_CASE_FEED_TOKEN || "").trim();

  // ① 开户
  let token = preset;
  if (preset) {
    console.log(`· 用你给的凭证（跳过开户），身份名 ${name}`);
  } else {
    console.log(`· 开户：${name} @ ${server}`);
    const res = await post(`${server}/api/push-agents`, { agent_name: name, agent_kind: o.kind });
    const text = await res.text();
    if (!res.ok) throw new Error(`开户失败（HTTP ${res.status}）：${text.slice(0, 300)}`);
    token = JSON.parse(text).token;
    if (!token) throw new Error(`开户响应里没有 token：${text.slice(0, 300)}`);
    console.log(`  ✅ 拿到凭证 ${token.slice(0, 12)}…`);
  }

  // ② 取材料包
  console.log(`· 取材料包：${server}/api/testcases/push-kit`);
  const res = await post(`${server}/api/testcases/push-kit`, { token });
  if (!res.ok) throw new Error(`取材料包失败（HTTP ${res.status}）`);
  const entries = stripTopDir(readZip(Buffer.from(await res.arrayBuffer())));
  if (!entries.size) throw new Error("材料包是空的（zip 里没有预期目录），平台版本可能不对");

  // ③ 落地
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, data] of entries) {
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, data);
    if (rel.endsWith(".sh")) fs.chmodSync(dst, 0o755);
  }
  fs.writeFileSync(
    path.join(dataDir(), ".gitignore-hint"),
    "这个目录是 dbdog-case-feed 的运行时目录（材料包 + 凭证），别提交进任何仓库。\n",
  );
  if (!kitReady()) throw new Error("材料落地后自检没过（缺 push-config.json 或 tc-push.sh）");

  console.log(`  ✅ 落到 ${dir}（${entries.size} 个文件）`);
  console.log();
  console.log("接下来三件事：");
  console.log(`  1) 把 ${path.join(dir, "AGENTS.md")} 读一遍——筛什么、用例怎么组装、脚本契约，都在里面`);
  console.log(`     （把它粘进你的 agent 规则文件，或每次让它自己读）`);
  console.log(`  2) 每个用例一个目录写进 <项目>/.dbdog-outbox/<批次>/，配一个 manifest.json`);
  console.log(`  3) 每轮结束跑一次：`);
  console.log(`       ${path.join(dir, "tc-push.sh")} --outbox <项目>/.dbdog-outbox`);
  console.log(`     成功 → 批次移进 sent/；失败 → 错误清单打出来、批次留在发件箱，改完再跑一次即可。`);
  console.log();
  console.log(`连的是：${server}（换一套：改 DBDOG_CASE_FEED_URL 或重跑本命令）`);
}

main().catch((err) => {
  console.error(`\n❌ ${err?.message ?? err}`);
  process.exit(1);
});
