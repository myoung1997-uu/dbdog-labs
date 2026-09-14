import { describe, it, expect } from 'vitest';
import { buildInvestigation } from './investigation-events.mjs';
import { REPORT_HEADINGS, reportText, missingReportSections, deliveryFeedback, investigationIssues } from './investigation-delivery.mjs';
import { postSpans } from '../skills/diag-flywheel/scripts/llmobs/lib/exp-client.mjs';
const msg = (events, id='m') => ({kind:'llm',span_id:id,trace_id:'t',ts:id==='m'?2:3,output:'```dbdog-investigation\n'+JSON.stringify(events)+'\n```'});
const report = REPORT_HEADINGS.map(h=>'## '+h+'\nActual scoped content.').join('\n\n');
const cp={event:'checkpoint',id:'cp',question:'Why slow?',scope:'X window W',findings:[],unresolved:[],next:{action:'test',reason:'resolve'}};
const branch={event:'branch',id:'b',hypothesis:'H1',parents:['question'],reason:'Explain the slowdown'};
const h={event:'hypothesis',id:'h',hypothesis:'H1',claim:'Execution A waits on B in W'};
const obs={event:'evidence',id:'o',observation:'O1',summary:'A waits on B',sources:[{ref:'E:t1',quote:'A waits on B'}],links:[{hypothesis:'H1',effect:'supports',aspect:'activation',reason:'waiter/blocker observed'}]};
const update={event:'update',id:'u',hypothesis:'H1',state:'supported',evidence:['O1'],reason:'Observed scoped blocking'};
const finish={event:'finish',id:'f',outcome:'answered',reason:'Answers the narrow question',conclusion:'A waited on B',evidence:['O1'],answer_hypotheses:['H1'],answer_relations:[],unresolved:[]};
const tool={kind:'tool',trace_id:'t',span_id:'t1',ts:1,name:'Read',output:'A waits on B'};
describe('real failures reduced to minimal non-private records',()=>{
 it('fallback uploads full fields instead of 8000-character previews',async()=>{
  const full=msg([cp,h,branch]).output+'x'.repeat(10000)+report, batches=[];
  await postSpans([{span_id:'s',output:full.slice(0,8000),output_local:full,thinking:'cut',thinking_local:'full thinking'}],{sink:{kind:'edge',url:'https://example.invalid',key:'test'},fetchImpl:async(u,o)=>{batches.push(JSON.parse(o.body));return {ok:true}}});
  expect(batches[0].spans[0].output).toBe(full);expect(batches[0].spans[0].thinking).toBe('full thinking');expect(batches[0].spans[0]).not.toHaveProperty('output_local');
 });
 it('record blocks never substitute for a report',()=>{
  expect(reportText(msg([cp]).output+'\n'+report)).toBe(report);
  expect(reportText(report+'\n'+msg([cp]).output)).toBe(report);
  expect(reportText('```dbdog-investigation\n[{"id":')).toBe('');
  expect(missingReportSections('## What happened\n\n## Why that broke things\n')).toHaveLength(5);
  expect(missingReportSections(report)).toEqual([]);
 });
 it('flags missing hypotheses without synthesizing claims from branch reasons',()=>{
  const inv=buildInvestigation([msg([cp,branch,update,finish])]);
  expect(inv.hypotheses).toEqual([]);expect(investigationIssues(inv).join('\n')).toContain('H1: branch exists');
  expect(deliveryFeedback([msg([cp,branch,update,finish])],report).output.decision).toBe('block');
 });
 it('retains rejected evidence and provides actionable field feedback',()=>{
  const broken={...obs};delete broken.sources;
  const inv=buildInvestigation([msg([cp,h,branch,broken,update,finish])]);
  expect(inv.diagnostics.find(d=>d.code==='invalid_event')).toMatchObject({rejected:broken,problem:expect.stringContaining('evidence.sources')});
  expect(deliveryFeedback([msg([cp,h,branch,broken,update,finish])],report).output.reason).toContain('missing observation O1');
 });
 it('allows repair while retaining invalid history',()=>{
  const broken={...obs};delete broken.sources;
  const spans=[tool,msg([cp,h,branch,broken,update,finish]),msg([obs,{...update,id:'u2'},{...finish,id:'f2'}],'m2')];
  const result=deliveryFeedback(spans,report);
  expect(result.state.issues).toEqual([]);expect(result.output).toBeNull();
  expect(buildInvestigation(spans).diagnostics.length).toBeGreaterThan(0);
 });
 it('accepts complete delivery, preserves non-investigation behavior',()=>{
  expect(deliveryFeedback([tool,msg([cp,h,branch,obs,update,finish])],report).state.status).toBe('complete');
  expect(deliveryFeedback([{kind:'llm',span_id:'m',trace_id:'t',output:'Hello'}],'Hello').output).toBeNull();
 });
 it('exhaustion is explicitly incomplete and does not loop forever',()=>{
  const r=deliveryFeedback([msg([cp,branch])],report,{attempts:3});
  expect(r.state.status).toBe('incomplete');expect(r.output.decision).toBeUndefined();expect(r.output.systemMessage).toContain('INCOMPLETE');
 });
});

