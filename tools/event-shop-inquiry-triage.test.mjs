import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyLead, deduplicateLeads, deduplicateMessages, sortLeads, main, messageQuery, renderMarkdown, loadCredentials } from './event-shop-inquiry-triage.mjs';
const now = new Date('2026-10-27T03:00:00Z');
const lead = { id: 'a', email: 'client@example.com', company_name: '会社', contact_name: '担当', created_at: '2026-10-21T03:00:00Z', preferred_date: '2026-11-18', raw_payload: { product: '展示会' } };
const msg = (direction, day, body = '') => ({ direction, received_at: `2026-10-${day}T03:00:00Z`, body });
test('1: 初回未送信と下書き', () => {
  const result = classifyLead(lead, [], now);
  assert.equal(result.category, '🔴 要返信');
  assert.match(result.nextAction, /初回返信が未送信/);
  assert.match(classifyLead({ ...lead, raw_payload: { event_shop: { draft_saved_at: 'x' } } }, [], now).nextAction, /下書きあり・未送信/);
});
test('2: 顧客からの見積依頼と引用・挨拶の除去', () => {
  const result = classifyLead(lead, [msg('outbound', '23'), msg('inbound', '25', '> 今回は辞退\n山田様\nお世話になっております。\n担当です。\n御見積書を頂くことは可能でしょうか')], now);
  assert.equal(result.category, '🔴 要返信');
  assert.equal(result.nextAction, '顧客の返信に未回答: 御見積書を頂くことは可能でしょうか');
});
test('3: 辞退は終了候補', () => {
  assert.equal(classifyLead(lead, [msg('inbound', '25', '必要な際は改めてご連絡させていただきます')], now).category, '⚪ 終了候補');
});
test('4: 10日経過で追客候補', () => {
  const result = classifyLead(lead, [msg('outbound', '17')], now);
  assert.equal(result.category, '🟡 顧客待ち');
  assert.match(result.nextAction, /10 日.*追客候補/);
});
test('5: 過去の開催日は未送信でも終了候補、当日は要返信', () => {
  assert.equal(classifyLead({ ...lead, preferred_date: '2026-10-26' }, [], now).nextAction, '開催日経過→管理画面で完了に');
  assert.equal(classifyLead({ ...lead, preferred_date: '2026-10-27' }, [], now).category, '🔴 要返信');
});
test('5b: 開催日経過でも直近の未回答返信があれば要返信（博展 10/25 の事例）', () => {
  const result = classifyLead({ ...lead, preferred_date: '2026-09-29' }, [msg('outbound', '25'), { ...msg('inbound', '25', '金様\nお世話になります。\nご検討ありがとうございます。\n一度御見積書を頂くことは可能でしょうか。'), received_at: '2026-10-25T23:12:00Z' }], now);
  assert.equal(result.category, '🔴 要返信');
  assert.equal(result.nextAction, '顧客の返信に未回答: 一度御見積書を頂くことは可能でしょうか。');
  assert.equal(classifyLead({ ...lead, preferred_date: '2026-09-29' }, [msg('outbound', '01'), msg('inbound', '05', '質問です')], now).category, '⚪ 終了候補');
});
test('5c: 抜粋は挨拶・お詫びの定型行を飛ばす', () => {
  const result = classifyLead(lead, [msg('outbound', '22'), msg('inbound', '26', 'オージャスト様\nお世話になっております。Cocoliveの五月女です。\nお待たせしてしまい恐れ入ります。\n先日ご依頼いただきました、4点について回答させていただきます。')], now);
  assert.equal(result.nextAction, '顧客の返信に未回答: 先日ご依頼いただきました、4点について回答させていただきます。');
});
test('3b: 別社・他社・またの機会の辞退を終了候補にする（2026-11-15 実害）', () => {
  const body = `ご担当者様
お世話になります。

本件、こちらが大阪になるため関東への受け取り、ご返却が難しく、
別社にて対応いただく予定となりました。

お手数をおかけいたしました。
またの機会がございましたらぜひよろしくお願いいたします。`;
  const result = classifyLead(lead, [msg('inbound', '15', body)], now);
  assert.equal(result.category, '⚪ 終了候補');
  assert.match(result.nextAction, /辞退/);
});
test('3c: 他社様の事例は質問文であり誤爆しない', () => {
  const body = `佐藤様

お世話になっております。
他社様の事例などあれば教えていただけますでしょうか。`;
  const result = classifyLead(lead, [msg('inbound', '15', body)], now);
  assert.equal(result.category, '🔴 要返信');
});
test('3d: 「他社の見積もりと比較したい」は要返信（誤爆防止）', () => {
  const body = '他社の見積もりと比較したいので、御見積書をいただけますか。';
  const result = classifyLead(lead, [msg('inbound', '15', body)], now);
  assert.equal(result.category, '🔴 要返信');
});
test('3e: 「キャンセル料は何日前から」は要返信（誤爆防止）', () => {
  const body = 'キャンセル料は何日前から発生しますか。';
  const result = classifyLead(lead, [msg('inbound', '15', body)], now);
  assert.equal(result.category, '🔴 要返信');
});
test('6: 同じemail/productの1日差は最新だけを残す', () => {
  const newer = { ...lead, id: 'new', created_at: '2026-10-22T03:00:00Z' };
  assert.deepEqual(deduplicateLeads([lead, newer]), { leads: [newer], duplicateCount: 1 });
  assert.equal(deduplicateLeads([lead, { ...newer, raw_payload: { product: '別商品' } }]).leads.length, 2);
  assert.equal(deduplicateLeads([lead, { ...newer, created_at: '2026-10-24T03:00:00Z' }]).leads.length, 2);
});
test('7: 要返信の開催日順・受信順・日付なし、その後顧客待ちと終了候補', () => {
  const red = (id, date, created_at = lead.created_at) => classifyLead({ ...lead, id, preferred_date: date, created_at }, [], now);
  const yellow = classifyLead({ ...lead, id: 'yellow' }, [msg('outbound', '25')], now);
  const white = classifyLead({ ...lead, id: 'white', preferred_date: '2026-10-01' }, [], now);
  const values = [white, red('none', ''), red('late', '2026-12-01'), yellow, red('early-new', '2026-11-01', '2026-10-22'), red('early-old', '2026-11-01')];
  assert.deepEqual(sortLeads(values).map(l => l.id), ['early-old', 'early-new', 'late', 'none', 'yellow', 'white']);
});
test('8: 認証なしのmainは試した全パスを1行で出しexit 0を返す', async t => {
  t.mock.method(os, 'homedir', () => '/mock-home');
  t.mock.method(fs, 'existsSync', () => false);
  t.mock.method(fs.promises, 'readFile', () => { assert.fail('存在しないファイルを読まない'); });
  const output = [];
  const code = await main({
    env: { SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', EVENT_SHOP_ENV_FILE: '/tmp/nonexistent-inquiry-triage-env-827361' },
    fetchImpl: () => { assert.fail('認証なしでネットワークにアクセスしない'); },
    log: value => output.push(value),
  });
  assert.equal(code, 0);
  assert.equal(output.length, 1);
  assert.equal(output[0], `イベント百貨店問合せ: 未確認（認証情報なし。試したパス: /tmp/nonexistent-inquiry-triage-env-827361, ${path.join('/mock-home', 'event-shop', '.env.local')}, D:/Claude/event-shop/.env.local）`);
});

for (const scenario of [
  { name: '明示パスを最優先', explicit: '/explicit/.env.local', existing: [0, 1, 2], selected: 0 },
  { name: '環境変数なしでホーム配下を選ぶ', existing: [0, 1], selected: 0 },
  { name: '明示パスがなければホーム配下を選ぶ', explicit: '/missing/.env.local', existing: [1, 2], selected: 1 },
  { name: 'ホーム配下もなければ旧PCパスを選ぶ', explicit: '/missing/.env.local', existing: [2], selected: 2 },
]) {
  test(`認証ファイル探索: ${scenario.name}`, async t => {
    t.mock.method(os, 'homedir', () => '/mock-home');
    const candidates = [scenario.explicit, path.join('/mock-home', 'event-shop', '.env.local'), 'D:/Claude/event-shop/.env.local'].filter(Boolean);
    const checked = [];
    t.mock.method(fs, 'existsSync', candidate => {
      checked.push(candidate);
      return scenario.existing.some(index => candidates[index] === candidate);
    });
    t.mock.method(fs.promises, 'readFile', async (file, encoding) => {
      assert.equal(file, candidates[scenario.selected]);
      assert.equal(encoding, 'utf8');
      return 'NEXT_PUBLIC_SUPABASE_URL="https://example.invalid"\nSUPABASE_SECRET_KEY="test-key"\n';
    });
    const credentials = await loadCredentials({ EVENT_SHOP_ENV_FILE: scenario.explicit });
    assert.deepEqual(credentials, { url: 'https://example.invalid', key: 'test-key', path: candidates[scenario.selected] });
    assert.deepEqual(checked, candidates.slice(0, scenario.selected + 1));
  });
}

test('認証ファイル探索: 最初のファイルが空でも後続を読まない', async t => {
  t.mock.method(fs, 'existsSync', () => true);
  t.mock.method(fs.promises, 'readFile', async file => {
    assert.equal(file, '/explicit/.env.local');
    return '';
  });
  assert.deepEqual(await loadCredentials({ EVENT_SHOP_ENV_FILE: '/explicit/.env.local' }), {
    url: undefined, key: undefined, path: '/explicit/.env.local',
  });
});
test('メールの重複除去はmessage id、なければ日時と方向', () => {
  const a = { ...msg('inbound', '25'), rfc822_message_id: '<one>' };
  assert.equal(deduplicateMessages([a, { ...a }, msg('outbound', '24'), msg('outbound', '24')]).length, 2);
});
test('自動返信のみの顧客は顧客待ち', () => {
  const result = classifyLead(lead, [msg('outbound', '23'), { ...msg('inbound', '25', '※こちらは自動返信メッセージです'), subject: undefined }], now);
  assert.equal(result.category, '🟡 顧客待ち');
});
test('自動返信より前に本物の返信があれば要返信のまま', () => {
  const result = classifyLead(lead, [msg('outbound', '22'), { ...msg('inbound', '24', '※こちらは自動返信メッセージです'), subject: undefined }, msg('inbound', '26', '御見積書をお送りください')], now);
  assert.equal(result.category, '🔴 要返信');
  assert.equal(result.nextAction, '顧客の返信に未回答: 御見積書をお送りください');
});
test('本文で過去の不在に触れた顧客返信は要返信', () => {
  const result = classifyLead(lead, [msg('outbound', '23'), { ...msg('inbound', '25', '先週は不在にしておりました。御見積書をお送りください'), subject: undefined }], now);
  assert.equal(result.category, '🔴 要返信');
});
test('自動送信と記載された問合せフォーム通知は要返信', () => {
  const result = classifyLead(lead, [msg('outbound', '23'), { ...msg('inbound', '25', 'このメールは自動送信されています。お問い合わせ内容: ブース制作の相談'), subject: undefined }], now);
  assert.equal(result.category, '🔴 要返信');
});
test('完了済み・社内・連携テストを除外', () => {
  assert.equal(deduplicateLeads([
    { ...lead, raw_payload: { event_shop: { closed_at: 'x' } } },
    { ...lead, email: 'someone@orgiast.jp' }, { ...lead, email: 'someone@event-shop.jp' },
    { ...lead, company_name: '連携テスト株式会社' },
  ]).leads.length, 0);
});
test('メール検索は受信日必須、企業ドメインまたはフリーメール全体を使用', () => {
  assert.match(messageQuery(lead), /received_at=gte.2026-10-21/);
  assert.match(messageQuery(lead), /ilike.\*example.com\*/);
  assert.match(messageQuery({ ...lead, email: 'a+b@gmail.com' }), /a%2Bb%40gmail.com/);
});
test('mainはmock fetchで認証ヘッダ・検索・JSON・quiet・API失敗を検証', async () => {
  const env = { SUPABASE_URL: 'https://example.invalid', SUPABASE_SERVICE_ROLE_KEY: 'test' };
  const calls = [], output = [];
  const fetchImpl = async (url, options) => {
    calls.push(url);
    assert.equal(options.headers.apikey, 'test');
    assert.equal(options.headers.Authorization, 'Bearer test');
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: true, json: async () => url.includes('quote_requests?') ? [lead] : [] };
  };
  assert.equal(await main({ env, now, args: ['--json'], fetchImpl, log: s => output.push(s) }), 0);
  assert.equal(JSON.parse(output[0])[0].category, '🔴 要返信');
  assert.match(calls[0], /created_at=gte.2026-06-29/);
  const quiet = [];
  await main({ env, now, args: ['--quiet'], fetchImpl: async () => ({ ok: true, json: async () => [] }), log: s => quiet.push(s) });
  assert.deepEqual(quiet, []);
  await main({ env, now, fetchImpl: async () => ({ ok: false, status: 503, statusText: 'Unavailable' }), log: s => quiet.push(s) });
  assert.equal(quiet[0], 'イベント百貨店問合せ: 未確認（503 Unavailable）');
});
test('Markdownの件数・日時・リンク・重複注記・セルエスケープ', () => {
  const output = renderMarkdown([classifyLead({ ...lead, company_name: 'A|B' }, [], now)], 1, now);
  assert.match(output, /2026-10-27 12:00/);
  assert.match(output, /重複 1 件/);
  assert.match(output, /A\\\|B/);
  assert.match(output, /https:\/\/event-shop.jp\/admin\/inquiries\/a/);
  assert.match(renderMarkdown([], 0, now), /^## ✅/);
});
