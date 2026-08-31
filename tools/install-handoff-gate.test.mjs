import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { install } from './install-handoff-gate.mjs';

const old='powershell -File "C:\\x\\manual-handoff-detector.ps1"';
function fixture(){const home=fs.mkdtempSync(path.join(os.tmpdir(),'handoff-installer-')),claude=path.join(home,'.claude'),file=path.join(claude,'settings.json');fs.mkdirSync(path.join(claude,'hooks'),{recursive:true});fs.writeFileSync(file,JSON.stringify({other:'keep',hooks:{Stop:[{matcher:'*',hooks:[{type:'command',command:old},{type:'command',command:'keep-stop'}]}],SessionStart:[{matcher:'*',hooks:[{type:'command',command:'keep-start'}]}]}}));fs.writeFileSync(path.join(claude,'hooks','manual-handoff-detector.ps1'),'legacy');return{home,file,claude};}
const quiet=()=>{};
const all=s=>Object.values(s.hooks).flatMap(gs=>gs.flatMap(g=>g.hooks||[])).map(h=>h.command);

test('dry-runでは1バイトも書かない',()=>{const x=fixture(),before=fs.readFileSync(x.file);install({home:x.home,log:quiet});assert.deepEqual(fs.readFileSync(x.file),before);assert.ok(fs.existsSync(path.join(x.claude,'hooks','manual-handoff-detector.ps1')));});
test('旧hookを削除し新2件を追加し他hookを保持',()=>{const x=fixture();install({home:x.home,apply:true,log:quiet});const s=JSON.parse(fs.readFileSync(x.file));const cs=all(s);assert.equal(cs.length,4);assert.ok(!cs.some(c=>c.includes('manual-handoff-detector.ps1')));assert.ok(cs.includes('keep-stop')&&cs.includes('keep-start'));assert.equal(cs.filter(c=>c.includes('handoff-quality-gate.mjs')).length,1);assert.equal(cs.filter(c=>c.includes('rule-compliance-report.mjs')).length,1);});
test('2回目は変更なし',()=>{const x=fixture();install({home:x.home,apply:true,log:quiet});const before=fs.readFileSync(x.file);const lines=[];const r=install({home:x.home,apply:true,log:x=>lines.push(x)});assert.equal(r.changed,false);assert.deepEqual(fs.readFileSync(x.file),before);assert.ok(lines.includes('変更なし'));});
test('不正JSONは何も書かず非0相当の例外',()=>{const x=fixture();fs.writeFileSync(x.file,'{bad');const before=fs.readFileSync(x.file);assert.throws(()=>install({home:x.home,apply:true,log:quiet}),/不正JSON/);assert.deepEqual(fs.readFileSync(x.file),before);});
test('read-back失敗時はバックアップから復元',()=>{const x=fixture(),before=fs.readFileSync(x.file);assert.throws(()=>install({home:x.home,apply:true,failReadBack:true,log:quiet}),/復元/);assert.deepEqual(fs.readFileSync(x.file),before);});
test('リネーム先があれば上書きしない',()=>{const x=fixture(),dst=path.join(x.claude,'hooks','manual-handoff-detector.ps1.bak-20260828-superseded');fs.writeFileSync(dst,'existing');const lines=[];install({home:x.home,apply:true,log:x=>lines.push(x)});assert.equal(fs.readFileSync(dst,'utf8'),'existing');assert.ok(fs.existsSync(path.join(x.claude,'hooks','manual-handoff-detector.ps1')));assert.ok(lines.some(x=>x.includes('上書きせずスキップ')));});
test('バックアップを作成する',()=>{const x=fixture();install({home:x.home,apply:true,log:quiet});assert.ok(fs.readdirSync(x.claude).some(n=>n.startsWith('settings.json.bak-')));});
