import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkSubmissions, drainQueue, ensureKey, findSimilarPending, notifyStale, pickTrustedKey, queueSubmission, reconcileSubmissions } from './makimono-publish.mjs';

const NOW = new Date('2026-08-27T12:00:00.000Z');
const pending = (overrides = {}) => ({ at: '2026-08-26T12:00:00.000Z', title: 'ＡＢＣ　手順', submissionId: 'sub_dummy', status: 'pending', ...overrides });
const validBody = '外部公開できる一般的な手順です。'.repeat(20);
const validQueue = { title: '安全な夜間処理の手順', summary: '安全な夜間処理を構成して確実に運用するための一般的な説明です。', category: '開発', body: validBody };
function queueHome(logs = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'makimono-queue-'));
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'makimono.env'), 'MAKIMONO_EMAIL=test@example.com\nMAKIMONO_KEY=mk_test_key_123456789\n');
  fs.writeFileSync(path.join(root, '.claude', 'makimono-submissions.json'), `${JSON.stringify(logs)}\n`);
  return root;
}
const categoryFetch = async () => response(200, { categories: [{ name: '開発' }] });

test('queue はJSONとMDを作りPOSTしない', async () => {
  const home = queueHome(); let posts = 0;
  const result = await queueSubmission({ home, ...validQueue, fetchImpl: async (url, options = {}) => { if (options.method === 'POST') posts++; return categoryFetch(); } });
  const files = fs.readdirSync(path.join(home, '.claude', 'makimono-queue'));
  assert.equal(result.ok, true); assert.equal(posts, 0); assert.equal(files.filter((x) => x.endsWith('.json')).length, 1); assert.equal(files.filter((x) => x.endsWith('.md')).length, 1);
});

test('queue は禁止本文を下書きへ退避して投入しない', async () => {
  const home = queueHome(); const result = await queueSubmission({ home, ...validQueue, body: `${validBody}\nkim@orgiast.jp`, fetchImpl: categoryFetch });
  assert.equal(result.ok, false); assert.equal(result.reason, 'forbidden'); assert.equal(fs.existsSync(path.join(home, '.claude', 'makimono-queue')), false); assert.equal(fs.readdirSync(path.join(home, '.claude', 'makimono-drafts')).length, 1);
});

test('queue の近似は未確認なら止まり force ならIDを記録する', async () => {
  const log = pending({ title: validQueue.title, summary: validQueue.summary, submissionId: 'sub_similar' });
  const stoppedHome = queueHome([log]); const stopped = await queueSubmission({ home: stoppedHome, ...validQueue, fetchImpl: categoryFetch });
  assert.equal(stopped.reason, 'similar'); assert.equal(fs.existsSync(path.join(stoppedHome, '.claude', 'makimono-queue')), false);
  const home = queueHome([log]); const queued = await queueSubmission({ home, ...validQueue, force: true, fetchImpl: categoryFetch });
  assert.deepEqual(queued.acknowledgedSimilar, ['sub_similar']);
  const metadata = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'makimono-queue', queued.queued), 'utf8'));
  assert.deepEqual(metadata.acknowledgedSimilar, ['sub_similar']);
});

test('queue は同一sha256を二重投入しない', async () => {
  const home = queueHome(); await queueSubmission({ home, ...validQueue, fetchImpl: categoryFetch });
  const again = await queueSubmission({ home, ...validQueue, fetchImpl: categoryFetch });
  assert.equal(again.duplicate, 'queued'); assert.equal(fs.readdirSync(path.join(home, '.claude', 'makimono-queue')).filter((x) => x.endsWith('.json')).length, 1);
});

test('drain はPOST・ログ追記・キュー削除を行う', async () => {
  const home = queueHome(); await queueSubmission({ home, ...validQueue, fetchImpl: categoryFetch }); let posts = 0;
  const result = await drainQueue({ home, check: false, fetchImpl: async (url, options = {}) => { if (url.endsWith('/listings') && options.method === 'POST') { posts++; return response(200, { submissionId: 'sub_sent', status: 'pending' }); } throw new Error(`unexpected ${url}`); } });
  assert.deepEqual(result, { sent: 1, held: 0, remaining: 0 }); assert.equal(posts, 1); assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'makimono-submissions.json')))[0].submissionId, 'sub_sent'); assert.deepEqual(fs.readdirSync(path.join(home, '.claude', 'makimono-queue')), []);
});

