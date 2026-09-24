import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rotate, planRotation, MAX_BYTES, writeHandoff } from './next-session-rotate.mjs';
const now = new Date('2026-09-22T00:00:00Z');
const block = (date, tasks) => `<!-- NEXT-SESSION v1 -->\n<!-- 更新: ${date} / cwd: /example -->\n## 残TODO\n${tasks}\n## 対象\ncontext only\n`;
test('archives exact original, preserves pending continuations and removes only explicit completion', () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rotate-')); const file=path.join(dir,'next-session.md');
 const source=block('2026-09-20','1. still open\n  done substep ✅\n2. ~~done~~ → ✅\n3. still open\n  done substep ✅\n4. [FB:test] new bug')+block('2026-08-01','1. old issue');
 fs.writeFileSync(file,source); const r=rotate(file,{now});
 assert.equal(r.stats.pending,2); assert.equal(r.stats.duplicate,1); assert.equal(r.stats.old,1);
 assert.ok(fs.readFileSync(r.archive,'utf8').includes(source)); assert.match(fs.readFileSync(file,'utf8'),/done substep ✅/);
 const archived=fs.readFileSync(r.archive,'utf8'); const bytes=fs.readFileSync(file);
 assert.equal(rotate(file,{now}).changed,false); assert.deepEqual(fs.readFileSync(file),bytes); assert.equal(fs.readFileSync(r.archive,'utf8'),archived);
});
test('oversized pending queue remains reachable, cap is bytes not characters', () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rotate-')); const file=path.join(dir,'next-session.md');
 const source=block('2026-09-22',Array.from({length:150},(_,i)=>`${i+1}. TODO ${i} ${'日本語'.repeat(80)}`).join('\n'));
 writeHandoff(file,source); const text=fs.readFileSync(file,'utf8'); assert.ok(Buffer.byteLength(text)<=MAX_BYTES);
 const ref=text.match(/\[継続キュー[^\]]*\]\(([^)]+)\)/)[1]; const pending=fs.readFileSync(path.join(dir,ref),'utf8');
 for(let i=0;i<150;i++)assert.ok(text.includes(`TODO ${i} `)||pending.includes(`TODO ${i} `));
});
test('unknown dates and dates mentioned as deadlines are not aged out',()=>{
 const r=planRotation(block('','1. check deadline 2026-01-01\n2. 未完了'),{now}); assert.equal(r.stats.pending,2);
});
test('overflow rotation is idempotent and does not create nested pending queues',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rotate-')); const file=path.join(dir,'next-session.md');
 fs.writeFileSync(file,block('2026-09-22',Array.from({length:200},(_,i)=>`${i+1}. ${i} ${'あ'.repeat(100)}`).join('\n')));
 const r=rotate(file,{now}); const first=fs.readFileSync(file,'utf8'); const archive=fs.readFileSync(r.archive,'utf8');
 assert.equal(rotate(file,{now}).changed,false); assert.equal(fs.readFileSync(file,'utf8'),first); assert.equal(fs.readFileSync(r.archive,'utf8'),archive);
});
test('accumulated continuation entries are budget-checked and overflow instead of exceeding MAX_BYTES',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rotate-')); const file=path.join(dir,'next-session.md');
 const regular=Array.from({length:120},(_,i)=>`${i+1}. TODO ${i} ${'日本語'.repeat(60)}`).join('\n');
 const continuations=Array.from({length:8},(_,i)=>`${120+i+1}. [継続キュー: 未完了 ${i}件](archive/old-${i}.pending.md) — 過去の退避キュー`).join('\n');
 const source=block('2026-09-22',`${regular}\n${continuations}`);
 fs.writeFileSync(file,source);
 const r=rotate(file,{now});
 assert.equal(r.changed,true);
 const text=fs.readFileSync(file,'utf8');
 assert.ok(Buffer.byteLength(text)<=MAX_BYTES);
 // every continuation reference must survive, either inlined in the active queue or in the overflow pending file
 const pendingRef=text.match(/\[継続キュー[^\]]*\]\(([^)]+)\)/g)?.at(-1)?.match(/\(([^)]+)\)/)[1];
 const pendingText=pendingRef?fs.readFileSync(path.join(dir,pendingRef),'utf8'):'';
 for(let i=0;i<8;i++) assert.ok(text.includes(`old-${i}.pending.md`)||pendingText.includes(`old-${i}.pending.md`),`continuation ${i} lost`);
});
test('normalized queues still retire subsequently completed and newly expired items',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rotate-')); const file=path.join(dir,'next-session.md');
 fs.writeFileSync(file,block('2026-09-22','1. open')); rotate(file,{now});
 const r=rotate(file,{now:new Date('2026-11-01')});assert.equal(r.stats.old,1);assert.equal(r.stats.pending,0);
});
