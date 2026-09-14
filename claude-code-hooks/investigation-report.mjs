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

// 浏览器入口直接嵌入独立 HTML；所有记录只以 textContent / JSON 文本展示。
function mountReport() {
  const data = JSON.parse(document.querySelector('#report-data').textContent);
  const inv = data.investigation, view = inv.views.hypothesis_view;
  const $ = selector => document.querySelector(selector);
  const labels = { supported: '得到支持', refuted: '已反驳', inconclusive: '证据不足', open: '待检验', active: '调查进行中', answered: '已回答', evidence_boundary: '以证据边界结束' };
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  const json = value => el('pre', JSON.stringify(value, null, 2));
  const fold = (parent, title, content) => { const d = el('details'); d.append(el('summary', title), content); parent.append(d); return d; };
  const nodeMap = new Map(view.nodes.map(n => [n.id, n]));
  const rawMap = new Map(data.raw.map(s => [s.ref, s]));
  const obsMap = new Map(inv.observations.map(o => [o.id, o]));
  const details = $('#detail');
  const heading = (title, text) => { details.append(el('h2', title)); if (text) details.append(el('p', text)); };
  function showObservation(parent, id) {
    const o = obsMap.get(id);
    if (!o) { parent.append(el('p', `记录缺口：${id}`)); return; }
    const box = el('section', null, 'evidence');
    box.append(el('h3', id), el('p', o.summary));
    for (const source of o.sources) {
      box.append(el('p', `${source.ref} · ${source.matched ? '原文引用匹配' : '引用未验证'}${source.location ? ' · ' + source.location : ''}`, 'meta'));
      box.append(el('pre', source.quote));
      if (rawMap.has(source.ref)) fold(box, '查看原始工具输入 / 返回', json(rawMap.get(source.ref)));
      else box.append(el('p', '当前输入没有对应原始 span。', 'warning'));
    }
    fold(box, '证据解释与目标', json(inv.edges.filter(e => e.kind === 'evidence' && e.from === id)));
    parent.append(box);
  }
  function select(id) {
    document.querySelectorAll('.card').forEach(c => c.classList.toggle('selected', c.dataset.id === id));
    details.replaceChildren();
    if (id === 'question') {
      heading('调查问题', view.root.question ?? '未记录调查问题');
      details.append(el('p', view.root.scope));
      fold(details, '阶段记录与下一步', json(inv.checkpoints));
      fold(details, '输入范围', json(data.source));
      return;
    }
    const n = nodeMap.get(id);
    if (!n) { heading('记录缺口', `没有找到被引用的假设 ${id}`); return; }
    heading(`${id} · ${labels[n.state] ?? n.state}`, n.claim);
    details.append(el('p', n.decision_summary ?? '尚未记录判定'), el('p', `判定来源：${n.status_source} · 引用检查：${n.reference_check} · 当前主张已判定：${n.assessment_current === true ? '是' : '否'}`, 'meta'));
    for (const o of new Set([...n.key_evidence.map(e => e.observation), ...n.details.observations])) showObservation(details, o);
    fold(details, '检查目的与预期', json(inv.checks.filter(c => n.details.checks.includes(c.id))));
    fold(details, '假设修订与判定历史', json({ revisions: n.details.revisions, decisions: n.details.decisions }));
    fold(details, '追问关系及其理由', json(n.details.branches));
    fold(details, '因果 / 条件关系（独立判断）', json(view.relations.filter(r => r.to === id || [r.from].flat().includes(id))));
    fold(details, '证据缺口', json(inv.gaps.filter(g => n.details.gaps.includes(g.id))));
  }
  $('#question').textContent = view.root.question ?? '调查问题未记录';
  $('#scope').textContent = view.root.scope ?? '';
  $('#state').textContent = labels[view.root.state] ?? view.root.state;
  $('#counts').textContent = `${view.nodes.length} 个假设 · ${view.edges.length} 条追问边 · ${inv.checks.length} 次检查 · ${inv.observations.length} 条观察`;
  const initial = inv.checkpoints[0];
  $('#findings').append(el('h2', '初始发现'));
  if (!initial?.findings.length) $('#findings').append(el('p', '未单独记录初始发现；定位过程见调查步骤。', 'meta'));
  for (const f of initial?.findings ?? []) {
    const d = fold($('#findings'), f.summary, el('div'));
    for (const o of f.evidence ?? []) showObservation(d, o);
  }
  const board = $('#board'), cards = new Map();
  for (const row of data.layers) {
    const line = el('div', null, 'level'); board.append(line);
    for (const id of row) {
      const n = nodeMap.get(id), state = n?.state ?? 'question';
      const b = el('button', null, `card ${state}`); b.dataset.id = id;
      b.append(el('span', id === 'question' ? '调查问题' : `${id} · ${labels[state] ?? state}`, 'badge'));
      b.append(el('strong', n?.claim ?? view.root.question ?? '未记录调查问题'));
      if (n) {
        b.append(el('span', n.decision_summary ?? '尚未记录判定', 'decision'));
        b.append(el('small', `${n.key_evidence.length} 个证据入口${n.reference_check === 'incomplete' ? ' · 引用缺口' : ''}${view.unplaced.includes(id) ? ' · 未关联' : ''}`));
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
  new ResizeObserver(drawEdges).observe(board);
  requestAnimationFrame(drawEdges);
  for (const r of view.relations) {
    const d = fold($('#relations'), `${r.id} · ${r.type} · ${[r.from].flat().join(' + ')} → ${r.to} · ${labels[r.state] ?? r.state}`, json(r));
    for (const id of new Set((r.history ?? []).flatMap(h => h.evidence ?? []))) showObservation(d, id);
  }
  if (!view.relations.length) $('#relations').append(el('p', '没有单独记录因果或条件关系。', 'meta'));
  const conclusion = $('#conclusion');
  if (view.root.state === 'active') {
    conclusion.append(el('h2', '当前阶段'), el('p', '调查尚未结束，或结束后已有新记录。'));
    if (view.conclusion) fold(conclusion, '此前结束记录（不代表当前结论）', json(view.conclusion));
  } else if (view.conclusion) {
    conclusion.append(el('h2', '调查结论'), el('p', view.conclusion.conclusion), el('p', view.conclusion.reason, 'meta'));
    const links = el('div', null, 'answer-links');
    for (const id of view.conclusion.answer_hypotheses ?? []) {
      const b = el('button', id); b.onclick = () => select(id); links.append(b);
    }
    conclusion.append(links); fold(conclusion, '结论依据、未解部分与结束记录', json(view.conclusion));
  }
  for (const s of inv.views.investigation_steps) {
    const d = fold($('#steps'), `${s.id} · ${s.event} · ${s.detail?.purpose ?? s.detail?.summary ?? s.detail?.reason ?? s.detail?.claim ?? ''}`, json(s));
    if (s.event === 'evidence') showObservation(d, s.detail.id);
  }
  $('#diagnostics').textContent = `记录检查 · ${inv.diagnostics.length} 项缺口`;
  $('#diagnostic-body').append(json(inv.diagnostics));
  for (const b of document.querySelectorAll('[data-tab]')) b.onclick = () => {
    const graph = b.dataset.tab === 'graph'; $('#graph-panel').hidden = !graph; $('#steps').hidden = graph;
    document.querySelectorAll('[data-tab]').forEach(t => { t.classList.toggle('active', t === b); t.setAttribute('aria-pressed', String(t === b)); });
    if (graph) requestAnimationFrame(drawEdges);
  };
  select('question');
}

export function renderInvestigationHtml(investigation, spans, source = {}) {
  const data = { ...reportData(investigation, spans, source), layers: graphLayers(investigation.views.hypothesis_view) };
  const serialized = JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>dbdog · 调查假设图</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f7f8fc;color:#24263b;font:14px/1.6 system-ui,-apple-system,sans-serif}header{background:#fff;border-bottom:1px solid #e3e5ef;padding:25px 32px}h1{font-size:23px;margin:8px 0}h2{font-size:16px;margin:0 0 12px}h3{font-size:14px}p{margin:8px 0}.brand{color:#6952ad;letter-spacing:2px;font-size:12px;font-weight:750}.meta,small{color:#626a80;font-size:12px}#state{float:right;color:#087e70;background:#e1f6f0;padding:4px 12px;border-radius:20px}nav{display:flex;gap:8px;margin:20px 28px}button{font:inherit;cursor:pointer;background:white;border:1px solid #d8dbe8;border-radius:7px;padding:8px 16px;color:inherit}button.active{background:#ece7fc;color:#61449e;border-color:#ac95df}button:focus-visible,summary:focus-visible{outline:3px solid #9b79dc;outline-offset:2px}main{padding:0 28px 28px}.workspace{display:grid;grid-template-columns:minmax(0,1fr) 350px;gap:20px}.pane,#detail,#steps{border:1px solid #deddea;border-radius:10px;background:white;padding:20px}#detail{position:sticky;top:15px;align-self:start;max-height:88vh;overflow:auto}.legend{display:flex;gap:18px;flex-wrap:wrap;font-size:12px;margin:16px 0;color:#5e6376}.legend span:before{content:'●';margin-right:5px}.green{color:#087f6c}.purple{color:#7761b2}.gray{color:#747b88}.amber{color:#986d14}#viewport{overflow:auto;border:1px solid #e6e2f3;border-radius:8px;background:#fcfbff}#board{position:relative;min-width:100%;width:max-content;padding:32px 24px}.level{position:relative;display:flex;justify-content:center;align-items:flex-start;gap:28px;margin-bottom:72px}.level:last-child{margin-bottom:0}.card{position:relative;z-index:1;width:255px;display:flex;flex-direction:column;gap:9px;text-align:left;padding:15px;background:white;border:1px solid #a994dc;box-shadow:0 3px 10px #30205608}.card strong{font-size:13px;line-height:1.6}.badge{font-size:11px;color:#7758aa}.decision{font-size:12px;color:#5d657b;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.card.supported{border-color:#14b99e}.supported .badge{color:#087f6c}.card.refuted{background:#f4f5f8;border-color:#bcc1cd}.refuted .badge{color:#626977}.card.inconclusive{border-color:#c59a42}.inconclusive .badge{color:#926912}.card.selected{box-shadow:0 0 0 3px #b7eadf}.card.question{width:340px;border-color:#cdc9dd}.card.question strong{font-size:14px}#edges{position:absolute;top:0;left:0;pointer-events:none;overflow:visible}#edges path{fill:none;stroke:#a894d1;stroke-width:1.7;stroke-dasharray:4 3}#edges .supported{stroke:#22bca2;stroke-dasharray:none}#edges .refuted{stroke:#c8cbd5}#edges .inconclusive{stroke:#c29a4b}#conclusion{margin-top:22px;border-left:3px solid #1bb59c;background:#effaf7;padding:18px}#relations{margin-top:20px}details{margin:10px 0;border:1px solid #e2e4ed;border-radius:6px;padding:9px 12px}summary{cursor:pointer;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 ui-monospace,monospace;background:#f5f6fa;padding:12px;border-radius:5px;max-height:450px;overflow:auto}.evidence{border-top:1px solid #e4e7ef;margin-top:16px}.warning{color:#a06612}.answer-links{display:flex;gap:8px}footer{padding:0 28px 25px;color:#697087;font-size:12px}[hidden]{display:none!important}@media(max-width:1000px){.workspace{grid-template-columns:1fr}#detail{position:static;max-height:none}main{padding:0 14px 20px}header{padding:20px}nav{margin:16px}}
</style><header><span class="brand">DBDOG / INVESTIGATION</span><span id="state"></span><h1 id="question"></h1><p id="scope" class="meta"></p><p id="counts" class="meta"></p></header>
<nav aria-label="调查视图"><button data-tab="graph" class="active" aria-pressed="true">假设图</button><button data-tab="steps" aria-pressed="false">调查步骤</button></nav>
<main><div id="graph-panel" class="workspace"><section class="pane"><section id="findings"></section><div class="legend"><span class="green">得到支持</span><span class="purple">待检验</span><span class="gray">已反驳</span><span class="amber">证据不足</span></div><p class="meta">向下连线表示继续追问，颜色取自子假设状态；不表示因果关系已经成立。点击节点查看证据。</p><div id="viewport"><div id="board"><svg id="edges" aria-hidden="true"></svg></div></div><section id="relations"><h2>因果与条件关系</h2></section><section id="conclusion"></section></section><aside id="detail" aria-label="节点详情"></aside></div><section id="steps" hidden aria-label="调查步骤"></section><details><summary id="diagnostics"></summary><div id="diagnostic-body"></div></details></main><footer>状态来自明确调查记录；结构完整、引用匹配和专业归因正确是不同判断。此离线文件包含所引用的原始取证内容。</footer>
<script type="application/json" id="report-data">${serialized}</script><script>(${mountReport.toString()})();</script></html>\n`;
}
