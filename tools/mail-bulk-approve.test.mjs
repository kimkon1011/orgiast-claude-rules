import test from 'node:test';
import assert from 'node:assert/strict';
import { processBulkMailApprovals, createSpreadsheetPayload, HEADERS } from './mail-bulk-approve.mjs';

test('mail-bulk-approve: payload generation created rows correctly', () => {
  const items = [
    { company: 'A社', to: 'a@example.com', cc: 'cc@example.com', subject: '件名A', body: '本文A' },
    { company: 'B社', to: 'b@example.com', subject: '件名B', body: '本文B' }
  ];
  const payload = createSpreadsheetPayload(items, '一括案内');
  assert.match(payload.title, /^一括案内_\d{8}$/);
  assert.equal(payload.rows.length, 3);
  assert.deepEqual(payload.rows[0], HEADERS);
  assert.equal(payload.rows[1][0], 'A社');
  assert.equal(payload.rows[1][5], false); // Send checkbox is false
});

test('mail-bulk-approve: processBulkMailApprovals sends email when checked and not previously sent', () => {
  const sent = [];
  const sendEmailImpl = (mail) => {
    sent.push(mail);
    return { messageId: 'msg-123' };
  };

  const rows = [
    HEADERS,
    ['A社', 'a@example.com', '', '件名A', '本文A', true, '', '']
  ];

  const now = new Date('2026-11-05T06:00:00Z');
  const result = processBulkMailApprovals(rows, sendEmailImpl, now);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'a@example.com');
  assert.equal(result[1][6], now.toISOString());
  assert.equal(result[1][7], 'msg-123');
});

test('mail-bulk-approve: processBulkMailApprovals skips row when already sent', () => {
  const sent = [];
  const sendEmailImpl = (mail) => {
    sent.push(mail);
    return { messageId: 'msg-456' };
  };

  const rows = [
    HEADERS,
    ['A社', 'a@example.com', '', '件名A', '本文A', true, '2026-11-04T12:00:00Z', '送信完了']
  ];

  const result = processBulkMailApprovals(rows, sendEmailImpl);

  assert.equal(sent.length, 0); // Not sent again
  assert.equal(result[1][6], '2026-11-04T12:00:00Z');
});

