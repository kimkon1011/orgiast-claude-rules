#!/usr/bin/env node
import fs from 'node:fs';
import { getDriveToken,driveApi } from './lib/drive-auth.mjs';
import { isEntry } from './is-entry.mjs';
export async function run(args=process.argv.slice(2)) {
 const value=f=>{const i=args.indexOf(f);return i<0?undefined:args[i+1];};
 const id=value('--id'),q=value('--query'),out=value('--out'),mime=value('--export');
 for(let i=0;i<args.length;i+=2)if(!['--id','--query','--out','--export','--page-token'].includes(args[i])||!args[i+1]||args[i+1].startsWith('--'))throw Error('Invalid drive-read arguments');
 if(Boolean(id)===Boolean(q)||id&&!/^[\w-]+$/.test(id)||!id&&(out||mime))throw Error('Specify --query or --id [--out file] [--export MIME]');
 const token=await getDriveToken({impersonate:'seisaku-team@orgiast.jp'});
 const params=new URLSearchParams(id ? out ? mime ? {mimeType:mime} : {alt:'media'} : {fields:'id,name,mimeType,modifiedTime,webViewLink'} : {q,fields:'nextPageToken,files(id,name,mimeType,modifiedTime)',pageSize:'100',...(value('--page-token')?{pageToken:value('--page-token')}:{})});
 const response=await driveApi(token,`https://www.googleapis.com/drive/v3/files${id?`/${id}${mime?'/export':''}`:''}?${params}`);
 if(out){const bytes=Buffer.from(await response.arrayBuffer());fs.writeFileSync(out,bytes);return{out,bytes:bytes.length};}
 return response.json();
}
if(isEntry(import.meta.url))run().then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e.message);process.exitCode=1;});
