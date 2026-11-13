import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertContextApproved, writeContextMarker } from './lib/send-context.mjs';
import { classifyMessage, fetchHistory, labelHistory, loadInternalSenders, main, runLlm } from './send-context-check.mjs';

const tmp = t => { const p=fs.mkdtempSync(path.join(os.tmpdir(),'send-context-')); t.after(()=>fs.rmSync(p,{recursive:true,force:true})); return p; };
test('LINE履歴は実テーブルの列名を使って整形する', async t => {
  const home=tmp(t); fs.mkdirSync(path.join(home,'.claude')); fs.writeFileSync(path.join(home,'.claude','line-send.env'),'LINE_CHANNEL_ACCESS_TOKEN=test\nSUPABASE_URL=https://example.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=test\n');
  let requested='';
  const result=await fetchHistory('line','C10930732da844f79c6032a40705a4d73',{home,fetchImpl:async url=>{ requested=String(url); return new Response(JSON.stringify([{id:1,external_message_id:'line-1',created_at:new Date().toISOString(),sender_display_name:'山之内さん',body:'確認しました',direction:'inbound'}]),{status:200}); }});
  assert.match(requested,/select=id,created_at,sender_display_name,body,direction,external_message_id/);
  assert.deepEqual(result.messages.map(({id,side,party,sender,text})=>({id,side,party,sender,text})),[{id:'line-1',side:'inbound',party:'external',sender:'山之内さん',text:'確認しました'}]);
});
test('LINEのinboundでも明示設定した社員表示名は自社として分類する', () => {
  const config=loadInternalSenders();
  const messages=[
    classifyMessage({side:'inbound',sender:'きむこん☺',text:'LED仕込みを1.5万円で可能でしょうか？'},'line',config),
    classifyMessage({side:'inbound',sender:'うっちー@モデル',text:'別件には回答します'},'line',config),
  ];
  assert.deepEqual(messages.map(x=>x.party),['internal','external']);
  assert.match(labelHistory(messages)[0],/\[自社\].*LED仕込み/);
  assert.match(labelHistory(messages)[1],/\[相手\].*別件/);
});
test('自社の質問と相手未回答の実データ形をLLMへ正しいラベルで渡す', () => {
  let prompt='';
  const verdict=runLlm([
    {party:'internal',sender:'きむこん☺',text:'LED仕込みを1.5万円で可能でしょうか？'},
    {party:'external',sender:'うっちー@モデル',text:'（この質問への回答はまだない）'},
  ],'ご確認をお願いいたします。',{spawn:(_exe,args)=>{prompt=fs.readFileSync(args[args.indexOf('--prompt-file')+1],'utf8');return {status:0,stdout:'{"verdict":"OK","reason":"自社質問を相手要望としていない","warnings":[]}',stderr:''};}});
  assert.match(prompt,/\[自社\] きむこん☺: LED仕込み/);
  assert.match(prompt,/\[相手\] うっちー@モデル/);
  assert.match(prompt,/\[自社\]の質問を相手の要望と解釈しない/);
  assert.equal(verdict.ok,true);
  assert.match(verdict.reason,/自社質問を相手要望としていない/);
});
test('定期報告モードは同じ未対応項目の再掲をNGにせず、質問と食い違いだけNGにする（2026-11-13の再現）', () => {
  let prompt='';
  const repeated='PRONIアイミツ事務局への返信が24時間以上未対応';
  runLlm([
    {party:'internal',sender:'佐藤優奈',at:'2026-11-10T21:31:30.420Z',text:`【業務報告】■問題点\n・${repeated}`},
    {party:'internal',sender:'佐藤優奈',at:'2026-11-11T21:31:49.700Z',text:`【業務報告】■問題点\n・${repeated}`},
  ],`【業務報告】■問題点\n・${repeated}`,{spawn:(_exe,args)=>{prompt ||= fs.readFileSync(args[args.indexOf('--prompt-file')+1],'utf8');return {status:0,stdout:'{"verdict":"OK","reason":"定期報告では未対応項目の再掲は許容","warnings":[]}',stderr:''};},periodicReport:{recipient:'佐藤優奈',kind:'毎日の状況報告',sourceEvidence:'[2026-11-11] PRONI: 未返信'}});
  assert.match(prompt,/佐藤優奈さん（宛先本人）あての毎日の状況報告/);
  assert.match(prompt,/「同じ未対応の項目を、前日以前の報告でも書いている」ことはNGにしない/);
  assert.match(prompt,/①報告の中で宛先本人に質問している/);
  assert.match(prompt,/②日付・金額・人名が下記のメール原本証拠と実際に食い違っている/);
  assert.match(prompt,/メール原本証拠:\n\[2026-11-11\] PRONI: 未返信/);
  assert.match(prompt,/Discord履歴に根拠となるメールが載っていないこと.*NGにしてはならない/);
  assert.match(prompt,/メール原本証拠はDiscord履歴より優先/);
  assert.match(prompt,/warningsだけに記載してOKにしてはならない/);
  assert.doesNotMatch(prompt,/③\[自社\]が既に聞いた質問を重ねて聞いていないか/);
});
test('定期報告モードなし（社外・他人宛て）は従来の5項目NG判定のまま', () => {
  let prompt='';
  runLlm([{party:'external',text:'確認しました'}],'返信本文',{spawn:(_exe,args)=>{prompt=fs.readFileSync(args[args.indexOf('--prompt-file')+1],'utf8');return {status:0,stdout:'{"verdict":"OK","reason":"整合","warnings":[]}',stderr:''};}});
  assert.match(prompt,/①回答済み質問の聞き直し/);
  assert.match(prompt,/③\[自社\]が既に聞いた質問を重ねて聞いていないか/);
  assert.match(prompt,/⑤自社既送信との重複・矛盾/);
  assert.doesNotMatch(prompt,/定期報告では次で判定する/);
});

