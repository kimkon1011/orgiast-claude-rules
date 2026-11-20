import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findPcoContactBan, isPcoBlockedDomain, isPcoSendLifted, PCO_SEND_LIFT_PHRASE } from './pco-contact-ban.mjs';
import { main } from '../send-context-check.mjs';

test('公式窓口ドメインとサブドメインをブロックする', () => {
  assert.equal(isPcoBlockedDomain('congre.co.jp'), true);
  assert.equal(isPcoBlockedDomain('or.knt.co.jp'), true);
  assert.equal(isPcoBlockedDomain('www.convention.co.jp'), true);
  assert.equal(isPcoBlockedDomain('orgiast.jp'), false);
  assert.equal(findPcoContactBan({ target: 'h-tanaka@congre.co.jp' }).domain, 'congre.co.jp');
  assert.equal(findPcoContactBan({ target: '33sagpj-toroku@or.knt.co.jp' }).domain, 'or.knt.co.jp');
  assert.equal(isPcoBlockedDomain('or.knt.co.jp'), true);
  assert.equal(findPcoContactBan({ target: 'y-nakano@convention.co.jp' }).address, 'y-nakano@convention.co.jp');
  assert.equal(findPcoContactBan({ target: 'cl1@c-linkage.co.jp', text: 'ご提案' }).domain, 'c-linkage.co.jp');
  assert.equal(findPcoContactBan({ target: 'kim@orgiast.jp' }), null);
});

test('宛先名に運営会社名があればブロックし、本文中の社名だけでは止めない', () => {
  assert.equal(findPcoContactBan({ target: '日本コンベンションサービス 中野様' }).name, '日本コンベンションサービス');
  assert.equal(findPcoContactBan({ target: 'kim@orgiast.jp', text: '日本コンベンションサービス中野様との日程調整について' }), null);
});

test('解除フレーズがあるときだけ isPcoSendLifted が真になる', () => {
  assert.equal(isPcoSendLifted('金さんが承認'), false);
  assert.equal(isPcoSendLifted(`2026-11-17 金さん指示。${PCO_SEND_LIFT_PHRASE}`), true);
});

const tmp = t => { const p=fs.mkdtempSync(path.join(os.tmpdir(),'pco-ban-')); t.after(()=>fs.rmSync(p,{recursive:true,force:true})); return p; };

test('send-context-check はPCO宛を履歴照会前に止め、マーカーを作らない', async t => {
  const home=tmp(t);
  const file=path.join(home,'body.txt');
  fs.writeFileSync(file,'ご提案です。');
  let fetched=false;
  const code=await main(['--channel','gmail','--target','h-tanaka@congre.co.jp','--text-file',file],{
    home,
    fetchHistory:async()=>{ fetched=true; return {target:'h-tanaka@congre.co.jp',messages:[]}; },
    runLlm:()=>({ok:true,reason:'ok',warnings:[]}),
  });
  assert.equal(code,3);
  assert.equal(fetched,false);
  assert.equal(fs.existsSync(path.join(home,'.claude','send-context-checks')), false);
});

test('通常の --kim-approved ではPCO禁止を解除できない', async t => {
  const home=tmp(t);
  const file=path.join(home,'body.txt');
  fs.writeFileSync(file,'ご提案です。');
  const code=await main(['--channel','gmail','--target','y-nakano@convention.co.jp','--text-file',file,'--kim-approved','金さんが承認'],{
    home,
    fetchHistory:async()=>({target:'y-nakano@convention.co.jp',messages:[]}),
    runLlm:()=>({ok:true,reason:'ok',warnings:[]}),
  });
  assert.equal(code,3);
});

test('メモに解除フレーズがあれば通常の判定へ進む', async t => {
  const home=tmp(t);
  const file=path.join(home,'body.txt');
  fs.writeFileSync(file,'日程の件です。');
  const at=new Date().toISOString();
  const code=await main(['--channel','gmail','--target','y-nakano@convention.co.jp','--text-file',file,'--kim-approved',`既存やり取りの確認済み。${PCO_SEND_LIFT_PHRASE}`],{
    home,
    fetchHistory:async()=>({target:'y-nakano@convention.co.jp',messages:[{id:'m1',at,side:'external',text:'候補をください'}]}),
    runLlm:()=>({ok:true,reason:'既存の日程調整',warnings:[]}),
    resolveKimApprovedRecipient:async()=>({allowed:true,resolvedId:'y-nakano@convention.co.jp',source:'test'}),
  });
  assert.equal(code,0);
  const dir=path.join(home,'.claude','send-context-checks');
  assert.equal(fs.existsSync(dir), true);
});
