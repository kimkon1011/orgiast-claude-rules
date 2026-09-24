// Shared by the external-state and reported-symptom gates.
export const symptomDenials = /問題(?:ありません|ない|なし)|異常なし|正常です|正常に動いています|対応は不要|不要です|必要ありません|枯渇していません|影響ありません|起きていません|発生していません|実データが合っていません|報告が(?:誤り|間違)/;
export const unknown = /未再現|未確認|まだ確認できていない|不明/;
export const meta = /検出|パターン|正規表現|ゲート|フック|ルール|fixtures?|\bgate\b.{0,40}(?:仕様|説明|block|pass)/i;
export const corrections = /訂正|と答えた|と書いた|と断定した|前回|先ほど|暫定回答|(?:私|自分|こちら).{0,30}誤り|誤りでした/;
export function sentences(text) {
  return String(text || '').split(/\r?\n/).map(s => s.trim())
    .filter(s => !s.startsWith('>') && !(s.startsWith('|') && s.endsWith('|')))
    .flatMap(s => s.split(/(?<=[。！？!?])/)).map(s => s.trim()).filter(Boolean);
}
export function currentTurnEntries(raw) {
  let entries = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    let entry; try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || entry.isSidechain === true) continue;
    const content = entry.message?.content;
    if (entry.type === 'user' && entry.message?.role === 'user'
      && !(Array.isArray(content) && content.some(b => b?.type === 'tool_result'))) entries = [];
    entries.push(entry);
  }
  return entries;
}
export function messageText(entry) {
  const content = entry.message?.content;
  return typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(b => b?.type === 'text').map(b => b.text || '').join('\n') : '';
}
export function blocks(entries, type) {
  return entries.filter(e => type !== 'tool_use' || e.type === 'assistant')
    .flatMap(e => Array.isArray(e.message?.content) ? e.message.content : []).filter(b => b?.type === type);
}
const vendors = [
  ['anthropic', /Anthropic|Claude\s*Console/i], ['openai', /OpenAI|ChatGPT/i],
  ['github', /GitHub|\bActions\b/i], ['vercel', /Vercel/i],
  ['google', /Google|GA4|GTM|Search Console|Drive|Gmail|Calendar|Workspace|Firebase/i],
  ['supabase', /Supabase/i], ['cloudflare', /Cloudflare/i], ['freee', /freee/i],
  ['stripe', /Stripe/i], ['discord', /Discord/i], ['notion', /Notion/i], ['slack', /Slack/i],
];
export function claimVendors(sentence) {
  const found = vendors.filter(([, pattern]) => pattern.test(sentence)).map(([name]) => name);
  if (!found.length && /Console|Billing|残高|クレジット|支払い|自動チャージ|オートチャージ/.test(sentence)) found.push('anthropic');
  return new Set(found);
}
export function claimVendor(sentence) { return [...claimVendors(sentence)][0] || null; }
const hosts = { 'github.com': 'github', 'githubusercontent.com': 'github', 'vercel.com': 'vercel',
  'google.com': 'google', 'googleapis.com': 'google', 'supabase.com': 'supabase', 'supabase.co': 'supabase',
  'cloudflare.com': 'cloudflare', 'freee.co.jp': 'freee', 'freee.com': 'freee', 'stripe.com': 'stripe',
  'discord.com': 'discord', 'notion.so': 'notion', 'slack.com': 'slack', 'openai.com': 'openai' };
function urlVendor(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return null;
    return Object.entries(hosts).find(([host]) => url.hostname === host || url.hostname.endsWith('.' + host))?.[1] || null;
  } catch { return null; }
}
// Anthropic Console billing has no supported direct-query path here. A gh success
// or a request to the model API must never stand in for its billing screen.
export function queriedVendorsFromRaw(raw) {
  const found = new Set();
  const addUrl = value => { const vendor = urlVendor(value); if (vendor) found.add(vendor); };
  for (const block of blocks(currentTurnEntries(raw), 'tool_use')) {
    const name = String(block.name || '');
    if (/^mcp__/.test(name)) {
      const server = name.split('__')[1] || '';
      for (const [vendor, pattern] of vendors) if (vendor !== 'anthropic' && pattern.test(server.replaceAll('_', ' '))) found.add(vendor);
    } else if (/^WebFetch$/i.test(name)) addUrl(block.input?.url);
    else if (/^(?:Bash|PowerShell)$/i.test(name)) {
      const command = String(block.input?.command || '');
      // Count executable positions, never mentions in echo/grep/local files.
      const cli = /(?:^|[;\n|&]\s*|\b(?:env|sudo)\s+)(?:\s*)(?:npx\s+)?(gh|vercel|gcloud|clasp|supabase|wrangler)\s+(?!--version\b|--help\b)/g;
      for (const match of command.matchAll(cli)) found.add(({ gh: 'github', vercel: 'vercel', gcloud: 'google', clasp: 'google', supabase: 'supabase', wrangler: 'cloudflare' })[match[1]]);
      if (/(?:^|[;\n|&])\s*(?:curl|wget|Invoke-RestMethod|Invoke-WebRequest)\s/i.test(command))
        for (const url of command.match(/https?:\/\/[^\s"'`<>]+/gi) || []) addUrl(url);
    }
  }
  return found;
}
export function reportedSymptoms(raw) {
  return currentTurnEntries(raw).filter(e => e.type === 'user').flatMap(e => sentences(messageText(e)))
    .filter(s => !meta.test(s) && /エラー|error|失敗|failed|動かない|落ちる|できない|不具合|止まっている|too low/i.test(s)
      && (claimVendors(s).size || /[A-Z][A-Za-z0-9_-]{2,}|「[^」]+」/.test(s)));
}
export const unreachable = /アクセスできません|触れません|代行できません|API\s*が(?:無い|ない)|ブラウザログインが必要|確認不可/;
export function evidenceRequest(text) {
  return sentences(text).some(s => !meta.test(s) && !corrections.test(s)
    && /(?:スクショ|スクリーンショット|画面の数値|(?:ページ|URL).{0,50}(?:見える値|表示.{0,10}(?:値|数値)))/i.test(s)
    && /(?:送って|共有して|見せて|教えて|提示して|添付して|ください|お願いします)/.test(s)
    && !/(?:不要|必要ありません|依頼しません)/.test(s));
}
export function needsEvidenceRequest(text, raw) {
  return reportedSymptoms(raw).length > 0 && sentences(text).some(s => !meta.test(s) && !corrections.test(s) && unreachable.test(s));
}
