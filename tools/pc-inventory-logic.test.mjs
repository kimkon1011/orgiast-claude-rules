import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../gas/fleet-status-sheet/PcInventoryLogic.gs',import.meta.url),'utf8');
const context={}; vm.createContext(context); vm.runInContext(source.replace(/\bconst\s+/g,'var '),context);
const forbidden=['ユーザ名','パスワード','購入日','商品名','購入金額','購入店','使用カード','保険の有無','保険終了日','倉庫場所','状態','主な使用者・使用用途','URL','デバイス名','デバイスID','その他'];
const allowed=['メーカー','コンピュータ名','型番','CPU','VGA GPU','OS','ビット','ﾒﾓﾘ種類','ﾒﾓﾘ容量(GB)','ﾒﾓﾘ空ｽﾛｯﾄ','ﾒﾓﾘ最大容量','HDD種類','HDD(GB)','CD/DVDドライブ','LAN口','無線LAN','HDMI','情報更新日'];
const management=['PC No.','ﾉｰﾄor ﾃﾞｽｸﾄｯﾌﾟ'];
function row(headers,values={}){return headers.map(h=>values[h]??'');}
function payload(host='HOST-A'){return {hostname:host,updatedAt:'2026-08-27',spec:{maker:'Dell',computerName:host,model:'X',cpu:'CPU',gpu:'GPU',os:'Windows',bits:'64-bit',memoryType:'DDR5',memoryGb:32,memorySlotsFree:2,memoryMaxGb:64,diskType:'NVMe',diskGb:1000,opticalDrive:'なし',lan:'あり',wifi:'あり',hdmi:'判定不能',deviceType:'ﾉｰﾄ'}};}

test('shuffled columns write only allowlisted or new-row management columns, never all 16 forbidden columns',()=>{
  const headers=[...forbidden,...allowed,...management].sort(()=>0.5-Math.random()); const plan=context.fleetPlanPcInventory(headers,[],payload());
  const written=Object.keys(plan.values).map(Number).map(i=>headers[i]);
  for(const h of forbidden) assert(!written.includes(h),`${h} was written`);
  for(const h of written) assert([...allowed,...management].includes(h),`not allowlisted: ${h}`);
});

test('matching hostname updates existing row without append and empty values do not clear cells',()=>{
  const headers=[...allowed,...forbidden,...management]; const existing=row(headers,{'コンピュータ名':'host-a','型番':'KEEP','パスワード':'SECRET'});
  const p=payload('HOST-A'); p.spec.model=''; p.spec.cpu=null; const plan=context.fleetPlanPcInventory(headers,[existing],p);
  assert.equal(plan.action,'updated'); assert.equal(plan.rowIndex,0); assert(!Object.hasOwn(plan.values,String(headers.indexOf('型番')))); assert(!Object.hasOwn(plan.values,String(headers.indexOf('CPU'))));
  assert(!Object.hasOwn(plan.values,String(headers.indexOf('パスワード'))));
});

test('new hostname appends and increments maximum P number',()=>{
  const headers=[...allowed,...management]; const rows=[row(headers,{'PC No.':'P2'}),row(headers,{'PC No.':'P19'})];
  const plan=context.fleetPlanPcInventory(headers,rows,payload('NEW')); assert.equal(plan.action,'appended'); assert.equal(plan.rowIndex,2);
  assert.equal(plan.values[headers.indexOf('PC No.')],'P20'); assert.equal(plan.values[headers.indexOf('ﾉｰﾄor ﾃﾞｽｸﾄｯﾌﾟ')],'ﾉｰﾄ');
});

test('NFKC handles half/full width mixed headers',()=>{
  const headers=allowed.map(h=>h.normalize('NFKC')).reverse(); headers.push(...management.map(h=>h.normalize('NFKC')));
  const plan=context.fleetPlanPcInventory(headers,[],payload());
  assert.equal(plan.values[context.pcFindHeader(headers,'ﾒﾓﾘ容量(GB)')],32); assert.equal(plan.values[context.pcFindHeader(headers,'無線LAN')],'あり');
});
