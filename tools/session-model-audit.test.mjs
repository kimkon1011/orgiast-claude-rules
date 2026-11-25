import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { audit, waitingVerdict, settingsModelProblem, isLightWork } from './session-model-audit.mjs';

const line = (o) => JSON.stringify(o);

function home(settings, sessions, t, extra = {}) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'session-audit-'));
  t.after(() => fs.rmSync(h, { recursive: true, force: true }));
  fs.mkdirSync(path.join(h, '.claude', 'projects', 'p'), { recursive: true });
  fs.writeFileSync(path.join(h, '.claude', 'settings.json'), JSON.stringify(settings));
  if (extra.defaultModel) fs.writeFileSync(path.join(h, '.claude', 'model-default.json'), JSON.stringify({ model: extra.defaultModel }));
  for (const [name, rows] of Object.entries(sessions)) fs.writeFileSync(path.join(h, '.claude', 'projects', 'p', `${name}.jsonl`), rows.map(line).join('\n'));
  return h;
}

const now = Date.parse('2026-11-15T08:00:00Z');
const at = (min) => new Date(now - min * 60000).toISOString();
const asst = (min, model, text) => ({ type: 'assistant', timestamp: at(min), message: { model, content: [{ type: 'text', text }] } });
const user = (min, text) => ({ type: 'user', timestamp: at(min), message: { content: text } });

test('settings: Opus 既定は OK、sonnet と未設定は NG', () => {
  assert.ok(settingsModelProblem(undefined, 'opus'));
  assert.equal(settingsModelProblem('sonnet', 'opus'), 'sonnet');
  assert.equal(settingsModelProblem('opus', 'opus'), null);
  assert.equal(settingsModelProblem('opus[1m]', 'opus'), null);
  assert.equal(settingsModelProblem('haiku', 'opus'), null);
  assert.equal(settingsModelProblem('sonnet', 'sonnet'), null);
});

test('軽い作業の判定', () => {
  assert.equal(isLightWork('/session-close して記録を追記'), true);
  assert.equal(isLightWork('見積の再計算と顧客への提案'), false);
});

test('返事待ち: 取り消せる選択肢で止まると WAITING、送信承認待ちは WAIT_HUMAN、なしは対象外', () => {
  assert.equal(waitingVerdict('次に kim がすること: 「対策を進めて」と一言返す').kind, 'WAITING');
  assert.equal(waitingVerdict('② kim の確認事項：どの対策を進めるか（すべて元に戻せます）').kind, 'WAITING');
  assert.equal(waitingVerdict('次に kim がすること: 上のカードで送信を押す').kind, 'WAIT_HUMAN');
  assert.equal(waitingVerdict('次に kim がすること: なし'), null);
});

test('audit: settings が sonnet なら NG SETTINGS。Opus での軽い作業は警告、返事待ちは NG', (t) => {
  const h = home({ model: 'sonnet' }, {
    a1111111: [{ type: 'ai-title', aiTitle: '/session-close の記録追記' }, { entrypoint: 'cli', ...user(90, '閉じて') }, asst(60, 'claude-opus-5-5', '記録を追記して /session-close しました。\n次に kim がすること: なし')],
    b2222222: [user(50, 'x'), asst(40, 'claude-opus-5-5', '次に kim がすること: 「対策を進めて」と一言返す')],
  }, t);
  const r = audit({ home: h, now, hours: 6, idleMin: 15 });
  assert.equal(r.status, 'NG');
  assert.equal(r.target, 'opus');
  assert.ok(r.findings.some((f) => f.kind === 'SETTINGS'));
  assert.ok(r.findings.some((f) => f.kind === 'OPUS_LIGHT' && f.level === 'WARN'));
  assert.equal(r.waiting, 1);
});

test('audit: Opus 既定で待ちもなければ OK', (t) => {
  const h = home({ model: 'opus' }, { c3333333: [user(30, 'x'), asst(20, 'claude-opus-5-5', '完了。次に kim がすること: なし')] }, t);
  const r = audit({ home: h, now, hours: 6, idleMin: 15 });
  assert.equal(r.status, 'OK');
  assert.equal(r.findings.filter((f) => f.level === 'NG').length, 0);
});
