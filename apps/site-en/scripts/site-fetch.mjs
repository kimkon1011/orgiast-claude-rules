import {gunzipSync} from 'node:zlib';
import {decode,core,canonical} from './lib.mjs';
import {SITES,outputPath} from './static-core.mjs';
let last=0;
export async function get(url,depth=0){
 if(depth>8)throw Error('Redirect loop');
 await new Promise(r=>setTimeout(r,Math.max(0,350-(Date.now()-last))));last=Date.now();
 const r=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(45000),headers:{'User-Agent':'Orgiast-English-Static/2.0','Accept-Encoding':'identity'}});
 if(r.status>=300&&r.status<400&&r.headers.get('location'))return get(new URL(r.headers.get('location'),url).href,depth+1);
 let bytes=Buffer.from(await r.arrayBuffer());if(bytes[0]===31&&bytes[1]===139)bytes=gunzipSync(bytes);
 return {url,status:r.status,text:bytes.toString('utf8'),bytes,headers:Object.fromEntries(r.headers)};
}
const xmlText=s=>decode(s.replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g,'').trim());
export async function sitemap(url,seen=new Set()){
 if(seen.has(url))return [];seen.add(url);const r=await get(url);if(r.status!==200)throw Error('Sitemap HTTP '+r.status+' '+url);
 if(/<sitemapindex\b/i.test(r.text)){const out=[];for(const m of r.text.matchAll(/<loc>([\s\S]*?)<\/loc>/g))out.push(...await sitemap(xmlText(m[1]),seen));return out;}
 return [...r.text.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/g)].map(m=>({url:xmlText(m[1].match(/<loc>([\s\S]*?)<\/loc>/)?.[1]||''),lastmod:xmlText(m[1].match(/<lastmod>([\s\S]*?)<\/lastmod>/)?.[1]||'')}));
}
export async function inventory(site){
 const urls=await sitemap(SITES[site]+'/sitemap.xml'),unique=new Map();
 for(const x of [...core[site].map(p=>({url:SITES[site]+p,lastmod:''})),...urls]){
  if(new URL(x.url).origin!==SITES[site])continue;try{outputPath(x.url);}catch{continue;}
  unique.set(canonical(x.url),{...x,site,phase:core[site].some(p=>canonical(SITES[site]+p)===canonical(x.url))?1:2});
 }
 return [...unique.values()].sort((a,b)=>a.phase-b.phase||a.url.localeCompare(b.url));
}
