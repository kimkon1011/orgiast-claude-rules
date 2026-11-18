import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const read = f => JSON.parse(fs.readFileSync(path.resolve(ROOT, f), 'utf8'));
export function write(f, value) { const dest=path.resolve(ROOT,f); fs.mkdirSync(path.dirname(dest),{recursive:true}); fs.writeFileSync(dest, typeof value==='string'?value:JSON.stringify(value,null,2)+'\n'); }
export const hash = s => crypto.createHash('sha256').update(s).digest('hex');
export const hasJa = s => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(s);
export const REPRESENTATIVE = '金功勇 (Representative Director & President)';
export function requiredTranslation(ja){if(/金\s*功勇/.test(ja)&&ja.length<100&&!/[。！？]/.test(ja))return (/管理部/.test(ja)?'Management Department: ':'')+REPRESENTATIVE;if(/^株式会社オージャスト$/.test(ja))return 'Orgiast Co., Ltd.';return null;}
export const decode = s => s.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m,x)=> x[0]==='#'?String.fromCodePoint(x[1].toLowerCase()==='x'?parseInt(x.slice(2),16):Number(x.slice(1))):({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '})[x.toLowerCase()]);
export const escape = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
export function tokens(html) { return [...html.matchAll(/<!--[\s\S]*?-->|<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>|<\/?[a-zA-Z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>|<![^>]*>|[^<]+|</gi)].map(m=>({raw:m[0],index:m.index})); }
export function elements(html) {
 const out=[], stack=[], voids=new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
 for(const t of tokens(html)){ const m=t.raw.match(/^<(\/?)([\w-]+)\b/i); if(!m||/^(script|style|noscript)$/i.test(m[2]))continue; const tag=m[2].toLowerCase();
 if(m[1]){let i=stack.length-1;while(i>=0&&stack[i].tag!==tag)i--;if(i>=0){const e=stack[i];e.end=t.index+t.raw.length;e.innerEnd=t.index;out.push(e);stack.splice(i,1);}}
 else {const e={tag,start:t.index,open:t.raw,innerStart:t.index+t.raw.length,end:t.index+t.raw.length};if(voids.has(tag)||/\/>$/.test(t.raw))out.push(e);else stack.push(e);}}
 return out.sort((a,b)=>a.start-b.start);
}
export function mainContent(html,site){const els=elements(html); const e=(site==='orgiast'?els.find(e=>/\bid=["']contentsArea["']/i.test(e.open)):null)||els.find(e=>e.tag==='main'); if(e)return html.slice(e.start,e.end);const header=els.find(e=>e.tag==='header'),footer=els.find(e=>e.tag==='footer');if(header&&footer&&footer.start>header.end)return html.slice(header.end,footer.start);throw Error('Main content container not found');}
export function segments(html) {const out=[];for(const t of tokens(html)){
 if(t.raw.startsWith('<')){if(/^<(script|style|noscript)\b|^<!--/i.test(t.raw))continue;const re=/\b(alt|title|placeholder|aria-label)\s*=\s*(["'])([\s\S]*?)\2/gi;for(const m of t.raw.matchAll(re)){const offset=m[0].indexOf(m[2])+1;const text=decode(m[3]).trim();if(text)out.push({start:t.index+m.index+offset,end:t.index+m.index+offset+m[3].length,text,attribute:m[1]});}
 if(/^<input\b/i.test(t.raw)&&/\btype=["'](?:submit|button)["']/i.test(t.raw)){const m=t.raw.match(/\bvalue\s*=\s*(["'])(.*?)\1/i);if(m)out.push({start:t.index+m.index+m[0].indexOf(m[1])+1,end:t.index+m.index+m[0].indexOf(m[1])+1+m[2].length,text:decode(m[2]).trim(),attribute:'value'});}}
 else {const text=decode(t.raw).trim();if(text){const lead=t.raw.length-t.raw.trimStart().length,trail=t.raw.length-t.raw.trimEnd().length;out.push({start:t.index+lead,end:t.index+t.raw.length-trail,text});}}}return out;}
export const visible = html => segments(html).map(s=>s.text).join(' ');
export function applySegments(html,translations){const ss=segments(html);for(const s of ss.reverse()){const en=translations.get(s.text);if(en!==undefined)html=html.slice(0,s.start)+escape(en)+html.slice(s.end);}return html;}
export function walk(dir,suffix='.json'){if(!fs.existsSync(dir))return [];return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name),suffix):e.name.endsWith(suffix)?[path.join(dir,e.name)]:[]);}
export const canonical = url => {const u=new URL(url);return u.origin+u.pathname.replace(/\/$/,'');};
export const core = {rebooth:['/','/about/','/why-choose-us/','/why-choose-us/design-quality/','/why-choose-us/reuse/','/why-choose-us/reduces-costs/','/works-top/','/news/','/column/','/company/','/contact/','/thanks/','/privacy-policy/'],orgiast:['/','/company','/services','/services/flow','/contactus','/contactform-complete','/policy','/clients','/recruiting','/event','/creative','/newsrelease','/interview']};
