/** Re-extract saved GET evidence after parser changes; no network. */
import fs from 'node:fs';
import path from 'node:path';
import {ROOT,read,write,hash,mainContent,visible,decode,walk} from './lib.mjs';
const manifest=read('MANIFEST.json'),http=read('evidence/http.json');
for(const p of manifest.pages){
 let d;
 if(p.source_file)d=read(p.source_file);
 else {
 const endpoint=http.filter(r=>r.url.includes('/pages?')&&r.url.includes(p.site==='rebooth'?'rebooth.co.jp':'orgiast.jp')).find(r=>{try{return read('evidence/http/'+hash(r.url)+'.txt').some(x=>x.id===p.ja_id);}catch{return false;}});
 const raw=endpoint?read('evidence/http/'+hash(endpoint.url)+'.txt').find(x=>x.id===p.ja_id):null;
 d={id:p.ja_id,site:p.site,type:p.type,slug:raw?.slug||new URL(p.ja_url).pathname.split('/').filter(Boolean).at(-1)||'home',link:p.ja_url,title:raw?.title?.rendered||'',post_content_html:raw?.content?.rendered||'',modified:raw?.modified||'',_source:endpoint?'REST':'sitemap',_source_url:endpoint?.url||'sitemap',_content_origin:'rendered-main',phase:p.phase};
 d._rendered_evidence='evidence/http/'+hash(p.ja_url)+'.txt';
 }
 if(d._rendered_evidence){
 if(!fs.existsSync(path.join(ROOT,d._rendered_evidence))){let url=p.ja_url;for(let i=0;i<5;i++){const r=http.find(r=>r.url===url&&r.headers.location);if(!r)break;url=new URL(r.headers.location,url).href;const f='evidence/http/'+hash(url)+'.txt';if(fs.existsSync(path.join(ROOT,f))){d._rendered_evidence=f;break;}}}
 const html=fs.readFileSync(path.join(ROOT,d._rendered_evidence),'utf8');d.content_html=mainContent(html,p.site);if(!d.title)d.title=decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]||'');
 if(!visible(d.content_html).trim())d._content_note='公開ページの本文領域は空。titleのみ翻訳し本文は補作しない。';
 }
 if(d.id===null&&/^\d+$/.test(d.slug)){d.id=Number(d.slug);d._id_evidence='numeric URL slug';p.ja_id=d.id;}
 d._source_hash=hash(d.title+'\n'+d.content_html);
 const slug=p.type==='pages'?(new URL(p.ja_url).pathname.split('/').filter(Boolean).join('--')||'home'):String(d.id||d.slug);
 p.source_file='source/'+p.site+'/'+p.type+'/'+slug+'.ja.json';p.en_file='en/'+p.site+'/'+p.type+'/'+slug+'.en.json';
 if(p.reason.startsWith('fetch:'))p.reason='translation_not_run';
 write(p.source_file,d);
}
write('MANIFEST.json',manifest);
const active=new Set(manifest.pages.map(p=>path.resolve(ROOT,p.source_file)));
const obsolete=walk(path.join(ROOT,'source'),'.ja.json').filter(f=>!active.has(f));
write('evidence/superseded-source-files.json',obsolete.map(f=>path.relative(ROOT,f)));
for(const f of obsolete){const root=path.resolve(ROOT,'source')+path.sep;if(!f.startsWith(root))throw Error('Outside source');fs.unlinkSync(f);}
console.log('Re-extracted',manifest.pages.length,'pages; removed superseded files',obsolete.length);

