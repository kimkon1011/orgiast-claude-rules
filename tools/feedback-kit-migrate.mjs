#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isEntry } from './is-entry.mjs';

export function scanApps(dirs) {
  const found = new Set(), seen = new Set();
  function walk(dir) {
    dir = fs.realpathSync(dir);
    if (seen.has(dir)) return; seen.add(dir);
    let gas = fs.existsSync(path.join(dir, '.clasp.json')) || fs.existsSync(path.join(dir, 'appsscript.json'));
    let next = false;
    try {const p=JSON.parse(fs.readFileSync(path.join(dir,'package.json'),'utf8'));next=Boolean(p.dependencies?.next || p.devDependencies?.next);} catch {}
    if (gas || next) { found.add(dir); if (gas && !next) return; }
    for (const e of fs.readdirSync(dir,{withFileTypes:true})) {
      if(e.isDirectory() && !e.name.startsWith('.') && !['node_modules','dist','build','out'].includes(e.name)) walk(path.join(dir,e.name));
    }
  }
  dirs.forEach(walk); return [...found].sort();
}
export async function main(args=process.argv.slice(2)) {
  const dirs=[];let apply=false, scanning=false;
  for (const arg of args) {
    if(arg==='--apply') {apply=true;scanning=false;}
    else if(arg==='--scan') scanning=true;
    else if(scanning && !arg.startsWith('--')) dirs.push(path.resolve(arg));
    else throw new Error('不明な引数: '+arg);
  }
  if(!dirs.length) throw new Error('--scan <dir>... が必要です');
  const {verifyApp}=await import('../packages/feedback-kit/verify.mjs');
  const {installApp}=await import('../packages/feedback-kit/install.mjs');
  const rows=[];
  for(const app of scanApps(dirs)) {
    let result=verifyApp(app), error='';
    if(apply && !result.ok) {try {installApp({app,upgrade:true});result=verifyApp(app);} catch(e){error=e.message;}}
    rows.push({app,version:result.kitVersion || '未導入',missing:result.missing.join(', ') || 'なし',error});
  }
  console.table(rows); return rows.some(r=>r.error || r.missing!=='なし')?1:0;
}
if(isEntry(import.meta.url)) {try {process.exitCode=await main();}catch(e){console.error(e.message);process.exitCode=1;}}
