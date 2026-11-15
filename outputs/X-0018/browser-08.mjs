import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
const out=new URL('./',import.meta.url);
const result={attempt:'X-0018-08',time:new Date().toISOString(),revision:'9d0dd65a4a19110c8d34a4e3b483561243548f5c',node:process.version,command:'LD_LIBRARY_PATH=/tmp/x0018-libs/root/usr/lib/x86_64-linux-gnu PLAYWRIGHT_BROWSERS_PATH=/tmp/x0018-browsers node outputs/X-0018/browser-08.mjs',scope:'公開ギャラリーのモバイルドロワー開閉とWorksへのGET遷移のみ。vibe-testingではない。フォーム入力・送信なし。',observations:[],blocked:[]};
let browser;
try {
 browser=await chromium.launch({headless:true});result.browser=browser.version();
 const context=await browser.newContext({viewport:{width:390,height:844}});
 await context.route('**/*',async route=>{const r=route.request();if(!['GET','HEAD','OPTIONS'].includes(r.method())){result.blocked.push({method:r.method(),url:r.url()});await route.abort();}else await route.continue();});
 const page=await context.newPage();page.setDefaultTimeout(15000);
 const observe=async(name)=>{await page.waitForLoadState('load',{timeout:30000});await page.waitForTimeout(2000);await page.evaluate(async()=>{for(let y=0;y<document.body.scrollHeight;y+=700){window.scrollTo(0,y);await new Promise(r=>setTimeout(r,100));}window.scrollTo(0,0);});await page.waitForTimeout(1000);const item={name,url:page.url(),title:await page.title(),bodyLength:(await page.locator('body').innerText()).length};await page.screenshot({path:new URL(name+'.png',out).pathname,fullPage:true});item.screenshot=name+'.png';result.observations.push(item);return item;};
 await page.goto('https://rebooth.co.jp/about/',{waitUntil:'domcontentloaded',timeout:45000});
 await observe('drawer-start-08');
 const toggle=page.locator('.c-drawer-toggle.js-toggle');
 result.before=await toggle.evaluate(e=>({html:e.outerHTML,parent:e.parentElement.outerHTML.slice(0,12000)}));
 await toggle.click();
 await page.waitForTimeout(800);
 result.open=await page.locator('[class*="drawer"]').evaluateAll(es=>es.map(e=>({cls:e.className,html:e.outerHTML.slice(0,15000)})));
 const links=page.locator('[class*="drawer"] a[href="https://rebooth.co.jp/works-top/"]');
 let target;
 for(let i=0;i<await links.count();i++){if(await links.nth(i).isVisible()){target=links.nth(i);break;}}
 if(!target)throw Error('開いたドロワーに可視Worksリンクなし');
 await observe('drawer-open-08');
 await toggle.click();await page.waitForTimeout(800);
 result.closed=await target.isVisible();
 if(result.closed)throw Error('閉じた後もドロワーWorksリンクが可視');
 await observe('drawer-closed-08');
 await toggle.click();await page.waitForTimeout(800);
 if(!await target.isVisible())throw Error('再度開いたドロワーWorksリンクが不可視');
 await Promise.all([page.waitForURL('https://rebooth.co.jp/works-top/'),target.click()]);
 const works=await observe('drawer-works-08');
 if(works.bodyLength<100||!await page.locator('a[href*="/works/"] img').count())throw Error('遷移後の一覧内容不足');
 result.assertions={openVisible:true,closedHidden:true,reopenedVisible:true,worksURL:page.url(),galleryImageCount:await page.locator('a[href*="/works/"] img').count()};
 result.status='partial_pass';result.unexecuted=['問い合わせ必須/不正/正常入力/安全な送信完了','vibe-testing init','正式ソース照合','C5'];
}catch(e){result.status='failed';result.error=String(e);}
finally{if(browser)await browser.close();await fs.writeFile(new URL('browser-08.json',out),JSON.stringify(result,null,2)+'\n');}
const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
await fs.writeFile(new URL('browser-08.html',out),'<!doctype html><html lang="ja"><meta charset="utf-8"><title>X-0018-08 読取検証</title><h1>公開ギャラリー読取検証（部分）</h1><pre>'+esc(JSON.stringify(result,null,2))+'</pre>'+result.observations.map(o=>'<h2>'+esc(o.name)+'</h2><img style="max-width:100%" src="'+esc(o.screenshot)+'">').join('')+'</html>');
console.log(JSON.stringify(result,null,2));

if(result.status==='failed')process.exitCode=1;
