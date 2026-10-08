import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateCourseCorrections } from './course-correction-gate.mjs';
function opts(t){const home=fs.mkdtempSync(path.join(os.tmpdir(),'cc-gate-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));return {home};}
const rule={id:'CC-099',rule:'追加規則',detectText:['禁止文'],detectEvidence:['証拠'],severity:'block',gate:'example',fix:'修復コマンド'};
const raw=JSON.stringify({type:'user',message:{role:'user',content:[{type:'tool_result',content:'証拠'}]}});
test('matching text blocks with rule and repair',t=>{const options={...opts(t),rules:[rule]};assert.equal(evaluateCourseCorrections({assistantText:'禁止文',transcriptRaw:''},options).decision,'block');const r=evaluateCourseCorrections({assistantText:'禁止文',transcriptRaw:raw},options);assert.equal(r.decision,'block');assert.match(r.reason,/CC-099.*追加規則.*修復コマンド/);});
test('warn records ledger without blocking',t=>{const options={...opts(t),rules:[{...rule,severity:'warn',detectEvidence:[]}]};assert.equal(evaluateCourseCorrections({assistantText:'禁止文'},options).decision,'pass');assert.match(fs.readFileSync(path.join(options.home,'.claude/course-corrections-ledger.jsonl'),'utf8'),/"verdict":"warn"/);});
test('quoted context and code fences do not trigger text rule',t=>{const options={...opts(t),rules:[{...rule,detectEvidence:[]}]};assert.equal(evaluateCourseCorrections({assistantText:'> 禁止文\n```\n禁止文\n```'},options).decision,'pass');});

test('evidence alone passes and records warn even for block severity', t => {
  const options = {...opts(t), rules:[rule]};
  assert.equal(evaluateCourseCorrections({assistantText:'通常文',transcriptRaw:raw},options).decision,'pass');
  const ledger = JSON.parse(fs.readFileSync(path.join(options.home,'.claude/course-corrections-ledger.jsonl'),'utf8'));
  assert.equal(ledger.verdict,'warn');
});
test('lane text with LANE-FALLBACK and reason passes', t => {
  const options = {...opts(t), rules:[{...rule,gate:'lane-abandonment-gate'}]};
  assert.equal(evaluateCourseCorrections({assistantText:'禁止文 [LANE-FALLBACK] 全レーン停止を確認',transcriptRaw:raw},options).decision,'pass');
});
