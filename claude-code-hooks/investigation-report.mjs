// 显式调查模型的离线展示；不解析自然语言，不推断边或判断结论。
export function reportData(investigation, spans, source = {}) {
  const refs = new Set(investigation.observations.flatMap(o => o.sources.map(s => s.ref)));
  const raw = spans.filter(s => refs.has(`E:${s.span_id}`)).map(s => ({
    ref: `E:${s.span_id}`, span_id: s.span_id, trace_id: s.trace_id, name: s.name,
    input: s.input_local ?? s.input, output: s.output_local ?? s.output, status: s.status,
  }));
  return { investigation, raw, source };
}

// 每层按所有已记录父边的最大深度排列；共享节点只画一次。未关联节点不补根边。
export function graphLayers(view) {
  const ids = ['question', ...view.nodes.map(n => n.id)];
  const levels = new Map();
  const pending = new Set(ids);
  while (pending.size) {
    let changed = false;
    for (const id of pending) {
      const parents = view.edges.filter(e => e.to === id).map(e => e.from);
      if (parents.some(p => !levels.has(p))) continue;
      levels.set(id, id === 'question' ? 0 : Math.max(0, ...parents.map(p => levels.get(p))) + 1);
      pending.delete(id); changed = true;
    }
    if (!changed) throw new Error('无法布局：追问边存在环或未知端点');
  }
  const rows = [];
  for (const [id, depth] of levels) (rows[depth] ??= []).push(id);
  return rows;
}

