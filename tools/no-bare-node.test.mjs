import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
function files(dir) { return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(dir,e.name)):/\.(ps1|mjs|js)$/.test(e.name)&&!e.name.includes('.test.')?[path.join(dir,e.name)]:[]); }
function violations(source, ps=false) {
  const patterns=ps ? [/\bStart-Process\s+(?:-FilePath\s+)?(?:['"]node(?:\.exe)?['"]|node\b)/gi, /&\s+(?:['"]node(?:\.exe)?['"]|node\b)/g] : [/(?:spawn(?:Sync)?|execFile(?:Sync)?)\s*\(\s*['"`]node(?:\.exe)?['"`]/g, /(?:exec(?:Sync)?)\s*\(\s*['"`]node\s/g];
  return patterns.flatMap(p=>[...source.matchAll(p)].map(m=>m[0]));
}
test('tools: bare-node process/shell launches are forbidden',()=>{
  const found=files(root).flatMap(f=>violations(fs.readFileSync(f,'utf8'),f.endsWith('.ps1')).map(m=>`${path.relative(root,f)}: ${m}`));
  assert.deepEqual(found,[]);
});
test('guard rejects bare launch variants and accepts executable paths',()=>{
  for(const s of ["Start-Process -FilePath 'node'",'Start-Process node',"& node x",'& "node" x']) assert.ok(violations(s,true).length);
  for(const s of ["spawnSync('node', [])","spawn('node', [], {shell:true})","exec('node file.mjs')"]) assert.ok(violations(s).length);
  assert.equal(violations('spawn(process.execPath, [])').length,0);
  assert.equal(violations('& $nodeExe x',true).length,0);
});
