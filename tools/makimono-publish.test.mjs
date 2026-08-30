import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkSubmissions, ensureKey, findSimilarPending, notifyStale, pickTrustedKey, reconcileSubmissions } from './makimono-publish.mjs';

const NOW = new Date('2026-08-27T12:00:00.000Z');
const pending = (overrides = {}) => ({ at: '2026-08-26T12:00:00.000Z', title: 'ＡＢＣ　手順', submissionId: 'sub_dummy', status: 'pending', ...overrides });

test('審査待ちの実例に近い題名を検出する', () => {
  const logs = [{ title: 'MCPサーバが「接続済み」なのにツールが動かない時の切り分け', status: 'pending', submissionId: 'sub_0492e723', at: '2026-08-30T09:59:00.000Z' }];
  const result = findSimilarPending(logs, { title: 'MCPサーバが「接続済み」なのに動かない — 4層の故障を切り分ける' });
  assert.equal(result.length, 1);
  assert.equal(result[0].submissionId, 'sub_0492e723');
});

// しきい値 0.3 の境界。実データで誤検知だった組み合わせ(類似度 0.25)は止めない。
// 止めすぎると毎回 --force を打つことになり、警告そのものが読まれなくなる。
test('主題が違えば語がいくつか重なっても止めない', () => {
  const logs = [{ title: 'Windowsの定期タスクから黒いコマンドウィンドウを消す', status: 'pending', submissionId: 'sub_84528b53', at: '2026-08-28T09:27:00.000Z' }];
  assert.deepEqual(findSimilarPending(logs, { title: 'ログオンしただけでIDEが開きAIエージェントが走り出す状態を作る（Windows/VS Code）' }), []);
});

// 言い換えが大きい実例(sub_734c6cfb → sub_913295b0)。ここを取り逃がすと同じ主題が並ぶ。
test('言い換えが大きくても同主題の審査待ちは検出する', () => {
  const logs = [{ title: 'MCPサーバの「Connected」は疎通の証拠にならない — 外部CLIを包むMCPを3段で検証する', status: 'pending', submissionId: 'sub_734c6cfb', at: '2026-08-30T07:16:00.000Z' }];
  const result = findSimilarPending(logs, { title: 'CLIをラップしたMCPサーバが上流の無料枠終了で死んだらREST直叩きへ寄せる' });
  assert.equal(result.length, 1);
  assert.equal(result[0].submissionId, 'sub_734c6cfb');
});

test('無関係な題名は類似と判定しない', () => {
  const logs = [{ title: 'MCPサーバが「接続済み」なのにツールが動かない時の切り分け', status: 'pending' }];
  assert.deepEqual(findSimilarPending(logs, { title: '会食候補を地図リンク付きで3件出す秘書スキル' }), []);
});

test('published と rejected は類似判定の対象外', () => {
  const title = 'MCPサーバが接続済みなのに動かない';
  const logs = [{ title, status: 'published' }, { title, status: 'rejected' }];
  assert.deepEqual(findSimilarPending(logs, { title }), []);
});

test('類似判定は入力ログを破壊しない', () => {
  const logs = [pending({ summary: '補足情報' })]; const snapshot = structuredClone(logs);
  findSimilarPending(logs, { title: 'ABC手順', summary: '候補の補足' });
  assert.deepEqual(logs, snapshot);
});

test('類似判定は非配列を空配列として扱う', () => {
  assert.deepEqual(findSimilarPending(null, { title: '題名' }), []);
  assert.deepEqual(findSimilarPending({}, { title: '題名' }), []);
});

test('タイトルの全角半角と空白差を正規化して published に更新する', () => {
  const result = reconcileSubmissions([pending()], [{ title: 'abc手順', slug: 'abc-guide' }], NOW, 3);
  assert.equal(result.published, 1);
  assert.deepEqual(result.logs[0], { ...pending(), status: 'published', slug: 'abc-guide', publishedSeenAt: NOW.toISOString() });
});

test('既に published のエントリは再判定しない', () => {
  const existing = pending({ status: 'published', slug: 'original', publishedSeenAt: '2026-08-20T00:00:00.000Z' });
  const result = reconcileSubmissions([existing], [{ title: 'abc手順', slug: 'replacement' }], NOW, 3);
  assert.equal(result.logs[0], existing);
  assert.deepEqual(result.logs[0], existing);
});

