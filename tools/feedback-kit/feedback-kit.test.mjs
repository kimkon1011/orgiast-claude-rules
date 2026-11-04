import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { installApp } from './install.mjs';
import { verifyApp } from './verify.mjs';
import { judge } from '../feedback-form-gate.mjs';
import { scanApps } from '../feedback-kit-migrate.mjs';
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
// GAS の ContentService.createTextOutput にも append があるため、append の有無だけでは
// JSON と HTML を区別できない。API の JSON 応答に launcher の HTML が混ざると JSON.parse が落ちる。
test('GAS integration never appends launcher HTML to a JSON doGet response',t=>{
  const f=fixture(t);
  fs.writeFileSync(path.join(f.app,'src/Code.gs'),'function doGet(e) {\n  return ContentService.createTextOutput(JSON.stringify({ok: true})).setMimeType(ContentService.MimeType.JSON);\n}\n');
  installApp({...f,name:'API アプリ'});
  const outputs=[{mime:'application/json'},{mime:''}].map(({mime})=>({content:'{"ok":true}',appends:0,append(s){this.appends+=1;this.content+=s;return this;},setMimeType(){return this;},getContent(){return this.content;},...(mime?{getMimeType:()=>mime}:{})}));
  for(const json of outputs){
    const ctx=vm.createContext({ContentService:{createTextOutput:()=>json,MimeType:{JSON:'application/json'}},HtmlService:{createTemplateFromFile:()=>({evaluate:()=>({getContent:()=>'<div id="feedbackKitOpen">'})})},FeedbackRelay_serveForm:()=>({getContent:()=>'<form>'})});
    vm.runInContext(fs.readFileSync(path.join(f.app,'src/Code.gs'),'utf8'),ctx);
    vm.runInContext(fs.readFileSync(path.join(f.app,'src/FeedbackKitIntegration.gs'),'utf8'),ctx);
    assert.equal(ctx.doGet({parameter:{}}),json);
    assert.equal(json.appends,0);
    assert.equal(json.content,'{"ok":true}');
  }
});
test('GAS integration still appends the launcher to HTML pages',t=>{
  const f=fixture(t);installApp({...f,name:'画面アプリ'});
  const html={content:'<html>app</html>',appends:0,append(s){this.appends+=1;this.content+=s;return this;},setTitle(){return this;},getContent(){return this.content;},getMimeType:()=>'text/html'};
  const ctx=vm.createContext({HtmlService:{createHtmlOutput:()=>html,createTemplateFromFile:()=>({evaluate:()=>({getContent:()=>'<div id="feedbackKitOpen">'})})},FeedbackRelay_serveForm:()=>({getContent:()=>'<form>'})});
  vm.runInContext(fs.readFileSync(path.join(f.app,'src/Code.gs'),'utf8'),ctx);
  vm.runInContext(fs.readFileSync(path.join(f.app,'src/FeedbackKitIntegration.gs'),'utf8'),ctx);
  assert.equal(ctx.doGet({parameter:{}}),html);
  assert.equal(html.appends,1);
  assert.match(html.content,/feedbackKitOpen/);
});
test('GAS backend rejects title-only and too many images before saving',()=>{
  const code=fs.readFileSync(new URL('./gas/templates/FeedbackRelay.js',import.meta.url),'utf8');
  const ctx=vm.createContext({});vm.runInContext(code,ctx);ctx._FeedbackRelay_checkRateLimit=()=>true;
  assert.equal(ctx.FeedbackRelay_submitFromForm({title:'only'}).ok,false);
  assert.equal(ctx.FeedbackRelay_submitFromForm({body:'required',images:Array(6).fill({})}).ok,false);
});

