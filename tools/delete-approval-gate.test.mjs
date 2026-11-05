import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { judge } from './delete-approval-gate.mjs';

function createFixture() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delete-gate-test-'));
  const transcriptPath = path.join(tmpDir, 'transcript.jsonl');

  return {
    tmpDir,
    transcriptPath,
    writeTranscript(entries) {
      const content = entries.map(e => JSON.stringify(e)).join('\n');
      fs.writeFileSync(transcriptPath, content, 'utf8');
    },
    cleanup() {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  };
}

test('delete-approval-gate: non-delete commands pass', () => {
  const res = judge({ tool_name: 'Bash', tool_input: { command: 'ls -la' } });
  assert.equal(res.decision, 'pass');
});

test('delete-approval-gate: deleting node_modules passes', () => {
  const res = judge({ tool_name: 'Bash', tool_input: { command: 'rm -rf node_modules' } });
  assert.equal(res.decision, 'pass');
});

test('delete-approval-gate: deleting temp files passes', () => {
  const tmpFile = path.join(os.tmpdir(), 'test-scratch.txt');
  const res = judge({ tool_name: 'Bash', tool_input: { command: `rm ${tmpFile}` } });
  assert.equal(res.decision, 'pass');
});

test('delete-approval-gate: git worktree remove passes', () => {
  const res = judge({ tool_name: 'Bash', tool_input: { command: 'git worktree remove .wt/my-wt' } });
  assert.equal(res.decision, 'pass');
});

test('delete-approval-gate: blocks deletion when target not listed in assistant message', () => {
  const fix = createFixture();
  try {
    fix.writeTranscript([
      { type: 'user', message: { role: 'user', content: '消して' } }
    ]);

    const res = judge({
      tool_name: 'Bash',
      tool_input: { command: 'rm important_file.txt' },
      transcript_path: fix.transcriptPath
    });

    assert.equal(res.decision, 'block');
    assert.match(res.reason, /削除対象を全件列挙して kim の許可/);
  } finally {
    fix.cleanup();
  }
});

test('delete-approval-gate: blocks deletion when listed but user approval missing', () => {
  const fix = createFixture();
  try {
    fix.writeTranscript([
      { type: 'assistant', message: { role: 'assistant', content: '削除対象: important_file.txt' } },
      { type: 'user', message: { role: 'user', content: 'ちょっと待って' } }
    ]);

    const res = judge({
      tool_name: 'Bash',
      tool_input: { command: 'rm important_file.txt' },
      transcript_path: fix.transcriptPath
    });

    assert.equal(res.decision, 'block');
  } finally {
    fix.cleanup();
  }
});

test('delete-approval-gate: passes deletion when listed and user approves', () => {
  const fix = createFixture();
  try {
    fix.writeTranscript([
      { type: 'assistant', message: { role: 'assistant', content: '削除対象: important_file.txt' } },
      { type: 'user', message: { role: 'user', content: '削除してよいです。' } }
    ]);

    const res = judge({
      tool_name: 'Bash',
      tool_input: { command: 'rm important_file.txt' },
      transcript_path: fix.transcriptPath
    });

    assert.equal(res.decision, 'pass');
  } finally {
    fix.cleanup();
  }
});

const consent = text => [{type:'assistant',content:text},{type:'user',content:'削除してよいです。'}];
const deletion = (command, transcript = []) => judge({tool_name:'Bash',tool_input:{command},transcript});
test('all exact paths must be listed, not one target or a basename', () => {
  assert.equal(deletion('rm a.txt b.txt',consent('削除対象: a.txt')).decision,'block');
  assert.equal(deletion('rm a.txt b.txt',consent('削除対象: a.txt b.txt')).decision,'pass');
  assert.equal(deletion('rm secret/a.txt',consent('削除対象: a.txt')).decision,'block');
  assert.equal(deletion('rm a.txt',consent('削除対象: other-a.txt')).decision,'block');
});
test('compound commands, PowerShell and git rm are covered', () => {
  for (const cmd of ['git worktree remove .wt/x; rm important.txt','echo hi\nrm important.txt','git rm important.txt','Remove-Item -LiteralPath "important file.txt" -Force','/usr/bin/rm important.txt']) assert.equal(deletion(cmd).decision,'block',cmd);
});
test('unsafe wildcard/dynamic targets cannot be authorized by a literal pattern', () => {
  for (const cmd of ['rm *.txt','rm "$TARGET"']) assert.equal(deletion(cmd,consent(cmd)).decision,'block');
});
test('scratch exemptions cannot be obtained with traversal or arbitrary claude/tmp names', () => {
  for (const cmd of ['rm node_modules/../important.txt','rm project/claude/important.txt','rm project/tmp/important.txt']) assert.equal(deletion(cmd).decision,'block',cmd);
});
test('Drive, Gmail, Canva and Docs IDs are protected, including absent IDs', () => {
  for (const tool_name of ['mcp__claude_ai_Google_Drive__trash_file','mcp__claude_ai_Gmail__delete_draft','mcp__claude_ai_Canva__delete_design','mcp__claude_ai_Google_Docs__delete_document']) {
    assert.equal(judge({tool_name,tool_input:{id:'item123'},transcript:consent('削除対象: item123')}).decision,'pass');
    assert.equal(judge({tool_name,tool_input:{id:'item123'},transcript:consent('別の対象')}).decision,'block');
    assert.equal(judge({tool_name,tool_input:{},transcript:[]}).decision,'block');
  }
});
test('only successful NEW Write in this human turn is exempt; Edit/overwrites/errors are not', () => {
  const use = name => ({type:'assistant',content:[{type:'tool_use',name,id:'write1',input:{file_path:'new.txt'}}]});
  const result = (content,is_error=false) => ({type:'user',content:[{type:'tool_result',tool_use_id:'write1',content,is_error}]});
  const start = {type:'user',content:'作業して'};
  assert.equal(deletion('rm new.txt',[start,use('Write'),result('File created successfully')]).decision,'pass');
  for (const rows of [[start,use('Edit'),result('File created successfully')],[start,use('Write'),result('File updated')],[start,use('Write'),result('File created successfully',true)],[use('Write'),result('File created successfully'),start]]) assert.equal(deletion('rm new.txt',rows).decision,'block');
});

import { execFileSync } from 'node:child_process';
import { deleteTargets } from './delete-approval-gate.mjs';
test('git clean resolves actual candidates with a dry run and never deletes during judging', t => {
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'delete-clean-'));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
  execFileSync('git',['init','-q',cwd],{windowsHide:true});fs.writeFileSync(path.join(cwd,'a.txt'),'keep');
  assert.deepEqual(deleteTargets('git clean -fd',cwd).map(t=>t.target),['a.txt']);
  assert.equal(fs.readFileSync(path.join(cwd,'a.txt'),'utf8'),'keep');
  assert.deepEqual(deleteTargets('git clean -n',cwd),[]);
});
test('shell wrappers and OS temp variable paths are recognized',()=>{
  assert.equal(deletion('powershell -Command "Remove-Item important.txt"').decision,'block');
  assert.equal(deletion('bash -c "rm important.txt"').decision,'block');
  assert.equal(deletion('Remove-Item "$env:TEMP/claude/scratch.txt"').decision,'pass');
});