test('staleDays は超過だけを stale とする', () => {
  const logs = [
    pending({ title: 'ちょうど3日', at: '2026-08-24T12:00:00.000Z' }),
    pending({ title: '4日', at: '2026-08-23T12:00:00.000Z' }),
  ];
  const result = reconcileSubmissions(logs, [], NOW, 3);
  assert.deepEqual(result.pendingItems.map((item) => [item.days, item.stale]), [[3, false], [4, true]]);
  assert.equal(result.stale, 1);
});

test('入力配列とエントリを破壊しない', () => {
  const logs = [pending()];
  const snapshot = structuredClone(logs);
  reconcileSubmissions(logs, [{ title: 'abc手順', slug: 'abc-guide' }], NOW, 3);
  assert.deepEqual(logs, snapshot);
});

test('公開側一覧が空でも例外を投げない', () => {
  assert.doesNotThrow(() => reconcileSubmissions([pending()], [], NOW, 3));
  const result = reconcileSubmissions([pending()], [], NOW, 3);
  assert.equal(result.pending, 1);
  assert.equal(result.published, 0);
});

function keyHome({ email = 'kim@orgiast.jp', key = 'mk_legacy_key_123456789', trusted } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'makimono-key-'));
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'makimono.env'), `MAKIMONO_EMAIL=${email}\nMAKIMONO_KEY=${key}\n`);
  if (trusted !== undefined) fs.writeFileSync(path.join(root, '.claude', 'makimono-trusted.env'), `MAKIMONO_TRUSTED_KEYS=${trusted}\n`);
  return root;
}

test('メール一致の信頼済みキーを旧キーより優先する', async () => {
  const home = keyHome({ trusted: JSON.stringify({ 'kim@orgiast.jp': 'mkt_trusted_secret' }) });
  assert.equal(pickTrustedKey({ home, email: 'kim@orgiast.jp' }), 'mkt_trusted_secret');
  assert.deepEqual(await ensureKey({ home }), { key: 'mkt_trusted_secret', email: 'kim@orgiast.jp' });
});

test('信頼済みキーのメール照合は大文字小文字と前後空白を無視する', () => {
  const home = keyHome({ trusted: JSON.stringify({ '  KIM@ORGIAST.JP ': 'mkt_case_secret' }) });
  assert.equal(pickTrustedKey({ home, email: ' kim@orgiast.jp ' }), 'mkt_case_secret');
});

test('信頼済みメール不一致なら旧キーへフォールバックする', async () => {
  const home = keyHome({ trusted: JSON.stringify({ 'other@orgiast.jp': 'mkt_other_secret' }) });
  assert.equal((await ensureKey({ home })).key, 'mk_legacy_key_123456789');
});

test('信頼済みファイルなし・壊れたJSON・空値でも旧キーへフォールバックする', async () => {
  for (const trusted of [undefined, '{broken', '']) {
    const home = keyHome({ trusted });
    await assert.doesNotReject(async () => assert.equal((await ensureKey({ home })).key, 'mk_legacy_key_123456789'));
  }
});

test('信頼済みキー使用ログにキー値を出さない', async () => {
  const secret = 'mkt_never_print_this_secret';
  const home = keyHome({ trusted: JSON.stringify({ 'kim@orgiast.jp': secret }) });
  const lines = []; const original = console.log; console.log = (...args) => lines.push(args.join(' '));
  try { await ensureKey({ home, logTrusted: true }); } finally { console.log = original; }
  assert.match(lines.join('\n'), /信頼済みキーで出品します（メール: kim@orgiast\.jp）/);
  assert.doesNotMatch(lines.join('\n'), new RegExp(secret));
});

function checkHome(logs) {
  const root = keyHome();
  fs.writeFileSync(path.join(root, '.claude', 'makimono-submissions.json'), `${JSON.stringify(logs, null, 2)}\n`);
  return root;
}
function response(status, data) { return { ok: status >= 200 && status < 300, status, json: async () => data }; }
async function runCheck(logs, fetchImpl, args = ['--check', '--json']) {
  const home = checkHome(logs); const lines = []; const original = console.log; console.log = (...values) => lines.push(values.join(' '));
  try { const result = await checkSubmissions(args, { home, fetchImpl, now: NOW }); return { result, lines, logs: JSON.parse(fs.readFileSync(path.join(home, '.claude', 'makimono-submissions.json'), 'utf8')) }; }
  finally { console.log = original; }
}

test('状態APIの published と slug をログへ反映する', async () => {
  const h = await runCheck([pending()], async (url) => url.includes('/search?') ? response(200, []) : response(200, { status: 'published', slug: 'api-slug' }));
  assert.equal(h.result.published, 1); assert.equal(h.logs[0].status, 'published'); assert.equal(h.logs[0].slug, 'api-slug');
});

