import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './stop-gate-runner.mjs';
import { addCheck } from './auto-progress.mjs';

delete process.env.CLAUDE_HEADLESS;
const open = '**[本セッションの目的]** 進捗確認を修正する\n次に kim がすること: なし\nこの後の自動進行: 残っている作業を進め結果を報告します\nこのセッション: まだ閉じない（作業中・2099-12-31 23:59 まで待つ）';
for (const kind of ['success', 'failure', 'missing-footer', 'ordinary']) test(`上限到達: ${kind}`, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-wait-check-'));
  const prior = process.env.ORGIAST_HOME;
  process.env.ORGIAST_HOME = home;
  t.after(() => {
    if (prior === undefined) delete process.env.ORGIAST_HOME; else process.env.ORGIAST_HOME = prior;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const calls = [];
  const options = { mode: 'off', policyOptions: { home, hostname: 'kim-PC', notify: async () => ({ delivered: 'test' }) },
    addCheck: args => { calls.push(args); if (kind === 'failure') throw new Error('disk full'); return addCheck(args); } };
  const text = kind === 'ordinary' ? 'https://github.com/org/repo を開いてください。' : kind === 'missing-footer' ? '開始しました。' : open;
  const humanText = '依頼'.repeat(40);
  const context = { assistantText: text, humanText, lastUserPrompt: humanText, raw: kind === 'missing-footer'
    ? JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { run_in_background: true } }] } }) : '' };
  let result;
  for (let attempt = 0; attempt < 3; attempt++) {
    result = await run({ session_id: 'wait-test', assistant_text: text }, context, options);
    if (attempt < 2) assert.equal(result.decision, 'block');
  }
  const records = fs.readFileSync(path.join(home, '.claude/stop-gate-runner-ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  if (kind === 'ordinary') {
    assert.equal(calls.length, 0);
    assert.equal(records.at(-1).verdict, 'pass_after_cap');
    assert.ok(result.record.reasonCodes.includes('URL-ACCOUNT'));
  } else {
    assert.equal(calls.length, 1);
    assert.equal(calls[0].session, 'wait-test');
    assert.match(calls[0].check, /session-progress-check\.mjs" --session "wait-test"$/);
    assert.equal(calls[0].label, `自動登録: ${kind === 'missing-footer' ? humanText.slice(0, 60) : '進捗確認を修正する'}`);
    assert.equal(calls[0].deadline, kind === 'missing-footer' ? '+24h' : new Date(2099, 11, 31, 23, 59).toISOString());
    assert.equal(records.at(-1).verdict, kind === 'failure' ? 'block' : 'pass_after_autoregister');
    if (kind === 'failure') {
      assert.equal(result.decision, 'block');
      assert.match(result.reason, /disk full/);
      const again = await run({ session_id: 'wait-test', assistant_text: text }, context, options);
      assert.equal(again.decision, 'block');
    } else {
      assert.equal(result.decision, undefined);
      const ledger = fs.readFileSync(path.join(home, '.claude/auto-progress-ledger.jsonl'), 'utf8');
      assert.match(ledger, /session-progress-check/);
    }
  }
});
