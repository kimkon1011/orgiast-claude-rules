import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
const out=new URL('./',import.meta.url);
const result={attempt:'X-0018-07',time:new Date().toISOString(),revision:'9d0dd65a4a19110c8d34a4e3b483561243548f5c',node:process.version,command:'LD_LIBRARY_PATH=/tmp/x0018-libs/root/usr/lib/x86_64-linux-gnu PLAYWRIGHT_BROWSERS_PATH=/tmp/x0018-browsers node outputs/X-0018/browser-07.mjs',scope:'公開ギャラリーのフッターメニュー→About→WorksのGETナビゲーションのみ。vibe-testingではない。フォーム入力・送信なし。',observations:[],blocked:[]};
let browser;
try {
 browser=await chromium.launch({headless:true});result.browser=browser.version();
 const context=await browser.newContext({viewport:{width:1280,height:900}});
 await context.route('**/*',async route=>{const r=route.request();if(!['GET','HEAD','OPTIONS'].includes(r.method())){result.blocked.push({method:r.method(),url:r.url()});await route.abort();}else await route.continue();});
 const page=await context.newPage();page.setDefaultTimeout(15000);
 const observe=async(name)=>{await page.waitForLoadState('load',{timeout:30000});await page.waitForTimeout(2000);await page.evaluate(async()=>{for(let y=0;y<document.body.scrollHeight;y+=700){window.scrollTo(0,y);await new Promise(r=>setTimeout(r,100));}window.scrollTo(0,0);});await page.waitForTimeout(1000);const item={name,url:page.url(),title:await page.title(),bodyLength:(await page.locator('body').innerText()).length};await page.screenshot({path:new URL(name+'.png',out).pathname,fullPage:true});item.screenshot=name+'.png';result.observations.push(item);return item;};
 await page.goto('https://rebooth.co.jp/works-top/',{waitUntil:'domcontentloaded',timeout:45000});
 await observe('menu-start-07');
 result.controls=await page.locator('[class*="drawer"],button').evaluateAll(es=>es.map(e=>({tag:e.tagName,cls:e.className,text:e.innerText.slice(0,100)})));
 const menu=page.locator('footer .menu a[href="https://rebooth.co.jp/about/"]');
 result.menuSource={selector:'footer .menu a[href="https://rebooth.co.jp/about/"]',text:await menu.innerText(),href:await menu.getAttribute('href')};
 await Promise.all([page.waitForURL('https://rebooth.co.jp/about/'),menu.click()]);
 const about=await observe('menu-about-07');
 if(about.bodyLength<100||!await page.locator('h1').count())throw Error('Aboutの本文または見出し不足');
 result.aboutHeading=await page.locator('h1').allTextContents();
 const works=page.locator('footer .menu a[href="https://rebooth.co.jp/works-top/"]');
 await Promise.all([page.waitForURL('https://rebooth.co.jp/works-top/'),works.click()]);
 const returned=await observe('menu-works-07');
 if(returned.bodyLength<100||!await page.locator('a[href*="/works/"] img').count())throw Error('一覧内容不足');
 result.status='partial_pass';result.unexecuted=['ドロワーメニュー/モバイル','問い合わせ必須/不正/正常入力/安全な送信完了','vibe-testing init','正式ソース照合','C5'];
}catch(e){result.status='failed';result.error=String(e);}
finally{if(browser)await browser.close();await fs.writeFile(new URL('browser-07.json',out),JSON.stringify(result,null,2)+'\n');}
const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
await fs.writeFile(new URL('browser-07.html',out),'<!doctype html><html lang="ja"><meta charset="utf-8"><title>X-0018-07 読取検証</title><h1>公開ギャラリー読取検証（部分）</h1><pre>'+esc(JSON.stringify(result,null,2))+'</pre>'+result.observations.map(o=>'<h2>'+esc(o.name)+'</h2><img style="max-width:100%" src="'+esc(o.screenshot)+'">').join('')+'</html>');
console.log(JSON.stringify(result,null,2));

if(result.status==='failed')process.exitCode=1;