for (const kind of ['gas', 'next']) test(`${kind}: history links are required in the form and success UI`, t => {
  const f = fixture(t, kind); installApp(f);
  const file = path.join(f.app, kind === 'gas' ? 'src/FeedbackForm.html' : 'components/FeedbackWidget.tsx');
  const original = fs.readFileSync(file, 'utf8');
  assert.equal((original.match(/<a\b[^>]*data-feedback-history-link/g) || []).length, 2);
  assert.equal((original.match(/送信した内容・対応状況を見る/g) || []).length, 2);
  assert.equal(verifyApp(f.app, f).ok, true);
  fs.writeFileSync(file, original.replaceAll('data-feedback-history-link', 'data-removed-link'));
  const result = verifyApp(f.app, f);
  assert.equal(result.ok, false);
  assert.ok(result.missing.includes('submitter-history-link'));
  assert.equal(result.details['submitter-history-link'], 'フォームに送信内容を見るリンクがありません');
  // A comment mentioning the marker cannot satisfy verification.
  fs.appendFileSync(file, kind === 'gas' ? '<!-- <a data-feedback-history-link> -->' : '\n/* <a data-feedback-history-link> */');
  assert.equal(verifyApp(f.app, f).ok, false);
  if (kind === 'next') {
    assert.match(original, /href="\/feedback\/mine"/);
    assert.ok(fs.existsSync(path.join(f.app, 'app/feedback/mine/page.tsx')));
  }
});

test('Next installer always installs history, including --no-admin-page', async t => {
  const { spawnSync } = await import('node:child_process');
  const f = fixture(t, 'next');
  const result = spawnSync(process.execPath, ['tools/feedback-kit/widget/install.mjs', '--target', f.app, '--files-only', '--no-admin-page'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(f.app, 'app/feedback/mine/page.tsx')));
  assert.equal(fs.existsSync(path.join(f.app, 'app/feedback/page.tsx')), false);
});

test('standalone widget verify checks links before posting and accepts valid links', async t => {
  const f = fixture(t, 'next'); installApp(f);
  const file = path.join(f.app, 'components/FeedbackWidget.tsx');
  const original = fs.readFileSync(file, 'utf8');
  const source = fs.readFileSync(new URL('./widget/verify.mjs', import.meta.url), 'utf8').replace(/^import .*;$/gm, '').replace(/^#!.*\n/, '');
  for (const present of [true, false]) {
    fs.writeFileSync(file, present ? original : original.replaceAll('data-feedback-history-link', 'data-removed-link'));
    let posted = false, exitCode;
    const errors = [];
    const env = { ...process.env }; delete env.NEXT_PUBLIC_SUPABASE_URL; delete env.SUPABASE_SERVICE_ROLE_KEY;
    const ctx = vm.createContext({
      existsSync: fs.existsSync, readFileSync: fs.readFileSync, readdirSync: fs.readdirSync,
      resolve: path.resolve, join: path.join, FormData,
      process: { argv: ['node', 'verify.mjs', '--target', f.app, '--url', 'https://example.test'], cwd: () => f.app, env,
        exit: code => { exitCode = code; throw new Error('test exit'); } },
      console: { log() {}, warn() {}, error: message => errors.push(message) },
      fetch: async () => { posted = true; return { ok: true, json: async () => ({ ok: true }) }; },
    });
    await vm.runInContext(`(async () => { ${source} })()`, ctx).catch(e => { assert.equal(e.message, 'test exit'); });
    assert.equal(posted, present);
    assert.equal(exitCode, present ? 0 : 1);
    assert.equal(errors.some(e => e.includes('フォームに送信内容を見るリンクがありません')), !present);
  }
});

test('GAS history URL respects override, default Sheet ACL and unconfigured fallback', () => {
  let props = {}, spreadsheet = null;
  const ctx = vm.createContext({
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => props[key] || '' }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://example.test/exec' }) },
  });
  vm.runInContext(fs.readFileSync(new URL('./gas/templates/FeedbackRelay.js', import.meta.url), 'utf8'), ctx);
  assert.equal(ctx.FeedbackRelay_historyUrl(), 'https://example.test/exec?view=mine');
  props.FEEDBACK_HISTORY_URL = 'https://example.test/read-only';
  assert.equal(ctx.FeedbackRelay_historyUrl(), props.FEEDBACK_HISTORY_URL);
  props.FEEDBACK_HISTORY_URL = 'javascript:alert(1)';
  spreadsheet = { getSheetByName: name => { assert.equal(name, '不具合要望'); return { getSheetId: () => 42 }; }, getUrl: () => 'https://docs.google.com/spreadsheets/d/test/edit' };
  assert.equal(ctx.FeedbackRelay_historyUrl(), 'https://docs.google.com/spreadsheets/d/test/edit#gid=42');
  spreadsheet.getSheetByName = () => null;
  assert.equal(ctx.FeedbackRelay_historyUrl(), spreadsheet.getUrl());
});