test('mail-bulk-approve: processBulkMailApprovals skips row when checkbox is false', () => {
  const sent = [];
  const sendEmailImpl = (mail) => {
    sent.push(mail);
    return { messageId: 'msg-789' };
  };

  const rows = [
    HEADERS,
    ['A社', 'a@example.com', '', '件名A', '本文A', false, '', '']
  ];

  const result = processBulkMailApprovals(rows, sendEmailImpl);

  assert.equal(sent.length, 0);
  assert.equal(result[1][6], '');
});

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createBulkApproval, generateGasScript } from './mail-bulk-approve.mjs';
function gasFixture({ failSend=false, failReceipt=false, editor='kim@orgiast.jp', sender='seisaku-team@orgiast.jp' }={}) {
  const values=[HEADERS.slice(),['A社','a@example.com','','件名A','本文A',true,'',''],['B社','b@example.com','','件名B','本文B',true,'','']];
  const props=new Map([['APPROVAL_SHEET_ID','0'],['SPREADSHEET_ID','sheet1']]);const sent=[];let locked=false;
  const lock={waitLock(){assert.equal(locked,false);locked=true;},releaseLock(){locked=false;}};
  const sheet={getSheetId:()=>0,getParent:()=>({getId:()=> 'sheet1'}),getRange(row,col,rows=1,cols=1){return {setValues(next){if(failReceipt&&col===7)throw Error('write failed');for(let i=0;i<rows;i++)for(let j=0;j<cols;j++)values[row-1+i][col-1+j]=next[i][j];},getValues:()=>values.slice(row-1,row-1+rows).map(r=>r.slice(col-1,col-1+cols))};}};
  const c={Session:{getEffectiveUser:()=>({getEmail:()=>sender})},SpreadsheetApp:{flush(){}},LockService:{getScriptLock:()=>lock},PropertiesService:{getScriptProperties:()=>({getProperty:k=>props.get(k),setProperty:(k,v)=>props.set(k,v)})},Utilities:{Charset:{UTF_8:'UTF-8'},base64Encode:s=>Buffer.from(s).toString('base64'),base64EncodeWebSafe:s=>Buffer.from(s).toString('base64url')},Gmail:{Users:{Messages:{send(mail,user){assert.equal(locked,true);assert.equal(user,'me');assert.ok([...props.values()].some(v=>String(v).includes('sending')));sent.push(mail);if(failSend)throw Error('timeout');return {id:'msg-'+sent.length};}}}}};
  vm.createContext(c);vm.runInContext(generateGasScript(),c);
  const event={triggerUid:'trigger1',user:{getEmail:()=>editor},range:{getSheet:()=>sheet,getColumn:()=>6,getNumColumns:()=>1,getRow:()=>2,getNumRows:()=>2}};
  return {c,event,sent,values,props};
}
test('actual GAS handles multirow mobile edits, returns message IDs, locks and does not resend',()=>{
  const f=gasFixture();f.c.onApprovalEdit(f.event);assert.equal(f.sent.length,2);assert.equal(f.values[1][7],'msg-1');assert.ok(f.values[1][6]);
  const mime=Buffer.from(f.sent[0].raw,'base64url').toString();assert.match(mime,/From: seisaku-team@orgiast.jp/);
  f.c.onApprovalEdit(f.event);assert.equal(f.sent.length,2);
});
test('GAS never retries ambiguous send or post-send write failure, even with blank sent timestamp',()=>{
  for(const opts of [{failSend:true},{failReceipt:true}]) {
    const f=gasFixture(opts);assert.throws(()=>f.c.onApprovalEdit(f.event));assert.equal(f.sent.length,1);assert.equal(f.values[1][6],'');
    // Re-edit only the uncertain row (not another, still unapproved row).
    f.event.range.getNumRows=()=>1;f.c.onApprovalEdit(f.event);assert.equal(f.sent.length,1);
    assert.ok(f.props.get('SEND_2'));
  }
});
test('GAS requires kim editor, installed trigger, correct account and checkbox column',()=>{
  const f=gasFixture({editor:'other@orgiast.jp'});f.c.onApprovalEdit(f.event);assert.equal(f.sent.length,0);
  const other=gasFixture({sender:'kim@orgiast.jp'});assert.throws(()=>other.c.onApprovalEdit(other.event),/seisaku-team/);
  const noEvent=gasFixture();delete noEvent.event.triggerUid;noEvent.c.onApprovalEdit(noEvent.event);assert.equal(noEvent.sent.length,0);
  const column=gasFixture();column.event.range.getColumn=()=>7;column.c.onApprovalEdit(column.event);assert.equal(column.sent.length,0);
});
test('payload rejects invalid addresses, header injection and oversized cells; formulas stay literal',()=>{
  const good={company:'A社',to:'a@example.com',subject:'案内',body:'=IMPORTXML("url")'};
  assert.equal(createSpreadsheetPayload([good]).rows[1][4],good.body);
  for(const patch of [{to:'a@example.com\nBcc: other@example.com'},{subject:'hello\r\nBcc: other@example.com'},{body:'x'.repeat(50001)},{body:''}])assert.throws(()=>createSpreadsheetPayload([{...good,...patch}]));
});
test('sheet provisioning uses shared account, literal cells, checkbox, sharing, clasp push and readback',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bulk-mail-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  // Exercise clasp discovery without depending on a global installation on the runner.
  const clasp=path.join(dir,'clasp fixture.js');fs.writeFileSync(clasp,'// clasp execution is captured by run below\n');
  const previousClasp=process.env.ORGIAST_CLASP_JS;
  t.after(()=>{if(previousClasp===undefined)delete process.env.ORGIAST_CLASP_JS;else process.env.ORGIAST_CLASP_JS=previousClasp;});
  process.env.ORGIAST_CLASP_JS=clasp;
  const items=[{company:'A社',to:'a@example.com',subject:'案内',body:'=literal'}];const payload=createSpreadsheetPayload(items);const calls=[];let runArgs;
  const api=async(token,url,opts)=>{
    calls.push({token,url,opts});let value={};
    if(url.includes('/about?'))value={user:{emailAddress:'seisaku-team@orgiast.jp'}};
    else if(url.endsWith('/v4/spreadsheets')){const body=JSON.parse(opts.body);assert.deepEqual(body.sheets[0].data[0].rowData[1].values[4],{userEnteredValue:{stringValue:'=literal'}});value={spreadsheetId:'sheet1'};}
    else if(url.includes('/values/'))value={values:payload.rows};
    else if(url.endsWith('/v1/projects')){assert.equal(JSON.parse(opts.body).parentId,'sheet1');value={scriptId:'script1'};}
    else if(url.endsWith('/content'))value={files:['Logic','Send','Setup'].map(name=>({name,source:fs.readFileSync(new URL('./mail-bulk-approve-gas/'+name+'.js',import.meta.url),'utf8')}))};
    return {json:async()=>value};
  };
  const result=await createBulkApproval(items,{projectDir:dir,getClaspToken:async()=> 'oauth',getToken:async opts=>{assert.equal(opts.impersonate,'seisaku-team@orgiast.jp');return 'dwd';},api,run:(...args)=>{runArgs=args;}});
  assert.match(result.url,/sheet1.*authuser=kim@orgiast.jp/);assert.equal(result.status,'setup-required');assert.match(result.setupUrl,/authuser=seisaku-team@orgiast.jp/);
  assert.ok(runArgs[1].includes('push'));assert.ok(runArgs[1].includes('--force'));assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'.clasp.json'))).scriptId,'script1');
  assert.equal(runArgs[0],process.execPath);assert.equal(runArgs[1][0],clasp);
  assert.equal(runArgs[1][runArgs[1].indexOf('--project')+1],path.join(dir,'.clasp.json'));assert.equal(runArgs[2].cwd,dir);
  assert.ok(calls.some(c=>c.url.includes(':batchUpdate')&&c.opts.body.includes('BOOLEAN')));assert.ok(calls.some(c=>c.url.includes('/permissions')&&c.opts.body.includes('kim@orgiast.jp')));
});
test('wrong clasp identity stops before creating any sheet',async()=>{
  let calls=0;await assert.rejects(createBulkApproval([{company:'A',to:'a@example.com',subject:'s',body:'b'}],{projectDir:path.join(os.tmpdir(),'nonexistent-approval-project'),getClaspToken:async()=> 'oauth',api:async()=>{calls++;return {json:async()=>({user:{emailAddress:'kim@orgiast.jp'}})};},getToken:()=>{throw Error('must not reach');}}),/既存 clasp 認証/);assert.equal(calls,1);
});

