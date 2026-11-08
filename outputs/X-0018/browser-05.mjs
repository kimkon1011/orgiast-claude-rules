import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
const out=new URL('./',import.meta.url);
const result={attempt:'X-0018-05',time:new Date().toISOString(),revision:'9d0dd65a4a19110c8d34a4e3b483561243548f5c',node:process.version,command:'PLAYWRIGHT_BROWSERS_PATH=/tmp/x0018-browsers node outputs/X-0018/browser-05.mjs',scope:'公開ギャラリーのGETナビゲーションのみ。vibe-testingではない。フォーム入力・送信なし。',observations:[],blocked:[]};
let browser;
try {
 browser=await chromium.launch({headless:true});result.browser=browser.version();
 const context=await browser.newContext({viewport:{width:1280,height:900}});
 await context.route('**/*',async route=>{const r=route.request();if(!['GET','HEAD','OPTIONS'].includes(r.method())){result.blocked.push({method:r.method(),url:r.url()});await route.abort();}else await route.continue();});
 const page=await context.newPage();page.setDefaultTimeout(15000);
 const observe=async(name)=>{const item={name,url:page.url(),title:await page.title(),bodyLength:(await page.locator('body').innerText()).length};await page.screenshot({path:new URL(name+'.png',out).pathname,fullPage:true});item.screenshot=name+'.png';result.observations.push(item);return item;};
 await page.goto('https://rebooth.co.jp/works-top/',{waitUntil:'domcontentloaded',timeout:45000});
 const list=await observe('gallery-list-05');if(list.bodyLength<100)throw Error('一覧DOM不足');
 const link=page.locator('a[href*="/works/"]').filter({has:page.locator('img')}).first();
 const href=await link.getAttribute('href');result.detailLink=href;
 await Promise.all([page.waitForURL(url=>url.pathname.startsWith('/works/')&&url.pathname!='/works/'),link.click()]);
 const detail=await observe('gallery-detail-05');if(detail.bodyLength<100)throw Error('詳細DOM不足');
 await page.goBack({waitUntil:'domcontentloaded'});const back=await observe('gallery-back-05');
 if(new URL(back.url).pathname!='/works-top/')throw Error('一覧へ戻れない');
 result.status='partial_pass';result.unexecuted=['メニュー遷移','問い合わせ必須/不正/正常入力/安全な送信完了','vibe-testing init','正式ソース照合','C5'];
}catch(e){result.status='failed';result.error=String(e);}
finally{if(browser)await browser.close();await fs.writeFile(new URL('browser-05.json',out),JSON.stringify(result,null,2)+'\n');}
const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
await fs.writeFile(new URL('browser-05.html',out),'<!doctype html><html lang="ja"><meta charset="utf-8"><title>X-0018-05 読取検証</title><h1>公開ギャラリー読取検証（部分）</h1><pre>'+esc(JSON.stringify(result,null,2))+'</pre>'+result.observations.map(o=>'<h2>'+esc(o.name)+'</h2><img style="max-width:100%" src="'+esc(o.screenshot)+'">').join('')+'</html>');
console.log(JSON.stringify(result,null,2));

if(result.status==='failed')process.exitCode=1;
