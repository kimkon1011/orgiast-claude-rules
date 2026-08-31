#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseEnvText } from './env-kv.mjs';
import { isEntry } from './is-entry.mjs';
import { extractWebhooks, scanFiles, buildWebhookSheetPayload } from './webhook-health.mjs';
import { resolveReporterLabel } from './reporter-label.mjs';

const API = 'https://discord.com/api/v10';
const normalize = (value) => String(value ?? '').toLowerCase().replace(/[ \u3000]/g, '');
const safeRow = (row) => ({ webhookId:row.webhookId || '', name:row.name || '', channelName:row.channelName || '', files:(row.files || row.pcs || '') });
export function formatWebhookCandidates(rows) {
  return ['Webhook名 / チャンネル / 保管場所', ...(rows || []).map((row) => { const safe=safeRow(row); return `${safe.name} / ${safe.channelName} / ${Array.isArray(safe.files) ? safe.files.map((f)=>path.basename(f)).join(', ') : safe.files}`; })].join('\n');
}
export function pickWebhookResult(rows, { json=false }={}) {
  const values=Array.isArray(rows)?rows:[];
  if (json) return { exitCode:values.length?0:1, stdout:`${JSON.stringify({count:values.length,rows:values.map(safeRow)})}\n`, stderr:'' };
  if (values.length===1 && values[0].url) return {exitCode:0,stdout:`${values[0].url}\n`,stderr:''};
  if (values.length>1) return {exitCode:1,stdout:'',stderr:`候補が複数あります。名前で選んでください。\n${formatWebhookCandidates(values)}\n`};
  return {exitCode:1,stdout:'',stderr:values.length?'URLはこのPCにありません。保管PCで実行してください。\n':'一致するWebhookがありません。\n'};
}
function parseArgs(args) {
  const out={json:false,create:'',name:'',query:''}, positional=[];
  for(let i=0;i<args.length;i+=1){ if(args[i]==='--json')out.json=true; else if(args[i]==='--create'&&args[i+1])out.create=args[++i]; else if(args[i]==='--name'&&args[i+1])out.name=args[++i]; else if(args[i].startsWith('--'))throw new Error(`不明なオプション: ${args[i]}`); else positional.push(args[i]); }
  out.query=positional.join(' '); if(!out.create&&!out.query)throw new Error('Webhook名またはチャンネル名を指定してください'); return out;
}
async function readContext(){ const home=process.env.ORGIAST_HOME||os.homedir(), dir=path.join(home,'.claude'); let ledger={}; try{ledger=JSON.parse(await fs.readFile(path.join(dir,'discord-webhooks.json'),'utf8'));}catch{} let envText='';try{envText=await fs.readFile(path.join(dir,'fleet-sheet.env'),'utf8');}catch{} return {home,dir,ledger,envText,env:parseEnvText(envText)}; }
async function localRows(ctx,query){ const urls=new Map(); for(const file of await scanFiles([])){let text='';try{text=await fs.readFile(file,'utf8');}catch{} for(const item of extractWebhooks(text))urls.set(item.webhookId,{...item,files:[path.basename(file)]});} for(const [id,item] of Object.entries(ctx.ledger)){if(item.url)urls.set(id,{webhookId:id,url:item.url,files:(item.files||[]).map((f)=>path.basename(f))});} const q=normalize(query); return [...urls.values()].map((item)=>({...item,...ctx.ledger[item.webhookId],files:item.files})).filter((item)=>[item.name,item.channelName,item.channelId,item.webhookId].some((v)=>normalize(v).includes(q))); }
async function sheetRows(ctx,query){if(!ctx.env.FLEET_SHEET_URL||!ctx.env.FLEET_SHEET_TOKEN)return[];const response=await fetch(ctx.env.FLEET_SHEET_URL,{method:'POST',redirect:'follow',headers:{'content-type':'application/json'},body:JSON.stringify({token:ctx.env.FLEET_SHEET_TOKEN,kind:'webhook-lookup',query,limit:200})});let body={};try{body=JSON.parse(await response.text());}catch{}return response.ok&&body.ok&&Array.isArray(body.rows)?body.rows:[];}
async function createWebhook(ctx,channelId,name){let token='';try{token=(await fs.readFile(path.join(ctx.dir,'orgiast-discord-bot-token.txt'),'utf8')).trim();}catch{}if(!token)throw new Error('このPCにDiscord Botトークンがありません');const response=await fetch(`${API}/channels/${encodeURIComponent(channelId)}/webhooks`,{method:'POST',headers:{Authorization:`Bot ${token}`,'content-type':'application/json'},body:JSON.stringify({name:name||'orgiast notification'})});if(response.status===403)throw new Error(`Botに「ウェブフックの管理」権限が必要です: https://discord.com/developers/applications`);if(!response.ok)throw new Error(`Discord API HTTP ${response.status}`);const body=await response.json(), url=`https://discord.com/api/webhooks/${body.id}/${body.token}`;ctx.ledger[body.id]={...(ctx.ledger[body.id]||{}),url,name:body.name,channelId:String(body.channel_id),files:['discord-webhooks.json'],lastSeenAliveAt:new Date().toISOString()};await fs.writeFile(path.join(ctx.dir,'discord-webhooks.json'),`${JSON.stringify(ctx.ledger,null,2)}\n`,'utf8');if(ctx.env.FLEET_SHEET_URL&&ctx.env.FLEET_SHEET_TOKEN){const resolved=resolveReporterLabel({envText:ctx.envText,hostname:os.hostname()}),payload=buildWebhookSheetPayload({alive:[{webhookId:String(body.id),name:body.name,channelId:String(body.channel_id),channelName:'',status:'alive',files:['discord-webhooks.json']}],dead:[],errors:[]},{label:resolved.label,checkedAt:new Date().toISOString().slice(0,10)});const posted=await fetch(ctx.env.FLEET_SHEET_URL,{method:'POST',redirect:'follow',headers:{'content-type':'application/json'},body:JSON.stringify({token:ctx.env.FLEET_SHEET_TOKEN,kind:'webhooks',...payload})});let result={};try{result=JSON.parse(await posted.text());}catch{}if(!posted.ok||!result.ok)throw new Error(`Webhookは作成しましたが台帳登録に失敗しました (HTTP ${posted.status})`);}return [{...ctx.ledger[body.id],webhookId:String(body.id)}];}
async function main(){const options=parseArgs(process.argv.slice(2)),ctx=await readContext();let rows=options.create?await createWebhook(ctx,options.create,options.name):await localRows(ctx,options.query);if(!rows.length&&!options.create)rows=await sheetRows(ctx,options.query);const result=pickWebhookResult(rows,options);if(result.stdout)process.stdout.write(result.stdout);if(result.stderr)process.stderr.write(result.stderr);process.exitCode=result.exitCode;}
if(isEntry(import.meta.url))main().catch((error)=>{console.error(String(error.message||error).replace(/https:\/\/discord\.com\/api\/webhooks\/\d+\/[^\s]+/g,'[REDACTED]'));process.exitCode=1;});
