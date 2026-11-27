// テスト中の未モック通信を拒否する。ローカルのテストHTTPサーバだけ許可。
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
const allow = value => {
  const url=typeof value==='string' || value instanceof URL ? new URL(value) : value;
  const host=url.hostname || url.host || '';
  if(!['127.0.0.1','localhost','[::1]','::1'].includes(host) || ['23373','80','443'].includes(String(url.port || '')))throw Error('テストで未モックの外部通信を拒否しました');
};
const originalFetch=globalThis.fetch;
globalThis.fetch=(input,init)=>{allow(typeof input==='object' && input.url ? input.url : input);return originalFetch(input,init);};
for(const mod of [http,https])for(const key of ['request','get']){const original=mod[key];mod[key]=function(...args){allow(args[0]);return original.apply(this,args);};}
syncBuiltinESMExports();
