// Claude API課金 日次監視 — Anthropic Admin cost_report → Discord #claude-code
// GitHub Actions で日次実行。秘匿値は env(GH Secrets)から。会話本文・トランスクリプトは一切触らない。
//   ANTHROPIC_ADMIN_KEY  : sk-ant-admin01-... (read-only 集計に使用)
//   DISCORD_COST_WEBHOOK : #claude-code webhook
const KEY = process.env.ANTHROPIC_ADMIN_KEY;
const HOOK = process.env.DISCORD_COST_WEBHOOK;
if (!KEY || !HOOK) { console.error('missing ANTHROPIC_ADMIN_KEY / DISCORD_COST_WEBHOOK'); process.exit(1); }

const H = { 'x-api-key': KEY, 'anthropic-version': '2023-06-01' };
const now = new Date();
const monthStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
const yst = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);

async function costReport(startingAt) {
  const buckets = [];
  let page = null;
  for (let p = 0; p < 40; p++) {
    let uri = `https://api.anthropic.com/v1/organizations/cost_report?starting_at=${startingAt}&group_by[]=description`;
    if (page) uri += `&page=${encodeURIComponent(page)}`;
    const r = await fetch(uri, { headers: H });
    if (!r.ok) throw new Error(`cost_report ${r.status}: ${await r.text()}`);
    const j = await r.json();
    buckets.push(...(j.data || []));
    if (j.has_more && j.next_page) page = j.next_page; else break;
  }
  return buckets;
}

const modelOf = (d) => { const m = /^(Claude .+?) Usage/.exec(d || ''); return m ? m[1] : (d || 'other'); };

const buckets = await costReport(monthStart);
let total = 0; const byModel = {}, byDay = {};
for (const b of buckets) {
  const day = String(typeof b.starting_at === 'string' ? b.starting_at : new Date(b.starting_at).toISOString()).slice(0, 10);
  for (const res of (b.results || [])) {
    const amt = parseFloat(res.amount) || 0;
    total += amt;
    const mdl = modelOf(res.description);
    byModel[mdl] = (byModel[mdl] || 0) + amt;
    byDay[day] = (byDay[day] || 0) + amt;
  }
}
const ystCost = byDay[yst] || 0;
const fable = Object.entries(byModel).filter(([k]) => /Fable|Mythos/i.test(k)).reduce((a, [, v]) => a + v, 0);
const top = Object.entries(byModel).sort((a, b) => b[1] - a[1]).slice(0, 6);

let msg = `**💰 Claude API課金 日次監視** (Developer Platform / MTD ${monthStart}〜)\n`;
msg += `MTD合計: **$${total.toFixed(2)}** ／ 前日 ${yst}: **$${ystCost.toFixed(2)}**\n`;
if (fable > 0) msg += `🚨 **Fable5(§1.16 禁止) MTD $${fable.toFixed(2)} = ${total ? (fable / total * 100).toFixed(0) : 0}%** → アプリのFable5全廃deployで消える\n`;
if (ystCost > 200) msg += `⚠️ 前日 $${ystCost.toFixed(2)} が高水準（>$200）\n`;
msg += `__モデル別 MTD TOP__\n`;
for (const [k, v] of top) msg += `- ${k}: $${v.toFixed(2)}\n`;
msg += `※Developer Platform(デプロイ済みアプリのAPI)分。Claude Codeシート利用は管理コンソール参照。`;

const post = await fetch(HOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: msg.slice(0, 1950) }) });
console.log(msg);
console.log(post.ok ? 'posted to #claude-code' : `discord POST failed ${post.status}`);
