// zip.mjs 的解包测试。
//
// ⚠ 夹具是**外部工具（Info-ZIP `zip`）产出的真 zip**，不是用本仓的代码打包的。
// 为什么坚持这一点：拿自己写的打包器测自己的解包器，同一个理解错误会在两边互相抵消，
// 测试全绿而线上解出垃圾 —— 这个文件就是为了防那一类。2026-09 真出过一次：中央目录里
// 「本地头偏移」读错了一格（42 读成 34 = 起始磁盘号，恒为 0），结果**每个条目都去偏移 0
// 取数据**：条目数对、名字对、内容是第一条的副本。当时的夹具若由本仓代码生成，照样绿。
//
// 夹具内容（刻意覆盖三种情况）：
//   - push-config.json 走 **deflate**（平台那份 zip 全是 deflate）
//   - sub/SPEC.md / tc-push.sh 走 **stored**（zip 对小文件不压）
//   - 含**目录条目**（名字以 / 结尾，解析时要跳过）与**中文正文**
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { readZip, stripTopDir } from "./zip.mjs";

// Info-ZIP 产出，sha256 = d8632868c3e6310304c0dc0d170c284ea097cf961eb1336c87566bff9c2b65c2
const FIXTURE_B64 = [
  "UEsDBAoAAAAAAAOxLV0AAAAAAAAAAAAAAAAPABwAZGJkb2ctcHVzaC1raXQvVVQJAANFrqZqRa6manV4CwABBPUBAAAEAAAAAFBL",
  "AwQUAAAACAADsS1dX1BZOlMAAABaAAAAHwAcAGRiZG9nLXB1c2gta2l0L3B1c2gtY29uZmlnLmpzb25VVAkAA0WupmpFrqZqdXgL",
  "AAEE9QEAAAQAAAAAFcxLCoAwDADRvcfIWgl+Vr1MiRJpadXQpiCIdzdu58E8sFJl30oGB0FVHCLfdEhmN07zAj3olfg01TTs8dZW",
  "2KK0GryQBgMkiahcdbNVxZ/g7T5QSwMECgAAAAAAA7EtXQAAAAAAAAAAAAAAABMAHABkYmRvZy1wdXNoLWtpdC9zdWIvVVQJAANF",
  "rqZqRa6manV4CwABBPUBAAAEAAAAAFBLAwQKAAAAAAADsS1d2hWzwCUAAAAlAAAAGgAcAGRiZG9nLXB1c2gta2l0L3N1Yi9TUEVD",
  "Lm1kVVQJAANFrqZqRa6manV4CwABBPUBAAAEAAAAACMg6KeE6IyDCueUqOS+i+aOqOmAgeagvOW8j+inhOiMg+OAggpQSwMECgAA",
  "AAAAA7EtXTXfHqMqAAAAKgAAABkAHABkYmRvZy1wdXNoLWtpdC90Yy1wdXNoLnNoVVQJAANFrqZqRa6manV4CwABBPUBAAAEAAAA",
  "ACMhL3Vzci9iaW4vZW52IGJhc2gKZWNobyAiZml4dHVyZSBzY3JpcHQiClBLAQIeAwoAAAAAAAOxLV0AAAAAAAAAAAAAAAAPABgA",
  "AAAAAAAAEADtQQAAAABkYmRvZy1wdXNoLWtpdC9VVAUAA0Wupmp1eAsAAQT1AQAABAAAAABQSwECHgMUAAAACAADsS1dX1BZOlMA",
  "AABaAAAAHwAYAAAAAAABAAAApIFJAAAAZGJkb2ctcHVzaC1raXQvcHVzaC1jb25maWcuanNvblVUBQADRa6manV4CwABBPUBAAAE",
  "AAAAAFBLAQIeAwoAAAAAAAOxLV0AAAAAAAAAAAAAAAATABgAAAAAAAAAEADtQfUAAABkYmRvZy1wdXNoLWtpdC9zdWIvVVQFAANF",
  "rqZqdXgLAAEE9QEAAAQAAAAAUEsBAh4DCgAAAAAAA7EtXdoVs8AlAAAAJQAAABoAGAAAAAAAAQAAAKSBQgEAAGRiZG9nLXB1c2gt",
  "a2l0L3N1Yi9TUEVDLm1kVVQFAANFrqZqdXgLAAEE9QEAAAQAAAAAUEsBAh4DCgAAAAAAA7EtXTXfHqMqAAAAKgAAABkAGAAAAAAA",
  "AQAAAKSBuwEAAGRiZG9nLXB1c2gta2l0L3RjLXB1c2guc2hVVAUAA0Wupmp1eAsAAQT1AQAABAAAAABQSwUGAAAAAAUABQDSAQAA",
  "OAIAAAAA",
].join("");

