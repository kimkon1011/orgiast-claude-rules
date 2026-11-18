import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {ROOT,write,read} from './lib.mjs';
import {SITES} from './static-core.mjs';
const require=createRequire(import.meta.url);
let chromium;
try{({chromium}=require('playwright-core'));}catch{({chromium}=require('C:/Users/USER/.claude/nightly-repo/node_modules/playwright-core'));}
const browser=await chromium.launch({channel:'chrome',headless:true});
const siteArg=process.argv.includes('--site')?process.argv[process.argv.indexOf('--site')+1]:null;
const rows=fs.existsSync(path.join(ROOT,'evidence/screens/results.json'))?read('evidence/screens/results.json').filter(r=>siteArg&&r.site!==siteArg):[];fs.mkdirSync(path.join(ROOT,'evidence/screens'),{recursive:true});
try{
 for(const [site,origin]of Object.entries(SITES).filter(([site])=>!siteArg||site===siteArg))for(const width of [1440,390]){
  const context=await browser.newContext({viewport:{width,height:900},deviceScaleFactor:1,isMobile:width===390,hasTouch:width===390});
  // Read-only inspection: no contact submissions or other POST requests.
  await context.route('**/*',route=>['GET','HEAD'].includes(route.request().method())?route.continue():route.abort());
  const page=await context.newPage(),errors=[],failedRequests=[];page.on('pageerror',e=>errors.push(e.message));page.on('requestfailed',r=>{if(r.method()==='GET')failedRequests.push({url:r.url(),error:r.failure()?.errorText});});
  const response=await page.goto(origin+'/en/',{waitUntil:'load',timeout:60000});
  await page.waitForTimeout(2000);
  await page.evaluate(async()=>{await document.fonts.ready;for(let y=0;y<document.body.scrollHeight;y+=600){window.scrollTo({top:y,behavior:'instant'});await new Promise(r=>setTimeout(r,500));}window.scrollTo({top:0,behavior:'instant'});});
  await page.waitForTimeout(2000);
  const file=`evidence/screens/${site}-${width}.png`;
  await page.screenshot({path:path.join(ROOT,file),fullPage:true});
  rows.push({site,width,url:origin+'/en/',status:response.status(),file,errors,failedRequests,...await page.evaluate(()=>({lang:document.documentElement.lang,noindex:document.querySelector('meta[name="robots"]')?.content,viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight,stylesheets:[...document.styleSheets].map(s=>s.href),images:{total:document.images.length,loaded:[...document.images].filter(i=>i.complete&&i.naturalWidth>0).length,unloaded:[...document.images].filter(i=>!i.complete||!i.naturalWidth).map(i=>({src:i.getAttribute('src'),dataSrc:i.getAttribute('data-src'),loading:i.loading}))}}))});
  console.log(JSON.stringify(rows.at(-1)));await context.close();
 }
}finally{await browser.close();}
write('evidence/screens/results.json',rows);
