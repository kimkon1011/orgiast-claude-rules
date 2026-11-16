import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { audit, waitingVerdict, settingsModelProblem } from './session-model-audit.mjs';

const line = (o) => JSON.stringify(o);

function home(settings, sessions, t) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'session-audit-'));
  t.after(() => fs.rmSync(h, { recursive: true, force: true }));
  fs.mkdirSync(path.join(h, '.claude', 'projects', 'p'), { recursive: true });
  fs.writeFileSync(path.join(h, '.claude', 'settings.json'), JSON.stringify(settings));
  for (const [name, rows] of Object.entries(sessions)) fs.writeFileSync(path.join(h, '.claude', 'projects', 'p', `${name}.jsonl`), rows.map(line).join('\n'));
  return h;
}

const now = Date.parse('2026-11-15T08:00:00Z');
const at = (min) => new Date(now - min * 60000).toISOString();
const asst = (min, model, text) => ({ type: 'assistant', timestamp: at(min), message: { model, content: [{ type: 'text', text }] } });
const user = (min, text) => ({ type: 'user', timestamp: at(min), message: { content: text } });

test('settings: 未設定と opus は NG、opus は OK', () => {
  assert.ok(settingsModelProblem(undefined, 'opus'));
  assert.equal(settingsModelProblem('opus[1m]', 'opus'), 'opus[1m]');
  assert.equal(settingsModelProblem('opus', 'opus'), null);
});

test('settings: 未設定と sonnet/haiku は NG、opus/haiku は OK', () => {
  assert.ok(settingsModelProblem(undefined, 'haiku'));
  assert.ok(settingsModelProblem('haiku', 'haiku'));
  assert.equal(settingsModelProblem('haiku[1m]', 'haiku'), 'haiku[1m]');
});

test('返事待ち: 取り消せる選択肢で止まると WAITING、送信承認待ちは WAIT_HUMAN、なしは対象外', () => {
  assert.equal(waitingVerdict('次に kim がすること: 「対策を進めて」と一言返す').kind, 'WAITING');
  assert.equal(waitingVerdict('② kim の確認事項：どの対策を進めるか（すべて元に戻せます）').kind, 'WAITING');
  assert.equal(waitingVerdict('次に kim がすること: 上のカードで送信を押す').kind, 'WAIT_HUMAN');
  assert.equal(waitingVerdict('次に kim がすること: なし'), null);
});

test('audit: Opus で動いて返事待ちのセッションを NG にする', (t) => {
  const h = home({ model: 'opus[1m]' }, {
    a1111111: [{ type: 'ai-title', aiTitle: '使用量の消費元' }, { entrypoint: 'claude-vscode', ...user(90, '調べて') }, asst(60, 'claude-opus-5-5', '次に kim がすること: 「対策を進めて」と一言返す')],
    b2222222: [user(50, 'x'), asst(40, 'claude-sonnet-5-5', '完了しました。\n次に kim がすること: なし')],
  }, t);
  const r = audit({ home: h, now, hours: 6, idleMin: 15 });
  assert.equal(r.status, 'NG');
  assert.equal(r.opus, 1);
  assert.equal(r.waiting, 1);
  assert.ok(r.findings.some((f) => f.kind === 'SETTINGS'));
});

test('audit: Opus 既定で待ちもなければ OK', (t) => {
  const h = home({ model: 'opus' }, { c3333333: [user(30, 'x'), asst(20, 'claude-opus-5-5', '完了。次に kim がすること: なし')] }, t);
  const r = audit({ home: h, now, hours: 6, idleMin: 15 });
  assert.equal(r.status, 'OK');
});