// 浏览器入口直接嵌入独立 HTML。呈现记录中的判断，不在展示层生成新归因。
function mountReport() {
  const data = JSON.parse(document.querySelector('#report-data').textContent);
  const inv = data.investigation, view = inv.views.hypothesis_view;
  const $ = selector => document.querySelector(selector);
  const labels = { supported: '得到支持', refuted: '已反驳', inconclusive: '证据不足', open: '待检验', active: '调查进行中', answered: '已回答', evidence_boundary: '以证据边界结束' };
  const effects = { supports: '支持', refutes: '反驳', inconclusive: '尚不能判断' };
  const aspects = { mechanism: '机制是否成立', activation: '本次是否发生', impact: '是否造成影响' };
  const relationTypes = { explains: '解释', alternative: '替代解释', amplifies: '放大', requires: '必要条件', joint_contribution: '共同作用', joint_necessity: '共同必要条件' };
  const gapResults = { empty: '没有返回数据', error: '检查出错', capability_unavailable: '当前能力不可用', outside_retention: '超出数据保留期限', inaccessible: '无法访问', inconclusive: '结果不足以判断' };
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  const fold = (parent, title, content = el('div')) => { const d = el('details'); d.append(el('summary', title), content); parent.append(d); return content; };
  const rawRecord = (parent, value) => fold(parent, '原始记录（JSON）', el('pre', JSON.stringify(value, null, 2), 'raw-json'));
  const field = (parent, title, text, cls) => { if (text == null || text === '') return; const p = el('p', null, cls); p.append(el('strong', title + '：'), document.createTextNode(text)); parent.append(p); };
  const block = (parent, title) => { const b = el('section', null, 'reading-block'); if (title) b.append(el('h3', title)); parent.append(b); return b; };
  const nodeMap = new Map(view.nodes.map(n => [n.id, n]));
  const relationMap = new Map(view.relations.map(r => [r.id, r]));
  const rawMap = new Map(data.raw.map(s => [s.ref, s]));
  const obsMap = new Map(inv.observations.map(o => [o.id, o]));
  const eventOrder = new Map(inv.events.map((e, i) => [e.id, i]));
  const details = $('#detail');
  // 历史步骤使用当时的主张，不能拿修订后的文字替换先前检验的解释。
  function targetTitle(id, at, kind) {
    if (id === 'question') return (at ? [...inv.checkpoints].reverse().find(c => eventOrder.get(c.id) <= eventOrder.get(at))?.question : view.root.question) ?? '调查问题';
    const n = kind === 'relation' ? null : nodeMap.get(id), r = kind === 'hypothesis' ? null : relationMap.get(id);
    if (n && at) return [...n.details.revisions].reverse().find(v => eventOrder.get(v.event_id) <= eventOrder.get(at))?.claim ?? `当时未声明的假设（${id}）`;
    return n?.claim ?? r?.claim ?? `未找到的记录（${id}）`;
  }
  function targetLink(parent, id, at, kind) {
    const b = el('button', targetTitle(id, at, kind), 'text-link'); b.title = id;
    b.onclick = () => { setTab('graph'); select(id, kind); details.scrollIntoView({ block: 'nearest' }); };
    parent.append(b);
  }
  function targets(parent, title, ids, at, kind) {
    if (!ids?.length) return;
    const b = block(parent, title); for (const id of ids) targetLink(b, id, at, kind);
  }
  function evidenceList(parent, ids) {
    for (const id of new Set(ids ?? [])) {
      const o = obsMap.get(id);
      const body = fold(parent, o?.summary ?? `缺少观察记录（${id}）`);
      showObservation(body, id);
    }
  }
  function unresolved(parent, items) {
    for (const u of items ?? []) {
      const b = block(parent, u.question); field(b, '缺少的证据', u.missing); field(b, '可以继续检查', u.next_step);
    }
  }
  function referenceNote(parent, check) {
    if (check === 'incomplete') parent.append(el('p', '部分证据引用缺失、未匹配，或不适用于当前主张；这项判断仍需核对。', 'warning'));
    else if (check === 'not_provided') parent.append(el('p', '这次判断未附证据引用。', 'meta'));
  }
  function showObservation(parent, id, at) {
    const o = obsMap.get(id);
    if (!o) { parent.append(el('p', `缺少观察记录（${id}）`, 'warning')); return; }
    const box = block(parent, '实际观察'); box.classList.add('evidence');
    box.append(el('p', o.summary));
    const links = inv.edges.filter(e => e.kind === 'evidence' && e.from === id);
    if (links.length) {
      const interpretation = block(box, '对解释的影响');
      for (const link of links) {
        const p = el('div', null, 'effect');
        p.append(el('span', effects[link.effect] ?? link.effect, 'effect-label ' + link.effect));
        targetLink(p, link.to, at ?? link.event_id, link.target_kind);
        field(p, aspects[link.aspect] ?? '判断理由', link.reason);
        interpretation.append(p);
      }
    } else box.append(el('p', '这条观察尚未关联具体解释，可用于定位现象。', 'meta'));
    const sources = fold(box, `原文依据 · ${o.sources.length} 处引用`);
    for (const source of o.sources) {
      const s = block(sources, source.tool ?? '取证来源');
      if (source.location) field(s, '位置', source.location);
      s.append(el('blockquote', source.quote || '（原始返回为空）'));
      s.append(el('p', source.matched ? '引用已在工具原文中找到；是否支持归因仍取决于上述解释。' : '引用尚未在原文中验证，请核对。', source.matched ? 'meta' : 'warning'));
      const raw = rawMap.get(source.ref);
      if (raw) {
        const body = fold(s, '完整工具输入与返回');
        field(body, '工具', raw.name);
        for (const [label, value] of [['输入', raw.input], ['返回', raw.output]]) {
          body.append(el('h4', label), el('pre', value == null ? '当前记录未包含此项。' : typeof value === 'string' ? value : JSON.stringify(value, null, 2), 'raw-output'));
        }
        rawRecord(body, raw);
      } else s.append(el('p', '当前文件未包含对应工具的原始返回。', 'warning'));
    }
  }
  function showCheck(parent, c) {
    field(parent, c.mode === 'locate' ? '定位什么' : '要检查什么', c.purpose);
    targets(parent, '检验的解释', c.hypotheses, c.event_id, 'hypothesis');
    targets(parent, '检验的关系', c.relations, c.event_id, 'relation');
    field(parent, '希望区分什么', c.expect);
  }
  function showGap(parent, g) {
    field(parent, '缺少的证据', g.wanted); field(parent, '已经尝试', g.attempt);
    field(parent, '实际结果', gapResults[g.result] ?? g.result); field(parent, '对结论的影响', g.impact);
    targets(parent, '受影响的解释', g.hypotheses, g.event_id, 'hypothesis');
    targets(parent, '受影响的关系', g.relations, g.event_id, 'relation');
    parent.append(el('p', '未取得证据不等于该解释被反驳。', 'meta'));
  }
  function showCheckpoint(parent, c) {
    field(parent, '调查问题', c.question); field(parent, '范围', c.scope);
    for (const f of c.findings ?? []) { const b = block(parent, '已有发现'); b.append(el('p', f.summary)); evidenceList(b, f.evidence); }
    unresolved(parent, c.unresolved); field(parent, '下一步', c.next?.action); field(parent, '选择理由', c.next?.reason);
  }
  function showDecision(parent, d) {
    field(parent, '判断', labels[d.state] ?? d.state); field(parent, '理由', d.reason);
    field(parent, '仍未解决', d.remaining); referenceNote(parent, d.reference_check); evidenceList(parent, d.evidence);
  }
  function showBranch(parent, b) {
    targets(parent, '为了进一步解释', b.parents, b.id);
    field(parent, '继续考虑', targetTitle(b.hypothesis, b.id)); field(parent, '追问理由', b.reason);
    parent.append(el('p', '这是调查深入的方向，是否存在因果联系需要另有证据。', 'meta'));
  }
  function showRelation(parent, r) {
    field(parent, '关系判断', r.claim); field(parent, '关系类型', relationTypes[r.type] ?? r.type);
    targets(parent, '起点解释', [r.from].flat()); targets(parent, '目标解释', [r.to]);
    field(parent, '当前状态', labels[r.state] ?? r.state);
    if (r.assessment_current === false) parent.append(el('p', '当前关系或相关假设尚未完成判定；历史判断不能自动沿用。', 'warning'));
    if (r.history?.length) showDecision(parent, r.history.at(-1));
    for (const d of r.history?.slice(0, -1) ?? []) showDecision(fold(parent, '此前判断 · ' + (labels[d.state] ?? d.state)), d);
    rawRecord(parent, r);
  }
  function showFinish(parent, f) {
    parent.append(el('p', f.conclusion)); field(parent, '结束方式', labels[f.outcome] ?? f.outcome); field(parent, '为什么结束', f.reason);
    targets(parent, '结论涉及的解释', f.answer_hypotheses, f.id); targets(parent, '结论涉及的关系', f.answer_relations, f.id, 'relation');
    if (f.unresolved?.length) unresolved(block(parent, '尚未确定的部分'), f.unresolved);
    referenceNote(parent, f.reference_check);
    if (f.evidence?.length) evidenceList(fold(parent, '结论依据'), f.evidence);
  }
  function select(id, kind) {
    document.querySelectorAll('.card').forEach(c => c.classList.toggle('selected', c.dataset.id === id && kind !== 'relation'));
    details.replaceChildren();
    if (id === 'question') {
      details.append(el('h2', '调查进展'));
      const current = inv.checkpoints.at(-1); if (current) showCheckpoint(details, current);
      for (const c of inv.checkpoints.slice(0, -1)) showCheckpoint(fold(details, '此前阶段 · ' + c.question), c);
      rawRecord(details, { checkpoints: inv.checkpoints, source: data.source }); return;
    }
    const n = kind === 'relation' ? null : nodeMap.get(id);
    if (!n) {
      const r = relationMap.get(id);
      if (r) { details.append(el('h2', '因果与条件关系')); showRelation(details, r); }
      else details.append(el('p', `未找到相关记录（${id}）`, 'warning'));
      return;
    }
    details.append(el('span', `${labels[n.state] ?? n.state} · ${id}`, 'badge'), el('h2', n.claim));
    field(details, '判断依据', n.decision_summary ?? '尚未记录判定');
    if (n.assessment_current === false) details.append(el('p', '当前主张尚未完成判定；此前的判断不能自动用于修订后的解释。', 'warning'));
    referenceNote(details, n.reference_check);
    const gaps = inv.gaps.filter(g => n.details.gaps.includes(g.id));
    for (const g of gaps) showGap(block(details, '尚缺什么'), g);
    for (const o of new Set([...n.key_evidence.map(e => e.observation), ...n.details.observations])) showObservation(details, o);
    for (const c of inv.checks.filter(c => n.details.checks.includes(c.id))) showCheck(fold(details, '如何检查 · ' + c.purpose), c);
    if (n.details.revisions.length > 1 || n.details.decisions.length > 1) {
      const history = fold(details, '解释与判断怎样变化');
      for (const s of inv.views.investigation_steps.filter(s => ['hypothesis', 'revise', 'update'].includes(s.event) && s.detail.hypothesis === id)) {
        const b = block(history, { hypothesis: '最初的解释', revise: '修订解释', update: '更新判断' }[s.event]);
        field(b, '当时的解释', s.detail.claim ?? targetTitle(id, s.id)); field(b, '理由', s.detail.reason);
        field(b, '判断', labels[s.detail.state]); field(b, '仍未解决', s.detail.remaining);
        evidenceList(b, s.detail.evidence);
      }
    }
    for (const b of n.details.branches) showBranch(fold(details, '为什么沿这个方向深入'), b);
    for (const r of view.relations.filter(r => r.to === id || [r.from].flat().includes(id))) showRelation(fold(details, '关系 · ' + r.claim), r);
    rawRecord(details, n);
  }
  $('#question').textContent = view.root.question ?? '调查问题未记录';
  $('#scope').textContent = view.root.scope ?? '';
  $('#state').textContent = labels[view.root.state] ?? view.root.state;
  $('#counts').textContent = `${view.nodes.length} 个候选解释 · ${inv.checks.length} 次检查 · ${inv.observations.length} 条观察`;
  const initial = inv.checkpoints[0];
  if (initial?.findings.length) {
    $('#findings').append(el('h2', '初始发现'));
    for (const f of initial.findings) evidenceList(fold($('#findings'), f.summary), f.evidence);
  }
  const board = $('#board'), cards = new Map();
  for (const row of data.layers) {
    const line = el('div', null, 'level'); board.append(line);
    for (const id of row) {
      const n = nodeMap.get(id), state = n?.state ?? 'question';
      const b = el('button', null, `card ${state}`); b.dataset.id = id;
      b.append(el('span', id === 'question' ? '调查问题' : labels[state] ?? state, 'badge'));
      b.append(el('strong', n?.claim ?? view.root.question ?? '未记录调查问题'));
      if (n) {
        b.append(el('span', n.decision_summary ?? '尚未记录判定', 'decision'));
        b.append(el('small', `${n.key_evidence.length} 条证据 · ${id}${n.reference_check === 'incomplete' ? ' · 引用待核对' : ''}${view.unplaced.includes(id) ? ' · 未记录追问来源' : ''}`));
      }
      b.onclick = () => select(id); line.append(b); cards.set(id, b);
    }
  }
  function drawEdges() {
    const svg = $('#edges'), rect = board.getBoundingClientRect();
    svg.replaceChildren(); svg.setAttribute('width', board.scrollWidth); svg.setAttribute('height', board.scrollHeight);
    for (const e of view.edges) {
      const a = cards.get(e.from).getBoundingClientRect(), b = cards.get(e.to).getBoundingClientRect();
      const x = a.x - rect.x + a.width / 2, y = a.bottom - rect.y;
      const tx = b.x - rect.x + b.width / 2, ty = b.top - rect.y;
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', `M${x},${y} C${x},${(y + ty) / 2} ${tx},${(y + ty) / 2} ${tx},${ty}`);
      p.setAttribute('class', nodeMap.get(e.to)?.state ?? 'open'); svg.append(p);
    }
  }
  new ResizeObserver(drawEdges).observe(board); requestAnimationFrame(drawEdges);
  for (const r of view.relations) showRelation(fold($('#relations'), `${labels[r.state] ?? r.state} · ${r.claim}`), r);
  if (!view.relations.length) $('#relations').hidden = true;
  const conclusion = $('#conclusion');
  if (view.root.state === 'active') {
    conclusion.append(el('h2', '当前阶段'), el('p', '调查尚未结束，或结束后已有新记录。'));
    if (view.conclusion) showFinish(fold(conclusion, '此前结束记录（不代表当前结论）'), view.conclusion);
  } else if (view.conclusion) {
    conclusion.append(el('h2', '调查结论')); showFinish(conclusion, view.conclusion);
  }
  const eventNames = { checkpoint: '定位问题与规划下一步', hypothesis: '提出解释', revise: '修订解释', branch: '继续深入原因', check: '选择检查', evidence: '取得观察', update: '更新判断', relation: '提出因果或条件关系', gap: '遇到证据边界', finish: '结束调查' };
  $('#steps').append(el('h2', '调查怎样推进'), el('p', '按实际记录顺序，查看考虑了什么、查到了什么，以及判断如何变化。', 'meta'));
  let step = 0;
  for (const s of inv.views.investigation_steps) {
    const d = s.detail;
    const summary = s.event === 'branch' ? targetTitle(d.hypothesis, s.id)
      : s.event === 'update' ? `${targetTitle(d.hypothesis ?? d.relation, s.id, d.hypothesis ? 'hypothesis' : 'relation')} · ${labels[d.state]}`
      : d.purpose ?? d.summary ?? d.claim ?? d.conclusion ?? d.wanted ?? d.reason ?? d.question ?? '';
    const body = fold($('#steps'), `${++step}. ${eventNames[s.event] ?? '调查记录'} · ${summary}`);
    body.parentElement.classList.add('step');
    if (s.event === 'checkpoint') showCheckpoint(body, d);
    else if (s.event === 'check') showCheck(body, d);
    else if (s.event === 'evidence') showObservation(body, d.id, s.id);
    else if (s.event === 'gap') showGap(body, d);
    else if (s.event === 'finish') {
      if (view.root.state === 'active' || s.id !== view.conclusion?.id) body.append(el('p', '历史结束记录，不代表当前结论。', 'warning'));
      showFinish(body, d);
    } else if (s.event === 'branch') showBranch(body, d);
    else if (s.event === 'update') {
      targets(body, '当时判断的解释', [d.hypothesis ?? d.relation], s.id, d.hypothesis ? 'hypothesis' : 'relation');
      const target = d.hypothesis ? nodeMap.get(d.hypothesis) : relationMap.get(d.relation);
      const history = target?.details?.decisions ?? target?.history ?? [];
      const index = history.findIndex(h => h.event_id === s.id);
      field(body, '状态变化', `${labels[history[index - 1]?.state ?? 'open']} → ${labels[d.state]}`);
      showDecision(body, history[index] ?? d);
    } else if (['hypothesis', 'revise', 'relation'].includes(s.event)) {
      field(body, '解释', d.claim); field(body, '理由', d.reason);
      if (s.event === 'revise') field(body, '修订后的状态', '待检验，原有判定需要重新核对');
      if (s.event === 'relation') {
        field(body, '关系类型', relationTypes[d.type] ?? d.type);
        targets(body, '起点解释', [d.from].flat(), s.id); targets(body, '目标解释', [d.to], s.id);
        body.append(el('p', '此处提出待检验的关系；后续证据与判断见调查步骤。', 'meta'));
      }
      evidenceList(body, d.based_on);
    }
    rawRecord(body, s);
  }
  const diagnosticNames = { missing_investigation_question: '未记录调查问题', missing_investigation_parent: '假设缺少明确的追问来源', investigation_parent_cycle: '追问关系形成循环，未绘制这些边', unknown_investigation_parent: '追问指向了不存在的父节点', unknown_branch_hypothesis: '追问关联的假设不存在', invalid_event_json: '调查记录格式无法读取', invalid_event: '调查记录缺少必要内容或格式不符', event_id_conflict: '同一记录编号出现冲突', ambiguous_trace_scope: '输入混合了多个调查', missing_evidence: '找不到引用的原始工具返回', future_evidence: '引用的工具返回发生在这条记录之后', quote_mismatch: '引用文字与工具原文不匹配', missing_observation: '缺少被引用的观察记录', missing_target_link: '证据未明确关联到此项判断', stale_claim_interpretation: '证据解释仍针对旧版主张', update_reference_incomplete: '判断所引用的证据不完整', finish_reference_incomplete: '结束结论所引用的证据不完整', finish_stale_assessment: '结束结论引用了旧版主张的判断', unknown_answer_claim: '结论关联的解释不存在', unresolved_relation: '关系的端点无法解析', unknown_check: '找不到对应的检查记录', unknown_hypothesis: '找不到关联的假设', unknown_relation: '找不到关联的关系', duplicate_hypothesis: '假设编号重复', duplicate_relation: '关系编号重复', duplicate_check: '检查编号重复', duplicate_observation: '观察编号重复', duplicate_gap: '证据缺口编号重复' };
  $('#diagnostics').textContent = inv.diagnostics.length ? `记录有 ${inv.diagnostics.length} 处需要核对` : '记录检查：未发现结构或引用缺口';
  if (!inv.diagnostics.length) $('#diagnostic-body').append(el('p', '记录可用于还原调查过程；这项检查不判断专业归因是否正确。'));
  for (const d of inv.diagnostics) {
    const b = block($('#diagnostic-body'), diagnosticNames[d.code] ?? '存在尚未识别的记录问题');
    const event = inv.views.investigation_steps.find(s => s.id === d.event_id);
    if (event) field(b, '相关步骤', eventNames[event.event]);
    const target = d.hypothesis ?? d.target; if (target) targets(b, '相关解释', [target]);
    field(b, '引用', d.ref); rawRecord(b, d);
  }
  function setTab(tab) {
    const graph = tab === 'graph'; $('#graph-panel').hidden = !graph; $('#steps').hidden = graph;
    document.querySelectorAll('[data-tab]').forEach(t => { const active = t.dataset.tab === tab; t.classList.toggle('active', active); t.setAttribute('aria-pressed', String(active)); });
    if (graph) requestAnimationFrame(drawEdges);
  }
  for (const b of document.querySelectorAll('[data-tab]')) b.onclick = () => setTab(b.dataset.tab);
  select('question');
}

