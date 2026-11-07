import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { judgeSubstituteCapability as judge } from './substitute-capability-gate.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'substitute-'));
  fs.mkdirSync(path.join(home, '.claude'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const put = (name, value) => fs.writeFileSync(path.join(home, '.claude', name), typeof value === 'string' ? value : JSON.stringify(value));
  return { home, put };
}
const request = '画像を生成するため OpenRouter に入金してください。';
test('OpenRouter 入金依頼＋xai.env は block、例外・依頼なしは pass', t => {
  const { home, put } = fixture(t);
  put('xai.env', '');
  const result = judge(request, { home });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /同じ能力\(image\).*grok/);
  for (const text of [request + '\n[SUBSTITUTE-OK] 「OpenRouter を使って」', '次に kim がすること: なし', '> ' + request, '```text\n' + request + '\n```', '~~~text\n' + request + '\n~~~']) {
    assert.equal(judge(text, { home }).decision, 'pass', text);
  }
  assert.equal(judge(request + '\n> [SUBSTITUTE-OK] 引用', { home }).decision, 'block');
});
test('code で codex 自身しか生きていなければ代替なし', t => {
  const { home, put } = fixture(t);
  put('lane-health.json', { lanes: { codex: { alive: true } } });
  assert.equal(judge('実装のため codex にログインしてください', { home }).decision, 'pass');
  assert.equal(judge('実装のため OpenRouter に入金してください', { home }).decision, 'block');
});
test('カタログ外プロバイダ・名前の部分一致は対象外', t => {
  const { home, put } = fixture(t);
  put('xai.env', '');
  for (const name of ['UnknownProvider', 'notopenrouter']) assert.equal(judge(`画像のため ${name} に入金してください`, { home }).decision, 'pass');
});
test('cooldown の最新記録、壊れた行、lane-health の xai 別名', t => {
  const { home, put } = fixture(t);
  put('xai.env', '');
  put('provider-limit-history.jsonl', '壊れた行\n' + JSON.stringify({ provider: 'xai', until: 2000 }));
  assert.equal(judge(request, { home, now: 1000 }).decision, 'pass');
  assert.equal(judge(request, { home, now: 3000 }).decision, 'block');
  put('lane-health.json', { lanes: { xai: { alive: true } } });
  assert.equal(judge(request, { home, now: 1000 }).decision, 'block');
});
test('ホスト・キーファイル・vendor と chat/research 能力を識別', t => {
  const { home, put } = fixture(t);
  put('groq.env', '');
  put('lane-health.json', { lanes: { gemini: { alive: true } } });
  for (const name of ['openrouter.ai', 'openrouter.env', 'OpenRouter']) {
    assert.equal(judge(`${name} へのチャージをお願いします`, { home }).decision, 'block');
    assert.match(judge(`調査のため ${name} の OAuth の許可が必要です`, { home }).reason, /同じ能力\(research\).*gemini/);
  }
});
test('CLI と runner は ORGIAST_HOME と transcript を使って block', t => {
  const { home, put } = fixture(t);
  put('xai.env', '');
  const transcript = path.join(home, 'transcript.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: request } }) + '\n');
  for (const script of ['substitute-capability-gate.mjs', 'stop-gate-runner.mjs']) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url))], {
      input: JSON.stringify({ transcript_path: transcript }), encoding: 'utf8', timeout: 20000,
      env: { ...process.env, ORGIAST_HOME: home, ORGIAST_HANDOFF_AUDIT: 'off', ORGIAST_HOSTNAME: 'kim-PC' },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).decision, 'block', result.stdout);
    assert.match(JSON.parse(result.stdout).reason, /\[SUBSTITUTE\]/);
  }
});
