import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, evaluateGateSkips, evaluateTop3Delivery, parseDunningSummary, evaluateDunningDelivery } from './cron-liveness-check.mjs';

const now = Date.parse('2026-08-21T00:00:00.000Z');
const entry = { label: '日次', repo: 'owner/repo', workflow: 'daily.yml', everyDays: 1 };
const key = 'owner/repo#daily.yml';

const dunningSummary = {
  evaluated: 236,
  items: [{ customerName: '非公開顧客名', token: 'secret-token-do-not-display' }],
  dmSent: 1, dmFailed: 0, channelPosted: false, invoicePosted: false,
  errors: [
    '責任者グループ投稿失敗: Discord HTTP 403: {"message": "Missing Access", "code": 50001}',
    '請求チャンネル投稿失敗: Discord HTTP 403',
  ],
};

test('dunning: プレフィックスとANSIコマンドエコーを含む実ログ形式から要約を読む', () => {
  const prefix = 'push\tUNKNOWN STEP\t2026-09-22T01:57:59.9356272Z ';
  const log = [
    `${prefix}##[group]Run curl -sS --fail-with-body -m 120 \\`,
    `${prefix}\u001b[36;1mcurl -H 'Content-Type: application/json' -d '${JSON.stringify(dunningSummary)}'\u001b[0m`,
    `${prefix}${JSON.stringify(dunningSummary)}`,
    `${prefix}Cleaning up orphan processes`,
  ].join('\n');
  assert.deepEqual(parseDunningSummary(log), dunningSummary);
  assert.equal(parseDunningSummary(log.split('\n').slice(0, 2).join('\n')), null);
});

test('dunning: 無関係なJSONと要約の必須配列がないJSONを拾わない', () => {
  for (const value of [{ evaluated: 'x' }, { foo: 1 }, { evaluated: 'x', items: [], errors: [] }, { evaluated: 1, items: [] }, { evaluated: 1, errors: [] }]) {
    assert.equal(parseDunningSummary(JSON.stringify(value)), null);
  }
});

test('dunning: 非文字列・該当なし・不正JSONは投げずnull', () => {
  for (const value of [null, undefined, 1, {}, [], '', 'no summary', '{broken json']) {
    assert.equal(parseDunningSummary(value), null);
  }
});

test('dunning: 複数の要約があれば最後を採用する', () => {
  const last = { ...dunningSummary, errors: [] };
  assert.deepEqual(parseDunningSummary([dunningSummary, last, { foo: 1 }].map(JSON.stringify).join('\n')), last);
});

test('dunning: errors非空なら件数と最初のエラーでalert', () => {
  assert.deepEqual(evaluateDunningDelivery(dunningSummary, now), {
    key: 'aujust#dunning-push#delivery', label: 'aujust督促(配達)', lastSuccess: null, ageDays: null, status: 'alert',
    line: `🚨 aujust督促(配達): 直近runで 2件の失敗 — ${dunningSummary.errors[0]}`,
  });
});

test('dunning: エラーの改行を潰し先頭120文字に制限する', () => {
  const first = '失敗\r\n詳細\n' + 'あ'.repeat(150);
  const actual = evaluateDunningDelivery({ ...dunningSummary, errors: [first, '表示しない2件目'] }, now);
  assert.equal(actual.line, `🚨 aujust督促(配達): 直近runで 2件の失敗 — ${first.replace(/[\r\n]+/g, ' ').slice(0, 120)}`);
});

test('dunning: 対象0件でチャンネル未投稿でもerrorsが空ならok', () => {
  const actual = evaluateDunningDelivery({ ...dunningSummary, items: [], dmSent: 0, errors: [] }, now);
  assert.equal(actual.status, 'ok');
  assert.equal(actual.line, '✅ aujust督促(配達): 対象 0件 / DM 0 / チャンネル false / 請求 false');
});

test('dunning: 取得失敗と要約なしは異なるunknown文言', () => {
  for (const [summary, message] of [[undefined, '実行ログを取得できません'], [null, '実行ログから配達結果を読めません']]) {
    const actual = evaluateDunningDelivery(summary);
    assert.equal(actual.status, 'unknown');
    assert.equal(actual.line, `⚠️ aujust督促(配達): ${message}`);
  }
});

test('dunning: 正常時の件数・DM・投稿結果を表示し不正な型は?にする', () => {
  const actual = evaluateDunningDelivery({ ...dunningSummary, errors: [], channelPosted: true }, now);
  assert.equal(actual.line, '✅ aujust督促(配達): 対象 1件 / DM 1 / チャンネル true / 請求 false');
  const invalid = evaluateDunningDelivery({ ...dunningSummary, errors: [], dmSent: 'secret', channelPosted: 'secret', invoicePosted: undefined }, now);
  assert.equal(invalid.line, '✅ aujust督促(配達): 対象 1件 / DM ? / チャンネル ? / 請求 ?');
});

