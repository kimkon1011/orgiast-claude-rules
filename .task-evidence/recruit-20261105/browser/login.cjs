const {chromium}=require('playwright');
const readline=require('node:readline');
(async()=>{
 const fs=require('node:fs');const p=require('node:path').join(__dirname,'credentials.tmp');const data=JSON.parse(fs.readFileSync(p,'utf8'));fs.unlinkSync(p);
 const browser=await chromium.launch({headless:true});
 for(const item of data){
  const page=await browser.newPage();
  try{
   await page.goto(item.name==='engage'?'https://en-gage.net/company_login/login/':'https://ats.rct.airwork.net/dashboards',{waitUntil:'domcontentloaded',timeout:45000});
   if(item.name==='engage'){
    await page.locator('#loginID').fill(item.account);await page.locator('#password').fill(item.password);await page.getByRole('button',{name:'ログイン',exact:true}).click();
   }else{
    await page.getByRole('link',{name:'ログイン',exact:true}).click();await page.waitForTimeout(3000);
    console.log(JSON.stringify({name:'airwork-before',url:page.url().split('?')[0],text:await page.locator('body').innerText(),inputs:await page.locator('input').evaluateAll(es=>es.map(e=>({name:e.name,type:e.type,id:e.id})))}));
    const pass=page.locator('input[type=password]');if(await pass.count()){
     const account=page.locator('input[type=text],input[type=email]').first();await account.fill(item.account);await pass.fill(item.password);await page.getByRole('button',{name:'ログイン',exact:true}).click();
    }
   }
   await page.waitForTimeout(5000);let txt=await page.locator('body').innerText();txt=txt.split(item.password).join('[REDACTED]');
   console.log(JSON.stringify({name:item.name,url:page.url().split('?')[0],text:txt.slice(0,9000),links:await page.locator('a').evaluateAll(es=>es.map(e=>({text:e.innerText,url:e.href})).filter(e=>/求人|仕事/.test(e.text)))}));
  }catch(e){console.log(item.name,e.message.split(item.password).join('[REDACTED]'));console.log(JSON.stringify({name:item.name,url:page.url().split('?')[0],text:(await page.locator('body').innerText()).split(item.password).join('[REDACTED]').slice(0,7000)}))}
  await page.close();
 }
 await browser.close();
})().catch(e=>{console.error(e.message);process.exitCode=1});
