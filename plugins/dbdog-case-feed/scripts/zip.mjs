// 极简 ZIP 解包（零依赖，只用 node 内建的 zlib）。
//
// 为什么自己写：平台的 Agent 接入包是个 zip（POST /api/testcases/push-kit 的产物），
// 而 node 内建没有解压 API、`unzip` 命令行也不是每台机器都有。为了不引第三方依赖，
// 这里只实现"取回条目内容"所需的最小一部分：定位 EOCD → 读中央目录 → 逐个按
// 本地头取压缩数据 → method 0 原样 / method 8 走 inflateRaw。
//
// 不支持的（用不到，遇到就明确报错，不静默产出坏数据）：加密、ZIP64、
// method 0/8 之外的压缩算法、分卷。接入包是标准的 store/deflate，够用。
import zlib from "node:zlib";

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** 从尾部往前找 EOCD（注释最长 65535，所以最多回扫这么多字节）。 */
function findEocd(buf) {
  const min = Math.max(0, buf.length - 65535 - 22);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * 解出全部条目。返回 [{ name, data:Buffer }]，目录条目（名字以 / 结尾）跳过。
 * 任何结构性问题都抛错——调用方自己决定是提示用户还是静默跳过。
 */
export function readZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error("不是有效的 zip（太短）");
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error("不是有效的 zip（找不到目录尾记录）");

  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || count === 0xffff) throw new Error("不支持 ZIP64 格式的 zip");

  const out = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CD_SIG) {
      throw new Error(`中央目录第 ${i} 项损坏`);
    }
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    // ⚠ 本地头偏移在 **42**，不是 34 —— 34 是"起始磁盘号"(分卷用的，恒为 0)。
    // 读错这一格不会报错，而是让**每个条目都去偏移 0 取数据**：解出来的文件数、名字全对，
    // 内容却全是第一条的。就这么静默地把整套材料包解成 11 份同样的东西过。
    const localAt = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);

    // 本地头的名字/扩展区长度可能和中央目录不同（前者才是数据真正的起点）。
    if (localAt + 30 > buf.length || buf.readUInt32LE(localAt) !== LOCAL_SIG) {
      throw new Error(`条目 ${name} 的本地头损坏`);
    }
    const lNameLen = buf.readUInt16LE(localAt + 26);
    const lExtraLen = buf.readUInt16LE(localAt + 28);
    const dataAt = localAt + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataAt, dataAt + compSize);

    if (!name.endsWith("/")) {
      let data;
      if (method === 0) data = Buffer.from(raw);
      else if (method === 8) data = zlib.inflateRawSync(raw);
      else throw new Error(`条目 ${name} 用了不支持的压缩方式 ${method}`);
      out.push({ name, data });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/**
 * 剥掉接入包最外层的目录前缀（平台打的包里所有条目都在 `dbdog-push-kit/` 下），
 * 返回 { 相对路径: Buffer }。前缀外的条目原样保留路径，交给调用方过滤。
 */
export function stripTopDir(entries, top = "dbdog-push-kit/") {
  const out = new Map();
  for (const e of entries) {
    if (!e.name.startsWith(top)) continue;
    const rel = e.name.slice(top.length);
    if (!rel) continue;
    out.set(rel, e.data);
  }
  return out;
}
