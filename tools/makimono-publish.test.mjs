import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkSubmissions, ensureKey, findSimilarSubmissions, notifyStale, pickTrustedKey, reconcileSubmissions, titleOverlapRatio, titleSimilarity } from './makimono-publish.mjs';

const NOW = new Date('2026-08-27T12:00:00.000Z');
const pending = (overrides = {}) => ({ at: '2026-08-26T12:00:00.000Z', title: 'ＡＢＣ　手順', submissionId: 'sub_dummy', status: 'pending', ...overrides });

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

const realPendingTitles = [
  ['sub_b9755c5d', '配布する PowerShell インストーラを CI で検査する（PS5.1・BOM の罠）'], ['sub_58a6f22d', '規約PDFを根拠に「それ違反ですか？」に答える相談AIの作り方'], ['sub_84528b53', 'Windowsの定期タスクから黒いコマンドウィンドウを消す'], ['sub_66340283', '社内フィードバックを毎日AIの作業キューへ自動取り込みする（安全ゲート付き）'], ['sub_188983bd', 'アプリ内フィードバック→責任者DM→Issue→自動修正PR→1タップ承認'], ['sub_f8442836', 'AIの永続メモリ索引が読み込み上限で黙って切り捨てられる問題を直す'], ['sub_45af39d0', '機密列を含む共有スプレッドシートにAIを安全に書き込ませる型'], ['sub_643134d8', 'AEO/GEO 施策の型 — AI検索で自社を推薦・引用されやすくする'], ['sub_4c9b1843', 'ChatGPTに本当にLPデザインを作らせて、コードへ忠実に落とす指示書'], ['sub_57317153', '既存スプレッドシートを正本にした業務アプリの列マッピングを壊れない設計にする'], ['sub_0275cb99', 'クラウド契約とプロジェクト所在を1枚のスプレッドシート台帳に自動集約する'], ['sub_d1b55b48', 'ずっと skipped だった CI ジョブを掘り起こして緑にする'], ['sub_26cab938', '別シートの列番号が腐って別レコードの値を返す事故の直し方（名前照合＋日付タイブレーク）'], ['sub_f0f27191', '「そのPCにしか直せない障害」をAIに自分で気付かせて着手させる'], ['sub_582c34db', 'ゲートを作った後の話 — すり抜けを監査して自己改善させるループ'], ['sub_d34d68e7', '全世界公開になっていた共有ドライブ資料を、業務を止めずに締める'], ['sub_b7a5ab7c', 'MCP stdio サーバが Windows で「接続済み」のまま死んでいるのを見抜く'], ['sub_7997b4a1', 'ログインできないGitHubアカウントに縛られた開発を、止めずに前へ進める'], ['sub_bcaffee4', '夜間の無人AIエージェントバッチが「静かに全滅」するのを止める（観測タスクの立て方）'], ['sub_734c6cfb', 'MCPサーバの「Connected」は疎通の証拠にならない — 外部CLIを包むMCPを3段で検証する'], ['sub_49503237', '毎晩「消化している」つもりのバッチが同じ先頭N件をやり直しているのを見抜いて直す'], ['sub_913295b0', 'CLIをラップしたMCPサーバが上流の無料枠終了で死んだらREST直叩きへ寄せる'], ['sub_2f8b6ed8', '毎晩「消化している」つもりのバッチが同じ先頭N件をやり直しているのを見抜く'], ['sub_f8a1fc83', '「名前でフォルダを探して無ければ作る」処理が自分の重複を掴み続ける問題を潰す'], ['sub_296a52ef', 'AIの記憶インデックスが読み込み上限で黙って切られる問題の検出と恒久対策'], ['sub_0492e723', 'MCPサーバが「接続済み」なのにツールが動かない時の切り分け'], ['sub_53a4205f', 'MCPサーバが「接続済み」なのに動かない — 4層の故障を切り分ける'], ['sub_c6a8fad1', 'ログオンしただけでIDEが開きAIエージェントが走り出す状態を作る（Windows/VS Code）'], ['sub_941ef071', 'MCPサーバが「接続済み」でもツールは死んでいる — Windowsの.cmd起動問題を見抜いて直す'], ['sub_429591c3', '「接続済み」は疎通の証拠にならない — 外部連携を起動層・認証層・枠層で切り分ける'], ['sub_e500f466', '定期実行が「手動なら動く」まま何週間も止まっているのを見抜いて直す'],
].map(([submissionId, title], index) => ({ at: new Date(NOW.getTime() - index * DAY).toISOString(), title, submissionId, status: 'pending' }));

