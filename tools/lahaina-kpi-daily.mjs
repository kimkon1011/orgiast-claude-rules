#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { measure, fetchPageResult } from './lahaina-exposure-check.mjs';
import { defaultDriveKeyPath, getDriveToken } from './lib/drive-auth.mjs';
import { callGraph, readEnvFile, DEFAULT_ENV_PATH, resolveUserId } from './instagram/ig-api.mjs';

export const SHEET_ID = '1bD2r68K3lgCklBaVj5vDGLDePMwBJ8vWgbUOLaRnDSA';
export const TAB = '日次KPI（自動）';
export const HEADERS = ['日付','露出スコア','じゃらん状態','じゃらん最安料金','じゃらんプラン数','楽天状態','公式予約導線数','公式営業継続告知','Airbnb','Booking','IGフォロワー','IG投稿数','GA4セッション','GA4ユーザー','GA4流入元上位','GSCクリック','GSC表示回数','GSC上位クエリ','取得エラー'];
const SUBJECTS = ['kim@orgiast.jp', 'seisaku-team@orgiast.jp'];
const GA_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const EMPTY_HTML_ERROR = '取得失敗: HTMLが空 (null / undefined / 空本文)';
const hasHtml = html => typeof html === 'string' && html.trim().length > 0;

export function isoLocal(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}
export function parseJalanDetails(html = '') {
  if (!hasHtml(html)) return { minPrice: '', planCount: '', error: EMPTY_HTML_ERROR };
  const prices = [...html.matchAll(/([0-9]{1,3}(?:,[0-9]{3})+)円/g)].map(m => Number(m[1].replaceAll(',',''))).filter(Number.isFinite);
  const markerCounts = ['planCassette','planName'].map(marker => (html.match(new RegExp(marker,'gi'))||[]).length);
  const fallback = (html.match(/宿泊プラン/gi)||[]).length;
  return { minPrice: prices.length ? Math.min(...prices) : '', planCount: Math.max(...markerCounts, fallback ? 1 : 0) };
}
export function parseOfficial(html = '') {
  if (!hasHtml(html)) return { reservationCount: '', continuing: null, oyster: null, latestNoticeDate: '', error: EMPTY_HTML_ERROR };
  const hrefs = [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]);
  const reservationLinks = hrefs.filter(h => /jalan|rakuten|booking\.com|airbnb|beds24|yad353005|予約|reserve/i.test(h));
  const dates = [...html.matchAll(/(?:20\d{2})[.\/-](?:1[0-2]|0?[1-9])[.\/-](?:3[01]|[12]\d|0?[1-9])/g)].map(m => m[0].replace(/[.\/]/g,'-').split('-').map((v,i)=>i ? v.padStart(2,'0') : v).join('-'));
  return { reservationCount: new Set(reservationLinks).size, continuing: html.includes('営業継続'), oyster: html.includes('牡蠣'), latestNoticeDate: dates.sort().at(-1) || '' };
}
export function buildRow(k) {
  return [k.date,k.exposureScore,k.jalan.status,k.jalan.minPrice,k.jalan.planCount,k.rakuten,k.official.reservationCount,k.official.continuing == null ? '' : k.official.continuing ? 'あり' : 'なし',k.airbnb,k.booking,k.instagram.followers,k.instagram.posts,k.ga4.sessions,k.ga4.users,k.ga4.sources.join(' / '),k.gsc.clicks,k.gsc.impressions,k.gsc.queries.join(' / '),k.errors.join(' | ')];
}

