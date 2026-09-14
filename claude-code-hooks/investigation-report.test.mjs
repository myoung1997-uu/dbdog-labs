// 自研事件协议的确定性展示测试。demo 是人工记录，不能证明真实诊断或客户端覆盖。
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { build, writeGraph } from './hypothesis-graph.mjs';
import { graphLayers, renderInvestigationHtml, reportData } from './investigation-report.mjs';
import { demoSpans } from './examples/investigation-demo.mjs';

const payload = html => JSON.parse(html.match(/<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/)[1]);
describe('可独立回放的调查图', () => {
  it('同一数据同时交付步骤、共享父边、因果关系、状态和原始结果', () => {
    const spans = demoSpans(), inv = build(spans).investigation;
    expect(inv.diagnostics).toEqual([]);
    const d = payload(renderInvestigationHtml(inv, spans));
    expect(d.investigation).toEqual(inv);
    expect(d.layers.flat()).toEqual(expect.arrayContaining(['question','H1','H2','H3','H4','H5','H6','H7']));
    expect(d.layers.flat().filter(id => id === 'H4')).toHaveLength(1);
    expect(d.investigation.views.hypothesis_view.nodes.find(n => n.id === 'H4').parents).toEqual(['H1','H2']);
    expect(d.investigation.relations[0]).toMatchObject({ id: 'R1', state: 'supported' });
    expect(d.raw[0].output).toBe(spans[1].output);
    expect(d.investigation.gaps[0].hypotheses).toEqual(['H7']);
    expect(d.investigation.views.hypothesis_view.nodes.map(n => n.state)).toContain('refuted');
    expect(d.investigation.views.hypothesis_view.conclusion.answer_hypotheses).toContain('H5');
  });
  it('记录中的 HTML / script 字符不执行，嵌入的原文可以无损恢复', () => {
    const spans = demoSpans(), attack = '</script><script>globalThis.pwned=1</script>\u2028';
    spans[1].output_local = attack + spans[1].output;
    const inv = build(spans).investigation;
    inv.hypotheses[0].claim = attack;
    const html = renderInvestigationHtml(inv, spans, { file: attack });
    expect(html).not.toContain(attack);
    expect(payload(html).raw[0].output).toBe(spans[1].output_local);
    expect(payload(html).source.file).toBe(attack);
    const scripts = [...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)];
    expect(scripts).toHaveLength(2);
    expect(() => new vm.Script(scripts[1][1])).not.toThrow();
  });
  it('未关联节点保持可见，环不能被布局器悄悄改成树', () => {
    const view = { nodes: [{id:'H1'},{id:'H2'}], edges: [] };
    expect(graphLayers(view)).toEqual([['question'],['H1','H2']]);
    expect(view.edges).toEqual([]);
    expect(() => graphLayers({...view, edges:[{from:'H1',to:'H2'},{from:'H2',to:'H1'}]})).toThrow('环');
  });
  it('CLI 实际生成三个可消费文件；多 trace、缺参和未知参数均失败', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbdog-report-'));
    try {
      const src = path.join(dir, 'spans.jsonl');
      const spans = demoSpans();
      fs.writeFileSync(src, spans.map(s => JSON.stringify(s)).join('\n'));
      const cli = (...args) => spawnSync(process.execPath, [path.join(import.meta.dirname,'graph.mjs'),src,...args], {encoding:'utf8'});
      const run = cli('--out', path.join(dir,'out'));
      expect(run.status, run.stderr).toBe(0);
      const result = JSON.parse(run.stdout);
      expect(result.investigation_summary.investigation_parent_edges).toBe(8);
      const embedded = payload(fs.readFileSync(result.html,'utf8'));
      expect(JSON.parse(fs.readFileSync(result.hypothesis_view,'utf8'))).toEqual(embedded.investigation.views.hypothesis_view);
      expect(JSON.parse(fs.readFileSync(result.investigation_steps,'utf8'))).toEqual(embedded.investigation.views.investigation_steps);
      expect(cli('--trace').status).not.toBe(0);
      expect(cli('--unknown').status).not.toBe(0);
      fs.appendFileSync(src,'\n'+JSON.stringify({...spans[0],span_id:'other',trace_id:'other'}));
      expect(cli().stderr).toContain('多个 trace');
      expect(cli('--trace','demo-lock-investigation').status).toBe(0);
      writeGraph([{span_id:'legacy',trace_id:'legacy',kind:'tool',output:'no records'}],path.join(dir,'out'));
      expect(fs.existsSync(result.html)).toBe(false); // 不留下上次运行的旧图。
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  });
  it('只将明确引用的原始 span 带入 HTML，完整数据仍留在输入记录', () => {
    const spans = demoSpans();
    spans.push({span_id:'unrelated',trace_id:spans[0].trace_id,kind:'tool',output:'unrelated noise'});
    expect(reportData(build(spans).investigation,spans).raw.map(s => s.ref)).toEqual(['E:sample','E:lifecycle','E:retention']);
  });
});
