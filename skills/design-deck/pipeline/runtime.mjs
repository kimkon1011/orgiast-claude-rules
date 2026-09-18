import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const dir=path.dirname(fileURLToPath(import.meta.url));
export const root=path.resolve(dir,'..');
export const out=path.join(dir,'out');
export const readJSON=p=>JSON.parse(fs.readFileSync(p,'utf8'));
export const writeJSON=(p,data)=>fs.writeFileSync(p,JSON.stringify(data,null,2)+'\n');
export function loadPages(){
  const pages=readJSON(path.join(dir,'pages.json'));
  const ids=new Set();
  for(const page of pages){
    if(!/^[a-z0-9-]+$/.test(page.id)||ids.has(page.id))throw new Error(`Invalid/duplicate page id: ${page.id}`);
    ids.add(page.id);
    for(const file of [...(page.photoSources??[]),page.directVisual,page.fallbackPhoto,page.svg].filter(Boolean)){
      const resolved=path.resolve(dir,file);
      if(!resolved.startsWith(root+path.sep)||!fs.existsSync(resolved))throw new Error(`Missing/outside project asset: ${file}`);
    }
    if(page.type==='perspective'){
      const c=page.crop;
      if(!page.directVisual||!c||!['x','y','width','height','sourceWidth','sourceHeight'].every(k=>Number.isFinite(c[k]))||c.x<0||c.y<0||c.width<=0||c.height<=0||c.sourceWidth<=0||c.sourceHeight<=0||c.x+c.width>c.sourceWidth||c.y+c.height>c.sourceHeight)throw new Error(`${page.id}: directVisual と元画像内の crop 座標が必要`);
    }
    if(page.type==='perspective'&&page.visualBrief)throw new Error(`${page.id}: 社長パースのGemini加工は禁止`);
  }
  return pages;
}
export function config(){
  const file=path.join(dir,'deck.config.json');
  const value=fs.existsSync(file)?readJSON(file):{};
  const local=(candidate,fallback)=>candidate?path.resolve(dir,candidate):fallback;
  return {title:value.title??'企画書',genImage:local(value.genImage,path.join(root,'gen-image.mjs')),htmlToPdf:local(value.htmlToPdf,path.join(root,'html-to-pdf.mjs')),playwright:value.playwright??'playwright-core',browser:value.browser??{channel:'chrome',headless:true},sourceHtml:value.sourceHtml?path.resolve(dir,value.sourceHtml):null,footerNote:value.footerNote??''};
}

export const title=config().title;