test('drain は投入後の未確認近似を保留する', async () => {
  const home = queueHome(); const queued = await queueSubmission({ home, ...validQueue, fetchImpl: categoryFetch });
  fs.writeFileSync(path.join(home, '.claude', 'makimono-submissions.json'), JSON.stringify([pending({ title: validQueue.title, summary: validQueue.summary, submissionId: 'sub_new' })])); let posts = 0;
  const result = await drainQueue({ home, check: false, fetchImpl: async () => { posts++; return response(200, {}); } });
  assert.deepEqual(result, { sent: 0, held: 1, remaining: 1 }); assert.equal(posts, 0); assert.equal(fs.existsSync(path.join(home, '.claude', 'makimono-queue', queued.queued)), true);
});

test('drain はPOST失敗を残して再試行可能にする', async () => {
  const home = queueHome(); await queueSubmission({ home, ...validQueue, fetchImpl: categoryFetch });
  const result = await drainQueue({ home, check: false, fetchImpl: async () => response(500, { error: 'temporary' }) });
  assert.deepEqual(result, { sent: 0, held: 1, remaining: 1 });
});

test('drain は空キューを正常終了する', async () => {
  assert.deepEqual(await drainQueue({ home: queueHome(), check: false, fetchImpl: async () => { throw new Error('network must not be called'); } }), { sent: 0, held: 0, remaining: 0 });
});

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

const pendingCorpusTitles = [
  ['sub_b9755c5d', '配布する PowerShell インストーラを CI で検査する（PS5.1・BOM の罠）'],
  ['sub_58a6f22d', '規約PDFを根拠に「それ違反ですか？」に答える相談AIの作り方'],
  ['sub_84528b53', 'Windowsの定期タスクから黒いコマンドウィンドウを消す'],
  ['sub_66340283', '社内フィードバックを毎日AIの作業キューへ自動取り込みする（安全ゲート付き）'],
  ['sub_188983bd', 'アプリ内フィードバック→責任者DM→Issue→自動修正PR→1タップ承認'],
  ['sub_f8442836', 'AIの永続メモリ索引が読み込み上限で黙って切り捨てられる問題を直す'],
  ['sub_45af39d0', '機密列を含む共有スプレッドシートにAIを安全に書き込ませる型'],
  ['sub_643134d8', 'AEO/GEO 施策の型 — AI検索で自社を推薦・引用されやすくする'],
  ['sub_4c9b1843', 'ChatGPTに本当にLPデザインを作らせて、コードへ忠実に落とす指示書'],
  ['sub_57317153', '既存スプレッドシートを正本にした業務アプリの列マッピングを壊れない設計にする'],
  ['sub_0275cb99', 'クラウド契約とプロジェクト所在を1枚のスプレッドシート台帳に自動集約する'],
  ['sub_d1b55b48', 'ずっと skipped だった CI ジョブを掘り起こして緑にする'],
  ['sub_26cab938', '別シートの列番号が腐って別レコードの値を返す事故の直し方（名前照合＋日付タイブレーク）'],
  ['sub_f0f27191', '「そのPCにしか直せない障害」をAIに自分で気付かせて着手させる'],
  ['sub_582c34db', 'ゲートを作った後の話 — すり抜けを監査して自己改善させるループ'],
  ['sub_d34d68e7', '全世界公開になっていた共有ドライブ資料を、業務を止めずに締める'],
  ['sub_b7a5ab7c', 'MCP stdio サーバが Windows で「接続済み」のまま死んでいるのを見抜く'],
  ['sub_7997b4a1', 'ログインできないGitHubアカウントに縛られた開発を、止めずに前へ進める'],
  ['sub_bcaffee4', '夜間の無人AIエージェントバッチが「静かに全滅」するのを止める（観測タスクの立て方）'],
  ['sub_734c6cfb', 'MCPサーバの「Connected」は疎通の証拠にならない — 外部CLIを包むMCPを3段で検証する'],
  ['sub_49503237', '毎晩「消化している」つもりのバッチが同じ先頭N件をやり直しているのを見抜いて直す'],
  ['sub_913295b0', 'CLIをラップしたMCPサーバが上流の無料枠終了で死んだらREST直叩きへ寄せる'],
  ['sub_2f8b6ed8', '毎晩「消化している」つもりのバッチが同じ先頭N件をやり直しているのを見抜く'],
  ['sub_f8a1fc83', '「名前でフォルダを探して無ければ作る」処理が自分の重複を掴み続ける問題を潰す'],
  ['sub_296a52ef', 'AIの記憶インデックスが読み込み上限で黙って切られる問題の検出と恒久対策'],
  ['sub_0492e723', 'MCPサーバが「接続済み」なのにツールが動かない時の切り分け'],
  ['sub_53a4205f', 'MCPサーバが「接続済み」なのに動かない — 4層の故障を切り分ける'],
  ['sub_c6a8fad1', 'ログオンしただけでIDEが開きAIエージェントが走り出す状態を作る（Windows/VS Code）'],
  ['sub_941ef071', 'MCPサーバが「接続済み」でもツールは死んでいる — Windowsの.cmd起動問題を見抜いて直す'],
  ['sub_429591c3', '「接続済み」は疎通の証拠にならない — 外部連携を起動層・認証層・枠層で切り分ける'],
  ['sub_e500f466', '定期実行が「手動なら動く」まま何週間も止まっているのを見抜いて直す'],
];
const pendingCorpus = pendingCorpusTitles.map(([submissionId, title], index) => ({
  submissionId,
  title,
  status: 'pending',
  at: new Date(Date.UTC(2026, 7, 30) - index * DAY).toISOString(),
}));
const pendingCorpusById = new Map(pendingCorpus.map((item) => [item.submissionId, item]));

