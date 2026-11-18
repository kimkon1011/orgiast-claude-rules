/** Rebuild only from current source files; retain validation outcomes. */
import fs from 'node:fs';
import path from 'node:path';
import {ROOT,read,write,walk,canonical,core} from './lib.mjs';
import {validate} from './validation.mjs';
const pages=walk(path.join(ROOT,'source'),'.ja.json').map(file=>{
 const d=JSON.parse(fs.readFileSync(file,'utf8')),source_file=path.relative(ROOT,file).replaceAll('\\','/'),en_file=source_file.replace(/^source\//,'en/').replace(/\.ja\.json$/,'.en.json');
 let status=d._logo_only?'skipped':'failed',reason=d._logo_only?'本文領域 wp_block-content は空。ロゴ／顧客名のみのため翻訳対象外。':'translation_not_run';
 if(!d._logo_only&&fs.existsSync(path.join(ROOT,en_file))){const result=validate(d,read(en_file));status=result.ok?'translated':'failed';reason=result.issues.join('; ');}
 return {site:d.site,type:d.type,ja_id:d.id,ja_url:d.link,source_file,en_path_planned:'/en'+new URL(d.link).pathname,en_file,phase:d.phase,status,reason};
});
const seen=new Set();for(const p of pages){const k=canonical(p.ja_url);if(seen.has(k))throw Error('Duplicate source URL '+k);seen.add(k);}
pages.sort((a,b)=>a.phase-b.phase||a.site.localeCompare(b.site)||a.ja_url.localeCompare(b.ja_url));write('MANIFEST.json',{generated:new Date().toISOString(),pages});console.log('Manifest rebuilt',pages.length);

