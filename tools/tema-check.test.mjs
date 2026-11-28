import test from 'node:test';
import assert from 'node:assert/strict';
import { checkTema, parseTemaRecord, stripTemaRecord } from './lib/tema-check.mjs';

const rec = (over = {}) => `[TEMA-CHECK]
候補: ${over.候補 || 'スマホ署名 / 紙に書き直して写真'}
選択: ${over.選択 || 'スマホ署名'}
紙理由: ${over.紙理由 ?? 'なし'}
手順数: ${over.手順数 || '3'}
読む量: ${over.読む量 || '1通・約200字'}
追加連絡: ${over.追加連絡 || '次の連絡にまとめる'}
前提: ${over.前提 || '所在=大阪 / 期限=12/2必着 / 順番=アシスタント確認済み→予備'}
AI代行: ${over.AI代行 ?? '不可（本人作業）'}
${over.サインイン ? `サインイン: ${over.サインイン}` : ''}
[/TEMA-CHECK]`;
const expect = (name, text, ok, code, opts) => test(name, () => { const r = checkTema(text, opts); assert.equal(r.ok, ok, JSON.stringify(r.findings)); if (code) assert.ok(r.findings.some((f) => f.code === code), JSON.stringify(r.findings)); });

expect('1 紙署名・記録なし', '紙に書き直して写真を送ってください', false, 'TEMA_NO_RECORD');
expect('2 スマホ署名を選択', `スマホ署名してください\n${rec()}`, true);
expect('3 押印郵送・紙1候補', `押印して郵送してください\n${rec({ 候補: '押印して郵送', 選択: '押印して郵送' })}`, false, 'TEMA_FEW_CANDIDATES');
expect('4 予備へ直依頼', `なっちゃん、発送してください\n${rec({ 前提: '所在=大阪 / 期限=12/2 / 順番=予備' })}`, false, 'TEMA_ORDER_SKIP');
expect('5 アシスタント不在確認後に予備', `なっちゃん、発送してください\n${rec()}`, true);
expect('6 窓口来所・比較なし', `窓口へ来所してください\n${rec({ 候補: '窓口へ来所 / 郵送', 選択: '窓口へ来所' })}`, false, 'TEMA_PAPER_NO_REASON');
expect('7 オンライン請求でまとめる', `オンライン請求してください\n${rec({ 候補: 'オンライン請求で2件まとめて1回 / 来所', 選択: 'オンライン請求で2件まとめて1回' })}`, true);
expect('8 所在なし', `対応してください\n${rec({ 前提: '担当者を確認済み' })}`, false, 'TEMA_NO_PREMISE');
expect('9 取消し検討なし', `先ほどの依頼は取り消します\n${rec({ 追加連絡: 'なし' })}`, false, 'TEMA_EXTRA_CONTACT');
expect('10 訂正検討なし', `訂正です。対応してください\n${rec({ 追加連絡: 'なし' })}`, false, 'TEMA_EXTRA_CONTACT');
expect('11 念のため検討なし', `念のため確認してください\n${rec({ 追加連絡: 'なし' })}`, false, 'TEMA_EXTRA_CONTACT');
expect('12a 複数通をまとめる', `3通に分けずまとめて1回送ってください\n${rec({ 候補: 'まとめて1回 / 3通に分ける' })}`, true);
expect('12b 複数通をまとめない', `3通に分けて送ってください\n${rec({ 候補: 'メール / LINE', 追加連絡: 'なし', 読む量: '3通' })}`, false, 'TEMA_EXTRA_CONTACT');
expect('13 法令で原本提出', `裁判所へ原本提出が必要なので郵送してください\n${rec({ 候補: '電子提出 / 原本郵送', 選択: '原本郵送', 紙理由: '法令（民事訴訟規則で原本提出）' })}`, true);
expect('14 AIで調べられる', `価格を調べてください\n${rec({ AI代行: '可' })}`, false, 'TEMA_AI_CAN_DO');
expect('15 カフェスタッフの外出', `カフェスタッフは郵便局へ発送してください\n${rec()}`, false, 'TEMA_STORE_BOUND');
expect('16 古いパスワード禁止なし', `古い保存パスワードでログインしてください\n${rec({ サインイン: '出どころ=既存セッション / 失敗時=出どころ切替→経路切替→本人の一点' })}`, false, 'SIGNIN_STALE_NOT_FORBIDDEN');
expect('17 正しいサインイン委任', `ログインしてください\n${rec({ サインイン: '出どころ=既存セッション→1Password / 禁止=旧保存パスワード / 失敗時=出どころ切替→経路切替→本人の一点' })}`, true);
expect('18 公共Wi-Fi手入力', `空港の公共Wi-Fiで金さんにパスワードを入力してもらいログインしてください\n${rec({ サインイン: '出どころ=既存セッション / 禁止=旧保存パスワード / 失敗時=本人の手入力→経路切替' })}`, false, 'SIGNIN_PUBLIC_WIFI');
expect('19 出どころなし', `ログインしてください\n${rec({ サインイン: '禁止=旧保存パスワード / 失敗時=出どころ切替→経路切替→本人の一点' })}`, false, 'SIGNIN_NO_SOURCE');
expect('20 報告だけ', '作業は完了しました', true, null);
test('解析と除去', () => { const text = `本文\n${rec()}`; assert.equal(parseTemaRecord(text).candidates.length, 2); assert.doesNotMatch(stripTemaRecord(text), /TEMA-CHECK/); });
