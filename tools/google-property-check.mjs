// 指定キーワードに合う GA4 プロパティ / Search Console サイト / GTM コンテナが
// impersonate 先アカウント(既定 kim@orgiast.jp)に存在するかを、既存 DWD サービスアカウントで読み取り専用に確認する。
// 使い方: node tools/google-property-check.mjs "tetsuko|toho|東邦" [GTM-XXXXXXX]
import { getDriveToken } from './lib/drive-auth.mjs';

const KEYWORDS = new RegExp(process.argv[2] ?? 'tetsuko|toho|東邦|テツコ|鋼材', 'i');
const TARGET_GTM = process.argv[3] ?? 'GTM-KBC4TFM';

const api = async (token, url, init = {}) => {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
};

async function checkGA4() {
  console.log('\n===== [1] GA4 =====');
  const token = await getDriveToken({ scope: 'https://www.googleapis.com/auth/analytics.readonly' });
  const summaries = await api(token, 'https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200');
  const accounts = summaries.accountSummaries ?? [];
  console.log(`accounts: ${accounts.length}`);
  for (const acc of accounts) {
    console.log(`- account ${acc.displayName} (${acc.account})`);
    for (const p of acc.propertySummaries ?? []) {
      const pid = p.property.split('/')[1];
      let streams = [];
      try {
        const ds = await api(token, `https://analyticsadmin.googleapis.com/v1beta/${p.property}/dataStreams`);
        streams = ds.dataStreams ?? [];
      } catch (e) { console.log(`    (dataStreams error: ${e.message})`); }
      const streamDesc = streams.map(s => `${s.webStreamData?.measurementId ?? s.type} ${s.webStreamData?.defaultUri ?? ''}`).join(' | ');
      const hit = KEYWORDS.test(`${acc.displayName} ${p.displayName} ${streamDesc}`) ? '  <<< 候補' : '';
      console.log(`    property ${p.displayName} (id ${pid}) streams: ${streamDesc}${hit}`);
      if (hit) {
        try {
          const rep = await api(token, `https://analyticsdata.googleapis.com/v1beta/properties/${pid}:runReport`, {
            method: 'POST',
            body: JSON.stringify({ dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }], metrics: [{ name: 'sessions' }, { name: 'screenPageViews' }] }),
          });
          const row = rep.rows?.[0]?.metricValues?.map(m => m.value) ?? ['0', '0'];
          console.log(`      直近30日: sessions=${row[0]} pageviews=${row[1]}`);
        } catch (e) { console.log(`      (runReport error: ${e.message})`); }
      }
    }
  }
}

async function checkSearchConsole() {
  console.log('\n===== [2] Search Console =====');
  const token = await getDriveToken({ scope: 'https://www.googleapis.com/auth/webmasters.readonly' });
  const sites = await api(token, 'https://www.googleapis.com/webmasters/v3/sites');
  const list = sites.siteEntry ?? [];
  console.log(`sites: ${list.length}`);
  for (const s of list) {
    const hit = KEYWORDS.test(s.siteUrl) ? '  <<< 候補' : '';
    console.log(`- ${s.siteUrl} (${s.permissionLevel})${hit}`);
  }
}

async function checkGTM() {
  console.log('\n===== [3] Tag Manager =====');
  const token = await getDriveToken({ scope: 'https://www.googleapis.com/auth/tagmanager.readonly' });
  const accs = await api(token, 'https://tagmanager.googleapis.com/tagmanager/v2/accounts');
  const list = accs.account ?? [];
  console.log(`accounts: ${list.length}`);
  for (const a of list) {
    const cs = await api(token, `https://tagmanager.googleapis.com/tagmanager/v2/${a.path}/containers`);
    for (const c of cs.container ?? []) {
      const hit = c.publicId === TARGET_GTM ? '  <<< 対象コンテナ' : '';
      console.log(`- ${a.name} / ${c.name} ${c.publicId} ${(c.domainName ?? []).join(',')}${hit}`);
    }
  }
}

for (const fn of [checkGA4, checkSearchConsole, checkGTM]) {
  try { await fn(); } catch (e) { console.log(`ERROR in ${fn.name}: ${e.message}`); }
}