export function renderInvestigationHtml(investigation, spans, source = {}) {
  const data = { ...reportData(investigation, spans, source), layers: graphLayers(investigation.views.hypothesis_view) };
  const serialized = JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>dbdog · 调查假设图</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f7f8fc;color:#24263b;font:14px/1.6 system-ui,-apple-system,sans-serif}header{background:#fff;border-bottom:1px solid #e3e5ef;padding:25px 32px}h1{font-size:23px;margin:8px 0}h2{font-size:16px;margin:0 0 12px}h3{font-size:14px}p{margin:8px 0}.brand{color:#6952ad;letter-spacing:2px;font-size:12px;font-weight:750}.meta,small{color:#626a80;font-size:12px}#state{float:right;color:#087e70;background:#e1f6f0;padding:4px 12px;border-radius:20px}nav{display:flex;gap:8px;margin:20px 28px}button{font:inherit;cursor:pointer;background:white;border:1px solid #d8dbe8;border-radius:7px;padding:8px 16px;color:inherit}button.active{background:#ece7fc;color:#61449e;border-color:#ac95df}button:focus-visible,summary:focus-visible{outline:3px solid #9b79dc;outline-offset:2px}main{padding:0 28px 28px}.workspace{display:grid;grid-template-columns:minmax(0,1fr) 420px;gap:20px}.pane,#detail,#steps{min-width:0;border:1px solid #deddea;border-radius:10px;background:white;padding:20px}#detail{position:sticky;top:15px;align-self:start;max-height:88vh;overflow:auto}.legend{display:flex;gap:18px;flex-wrap:wrap;font-size:12px;margin:16px 0;color:#5e6376}.legend span:before{content:'●';margin-right:5px}.green{color:#087f6c}.purple{color:#7761b2}.gray{color:#747b88}.amber{color:#986d14}#viewport{overflow:auto;border:1px solid #e6e2f3;border-radius:8px;background:#fcfbff}#board{position:relative;min-width:100%;width:max-content;padding:32px 24px}.level{position:relative;display:flex;justify-content:center;align-items:flex-start;gap:28px;margin-bottom:72px}.level:last-child{margin-bottom:0}.card{position:relative;z-index:1;width:255px;display:flex;flex-direction:column;gap:9px;text-align:left;padding:15px;background:white;border:1px solid #a994dc;box-shadow:0 3px 10px #30205608}.card strong{font-size:13px;line-height:1.6}.badge{font-size:11px;color:#7758aa}.decision{font-size:12px;color:#5d657b;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.card.supported{border-color:#14b99e}.supported .badge{color:#087f6c}.card.refuted{background:#f4f5f8;border-color:#bcc1cd}.refuted .badge{color:#626977}.card.inconclusive{border-color:#c59a42}.inconclusive .badge{color:#926912}.card.selected{box-shadow:0 0 0 3px #b7eadf}.card.question{width:340px;border-color:#cdc9dd}.card.question strong{font-size:14px}#edges{position:absolute;top:0;left:0;pointer-events:none;overflow:visible}#edges path{fill:none;stroke:#a894d1;stroke-width:1.7;stroke-dasharray:4 3}#edges .supported{stroke:#22bca2;stroke-dasharray:none}#edges .refuted{stroke:#c8cbd5}#edges .inconclusive{stroke:#c29a4b}#conclusion{margin-top:22px;border-left:3px solid #1bb59c;background:#effaf7;padding:18px}#relations{margin-top:20px}details{margin:10px 0;border:1px solid #e2e4ed;border-radius:6px;padding:9px 12px}summary{cursor:pointer;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 ui-monospace,monospace;background:#f5f6fa;padding:12px;border-radius:5px;max-height:450px;overflow:auto}.evidence{border-top:1px solid #e4e7ef;margin-top:16px}.warning{color:#a06612}.answer-links{display:flex;gap:8px}footer{padding:0 28px 25px;color:#697087;font-size:12px}[hidden]{display:none!important}@media(max-width:1000px){.workspace{grid-template-columns:1fr}#detail{position:static;max-height:none}main{padding:0 14px 20px}header{padding:20px}nav{margin:16px}}
.reading-block{margin:14px 0;overflow-wrap:anywhere}.reading-block h3{margin:0 0 6px}.reading-block h4{margin:12px 0 4px}.text-link{display:block;text-align:left;border:0;background:transparent;padding:3px 0;color:#62489d;text-decoration:underline;text-underline-offset:3px;white-space:normal;overflow-wrap:anywhere;font-size:13px}.effect{border-left:3px solid #e6e1ef;padding:8px 12px;margin:10px 0}.effect-label{font-size:12px;font-weight:650}.effect-label.supports{color:#087f6c}.effect-label.refutes{color:#77586a}.effect-label.inconclusive{color:#926912}blockquote{margin:10px 0;padding:10px 14px;border-left:3px solid #cbc2df;background:#f8f7fb;white-space:pre-wrap;overflow-wrap:anywhere}#detail h2{margin-top:10px;line-height:1.6}#detail .evidence{padding-top:12px}#steps{max-width:1040px;margin:auto}#steps>.step{padding:14px 18px;margin:14px 0}#steps>.step>summary{font-weight:600}.raw-json{color:#626a80}.step .reading-block{padding-left:6px}
</style><header><span class="brand">DBDOG / INVESTIGATION</span><span id="state"></span><h1 id="question"></h1><p id="scope" class="meta"></p><p id="counts" class="meta"></p></header>
<nav aria-label="调查视图"><button data-tab="graph" class="active" aria-pressed="true">假设图</button><button data-tab="steps" aria-pressed="false">调查步骤</button></nav>
<main><div id="graph-panel" class="workspace"><section class="pane"><section id="findings"></section><div class="legend"><span class="green">得到支持</span><span class="purple">待检验</span><span class="gray">已反驳</span><span class="amber">证据不足</span></div><p class="meta">向下连线表示继续追问，颜色取自子假设状态；不表示因果关系已经成立。点击节点查看证据。</p><div id="viewport"><div id="board"><svg id="edges" aria-hidden="true"></svg></div></div><section id="relations"><h2>因果与条件关系</h2></section><section id="conclusion"></section></section><aside id="detail" aria-label="节点详情"></aside></div><section id="steps" hidden aria-label="调查步骤"></section><details><summary id="diagnostics"></summary><div id="diagnostic-body"></div></details></main><footer>状态来自明确调查记录；结构完整、引用匹配和专业归因正确是不同判断。此离线文件包含所引用的原始取证内容。</footer>
<script type="application/json" id="report-data">${serialized}</script><script>(${mountReport.toString()})();</script></html>\n`;
}
