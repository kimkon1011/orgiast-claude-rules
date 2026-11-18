import fs from 'node:fs';
import path from 'node:path';
import {ROOT,read,write,hash,segments,elements,hasJa,decode} from './lib.mjs';
const manifest=read('MANIFEST.json');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let last=0;
async function get(url){await sleep(Math.max(0,350-(Date.now()-last)));const r=await fetch(url,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(30000)});const html=await r.text();last=Date.now();if(r.status!==200&&r.status!==404)throw Error('GET '+r.status+' '+url);const f='evidence/templates/'+hash(url)+'.html';write(f,html);return {html,file:f,status:r.status};}
for(const site of ['rebooth','orgiast']){
 const entries=new Map(),sources=[],unverified=[];
 function inventory(html,url,file,postContent='',is404=false){
 const els=elements(html),post=new Set(segments(postContent).map(s=>s.text));
 for(const s of segments(html)){
 if(!hasJa(s.text)||s.text.length>1600)continue;
 const parents=els.filter(e=>e.start<=s.start&&e.end>=s.end);
 if(!parents.some(e=>e.tag==='body'))continue;
 let category=parents.some(e=>e.tag==='header')?'header_navigation':parents.some(e=>e.tag==='footer')?'footer':parents.some(e=>e.tag==='form')?'form':parents.some(e=>/breadcrumb|pankuzu/i.test(e.open))?'breadcrumb':parents.some(e=>/button|btn|submit/i.test(e.open))?'button':parents.some(e=>/taxonomy|filter|select/i.test(e.open))?'taxonomy':is404?'404':'theme_or_dynamic_content';
 if(post.has(s.text)&&!['form','header_navigation','footer','breadcrumb','button','taxonomy','404'].includes(category))continue;
 // Only text from source markup; no guessed UI strings or synthetic send messages.
 const key=category+'\n'+s.text;const row=entries.get(key)||{category,ja:s.text,en:null,status:'failed',reason:'translation_not_run',evidence:[]};
 if(row.evidence.length<3)row.evidence.push({url,file,excerpt:html.slice(Math.max(0,s.start-50),Math.min(html.length,s.end+50)),attribute:s.attribute||null,origin:post.has(s.text)?'rendered form/UI (also present in post_content)':'absent from REST post_content; theme/custom-field/dynamic candidate'});
 entries.set(key,row);
 }}
 for(const p of manifest.pages.filter(p=>p.site===site&&p.phase===1&&p.source_file)){const d=read(p.source_file);if(!d._rendered_evidence)continue;const html=fs.readFileSync(path.join(ROOT,d._rendered_evidence),'utf8');inventory(html,p.ja_url,d._rendered_evidence,d.post_content_html||'');sources.push({url:p.ja_url,file:d._rendered_evidence});}
 const origin=site==='rebooth'?'https://rebooth.co.jp':'https://www.orgiast.jp',url=origin+'/site-en-audit-not-found-20261118/';const r=await get(url);inventory(r.html,url,r.file,'',true);sources.push({url,file:r.file,status:r.status});
 unverified.push({category:'form_submission_messages',reason:'GETで表示されるラベル・プレースホルダ・初期メッセージのみ採録。CF7の送信成功／失敗メッセージやサーバー側検証メッセージはPOST禁止のため未確認。管理画面／フォーム設定の読取りが後工程で必要。'});
 write('template-strings.'+site+'.json',{site,generated:new Date().toISOString(),method:'Rendered text and translatable attributes; compare REST post_content. Candidate origin is explicitly recorded, not asserted to be theme source code.',sources,unverified,entries:[...entries.values()]});
 console.log(site,entries.size,'evidenced template/UI candidates');
}