test('近似題名を検出し無関係な題名は検出しない', () => {
  const logs = [pending({ title: '毎晩バッチが同じ先頭N件をやり直しているのを見抜く' })];
  assert.ok(findSimilarSubmissions(logs, '毎晩バッチが同じ先頭N件をやり直しているのを見抜いて直す').length >= 1);
  assert.equal(findSimilarSubmissions(logs, '規約PDFを根拠に相談するAI').length, 0);
});

test('published の除外とタイトル正規化', () => {
  const logs = [pending({ status: 'published', title: 'ＡＢＣ　手順！' })];
  assert.equal(findSimilarSubmissions(logs, 'abc手順', { includePublished: false }).length, 0);
  assert.equal(titleSimilarity('ＡＢＣ　手順！', 'abc手順'), 1);
});

test('類似検索は入力配列とエントリを破壊しない', () => {
  const logs = [pending()]; const snapshot = structuredClone(logs);
  findSimilarSubmissions(logs, 'ABC手順');
  assert.deepEqual(logs, snapshot);
});

test('実データの重複題名を閾値0.4で検出する', () => {
  const byId = (id) => realPendingTitles.find((entry) => entry.submissionId === id);
  const matches = (id) => findSimilarSubmissions(realPendingTitles.filter((entry) => entry.submissionId !== id), byId(id).title);
  assert.ok(matches('sub_49503237').some((entry) => entry.submissionId === 'sub_2f8b6ed8'));
  assert.ok(matches('sub_2f8b6ed8').some((entry) => entry.submissionId === 'sub_49503237'));
  assert.ok(matches('sub_f8442836').some((entry) => entry.submissionId === 'sub_296a52ef'));
  assert.ok(matches('sub_296a52ef').some((entry) => entry.submissionId === 'sub_f8442836'));
  assert.ok(matches('sub_0492e723').filter((entry) => ['sub_53a4205f', 'sub_941ef071', 'sub_429591c3', 'sub_734c6cfb', 'sub_b7a5ab7c'].includes(entry.submissionId)).length >= 2);
  assert.equal(matches('sub_58a6f22d').length, 0);
});

test('最長共通部分文字列の比率は完全一致が1、共通部分なしが0', () => {
  assert.equal(titleOverlapRatio('ＡＢＣ 手順！', 'abc手順'), 1);
  assert.equal(titleOverlapRatio('abc', '日本語'), 0);
});

test('疎通の証拠にならない実データ題名を相互に検出する', () => {
  const byId = (id) => realPendingTitles.find((entry) => entry.submissionId === id);
  for (const [left, right] of [['sub_734c6cfb', 'sub_429591c3'], ['sub_429591c3', 'sub_734c6cfb']]) {
    assert.ok(findSimilarSubmissions([byId(right)], byId(left).title).some((entry) => entry.submissionId === right));
  }
});

test('実データ全ペアの既定重複判定は既知の9組だけ', () => {
  const expected = [
    ['sub_49503237', 'sub_2f8b6ed8'], ['sub_0492e723', 'sub_53a4205f'], ['sub_b7a5ab7c', 'sub_941ef071'],
    ['sub_b7a5ab7c', 'sub_0492e723'], ['sub_f8442836', 'sub_296a52ef'], ['sub_b7a5ab7c', 'sub_53a4205f'],
    ['sub_0492e723', 'sub_941ef071'], ['sub_53a4205f', 'sub_941ef071'], ['sub_734c6cfb', 'sub_429591c3'],
  ].map((pair) => pair.sort().join('/')).sort();
  const actual = [];
  for (let i = 0; i < realPendingTitles.length; i++) for (let j = i + 1; j < realPendingTitles.length; j++) {
    if (findSimilarSubmissions([realPendingTitles[j]], realPendingTitles[i].title).length) actual.push([realPendingTitles[i].submissionId, realPendingTitles[j].submissionId].sort().join('/'));
  }
  assert.deepEqual(actual.sort(), expected);
});
