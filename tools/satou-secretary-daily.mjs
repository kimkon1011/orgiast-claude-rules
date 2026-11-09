#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { getDriveToken } from './lib/drive-auth.mjs';
import { gwsFetch } from './lib/gws-proxy.mjs';
import { searchGmail, headerValue, compactMessage } from './gmail-search.mjs';
import { readEnvValue } from './env-kv.mjs';

export const LEDGER_ID = '17h_x-1kdxI_92H_dXBydclLsxUmYKa-ut0P3begM_j0';
export const MASTER_ID = '14RC6og1ma_I3LGHwCVwswKArgHwCOPxWlPB3g8adaYY';
export const MASTER_TAB = '案件一覧';
export const OUTPUT_TABS = ['自動_案件', '自動_今日の要対応', '自動_実行ログ'];
const USER = 'seisaku-team@orgiast.jp';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const JST = 'Asia/Tokyo';
const STAFF_HEADERS = ['営業スタッフ','企画スタッフ','営業ｻﾌﾞP','営業P','制作スタッフ','制作ｻﾌﾞP','制作P','アシスタント'];
const ACTIVE_STATES = new Set(['確定','アプローチリスト']);
const CLOSED_STATES = new Set(['納品完了','失注']);
const CASE_HEADERS = ['コード','顧客','案件名','状態','営業','制作','納品日','売上','計画URL','見積URL','マスター行番号'];
const ACTION_HEADERS = ['種別','期限/日時','内容','相手/案件','状態','直リンク'];
const LOG_HEADERS = ['実行日時','案件数','メール数','未返信数','予定数','アイミツ数','tl;dv数','エラー'];

