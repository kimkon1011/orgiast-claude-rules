import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { insertBlock } from './claude-md-block.mjs';
function fixture(t, content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-block-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'CLAUDE.md'); fs.writeFileSync(file, content); return { file, root };
}
test('新規差し込み・段落の後・再実行は unchanged・中身更新・バックアップ', t => {
  const {file, root} = fixture(t, '# rules\n\nアンカー\n同じ段落\n\n次の段落\n');
  const args = {file, id:'presend-reply-check', block:'本文', after:'アンカー'};
  assert.equal(insertBlock(args), 'inserted');
  const first = fs.readFileSync(file,'utf8'); assert.match(first,/同じ段落\n\n<!-- BEGIN/);
  assert.equal(insertBlock(args),'unchanged'); assert.equal(fs.readdirSync(root).length,2);
  assert.equal(insertBlock({...args,block:'新しい本文'}),'updated');
  assert.equal(fs.readFileSync(file,'utf8').split('<!-- BEGIN').length,2);
  assert.equal(fs.readdirSync(root).length,3);
});
test('アンカー無しは末尾', t => {
  const {file}=fixture(t,'先頭\n'); insertBlock({file,id:'test',block:'末尾',after:'無い'});
  assert.match(fs.readFileSync(file,'utf8'),/^先頭\n\n<!-- BEGIN/);
});
test('CRLF維持・BOMなし', t => {
  const {file}=fixture(t,'\uFEFF先頭\r\n\r\n次\r\n'); insertBlock({file,id:'test',block:'本文\n次行'});
  const text=fs.readFileSync(file,'utf8'); assert.notEqual(text.charCodeAt(0),0xfeff); assert.equal(text.replaceAll('\r\n','').includes('\n'),false);
});
test('dry-run は原本・バックアップを変更しない', t => {
  const {file,root}=fixture(t,'先頭\n'); assert.equal(insertBlock({file,id:'test',block:'本文',dryRun:true}),'inserted');
  assert.equal(fs.readFileSync(file,'utf8'),'先頭\n'); assert.equal(fs.readdirSync(root).length,1);
});
