import fs from 'node:fs';
import path from 'node:path';
import {dir,imageElements} from './runtime.mjs';

const nonempty=value=>typeof value==='string'&&value.trim().length>0;
export function resolveVisual(p){
  if(nonempty(p.directVisual))return {file:p.directVisual,mode:'direct-perspective'};
  const generated=`visuals/${p.id}.png`;
  if(nonempty(p.visualBrief)&&fs.existsSync(path.join(dir,generated)))return {file:generated,mode:'gemini'};
  if(nonempty(p.fallbackPhoto))return {file:p.fallbackPhoto,mode:'fallback-original'};
  const element=imageElements(p).find(element=>nonempty(element.src));
  return element?{file:element.src,mode:'image-element'}:null;
}
// All page types, including covers and company profiles, use the same gate.
// A brief declares an image, but build/report also require its generated file or fallback.
export function missingImagePages(pages){
  return pages.flatMap((p,index)=>{
    const declared=[p.directVisual,p.fallbackPhoto,p.visualBrief,...imageElements(p).map(element=>element.src)].some(nonempty);
    const visual=resolveVisual(p);
    const available=visual&&fs.existsSync(path.resolve(dir,visual.file));
    if(declared&&available)return [];
    return [{id:p.id,name:p.headline||p.name||p.id||`ページ${index+1}`,reason:declared?'画像未生成・参照ファイルなし':'画像指定なし'}];
  });
}
export const imageErrorMessage=missing=>`画像なしページ: ${missing.length}件\n${missing.map(p=>`${p.id}: ${p.name}（${p.reason}）`).join('\n')}`;
export function assertPageImages(pages){
  const missing=missingImagePages(pages);
  if(missing.length)throw new Error(imageErrorMessage(missing));
}