export function parseInstagram(html = '') {
  if (!hasHtml(html)) return { followers: '', posts: '', error: EMPTY_HTML_ERROR };
  const followers = html.match(/([\d,.]+)\s*(?:Followers|フォロワー)/i)?.[1] || html.match(/"edge_followed_by":\{"count":(\d+)/)?.[1] || '';
  const posts = html.match(/([\d,.]+)\s*(?:Posts|投稿)/i)?.[1] || html.match(/"edge_owner_to_timeline_media":\{"count":(\d+)/)?.[1] || '';
  return { followers, posts, error: followers || posts ? '' : '公開ページから数値抽出不可' };
}

function pageError(media, page, reason) {
  return `${media}: ${reason} (URL: ${page.url}, HTTP: ${page.httpStatus ?? '応答なし'})`;
}

async function jsonApi(url, token, options = {}) {
  const res = await fetch(url, { ...options, headers: { Authorization:`Bearer ${token}`, 'Content-Type':'application/json', ...(options.headers||{}) } });
  const text = await res.text(); let body = null; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw:text.slice(0,300) }; }
  if (!res.ok) throw new Error(`${res.status} ${body?.error?.message || text.slice(0,200)}`);
  return body;
}
async function token(subject, scope) { return getDriveToken({ keyPath:defaultDriveKeyPath(), impersonate:subject, scope }); }

async function getInstagram() {
  const env = readEnvFile(DEFAULT_ENV_PATH);
  if (env.INSTAGRAM_ACCESS_TOKEN) {
    try {
      const id = env.INSTAGRAM_USER_ID || (await resolveUserId({accessToken:env.INSTAGRAM_ACCESS_TOKEN})).userId;
      const d = await callGraph({path:`/${id}`, params:{fields:'username,followers_count,media_count'}, accessToken:env.INSTAGRAM_ACCESS_TOKEN});
      return { followers:d.followers_count ?? '', posts:d.media_count ?? '', source:'graph', error:'' };
    } catch (e) { /* public fallback below */ }
  }
  try {
    const url = 'https://www.instagram.com/lahaina_ushimado/';
    const page = await fetchPageResult(url);
    const parsed = parseInstagram(page.error ? null : page.html);
    const reason = page.error || parsed.error;
    return {...parsed,source:'public',url,httpStatus:page.httpStatus,error:reason ? pageError('Instagram',{...page,url},reason) : ''};
  } catch (e) { return {followers:'',posts:'',source:'public',error:`Instagram取得失敗: ${e.message}`}; }
}

async function getGa4(date) {
  const audit=[];
  for (const subject of SUBJECTS) {
    try {
      const t=await token(subject,GA_SCOPE); const sums=await jsonApi('https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200',t);
      let properties=0;
      for (const a of sums.accountSummaries||[]) for (const p of a.propertySummaries||[]) {
        properties++; const streams=await jsonApi(`https://analyticsadmin.googleapis.com/v1beta/${p.property}/dataStreams?pageSize=200`,t);
        const hit=(streams.dataStreams||[]).find(s=>s.webStreamData?.measurementId==='G-7WMQYJGG39');
        if (!hit) continue;
        const propertyId=p.property.split('/').pop();
        const common={dateRanges:[{startDate:date,endDate:date}],metrics:[{name:'sessions'},{name:'totalUsers'}]};
        const totals=await jsonApi(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,t,{method:'POST',body:JSON.stringify(common)});
        const sources=await jsonApi(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,t,{method:'POST',body:JSON.stringify({dateRanges:common.dateRanges,dimensions:[{name:'sessionSourceMedium'}],metrics:[{name:'sessions'}],orderBys:[{metric:{metricName:'sessions'},desc:true}],limit:3})});
        const events=await jsonApi(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,t,{method:'POST',body:JSON.stringify({dateRanges:common.dateRanges,dimensions:[{name:'eventName'}],metrics:[{name:'eventCount'}],dimensionFilter:{filter:{fieldName:'eventName',inListFilter:{values:['form_submit','click']}}}})});
        return {sessions:totals.rows?.[0]?.metricValues?.[0]?.value||'0',users:totals.rows?.[0]?.metricValues?.[1]?.value||'0',sources:(sources.rows||[]).map(r=>`${r.dimensionValues[0].value}:${r.metricValues[0].value}`),events:(events.rows||[]).map(r=>`${r.dimensionValues[0].value}:${r.metricValues[0].value}`),property:p.property,subject,audit};
      }
      audit.push(`${subject}: accountSummaries=${(sums.accountSummaries||[]).length}, properties=${properties}, measurementId一致=0`);
    } catch(e) { audit.push(`${subject}: ${e.message}`); }
  }
  return {sessions:'',users:'',sources:[],events:[],property:'',subject:'',audit,error:`GA4権限なし（G-7WMQYJGG39 はどちらの配下にも無い）`};
}