test('setup creates installable onEdit once, protects receipts and keeps unrelated/queue triggers',()=>{
  const props=new Map();let triggers=['unrelated'];const notes=[];let protection;
  const sheet={getSheetId:()=>0,getLastRow:()=>3,getRange:(...args)=>({args,setNote:text=>notes.push(text)}),getProtections:()=>protection?[protection]:[],protect:()=>{protection={getDescription:()=> 'bulk-mail-approval',setDescription(){return this;},getEditors:()=>[],removeEditors(){},addEditor(email){assert.equal(email,'seisaku-team@orgiast.jp');},canDomainEdit:()=>true,setDomainEdit(value){assert.equal(value,false);},setUnprotectedRanges(ranges){assert.equal(ranges[0].args[1],6);}};return protection;}};
  const ss={getId:()=> 'sheet1',getSheetByName:name=>name==='送信承認'?sheet:null};
  const c={Session:{getEffectiveUser:()=>({getEmail:()=> 'seisaku-team@orgiast.jp'})},SpreadsheetApp:{getActiveSpreadsheet:()=>ss,ProtectionType:{SHEET:'sheet'},flush(){}},PropertiesService:{getScriptProperties:()=>({getProperty:k=>props.get(k),setProperty:(k,v)=>props.set(k,v)})},DriveApp:{createFolder:()=>({getId:()=> 'commands',addEditor:email=>assert.equal(email,'kim@orgiast.jp')})},Logger:{log(){}},ScriptApp:{getProjectTriggers:()=>triggers.map(name=>({getHandlerFunction:()=>name})),deleteTrigger:t=>{triggers=triggers.filter(n=>n!==t.getHandlerFunction());},newTrigger(name){const builder={forSpreadsheet:()=>builder,onEdit:()=>builder,timeBased:()=>builder,everyMinutes:n=>{assert.equal(n,1);return builder;},create:()=>triggers.push(name)};return builder;}}};
  vm.createContext(c);vm.runInContext(generateGasScript(),c);c.setupOnce();c.setupOnce();
  assert.deepEqual(triggers.sort(),['onApprovalEdit','processCommandQueue','unrelated']);assert.equal(props.get('CMD_FOLDER_ID'),'commands');
  assert.deepEqual(Object.keys(c._COMMANDS_()),['approvalStatus']);assert.equal(notes.length,2);
});
