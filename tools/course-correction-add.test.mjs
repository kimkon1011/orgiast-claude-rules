import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addCorrection } from './course-correction-add.mjs';
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cc-add-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.writeFileSync(path.join(dir,'course-corrections.json'),JSON.stringify([{id:'CC-003'}]));fs.writeFileSync(path.join(dir,'course-corrections.md'),'# Original\n');return dir;}
test('allocates next ID and appends to both files without changing history',t=>{const dir=fixture(t);const r=addCorrection('指摘',{dir,rule:'規則',detectText:'禁止',detectEvidence:'失敗',severity:'warn',now:new Date('2026-10-08')});assert.equal(r.id,'CC-004');assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'course-corrections.json'))).length,2);assert.match(fs.readFileSync(path.join(dir,'course-corrections.md'),'utf8'),/^# Original\n\n## CC-004 \(2026-10-08\)/);});
test('invalid regex and severity leave both files untouched',t=>{const dir=fixture(t);for(const params of [{detectText:'['},{detectText:'ok',severity:'bad'}])assert.throws(()=>addCorrection('指摘',{dir,rule:'規則',...params}));assert.equal(fs.readFileSync(path.join(dir,'course-corrections.md'),'utf8'),'# Original\n');assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'course-corrections.json'))).length,1);});
