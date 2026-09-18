import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {dir,root,out,title,loadPages,writeJSON,config} from './runtime.mjs';
import {writeReport} from './report.mjs';
const settings=config();
const require=createRequire(path.join(root,'package.json'));
const {chromium}=require(settings.playwright);
const pages=loadPages();
const browser=await chromium.launch(settings.browser);
const results={createdAt:new Date().toISOString(),pages:[],issues:[],sourceTablesVerified:null};
try{
  const page=await browser.newPage({viewport:{width:1600,height:900},deviceScaleFactor:1});
  await page.goto(pathToFileURL(path.join(out,`${title}.html`)).href,{waitUntil:'networkidle'});
  await page.evaluate(()=>document.fonts.ready);
  await page.locator('img').evaluateAll(imgs=>Promise.all(imgs.map(img=>img.decode())));
  const count=await page.locator('.slide').count();if(count!==pages.length)throw new Error(`Expected ${pages.length} slides; got ${count}`);
  for(let i=0;i<count;i++){
    const slide=page.locator('.slide').nth(i);
    const check=await slide.evaluate(s=>{
      const r=s.getBoundingClientRect(),footer=s.querySelector('.footer').getBoundingClientRect();
      const issues=[];
      const body=s.querySelector('.body-copy'),bodyStyle=getComputedStyle(body);
      const bodyLines=Math.round(body.getBoundingClientRect().height/parseFloat(bodyStyle.lineHeight));
      if(bodyLines>3)issues.push(`本文実測${bodyLines}行`);
      const pictures=[...s.querySelectorAll('[data-photo]')];
      let area=0;
      for(const pic of pictures){
        const b=pic.getBoundingClientRect();
        const height=Math.max(0,Math.min(b.bottom,footer.top)-Math.max(b.top,r.top));
        area+=b.width*height;
        const image=pic.querySelector('img');
        for(let x=image;x&&x!==s;x=x.parentElement){const st=getComputedStyle(x);if(st.filter!=='none'||Number(st.opacity)<1)issues.push('写真のfilter/opacity');}
        const st=getComputedStyle(image);
        if(!image.complete||!image.naturalWidth)issues.push('画像未読込');
        const caption=pic.querySelector('figcaption');if(caption){const c=caption.getBoundingClientRect();area-=c.width*c.height;}
      }
      if(s.dataset.type==='cover'){
        for(const x of s.querySelectorAll('.cover-copy,.cover-kicker')){const b=x.getBoundingClientRect();area-=b.width*b.height;}
      }
      const photoRatio=area/(1600*900);
      if(pictures.length&&photoRatio<.4)issues.push(`写真面積 ${(photoRatio*100).toFixed(1)}% < 40%`);
      const walker=document.createTreeWalker(s,NodeFilter.SHOW_TEXT);
      let node;const overflow=[];
      while(node=walker.nextNode()){
        if(!node.textContent.trim()||node.parentElement.closest('svg,.footer,figcaption'))continue;
        const range=document.createRange();range.selectNodeContents(node);
        for(const box of range.getClientRects())if(box.right>r.right+.5||box.left<r.left-.5||box.bottom>footer.top+1||box.top<r.top-.5){overflow.push(node.textContent.trim().slice(0,55));break;}
      }
      if(overflow.length)issues.push(`文字のはみ出し/フッター重複: ${[...new Set(overflow)].join(' / ')}`);
      return {id:s.id,width:r.width,height:r.height,bodyLines,photoPercent:Number((photoRatio*100).toFixed(2)),images:pictures.length,issues};
    });
    const filename=`preview-p${String(i+1).padStart(2,'0')}.png`;
    await slide.screenshot({path:path.join(out,filename)});
    results.pages.push({...check,file:filename});results.issues.push(...check.issues.map(x=>`${check.id}: ${x}`));
    console.log(`PNG OK ${filename} | photo ${check.photoPercent}% | body ${check.bodyLines} lines`);
  }
  // Optional source-document comparison: keep the v4 cell/span fidelity check.
  if(settings.sourceHtml){
    const extract=locator=>locator.evaluateAll(tables=>tables.map(t=>[...t.rows].map(r=>[...r.cells].map(c=>({text:c.textContent.replace(/\s/g,''),rowspan:c.rowSpan,colspan:c.colSpan})))));
    const actual=await extract(page.locator('table'));
    const source=await browser.newPage();
    await source.goto(pathToFileURL(settings.sourceHtml).href);
    const original=await extract(source.locator('table'));
    results.sourceTablesVerified=JSON.stringify(actual)===JSON.stringify(original);
    if(!results.sourceTablesVerified)results.issues.push('source table cell mismatch');
  }
  const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  fs.writeFileSync(path.join(out,'preview-index.html'),`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} 全ページ</title><style>body{font-family:system-ui,sans-serif;background:#eef3f4;color:#0a2540;margin:32px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:24px}figure{margin:0}img{width:100%;display:block}figcaption{padding:12px 0;font-weight:700}a{color:inherit}</style><h1>${escape(title)}</h1><p><a href="${encodeURI(title)}.pdf">PDFを開く</a> · 画像をクリックすると原寸で開きます</p><main>${results.pages.map((r,i)=>`<figure><a href="${r.file}"><img src="${r.file}" alt="${escape(pages[i].headline)}"></a><figcaption>${String(i+1).padStart(2,'0')}　${escape(pages[i].headline)}</figcaption></figure>`).join('')}</main></html>`);
  writeJSON(path.join(out,'preview-checks.json'),results);writeReport();
  if(results.issues.length){console.error(results.issues.join('\n'));process.exitCode=1;}
}finally{await browser.close();}