describe('actual Stop hook repair boundary',()=>{
 it('feeds omissions to the model, persists incomplete tag, then accepts a repaired delivery',async()=>{
  const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path'),cpmod=await import('node:child_process');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dbdog-delivery-test-'));
  const transcript=path.join(dir,'transcript.jsonl'),session='test-session';
  const hook=new URL('./stop.mjs',import.meta.url);
  const env={...process.env,DBDOG_OBS_DIR:dir,DBDOG_OBS_REPORT_URL:'',DBDOG_OBS_API_KEY:'',DBDOG_SUMMARY_LLM_URL:'',ANTHROPIC_API_KEY:''};
  const writeMessage=(events,uuid)=>fs.appendFileSync(transcript,JSON.stringify({type:'assistant',uuid,timestamp:'2026-09-14T00:00:01Z',message:{id:uuid,usage:{},content:[{type:'text',text:msg(events).output}]}})+'\n');
  try {
   fs.writeFileSync(path.join(dir,session+'.json'),JSON.stringify({active:true,trace_id:'t',root_span_id:'root',session_id:session,started_at:'2026-09-14T00:00:00Z',cursor:0,transcript_path:transcript}));
   writeMessage([cp,branch],'a');
   const run=()=>JSON.parse(cpmod.execFileSync(process.execPath,[hook.pathname],{env,input:JSON.stringify({session_id:session,hook_event_name:'Stop',transcript_path:transcript,last_assistant_message:report}),encoding:'utf8'})||'null');
   expect(run().decision).toBe('block');
   expect(JSON.parse(fs.readFileSync(path.join(dir,session+'.json'))).investigation_delivery.status).toBe('incomplete');
   writeMessage([h,{event:'gap',id:'g',gap:'D1',hypotheses:['H1'],wanted:'Original linkage',attempt:'Checked supplied result references',result:'inaccessible',impact:'Linkage unavailable; limiting conclusion'}, {...update,evidence:[],state:'inconclusive'}, {...finish,evidence:[],outcome:'evidence_boundary',unresolved:[{question:'Blocking impact?',missing:'Incident samples',next_step:'Obtain incident samples'}]}],'b');
   expect(run()).toBeNull();
   const spans=fs.readFileSync(path.join(dir,'spans.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
   expect(spans.filter(s=>s.span_id==='root').at(-1).tags.investigation_delivery).toBe('complete');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
 });
});

describe('reference correction in the investigation loop',()=>{
 it('reports paraphrased quotes before Stop and explains immutable observation repair',()=>{
  const bad={...obs,sources:[{ref:'E:t1',quote:'A ... B'}]};
  const inv=buildInvestigation([tool,msg([cp,h,branch,bad])]);
  expect(investigationIssues(inv).join('\n')).toContain('NEW observation ID');
  const fixed={...obs,id:'o2',observation:'O2'};
  const spans=[tool,msg([cp,h,branch,bad,update]),msg([fixed,{...update,id:'u2',evidence:['O2']},{...finish,id:'f2',evidence:['O2']}],'m2')];
  expect(deliveryFeedback(spans,report).state.status).toBe('complete');
  expect(buildInvestigation(spans).observations).toHaveLength(2);
 });
 it('surfaces unreadable JSON immediately and does not permanently block later complete records',()=>{
  const broken={...msg([],'broken'),output:'```dbdog-investigation\n[{"event":"hypothesis" broken}]\n```'};
  expect(investigationIssues(buildInvestigation([broken])).join('\n')).toContain('none of its records were accepted');
  expect(deliveryFeedback([tool,broken,msg([cp,h,branch,obs,update,finish])],report).state.status).toBe('complete');
 });
 it('requires the actual check linked by evidence in the final judgment',()=>{
  const spans=[tool,msg([cp,h,branch,{...obs,check:'C-missing'},update,finish])];
  expect(deliveryFeedback(spans,report).output.reason).toContain('referenced check C-missing is undeclared');
 });
});

it('a missing database plan does not waive mismatched quotes on existing observations',()=>{
 const gap={event:'gap',id:'g',gap:'D1',hypotheses:['H1'],wanted:'Actual query plan',attempt:'Looked for incident plan',result:'empty',impact:'Dominant operator remains unknown'};
 const bad={...obs,sources:[{ref:'E:t1',quote:'A ... B'}]};
 const spans=[tool,msg([cp,h,branch,bad,gap,update,{...finish,outcome:'evidence_boundary'}])];
 const result=deliveryFeedback(spans,report);
 expect(result.state.status).toBe('incomplete');
 expect(result.output.reason).toContain('database evidence gap does not validate');
});
