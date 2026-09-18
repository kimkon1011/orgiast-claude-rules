import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
const source=new URL('../skills/design-deck/pipeline/',import.meta.url);
async function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'design-deck-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const dir=path.join(root,'deck-hybrid');fs.cpSync(source,dir,{recursive:true});
  fs.mkdirSync(path.join(root,'assets'));
  fs.writeFileSync(path.join(root,'assets','photo.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="teal"/></svg>');
  const pages=JSON.parse(fs.readFileSync(path.join(dir,'pages.example.json'),'utf8'));
  for(const p of pages){if(p.photoSources)p.photoSources=['../assets/photo.svg','../assets/photo.svg'];if(p.fallbackPhoto)p.fallbackPhoto='../assets/photo.svg';if(p.directVisual)p.directVisual='../assets/photo.svg';}
  const save=()=>fs.writeFileSync(path.join(dir,'pages.json'),JSON.stringify(pages));save();
  const build=await import(pathToFileURL(path.join(dir,'build.mjs')).href);
  const runtime=await import(pathToFileURL(path.join(dir,'runtime.mjs')).href);
  return {root,dir,pages,save,build,runtime};
}
test('all seven example types render with embedded fallbacks and explicit perspective crop',async t=>{
  const f=await fixture(t),{html,checks}=f.build.buildHTML(f.runtime.loadPages());
  assert.equal((html.match(/<section /g)??[]).length,7);
  assert.equal(checks.flatMap(c=>c.warnings).length,0);
  assert.equal(checks[0].visual.mode,'fallback-original');
  assert.match(html,/data:image\/svg\+xml;base64,/);
  assert.match(html,/aspect-ratio:1600\/900/);
  assert.match(html,/width:100%;left:0%;top:0%/);
});
test('v4 table spans, escaping and cropped portrait survive distribution with arbitrary page id',async t=>{
  const f=await fixture(t),table=f.pages[3],perspective=f.pages[6];
  table.table.rows=[[{text:'<script>&',rowspan:2,colspan:2,class:'profit'}],[{text:'残す'}]];
  perspective.id='different-id';perspective.crop={x:280,y:60,width:812,height:880,sourceWidth:1536,sourceHeight:1024};
  const {html}=f.build.buildHTML([table,perspective]);
  assert.match(html,/rowspan="2" colspan="2" class="profit">&lt;script&gt;&amp;/);
  assert.match(html,/perspective-portrait/);
  assert.match(html,/aspect-ratio:812\/880/);
  assert.doesNotMatch(html,/<script>/);
});
test('invalid perspective crops and attempts to generate a supplied perspective are rejected',async t=>{
  const f=await fixture(t),p=f.pages[6];
  p.visualBrief='regenerate';f.save();assert.throws(()=>f.runtime.loadPages(),/Gemini加工は禁止/);
  delete p.visualBrief;p.crop.x=1601;f.save();assert.throws(()=>f.runtime.loadPages(),/crop/);
});
test('14/15 character and 3/4 line warning boundaries',async t=>{
  const f=await fixture(t);
  assert.equal(f.build.textWarnings({id:'p',headline:'あ'.repeat(14),body:'あ'.repeat(96)}).warnings.length,0);
  assert.equal(f.build.textWarnings({id:'p',headline:'あ'.repeat(15),body:'あ'.repeat(97)}).warnings.length,2);
});
test('PDF subprocess exit zero is insufficient when output is not a PDF',async t=>{
  const f=await fixture(t);
  fs.writeFileSync(path.join(f.root,'html-to-pdf.mjs'),"import fs from 'node:fs';fs.writeFileSync(process.argv[3],'not a pdf');");
  const run=spawnSync(process.execPath,[path.join(f.dir,'build.mjs')],{encoding:'utf8'});
  assert.notEqual(run.status,0);assert.match(run.stderr,/PDF verification failed/);
});
test('report does not inherit original project review, approval or source-table validation',async t=>{
  const f=await fixture(t);fs.mkdirSync(path.join(f.dir,'out'));
  const {writeReport}=await import(pathToFileURL(path.join(f.dir,'report.mjs')).href);writeReport();
  const report=fs.readFileSync(path.join(f.dir,'BUILD-REPORT.md'),'utf8');
  assert.match(report,/sourceHtml未指定/);assert.match(report,/未実施。全PNG/);
  assert.doesNotMatch(report,/全項目4|全11枚を原寸PNGで目視確認|採用実写真: w2/);
});
