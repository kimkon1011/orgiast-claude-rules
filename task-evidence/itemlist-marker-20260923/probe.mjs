import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const base=new URL('./',import.meta.url);
function run(file,fail=false){
 const src=fs.readFileSync(new URL(file,base),'utf8');
 const ctx=vm.createContext({});
 for(const name of ['_Procure_appendMarkerRow','_Procure_pickWritableRow']){
  const match=src.match(new RegExp('function '+name+'\\([^]*?^\\}','m'));
  if(match)vm.runInContext(match[0],ctx);
 }
 const data=Array.from({length:7},()=>Array(7).fill('')); data[3][1]='以下に追加ｱｲﾃﾑ情報を入力';
 let inserts=0;
 const sheet={getLastRow:()=>data.length,getLastColumn:()=>7,insertRowsAfter(){inserts++;},getRange(r,c,n,m){if(fail&&r===1)throw Error('read failed');return {getMergedRanges:()=>[],getDisplayValues:()=>Array.from({length:n},(_,i)=>Array.from({length:m},(_,j)=>data[r+i-1]?.[c+j-1]??''))};}};
 return {selectedRow:ctx._Procure_pickWritableRow(sheet,{'品名':7},{}),insertCalls:inserts};
}
const result={live:run('live-procurement.js'),candidate:run('candidate/src/Phase_ProcurementRequest.js'),candidateReadFailure:run('candidate/src/Phase_ProcurementRequest.js',true)};
assert.equal(result.live.selectedRow,3);assert.equal(result.candidate.selectedRow,5);assert.equal(result.candidateReadFailure.selectedRow,3);assert.equal(result.candidate.insertCalls,0);
fs.writeFileSync(new URL('reproduction.json',base),JSON.stringify(result,null,2)+'\n'); console.log(result);
