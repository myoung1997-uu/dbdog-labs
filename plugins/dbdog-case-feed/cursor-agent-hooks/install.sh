#!/usr/bin/env bash
# 把 case-feed 的 stop 钩子装进 ~/.cursor/hooks.json。
#
# 用**文件安装**，不走 Cursor Marketplace 插件 —— 与 dbdog-agent-obs 的 cursor 安装脚本同款，
# 理由也一样：Cursor 本机 CLI 对插件提供的 hooks 不可靠。
# 手法：把 hooks.json 里的占位路径渲染成本机绝对路径 → jq 合并进目标（先备份）。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/.." && pwd)"
TARGET="${DBDOG_CURSOR_HOOKS_TARGET:-$HOME/.cursor/hooks.json}"
PLACEHOLDER='/ABSOLUTE/PATH/TO/dbdog-labs/plugins/dbdog-case-feed'

if ! command -v node >/dev/null 2>&1; then
  echo "需要 node >= 18" >&2; exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "合并安装需要 jq" >&2; exit 1
fi

mkdir -p "$(dirname "$TARGET")"
if [[ ! -f "$TARGET" ]]; then
  echo '{"version":1,"hooks":{}}' >"$TARGET"
fi
cp "$TARGET" "$TARGET.bak.$(date +%Y%m%d%H%M%S)"

RENDERED="$(mktemp)"
sed "s|$PLACEHOLDER|$PLUGIN_ROOT|g" "$HERE/hooks.json" >"$RENDERED"

# 合并：同名的 hook 事件整体覆盖（与本仓其它 kit 的合并口径一致）。
jq --slurpfile snip "$RENDERED" '
  .version = (.version // 1)
  | .hooks = ((.hooks // {}) + $snip[0].hooks)
' "$TARGET" >"$TARGET.new"
mv "$TARGET.new" "$TARGET"
rm -f "$RENDERED"

echo "已装 case-feed 的 stop 钩子 → $TARGET"
echo "插件根：$PLUGIN_ROOT"
echo "事件：$(jq -r '.hooks | keys | join(", ")' "$TARGET")"
echo
echo "还没配平台地址的话，先跑一次（会开户，并把材料包落到本地）："
echo "  export DBDOG_CASE_FEED_URL='http://<平台地址>:<端口>'"
echo "  node \"$PLUGIN_ROOT/install.mjs\" --kind cursor"
echo "  # 想让材料包落在 cursor 自己的目录下，再加：export DBDOG_CASE_FEED_DATA=~/.cursor/dbdog-case-feed"
echo
echo "之后开新的一轮 Cursor CLI agent：把筛好的用例写进 <项目>/.dbdog-outbox/，每轮结束会自动推。"