test('dunning: 顧客名や要約内のトークンをlineに含めない', () => {
  for (const errors of [[], dunningSummary.errors]) {
    const actual = evaluateDunningDelivery({ ...dunningSummary, errors, token: 'top-level-secret-token' }, now);
    assert.doesNotMatch(actual.line, /非公開顧客名|secret-token-do-not-display|top-level-secret-token/);
  }
});

function result(value) {
  return evaluate([entry], { [key]: value }, now)[0];
}

test('直近のschedule成功はok', () => {
  const actual = result('2026-08-20T00:00:00.000Z');
  assert.equal(actual.status, 'ok');
  assert.match(actual.line, /^✅/);
});

test('許容期間を超えたschedule成功はstale', () => {
  const actual = result('2026-08-19T00:00:00.000Z');
  assert.equal(actual.status, 'stale');
  assert.match(actual.line, /^🚨/);
});

test('schedule成功履歴なしはnever', () => {
  const actual = result(null);
  assert.equal(actual.status, 'never');
  assert.equal(actual.lastSuccess, null);
});

test('取得失敗はunknown', () => {
  const actual = evaluate([entry], {}, now)[0];
  assert.equal(actual.status, 'unknown');
  assert.match(actual.line, /^⚠️/);
});

test('境界値はok、境界を超えるとstale', () => {
  assert.equal(result('2026-08-19T12:00:00.000Z').status, 'ok');
  assert.equal(result('2026-08-19T11:59:59.999Z').status, 'stale');
});

test('直近7日のgateスキップ3件で警報', () => {
  const records = [1, 2, 3].map((days) => ({ ts: new Date(now - days * 864e5).toISOString(), reasonCode: 'no-path' }));
  assert.match(evaluateGateSkips(records, now).line, /🚨 gate判定スキップ（要調査）3件/);
});

test('unreadableだけなら10件でもgateスキップ警報を出さない', () => {
  const records = Array.from({ length: 10 }, (_, index) => ({ ts: new Date(now - index * 36e5).toISOString(), reasonCode: 'unreadable' }));
  assert.equal(evaluateGateSkips(records, now), null);
});

test('reasonCodeなしの旧記録はgateスキップ警報に数えない', () => {
  const records = Array.from({ length: 10 }, (_, index) => ({ ts: new Date(now - index * 36e5).toISOString() }));
  assert.equal(evaluateGateSkips(records, now), null);
});

test('unreadable 8件と要調査3件なら要調査分だけ警報に数える', () => {
  const unreadable = Array.from({ length: 8 }, (_, index) => ({ ts: new Date(now - index * 36e5).toISOString(), reasonCode: 'unreadable' }));
  const investigable = [1, 2, 3].map((days) => ({ ts: new Date(now - days * 864e5).toISOString(), reasonCode: 'no-path' }));
  assert.match(evaluateGateSkips([...unreadable, ...investigable], now).line, /（要調査）3件/);
});

test('unreadable 8件と要調査2件ならgateスキップ警報を出さない', () => {
  const unreadable = Array.from({ length: 8 }, (_, index) => ({ ts: new Date(now - index * 36e5).toISOString(), reasonCode: 'unreadable' }));
  const investigable = [1, 2].map((days) => ({ ts: new Date(now - days * 864e5).toISOString(), reasonCode: 'no-path' }));
  assert.equal(evaluateGateSkips([...unreadable, ...investigable], now), null);
});

test('7日より古いgateスキップは要調査件数に数えない', () => {
  const records = [1, 2].map((days) => ({ ts: new Date(now - days * 864e5).toISOString(), reasonCode: 'no-path' }));
  records.push({ ts: new Date(now - 8 * 864e5).toISOString(), reasonCode: 'no-path' });
  assert.equal(evaluateGateSkips(records, now), null);
});

// 日次TOP3 は workflow の成否ではなくローカル着地(asOf)で測る。
// 取りこぼしは top3-catchup が artifact から回収するため、run が赤くても届いていることがある。
const top3Now = Date.parse('2026-09-02T07:00:00.000Z'); // = 2026-09-02 16:00 JST

test('日次TOP3: 当日ぶんが届いていればok', () => {
  const actual = evaluateTop3Delivery('2026-09-02', top3Now);
  assert.equal(actual.status, 'ok');
  assert.match(actual.line, /^✅/);
});

test('日次TOP3: 前日ぶんで止まっていてもまだok（当日の生成前に鳴らさない）', () => {
  assert.equal(evaluateTop3Delivery('2026-09-01', top3Now).status, 'ok');
});

test('日次TOP3: 2日以上遅れたらstale', () => {
  const actual = evaluateTop3Delivery('2026-08-31', top3Now);
  assert.equal(actual.status, 'stale');
  assert.match(actual.line, /^🚨/);
});

test('日次TOP3: 一度も届いていなければnever', () => {
  assert.equal(evaluateTop3Delivery(null, top3Now).status, 'never');
});

test('日次TOP3: asOfが日付として読めなければunknown', () => {
  const actual = evaluateTop3Delivery('not-a-date', top3Now);
  assert.equal(actual.status, 'unknown');
  assert.match(actual.line, /^⚠️/);
});
