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

const cc002 = JSON.parse(fs.readFileSync(new URL('./course-corrections.json', import.meta.url), 'utf8')).find(r => r.id === 'CC-002');
const transcript = (...rows) => rows.map(row => JSON.stringify(row)).join('\n');
const use = (name, input = {}) => ({type:'assistant', message:{role:'assistant', content:[{type:'tool_use', id:'check', name, input}]}});
test('CC-002 blocks unchecked URL without evidence tools', t => {
  const result = evaluateCourseCorrections({assistantText:'こちら https://example.com/billing', transcriptRaw:transcript(use('Read', {file_path:'billing.md'}))}, {...opts(t), rules:[cc002]});
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /CC-002/);
});
test('CC-002 accepts evidence tool names and shell commands in this turn', t => {
  for (const event of [use('WebFetch'), use('Bash',{command:'curl -I https://example.com'}), use('Bash',{command:'gh api repos/owner/repo'}), use('mcp__playwright__browser_navigate'), use('mcp__claude_ai_browser')]) {
    assert.equal(evaluateCourseCorrections({assistantText:'https://example.com',transcriptRaw:transcript(event)}, {...opts(t),rules:[cc002]}).decision,'pass');
  }
});
test('CC-002 accepts PR URL returned by gh pr create', t => {
  const url = 'https://github.com/owner/repo/pull/123';
  const raw = transcript(use('Bash',{command:'gh pr create --title fix --body fix'}), {type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:'check',content:url}]}});
  assert.equal(evaluateCourseCorrections({assistantText:`PR: ${url}`,transcriptRaw:raw},{...opts(t),rules:[cc002]}).decision,'pass');
});
test('CC-002 excludes local and artifact URLs but still detects other URLs', t => {
  for (const url of ['http://localhost:3000/path','https://claude.ai/artifact/abc','https://github.com/owner/repo/pull/123']) {
    const options = {...opts(t),rules:[cc002]};
    assert.equal(evaluateCourseCorrections({assistantText:url},options).decision,'pass');
    assert.equal(evaluateCourseCorrections({assistantText:`${url}\nhttps://example.com`},options).decision,'block');
  }
  for (const url of ['https://localhost.evil.com','https://claude.ai/artifacts','https://github.com/owner/repo/pull/123/unknown']) {
    assert.equal(evaluateCourseCorrections({assistantText:url},{...opts(t),rules:[cc002]}).decision,'block');
  }
});
test('CC-002 ignores fenced and quoted URLs', t => {
  assert.equal(evaluateCourseCorrections({assistantText:'> https://example.com\n```text\nhttps://example.com\n```\n~~~\nhttps://example.com\n~~~'},{...opts(t),rules:[cc002]}).decision,'pass');
});
test('CC-002 cannot use previous-turn tools or tool-result text as evidence tools', t => {
  const nextUser = {type:'user',message:{role:'user',content:'次の依頼'}};
  for (const raw of [transcript(use('WebFetch'),nextUser),transcript({type:'user',message:{role:'user',content:[{type:'tool_result',content:'WebFetch curl gh api playwright'}]}})]) {
    assert.equal(evaluateCourseCorrections({assistantText:'https://example.com',transcriptRaw:raw},{...opts(t),rules:[cc002]}).decision,'block');
  }
});
