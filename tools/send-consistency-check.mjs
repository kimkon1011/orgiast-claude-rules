#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isEntry } from './is-entry.mjs';
import { gwsFetch } from './lib/gws-proxy.mjs';
import { readContextMarker } from './lib/send-context.mjs';
import { checkSendConsistency, formatConsistencyFindings, normalizeSubject, addresses, CHANNEL_ITEM_SUPPORT } from './lib/send-consistency.mjs';

import { markCardSent, CARD_NOTICE } from './lib/approval-cards.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const ACCOUNTS = ['seisaku-team@orgiast.jp', 'kim@orgiast.jp', 'cr@orgiast.jp'];
const homeOf = deps => deps.home ?? process.env.ORGIAST_HOME ?? os.homedir();
export const subjectHash = subject => createHash('sha256').update(normalizeSubject(subject)).digest('hex');
export const registryPath = home => path.join(home, '.claude', 'sent-registry.jsonl');
export function readSentRegistry(home) {
  try { return fs.readFileSync(registryPath(home), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
function jsonFile(file, absent) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT' && absent !== undefined) return absent; throw error; }
}
const decode = p => p?.filename ? '' : p?.body?.data ? Buffer.from(p.body.data, 'base64url').toString('utf8') : (p?.parts || []).map(decode).join('\n');
export function gmailRow(message, extra = {}) {
  const h = Object.fromEntries((message?.payload?.headers || []).map(v => [v.name.toLowerCase(), v.value]));
  return { ...extra, to: h.to, cc: h.cc, sender: h.from, subject: h.subject, text: decode(message?.payload), at: new Date(Number(message?.internalDate || 0)).toISOString(), threadId: message?.threadId, id: message?.id };
}
async function gmailData(input, deps) {
  const fetchImpl = deps.fetchImpl ?? gwsFetch;
  const getToken = deps.getToken ?? (await import('./lib/gmail-auth.mjs')).mintDwdToken;
  const sentHistory = [], otherDrafts = [], threadMessages = [], failures = [];
  let refreshThread;
  for (const account of new Set([...ACCOUNTS, ...(input.account ? [input.account] : [])])) {
    try {
      const token = await getToken({ user: account, scope: 'https://www.googleapis.com/auth/gmail.readonly', fetchImpl });
      const get = async suffix => {
        const r = await fetchImpl(`https://gmail.googleapis.com/gmail/v1/users/me/${suffix}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(25000) });
        if (!r.ok) throw Error(`Gmail HTTP ${r.status}`);
        return r.json();
      };
      const list = async (kind, q) => {
        let pageToken, rows = [];
        do { const data = await get(`${kind}?${new URLSearchParams({ q, maxResults:'100', ...(pageToken ? {pageToken} : {}) })}`); rows.push(...(data[kind] || [])); pageToken = data.nextPageToken; } while (pageToken);
        return rows;
      };
      const query = addresses(input.to).map(to => `to:${to}`).join(' ');
      try {
        for (const row of await list('messages', `in:sent {${query}} newer_than:14d`)) sentHistory.push(gmailRow(await get(`messages/${row.id}?format=full`), { account, side:'self' }));
      } catch { failures.push('sentHistory'); }
      try {
        for (const row of await list('drafts', `{${query}}`)) {
          const draft = await get(`drafts/${row.id}?format=full`);
          otherDrafts.push(gmailRow(draft.message, { account, draftId:row.id }));
        }
      } catch { failures.push('otherDrafts'); }
      if (account === (input.account || ACCOUNTS[0])) {
        try {
          // 宛先全体の最新メールで代用せず、送る下書きのスレッドを読む。
          let threadId = input.threadId;
          if (!threadId && input.draftId) threadId = (await get(`drafts/${input.draftId}?format=full`)).message?.threadId;
          if (!threadId) throw Error('スレッド未指定');
          refreshThread=async()=>{
            const data = await get(`threads/${encodeURIComponent(threadId)}?format=full`);
            return (data.messages || []).filter(m=>!(m.labelIds || []).includes('DRAFT')).map(m=>{
              const row=gmailRow(m,{account});return {...row,side:addresses(row.sender).includes(account)?'self':'external'};
            });
          };
          threadMessages.push(...await refreshThread());
        } catch { failures.push('threadMessages'); }
      }
    } catch { failures.push('sentHistory','otherDrafts', ...(account === (input.account || ACCOUNTS[0]) ? ['threadMessages'] : [])); }
  }
  return { sentHistory, otherDrafts, threadMessages, failures, refreshThread };
}

// 14日照合とは別の最終検索。キャッシュを使用せず、全送信アカウントを読む。
export async function readRecentSent(input, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? gwsFetch;
  const getToken = deps.getToken ?? (await import('./lib/gmail-auth.mjs')).mintDwdToken;
  const now = new Date(input.now ?? Date.now()).getTime();
  const rows = [];
  for (const account of new Set([...ACCOUNTS, ...(input.account ? [input.account] : [])])) {
    const token = await getToken({ user: account, scope: 'https://www.googleapis.com/auth/gmail.readonly', fetchImpl });
    const get = async suffix => {
      const res = await fetchImpl(`https://gmail.googleapis.com/gmail/v1/users/me/${suffix}`, { cache: 'no-store', headers: { Authorization: `Bearer ${token}`, 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(25000) });
      if (!res.ok) throw Error(`直前の送信済み確認 HTTP ${res.status}`);
      return res.json();
    };
    for (const to of addresses(input.to)) {
      let pageToken;
      do {
        const query = new URLSearchParams({ q: `in:sent to:${to} after:${Math.floor((now - 600000) / 1000)}`, maxResults: '100', ...(pageToken ? { pageToken } : {}) });
        const data = await get(`messages?${query}`);
        for (const message of data.messages || []) rows.push(gmailRow(await get(`messages/${message.id}?format=full`), { account }));
        pageToken = data.nextPageToken;
      } while (pageToken);
    }
  }
  return rows;
}

// CSVの引用符内のカンマ・改行・二重引用符を保持する。
export function parseTaskCsv(csv) {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i=0;i<csv.length;i++) {
    const c=csv[i];
    if (c === '"') { if (quoted && csv[i+1] === '"') {cell+='"';i++;} else quoted=!quoted; }
    else if (!quoted && (c === ',' || c === '\n')) {row.push(cell.replace(/\r$/, ''));cell='';if(c==='\n'){rows.push(row);row=[];}}
    else cell+=c;
  }
  if(cell || row.length){row.push(cell);rows.push(row);}
  return rows;
}
export function decodeTaskOutput(value) {
  if(typeof value==='string')return value;
  const bytes=Buffer.from(value);
  if(bytes[0]===0xff && bytes[1]===0xfe)return bytes.subarray(2).toString('utf16le');
  try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return new TextDecoder('shift_jis').decode(bytes);}
}
export function scanScheduled(input, { home, taskCsv, readFile = file => fs.readFileSync(file,'utf8'), cwd = root } = {}) {
  const found = [], seen = new Set(), failures = [];
  function scan(text, where, base, depth=0) {
    if(depth > 12) {failures.push('scheduledSends');return;}
    if ((input.draftId && text.includes(input.draftId)) || addresses(input.to).some(to => text.toLowerCase().includes(to))) found.push({ to:input.to, subject:input.subject, draftId:input.draftId && text.includes(input.draftId) ? input.draftId : undefined, where, status:'pending' });
    const paths = [...text.matchAll(/(?:"([^"\r\n]+\.(?:md|txt|ps1))"|'([^'\r\n]+\.(?:md|txt|ps1))'|([^\s"'`<>|]+\.(?:md|txt|ps1)))/gi)].map(m=>m[1]||m[2]||m[3]);
    for(let file of paths) {
      file=file.replace(/^~(?=[\\/])/,home).replace(/%USERPROFILE%/gi,home);
      file=path.resolve(base,file);
      if(seen.has(file))continue;seen.add(file);
      try{scan(readFile(file),file,path.dirname(file),depth+1);}catch{
        // The scheduler command itself is authoritative.  A missing file named by that
        // command makes its payload unreadable; a missing file merely mentioned inside
        // an already-read script cannot produce a send and is commonly stale prose.
        if(depth === 0)failures.push('scheduledSends');
      }
    }
  }
  const rows=parseTaskCsv(taskCsv || '');
  const actionColumn=(rows[0] || []).findIndex(cell=>/^(Task To Run|実行するタスク)$/i.test(cell.trim()));
  const executable=/(?:^|[\\/"'\s])(?:claude|node)(?:\.exe)?(?:["'\s]|$)/i;
  const wrapper=/(?:powershell|pwsh)(?:\.exe)?(?:["'\s]|$)/i;
  for(const row of rows.slice(actionColumn>=0?1:0)) {
    const command = actionColumn>=0 ? row[actionColumn] : row.find(cell => executable.test(cell) || (wrapper.test(cell) && /\.ps1(?:["'\s]|$)/i.test(cell)));
    if(command && (executable.test(command) || (wrapper.test(command) && /\.ps1(?:["'\s]|$)/i.test(command)))) scan(command,row.join(' | '),cwd);
  }
  return { rows:found, failures };
}
export async function collectSendConsistency(input, deps = {}) {
  const home = homeOf(deps), now = input.now ?? new Date().toISOString();
  const data = { ...input, now, sentHistory:[], scheduledSends:[], otherDrafts:[], threadMessages:[], calendarEvents:[], unverified:[...(input.unverified || [])], unsupported:[...(input.unsupported || [])] };
  const missing = key => data.unverified.push(key);
  let refreshThread=deps.refreshThread;
  if(!addresses(input.to).length) missing('to');
  const acquire = async (key, fn) => { try { data[key] = await fn(); } catch { missing(key); } };
  try { data.sentHistory.push(...readSentRegistry(home)); } catch { missing('sentHistory'); }
  data.subjectHash = subjectHash(input.subject);
  if (deps.gmailData || input.channel === 'gmail') {
    try { const g = await (deps.gmailData ?? gmailData)(input,deps); data.sentHistory.push(...g.sentHistory);data.otherDrafts.push(...g.otherDrafts);data.threadMessages=g.threadMessages;data.unverified.push(...g.failures);refreshThread ??= g.refreshThread; } catch { ['sentHistory','otherDrafts','threadMessages'].forEach(missing); }
  } else if (deps.fetchHistory === null && CHANNEL_ITEM_SUPPORT[input.channel]?.threadMessages === 'optional') {
    // readerを持たない接続経路を明示的に表す。通信失敗からここへフォールバックしない。
    data.unsupported.push('threadMessages', 'draftReadAt');
  } else {
    try {
      const reader=deps.fetchHistory ?? (await import('./send-context-check.mjs')).fetchHistory;
      const history = await reader(input.channel, input.threadId || String(input.to), { home, fetchImpl:deps.fetchImpl });
      refreshThread ??= async()=> (await reader(input.channel,history.target,{home,fetchImpl:deps.fetchImpl})).messages;
      data.threadMessages=history.messages;
      data.sentHistory.push(...history.messages.filter(m=>m.side==='self').map(m=>({...m,to:input.to})));
    } catch { missing('threadMessages');missing('sentHistory'); }
  }
  try {
    const csv = decodeTaskOutput(deps.taskCsv ?? (deps.execFile ?? execFileSync)('schtasks.exe',['/query','/fo','csv','/v'],{windowsHide:true,timeout:20000}));
    const scheduled=scanScheduled(input,{home,taskCsv:csv,...deps});data.scheduledSends.push(...scheduled.rows);data.unverified.push(...scheduled.failures);
  } catch { missing('scheduledSends'); }
  try {
    const store = deps.followupStore ?? jsonFile(path.join(home,'.claude','followup-ledger','ledger.json'),{rows:[]});
    const localRows=store.items || store.rows || [];
    let remoteRows=[];
    try {
      if(deps.followupRows) remoteRows=await deps.followupRows();
      else {
        const {createSheetsClient}=await import('./lib/sheets-dwd.mjs');
        const {valuesToRow}=await import('./lib/followup-schema.mjs');
        const cfg=jsonFile(path.join(root,'config','followup-ledger.json'));
        const sheets=createSheetsClient({fetchImpl:deps.fetchImpl,getToken:deps.sheetsToken,maxRetries:0,max429Retries:0});
        remoteRows=(await sheets.get(cfg.spreadsheetId,"'ledger'!A2:AE")).map(valuesToRow);
      }
    }catch{missing('followupLedger');}
    for(const row of [...localRows,...remoteRows]) {
      if(row.lastSentAt) data.sentHistory.push({...row,at:row.lastSentAt,text:row.nudgeText || row.task,where:`followup:${row.id}`});
      if(!['完了','sent','done','送信済み'].includes(row.status)) data.scheduledSends.push({...row,subject:row.subject || row.task,where:`followup:${row.id}`});
    }
  } catch { missing('followupLedger'); }
  try {
    const queue=deps.sendQueue ?? jsonFile(path.join(home,'.claude','reply-queue','queue.json'),{items:{}});
    for(const row of Object.values(queue.items || {})) if(!['sent','done','rejected','expired'].includes(row.state)) {
      data.scheduledSends.push({to:row.to || row.thread,subject:row.subject,draftId:row.draftId || row.id,text:row.draft?.text,where:`reply-queue:${row.id}`,status:row.state});
    }
  }catch{missing('scheduledSends');}
  // 他PCのローカルファイルは、全PC収集済みの新鮮なスナップショットが無ければ照合不能。
  try {
    const fleetFile=path.join(home,'.claude','send-consistency-fleet.json');
    let fleet;
    try { fleet=deps.fleetSnapshot ?? jsonFile(fleetFile); }
    catch(error) {
      if(error.code === 'ENOENT' && CHANNEL_ITEM_SUPPORT[input.channel]?.otherPcState === 'unsupported') {
        data.unsupported.push('otherPcState');
        fleet=null;
      } else throw error;
    }
    if(!fleet) throw Object.assign(Error('fleet snapshot unsupported'),{code:'UNSUPPORTED_FLEET'});
    const pcMap=deps.pcMap ?? jsonFile(path.join(root,'fleet-pc-map.json'));
    const labels=Object.keys(pcMap).filter(k=>!k.startsWith('_'));
    if (!labels.every(label => fleet.labels?.includes(label)) || !(new Date(now)-Date.parse(fleet.checkedAt)>=0 && new Date(now)-Date.parse(fleet.checkedAt)<=5*60000)) throw Error('全PCの読み戻しが古いか不足');
    for (const key of ['sentHistory','scheduledSends','otherDrafts']) { if(!Array.isArray(fleet[key]))throw Error('欠落');data[key].push(...fleet[key]); }
  } catch(error) { if(error.code !== 'UNSUPPORTED_FLEET') missing('otherPcState'); }
  await acquire('directives',async()=>deps.directives ?? jsonFile(path.join(root,'config','send-directives.json')));
  await acquire('calendarEvents',async()=> {
    if (deps.calendarEvents) return deps.calendarEvents(input);
    const { listCalendarEvents }=await import('./calendar-events-list.mjs');
    const result=await listCalendarEvents({from:new Date(new Date(now).getTime()-86400000).toISOString().slice(0,10),to:new Date(new Date(now).getTime()+366*86400000).toISOString().slice(0,10),fetchImpl:deps.fetchImpl,getToken:deps.calendarToken});
    return result.map(e=>({...e,subject:e.summary}));
  });
  // カレンダー・台帳の取得待ち中に届いた新着も、返す直前に再取得する。
  if(refreshThread)await acquire('threadMessages',refreshThread);
  data.sentHistory.push(...data.threadMessages.filter(m=>m.side==='self').map(m=>({...m,to:m.to || input.to})));
  data.requiredCc=addresses(input.requiredCc);
  try {
    if(input.channel==='gmail') for (const file of ['booth-sales-cc.json','invoice-cc.json']) {
      const rule=jsonFile(path.join(root,'config',file));
      if((rule.keywords || rule.subjectKeywords || []).some(k=>`${input.subject}\n${input.text}`.toLowerCase().includes(k.toLowerCase()))) data.requiredCc.push(...addresses(rule.cc));
    }
    data.requiredCc.push(...data.threadMessages.flatMap(m=>addresses(m.cc)).filter(a=>!ACCOUNTS.includes(a)));
  } catch { missing('requiredCc'); }
  data.knownNames=input.knownNames ?? data.threadMessages.filter(m=>m.side!=='self' && addresses(m.sender).some(a=>addresses(input.to).includes(a))).map(m=>String(m.sender).split('<')[0].replace(/"/g,'').trim()).filter(n=>n&&!n.includes('@'));
  const marker=readContextMarker(input.text,home);
  data.draftReadAt=input.draftReadAt ?? (marker?.channel===input.channel && String(marker.target)===String(input.threadId || input.to) ? marker.checkedAt : undefined);
  if(!data.unsupported.includes('draftReadAt') && (!Number.isFinite(Date.parse(data.draftReadAt)) || Date.parse(data.draftReadAt)>new Date(now).getTime())) missing('draftReadAt');
  if (CHANNEL_ITEM_SUPPORT[input.channel]?.otherDrafts === 'unsupported') data.unsupported.push('otherDrafts');
  data.unsupported=[...new Set(data.unsupported)];
  data.unverified=[...new Set(data.unverified)];
  if(input.now===undefined)data.now=new Date().toISOString();
  return data;
}
export async function assertSendConsistency(input, deps = {}) {
  const data=await (deps.collect ?? collectSendConsistency)(input,deps);
  if (input.channel === 'gmail') {
    try { data.recentSent = await (deps.readRecentSent ?? readRecentSent)({ ...input, now: input.now ?? new Date().toISOString() }, deps); }
    catch { data.unverified = [...(data.unverified || []), 'recentSent']; }
  }
  // 全チャネルで、収集中に別プロセスが送信した分まで直前に再読込する。
  try { data.recentSent = [...(data.recentSent || []), ...readSentRegistry(homeOf(deps))]; }
  catch { data.unverified = [...(data.unverified || []), 'recentSent']; }
  if (input.now === undefined) data.now = new Date().toISOString();
  const result=checkSendConsistency(data, deps.opts);
  const warnings = result.findings.filter(f => f.code.startsWith('UNSUPPORTED_'));
  if (warnings.length) {
    const file = path.join(homeOf(deps), '.claude', 'send-consistency', 'unsupported.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (const finding of warnings) {
      fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), channel: input.channel, to: input.to, ...finding }) + '\n', 'utf8');
      (deps.warn ?? console.error)(finding.message);
    }
  }
  if(!result.ok) throw Object.assign(new Error(formatConsistencyFindings(result.findings)),{code:'SEND_CONSISTENCY_BLOCKED',exitCode:result.findings.some(f=>f.code.startsWith('UNVERIFIED_')&&f.severity!=='warning')?3:2,findings:result.findings});
  return { ...result, input:data };
}
export async function afterSendCleanup(input, deps = {}) {
  if(!input.sentMessageId) throw Error('送信成功IDが無いため後始末できません');
  const home=homeOf(deps), at=input.sentAt || new Date().toISOString();
  const record={channel:input.channel,to:input.to,subjectHash:subjectHash(input.subject),draftId:input.draftId,account:input.account,at,messageId:input.sentMessageId,status:'sent'};
  const result={ok:true,registry:true,draft:'対象なし',scheduledSends:[],followupLedger:'sent-registryで再送抑止'};
  try {
    const file=registryPath(home);fs.mkdirSync(path.dirname(file),{recursive:true});fs.appendFileSync(file,JSON.stringify(record)+'\n','utf8');
    if(!readSentRegistry(home).some(r=>r.messageId===record.messageId && r.at===at))throw Error('送信済み記録の読み戻し失敗');
  }catch(error){result.ok=false;result.registry=false;result.error=error.message;(deps.stdout ?? console.log)(JSON.stringify({afterSendCleanup:result}));return result;}
  // 成功済み送信はカード台帳の破損・書込失敗に関係なく先に永続化する。
  try {
    const marked = markCardSent(input, { home, by: input.account || input.channel || 'AI', at });
    if (marked.length) result.cardNotice = CARD_NOTICE;
  } catch (error) {
    result.ok = false; result.cardError = error.message; result.cardNotice = CARD_NOTICE;
  }
  if(input.channel==='gmail' && input.draftId) {
    try {
      if(!deps.getDraft || !deps.deleteDraft) throw Error('下書き読み戻し依存がありません');
      let r=await deps.getDraft(input.draftId);
      if(r.status!==404){if(!r.ok)throw Error(`下書き確認 HTTP ${r.status}`);const removed=await deps.deleteDraft(input.draftId);if(!removed.ok && removed.status!==404)throw Error('下書き削除失敗');r=await deps.getDraft(input.draftId);}
      if(r.status!==404)throw Error('元の下書きが残っています');result.draft='削除済み・404読み戻し';
    }catch(error){result.ok=false;result.draft=error.message;}
  }
  // 手順本文を編集せず、同じdraftIdの予定は共通入口の台帳照合で止める。
  result.scheduledSends=(input.scheduledSends || []).filter(r=>input.draftId && r.draftId===input.draftId).map(r=>({where:r.where || r.path,status:'送信済み',via:'sent-registry'}));
  try {
    const ledgerFile=path.join(home,'.claude','followup-ledger','ledger.json');
    const store=jsonFile(ledgerFile,{rows:[]});let changed=false;
    for(const row of store.items || store.rows || []) if(input.draftId && (row.draftId || row.id)===input.draftId) {row.lastSentAt=at;row.lastSentId=input.sentMessageId;row.sendStatus='送信済み';changed=true;}
    if(changed){fs.writeFileSync(ledgerFile,JSON.stringify(store,null,2)+'\n','utf8');const back=jsonFile(ledgerFile);if(!(back.items||back.rows||[]).filter(r=>(r.draftId||r.id)===input.draftId).every(r=>r.lastSentId===input.sentMessageId))throw Error('台帳読み戻し不一致');result.followupLedger='送信済み・読み戻し済み';}
  }catch(error){result.ok=false;result.followupLedger=error.message;}
  (deps.stdout ?? console.log)(JSON.stringify({afterSendCleanup:result}));
  return result;
}
export async function main(argv=process.argv.slice(2),deps={}) {
  const args={};const out=deps.stdout ?? console.log;
  try {
    for(let i=0;i<argv.length;i++){const key=argv[i];if(key==='--json'){args.json=true;continue;}if(!['--channel','--to','--cc','--subject','--body-file','--draft-id','--draft-read-at'].includes(key)||!argv[i+1]||argv[i+1].startsWith('--'))throw Error('引数が不正');args[key.slice(2)]=argv[++i];}
    if(!['gmail','discord','line','beeper'].includes(args.channel)||!args.to||!args['body-file'])throw Error('--channel --to --body-file が必要');
    const input={channel:args.channel,to:args.to,cc:args.cc,subject:args.subject,text:fs.readFileSync(args['body-file'],'utf8'),draftId:args['draft-id'],draftReadAt:args['draft-read-at']};
    const result=await assertSendConsistency(input,deps);out(args.json?JSON.stringify({ok:true,findings:result.findings}):'送信前の整合性チェック: 合格');return 0;
  }catch(error){out(args.json?JSON.stringify({ok:false,findings:error.findings || [],message:error.message}):error.message);return error.exitCode || 3;}
}
if(isEntry(import.meta.url))process.exitCode=await main();