test('状態APIの pending は審査待ちとして数える', async () => {
  const h = await runCheck([pending()], async (url) => url.includes('/search?') ? response(200, []) : response(200, { status: 'pending' }));
  assert.equal(h.result.pending, 1); assert.equal(h.result.published, 0);
});

test('rejected は別集計で stale 対象にしない', async () => {
  const old = pending({ at: '2026-08-01T00:00:00.000Z' });
  const h = await runCheck([old], async (url) => url.includes('/search?') ? response(200, []) : response(200, { status: 'rejected' }));
  assert.equal(h.result.rejected, 1); assert.equal(h.result.pending, 0); assert.equal(h.result.published, 0); assert.equal(h.result.stale, 0);
  assert.deepEqual(JSON.parse(h.lines.at(-1)), { published: 0, pending: 0, rejected: 1, stale: 0, items: [] });
});

test('状態APIが404なら公開一覧のタイトル一致へフォールバックする', async () => {
  const h = await runCheck([pending()], async (url) => url.includes('/search?') ? response(200, [{ title: 'abc手順', slug: 'fallback-slug' }]) : response(404, { error: 'not_found' }));
  assert.equal(h.result.published, 1); assert.equal(h.logs[0].slug, 'fallback-slug');
});

test('状態APIが全件エラーでも check は落ちない', async () => {
  const h = await runCheck([pending(), pending({ submissionId: 'sub_2' })], async () => { throw new Error('offline'); });
  assert.equal(h.result.pending, 2); assert.equal(h.result.published, 0);
});

test('状態APIの同時実行は4本を超えない', async () => {
  let active = 0; let maximum = 0;
  const logs = Array.from({ length: 9 }, (_, index) => pending({ submissionId: `sub_${index}`, title: `項目${index}` }));
  await runCheck(logs, async (url) => {
    if (url.includes('/search?')) return response(200, []);
    active++; maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 10)); active--;
    return response(200, { status: 'pending' });
  });
  assert.equal(maximum, 4);
});

function notifyFixture(ids) {
  return { pending: ids.length, stale: ids.length, pendingItems: ids.map((submissionId) => ({ submissionId, title: submissionId, stale: true })) };
}
function notifyHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'makimono-notify-'));
  const stateFile = path.join(root, '.claude', 'makimono-notify-state.json');
  const calls = [];
  process.env.ORGIAST_HOME = root;
  return { root, stateFile, calls, webhookUrl: 'https://example.com/test-webhook', fetchImpl: async (...args) => { calls.push(args); return { ok: true, status: 204 }; } };
}

test('同じ stale 集合の2回目は通知しない', async () => {
  const h = notifyHarness(); const options = { fetchImpl: h.fetchImpl, webhookUrl: h.webhookUrl, now: NOW };
  await notifyStale(notifyFixture(['a']), 3, options);
  await notifyStale(notifyFixture(['a']), 3, { ...options, now: new Date(NOW.getTime() + DAY) });
  assert.equal(h.calls.length, 1);
});

const DAY = 24 * 60 * 60 * 1000;
test('stale ID が増えたら通知する', async () => {
  const h = notifyHarness();
  await notifyStale(notifyFixture(['a']), 3, { fetchImpl: h.fetchImpl, webhookUrl: h.webhookUrl, now: NOW });
  await notifyStale(notifyFixture(['a', 'b']), 3, { fetchImpl: h.fetchImpl, webhookUrl: h.webhookUrl, now: new Date(NOW.getTime() + DAY) });
  assert.equal(h.calls.length, 2);
});

test('7日経過で再通知する', async () => {
  const h = notifyHarness();
  await notifyStale(notifyFixture(['a']), 3, { fetchImpl: h.fetchImpl, webhookUrl: h.webhookUrl, now: NOW });
  await notifyStale(notifyFixture(['a']), 3, { fetchImpl: h.fetchImpl, webhookUrl: h.webhookUrl, now: new Date(NOW.getTime() + 7 * DAY) });
  assert.equal(h.calls.length, 2);
});

test('forceNotify は同内容でも強制通知する', async () => {
  const h = notifyHarness();
  await notifyStale(notifyFixture(['a']), 3, { fetchImpl: h.fetchImpl, webhookUrl: h.webhookUrl, now: NOW });
  await notifyStale(notifyFixture(['a']), 3, { fetchImpl: h.fetchImpl, webhookUrl: h.webhookUrl, now: NOW, forceNotify: true });
  assert.equal(h.calls.length, 2);
});
