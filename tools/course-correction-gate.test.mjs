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
function assertWarn(ctx, options) {
  assert.equal(evaluateCourseCorrections(ctx, options).decision, 'pass');
  const ledger = fs.readFileSync(path.join(options.home, '.claude/course-corrections-ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(ledger.at(-1).id, 'CC-002');
  assert.equal(ledger.at(-1).verdict, 'warn');
}
function assertNoWarning(ctx, options) {
  assert.equal(evaluateCourseCorrections(ctx, options).decision, 'pass');
  assert.equal(fs.existsSync(path.join(options.home, '.claude/course-corrections-ledger.jsonl')), false);
}
test('CC-002 warns without blocking unchecked URLs', t => {
  assertWarn({assistantText:'こちら https://example.com/billing', transcriptRaw:transcript(use('Read', {file_path:'billing.md'}))}, {...opts(t), rules:[cc002]});
});
test('CC-002 evidence tools suppress warnings in this turn', t => {
  for (const event of [use('WebFetch'), use('Bash',{command:'curl -I https://example.com'}), use('Bash',{command:'gh api repos/owner/repo'}), use('Bash',{command:'gh pr view'}), use('Bash',{command:'gh run view'}), use('Bash',{command:'vercel inspect'}), use('Bash',{command:'clasp open'}), use('mcp__playwright__browser_navigate'), use('mcp__claude_ai_browser'), use('mcp__drive__get'), use('Artifact')]) {
    assertNoWarning({assistantText:'https://example.com',transcriptRaw:transcript(event)}, {...opts(t),rules:[cc002]});
  }
});
test('CC-002 excludes local, artifact, PR and Workspace URLs independently', t => {
  for (const url of ['http://localhost:3000/path','https://claude.ai/artifact/abc','https://github.com/owner/repo/pull/123','https://docs.google.com/a/orgiast.jp/document/d/123','https://script.google.com/a/orgiast.jp/home','https://drive.google.com/drive/u/0?authuser=user@example.com','https://drive.google.com/file/d/123?usp=sharing&authuser=0']) {
    assertNoWarning({assistantText:url},{...opts(t),rules:[cc002]});
    assertWarn({assistantText:`${url}\nhttps://example.com`},{...opts(t),rules:[cc002]});
  }
  for (const url of ['https://localhost.evil.com','https://claude.ai/artifacts','https://github.com/owner/repo/pull/123/unknown','https://docs.google.com/a/orgiast.jp.evil/document/d/123','https://drive.google.com/file/d/123']) {
    assertWarn({assistantText:url},{...opts(t),rules:[cc002]});
  }
});
test('CC-002 ignores fenced and quoted URLs without warnings', t => {
  assertNoWarning({assistantText:'> https://example.com\n```text\nhttps://example.com\n```\n~~~\nhttps://example.com\n~~~'},{...opts(t),rules:[cc002]});
});
test('CC-002 cannot use previous-turn tools or tool-result text as evidence tools', t => {
  const nextUser = {type:'user',message:{role:'user',content:'次の依頼'}};
  for (const raw of [transcript(use('WebFetch'),nextUser),transcript({type:'user',message:{role:'user',content:[{type:'tool_result',content:'WebFetch curl gh api playwright'}]}})]) {
    assertWarn({assistantText:'https://example.com',transcriptRaw:raw},{...opts(t),rules:[cc002]});
  }
});
test('CC-002 promotion metadata and unknown fields are ignored', t => {
  assert.equal(cc002.promoteTo, 'block');
  assert.equal(cc002.promoteAfter, '2026-10-15');
  assertWarn({assistantText:'https://example.com'},{...opts(t),rules:[{...cc002, unknownMetadata:{future:true}}]});
});