const fixture = () => Buffer.from(FIXTURE_B64, "base64");

// 夹具里三个真文件的内容（逐字节期望值）——「内容对不对」才是这类解析器的命门
const EXPECTED = new Map([
  ["dbdog-push-kit/push-config.json", '{"base_url":"http://example:1234","token":"tk-fixture","push_path":"/api/testcases/push"}\n'],
  ["dbdog-push-kit/sub/SPEC.md", "# 规范\n用例推送格式规范。\n"],
  ["dbdog-push-kit/tc-push.sh", '#!/usr/bin/env bash\necho "fixture script"\n'],
]);

test("夹具本身没被动过（sha256 守卫）", () => {
  assert.equal(
    crypto.createHash("sha256").update(fixture()).digest("hex"),
    "d8632868c3e6310304c0dc0d170c284ea097cf961eb1336c87566bff9c2b65c2",
  );
});

test("解出全部文件条目，跳过目录条目", () => {
  const names = readZip(fixture()).map((e) => e.name);
  assert.deepEqual(names.sort(), [...EXPECTED.keys()].sort());
  // 目录条目（dbdog-push-kit/ 与 dbdog-push-kit/sub/）不该出现
  assert.ok(!names.some((n) => n.endsWith("/")));
});

test("每个文件的内容逐字节正确 —— 不是「都解出了同一份」", () => {
  const got = new Map(readZip(fixture()).map((e) => [e.name, e.data.toString("utf8")]));
  for (const [name, want] of EXPECTED) assert.equal(got.get(name), want, `${name} 内容不对`);
  // 反向断言：内容必须彼此不同。全都一样正是「偏移读错」那个 bug 的指纹。
  assert.equal(new Set(got.values()).size, EXPECTED.size);
});

test("deflate 与 stored 两种方式都能解出正确长度", () => {
  const byName = new Map(readZip(fixture()).map((e) => [e.name, e.data.length]));
  assert.equal(byName.get("dbdog-push-kit/push-config.json"), 90); // deflate
  assert.equal(byName.get("dbdog-push-kit/sub/SPEC.md"), 37); // stored
});

test("stripTopDir 剥掉最外层目录，保留子目录", () => {
  const m = stripTopDir(readZip(fixture()));
  assert.deepEqual([...m.keys()].sort(), ["push-config.json", "sub/SPEC.md", "tc-push.sh"]);
  assert.equal(m.get("sub/SPEC.md").toString("utf8"), EXPECTED.get("dbdog-push-kit/sub/SPEC.md"));
});

test("stripTopDir 缺前缀时返回空（别把无关 zip 当接入包）", () => {
  assert.equal(stripTopDir(readZip(fixture()), "not-this-prefix/").size, 0);
});

test("坏输入明确报错，不静默产出空结果", () => {
  assert.throws(() => readZip(Buffer.alloc(4)), /不是有效的 zip/);
  assert.throws(() => readZip(Buffer.from("这不是 zip,只是一段文本".repeat(20))), /找不到目录尾记录/);
});
