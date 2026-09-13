# Cursor：case-feed 的钩子

把「每轮结束把发件箱里的用例推出去」接到 Cursor 本机 CLI agent 上。

## 安装

```sh
cd <本仓>/plugins/dbdog-case-feed/cursor-agent-hooks
./install.sh                       # 默认合并进 ~/.cursor/hooks.json（会先备份）
```

然后配平台地址并落地材料包（**只做一次**）：

```sh
export DBDOG_CASE_FEED_URL='http://<平台地址>:<端口>'   # 内网/外网两套独立部署，填你该连的那套
node ../install.mjs --kind cursor
```

想让它跟其它 Cursor 组件待在一起，加一句 `export DBDOG_CASE_FEED_DATA=~/.cursor/dbdog-case-feed`
（默认落在 `~/.claude/dbdog-case-feed/`）。

## 用法

开新的一轮 CLI agent，把筛好的用例按材料包里的 `AGENTS.md` 写进 `<项目>/.dbdog-outbox/<批次>/`。
每轮结束（`stop` 事件）会自动把发件箱里的批次推出去。

## 与 Claude Code 侧的差异（读侧须知）

| | Claude Code | Cursor |
|---|---|---|
| 触发点 | `Stop` | `stop` |
| 装法 | 插件市场（`claude plugin install`） | 文件安装（`install.sh` 合并 `~/.cursor/hooks.json`） |
| 自动自举（开户 + 取材料包） | 有（`SessionStart`） | **没有** —— 自己跑一次 `node ../install.mjs` |
| 推失败的错误回灌给模型 | 有（`decision: block`） | **不保证** —— Cursor 是否把 hook 输出喂回模型未验证，所以按"批次会留在发件箱、错误打到 stderr"设计 |

也就是说：**Cursor 侧"用例不会丢"是有保证的（失败就留在发件箱），但"模型自己知道失败了"没保证。**
想确认推没推成功，看那个批次的目录还在不在 `.dbdog-outbox/` 下 —— 推成功会被移进 `sent/`。

推送逻辑本身与 Claude 侧**共用同一份代码**（`../scripts/push.mjs`）—— 两侧的钩子载荷里
`cwd` 的含义一致，所以没有第二套实现要维护。
