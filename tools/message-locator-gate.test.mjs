import assert from 'node:assert/strict';
import test from 'node:test';
import { judge, formatReason, REMEDY_EXAMPLES } from './message-locator-gate.mjs';

test('目印なしで Discord の通知を見てもらう案内は止める（2026-10-26 実例）', () => {
  const r = judge('次に kim がすること: Discord の DM で今日19時ごろの通知を開き、届いているかと読みやすさを確認する。');
  assert.equal(r.triggered, true);
  assert.ok(r.missing.some(m => m.includes('送信者')));
  assert.ok(r.missing.some(m => m.includes('直接リンク')));
});

test('送信者・日時・先頭行・直リンクがそろえば通す', () => {
  for (const ex of REMEDY_EXAMPLES) assert.equal(judge(ex).triggered, false, ex);
});

test('メール送信の報告も、宛先・時刻・件名がそろえば通す', () => {
  const r = judge('10/18 10:26 に seisaku-team@orgiast.jp から kuroda@nico-inc.net へ、件名「【株式会社オージャスト】10月19日（月）お打ち合わせのご案内」を送りました。');
  assert.equal(r.triggered, false);
});

test('目印のない「Discord に送りました」は止める', () => {
  assert.equal(judge('結果は Discord に送りました。').triggered, true);
});

test('メッセージを案内していない文は対象外', () => {
  assert.equal(judge('Discord の Bot 権限を確認しました。管理者権限はオンです。').triggered, false);
  assert.equal(judge('このルールは全社に配布されます。').triggered, false);
});

test('コードブロック内は対象外、override タグで通る', () => {
  assert.equal(judge('```\nDiscord に送りました\n```').triggered, false);
  assert.equal(judge('Discord に送りました。[MSG-LOCATOR-OK: 一般論の説明]').triggered, false);
});

test('差し戻し文に例と必須項目が入っている', () => {
  const reason = formatReason(['日時（日付と時:分）'], 'x');
  assert.match(reason, /MSG-LOCATOR/);
  assert.match(reason, /discord\.com\/channels/);
});