async function getGsc(date) {
  const audit=[];
  for (const subject of SUBJECTS) {
    try {
      const t=await token(subject,GSC_SCOPE); const sites=await jsonApi('https://searchconsole.googleapis.com/webmasters/v3/sites',t);
      const entries=sites.siteEntry||[]; const hit=entries.find(s=>['https://lahaina.jp/','sc-domain:lahaina.jp'].includes(s.siteUrl));
      if (!hit) { audit.push(`${subject}: sites=${entries.length}, lahaina一致=0`); continue; }
      const endpoint=`https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(hit.siteUrl)}/searchAnalytics/query`;
      const totals=await jsonApi(endpoint,t,{method:'POST',body:JSON.stringify({startDate:date,endDate:date,rowLimit:1})});
      const result=await jsonApi(endpoint,t,{method:'POST',body:JSON.stringify({startDate:date,endDate:date,dimensions:['query'],rowLimit:3})});
      const rows=result.rows||[], total=totals.rows?.[0]||{}; return {clicks:total.clicks||0,impressions:total.impressions||0,queries:rows.map(r=>`${r.keys[0]}:${r.clicks}/${r.impressions}`),site:hit.siteUrl,subject,audit};
    } catch(e) { audit.push(`${subject}: ${e.message}`); }
  }
  return {clicks:'',impressions:'',queries:[],site:'',subject:'',audit,error:'GSC権限なし'};
}

async function writeSheet(row, dryRun) {
  if (dryRun) return {mode:'dry-run',verified:false};
  let t, authScope, authErrors=[];
  for (const scope of [SHEETS_SCOPE,'https://www.googleapis.com/auth/drive']) try { t=await token('kim@orgiast.jp',scope); authScope=scope; break; } catch(e) { authErrors.push(`${scope}: ${e.message}`); }
  if (!t) throw new Error(`Sheets認証失敗: ${authErrors.join(' / ')}`);
  const meta=await jsonApi(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties`,t);
  if (!(meta.sheets||[]).some(s=>s.properties.title===TAB)) await jsonApi(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`,t,{method:'POST',body:JSON.stringify({requests:[{addSheet:{properties:{title:TAB}}}]})});
  const range=encodeURIComponent(`'${TAB}'!A:S`); const current=await jsonApi(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}`,t);
  const values=current.values||[]; let index=values.findIndex((r,i)=>i>0&&r[0]===row[0]);
  if (!values.length) await jsonApi(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(`'${TAB}'!A1:S1`)}?valueInputOption=RAW`,t,{method:'PUT',body:JSON.stringify({values:[HEADERS]})});
  if (index<0) index=Math.max(values.length,1);
  const target=`'${TAB}'!A${index+1}:S${index+1}`;
  await jsonApi(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(target)}?valueInputOption=RAW`,t,{method:'PUT',body:JSON.stringify({values:[row]})});
  const back=await jsonApi(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(target)}`,t);
  const got=back.values?.[0]||[]; const verified=row.every((v,i)=>String(v??'')===String(got[i]??''));
  if (!verified) throw new Error(`Sheet read-back mismatch at ${target}`);
  return {mode:'sheet',target,verified,authScope,row:got};
}