test('定期報告の再掲許容とは独立に原本の事実を照合し、不一致を止める',()=>{
  for(const kind of ['日付','金額','人名']){
    const prompts=[];
    const verdict=runLlm([],'報告本文',{periodicReport:{recipient:'佐藤優奈',sourceEvidence:'メール原本'},spawn:(_exe,args)=>{
      prompts.push(fs.readFileSync(args[args.indexOf('--prompt-file')+1],'utf8'));
      return{status:0,stdout:JSON.stringify({verdict:prompts.length===1?'OK':'NG',reason:`${kind}の不一致`,warnings:[]})};
    }});
    assert.equal(verdict.ok,false);assert.equal(prompts.length,2);
    assert.match(prompts[1],/発信者・担当者・連絡者の人名が別人に置き換わっていたら必ずNG/);
    assert.doesNotMatch(prompts[1],/前日以前の報告/);
  }
});
test('LINE履歴取得エラーはレスポンス本文を含む', async t => {
  const home=tmp(t); fs.mkdirSync(path.join(home,'.claude')); fs.writeFileSync(path.join(home,'.claude','line-send.env'),'LINE_CHANNEL_ACCESS_TOKEN=test\nSUPABASE_URL=https://example.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=test\n');
  await assert.rejects(()=>fetchHistory('line','C10930732da844f79c6032a40705a4d73',{home,fetchImpl:async()=>new Response('{"message":"missing column"}',{status:400})}),/HTTP 400: .*missing column/);
});
test('DiscordユーザーIDは404時にDMチャンネルを作って履歴を読む', async t => {
  const home=tmp(t); fs.mkdirSync(path.join(home,'.claude')); fs.writeFileSync(path.join(home,'.claude','orgiast-discord-bot-token.txt'),'token');
  const calls=[];
  const result=await fetchHistory('discord','1423319951980232744',{home,fetchImpl:async (url,init={})=>{
    calls.push({url:String(url),init});
    if(calls.length===1) return new Response('not found',{status:404});
    if(calls.length===2) return Response.json({id:'dm-1'});
    return Response.json([{id:'m1',timestamp:'2026-11-10T00:00:00.000Z',author:{bot:false,username:'satou'},content:'了解です'}]);
  }});
  assert.equal(result.target,'dm-1');
  assert.equal(JSON.parse(calls[1].init.body).recipient_id,'1423319951980232744');
  assert.equal(result.messages[0].text,'了解です');
});
test('LLM判定はWindowsの引数長制限を避けてprompt-fileを使う', () => {
  let prompt='';
  const result=runLlm([{text:'長文'.repeat(20000)}],'テスト本文',{spawn:(_exe,args)=>{ const i=args.indexOf('--prompt-file'); assert.ok(i>=0); prompt=fs.readFileSync(args[i+1],'utf8'); return {status:0,stdout:'{"verdict":"OK","reason":"整合","warnings":[]}',stderr:''}; }});
  assert.match(prompt,/長文長文/); assert.equal(result.ok,true);
});
test('Discord名前解決はDMを開いて履歴だけを読み、メッセージはPOSTしない', async t => {
  const home=tmp(t); fs.mkdirSync(path.join(home,'.claude')); fs.writeFileSync(path.join(home,'.claude','orgiast-discord-bot-token.txt'),'token');
  const calls=[];
  const result=await fetchHistory('discord','佐藤優奈',{home,fetchImpl:async(url,init={})=>{
    url=String(url);
    calls.push({url,init});
    if(url.includes('/members/search')) return Response.json([{user:{id:'1423319951980232744',global_name:'佐藤優奈',username:'satou1319'}}]);
    if(init.method==='POST') { assert.ok(url.endsWith('/users/@me/channels')); assert.equal(JSON.parse(init.body).recipient_id,'1423319951980232744'); return Response.json({id:'dm-satou'}); }
    assert.ok(url.endsWith('/channels/dm-satou/messages?limit=100'));
    return Response.json([]);
  }});
  assert.equal(result.target,'dm-satou');
  assert.equal(calls.filter(x=>x.init.method==='POST').length,1);
});
test('既存DiscordチャンネルIDはDMを作らず読み、403は読み取り失敗として止める', async t => {
  const home=tmp(t); fs.mkdirSync(path.join(home,'.claude')); fs.writeFileSync(path.join(home,'.claude','orgiast-discord-bot-token.txt'),'token');
  await fetchHistory('discord','1561703420455292979',{home,fetchImpl:async(_url,init)=>{assert.notEqual(init.method,'POST');return Response.json([]);}});
  await assert.rejects(()=>fetchHistory('discord','1561703420455292979',{home,fetchImpl:async(_url,init)=>{assert.notEqual(init.method,'POST');return new Response('forbidden',{status:403});}}),/HTTP 403/);
});
test('安価LLMが空出力ならGroqへ切り替えてJSON判定を完了する', () => {
  const providers=[];
  const result=runLlm([{party:'external',text:'確認しました'}],'返信',{spawn:(_exe,args)=>{
    providers.push(args[args.indexOf('--provider')+1]);
    return providers.length===1 ? {status:0,stdout:'(出力なし)',stderr:'gemini out=0'} : {status:0,stdout:'{"verdict":"OK","reason":"整合","warnings":[]}',stderr:''};
  }});
  assert.deepEqual(providers,['gemini','groq']);
  assert.equal(result.ok,true);
});
test('回答済み質問を再送する判定はNGでマーカーを書かない', async t => {
  const home=tmp(t), file=path.join(home,'body.txt'); fs.writeFileSync(file,'予備日はいつですか？');
  const code=await main(['--channel','line','--target','C1','--text-file',file],{home,fetchHistory:async()=>({target:'C1',messages:[{id:'m1',at:new Date().toISOString(),side:'external',text:'予備日は11月20日です'}]}),runLlm:()=>({ok:false,reason:'回答済みの予備日を聞き直している',warnings:[]})});
  assert.equal(code,2); assert.equal(fs.existsSync(path.join(home,'.claude','send-context-checks')),false);
});
test('マーカー無し送信は拒否', async t => {
  await assert.rejects(()=>assertContextApproved({channel:'line',target:'C1',text:'本文',home:tmp(t),getLatest:async()=>null}),/承認マーカーがありません/);
});
test('マーカー後の新着は拒否', async t => {
  const home=tmp(t); writeContextMarker({channel:'line',target:'C1',text:'本文',latest:{id:'m1',at:'2026-11-10T00:00:00.000Z'},reason:'OK',home});
  await assert.rejects(()=>assertContextApproved({channel:'line',target:'C1',text:'本文',home,getLatest:async()=>({id:'m2',at:'2026-11-10T00:01:00.000Z'})}),/新着/);
});
test('OKマーカーかつ最新一致なら許可', async t => {
  const home=tmp(t), latest={id:'m1',at:'2026-11-10T00:00:00.000Z'}; writeContextMarker({channel:'line',target:'C1',text:'本文',latest,reason:'OK',home});
  assert.equal((await assertContextApproved({channel:'line',target:'C1',text:'本文',home,getLatest:async()=>latest})).reason,'OK');
});
test('beeper --dry-run はマーカー無しでも許可', async t => {
  const home=tmp(t), file=path.join(home,'body.txt'); fs.writeFileSync(file,'本文');
  const cli=fileURLToPath(new URL('./beeper-send.mjs',import.meta.url));
  assert.equal(spawnSync(process.execPath,[cli,'--chat','c1','--body-file',file,'--dry-run'],{env:{...process.env,ORGIAST_HOME:home}}).status,0);
});
test('--intended-change ありで条件変更を正しく送る場合（変更明示・値整合）はOK', () => {
  let prompt='';
  const verdict=runLlm(
    [{party:'internal',sender:'オージャスト',text:'設営 9:00〜13:00・5,200円で確定です',at:'2026-11-09T10:00:00Z'}],
    '11/9に確定でお伝えした設営条件に変更が出そうで申し訳ありません。設営 9:00〜18:00（休憩1時間）、日報酬 10,400円への変更をご検討いただけますでしょうか。',
    {intendedChanges:['設営時間 9:00-13:00 → 9:00-18:00（休憩1時間）','設営日報酬 5,200円 → 10,400円'],
     spawn:(_exe,args)=>{prompt=fs.readFileSync(args[args.indexOf('--prompt-file')+1],'utf8');return {status:0,stdout:'{"verdict":"OK","reason":"意図した変更を明示、値も履歴と整合","warnings":[]}',stderr:''};}}
  );
  assert.match(prompt,/意図した変更/);
  assert.match(prompt,/設営時間/);
  assert.match(prompt,/設営日報酬/);
  assert.match(prompt,/その変更自体を矛盾・重複としてNGにしない/);
  assert.equal(verdict.ok,true);
});
test('--intended-change ありでも変更前値が履歴と食い違う場合はNG', () => {
  let prompt='';
  const verdict=runLlm(
    [{party:'internal',sender:'オージャスト',text:'設営 9:00〜13:00・5,200円で確定です',at:'2026-11-09T10:00:00Z'}],
    '変更があります。設営 9:00〜18:00、日報酬 10,400円でお願いします。',
    {intendedChanges:['設営時間 9:00-13:00 → 9:00-18:00','設営日報酬 5,200円 → 10,400円'],
     spawn:(_exe,args)=>{prompt=fs.readFileSync(args[args.indexOf('--prompt-file')+1],'utf8');return {status:0,stdout:'{"verdict":"NG","reason":"変更であることを明示していない。変更前の値5,200円の根拠が本文から確認できない","warnings":[]}',stderr:''};}}
  );
  assert.match(prompt,/意図した変更/);
  assert.match(prompt,/変更であることを明示していない場合はNG/);
  assert.equal(verdict.ok,false);
});
test('--intended-change なしでも変更を明示していれば従来通りOK可', () => {
  let prompt='';
  const verdict=runLlm(
    [{party:'internal',sender:'オージャスト',text:'予備日は11月20日で',at:'2026-11-08T10:00:00Z'}],
    'お世話になっております。先日確定した予備日11月20日ですが、別の日程でご調整いただくことは可能でしょうか。',
    {spawn:(_exe,args)=>{prompt=fs.readFileSync(args[args.indexOf('--prompt-file')+1],'utf8');return {status:0,stdout:'{"verdict":"OK","reason":"新たなお伺いであり矛盾ではない","warnings":[]}',stderr:''};}}
  );
  assert.doesNotMatch(prompt,/意図した変更/);
  assert.equal(verdict.ok,true);
});
test('main --intended-change をparseしてマーカーに記録する', async t => {
  const home=tmp(t), file=path.join(home,'body.txt'); fs.writeFileSync(file,'変更のご連絡');
  const code=await main(['--channel','discord','--target','1423319951980232744','--text-file',file,'--intended-change','時間変更','--intended-change','金額変更'],{
    home,
    fetchHistory:async()=>({target:'dm-1',messages:[{id:'m1',at:'2026-11-10T00:00:00.000Z',side:'self',party:'internal',sender:'オージャスト',text:'確定'}]}),
    runLlm:()=>({ok:true,reason:'条件変更確認',warnings:[]})
  });
  assert.equal(code,0);
  const markers=fs.readdirSync(path.join(home,'.claude','send-context-checks'));
  assert.equal(markers.length,1);
  const marker=JSON.parse(fs.readFileSync(path.join(home,'.claude','send-context-checks',markers[0]),'utf8'));
  assert.deepEqual(marker.intendedChanges,['時間変更','金額変更']);
});
test('--intended-change 無しのマーカーはintendedChangesをundefinedのまま', async t => {
  const home=tmp(t), file=path.join(home,'body.txt'); fs.writeFileSync(file,'通常連絡');
  const code=await main(['--channel','discord','--target','1423319951980232744','--text-file',file],{
    home,
    fetchHistory:async()=>({target:'dm-1',messages:[{id:'m1',at:'2026-11-10T00:00:00.000Z',side:'self',party:'internal',sender:'オージャスト',text:'確認'}]}),
    runLlm:()=>({ok:true,reason:'問題なし',warnings:[]})
  });
  assert.equal(code,0);
  const markers=fs.readdirSync(path.join(home,'.claude','send-context-checks'));
  assert.equal(markers.length,1);
  const marker=JSON.parse(fs.readFileSync(path.join(home,'.claude','send-context-checks',markers[0]),'utf8'));
  assert.equal(marker.intendedChanges,undefined);
});
test('Gmail履歴取得はDRAFTメッセージを除外し検索時に-in:draftsを指定する', async t => {
  const home = tmp(t);
  const calls = [];
  const result = await fetchHistory('gmail', 'client@example.com', {
    home,
    getGmailToken: async () => 'fake-token',
    fetchImpl: async (url, init = {}) => {
      const urlStr = String(url);
      calls.push({ url: urlStr, init });
      if (urlStr.includes('/oauth2/token')) {
        return Response.json({ access_token: 'fake-token' });
      }
      if (urlStr.includes('/messages?q=')) {
        assert.match(urlStr, /-in%3Adrafts/i);
        return Response.json({ messages: [{ id: 'm-sent', threadId: 'thread-123' }] });
      }
      if (urlStr.includes('/threads/thread-123')) {
        return Response.json({
          id: 'thread-123',
          messages: [
            {
              id: 'm-sent',
              labelIds: ['SENT'],
              internalDate: '1794132000000', // 2026-11-08T10:00:00Z
              payload: {
                headers: [
                  { name: 'From', value: 'seisaku-team@orgiast.jp' },
                  { name: 'To', value: 'client@example.com' }
                ],
                body: { data: Buffer.from('送信済みの案内本文', 'utf8').toString('base64url') }
              }
            },
            {
              id: 'm-recv',
              labelIds: ['INBOX'],
              internalDate: '1794218400000', // 2026-11-09T10:00:00Z
              payload: {
                headers: [
                  { name: 'From', value: 'client@example.com' },
                  { name: 'To', value: 'seisaku-team@orgiast.jp' }
                ],
                body: { data: Buffer.from('相手からの返信本文', 'utf8').toString('base64url') }
              }
            },
            {
              id: 'm-draft',
              labelIds: ['DRAFT'],
              internalDate: '1794304800000', // 2026-11-10T10:00:00Z
              payload: {
                headers: [
                  { name: 'From', value: 'seisaku-team@orgiast.jp' },
                  { name: 'To', value: 'client@example.com' }
                ],
                body: { data: Buffer.from('作成中の下書き本文', 'utf8').toString('base64url') }
              }
            }
          ]
        });
      }
      return new Response('not found', { status: 404 });
    }
  });

  assert.equal(result.target, 'thread-123');
  assert.equal(result.messages.length, 2);
  assert.deepEqual(result.messages.map(m => m.id), ['m-sent', 'm-recv']);
  assert.ok(!result.messages.some(m => m.text.includes('作成中の下書き本文')));
  assert.equal(result.messages[0].text, '送信済みの案内本文');
  assert.equal(result.messages[1].text, '相手からの返信本文');
});
