import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { auditCommitments, extractCommitments, hasUnsupportedDoneClaim, trackCommitments, registerCommitment } from './autoreply-commitments.mjs';
import { recordSentReply, retryForbiddenAnswer } from './discord-autoreply.mjs';

const ts = '2026-11-23T11:14:00+09:00';
const first = '明日14:00～14:30に短時間ミーティングを設定します。Zoomリンクは後ほど送ります';
const second = '同日15:30‑16:00に変更いたします…再設定後、Zoomリンクを送ります';
const claim = 'CC設定とフォロー担当の配置は既に運用化しました';

test('42086 と 42200 の日時は JST で解決し、同日は直前の会議日を引き継ぐ', () => {
  const [one, send] = extractCommitments(first, { now: ts });
  assert.equal(one.kind, 'meeting');
  assert.equal(one.start, '2026-11-24T14:00:00+09:00');
  assert.equal(one.end, '2026-11-24T14:30:00+09:00');
  assert.equal(send.kind, 'send');
  const [two] = extractCommitments(second, { now: '2026-11-23T14:17:00+09:00', previousDay: one.date });
  assert.equal(two.kind, 'meeting');
  assert.equal(two.start, '2026-11-24T15:30:00+09:00');
  assert.equal(two.end, '2026-11-24T16:00:00+09:00');
});

test('完了主張、引用、否定、疑問と JST 日付境界', () => {
  assert.equal(extractCommitments(claim)[0].kind, 'done-claim');
  assert.equal(hasUnsupportedDoneClaim(claim), true);
  assert.equal(hasUnsupportedDoneClaim('登録しました（eventId: abc123）'), false);
  assert.deepEqual(extractCommitments('「送ります」と言われました。電話しますか？ 設定しません。会議は設定しますが実施しない。'), []);
  assert.equal(extractCommitments('明日14:00〜14:30にお電話します', { now: '2026-11-23T23:00:00Z' })[0].start,
    '2026-11-25T14:00:00+09:00');
  assert.equal(extractCommitments('11/24 14:00〜14:30に面談を入れます', { now: ts })[0].end, '2026-11-24T14:30:00+09:00');
});

test('再生成後の完了主張も送信候補から外す', async () => {
  let retries = 0;
  const result = await retryForbiddenAnswer(async () => {
    retries++;
    return JSON.stringify({ needs_reply: true, answer: claim, confidence: 1 });
  }, { answer: claim }, {});
  assert.equal(result, null);
  assert.equal(retries, 1);
});

const entry = { ts, where: 'dm', channelId: 'group', channelName: '佐藤優奈 & 澤山', replyId: '42086', senderName: '澤山', content: first };
const approvalMessage = 'ミーティングは24日14:00〜14:30でお願いします。';
function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'autoreply-commitments-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
function rows(home) {
  return fs.readFileSync(path.join(home, '.claude', 'discord-autoreply', 'commitments.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
}

test('送信記録から未了承の約束を追跡し、同日の変更と24時間超を監査する', async t => {
  const home = tempHome(t);
  const inbox = [];
  const deps = { addItemImpl: async (_, item) => { inbox.push(item); return { id: 'mock' }; },
    registerCommitment: async () => assert.fail('without approval') };
  await recordSentReply(home, entry, deps);
  await recordSentReply(home, { ...entry, ts: '2026-11-23T14:17:00+09:00', replyId: '42200', content: second,
    question: '澤山: 24日15時から現場です' }, deps);
  assert.deepEqual(rows(home).map(r => [r.kind, r.status]), [
    ['meeting', 'unexecuted'], ['send', 'unexecuted'], ['meeting', 'unexecuted'], ['send', 'unexecuted']
  ]);
  assert.equal(rows(home)[2].start, '2026-11-24T15:30:00+09:00');
  assert.equal(inbox.filter(item => item.source === 'autoreply-commitments').length, 4);
  assert.equal(await auditCommitments({ home, now: Date.parse(ts) + 86400000, post: deps.addItemImpl }), 0);
  assert.equal(await auditCommitments({ home, now: Date.parse(ts) + 86400001, post: deps.addItemImpl }), 2);
});

test('了承済みの会議だけ登録し、Meet・日時・通知を読み戻す', async t => {
  const home = tempHome(t);
  let body;
  const inbox = [];
  let gets = 0;
  const deps = {
    addItemImpl: async (_, item) => inbox.push(item),
    register: row => registerCommitment(row, {
      getToken: async ({ impersonate, scope }) => {
        assert.equal(impersonate, 'kim@orgiast.jp');
        assert.match(scope, /calendar\.events$/);
        return 'mock-token';
      },
      fetchImpl: async (url, init) => {
        if (init.method === 'POST') {
          assert.match(url, /primary\/events\?sendUpdates=none&conferenceDataVersion=1$/);
          body = JSON.parse(init.body);
          assert.equal(body.attendees, undefined);
          assert.equal(body.conferenceData.createRequest.conferenceSolutionKey.type, 'hangoutsMeet');
          assert.deepEqual(body.reminders, { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] });
          return { ok: true };
        }
        assert.ok(url.endsWith('/' + body.id));
        gets++;
        return { ok: true, json: async () => ({ ...body, hangoutLink: 'https://meet.google.com/abc-defg-hij' }) };
      }
    })
  };
  await trackCommitments(home, { ...entry, approvalMessage }, deps);
  await trackCommitments(home, { ...entry, approvalMessage }, deps);
  assert.equal(gets, 1);
  assert.equal(rows(home).find(r => r.status === 'registered').meetUrl, 'https://meet.google.com/abc-defg-hij');
  assert.ok(inbox.every(item => item.text.includes('Zoomリンク')));
  assert.equal(await auditCommitments({ home, now: Date.parse(ts) + 90000000, post: deps.addItemImpl }), 1);
});

test('日時違い・現場の発言は登録せず、登録失敗は未実行として報告する', async t => {
  const home = tempHome(t);
  const inbox = [];
  let attempts = 0;
  for (const [index, message] of [approvalMessage.replace('14:30', '14:45'), '24日14:00〜14:30は現場です。', approvalMessage].entries()) {
    await trackCommitments(home, { ...entry, replyId: String(index), approvalMessage: message }, {
      addItemImpl: async (_, item) => inbox.push(item),
      register: async () => { attempts++; throw new Error('Calendar get HTTP 403'); }
    });
  }
  assert.equal(attempts, 1);
  assert.equal(inbox.length, 6);
  assert.match(inbox.at(-2).text, /Calendar get HTTP 403/);
  assert.ok(rows(home).every(row => row.status === 'unexecuted'));
});

test('電話は Meet を付けず、通知の不一致を登録成功として扱わない', async () => {
  const { start, end } = extractCommitments(first, { now: ts })[0];
  const row = { id: 'mockevent123', kind: 'call', senderName: '澤山', start, end };
  let body;
  const deps = {
    getToken: async () => 'mock-token',
    fetchImpl: async (_, init) => {
      if (init.method === 'POST') {
        body = JSON.parse(init.body);
        assert.equal(body.summary, '【調整可】澤山さんに電話');
        assert.equal(body.conferenceData, undefined);
        return { ok: true };
      }
      return { ok: true, json: async () => ({ ...body, reminders: { useDefault: true } }) };
    }
  };
  await assert.rejects(registerCommitment(row, deps), /Calendar read-back mismatch/);
});
