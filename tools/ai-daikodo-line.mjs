#!/usr/bin/env node
const BASE=process.env.AI_DAIKODO_BASE_URL||'https://ai-daikodo.com';

export function parseArgs(argv){const out={json:false};for(let i=0;i<argv.length;i++){const a=argv[i];if(a==='--status')out.command='status';else if(a==='--inbox')out.command='inbox';else if(a==='--json')out.json=true;else if(a==='--since')out.since=argv[++i];else throw new Error(`unknown argument: ${a}`);}if(!out.command)throw new Error('use --status or --inbox');if(out.command==='inbox'&&!out.since)out.since=new Date(Date.now()-7*864e5).toISOString();return out;}

export async function callAdmin(path,{fetchImpl=fetch,key=process.env.AI_DAIKODO_ADMIN_API_KEY}={}){if(!key)throw new Error('AI_DAIKODO_ADMIN_API_KEY is not set');const response=await fetchImpl(`${BASE}${path}`,{headers:{Authorization:`Bearer ${key}`}});const text=await response.text();let body;try{body=JSON.parse(text);}catch{body=text;}if(!response.ok)throw new Error(`admin API HTTP ${response.status}: ${typeof body==='string'?body:JSON.stringify(body)}`);return body;}

export async function run(argv,options={}){const args=parseArgs(argv);const path=args.command==='status'?'/api/admin/line/webhook-status':`/api/admin/line/inbox?since=${encodeURIComponent(args.since)}`;const body=await callAdmin(path,options);return{args,body};}

if(import.meta.url===`file:///${process.argv[1].replace(/\\/g,'/')}`){run(process.argv.slice(2)).then(({body})=>console.log(JSON.stringify(body,null,2))).catch(e=>{console.error(e.message);process.exitCode=1;});}
