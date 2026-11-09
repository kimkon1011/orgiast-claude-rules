import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertContextApproved, writeContextMarker } from './lib/send-context.mjs';
import { main } from './send-context-check.mjs';

const tmp = t => { const p=fs.mkdtempSync(path.join(os.tmpdir(),'send-context-')); t.after(()=>fs.rmSync(p,{recursive:true,force:true})); return p; };
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
