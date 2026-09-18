import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {root,out,loadPages,writeJSON,config} from './runtime.mjs';
const settings=config(),require=createRequire(path.join(root,'package.json'));
const {chromium}=require(settings.playwright),pages=loadPages();
const browser=await chromium.launch({channel:'chrome',headless:true});
const results={createdAt:new Date().toISOString(),pages:[],issues:[]};
try{
  const page=await browser.newPage({viewport:{width:1600,height:900},deviceScaleFactor:1});
  await page.goto(pathToFileURL(path.join(out,`${settings.title}.html`)).href,{waitUntil:'networkidle'});
  await page.evaluate(()=>document.fonts.ready);
  await page.locator('img').evaluateAll(images=>Promise.all(images.map(image=>image.decode())));
  const count=await page.locator('.slide').count();
  if(count!==pages.length)throw new Error(`Expected ${pages.length} slides; got ${count}`);
  for(let index=0;index<count;index++){
    const slide=page.locator('.slide').nth(index);
    const check=await slide.evaluate(node=>{
      const frame=node.getBoundingClientRect(),footer=node.querySelector('footer').getBoundingClientRect(),issues=[];
      const copy=node.querySelector('.body-copy');let bodyLines=0;
      if(copy){const style=getComputedStyle(copy);bodyLines=Math.round(copy.getBoundingClientRect().height/parseFloat(style.lineHeight));if(bodyLines>3)issues.push(`本文実測${bodyLines}行`);}
      let area=0;const photos=[...node.querySelectorAll('[data-photo]')];
      for(const photo of photos){const box=photo.getBoundingClientRect();area+=box.width*Math.max(0,Math.min(box.bottom,footer.top)-Math.max(box.top,frame.top));const image=photo.querySelector('img');if(!image.complete||!image.naturalWidth)issues.push('画像未読込');for(let current=image;current&&current!==node;current=current.parentElement){const style=getComputedStyle(current);if(style.filter!=='none'||Number(style.opacity)<1)issues.push('写真のfilter/opacity');}}
      const ratio=area/(1600*900);if(photos.length&&ratio<.4)issues.push(`写真面積 ${(ratio*100).toFixed(1)}% < 40%`);
      for(const element of node.querySelectorAll('h1,h2,h3,p,td,th,strong')){const box=element.getBoundingClientRect();if(box.right>frame.right+.5||box.left<frame.left-.5||box.bottom>footer.top+1)issues.push(`文字切れ/フッター衝突: ${element.textContent.trim().slice(0,30)}`);}
      return {id:node.id,bodyLines,photoPercent:Number((ratio*100).toFixed(2)),issues:[...new Set(issues)]};
    });
    const file=`preview-p${String(index+1).padStart(2,'0')}.png`;await slide.screenshot({path:path.join(out,file)});
    results.pages.push({...check,file});results.issues.push(...check.issues.map(issue=>`${check.id}: ${issue}`));
  }
  writeJSON(path.join(out,'preview-checks.json'),results);
  if(results.issues.length){console.error(results.issues.join('\n'));process.exitCode=1;}else console.log(`PREVIEW OK: ${count} pages`);
}finally{await browser.close();}
