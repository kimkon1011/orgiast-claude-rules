#!/usr/bin/env node
// 実送信を禁止した回帰テストと、実行結果からの表生成。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { isEntry } from './is-entry.mjs';
export const CONSISTENCY_TEST_FILES = [
  'tools/tema-fix3-review.test.mjs', 'tools/tema-send-regression.test.mjs',
  'tools/discord-autoreply.test.mjs', 'tools/discord-beeper-autoreply.test.mjs',
  'tools/daily-beeper-approval.test.mjs', 'tools/lahaina-daily-post.test.mjs', 'tools/lahaina-standing-send.test.mjs',
  'tools/fleet-chase.test.mjs', 'tools/vehicle-inspection-watch.test.mjs', 'tools/origuchi-referral-monthly.test.mjs',
  'tools/satou-secretary-daily.test.mjs', 'tools/schedule-sync.test.mjs', 'tools/kim-inbox.test.mjs',
  'tools/feedback-nag.test.mjs', 'tools/feedback-progress-notify.test.mjs', 'tools/ledger-stale-nag.test.mjs',
  'tools/reply-queue.test.mjs',
  'tools/send-consistency.test.mjs','tools/send-consistency-integration.test.mjs','tools/tema-rollout-check.test.mjs',
  'tools/tema-check.test.mjs','tools/lib/handback-guard.test.mjs','tools/followup-ledger.test.mjs',
  'tools/handoff-action-gate.test.mjs','tools/delegation-retest.test.mjs','tools/onboarding-sync-absolute.test.mjs','tools/absolute-rules.test.mjs',
  'tools/gmail-draft.test.mjs','tools/discord-dm.test.mjs','tools/line-channel.test.mjs','tools/line-group-send.test.mjs',
  'tools/beeper-send.test.mjs','tools/beeper-api.test.mjs','tools/beeper-readback.test.mjs','tools/send-context-check.test.mjs',
  'tools/fleet-beacon.test.mjs','tools/fleet-status.test.mjs','tools/mail-send-approval-gate.test.mjs',
  'tools/mail-consistency-check.test.mjs','tools/mail-consistency-gate.test.mjs',
];
export async function main(argv=process.argv.slice(2)) {
  const root=fileURLToPath(new URL('../',import.meta.url));
  const i=argv.indexOf('--out'),out=path.resolve(i<0?path.join(root,'..','test-results-consistency.md'):argv[i+1]);
  const guard=pathToFileURL(path.join(root,'tools','test-fixtures','no-live-network.mjs')).href;
  const args=['--import',guard,'--test','--test-reporter=tap',...CONSISTENCY_TEST_FILES];
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'consistency-suite-'));
  let output='';
  const code=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,args,{cwd:root,windowsHide:true,env:{...process.env,ORGIAST_HOME:home,NODE_OPTIONS:`--import=${guard}`},stdio:['ignore','pipe','pipe']});
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});child.on('error',reject);child.on('close',resolve);
  });
  const getCount=key=>Number(output.match(new RegExp(`^# ${key} (\\d+)$`,'m'))?.[1] || 0);
  const cases=[...output.matchAll(/^# CASE_RESULT (.+)$/gm)].map(m=>JSON.parse(m[1]));
  const tests=[...output.matchAll(/^(ok|not ok) (\d+) - (.+)$/gm)].map(m=>({status:m[1],id:m[2],title:m[3]}));
  const esc=s=>String(s).replace(/\|/g,'\\|').replace(/\r?\n/g,' ');
  const report=[
    '# 送信前整合性チェック テスト結果','',`実行日時: ${new Date().toISOString()}`,
    `終了コード: ${code}。${getCount('tests')}件、合格${getCount('pass')}件、不合格${getCount('fail')}件、skip ${getCount('skipped')}件。`,
    '', '実行コマンド:', '', '```powershell',"powershell.exe -NoProfile -NonInteractive -Command 'node tools/run-consistency-tests.mjs; exit $LASTEXITCODE'",'```','',
    '内部の実行コマンド:', '', '```text',`node ${args.join(' ')}`,'```','',
    '外部APIは依存注入またはローカルHTTPサーバでモック。未モックの外部通信はプリロードで拒否。送信CLIの本番実行・push・PR作成は行わない。',
    '', '| ケース番号 | 内容 | 期待 | 実際 | 合否 |','|---|---|---|---|---|',
    ...cases.map(c=>`| ${c.id} | ${esc(c.title)} | ${c.expected.join(', ') || '合格'} | ${c.actual.join(', ') || '合格'} | ${c.pass?'合格':'不合格'} |`),
    '', '| 実行番号 | 内容 | 期待 | 実際 | 合否 |','|---|---|---|---|---|',
    ...tests.map(t=>`| T${t.id} | ${esc(t.title)} | ok | ${t.status} | ${t.status==='ok'?'合格':'不合格'} |`),
    '', `実ログ: ${path.basename(out)}.tap`, '',
  ].join('\n');
  fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,report,'utf8');fs.writeFileSync(`${out}.tap`,output,'utf8');
  if (i < 0) {
    fs.writeFileSync(path.join(root, '..', 'test-results.md'), report.replace('# 送信前整合性チェック テスト結果', '# 手間チェック・送信前整合性チェック テスト結果'), 'utf8');
  }
  // 作成した一時ディレクトリだけを削除する。
  if(path.dirname(home)===path.resolve(os.tmpdir()) && path.basename(home).startsWith('consistency-suite-'))fs.rmSync(home,{recursive:true,force:true});
  console.log(JSON.stringify({exitCode:code,tests:getCount('tests'),pass:getCount('pass'),fail:getCount('fail'),report:out}));
  if(code!==0)console.error(tests.filter(t=>t.status!=='ok').map(t=>`${t.id}: ${t.title}`).join('\n'));
  const requiredCases = [...Array.from({length:13}, (_,i)=>`C${i+1}`), 'T8a','T8b','T8c','J-LINE','J-GMAIL'];
  return code || (requiredCases.every(id => cases.some(c=>c.id===id && c.pass)) && cases.every(c=>c.pass) && getCount('fail')===0 && getCount('tests')>0 ? 0 : 1);
}
if(isEntry(import.meta.url))process.exitCode=await main();
