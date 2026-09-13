---
name: case-feed
description: 给 dbdog 供题——把筛出来的、用来考验 dbdog 系统能力的用例（复现脚本 + manifest）交给用例平台。**只负责组装和写进发件箱，不要自己跑推送命令**：每轮结束由钩子自动推，失败会把平台的错误清单回灌给你。触发词：供题 / 推用例 / 推送问题用例平台 / 上传问题用例 / 提交问题用例入库 / case-feed。
---

> 注意与 `diag-flywheel` 的区别：那个的"沉淀用例"是往 **dbdog-server** 存**考题**（评测诊断 agent 的能力）；
> 这个是把**复现用例**推给**用例平台**（dbdog-benchmark）。两者是不同系统、不同凭证，别混。

---

# case-feed —— 把筛出来的用例喂给 dbdog

你手上有一批值得考的用例（某个引擎缺陷的复现），要交给 dbdog 用例平台。
**你只做组装和写盘，推送由钩子自动做** —— 这样"推没推成功"不取决于你记不记得跑命令。

## 三步

### ① 先读规范（唯一权威，别凭记忆写）

规范会变，所以**不抄进这份 skill**，而是每台机器首次接入时从平台取最新一份：

```bash
cat "$CLAUDE_PLUGIN_DATA/kit/AGENTS.md"       # agent 指令：筛什么、怎么判、脚本契约、退出码含义
cat "$CLAUDE_PLUGIN_DATA/kit/SPEC.md"         # manifest 字段表 + 校验行为
cat "$CLAUDE_PLUGIN_DATA/kit/HANG-DRIVER.md"  # 只在做 hang（语句卡住）类用例时读
```

`$CLAUDE_PLUGIN_DATA` 是插件机制给的环境变量；**没设时**材料包在 `~/.claude/dbdog-case-feed/kit/`。

### ② 组装一个批次

一个批次一个目录：一个 `manifest.json` + **每个用例一个子目录**。

```
<项目>/.dbdog-outbox/<批次名>/
  manifest.json
  OG-6410/                    ← 用例编号就是目录名
    setup.sh  run.sh  cleanup.sh
```

⚠ **用例文件必须放在「用例编号」那个子目录里**。批次目录本身只放 `manifest.json`；把文件直接摊在批次目录下，扫描不到（表现为"推上去的文件莫名其妙的少"）。

### ③ 写进发件箱，然后正常结束这一轮

**不要自己跑 `tc-push.sh`。** 每轮结束（Stop 钩子）会自动把发件箱里的批次推出去：

- 推成功 → 批次被移进 `.dbdog-outbox/sent/`。
- 推失败 → 平台的错误清单作为一条反馈回到你这里；照它改，**下一轮结束会自动重推**，不用你手动做什么。

## 容易踩的几条

- **不许写死数据库连接。** 平台按所选实例注入 `PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE`（MySQL 场景是 `MYSQL_*`），脚本照读环境变量就行。
- **退出码三态**：`run` 脚本 `exit 0` = 复现成功；`1` = 跑通了但没复现；`2` = 环境异常或该版本判不了。
  **"判不了"不许记成"没复现"** —— 拿不准走 2。
- **`total_issues` / `filtered_issues` 报「本轮」增量**，不是累计值（平台按流水累加）。
- **同一批里别重复用例编号**（平台整笔拒收）。

## 排查：我现在连的是哪套？

平台有内网、外网两套独立部署，各有各的库和凭证 —— 推错套不会报错。想确认：

```bash
cat "$CLAUDE_PLUGIN_DATA/kit/push-config.json"   # base_url + 身份 token 前几位
```

要换一套：改环境变量 `DBDOG_CASE_FEED_URL`（或在插件配置里重填 `case_feed_url`），
然后删掉本插件 data 目录下的 `kit/` 让它重新自举。

（没配过 `case_feed_url` 的话，这个功能整个是关着的 —— 不会往任何平台发请求。）
