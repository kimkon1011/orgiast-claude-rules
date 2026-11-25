import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detect, selftest, scan, CONTROLS } from './handoff-audit-oauth-consent-scan.mjs';

// 走査結果の「0 件」は、検出器が動いていなければ意味を持たない。
// 対照（陽性2・陰性3）が全通過することを先に固定する。
test('検出器の対照が全通過する（陽性2・陰性3）', () => {
  const r = selftest();
  assert.equal(r.passed, r.total, JSON.stringify(r.failures));
  assert.equal(r.total, 5);
  assert.ok(CONTROLS.some((c) => c.want === true), '陽性対照が無いと 0 件が無意味になる');
  assert.ok(CONTROLS.some((c) => c.want === false), '陰性対照が無いと常時 true の検出器を見逃す');
});

test('Google プロパティ語と OAuth 同意語が揃ったときだけ陽性', () => {
  assert.equal(detect('GA4 を見るには OAuth の初回同意が必要です'), true);
  assert.equal(detect('GA4 のセッションは 1,234 でした'), false, '同意語が無ければ陽性にしない');
  assert.equal(detect('Slack の初回同意をしてください'), false, 'Google プロパティ語が無ければ陽性にしない');
});

test('他ベンダーの OAuth 同意は対象外（DWD で代替できない正当な手渡し）', () => {
  assert.equal(detect('https://github.com/login/device で承認してください。GA4 とは無関係'), false);
  assert.equal(detect('ChatGPT にサインインしてから GTM を見ます。OAuth の同意をお願いします'), false);
});

test('監査TODO文そのもの（自セッションのプロンプト）は再発として数えない', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-consent-scan-'));
  const dir = path.join(home, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  const todo = 'GA4 の OAuth 初回同意の承認を user に依頼 [handoff-audit:8c97bb8b5e2e2968] 検証する';
  fs.writeFileSync(path.join(dir, 'handoff-audit-ledger.jsonl'),
    JSON.stringify({ ts: new Date().toISOString(), sessionId: 'aaaaaaaa', excerpt: todo }) + '\n' +
    JSON.stringify({ ts: new Date().toISOString(), sessionId: 'bbbbbbbb', excerpt: 'GA4 を見るには OAuth の初回同意が必要です。承認してください。' }) + '\n');
  const r = scan({ home, since: Date.now() - 86400_000 });
  assert.equal(r.ledger.scanned, 2);
  assert.equal(r.hits, 1, 'TODO文を除外し、本物の1件だけを数える');
  assert.equal(r.rows[0].id, 'bbbbbbbb');
});

test('窓の外は数えない（窓の境界を実測値で固定する）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-consent-scan-'));
  const dir = path.join(home, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'handoff-audit-ledger.jsonl'),
    JSON.stringify({ ts: '2026-01-01T00:00:00Z', sessionId: 'old00000', excerpt: 'GA4 の OAuth 初回同意を承認してください。' }) + '\n');
  const r = scan({ home, since: Date.parse('2026-09-01T00:00:00Z') });
  assert.equal(r.ledger.total, 1);
  assert.equal(r.ledger.scanned, 0);
  assert.equal(r.hits, 0);
});
