const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true});
 for(const [name,url] of [['engage','https://en-gage.net/company_login/login/'],['airwork','https://ats.rct.airwork.net/dashboards']]){
  const page=await browser.newPage();
  try{await page.goto(url,{waitUntil:'domcontentloaded',timeout:45000}); await page.waitForTimeout(2500);
   console.log(JSON.stringify({name,url:page.url(),text:(await page.locator('body').innerText()).slice(0,5000),inputs:await page.locator('input').evaluateAll(es=>es.map(e=>({name:e.name,type:e.type,id:e.id,placeholder:e.placeholder}))),buttons:await page.locator('button').allTextContents()}));
  }catch(e){console.log(name,e.message)}
  await page.close();
 }
 await browser.close();
})().catch(e=>{console.error(e.message);process.exitCode=1});
