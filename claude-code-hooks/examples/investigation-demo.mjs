// 人工构造的协议与展示示例，不是生产调查或 Datadog 原始记录。
// node investigation-demo.mjs > /tmp/demo-spans.jsonl
import { pathToFileURL } from 'node:url';
export function demoSpans() {
  let seq = 0;
  const e = (event, fields) => ({ event, id: `demo-${++seq}`, ...fields });
  const message = (span_id, ts, events) => ({ span_id, trace_id: 'demo-lock-investigation', kind: 'llm', ts,
    output: '```dbdog-investigation\n' + JSON.stringify(events) + '\n```' });
  const hypotheses = [
    ['H1', 'orders 上的冲突锁使 checkout SQL 等待', ['question']],
    ['H2', '持锁事务占用连接，使 checkout 连接池耗尽', ['question']],
    ['H3', '数据库 CPU 饱和导致本次延迟', ['question']],
    ['H4', '事务 B 未结束，持续持有 orders 的冲突锁', ['H1', 'H2']],
    ['H5', '应用在事务 B 内同步等待支付响应，推迟了提交', ['H4']],
    ['H6', '内核释放锁失败导致事务 B 结束后仍持锁', ['H4']],
    ['H7', '支付端重试风暴放大了事务 B 的等待时间', ['H5']],
  ];
  const raw = 'DEMO ONLY: A waits on B on orders for 42s; B idle in transaction; pool 20/20 occupied; CPU 12%; B commits then releases locks; payment call spans 40s inside B; retries unavailable';
  const observations = [
    ['O1', ['H1', 'H4'], 'A waits on B on orders for 42s', 'supports', '样本明确给出对象、阻塞者及持续时间'],
    ['O2', ['H2'], 'pool 20/20 occupied', 'supports', '同一窗口连接全部占用；结合事务身份判断等待传播'],
    ['O3', ['H3'], 'CPU 12%', 'refutes', '本示例窗口的 CPU 不支持饱和解释'],
    ['O4', ['H5'], 'payment call spans 40s inside B', 'supports', '调用时间被事务 B 包含，覆盖主要等待'],
    ['O5', ['H6'], 'B commits then releases locks', 'refutes', '事务提交时正常释放锁'],
    ['O6', ['H7'], 'retries unavailable', 'inconclusive', '没有重试记录，无法判断放大因素'],
  ];
  const initial = message('start', 1, [
    e('checkpoint', { question: '【演示数据】checkout SQL 延迟与连接耗尽为什么同时发生？', scope: '人工协议示例 · 实例 demo-db · 10:00–10:05', findings: [], unresolved: [], next: { action: '定位等待与资源占用', reason: '把笼统延迟落到对象和窗口' } }),
    ...hypotheses.slice(0, 3).flatMap(([hypothesis, claim, parents]) => [e('hypothesis', { hypothesis, claim }), e('branch', { hypothesis, parents, reason: '进一步解释父节点中的现象；因果联系另行检验' })]),
    e('check', { check: 'C1', mode: 'test', hypotheses: ['H1', 'H2', 'H3'], purpose: '对照同一窗口的阻塞链、连接占用与 CPU', expect: '区分锁等待、连接耗尽和 CPU 饱和' }),
  ]);
  const results = observations.map(([observation, ids, quote, effect, reason]) => e('evidence', { observation, check: ['O4','O5'].includes(observation) ? 'C2' : observation === 'O6' ? 'C3' : 'C1', summary: reason,
    sources: [{ ref: ['O4','O5'].includes(observation) ? 'E:lifecycle' : observation === 'O6' ? 'E:retention' : 'E:sample', quote }], links: ids.map(hypothesis => ({ hypothesis, effect, aspect: 'activation', reason })) }));
  const states = [['H1','supported',['O1']], ['H2','supported',['O1','O2']], ['H3','refuted',['O3']], ['H4','supported',['O1']], ['H5','supported',['O4']], ['H6','refuted',['O5']], ['H7','inconclusive',['O6']]];
  // O1 对 H2 的传播判断也有明确关联；不是按相邻步骤猜测。
  results[0].links.push({ hypothesis: 'H2', effect: 'supports', aspect: 'activation', reason: '占用连接的等待者指向同一阻塞事务' });
  const declare = i => { const [hypothesis, claim, parents] = hypotheses[i]; return [e('hypothesis', {hypothesis, claim}), e('branch', {hypothesis, parents, reason: '沿已有观察进一步解释父节点描述的情况'})]; };
  const judge = row => { const [hypothesis, state, evidence] = row; return e('update', {hypothesis, state, evidence, reason: observations.find(o => o[1].includes(hypothesis))?.[4] ?? '按同一窗口的观察判断'}); };
  const tool = (span_id, ts, output) => ({span_id, trace_id:'demo-lock-investigation', kind:'tool', name:'demo_evidence', ts, output});
  return [initial, tool('sample', 2, raw.split('; B commits')[0]), message('deepen', 3, [
    ...declare(3), ...results.slice(0,3), ...states.slice(0,4).map(judge),
    ...declare(4), ...declare(5),
    e('check', {check:'C2', mode:'test', hypotheses:['H5','H6'], purpose:'检查 B 的事务生命周期及内部调用', expect:'提交前的外部调用或提交后的异常持锁将区分这两个解释'}),
  ]), tool('lifecycle',4,'DEMO ONLY: B commits then releases locks; payment call spans 40s inside B'), message('deeper',5,[
    ...results.slice(3,5), ...states.slice(4,6).map(judge),
    e('relation', { relation: 'R1', type: 'explains', from: 'H5', to: 'H4', claim: '事务内的支付调用推迟提交，延长持锁' }),
    e('evidence', { observation: 'O7', check: 'C2', summary: '支付调用覆盖事务 B 的主要等待时段', sources: [{ ref: 'E:lifecycle', quote: 'payment call spans 40s inside B' }], links: [{ relation: 'R1', effect: 'supports', aspect: 'activation', reason: '调用发生于事务内，延后提交' }] }),
    e('update', { relation: 'R1', state: 'supported', evidence: ['O7'], reason: '本示例的时序记录支持该连接' }),
    ...declare(6),
    e('check', {check:'C3', mode:'test', hypotheses:['H7'], purpose:'查询支付端重试记录', expect:'重试是否覆盖并放大等待时段'}),
  ]), tool('retention',6,'DEMO ONLY: retries unavailable'), message('judgment',7,[
    results[5], judge(states[6]),
    e('gap', { gap: 'D1', hypotheses: ['H7'], wanted: '支付端重试记录', attempt: '检查归档', result: 'outside_retention', impact: '无法判断是否还有重试放大因素' }),
    e('finish', { outcome: 'evidence_boundary', conclusion: '演示结论：事务内等待支付响应延长持锁，并与连接占用同时出现；支付端是否重试仍未确定。', reason: '本示例已交付数据库内确认部分；更深的支付行为缺少记录。', evidence: ['O1','O2','O4','O7'], answer_hypotheses: ['H1','H2','H4','H5'], answer_relations: ['R1'], unresolved: [{ question: '支付端为何等待', missing: '支付端重试及执行记录', next_step: '取得该时间窗口的支付端记录' }] }),
  ])];
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(demoSpans().map(s => JSON.stringify(s)).join('\n') + '\n');
}
