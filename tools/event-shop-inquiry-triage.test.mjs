import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyLead, checkGmailDrafts, deduplicateLeads, deduplicateMessages, sortLeads, main, messageQuery, renderMarkdown, loadCredentials, findOpenInboxAsk, resolveReplyDraftApproval, isOrderConfirmed } from './event-shop-inquiry-triage.mjs';
const now = new Date('2026-10-27T03:00:00Z');
const lead = { id: 'a', email: 'client@example.com', company_name: '会社', contact_name: '担当', created_at: '2026-10-21T03:00:00Z', preferred_date: '2026-11-18', raw_payload: { product: '展示会' } };
const msg = (direction, day, body = '') => ({ direction, received_at: `2026-10-${day}T03:00:00Z`, body });
test('1: 初回未送信と下書き', async () => {
  const result = await classifyLead(lead, [], now);
  assert.equal(result.category, '🔴 要返信');
  assert.match(result.nextAction, /初回返信が未送信.*下書きなし/);
  assert.match((await classifyLead({ ...lead, raw_payload: { event_shop: { draft_saved_at: 'x' } } }, [], now)).nextAction, /管理画面に下書きあり・未送信/);
});
test('2: 顧客からの見積依頼と引用・挨拶の除去', async () => {
  const result = await classifyLead(lead, [msg('outbound', '23'), msg('inbound', '25', '> 今回は辞退\n山田様\nお世話になっております。\n担当です。\n御見積書を頂くことは可能でしょうか')], now);
  assert.equal(result.category, '🔴 要返信');
  assert.equal(result.nextAction, '顧客の返信に未回答: 御見積書を頂くことは可能でしょうか');
});
test('3: 辞退は終了候補', async () => {
  assert.equal((await classifyLead(lead, [msg('inbound', '25', '必要な際は改めてご連絡させていただきます')], now)).category, '⚪ 終了候補');
});
test('4: 10日経過で追客候補', async () => {
  const result = await classifyLead(lead, [msg('outbound', '17')], now);
  assert.equal(result.category, '🟡 顧客待ち');
  assert.match(result.nextAction, /10 日.*追客候補/);
});
test('4b: 追客候補に下書きとkim-inboxの状態を併記', async () => {
  const messages = [msg('outbound', '17')];
  const classify = deps => classifyLead(lead, messages, now, deps);
  assert.equal((await classify({ gmailDraftCheck: async () => ({ found: true, account: 'seisaku-team@orgiast.jp' }), kimInboxCheck: async () => ({ id: 'ask-both' }) })).nextAction,
    '顧客の返信待ち（最終送信から 10 日）・追客下書き済み・kim 承認待ち（下書き: seisaku-team@orgiast.jp / inbox: ask-both）');
  assert.match((await classify({ gmailDraftCheck: async () => ({ found: true, account: 'kim@orgiast.jp' }), kimInboxCheck: async () => null })).nextAction, /下書きあり: kim@orgiast.jp・kim-inbox 未登録/);
  assert.match((await classify({ gmailDraftCheck: async () => ({ found: false }), kimInboxCheck: async () => ({ id: 'ask-only' }) })).nextAction, /kim-inbox 承認待ち: ask-only・下書きなし/);
  assert.equal((await classify({ gmailDraftCheck: async () => ({ found: false }), kimInboxCheck: async () => null })).nextAction, '顧客の返信待ち（最終送信から 10 日）・追客候補');
});
test('4c: 追客候補の照会エラーは未確認とし、7日未満では照会しない', async () => {
  const fail = async () => { throw new Error('failure'); };
  assert.match((await classifyLead(lead, [msg('outbound', '17')], now, { gmailDraftCheck: fail, kimInboxCheck: async () => null })).nextAction, /下書き: 未確認/);
  assert.match((await classifyLead(lead, [msg('outbound', '17')], now, { gmailDraftCheck: async () => ({ found: false }), kimInboxCheck: fail })).nextAction, /kim-inbox: 未確認/);
  let calls = 0;
  await classifyLead(lead, [msg('outbound', '25')], now, { gmailDraftCheck: async () => { calls++; }, kimInboxCheck: async () => { calls++; } });
  assert.equal(calls, 0);
  assert.equal((await classifyLead(lead, [msg('outbound', '17')], now, { gmailDraftCheck: async () => ({ found: true }) })).nextAction,
    '顧客の返信待ち（最終送信から 10 日）・追客候補');
});
test('4d: 受注確定済み（TAO）は追客候補にせず下書き照会しない', async () => {
  const triageNow = new Date('2026-11-26T10:31:00Z');
  const inbound = {
    direction: 'inbound',
    received_at: '2026-11-18T08:43:00Z',
    body: 'お申し込み書を本メールに添付のうえ、ご返送いたします。手配の進行をよろしくお願いいたします。',
  };
  const outbound = {
    direction: 'outbound',
    received_at: '2026-11-18T10:31:00Z',
    body: 'ご記入・ご捺印いただいたお申し込み書と関連資料を確かに受領いたしました。以下の内容で手配を進めてまいります。■ご注文内容',
  };
  let draftCalls = 0;
  let inboxCalls = 0;
  const result = await classifyLead(
    { ...lead, company_name: '株式会社TAO', contact_name: '中田', preferred_date: '2026-12-09' },
    [inbound, outbound],
    triageNow,
    {
      gmailDraftCheck: async () => { draftCalls++; return { found: false }; },
      kimInboxCheck: async () => { inboxCalls++; return null; },
    },
  );
  assert.equal(result.category, '🟡 顧客待ち');
  assert.equal(result.nextAction, '受注済み・手配中（追客不要・最終送信から 8 日）');
  assert.doesNotMatch(result.nextAction, /追客候補/);
  assert.equal(draftCalls, 0);
  assert.equal(inboxCalls, 0);
});
test('4e: 当社の見積送付だけでは7日経過でも追客候補のまま', async () => {
  const triageNow = new Date('2026-11-26T03:00:00Z');
  const outbound = {
    direction: 'outbound',
    received_at: '2026-11-18T03:00:00Z',
    body: 'お見積書とお申し込み書を添付いたしました。ご検討のほどよろしくお願いいたします。',
  };
  const result = await classifyLead(
    { ...lead, preferred_date: '2026-12-09' },
    [outbound],
    triageNow,
    {
      gmailDraftCheck: async () => ({ found: false }),
      kimInboxCheck: async () => null,
    },
  );
  assert.equal(result.category, '🟡 顧客待ち');
  assert.equal(result.nextAction, '顧客の返信待ち（最終送信から 8 日）・追客候補');
});
test('isOrderConfirmed: 当社受領・手配開始と顧客の申込書返送を検知し、見積添付だけでは false', () => {
  assert.equal(isOrderConfirmed(
    { body: 'お申し込み書を本メールに添付のうえ、ご返送いたします。' },
    { body: 'お申し込み書を確かに受領いたしました。手配を進めてまいります。' },
  ), true);
  assert.equal(isOrderConfirmed(
    { body: '注文書を送付します。' },
    { body: 'ご確認ください。' },
  ), true);
  assert.equal(isOrderConfirmed(
    { body: 'ご注文を承りました。' },
    { body: 'ご注文を承りました。' },
  ), true);
  assert.equal(isOrderConfirmed(
    { body: '見積をお願いします。' },
    { body: 'お見積書とお申し込み書を添付いたしました。ご検討ください。' },
  ), false);
  assert.equal(isOrderConfirmed(null, null), false);
});
test('findOpenInboxAsk: email・企業ドメイン・法人格除去社名に一致し、対象外を除く', () => {
  const item = (id, text, overrides = {}) => ({ id, text, status: 'open', kind: 'ask', ...overrides });
  assert.deepEqual(findOpenInboxAsk(lead, { items: [item('email', 'CLIENT@EXAMPLE.COM の承認')] }), { id: 'email' });
  assert.deepEqual(findOpenInboxAsk(lead, { items: [item('domain', 'example.com 宛ての追客')] }), { id: 'domain' });
  assert.deepEqual(findOpenInboxAsk({ ...lead, company_name: '株式会社 熊メディア' }, { items: [item('company', '熊メディアへの追客')] }), { id: 'company' });
  assert.equal(findOpenInboxAsk({ ...lead, email: 'person@gmail.com', company_name: '会社' }, { items: [item('free', 'gmail.com の案件')] }), null);
  assert.equal(findOpenInboxAsk(lead, { items: [item('answered', 'client@example.com', { status: 'answered' }), item('info', 'client@example.com', { kind: 'info' })] }), null);
});
test('5: 過去の開催日は未送信でも終了候補、当日は要返信', async () => {
  assert.equal((await classifyLead({ ...lead, preferred_date: '2026-10-26' }, [], now)).nextAction, '開催日経過→管理画面で完了に');
  assert.equal((await classifyLead({ ...lead, preferred_date: '2026-10-27' }, [], now)).category, '🔴 要返信');
});
test('5b: 開催日経過でも直近の未回答返信があれば要返信（博展 10/25 の事例）', async () => {
  const result = await classifyLead({ ...lead, preferred_date: '2026-09-29' }, [msg('outbound', '25'), { ...msg('inbound', '25', '金様\nお世話になります。\nご検討ありがとうございます。\n一度御見積書を頂くことは可能でしょうか。'), received_at: '2026-10-25T23:12:00Z' }], now);
  assert.equal(result.category, '🔴 要返信');
  assert.equal(result.nextAction, '顧客の返信に未回答: 一度御見積書を頂くことは可能でしょうか。');
  assert.equal((await classifyLead({ ...lead, preferred_date: '2026-09-29' }, [msg('outbound', '01'), msg('inbound', '05', '質問です')], now)).category, '⚪ 終了候補');
});
test('5c: 抜粋は挨拶・お詫びの定型行を飛ばす', async () => {
  const result = await classifyLead(lead, [msg('outbound', '22'), msg('inbound', '26', 'オージャスト様\nお世話になっております。Cocoliveの五月女です。\nお待たせしてしまい恐れ入ります。\n先日ご依頼いただきました、4点について回答させていただきます。')], now);
  assert.equal(result.nextAction, '顧客の返信に未回答: 先日ご依頼いただきました、4点について回答させていただきます。');
});
test('3b: 別社・他社・またの機会の辞退を終了候補にする（2026-11-15 実害）', async () => {
  const body = `ご担当者様
お世話になります。

本件、こちらが大阪になるため関東への受け取り、ご返却が難しく、
別社にて対応いただく予定となりました。

お手数をおかけいたしました。
またの機会がございましたらぜひよろしくお願いいたします。`;
  const result = await classifyLead(lead, [msg('inbound', '15', body)], now);
  assert.equal(result.category, '⚪ 終了候補');
  assert.match(result.nextAction, /辞退/);
});
test('3c: 他社様の事例は質問文であり誤爆しない', async () => {
  const body = `佐藤様

お世話になっております。
他社様の事例などあれば教えていただけますでしょうか。`;
  const result = await classifyLead(lead, [msg('inbound', '15', body)], now);
  assert.equal(result.category, '🔴 要返信');
});
test('3d: 「他社の見積もりと比較したい」は要返信（誤爆防止）', async () => {
  const body = '他社の見積もりと比較したいので、御見積書をいただけますか。';
  const result = await classifyLead(lead, [msg('inbound', '15', body)], now);
  assert.equal(result.category, '🔴 要返信');
});
test('3e: 「キャンセル料は何日前から」は要返信（誤爆防止）', async () => {
  const body = 'キャンセル料は何日前から発生しますか。';
  const result = await classifyLead(lead, [msg('inbound', '15', body)], now);
  assert.equal(result.category, '🔴 要返信');
});
test('6: 同じemail/productの1日差は最新だけを残す', () => {
  const newer = { ...lead, id: 'new', created_at: '2026-10-22T03:00:00Z' };
  assert.deepEqual(deduplicateLeads([lead, newer]), { leads: [newer], duplicateCount: 1 });
  assert.equal(deduplicateLeads([lead, { ...newer, raw_payload: { product: '別商品' } }]).leads.length, 2);
  assert.equal(deduplicateLeads([lead, { ...newer, created_at: '2026-10-24T03:00:00Z' }]).leads.length, 2);
});
test('7: 要返信の開催日順・受信順・日付なし、その後顧客待ちと終了候補', async () => {
  const red = async (id, date, created_at = lead.created_at) => classifyLead({ ...lead, id, preferred_date: date, created_at }, [], now);
  const yellow = await classifyLead({ ...lead, id: 'yellow' }, [msg('outbound', '25')], now);
  const white = await classifyLead({ ...lead, id: 'white', preferred_date: '2026-10-01' }, [], now);
  const values = [white, await red('none', ''), await red('late', '2026-12-01'), yellow, await red('early-new', '2026-11-01', '2026-10-22'), await red('early-old', '2026-11-01')];
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
test('自動返信のみの顧客は顧客待ち', async () => {
  const result = await classifyLead(lead, [msg('outbound', '23'), { ...msg('inbound', '25', '※こちらは自動返信メッセージです'), subject: undefined }], now);
  assert.equal(result.category, '🟡 顧客待ち');
});
test('自動返信より前に本物の返信があれば要返信のまま', async () => {
  const result = await classifyLead(lead, [msg('outbound', '22'), { ...msg('inbound', '24', '※こちらは自動返信メッセージです'), subject: undefined }, msg('inbound', '26', '御見積書をお送りください')], now);
  assert.equal(result.category, '🔴 要返信');
  assert.equal(result.nextAction, '顧客の返信に未回答: 御見積書をお送りください');
});
test('本文で過去の不在に触れた顧客返信は要返信', async () => {
  const result = await classifyLead(lead, [msg('outbound', '23'), { ...msg('inbound', '25', '先週は不在にしておりました。御見積書をお送りください'), subject: undefined }], now);
  assert.equal(result.category, '🔴 要返信');
});
test('自動送信と記載された問合せフォーム通知は要返信', async () => {
  const result = await classifyLead(lead, [msg('outbound', '23'), { ...msg('inbound', '25', 'このメールは自動送信されています。お問い合わせ内容: ブース制作の相談'), subject: undefined }], now);
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
test('Markdownの件数・日時・リンク・重複注記・セルエスケープ', async () => {
  const output = renderMarkdown([await classifyLead({ ...lead, company_name: 'A|B' }, [], now)], 1, now);
  assert.match(output, /2026-10-27 12:00/);
  assert.match(output, /重複 1 件/);
  assert.match(output, /A\\\|B/);
  assert.match(output, /https:\/\/event-shop.jp\/admin\/inquiries\/a/);
  assert.match(renderMarkdown([], 0, now), /^## ✅/);
});
test('checkGmailDrafts: Gmail下書きあり（seisaku-team）', async () => {
  const calls = [];
  const getToken = async ({ user, scope }) => {
    calls.push({ user, scope });
    return 'mock-token';
  };
  let fetchCount = 0;
  const fetchImpl = async (url, options) => {
    fetchCount++;
    // 1回目(seisaku-team): 下書きあり / 2回目(kim): 下書きなし
    if (fetchCount === 1) {
      return { ok: true, json: async () => ({ drafts: [{ id: 'r-test-draft-id' }] }) };
    }
    return { ok: true, json: async () => ({ drafts: [] }) };
  };
  const result = await checkGmailDrafts('ishii@growth-verse.ai', { fetchImpl, getToken });
  assert.deepEqual(result, { found: true, account: 'seisaku-team@orgiast.jp', draftId: 'r-test-draft-id' });
  assert.equal(calls[0].user, 'seisaku-team@orgiast.jp');
  assert.match(calls[0].scope, /gmail\.readonly/);
});
test('checkGmailDrafts: Gmail下書きあり（kim）', async () => {
  let callIndex = 0;
  const getToken = async ({ user, scope }) => 'mock-token';
  const fetchImpl = async (url, options) => {
    callIndex++;
    if (callIndex <= 1) return { ok: true, json: async () => ({ drafts: [] }) }; // seisaku-team: なし
    return { ok: true, json: async () => ({ drafts: [{ id: 'r-kim-draft' }] }) }; // kim: あり
  };
  const result = await checkGmailDrafts('client@example.com', { fetchImpl, getToken });
  assert.deepEqual(result, { found: true, account: 'kim@orgiast.jp', draftId: 'r-kim-draft' });
});
test('checkGmailDrafts: 下書きなし', async () => {
  let callIndex = 0;
  const getToken = async ({ user, scope }) => 'mock-token';
  const fetchImpl = async (url, options) => {
    callIndex++;
    return { ok: true, json: async () => ({ drafts: [] }) };
  };
  const result = await checkGmailDrafts('nobody@example.com', { fetchImpl, getToken });
  assert.deepEqual(result, { found: false });
  assert.equal(callIndex, 2); // 両アカウントをチェック
});
test('checkGmailDrafts: API失敗は未確認として続行', async () => {
  let callIndex = 0;
  const getToken = async ({ user, scope }) => 'mock-token';
  const fetchImpl = async (url, options) => {
    callIndex++;
    if (callIndex <= 1) throw new Error('network error'); // seisaku-team: failure
    return { ok: true, json: async () => ({ drafts: [{ id: 'r-recovered' }] }) }; // kim: あり
  };
  const result = await checkGmailDrafts('recover@example.com', { fetchImpl, getToken });
  assert.deepEqual(result, { found: true, account: 'kim@orgiast.jp', draftId: 'r-recovered' });
  assert.equal(callIndex, 2); // 両方試行
});
test('checkGmailDrafts: 全API失敗でエラーを返す', async () => {
  const getToken = async ({ user, scope }) => { throw new Error('token error'); };
  const fetchImpl = async () => { throw new Error('network error'); };
  const result = await checkGmailDrafts('fail@example.com', { fetchImpl, getToken });
  assert.deepEqual(result, { found: false, error: 'kim@orgiast.jp: token error' });
});
test('checkGmailDrafts: 両アカウントHTTP 403でエラーを返す', async () => {
  let callIndex = 0;
  const getToken = async ({ user, scope }) => 'mock-token';
  const fetchImpl = async (url, options) => {
    callIndex++;
    return { ok: false, status: 403 };
  };
  const result = await checkGmailDrafts('forbidden@example.com', { fetchImpl, getToken });
  assert.deepEqual(result, { found: false, error: 'kim@orgiast.jp: HTTP 403' });
  assert.equal(callIndex, 2); // 両方試行
});
test('checkGmailDrafts: 1アカウント失敗・他は下書きなしでエラーを返す', async () => {
  let callIndex = 0;
  const getToken = async ({ user, scope }) => 'mock-token';
  const fetchImpl = async (url, options) => {
    callIndex++;
    if (callIndex <= 1) return { ok: false, status: 403 }; // seisaku-team: 失敗
    return { ok: true, json: async () => ({ drafts: [] }) }; // kim: 下書きなし
  };
  const result = await checkGmailDrafts('half-fail@example.com', { fetchImpl, getToken });
  assert.deepEqual(result, { found: false, error: 'seisaku-team@orgiast.jp: HTTP 403' });
  assert.equal(callIndex, 2); // 両方試行
});
test('classifyLead: deps.gmailDraftCheck でGmail下書きあり', async () => {
  const gmailDraftCheck = async (email) => {
    assert.equal(email, 'client@example.com');
    return { found: true, account: 'seisaku-team@orgiast.jp', draftId: 'r-test-123' };
  };
  const result = await classifyLead(lead, [], now, { gmailDraftCheck });
  assert.equal(result.category, '🔴 要返信');
  assert.equal(result.nextAction, '初回返信が未送信（Gmail下書きあり: seisaku-team@orgiast.jp r-test-123・承認待ち）');
});
test('classifyLead: deps.gmailDraftCheck でGmail下書き確認失敗', async () => {
  const gmailDraftCheck = async (email) => ({ found: false, error: 'API error' });
  const result = await classifyLead(lead, [], now, { gmailDraftCheck });
  assert.equal(result.category, '🔴 要返信');
  assert.match(result.nextAction, /Gmail下書き: 未確認/);
});
test('classifyLead: deps.gmailDraftCheck でGmail下書きなし・管理画面下書きあり', async () => {
  const gmailDraftCheck = async (email) => ({ found: false });
  const result = await classifyLead(
    { ...lead, raw_payload: { event_shop: { draft_saved_at: '2026-10-25T10:00:00Z' } } },
    [], now, { gmailDraftCheck },
  );
  assert.equal(result.category, '🔴 要返信');
  assert.match(result.nextAction, /管理画面に下書きあり・未送信/);
});
test('classifyLead: deps.gmailDraftCheck でGmail下書きなし・管理画面下書きなし', async () => {
  const gmailDraftCheck = async (email) => ({ found: false });
  const result = await classifyLead(lead, [], now, { gmailDraftCheck });
  assert.equal(result.category, '🔴 要返信');
  assert.match(result.nextAction, /下書きなし/);
});
test('resolveReplyDraftApproval: 下書きあり（顧客最新より新しい）→ 承認待ち', () => {
  const result = resolveReplyDraftApproval({
    lastInboundAt: '2026-11-25T05:16:00Z',
    draft: { found: true, account: 'seisaku-team@orgiast.jp', draftId: 'r1', date: '2026-11-26T01:17:00Z' },
    inbox: { id: 'ki-20261126012107-6f10' },
  });
  assert.deepEqual(result, {
    category: '🟠 返信下書き済み・kim 承認待ち',
    nextAction: '下書き: seisaku-team@orgiast.jp / inbox: ki-20261126012107-6f10',
  });
});
test('resolveReplyDraftApproval: 下書きの方が古い → null（要返信のまま）', () => {
  assert.equal(resolveReplyDraftApproval({
    lastInboundAt: '2026-11-26T05:00:00Z',
    draft: { found: true, account: 'seisaku-team@orgiast.jp', draftId: 'r1', date: '2026-11-25T01:00:00Z' },
    inbox: { id: 'ki-old' },
  }), null);
});
test('resolveReplyDraftApproval: 下書きなし → null', () => {
  assert.equal(resolveReplyDraftApproval({
    lastInboundAt: '2026-11-25T05:16:00Z',
    draft: { found: false },
    inbox: { id: 'ki-any' },
  }), null);
  assert.equal(resolveReplyDraftApproval({
    lastInboundAt: '2026-11-25T05:16:00Z',
    draft: { found: true, account: 'seisaku-team@orgiast.jp', draftId: 'r1', date: '2026-11-26T01:17:00Z' },
    inbox: null,
  }), null);
  assert.equal(resolveReplyDraftApproval({
    lastInboundAt: '2026-11-25T05:16:00Z',
    draft: { found: true, account: 'seisaku-team@orgiast.jp', draftId: 'r1' },
    inbox: { id: 'ki-no-date' },
  }), null);
});
test('classifyLead: 顧客返信あっても新しい下書き+inboxなら承認待ち', async () => {
  const messages = [msg('outbound', '20'), msg('inbound', '25', '申込書を送ります')];
  const result = await classifyLead(lead, messages, now, {
    gmailDraftCheck: async () => ({ found: true, account: 'seisaku-team@orgiast.jp', draftId: 'r-reply', date: '2026-10-26T12:00:00Z' }),
    kimInboxCheck: async () => ({ id: 'ki-reply' }),
  });
  assert.equal(result.category, '🟠 返信下書き済み・kim 承認待ち');
  assert.equal(result.nextAction, '下書き: seisaku-team@orgiast.jp / inbox: ki-reply');
});
test('classifyLead: 下書きが顧客メールより古い／照会失敗は要返信のまま', async () => {
  const messages = [msg('outbound', '20'), msg('inbound', '25', '御見積書をお送りください')];
  const older = await classifyLead(lead, messages, now, {
    gmailDraftCheck: async () => ({ found: true, account: 'seisaku-team@orgiast.jp', draftId: 'r-old', date: '2026-10-24T12:00:00Z' }),
    kimInboxCheck: async () => ({ id: 'ki-old' }),
  });
  assert.equal(older.category, '🔴 要返信');
  assert.match(older.nextAction, /顧客の返信に未回答/);
  const failed = await classifyLead(lead, messages, now, {
    gmailDraftCheck: async () => { throw new Error('network'); },
    kimInboxCheck: async () => { throw new Error('inbox'); },
  });
  assert.equal(failed.category, '🔴 要返信');
  assert.match(failed.nextAction, /顧客の返信に未回答/);
});
test('Markdown見出しに返信下書き済み件数を出す', async () => {
  const orange = await classifyLead(lead, [msg('outbound', '20'), msg('inbound', '25', '質問です')], now, {
    gmailDraftCheck: async () => ({ found: true, account: 'seisaku-team@orgiast.jp', draftId: 'r', date: '2026-10-26T12:00:00Z' }),
    kimInboxCheck: async () => ({ id: 'ki-md' }),
  });
  const output = renderMarkdown([orange], 0, now);
  assert.match(output, /要返信 0 件 \/ 返信下書き済み 1 件/);
  assert.match(output, /^## 🟠/);
});
