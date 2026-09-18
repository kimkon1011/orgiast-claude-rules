import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {dir,root,loadPages,readJSON,writeJSON,config} from './runtime.mjs';
const settings=config();
const force=process.argv.includes('--force');
if(process.argv.slice(2).some(a=>a!=='--force'))throw new Error('Usage: node deck-hybrid/gen-visuals.mjs [--force]');
fs.mkdirSync(path.join(dir,'visuals'),{recursive:true});
const logPath=path.join(dir,'gen-visuals-log.json');
const log=fs.existsSync(logPath)?readJSON(logPath):{runs:[]};
const run={startedAt:new Date().toISOString(),force,pages:[]};log.runs.push(run);
const save=()=>writeJSON(logPath,log);
const redact=s=>s.replace(/AIza[\w-]+/g,'[REDACTED]').replace(/([?&]key=)[^\s&"']+/g,'$1[REDACTED]');
async function ensurePNG(file){
  const bytes=fs.readFileSync(file);
  const signature=bytes.subarray(0,8).toString('hex');
  if(signature==='89504e470d0a1a0a')return {inputSignature:signature,converted:false};
  // Existing gen-image writes the API bytes as received, regardless of the suffix.
  // Decode and re-encode locally at native size; no image generation or visual edits.
  const require=createRequire(path.join(root,'package.json'));
  const {chromium}=require(settings.playwright);
  const browser=await chromium.launch(settings.browser);
  try{
    const page=await browser.newPage();await page.goto(pathToFileURL(file).href);
    const png=await page.locator('img').evaluate(async img=>{
      await img.decode();const canvas=document.createElement('canvas');
      canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;
      canvas.getContext('2d').drawImage(img,0,0);return canvas.toDataURL('image/png').split(',')[1];
    });
    fs.writeFileSync(file,Buffer.from(png,'base64'));
    return {inputSignature:signature,converted:true};
  }finally{await browser.close();}
}
function invoke(args){return new Promise(resolve=>{
  const child=spawn(process.execPath,[settings.genImage,...args],{cwd:root,stdio:['ignore','pipe','pipe']});
  let output='';
  child.stdout.on('data',d=>{output+=d});child.stderr.on('data',d=>{output+=d});
  const timeout=setTimeout(()=>child.kill(),360000);
  child.on('error',e=>{output+=e.message});
  child.on('close',code=>{clearTimeout(timeout);resolve({code,output:redact(output).slice(-12000)})});
});}
for(const p of loadPages().filter(p=>p.visualBrief)){
  if(!Array.isArray(p.photoSources)||p.photoSources.length<2||p.photoSources.length>4)throw new Error(`${p.id}: photoSources は実写真2〜4枚`);
  const target=path.join(dir,'visuals',`${p.id}.png`);
  const entry={id:p.id,sources:p.photoSources,attempts:[],status:'pending'};run.pages.push(entry);
  if(fs.existsSync(target)&&!force){entry.status='skipped-existing';save();console.log(`${p.id}: existing -> skip`);continue;}
  const prompt=[
    'Use case: compositing. Asset: Japanese business exhibition proposal, photo visual only.',
    '実写真の質感を保つ。人物は自然で顔の重複なし。文字・ロゴ・数字・表・図解・透かしを描かない。看板・衣服の既存の文字とロゴは無地にする。明るい展示会場の光。暗いフィルターは禁止。',
    '完成後のブースと自然な接客のみ。設営・搬入・床のゴミ・資材・私的集合写真・空いた寂しい会場は不可。',
    'アスペクト比16:9。入力画像は実写真の参考素材。新しいブース設計パースは作らず、素材の施工の質感と接客の様子を組み合わせる。',
    p.visualBrief
  ].join('\n');entry.prompt=prompt;
  // Three total attempts. gen-image itself tries its existing model list each time.
  for(let attempt=1;attempt<=3;attempt++){
    const temp=path.join(dir,'visuals',`${p.id}.pending.png`);
    fs.rmSync(temp,{force:true});
    console.log(`${p.id}: Gemini attempt ${attempt}/3`);save();
    const result=await invoke([temp,prompt,...p.photoSources.flatMap(f=>['--img',path.resolve(dir,f)])]);
    let encoding=null,encodingError=null;
    if(result.code===0&&fs.existsSync(temp)){
      try{encoding=await ensurePNG(temp)}catch(error){encodingError=redact(error.message)}
    }
    const ok=result.code===0&&encoding!==null;
    entry.attempts.push({attempt,endedAt:new Date().toISOString(),exitCode:result.code,success:ok,encoding,encodingError,output:result.output});
    console.log(result.output.trim());save();
    if(ok){fs.renameSync(temp,target);entry.status='generated';entry.bytes=fs.statSync(target).size;save();break;}
    if(fs.existsSync(temp))fs.renameSync(temp,path.join(dir,'visuals',`${p.id}.rejected-${Date.now()}.bin`));
    if(!/429|RESOURCE_EXHAUSTED|rate.?limit/i.test(result.output)||attempt===3){
      entry.status=fs.existsSync(target)?'retained-existing-after-failure':'fallback-original';entry.fallbackPhoto=p.fallbackPhoto;save();break;
    }
    console.log(`${p.id}: 429 -> waiting 60 seconds`);
    await new Promise(r=>setTimeout(r,60000));
  }
}
run.completedAt=new Date().toISOString();save();
