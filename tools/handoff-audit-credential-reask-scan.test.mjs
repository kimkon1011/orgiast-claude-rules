import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detect, firstMatch, selftest, scan, CONTROLS } from './handoff-audit-credential-reask-scan.mjs';

// 走査結果の「0 件」は、検出器が動いていなければ意味を持たない。
// 対照（陽性5・陰性5）が全通過することを先に固定する。
test('検出器の対照が全通過する（陽性5・陰性5）', () => {
  const r = selftest();
  assert.equal(r.passed, r.total, JSON.stringify(r.failures));
  assert.equal(r.total, 10);
  assert.ok(CONTROLS.some((c) => c.want === true), '陽性対照が無いと 0 件が無意味になる');
  assert.ok(CONTROLS.some((c) => c.want === false), '陰性対照が無いと常時 true の検出器を見逃す');
});

test('クレデンシャル語と依頼語が近接したときだけ陽性', () => {
  assert.equal(detect('API キーを教えてください'), true);
  assert.equal(detect('クライアント ID を貼り付けてください'), true);
  assert.equal(detect('impersonate するメールアドレスを入力してください'), true);
  assert.equal(detect('Webhook URL を教えていただけますか'), true);
});

test('依頼語が無ければ陽性にしない（復元・報告は正しい挙動）', () => {
  assert.equal(detect('API キーは .env.local から復元しました。追加作業はありません。'), false, '復元できていれば聞き直しではない');
  assert.equal(detect('SUPABASE_DB_URL は解決済みで、接続も確認済みです。'), false, '報告だけなら陽性にしない');
  assert.equal(detect('パスワードをローテーションしました。'), false, '値の変更報告は陽性にしない');
});

test('近接していなければ陽性にしない（離れた語の共起は対象外）', () => {
  const far = 'API キーについて補足します。' + 'あ'.repeat(120) + 'こちらから入力してください。';
  assert.equal(detect(far), false, '80 文字を超えて離れた語は共起としない');
});

test('監査TODO文そのもの（自セッションのプロンプト）は再発として数えない', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-reask-scan-'));
  const dir = path.join(home, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  const todo = 'API キー/Client ID/impersonate メールの復元 [handoff-audit:0ab11a96de53cc66] 再発を検証する';
  fs.writeFileSync(path.join(dir, 'handoff-audit-ledger.jsonl'),
    JSON.stringify({ ts: new Date().toISOString(), sessionId: 'aaaaaaaa', excerpt: todo }) + '\n' +
    JSON.stringify({ ts: new Date().toISOString(), sessionId: 'bbbbbbbb', excerpt: 'API キーを教えてください。' }) + '\n');
  const r = scan({ home, since: Date.now() - 86400_000 });
  assert.equal(r.ledger.scanned, 2);
  assert.equal(r.hits, 1, 'TODO文を除外し、本物の1件だけを数える');
  assert.equal(r.rows[0].id, 'bbbbbbbb');
});

test('窓の外は数えない（窓の境界を実測値で固定する）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-reask-scan-'));
  const dir = path.join(home, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'handoff-audit-ledger.jsonl'),
    JSON.stringify({ ts: '2026-01-01T00:00:00Z', sessionId: 'old00000', excerpt: 'API キーを教えてください。' }) + '\n');
  const r = scan({ home, since: Date.parse('2026-09-01T00:00:00Z') });
  assert.equal(r.ledger.total, 1);
  assert.equal(r.ledger.scanned, 0);
  assert.equal(r.hits, 0);
});

test('assistant 以外の turn は数えない（依頼する側だけを見る）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-reask-scan-'));
  const proj = path.join(home, '.claude', 'projects', 'p');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 's.jsonl'),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Client ID を教えてください。' } }) + '\n' +
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Client ID を貼り付けてください。' }] }, timestamp: new Date().toISOString() }) + '\n');
  const r = scan({ home, since: Date.now() - 86400_000 });
  assert.equal(r.hits, 1, 'user turn は数えず、assistant の1件だけを数える');
  assert.match(r.rows[0].match, /Client ID/);
});
