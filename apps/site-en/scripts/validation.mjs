import {visible,segments,tokens,decode,hash,REPRESENTATIVE} from './lib.mjs';
export function numbers(text){
 text=decode(text).replace(/[①②③④⑤⑥⑦⑧⑨⑩]/g,m=>m+' ').normalize('NFKC');
 // BtoB/B2B is a business abbreviation, not a newly introduced numeric claim.
 text=text.replace(/\bBtoB\b/gi,'B2B');
 text=text.replace(/\b(Q\d+)\.(?=\d)/gi,'$1. ');
 const raw=text.match(/(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g)||[];
 const out=raw.map(n=>n.replace(/,/g,'').replace(/^0+(?=\d)/,''));
 // Add the complete value of compound Japanese large units (e.g. 4億1,900万).
 for(const m of text.matchAll(/(?:\d[\d,]*(?:\.\d+)?[兆億万])+(?:\d[\d,]*)?/g)){
  let total=0;for(const p of m[0].matchAll(/(\d[\d,]*(?:\.\d+)?)([兆億万]?)/g))total+=Number(p[1].replace(/,/g,''))*({'兆':1e12,'億':1e8,'万':1e4,'':1}[p[2]]);
  out.push(String(total));
 }
 for(const m of text.matchAll(/(\d+)万([\d,]+)(?![\d,千百十])/g))out.push(String(Number(m[1])*10000+Number(m[2].replace(/,/g,''))));
 // A shared Japanese unit applies to both ends of a numeric range (30〜55万円).
 for(const m of text.matchAll(/(\d+(?:[,.]\d+)*)\s*[〜～~–—-]\s*(\d+(?:[,.]\d+)*)\s*(億|万)/g))for(const n of [m[1],m[2]])out.push(String(Number(n.replace(/,/g,''))*({'億':1e8,'万':1e4})[m[3]]));
 // Equivalent Japanese / English scale notation; no date or phone reinterpretation.
 for(const m of text.matchAll(/(\d+(?:[,.]\d+)*)\s*(兆|億|万|割|thousand|million|billion|trillion)/gi)){
 const scale=({'兆':1e12,'億':1e8,'万':1e4,'割':10,thousand:1e3,million:1e6,billion:1e9,trillion:1e12})[m[2].toLowerCase()];
 out.push(String(Number(m[1].replace(/,/g,''))*scale));
 }return [...new Set(out)];
}
export function japanese(text,source){
 const raw=(text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu)||[]).length;
 let adjusted=text.replace(/金\s*功勇/g,'').replace(/Re:Booth\s*\(Re:ブース\)/g,'Re:Booth');
 // Japanese originals alongside romanized/translated proper names are explicitly permitted.
 adjusted=adjusted.replace(/[（(]([^()（）]{1,60})[）)]/g,(all,name)=>source.includes(name)&&!/。|！|？/.test(name)?'':all);
 const remainder=(adjusted.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu)||[]);
 return {raw,rate:raw/Math.max([...text].length,1)*100,unapproved:remainder.length,samples:[...new Set(adjusted.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu)||[])]};
}
export function textIssues(ja,en){
 const issues=[];if(typeof en!=='string'||!en.trim())return ['empty translation'];
 if(/金\s*功勇/.test(ja)&&!en.includes(REPRESENTATIVE))issues.push('representative must use exact required Japanese name and role');
 const j=japanese(en,ja);if(j.unapproved)issues.push('untranslated Japanese: '+j.samples.join(', '));
 const src=numbers(ja),dst=numbers(en);
 // A translated scale may replace its coefficient if the full quantity is equivalent.
 const extra=dst.filter(n=>!src.includes(n));
 const scaledCoefficients=[...en.normalize('NFKC').matchAll(/(\d+(?:[,.]\d+)*)\s*(thousand|million|billion|trillion)/gi)].filter(m=>src.includes(String(Number(m[1].replace(/,/g,''))*({thousand:1e3,million:1e6,billion:1e9,trillion:1e12})[m[2].toLowerCase()]))).map(m=>m[1].replace(/,/g,''));
 const trulyExtra=extra.filter(n=>!scaledCoefficients.includes(n));
 if(trulyExtra.length)issues.push('extra numbers: '+trulyExtra.join(', '));
 if(/Koyu Kim|Takayuki Kim|Takayuki Nomura/i.test(en))issues.push('unauthorized representative romanization');
 if(/<[^>]+>/.test(en)&&!/<[^>]+>/.test(ja))issues.push('HTML introduced into text');
 return issues;
}
const tagCount=(html,tag)=>(html.match(new RegExp('<'+tag+'(?:\\s|/?>)','gi'))||[]).length;
function structure(html){return tokens(html).filter(t=>t.raw.startsWith('<')).map(t=>t.raw.replace(/\b(alt|title|placeholder|aria-label)\s*=\s*(["'])([\s\S]*?)\2/gi,'$1=""').replace(/(<input\b[^>]*\btype=["'](?:submit|button)["'][^>]*\bvalue=)(["']).*?\2/gi,'$1""')).join('');}
export function validate(source,en){
 const src=visible(source.title)+' '+visible(source.content_html),dst=visible(en.title)+' '+visible(en.content_html);
 const jp=japanese(dst,src);const issues=textIssues(src,dst);
 const a=[tagCount(source.content_html,'a'),tagCount(en.content_html,'a')],img=[tagCount(source.content_html,'img'),tagCount(en.content_html,'img')];
 if(a[0]!==a[1])issues.push('a count mismatch');if(img[0]!==img[1])issues.push('img count mismatch');
 if(structure(source.content_html)!==structure(en.content_html))issues.push('HTML structure or protected attribute changed');
 if(en._source_hash!==source._source_hash)issues.push('source hash mismatch');
 return {ok:issues.length===0,japanese:jp,extra_numbers:numbers(dst).filter(n=>!numbers(src).includes(n)),a,img,issues};
}