export async function collect({now=new Date(),dryRun=false,outputDir=path.join(os.homedir(),'.claude','lahaina-kpi'),dependencies={}}={}) {
  const deps = {measure,getInstagram,getGa4,getGsc,writeSheet,...dependencies};
  const date=isoLocal(now), check=new Date(now); check.setDate(check.getDate()+14);
  const yesterday=new Date(now); yesterday.setDate(yesterday.getDate()-1);
  const twoDaysAgo=new Date(now); twoDaysAgo.setDate(twoDaysAgo.getDate()-2);
  const errors=[];
  const exposure=await deps.measure({dateStr:isoLocal(check),includeHtml:true});
  const jalanItem=exposure.results.find(r=>r.media==='じゃらん'), rakuten=exposure.results.find(r=>r.media==='楽天トラベル'), airbnb=exposure.results.find(r=>r.media==='Airbnb'), booking=exposure.results.find(r=>r.media==='Booking.com');
  const officialItem=exposure.results.find(r=>r.media==='公式HP');
  const jalan=parseJalanDetails(jalanItem.error ? null : jalanItem.html), official=parseOfficial(officialItem.error ? null : officialItem.html);
  for (const item of exposure.results) {
    const reason=item.error || (item===jalanItem ? jalan.error : item===officialItem ? official.error : '');
    if(reason) errors.push(pageError(item.media,item,reason));
  }
  const [instagram,ga4,gsc]=await Promise.all([
    Promise.resolve().then(()=>deps.getInstagram()).catch(e=>({followers:'',posts:'',error:`Instagram取得失敗: ${e.message}`})),
    Promise.resolve().then(()=>deps.getGa4(isoLocal(yesterday))).catch(e=>({sessions:'',users:'',sources:[],error:`GA4取得失敗: ${e.message}`})),
    Promise.resolve().then(()=>deps.getGsc(isoLocal(twoDaysAgo))).catch(e=>({clicks:'',impressions:'',queries:[],error:`GSC取得失敗: ${e.message}`})),
  ]);
  if(instagram.error) errors.push(instagram.error); if(ga4.error) errors.push(ga4.error); if(gsc.error) errors.push(gsc.error);
  const k={date,exposureScore:`${exposure.buyable}/${exposure.total}`,jalan:{status:jalanItem.status,...jalan},rakuten:rakuten.status,official,airbnb:airbnb.status,booking:booking.status,instagram,ga4,gsc,errors,checkin:exposure.checkin,
    fetches:exposure.results.map(({html,...item})=>({...item,...(html===undefined ? {} : {htmlWasNull:html===null})}))};
  const row=buildRow(k); const dir=outputDir; fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,`${date}.json`); fs.writeFileSync(file,JSON.stringify({...k,row,savedAt:new Date().toISOString()},null,2));
  let write; try { write=await deps.writeSheet(row,dryRun); } catch(e) { errors.push(e.message); fs.writeFileSync(file,JSON.stringify({...k,errors,row:buildRow(k),savedAt:new Date().toISOString()},null,2)); write={mode:'local-fallback',verified:false,error:e.message}; }
  return {...k,row:buildRow(k),localFile:file,write};
}

async function main() {
  const a=process.argv.slice(2); if(a.includes('--help')||a.includes('-h')) { console.log('Usage: node tools/lahaina-kpi-daily.mjs [--dry-run] [--json]\nDaily Lahaina exposure, web, Instagram, GA4 and Search Console KPI collection.'); return; }
  const result=await collect({dryRun:a.includes('--dry-run')});
  const logDir=path.join(os.homedir(),'.claude','lahaina-kpi'); fs.mkdirSync(logDir,{recursive:true});
  fs.appendFileSync(path.join(logDir,'run.log'),`${new Date().toISOString()} date=${result.date} exposure=${result.exposureScore} write=${result.write.mode} verified=${result.write.verified} errors=${result.errors.length}\n`);
  if(a.includes('--json')) console.log(JSON.stringify(result,null,2));
  else console.log(`lahaina-kpi ${result.date} exposure=${result.exposureScore} write=${result.write.mode} verified=${result.write.verified} errors=${result.errors.length} file=${result.localFile}`);
}
if(isEntry(import.meta.url)) main().catch(e=>{const line=`${new Date().toISOString()} failed=${e.message}\n`; try { const d=path.join(os.homedir(),'.claude','lahaina-kpi'); fs.mkdirSync(d,{recursive:true}); fs.appendFileSync(path.join(d,'run.log'),line); } catch {} console.error(`lahaina-kpi failed: ${e.message}`);process.exitCode=1;});
