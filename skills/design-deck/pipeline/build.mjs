import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {dir,root,out,title,loadPages,writeJSON,config} from './runtime.mjs';
import {writeReport} from './report.mjs';
export const escapeHTML=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const settings=config();
const e=escapeHTML,br=s=>e(s).replace(/\n/g,'<br>');
export function textWarnings(p){
  const warnings=[];
  const headlineLength=Array.from(p.headline).length;
  const bodyLines=String(p.body??'').split('\n').reduce((sum,s)=>sum+Math.max(1,Math.ceil(Array.from(s).length/(p.bodyCharsPerLine??32))),0);
  if(headlineLength>14)warnings.push(`${p.id}: headline ${headlineLength}字 > 14字`);
  if(bodyLines>3)warnings.push(`${p.id}: body 推定${bodyLines}行 > 3行`);
  return {headlineLength,estimatedBodyLines:bodyLines,warnings};
}
function dataURL(f){
  const absolute=path.resolve(dir,f);const ext=path.extname(f).slice(1).toLowerCase();
  const mime={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',svg:'image/svg+xml'}[ext];
  if(!mime)throw new Error(`Unsupported image: ${f}`);
  return `data:${mime};base64,${fs.readFileSync(absolute).toString('base64')}`;
}
function resolveVisual(p){
  if(p.directVisual)return {file:p.directVisual,mode:'direct-perspective'};
  const generated=`visuals/${p.id}.png`;
  if(p.visualBrief && fs.existsSync(path.join(dir,generated)))return {file:generated,mode:'gemini'};
  if(p.fallbackPhoto)return {file:p.fallbackPhoto,mode:'fallback-original'};
  return null;
}
const header=p=>`<header class="head"><div class="kicker">${e(p.kicker)}</div><h2>${e(p.headline)}</h2><p class="body-copy">${br(p.body)}</p></header>`;
const footer=p=>`<footer class="footer"><span>${e(p.footerText??settings.title)}</span><span>${e(p.footerNote??settings.footerNote??'')}</span><b>${e(p.footerPage)}</b></footer>`;
function photo(p,v,klass='photo-panel'){
  if(!v)throw new Error(`${p.id}: visual required`);
  return `<figure class="${klass}" data-photo="true"><img src="${dataURL(v.file)}" alt="${e(p.visualAlt??'完成ブース・接客の様子')}"/><figcaption>${v.mode==='gemini'?'実写真を基にした構成イメージ':e(p.photoCaption??'実写真')}</figcaption></figure>`;
}
function table(t,klass=''){
  const cell=(value,tag)=>{const c=typeof value==='object'?value:{text:value};return `<${tag}${c.rowspan?` rowspan="${Number(c.rowspan)}"`:''}${c.colspan?` colspan="${Number(c.colspan)}"`:''}${c.class?` class="${e(c.class)}"`:''}>${br(c.text)}</${tag}>`;};
  return `<table class="table ${klass}"><thead><tr>${t.headers.map(c=>cell(c,'th')).join('')}</tr></thead><tbody>${t.rows.map((r,i)=>`<tr${klass==='events'&&i===t.rows.length-1?' class="first"':''}>${r.map(c=>cell(c,'td')).join('')}</tr>`).join('')}</tbody></table>`;
}
function svg(p){return fs.readFileSync(path.join(dir,p.svg),'utf8');}
const templates={
  cover:(p,v)=>`${photo(p,v,'coverbg')}<div class="cover-kicker kicker">${e(p.kicker)}</div><div class="cover-copy"><div class="subtitle">${e(p.subtitle)}</div><h1>${e(p.headline)}</h1><div class="deck-title">${e(p.deckTitle)}</div><p class="body-copy">${br(p.body)}</p><p class="event">${e(p.event)}</p><p class="partner">${e(p.partner)}</p><div class="badge">${e(p.badge)}</div><div class="version">${e(p.version)}</div></div>`,
  stats:(p,v)=>`${photo(p,v)}${header(p)}<div class="body premise"><div class="stats-grid">${p.stats.map(s=>`<div class="metric"><div class="metric-label">${e(s.label)}</div><strong>${e(s.value)}</strong><small>${e(s.unit)}</small></div>`).join('')}</div><div class="facts">${(p.facts??[]).map(([k,t])=>`<div><b>${e(k)}</b><span>${e(t)}</span></div>`).join('')}</div>${p.booth?.length?`<div class="boothsum">${p.booth.map(t=>`<div>${e(t)}</div>`).join('')}</div>`:''}<div class="costbox"><b>${e(p.cost)}</b><p>${e(p.costNote)}</p></div></div>`,
  timeline:p=>`${header(p)}<div class="body standalone-timeline">${p.timeline.map(x=>`<div class="time"><b>${e(x.date??x[0])}</b><span>${e(x.text??x[1])}</span></div>`).join('')}</div>`,
  compare:p=>`${header(p)}<div class="body compare-columns">${p.columns.map(x=>`<article><h3>${e(x.title)}</h3><div class="metric"><strong>${e(x.value??'')}</strong><small>${e(x.unit??'')}</small></div>${(x.items??[]).map(i=>`<p>${e(i)}</p>`).join('')}</article>`).join('')}</div>`,
  visual:(p,v)=>`${photo(p,v)}${header(p)}`,
  table:p=>`${header(p)}<div class="body events-body">${table(p.table,'events')}<p class="insight">${e(p.insight)}</p></div>`,
  'layout-diagram':p=>`${header(p)}<div class="body layoutwrap"><div class="floor-wrap">${svg(p)}</div><div class="specs"><div class="metric"><div class="metric-label">${e(p.companyCount)}社プラン ／ 1社あたり</div><strong>${e(p.area)}</strong><small>㎡</small><div class="metric-foot">約${e(p.area)}㎡ / 社 ｜ 正面幅 約${e(p.frontWidth)}m</div></div><div class="spec"><h3>各社のスペース</h3><p>${e(p.features)}</p></div><div class="spec"><h3>共有スペース</h3><p>${e(p.shared)}</p></div><p class="note">※${e(p.note)}</p></div></div>`,
  perspective:(p,v)=>{
    const c=p.crop;
    return `${header(p)}<div class="persp-points">${(p.points??[]).map((t,i)=>`<div><span class="point-index">0${i+1}</span><p>${br(t)}</p></div>`).join('')}<p class="note">※${e(p.note)}</p></div><figure class="perspective" data-photo="true" style="--crop-ratio:${c.width}/${c.height}"><div class="crop" style="aspect-ratio:${c.width}/${c.height}"><img src="${dataURL(v.file)}" alt="社長提供の完成イメージ案" style="width:${c.sourceWidth/c.width*100}%;left:${-c.x/c.width*100}%;top:${-c.y/c.height*100}%"/></div></figure>`;
  },
  'leads-chart':(p,v)=>`${photo(p,v)}${header(p)}<div class="body leads"><h3>3日間の名刺獲得見込み</h3><div class="chartbox">${svg(p)}</div><p class="note chart-note">※${e(p.chartNote)}</p><h3>各社が選べる名刺リスト</h3>${table(p.table,'leadtable')}<p class="note pool-note">＊${e(p.poolNote)}</p><div class="methods">${p.methods.map(t=>`<div>${e(t)}</div>`).join('')}</div><p class="reason">${e(p.reason)}</p></div>`,
  'finance-table':p=>`${header(p)}<div class="body fin">${table(p.table,'finance')}<div class="formulas">${p.formulas.map(f=>`<div class="formula"><h3>${e(f.label)}</h3>${f.lines.map(l=>`<p>${e(l)}</p>`).join('')}</div>`).join('')}</div><p class="finance-note"><b>注記：</b>${e(p.note)}</p></div>`,
  'roles-timeline':(p,v)=>`${photo(p,v,'photo-panel rolecuts')}${header(p)}<div class="body roles-body"><div class="roles">${p.roles.map(r=>`<div class="role"><h3>${e(r.name)}</h3>${r.items.map(t=>`<p>${e(t)}</p>`).join('')}</div>`).join('')}</div><div class="timeline">${p.timeline.map(([d,t])=>`<div class="time"><b>${e(d)}</b><span>${e(t)}</span></div>`).join('')}</div><h3 class="next-label">次のアクション</h3><div class="actions">${p.actions.map((t,i)=>`<div class="action"><b>0${i+1}</b><span>${e(t)}</span></div>`).join('')}</div></div>`
};
export function buildHTML(pages){
  const checks=[];
  const slides=pages.map(p=>{
    const template=templates[p.type];if(!template)throw new Error(`Unsupported type: ${p.type}`);
    const v=resolveVisual(p);const check={id:p.id,type:p.type,...textWarnings(p),visual:v};checks.push(check);
    for(const w of check.warnings)console.warn(`WARNING ${w}`);
    if(v?.mode==='fallback-original')console.warn(`VISUAL ${p.id}: 実写真フォールバック ${v.file}`);
    return `<section class="slide ${e(p.type)} ${p.type==='perspective'&&p.crop.width<p.crop.height?'perspective-portrait':''} ${v&&p.type!=='cover'&&p.type!=='perspective'?'split':''}" id="${e(p.id)}" data-type="${e(p.type)}">${template(p,v)}${footer(p)}</section>`;
  }).join('\n');
  const css=fs.readFileSync(path.join(dir,'styles.css'),'utf8');
  return {html:`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${css}</style></head><body><main class="deck">${slides}</main></body></html>`,checks};
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.join(dir,'build.mjs')){
  fs.mkdirSync(out,{recursive:true});
  const pages=loadPages();const {html,checks}=buildHTML(pages);
  const htmlPath=path.join(out,`${title}.html`),pdfPath=path.join(out,`${title}.pdf`);
  fs.writeFileSync(htmlPath,html);
  writeJSON(path.join(out,'build-checks.json'),{builtAt:new Date().toISOString(),pages:checks,warnings:checks.flatMap(c=>c.warnings)});
  const result=spawnSync(process.execPath,[settings.htmlToPdf,htmlPath,pdfPath],{stdio:'inherit',cwd:root});
  if(result.status!==0)throw new Error(`html-to-pdf failed: ${result.error?.message??result.status}`);
  const pdf=fs.readFileSync(pdfPath);
  const pageCount=(pdf.toString('latin1').match(/\/Type\s*\/Page\b/g)??[]).length;
  if(pdf.subarray(0,5).toString()!=='%PDF-'||pageCount!==pages.length)throw new Error(`PDF verification failed: ${pageCount} pages`);
  writeJSON(path.join(out,'pdf-info.json'),{pageCount,bytes:pdf.length,cssSize:[1600,900],mediaBoxes:[...new Set(pdf.toString('latin1').match(/\/MediaBox\s*\[[^\]]+\]/g))]});
  writeReport();
  console.log(`BUILD OK: ${pageCount} pages, ${pdf.length} bytes, ${checks.flatMap(c=>c.warnings).length} text warnings`);
}
