import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { installApp } from './install.mjs';
import { verifyApp } from './verify.mjs';
import { judge } from '../../tools/feedback-form-gate.mjs';
import { scanApps } from '../../tools/feedback-kit-migrate.mjs';
import { atLeast } from './common.mjs';
function fixture(t,kind='gas') {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'feedback-kit-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const app=path.join(root,'app');fs.mkdirSync(app);
  if(kind==='gas') {fs.writeFileSync(path.join(app,'.clasp.json'),JSON.stringify({rootDir:'src'}));fs.mkdirSync(path.join(app,'src'));fs.writeFileSync(path.join(app,'src/Code.gs'),'function doGet(e) { return HtmlService.createHtmlOutput("existing app"); }');}
  else {fs.mkdirSync(path.join(app,'app'));fs.writeFileSync(path.join(app,'package.json'),JSON.stringify({dependencies:{next:'15.0.0'}}));fs.writeFileSync(path.join(app,'app/layout.tsx'),'export default function Layout({children}) {return <html><body>{children}</body></html>;}');}
  return {root,app,registryFile:path.join(root,'registry.json'),appsFile:path.join(root,'apps.json'),localFile:path.join(root,'local.json')};
}
for(const kind of ['gas','next']) test(`${kind}: install → verify, repeated installation, isolated registry`,t=>{
  const f=fixture(t,kind);installApp({...f,name:'検証アプリ'});
  assert.deepEqual(verifyApp(f.app,f).missing,[]);
  const before=fs.readFileSync(path.join(f.app,'.feedback-kit.json'),'utf8');
  installApp(f);assert.equal(fs.readFileSync(path.join(f.app,'.feedback-kit.json'),'utf8'),before);
  assert.equal(JSON.parse(fs.readFileSync(f.registryFile)).apps.length,1);
  assert.deepEqual(verifyApp(f.app,f).missing,[]);
});
test('dry-run does not write files or registry',t=>{const f=fixture(t);const before=fs.readdirSync(f.app);assert.equal(installApp({...f,dryRun:true}).dryRun,true);assert.deepEqual(fs.readdirSync(f.app),before);assert.equal(fs.existsSync(f.registryFile),false);});
test('upgrade backs up legacy form and replaces nested custom modal',t=>{
  const f=fixture(t);const old='<input name="title"><textarea></textarea>';
  fs.writeFileSync(path.join(f.app,'src/FeedbackForm.html'),old);
  fs.writeFileSync(path.join(f.app,'src/Index.html'),'<main>keep</main><div id="feedbackModal"><div><input id="old-title"></div></div><footer>keep</footer>');
  assert.throws(()=>installApp(f),/--upgrade/);installApp({...f,upgrade:true});
  assert.deepEqual(verifyApp(f.app,f).missing,[]);
  const index=fs.readFileSync(path.join(f.app,'src/Index.html'),'utf8');assert.match(index,/data-feedback-kit-frame/);assert.doesNotMatch(index,/old-title/);assert.match(index,/<footer>keep/);
  const backups=fs.readdirSync(path.join(f.app,'.feedback-kit-backup'));assert.ok(backups.some(d=>fs.existsSync(path.join(f.app,'.feedback-kit-backup',d,'src/FeedbackForm.html'))));
});
test('gate denies old version and real UI regressions despite stamped metadata',t=>{
  const f=fixture(t);installApp(f);
  const judgeOptions={zeroRegistryFile:f.registryFile};
  assert.equal(judge({command:'clasp push',cwd:f.app},judgeOptions).deny,false);
  const file=path.join(f.app,'src/FeedbackForm.html');fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace("document.addEventListener('paste'","document.addEventListener('copy'"));
  let r=judge({command:'clasp push',cwd:f.app},judgeOptions);assert.equal(r.deny,true);assert.match(r.reason,/image-attach/);assert.match(r.reason,/--upgrade/);
  installApp({...f,upgrade:true});const meta=path.join(f.app,'.feedback-kit.json'),value=JSON.parse(fs.readFileSync(meta));value.kitVersion='0.9.9';fs.writeFileSync(meta,JSON.stringify(value));assert.ok(verifyApp(f.app,f).missing.includes('kit-version'));
});
test('registry missing is not zero-backlog registered',t=>{const f=fixture(t);installApp(f);fs.unlinkSync(f.registryFile);assert.ok(verifyApp(f.app,f).missing.includes('zero-backlog-registered'));});
test('scan finds clasp root only and skips backups and node_modules',t=>{const f=fixture(t);installApp(f);fs.writeFileSync(path.join(f.app,'src/appsscript.json'),'{}');assert.deepEqual(scanApps([f.root,f.app]),[f.app]);});
test('semver numeric comparison and malformed versions fail closed',()=>{assert.equal(atLeast('1.10.0','1.2.0'),true);for(const v of ['1.0','garbage','1.0.0-beta','01.0.0'])assert.equal(atLeast(v,'1.0.0'),false);});
test('GAS backend rejects title-only and too many images before saving',()=>{
  const code=fs.readFileSync(new URL('../feedback-gas/templates/FeedbackRelay.js',import.meta.url),'utf8');
  const ctx=vm.createContext({});vm.runInContext(code,ctx);ctx._FeedbackRelay_checkRateLimit=()=>true;
  assert.equal(ctx.FeedbackRelay_submitFromForm({title:'only'}).ok,false);
  assert.equal(ctx.FeedbackRelay_submitFromForm({body:'required',images:Array(6).fill({})}).ok,false);
});
