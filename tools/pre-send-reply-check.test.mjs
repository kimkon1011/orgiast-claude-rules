import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { checkPreSendReply, collectBeeperContext, splitInstructions } from './lib/pre-send-reply-check.mjs';
import { writePreSendPass, assertPreSendPass } from './lib/pre-send-marker.mjs';
import { sendMessage } from './beeper-api.mjs';
import { main as cli } from './pre-send-reply-check.mjs';
import { main as contextMain } from './send-context-check.mjs';
import { sendDiscordDm } from './discord-dm.mjs';
import { createBeeperAdapter } from './lib/followup-adapters.mjs';
import { withTema } from './test-fixtures/tema-record.mjs';

const now = Date.parse('2026-11-28T03:00:00Z');
const msg = (text, extra = {}) => ({ chatID: 'target', chatTitle: 'なっちゃん', id: 'm1', at: new Date(now - 1000).toISOString(), senderID: 'n', senderName: 'なっちゃん', isSender: false, text, attachments: [], ...extra });
const copy = msg('控えここ入れてます', { chatID: 'cafe', chatTitle: 'カフェ（東邦ハイツ211）', attachments: [{ type: 'img', srcURL: 'mxc://fixture/1', description: '控えの束をカフェの書類ラック「納品書」の上段に差し込み。付箋「裁判関係 11/28 投函済」' }] });
const copyDraft = '控えの束は持ち帰ってカフェに置いておいてくれればOKです。';
const check = (draft, messages) => checkPreSendReply({ draft, messages, now });
function blocked(result, code) { assert.equal(result.ok, false); assert.ok(result.findings.some(f => f.code === code), JSON.stringify(result)); }
function temp(t) { const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-send-')); t.after(() => fs.rmSync(home, { recursive: true, force: true })); return home; }

test('case 1: 関連チャットの控え保管と逆指示', () => {
  const result = check(copyDraft, [copy]); blocked(result, 'PLACEMENT_CONFLICT');
  assert.ok(result.findings.some(f => f.conflictWith.text.includes('控えここ入れてます')));
});
test('case 2: 本文空・説明なし画像は無関係な下書きでも停止', () => blocked(check('レターパックに入れて窓口で出してね', [msg('', { attachments: [{ type: 'img' }] })]), 'UNREAD_IMAGE'));
test('case 3: 画像に記入済みの乙第12号証を再指示しない', () => blocked(check('古川さんの陳述書2枚の右上に「乙第12号証」と書く', [msg('', { attachments: [{ type: 'img', description: '陳述書2枚の右上に手書きで「乙第12号証」記入済み' }] })]), 'DONE_REINSTRUCTED'));
test('case 4: 投函引受後に窓口への変更を指示しない', () => {
  const result = check('今日中に窓口で出してください', [msg('投函しておきます')]); blocked(result, 'METHOD_CHANGE_AFTER_COMMIT');
  assert.match(result.findings[0].fix, /相手が引き受け済み.*投函しておきます/);
});
test('case 5: 最新指定の日時と不一致', () => blocked(check('では今日14時でお願いします', [msg('明日15時に変えてください')]), 'DATETIME_CONFLICT'));
test('case 6: 控え1部を2部に変えない', () => blocked(check('控えを2部コピーしておいてください', [msg('控えは1部で大丈夫です')]), 'QUANTITY_CONFLICT'));
test('case 7: 訂正済み住所と郵便番号の不一致', () => blocked(check('〒537-0025 大阪府大阪市東成区中道1-2-3に送ってください', [msg('住所訂正です。正しくは〒537-0001 大阪府大阪市東成区深江北2-15-24です')]), 'ADDRESS_CONFLICT'));
test('case 8: 登記簿提出済みを再指示しない', () => blocked(check('登記簿を法務局に持って行ってください', [msg('登記簿は昨日法務局に提出済みです')]), 'DONE_REINSTRUCTED'));
test('case 9: 追跡番号写真の依頼は矛盾なし', () => assert.equal(check('ありがとう。追跡番号の写真をこのトークに送ってね', [msg('了解です、今から郵便局に行きます')]).ok, true));
test('case 10: 無関係な説明済み画像は通過', () => assert.equal(check('レターパックの表の写真を送ってね', [msg('', { attachments: [{ type: 'img', description: 'カフェの新メニューのケーキの写真' }] })]).ok, true));
test('case 11: 通過文への数量指示混入と画像説明削除のミューテーション', () => {
  blocked(check('ありがとう。追跡番号の写真をこのトークに送ってね。控えは2部コピーして', [msg('了解です、今から郵便局に行きます'), msg('控えは1部で大丈夫です')]), 'QUANTITY_CONFLICT');
  const mutated = structuredClone(copy); delete mutated.attachments[0].description;
  blocked(check(copyDraft, [mutated]), 'UNREAD_IMAGE');
});
test('case 12: マーカー無し・本文違い・期限切れ・未来・宛先違いを拒否', t => {
  const home = temp(t), input = { home, chatID: 'fixture', text: '本文\r\n2行目', now };
  const reject = overrides => assert.throws(() => assertPreSendPass({ ...input, ...overrides }), { code: 'PRE_SEND_REQUIRED' });
  reject(); const written = writePreSendPass(input);
  assertPreSendPass({ ...input, text: ' 本文\n2行目 ' });
  reject({ text: '別本文' }); reject({ chatID: '別宛先' }); reject({ now: now + 300001 }); reject({ now: now - 1 });
  fs.writeFileSync(written.file, JSON.stringify({ ...written, chatID: '改変' })); reject();
});
test('case 12 API: 直接importする使い捨てスクリプトも通信前に停止、合格時だけmock fetch', async t => {
  const home = temp(t); let calls = 0;
  const options = { env: { ORGIAST_HOME: home, BEEPER_ACCESS_TOKEN: 'fixture' }, fetchImpl: async () => { calls++; return Response.json({ pendingMessageID: 'mock' }); } };
  await assert.rejects(() => sendMessage('fixture', '本文', {}, options), { code: 'PRE_SEND_REQUIRED' }); assert.equal(calls, 0);
  writePreSendPass({ home, chatID: 'fixture', text: '本文' });
  await sendMessage('fixture', '本文', {}, options); assert.equal(calls, 1);
});
function contextApi() {
  const peer = { id: 'n', fullName: 'なっちゃん' }, self = { id: 'me', isSelf: true };
  const chats = [
    { id: 'target', title: '送信先', participants: { items: [peer, self] }, lastActivity: new Date(now - 2000).toISOString() },
    { id: 'cafe', title: 'カフェ', participants: { items: [peer] }, lastActivity: new Date(now - 2000).toISOString() },
    { id: 'other', participants: { items: [{ id: 'other', fullName: '別人' }, self] }, lastActivity: new Date(now - 2000).toISOString() },
    { id: 'old', participants: { items: [peer] }, lastActivity: new Date(now - 25 * 3600000).toISOString() },
  ];
  const reads = [];
  return { reads, getChat: async id => chats.find(c => c.id === id), listChats: async () => ({ items: chats }),
    listMessages: async id => { reads.push(id); return { items: [msg('', { id: id + '-m', timestamp: new Date(now - 1000).toISOString(), chatID: id, attachments: [{ type: 'img', srcURL: 'mxc://fixture' }] })] }; }, downloadAttachment: async () => Buffer.from('fixture') };
}
test('case 13: 同じ相手の24時間内関連チャット・空本文添付・説明・保存', async t => {
  const api = contextApi(), saveDir = temp(t);
  const rows = await collectBeeperContext({ chatID: 'target', now, api, saveDir, imageNotes: { 'cafe-m': '控えを上段に入れました' } });
  assert.deepEqual(api.reads.sort(), ['cafe','target']); assert.equal(rows.length, 2);
  assert.equal(rows[0].text, ''); assert.equal(rows[0].attachments.length, 1);
  assert.equal(rows[1].attachments[0].description, '控えを上段に入れました'); assert.ok(fs.existsSync(rows[0].attachments[0].savedPath));
});
test('splitInstructions: 箇条書きとAI注記', () => assert.deepEqual(splitInstructions('1. 控えを確認。\n・住所を確認\n（AIが代理で返信しています）'), ['控えを確認','住所を確認']));
test('自分の発言・同じ日時住所数量・別の対象は停止しない', () => {
  assert.equal(check('控えを2部コピーしてください', [msg('控えは1部', { isSender: true }), msg('住民票は1部')]).ok, true);
  assert.equal(check('11月29日15時でお願いします', [msg('明日15時に変えてください')]).ok, true);
  assert.equal(check('〒５３７－０００１ 大阪府大阪市東成区深江北２－１５－２４に送ってください', [msg('住所は〒537-0001 大阪府大阪市東成区深江北2-15-24です')]).ok, true);
});

test('別案件の日時住所や同じ投稿内の別対象数量は混同しない', () => {
  assert.equal(check('配送は今日14時でお願いします', [msg('会議は明日15時に変えてください')]).ok, true);
  assert.equal(check('倉庫の住所は〒537-0025 大阪府大阪市東成区中道1-2-3に送ってください', [msg('カフェの住所訂正です。正しくは〒537-0001 大阪府大阪市東成区深江北2-15-24です')]).ok, true);
  assert.equal(check('控えは1部コピーしてください', [msg('控えは1部、申請書は2部です')]).ok, true);
  blocked(check('申請書は1部コピーしてください', [msg('控えは1部、申請書は2部です')]), 'QUANTITY_CONFLICT');
});
test('最新指定を優先し、昨日の明日と今日を同日として照合する', () => {
  assert.equal(check('今日15時でお願いします', [msg('明日15時に変えてください', { at: new Date(now - 86400000).toISOString() })]).ok, true);
  assert.equal(check('明日15時でお願いします', [msg('今日14時に変えてください', { at: new Date(now - 2000).toISOString() }), msg('明日15時に変えてください')]).ok, true);
});
test('非Beeperのimage-notesでも添付説明を照合へ渡す', async t => {
  const home = temp(t), file = path.join(home, 'body.txt'), notes = path.join(home, 'notes.json');
  fs.writeFileSync(file, 'ありがとう'); fs.writeFileSync(notes, JSON.stringify({ m1: '写真は新メニューのケーキ' }));
  const argv = ['--channel','line','--chat','fixture','--text-file',file,'--image-notes',notes];
  assert.equal(await cli(argv, { home, now, stdout: () => {}, fetchHistory: async (_, __, options) => { assert.equal(options.readOnly, true); return { target: 'fixture', messages: [msg('', { attachments: [{ type: 'img' }] })] }; } }), 0);
});
test('複数添付の片方の読取結果で、他の未読画像を既読にしない', async () => {
  const api = contextApi(); api.listChats = async () => ({ items: [] });
  api.listMessages = async () => ({ items: [msg('', { attachments: [{ type: 'img' }, { type: 'file' }] })] });
  const messages = await collectBeeperContext({ chatID: 'target', now, api, imageNotes: { 'm1:1': 'テキストファイルを読みました' } });
  blocked(check('ありがとう', messages), 'UNREAD_IMAGE');
});
test('CLI: block=2・pass=0、合格時指定した場合だけマーカー', async t => {
  const home = temp(t), file = path.join(home, 'body.txt'); fs.writeFileSync(file, '本文');
  const args = ['--channel','beeper','--chat','target','--text-file',file,'--json']; let output;
  const deps = { home, now, stdout: s => { output = JSON.parse(s); }, collectBeeperContext: async () => [msg('', { attachments: [{ type: 'file' }] })] };
  assert.equal(await cli([...args,'--write-pass'], deps), 2); assert.equal(output.ok, false);
  assert.throws(() => assertPreSendPass({ home, chatID: 'target', text: '本文', now }));
  deps.collectBeeperContext = async () => [];
  assert.equal(await cli(args, deps), 0); assert.throws(() => assertPreSendPass({ home, chatID: 'target', text: '本文', now }));
  assert.equal(await cli([...args,'--write-pass'], deps), 0); assertPreSendPass({ home, chatID: 'target', text: '本文', now });
});
test('send-context: kim承認指定でも決定的な矛盾はLLM前に停止', async t => {
  const home = temp(t), file = path.join(home, 'body.txt'); fs.writeFileSync(file, '控えを2部コピーして');
  const code = await contextMain(['--channel','line','--target','cafe','--text-file',file,'--kim-approved','fixture'], { home, now,
    fetchHistory: async () => ({ target: 'cafe', messages: [msg('控えは1部で大丈夫です')] }), runLlm: () => assert.fail('LLMを呼ばない') });
  assert.equal(code, 2); assert.equal(fs.existsSync(path.join(home, '.claude', 'send-context-checks')), false);
});
test('Discord入口: 取得済みの完了発言でPOSTを停止', async t => {
  const home = temp(t); let posts = 0;
  await assert.rejects(() => sendDiscordDm('相手', withTema('登記簿を法務局に持って行ってください'), { home, now, noCopyKim: true, token: 'fixture', resolve: async () => ({ id: 'peer' }), assertContextApproved: async () => {},
    fetchImpl: async (url, init) => {
      if (url.endsWith('/users/@me/channels')) return Response.json({ id: 'chat' });
      if (init.method === 'POST') { posts++; return Response.json({ id: 'sent' }); }
      return Response.json([{ id: 'm', timestamp: new Date(now).toISOString(), author: { id: 'peer' }, content: '登記簿は昨日法務局に提出済みです' }]);
    } }), { code: 'PRE_SEND_REPLY_BLOCKED' });
  assert.equal(posts, 0);
});

test('CLI --now は送信予定時刻を優先し、未来・24時間超の発言を除外', async t => {
  const home=temp(t),file=path.join(home,'body.txt'); fs.writeFileSync(file,'控えを2部コピーしてください');
  const at='2026-11-28T01:25:00Z', end=Date.parse(at);
  const args=['--channel','beeper','--chat','target','--text-file',file,'--now',at,'--write-pass'];
  const rows=[msg('控えは1部で大丈夫です',{at:new Date(end+1).toISOString()}),msg('控えは1部で大丈夫です',{at:new Date(end-86400001).toISOString()})];
  const deps={home,now:end+86400000,stdout:()=>{},collectBeeperContext:async options=>{assert.equal(options.now,at);return rows;}};
  assert.equal(await cli(args,deps),0); assertPreSendPass({home,chatID:'target',text:fs.readFileSync(file,'utf8'),now:end});
  rows.push(msg('控えは1部で大丈夫です',{at})); assert.equal(await cli(args,deps),2);
  await assert.rejects(()=>cli([...args,'--unused'],{...deps,collectBeeperContext:async()=>{throw Error('fixture');}}),/fixture/);
  assert.equal(await cli(['--channel','line','--chat','target','--text-file',file,'--now',at],{home,stdout:()=>{},fetchHistory:async()=>({target:'target',messages:rows.slice(0,2)})}),0);
});

test('過去再現: 最終活動が送信予定より後の関連チャットも当時の発言を読む', async () => {
  const api=contextApi(), original=api.listChats;
  api.listChats=async()=>({items:(await original()).items.map(c=>c.id==='cafe'?{...c,lastActivity:new Date(now+86400000).toISOString()}:c)});
  const rows=await collectBeeperContext({chatID:'target',now,api}); assert.ok(rows.some(m=>m.chatID==='cafe'));
});

test('followup Beeper: blockは送信・マーカー・整合性確認なし、passは照合→整合性→マーカー→送信→後処理', async t => {
  const home=temp(t),order=[];
  const deps={home,resolveBeeperTarget:()=>({token:'fixture',via:'test'}),preSendCheck:async()=>{order.push('reply');return{ok:false,findings:[{code:'UNREAD_IMAGE'}]};},
    consistencyCheck:async()=>{order.push('consistency');return{ok:true};},
    writePreSendPass:args=>{order.push('marker');writePreSendPass(args);},
    sendMessage:async(chatID,text,_,options)=>{order.push('send');assert.equal(options.env.ORGIAST_HOME,home);assertPreSendPass({chatID,text,home});return{id:'sent'};},
    cleanup:async()=>order.push('cleanup')};
  const blocked=await createBeeperAdapter(deps).send({chatId:'target'},'本文');assert.equal(blocked.ok,false);assert.match(blocked.error,/送信前照合/);assert.deepEqual(order,['reply']);
  order.length=0;deps.preSendCheck=async()=>{order.push('reply');return{ok:true,findings:[]};};
  assert.equal((await createBeeperAdapter(deps).send({chatId:'target'},'本文')).ok,true);
  assert.deepEqual(order,['reply','consistency','marker','send','cleanup']);
});
