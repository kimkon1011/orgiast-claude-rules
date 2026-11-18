/** GET only; Node standard fetch; >=350ms after completed request. */
import {gunzipSync} from 'node:zlib';
import {write,hash,decode,mainContent,elements,visible,canonical,core} from './lib.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let last=0;const log=[];
async function get(url){
 const u=new URL(url);if(!['rebooth.co.jp','www.orgiast.jp','plugins.svn.wordpress.org'].includes(u.hostname)||u.pathname.startsWith('/en/'))throw Error('URL outside GET scope: '+url);
 for(let attempt=0;attempt<3;attempt++){await sleep(Math.max(0,350-(Date.now()-last)));try{
 const r=await fetch(url,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(30000),headers:{'User-Agent':'Orgiast-English-Content-Audit/2.0'}});let b=Buffer.from(await r.arrayBuffer());last=Date.now();
 const record={url,status:r.status,at:new Date().toISOString(),headers:Object.fromEntries(r.headers)};log.push(record);write('evidence/http.json',log);
 if(r.status>=300&&r.status<400&&r.headers.get('location')){const result=await get(new URL(r.headers.get('location'),url).href);write('evidence/http/'+hash(url)+'.txt',result.text);return result;}
 if((r.status===429||r.status>=500)&&attempt<2){await sleep(2000*(attempt+1));continue;}
 if(b[0]===31&&b[1]===139)b=gunzipSync(b);const text=b.toString('utf8');write('evidence/http/'+hash(url)+'.txt',text);return {...record,text};
 }catch(e){last=Date.now();if(attempt===2)throw e;await sleep(2000);}}
}
async function json(url){const r=await get(url);try{return r.status===200?JSON.parse(r.text):null;}catch{return null;}}
async function sitemap(url,seen=new Set()){if(seen.has(url))return [];seen.add(url);const r=await get(url);if(r.status!==200)throw Error('Sitemap '+r.status+' '+url);const locs=[...r.text.matchAll(/<loc>\s*(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?\s*<\/loc>/g)].map(m=>decode(m[1]));if(/<sitemapindex\b/.test(r.text)){const out=[];for(const loc of locs)out.push(...await sitemap(loc,seen));return out;}return [...r.text.matchAll(/<url>([\s\S]*?)<\/url>/g)].map(m=>({url:decode(m[1].match(/<loc>\s*(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?\s*<\/loc>/)?.[1]||''),modified:m[1].match(/<lastmod>(.*?)<\/lastmod>/)?.[1]||'',sitemap:url}));}
const rows=[],inventory={},failures=[];
const sites={rebooth:'https://rebooth.co.jp',orgiast:'https://www.orgiast.jp'};
const wanted={rebooth:['page','post','works','news','reviews','client'],orgiast:['page','post','event','creative','interview','newsrelease','topics']};
for(const [site,origin] of Object.entries(sites)){
 console.log('FETCH '+site);const home=await get(origin+'/');write('evidence/'+site+'-home.html',home.text);
 let rest=origin+(site==='orgiast'?'/wp':'')+'/wp-json/wp/v2';let types=await json(rest+'/types');
 if(!types){const linked=home.headers.link?.match(/<([^>]+)>; rel="https:\/\/api.w.org\/"/)?.[1];if(linked){rest=linked.replace(/\/$/,'')+'/wp/v2';types=await json(rest+'/types');}}
 inventory[site]={rest,types:types||{},sitemap:[]};await get(origin+'/wp-json/');await get(origin+'/feed/');
 const records=new Map();
 for(const type of wanted[site]){const info=types?.[type];if(!info)continue;for(let page=1;;page++){
 const endpoint=rest+'/'+info.rest_base+'?per_page=100&page='+page;const r=await get(endpoint);let data;try{data=JSON.parse(r.text);}catch{}if(r.status!==200||!Array.isArray(data)){failures.push({site,type,url:endpoint,reason:'REST unavailable '+r.status});break;}
 for(const d of data){if(new URL(d.link).pathname.startsWith('/en/'))continue;const pathname=new URL(d.link).pathname;const actualType=type==='page'?'pages':type==='post'?(pathname.split('/')[1]||'posts'):type;
 records.set(canonical(d.link),{id:d.id,site,type:actualType,slug:d.slug,link:d.link,title:d.title?.rendered||'',content_html:d.content?.rendered||'',post_content_html:d.content?.rendered||'',modified:d.modified||'',_source:'REST',_source_url:endpoint});}
 console.log(site,info.rest_base,page,data.length);if(page>=Number(r.headers['x-wp-totalpages']||1))break;}}
 const urls=await sitemap(origin+'/sitemap.xml');inventory[site].sitemap=[...urls];
 for(const pathname of core[site])urls.push({url:origin+pathname,modified:'',sitemap:'RESEARCH.md core list'});
 for(const entry of urls){if(!entry.url)continue;const u=new URL(entry.url);if(u.origin!==origin||u.pathname.startsWith('/en/'))continue;const k=canonical(entry.url);if(!records.has(k)){const isCore=core[site].some(p=>canonical(origin+p)===k);const bits=u.pathname.split('/').filter(Boolean);const type=isCore?'pages':bits[0]||'pages';if(!isCore&&!wanted[site].includes(type)&&!['exhibition','production','column'].includes(type))continue;records.set(k,{id:null,site,type,slug:bits.at(-1)||'home',link:entry.url,title:'',content_html:'',modified:entry.modified,_source:'sitemap',_source_url:entry.sitemap});}}
 let n=0;
 for(const d of records.values()){
 const isCore=core[site].some(p=>canonical(origin+p)===canonical(d.link));d.phase=isCore?1:(['topics','client','exhibition','production'].includes(d.type)?3:2);
 try{if(d._source==='sitemap'||isCore||!visible(d.content_html).trim()){
 const r=await get(d.link);if(r.status!==200)throw Error('HTTP '+r.status);const main=mainContent(r.text,site);d.content_html=main;d._content_origin='rendered-main';d._rendered_evidence='evidence/http/'+hash(d.link)+'.txt';
 const title=r.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);if(!d.title)d.title=decode(title?.[1]||'');d.id??=Number(r.text.match(/\b(?:postid|page-id)-(\d+)/)?.[1])||null;
 if(d.type==='client'){const body=elements(main).find(e=>/class=["'][^"']*\bwp_block-content\b/.test(e.open));d._logo_only=!!body&&!visible(main.slice(body.innerStart,body.innerEnd)).trim();}
 }else d._content_origin='REST post_content';
 d._fetched_at=new Date().toISOString();d._source_hash=hash(d.title+'\n'+d.content_html);
 const slug=d.type==='pages'?(new URL(d.link).pathname.split('/').filter(Boolean).join('--')||'home'):(String(d.id||d.slug));const file='source/'+site+'/'+d.type+'/'+slug+'.ja.json';write(file,d);
 rows.push({site,type:d.type,ja_id:d.id,ja_url:d.link,source_file:file,en_path_planned:'/en'+(new URL(d.link).pathname==='/'?'/':new URL(d.link).pathname),en_file:'en/'+site+'/'+d.type+'/'+slug+'.en.json',phase:d.phase,status:d._logo_only?'skipped':'failed',reason:d._logo_only?'本文領域 wp_block-content は空。ロゴ／顧客名のみのため翻訳対象外。':'translation_not_run'});
 }catch(e){failures.push({site,type:d.type,url:d.link,reason:e.message});rows.push({site,type:d.type,ja_id:d.id,ja_url:d.link,en_path_planned:'/en'+new URL(d.link).pathname,en_file:null,phase:d.phase,status:'failed',reason:'fetch: '+e.message});}
 if(++n%25===0)console.log(site,'saved',n,'/',records.size);write('MANIFEST.json',{generated:new Date().toISOString(),pages:rows});}
}
const polylang=await get('https://plugins.svn.wordpress.org/polylang/trunk/readme.txt');write('evidence/polylang-readme.txt',polylang.text);
write('evidence/inventory.json',inventory);write('evidence/fetch-failures.json',failures);rows.sort((a,b)=>a.phase-b.phase||a.site.localeCompare(b.site)||a.ja_url.localeCompare(b.ja_url));write('MANIFEST.json',{generated:new Date().toISOString(),pages:rows});console.log('COMPLETE',rows.length,'failures',failures.length);