test('GAS form receives history URL and fallback route precedes existing app', t => {
  const f = fixture(t); installApp(f);
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(f.app, 'src/FeedbackRelay.js'), 'utf8'), ctx);
  const template = { evaluate: () => ({ setTitle() { return this; }, addMetaTag() { return this; } }) };
  ctx._FeedbackRelay_loadFormTemplate = () => template;
  ctx.FeedbackRelay_historyUrl = () => 'https://example.test/history';
  ctx.FeedbackRelay_serveForm({ app: 'test' });
  assert.equal(template.historyUrl, 'https://example.test/history');
  vm.runInContext(fs.readFileSync(path.join(f.app, 'src/FeedbackKitIntegration.gs'), 'utf8'), ctx);
  const expected = {};
  ctx.FeedbackRelay_serveHistory = () => expected;
  ctx.FeedbackKit_originalDoGet = () => { throw new Error('must not reach existing app'); };
  assert.equal(ctx.doGet({ parameter: { view: 'mine' } }), expected);
});

test('Next history authenticates chunked cookies and queries only the verified submitter', async () => {
  const { stripTypeScriptTypes } = await import('node:module');
  const source = fs.readFileSync(new URL('./widget/templates/feedback-mine-page.tsx', import.meta.url), 'utf8');
  // Execute the real server loading logic; JSX rendering is outside this data-access test.
  const logic = source.slice(0, source.indexOf('  return <main')).replace(/^import .*;$/gm, '').replaceAll('export default ', '').replaceAll('export ', '') + '  return { rows, message };\n}';
  const js = stripTypeScriptTypes(logic);
  const raw = 'base64-' + Buffer.from(JSON.stringify({ access_token: 'verified-token' })).toString('base64');
  let authenticated = true, requestCookies = [
    { name: 'sb-project-auth-token.1', value: raw.slice(12) },
    { name: 'sb-project-auth-token.0', value: raw.slice(0, 12) },
  ];
  const calls = [];
  const ctx = vm.createContext({ Buffer, URLSearchParams,
    process: { env: { NEXT_PUBLIC_SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'server-only' } },
    cookies: async () => ({ getAll: () => requestCookies }),
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/auth/v1/user')) return { ok: authenticated, json: async () => ({ email: 'me@example.test' }) };
      return { ok: true, json: async () => [{ id: 'mine', status: 'in_progress', body: 'text' }] };
    },
  });
  vm.runInContext(js, ctx);
  assert.equal((await ctx.FeedbackMinePage()).rows[0].id, 'mine');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer verified-token');
  const query = new URL(calls[1].url).searchParams;
  assert.equal(query.get('submitter_email'), 'eq."me@example.test"');
  assert.equal(query.get('select'), 'id,kind,title,body,status,created_at');
  assert.equal(calls[1].options.cache, 'no-store');
  calls.length = 0; authenticated = false;
  assert.match((await ctx.FeedbackMinePage()).message, /ログイン/);
  assert.equal(calls.length, 1); // invalid token must never reach the service-role query
  calls.length = 0; requestCookies = [];
  assert.equal((await ctx.FeedbackMinePage()).rows.length, 0);
  assert.equal(calls.length, 0);
  ctx.process.env = {};
  assert.match((await ctx.FeedbackMinePage()).message, /通知のみ/);
  assert.equal(calls.length, 0);
  assert.doesNotMatch(source.slice(source.indexOf('  return <main')), /admin_note|submitter_email|SERVICE_ROLE|screenshot/);
});
