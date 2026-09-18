import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {dir,out,loadPages,writeJSON,config} from './runtime.mjs';
const settings=config();
export const escapeHTML=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const e=escapeHTML,br=s=>e(s).replace(/\n/g,'<br>');
export function textWarnings(page){
  const headlineLength=Array.from(page.headline??'').length;
  const estimatedBodyLines=String(page.body??'').split('\n').reduce((n,s)=>n+Math.max(1,Math.ceil(Array.from(s).length/(page.bodyCharsPerLine??32))),0);
  const warnings=[];
  if(headlineLength>14)warnings.push(`${page.id}: headline ${headlineLength}字 > 14字`);
  if(estimatedBodyLines>3)warnings.push(`${page.id}: body 推定${estimatedBodyLines}行 > 3行`);
  return {headlineLength,estimatedBodyLines,warnings};
}
function dataURL(file){
  const absolute=path.resolve(dir,file),ext=path.extname(file).slice(1).toLowerCase();
  const mime={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',svg:'image/svg+xml'}[ext];
  if(!mime)throw new Error(`Unsupported image: ${file}`);
  return `data:${mime};base64,${fs.readFileSync(absolute).toString('base64')}`;
}
function visual(page){
  if(page.directVisual)return {file:page.directVisual,mode:'direct'};
  const generated=`visuals/${page.id}.png`;
  if(page.visualBrief&&fs.existsSync(path.join(dir,generated)))return {file:generated,mode:'gemini'};
  if(page.fallbackPhoto)return {file:page.fallbackPhoto,mode:'fallback'};
  return null;
}
const header=p=>`<header><div class="kicker">${e(p.kicker)}</div><h2>${e(p.headline)}</h2><p class="body-copy">${br(p.body)}</p></header>`;
const footer=p=>`<footer><span>${e(p.footerText??settings.title)}</span><b>${e(p.footerPage)}</b></footer>`;
const photo=(p,v,klass='photo')=>`<figure class="${klass}" data-photo><img src="${dataURL(v.file)}" alt="${e(p.visualAlt??'写真ビジュアル')}"><figcaption>${v.mode==='gemini'?'実写真を基にした構成イメージ':''}</figcaption></figure>`;
const cell=(c,tag)=>`<${tag}>${br(typeof c==='object'?c.text:c)}</${tag}>`;
const table=t=>`<table><thead><tr>${t.headers.map(c=>cell(c,'th')).join('')}</tr></thead><tbody>${t.rows.map(r=>`<tr>${r.map(c=>cell(c,'td')).join('')}</tr>`).join('')}</tbody></table>`;
const templates={
  cover:(p,v)=>`${photo(p,v,'photo cover-photo')}<div class="cover-copy"><div class="kicker">${e(p.kicker)}</div><p>${e(p.subtitle)}</p><h1>${e(p.headline)}</h1><p class="body-copy">${br(p.body)}</p></div>`,
  stats:(p,v)=>`${photo(p,v)}${header(p)}<div class="content metrics">${p.stats.map(s=>`<div><strong>${e(s.value)}</strong><small>${e(s.unit)}</small><p>${e(s.label)}</p></div>`).join('')}</div>`,
  visual:(p,v)=>`${photo(p,v)}${header(p)}`,
  table:p=>`${header(p)}<div class="content table-wrap">${table(p.table)}<p class="insight">${e(p.insight)}</p></div>`,
  timeline:p=>`${header(p)}<div class="content timeline">${p.timeline.map(x=>`<div><b>${e(x.date??x[0])}</b><p>${e(x.text??x[1])}</p></div>`).join('')}</div>`,
  compare:p=>`${header(p)}<div class="content compare">${p.columns.map(x=>`<article><h3>${e(x.title)}</h3><strong>${e(x.value??'')}</strong>${(x.items??[]).map(i=>`<p>${e(i)}</p>`).join('')}</article>`).join('')}</div>`,
  perspective:(p,v)=>`${header(p)}${photo(p,v,'photo perspective-photo')}<div class="points">${(p.points??[]).map(x=>`<p>${e(x)}</p>`).join('')}<small>${e(p.note)}</small></div>`
};
export function buildHTML(pages){
  const checks=[];
  const slides=pages.map(page=>{
    const render=templates[page.type];if(!render)throw new Error(`Unsupported type: ${page.type}`);
    const image=visual(page),check={id:page.id,type:page.type,...textWarnings(page),visual:image};checks.push(check);
    for(const warning of check.warnings)console.warn(`WARNING ${warning}`);
    return `<section class="slide ${e(page.type)} ${image&&page.type!=='cover'?'split':''}" id="${e(page.id)}" data-type="${e(page.type)}">${render(page,image)}${footer(page)}</section>`;
  }).join('\n');
  const css=fs.readFileSync(path.join(dir,'styles.css'),'utf8');
  return {html:`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${e(settings.title)}</title><style>${css}</style></head><body><main>${slides}</main></body></html>`,checks};
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.join(dir,'build.mjs')){
  fs.mkdirSync(out,{recursive:true});
  const pages=loadPages(),{html,checks}=buildHTML(pages);
  const htmlPath=path.join(out,`${settings.title}.html`),pdfPath=path.join(out,`${settings.title}.pdf`);
  fs.writeFileSync(htmlPath,html);writeJSON(path.join(out,'build-checks.json'),{pages:checks,warnings:checks.flatMap(x=>x.warnings)});
  const result=spawnSync(process.execPath,[settings.htmlToPdf,htmlPath,pdfPath],{stdio:'inherit'});
  if(result.status!==0)throw new Error(`html-to-pdf failed: ${result.error?.message??result.status}`);
  console.log(`BUILD OK: ${pages.length} pages, ${checks.flatMap(x=>x.warnings).length} warnings`);
}