// 実測で確認した重複8組を両方向で固定し、言い換え側だけを取り逃がす非対称な劣化も防ぐ。
// 0.32 の境界例を含むため、しきい値変更で既知重複の感度が落ちれば失敗する。
test('審査待ちコーパスの既知の重複を全部止める', () => {
  const duplicatePairs = [
    ['sub_49503237', 'sub_2f8b6ed8'],
    ['sub_f8442836', 'sub_296a52ef'],
    ['sub_0492e723', 'sub_53a4205f'],
    ['sub_0492e723', 'sub_941ef071'],
    ['sub_b7a5ab7c', 'sub_941ef071'],
    ['sub_b7a5ab7c', 'sub_53a4205f'],
    ['sub_53a4205f', 'sub_941ef071'],
    ['sub_734c6cfb', 'sub_429591c3'],
  ];
  for (const [leftId, rightId] of duplicatePairs) {
    const left = pendingCorpusById.get(leftId); const right = pendingCorpusById.get(rightId);
    assert.equal(findSimilarPending([right], { title: left.title }).length, 1, `${leftId} -> ${rightId}`);
    assert.equal(findSimilarPending([left], { title: right.title }).length, 1, `${rightId} -> ${leftId}`);
  }
});

// 2026-08-30 の31件・465ペアで実測19件。22以下に固定し、警告が乱発して
// --force の常用を招く方向のしきい値劣化を検出する。
test('審査待ちコーパスで警告が形骸化していない', () => {
  let detectedPairs = 0;
  for (let left = 0; left < pendingCorpus.length; left++) {
    for (let right = left + 1; right < pendingCorpus.length; right++) {
      if (findSimilarPending([pendingCorpus[right]], { title: pendingCorpus[left].title }).length === 1) detectedPairs++;
    }
  }
  assert.ok(detectedPairs <= 22, `検出ペア数 ${detectedPairs} が上限22を超えた`);
});

// 実測で全30件に非類似だった両端の題名を固定し、一般語の一致だけで止める
// 誤検知が入り込んだ場合に検出する。
test('審査待ちコーパスの無関係な題名は素通しする', () => {
  for (const id of ['sub_58a6f22d', 'sub_c6a8fad1']) {
    const subject = pendingCorpusById.get(id);
    const others = pendingCorpus.filter((item) => item.submissionId !== id);
    assert.deepEqual(findSimilarPending(others, { title: subject.title }), [], id);
  }
});
