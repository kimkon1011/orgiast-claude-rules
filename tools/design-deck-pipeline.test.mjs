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
  if(!process.env.DESIGN_DECK_TEST_KEEP_TEMP)t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
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
  for(const slide of html.match(/<section\b[\s\S]*?<\/section>/g))assert.match(slide,/<figure[^>]*data-photo="true"[^>]*>[\s\S]*?<img/);
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

test('build and standalone report fail with every missing page named, ignoring stale success and exemptions',async t=>{
  const f=await fixture(t);
  for(const index of [0,3,5]){
    const p=f.pages[index];delete p.visualBrief;delete p.fallbackPhoto;
    p.elements=[{kind:'text',text:'写真ではない'}];
    p.allowNoImage=true; // No opt-out flag is recognized.
  }
  f.pages[5].headline='会社概要';f.save();
  fs.mkdirSync(path.join(f.dir,'out'));
  fs.writeFileSync(path.join(f.dir,'out','build-checks.json'),JSON.stringify({pages:f.pages.map(p=>({id:p.id,visual:{mode:'gemini'}})),warnings:[]}));
  fs.writeFileSync(path.join(f.dir,'out','pdf-info.json'),JSON.stringify({pageCount:7,bytes:999}));
  fs.writeFileSync(path.join(f.root,'html-to-pdf.mjs'),"import fs from 'node:fs';fs.writeFileSync('pdf-was-called','yes');");
  for(const entry of ['report.mjs','build.mjs']){
    const run=spawnSync(process.execPath,[path.join(f.dir,entry)],{encoding:'utf8'});
    assert.notEqual(run.status,0);assert.match(run.stderr,/画像なしページ: 3件/);
    const report=fs.readFileSync(path.join(f.dir,'BUILD-REPORT.md'),'utf8');
    assert.match(report,/画像なしページ: 3件/);
    for(const index of [0,3,5])assert.ok(report.includes(`${f.pages[index].id}: ${f.pages[index].headline}`));
    assert.match(report,/既存PDFは今回の成果物として使用不可/);
  }
  assert.equal(fs.existsSync(path.join(f.root,'pdf-was-called')),false);
  assert.equal(fs.existsSync(path.join(f.dir,'out','企画書.html')),false);
  const checks=JSON.parse(fs.readFileSync(path.join(f.dir,'out','build-checks.json'),'utf8'));
  assert.equal(checks.missingImagePages.length,3);assert.equal(checks.errors.length,1);
  assert.throws(()=>f.build.buildHTML(f.pages),/画像なしページ: 3件/);
});

test('all pages with images pass the build and report CLIs',async t=>{
  const f=await fixture(t);
  // Isolated PDF adapter tests the gate and subprocess flow, without browser/API dependencies.
  fs.writeFileSync(path.join(f.root,'html-to-pdf.mjs'),`import fs from 'node:fs';fs.writeFileSync(process.argv[3],'%PDF-1.4\\n'+('/Type /Page\\n').repeat(${f.pages.length}));`);
  for(const entry of ['build.mjs','report.mjs']){
    const run=spawnSync(process.execPath,[path.join(f.dir,entry)],{encoding:'utf8'});
    assert.equal(run.status,0,run.stderr);
    if(entry==='build.mjs')assert.match(run.stdout,/BUILD OK: 7 pages/);
  }
  assert.match(fs.readFileSync(path.join(f.dir,'BUILD-REPORT.md'),'utf8'),/画像なしページ: 0件/);
});

test('image elements render and empty images, whitespace briefs and missing generation fail',async t=>{
  const f=await fixture(t),p=f.pages[3];
  delete p.fallbackPhoto;delete p.visualBrief;
  p.elements=[{kind:'image',src:'../assets/photo.svg'}];
  const {html,checks}=f.build.buildHTML([p]);
  assert.equal(checks[0].visual.mode,'image-element');assert.match(html,/data-photo="true"><img/);
  p.elements[0].src='../assets/missing.svg';f.save();
  assert.throws(()=>f.runtime.loadPages(),/Missing\/outside project asset/);
  assert.throws(()=>f.build.buildHTML([p]),/画像未生成・参照ファイルなし/);
  p.elements=[{kind:'image'}];p.visualBrief='   ';
  assert.throws(()=>f.build.buildHTML([p]),/画像指定なし/);
  p.visualBrief='明るい完成会場';
  assert.throws(()=>f.build.buildHTML([p]),/画像未生成・参照ファイルなし/);
  fs.mkdirSync(path.join(f.dir,'visuals'));
  fs.writeFileSync(path.join(f.dir,'visuals',`${p.id}.png`),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=','base64'));
  const generated=f.build.buildHTML([p]);
  assert.equal(generated.checks[0].visual.mode,'gemini');
  assert.match(generated.html,/イメージ（AI生成）/);
});

test('nested image elements and file/path aliases remain supported and validated',async t=>{
  const f=await fixture(t),p=f.pages[3];delete p.fallbackPhoto;delete p.visualBrief;
  for(const field of ['file','path']){
    p.elements=[{kind:'group',children:[{kind:'image',[field]:'../assets/photo.svg'}]}];f.save();
    assert.deepEqual(f.runtime.imageMissingPages(f.runtime.loadPages()),[]);
    assert.match(f.build.buildHTML([p]).html,/data-photo="true"><img/);
  }
  p.visualBrief='Generate a photo';p.elements[0].children[0].path='../assets/missing.svg';f.save();
  assert.throws(()=>f.runtime.loadPages(),/Missing\/outside project asset/);
});

test('legacy diagram and finance templates render the required photo alongside editable data',async t=>{
  const f=await fixture(t),base=f.pages[3];
  const diagram={...base,id:'diagram',type:'layout-diagram',svg:'../assets/photo.svg'};
  const finance={...base,id:'finance',type:'finance-table',formulas:[]};
  const {html}=f.build.buildHTML([diagram,finance]);
  for(const slide of html.match(/<section\b[\s\S]*?<\/section>/g))assert.match(slide,/data-photo="true"><img/);
  assert.match(html,/<svg/);assert.match(html,/<table/);
});