const norm = value => String(value ?? '').normalize('NFKC').replace(/[\s　]+/g, '').trim();
const text = value => String(value ?? '').trim();
export function headerMap(headers) { return new Map(headers.map((value, index) => [norm(value), index])); }
function indexOf(map, ...names) { for (const name of names) if (map.has(norm(name))) return map.get(norm(name)); return -1; }
function includesSatou(value) { return norm(value).includes('佐藤優奈'); }
export function sheetDate(value) {
  if (value === '' || value == null) return null;
  if (typeof value === 'number') return new Date(Date.UTC(1899, 11, 30) + value * 86400000);
  const s = text(value).replace(/\(.+?\)/g, '').replace(/[年月]/g, '/').replace(/日/g, '');
  const m = s.match(/(20\d{2})[\/-](\d{1,2})[\/-](\d{1,2})/);
  return m ? new Date(`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}T00:00:00+09:00`) : null;
}
const jstDate = date => new Intl.DateTimeFormat('sv-SE',{timeZone:JST,year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
const jstTime = date => new Intl.DateTimeFormat('ja-JP',{timeZone:JST,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(date);

export function extractCases(rows, now = new Date()) {
  if (!rows.length) throw new Error('案件一覧が空です');
  const map = headerMap(rows[0]);
  const required = { state:indexOf(map,'予算項目'), code:indexOf(map,'ｺｰﾄﾞ','コード'), client:indexOf(map,'クライアント名'), name:indexOf(map,'案件名'), delivered:indexOf(map,'納品日'), sales:indexOf(map,'営業'), production:indexOf(map,'制作') };
  const missing = Object.entries(required).filter(([,i])=>i<0).map(([k])=>k);
  if (missing.length) throw new Error(`案件一覧の必須ヘッダーなし: ${missing.join(',')}`);
  const idx = { ...required, plan:indexOf(map,'実施計画URL'), estimate:indexOf(map,'見積書URL'), revenue:indexOf(map,'売上') };
  const staff = STAFF_HEADERS.map(name=>indexOf(map,name)).filter(i=>i>=0);
  const cutoff = new Date(now); cutoff.setDate(cutoff.getDate()-30);
  return rows.slice(1).flatMap((row, offset) => {
    const primary = includesSatou(row[idx.sales]) || includesSatou(row[idx.production]);
    const secondary = staff.some(i=>includesSatou(row[i]));
    const state = text(row[idx.state]);
    if (!primary && !(secondary && ACTIVE_STATES.has(state))) return [];
    const delivery = sheetDate(row[idx.delivered]);
    if (CLOSED_STATES.has(state) && delivery && delivery < cutoff) return [];
    return [{ code:text(row[idx.code]), client:text(row[idx.client]), name:text(row[idx.name]), state,
      sales:text(row[idx.sales]), production:text(row[idx.production]), delivery, deliveryText:delivery ? jstDate(delivery) : text(row[idx.delivered]),
      revenue:row[idx.revenue] ?? '', plan:text(row[idx.plan]), estimate:text(row[idx.estimate]), masterRow:offset+2 }];
  });
}

export function extractAimitsu(messages) {
  const out = [], seen = new Set();
  for (const m of messages) {
    if (!/@imitsu\.jp/i.test(m.from || '')) continue;
    const hay = `${m.subject || ''}\n${m.snippet || ''}\n${m.body || ''}`;
    const no = hay.match(/案件\s*(?:No|NO|番号)\s*[:：#]?\s*([A-Za-z0-9_-]+)/i)?.[1] || '';
    const company = hay.match(/企業名\s*[:：]\s*([^\n\r]+)/)?.[1]?.trim() || hay.match(/([^\n\r]{1,80})様からのメッセージ/)?.[1]?.trim() || '';
    const unanswered = /未回答案件|未回答|回答期限/.test(hay);
    if (!no && !company && !unanswered) continue;
    const key = `${m.threadId}|${no}|${company}|${unanswered}`;
    if (seen.has(key)) continue; seen.add(key);
    out.push({ caseNo:no, company, unanswered, subject:m.subject || '', threadId:m.threadId, url:gmailUrl(m.threadId) });
  }
  return out;
}

function gmailUrl(threadId) { return `https://mail.google.com/mail/?authuser=${encodeURIComponent(USER)}#all/${threadId}`; }
async function googleJson(url, { token, method='GET', body, fetchImpl=gwsFetch }={}) {
  const res = await fetchImpl(url,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
  const raw=await res.text(); let value={}; try { value=raw?JSON.parse(raw):{}; } catch { value={raw:raw.slice(0,300)}; }
  if(!res.ok) throw new Error(`Google API ${res.status}: ${value?.error?.message || raw.slice(0,200)}`);
  return value;
}
async function driveToken() { return getDriveToken({scope:DRIVE_SCOPE,impersonate:USER,signal:AbortSignal.timeout(30000)}); }
async function readSheet(id, range, deps={}) {
  const token=await (deps.getToken||driveToken)();
  return (await googleJson(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`,{token,fetchImpl:deps.fetchImpl})).values || [];
}

async function gmailThread(token, id, fetchImpl=gwsFetch) {
  const data=await googleJson(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${id}?format=metadata&metadataHeaders=Date&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject`,{token,fetchImpl});
  return (data.messages||[]).map(compactMessage);
}
function sender(raw='') { const m=raw.match(/^(.*?)\s*<([^>]+)>/); return m ? {name:m[1].replace(/^"|"$/g,'').trim(),email:m[2].trim()} : {name:raw,email:(raw.match(/[\w.+-]+@[\w.-]+/)||[''])[0]}; }
async function collectMail(deps={}) {
  const query='newer_than:2d (to:satou@orgiast.jp OR cc:satou@orgiast.jp OR "佐藤 優奈" OR "佐藤優奈" OR from:imitsu.jp) -from:saiyo@orgiast.jp -to:saiyo@orgiast.jp';
  const result=await (deps.searchGmail||searchGmail)({user:USER,query,max:100,withBody:true,bodyLimit:8000,concurrency:3});
  const token=await (deps.getGmailToken||(()=>getDriveToken({scope:GMAIL_SCOPE,impersonate:USER})))();
  const byThread=new Map(); for(const m of result.messages) if(!byThread.has(m.threadId)) byThread.set(m.threadId,m);
  const messages=[...byThread.values()];
  const unanswered=[];
  for(const m of messages) {
    const thread=await (deps.gmailThread||gmailThread)(token,m.threadId,deps.fetchImpl);
    const last=thread.sort((a,b)=>Number(a.internalDate)-Number(b.internalDate)).at(-1) || m;
    const who=sender(last.from);
    if(who.email && !/@orgiast\.jp$/i.test(who.email)) unanswered.push({...last,sender:who,url:gmailUrl(last.threadId)});
  }
  return {messages,unanswered,aimitsu:extractAimitsu(result.messages)};
}

async function collectCalendar(now, deps={}) {
  const start=new Date(now), end=new Date(now); end.setDate(end.getDate()+14);
  const all=[];
  for(const user of [USER,'kim@orgiast.jp']) {
    const token=await (deps.getCalendarToken||(()=>getDriveToken({scope:CALENDAR_SCOPE,impersonate:user})))();
    const q=new URLSearchParams({timeMin:start.toISOString(),timeMax:end.toISOString(),singleEvents:'true',orderBy:'startTime',maxResults:'250'});
    const data=await googleJson(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`,{token,fetchImpl:deps.fetchImpl});
    for(const e of data.items||[]) {
      const attendees=(e.attendees||[]).map(a=>a.email?.toLowerCase());
      const organizer=(e.organizer?.email||'').toLowerCase();
      if(attendees.includes('satou@orgiast.jp')||attendees.includes('matsumoto.y.work@gmail.com')||organizer==='matsumoto.y.work@gmail.com') all.push({...e,calendarUser:user});
    }
  }
  return [...new Map(all.map(e=>[e.id,e])).values()];
}

async function collectTldv(cases, now, deps={}) {
  const key=process.env.TLDV_API_KEY||readEnvValue(path.join(os.homedir(),'.claude','tldv.env'),'TLDV_API_KEY');
  if(!key) return {items:[],note:'tl;dv キーなし'};
  const since=new Date(now); since.setDate(since.getDate()-7);
  const url=`https://pasta.tldv.io/v1alpha1/meetings?${new URLSearchParams({from:since.toISOString(),to:now.toISOString(),page:'1',limit:'100'})}`;
  const res=await (deps.fetchImpl||fetch)(url,{headers:{'x-api-key':key},signal:AbortSignal.timeout(30000)}); if(!res.ok) throw new Error(`tl;dv HTTP ${res.status}`);
  const data=await res.json(), needles=[...new Set(cases.flatMap(c=>[c.code,c.client]).filter(v=>norm(v).length>=2))];
  return {items:(data.results||[]).filter(m=>needles.some(n=>norm(m.name).includes(norm(n)))).map(m=>({name:m.name,date:m.happenedAt,url:m.url||`https://tldv.io/app/meetings/${m.id}`})),note:''};
}

function caseRows(cases) { return cases.map(c=>[c.code,c.client,c.name,c.state,c.sales,c.production,c.deliveryText,c.revenue,c.plan,c.estimate,c.masterRow]); }
function actionRows({mail,calendar,cases,tldv,now}) {
  const rows=[];
  for(const m of mail.unanswered) rows.push(['未返信メール',`${jstDate(new Date(Number(m.internalDate)))} ${jstTime(new Date(Number(m.internalDate)))}`,m.subject,m.sender.name||m.sender.email,'未返信',m.url]);
  const soon=new Date(now); soon.setHours(soon.getHours()+48);
  for(const e of calendar) { const d=new Date(e.start?.dateTime||`${e.start?.date}T00:00:00+09:00`); if(d<=soon) rows.push(['予定',`${jstDate(d)} ${jstTime(d)}`,e.summary||'(無題)',e.location||e.calendarUser,'48時間以内',e.htmlLink||'']); }
  const week=new Date(now); week.setDate(week.getDate()+7);
  for(const c of cases) if(c.delivery&&c.delivery>=now&&c.delivery<=week) rows.push(['納品期限',c.deliveryText,c.name,c.client,c.state,c.plan||c.estimate]);
  for(const a of mail.aimitsu.filter(a=>a.unanswered)) rows.push(['アイミツ', '',a.subject||`案件No: ${a.caseNo}`,a.company,'未回答',a.url]);
  for(const m of tldv.items) rows.push(['tl;dv',m.date,m.name,'会議','参考',m.url]);
  return rows;
}
async function writeOutputs(payload, deps={}) {
  const token=await (deps.getToken||driveToken)(), fetchImpl=deps.fetchImpl;
  const before=await googleJson(`https://sheets.googleapis.com/v4/spreadsheets/${LEDGER_ID}?fields=sheets.properties`,{token,fetchImpl});
  const sheet1=before.sheets?.find(s=>s.properties.title==='シート1')?.properties;
  if(!sheet1) throw new Error('保護対象の「シート1」が見つかりません');
  const requests=OUTPUT_TABS.filter(title=>!before.sheets.some(s=>s.properties.title===title)).map(title=>({addSheet:{properties:{title,gridProperties:{frozenRowCount:1}}}}));
  if(requests.length) await googleJson(`https://sheets.googleapis.com/v4/spreadsheets/${LEDGER_ID}:batchUpdate`,{token,method:'POST',body:{requests},fetchImpl});
  const tables={ '自動_案件':[CASE_HEADERS,...caseRows(payload.cases)], '自動_今日の要対応':[ACTION_HEADERS,...payload.actions], '自動_実行ログ':[LOG_HEADERS,[payload.executedAt,payload.cases.length,payload.mail.messages.length,payload.mail.unanswered.length,payload.calendar.length,payload.mail.aimitsu.length,payload.tldv.items.length,payload.errors.join(' | ')||payload.tldv.note]] };
  for(const [title,values] of Object.entries(tables)) {
    await googleJson(`https://sheets.googleapis.com/v4/spreadsheets/${LEDGER_ID}/values/${encodeURIComponent(`'${title}'!A:Z`)}:clear`,{token,method:'POST',body:{},fetchImpl});
    await googleJson(`https://sheets.googleapis.com/v4/spreadsheets/${LEDGER_ID}/values/${encodeURIComponent(`'${title}'!A1`)}?valueInputOption=RAW`,{token,method:'PUT',body:{values},fetchImpl});
  }
  const after=await googleJson(`https://sheets.googleapis.com/v4/spreadsheets/${LEDGER_ID}?fields=sheets.properties`,{token,fetchImpl});
  const protectedAfter=after.sheets?.find(s=>s.properties.title==='シート1')?.properties;
  if(protectedAfter?.sheetId!==sheet1.sheetId) throw new Error('シート1 identity changed');
  const readBack={}; for(const title of OUTPUT_TABS) readBack[title]=(await readSheet(LEDGER_ID,`'${title}'!A:Z`,{getToken:async()=>token,fetchImpl})).length;
  return {readBack,sheet1:{sheetId:sheet1.sheetId,title:sheet1.title,rowCount:sheet1.gridProperties?.rowCount,columnCount:sheet1.gridProperties?.columnCount},sheet1Unchanged:JSON.stringify(sheet1)===JSON.stringify(protectedAfter)};
}

export async function run({now=new Date(),dryRun=false,deps={}}={}) {
  const errors=[], status={}; let cases=[],mail={messages:[],unanswered:[],aimitsu:[]},calendar=[],tldv={items:[],note:''};
  const source=async(name,fn,fallback)=>{try{const v=await fn();status[name]='ok';return v;}catch(e){errors.push(`${name}: ${e.message}`);status[name]='error';return fallback;}};
  cases=await source('案件一覧',async()=>extractCases(await readSheet(MASTER_ID,`'${MASTER_TAB}'!A:CL`,deps),now),[]);
  mail=await source('Gmail',()=>collectMail(deps),mail);
  calendar=await source('Calendar',()=>collectCalendar(now,deps),[]);
  tldv=await source('tl;dv',()=>collectTldv(cases,now,deps),tldv);
  if(Object.values(status).every(v=>v==='error')) { const e=new Error(`全ソース失敗: ${errors.join(' | ')}`); e.exitCode=1; throw e; }
  const payload={executedAt:`${jstDate(now)} ${jstTime(now)} JST`,cases,mail,calendar,tldv,errors,status}; payload.actions=actionRows({...payload,now});
  payload.write=dryRun?{mode:'dry-run'}:await writeOutputs(payload,deps);
  return payload;
}
export function summary(r) { return `satou-secretary ${r.executedAt} cases=${r.cases.length} mail=${r.mail.messages.length} unanswered=${r.mail.unanswered.length} calendar=${r.calendar.length} aimitsu=${r.mail.aimitsu.length} tldv=${r.tldv.items.length} actions=${r.actions.length} write=${r.write.mode||'sheet'} errors=${r.errors.length}${r.tldv.note?` note="${r.tldv.note}"`:''}`; }
async function main(){const args=process.argv.slice(2),result=await run({dryRun:args.includes('--dry-run')});console.log(args.includes('--json')?JSON.stringify(result,null,2):summary(result));}
if(isEntry(import.meta.url)) main().catch(e=>{console.error(`satou-secretary failed: ${e.message}`);process.exitCode=e.exitCode||1;});
