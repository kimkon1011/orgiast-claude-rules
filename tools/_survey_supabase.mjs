#!/usr/bin/env node
// 調査依頼: Supabase の channel_messages / deal_activities を照会（読み取り専用）
import { loadSecrets } from './line-group-send.mjs';

async function query(url, headers) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  return r.json();
}

async function main() {
  const s = await loadSecrets();
  const H = { apikey: s.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${s.SUPABASE_SERVICE_ROLE_KEY}` };
  const BASE = `${s.SUPABASE_URL}/rest/v1`;

  // ── 1. channel_messages: 列名確認 ──
  const colSample = await query(`${BASE}/channel_messages?limit=1`, H);
  console.log('=== channel_messages 列一覧 (1行サンプル) ===');
  console.log(JSON.stringify(colSample[0] || {}, null, 2));
  console.log();

  // ── 2. channel_messages: channel別・direction別 直近14日件数 ──
  const since = '2026-10-30';
  const channels = await query(`${BASE}/channel_messages?select=channel,direction,count&channel=not.is.null&direction=not.is.null&created_at=gte.${since}&order=channel.asc`, H);
  // 上記はaggregateできないので個別に集計
  const aggUrl = `${BASE}/channel_messages?select=channel,direction&created_at=gte.${since}&limit=10000`;
  const all = await query(aggUrl, H);
  const agg = {};
  for (const row of all) {
    const ch = row.channel || 'null';
    const dir = row.direction || 'null';
    agg[ch] = agg[ch] || {};
    agg[ch][dir] = (agg[ch][dir] || 0) + 1;
  }
  console.log('=== channel_messages: channel×direction 件数 (2026-10-30以降) ===');
  for (const [ch, dirs] of Object.entries(agg)) {
    const parts = Object.entries(dirs).map(([d, c]) => `${d}=${c}`);
    console.log(`  ${ch}: ${parts.join(', ')}`);
  }
  console.log();

  // ── 3. channel_messages: channel別 最新 received_at/created_at ──
  for (const ch of Object.keys(agg)) {
    const latest = await query(`${BASE}/channel_messages?select=created_at,received_at&channel=eq.${encodeURIComponent(ch)}&order=created_at.desc&limit=1`, H);
    if (latest[0]) {
      console.log(`  ${ch}: 最新 created_at=${latest[0].created_at}, received_at=${latest[0].received_at}`);
    }
  }
  console.log();

  // ── 4. customer_id が null の件数 ──
  for (const ch of Object.keys(agg)) {
    const nullCount = await query(`${BASE}/channel_messages?select=id&channel=eq.${encodeURIComponent(ch)}&customer_id=is.null&created_at=gte.${since}&limit=10000`, H);
    console.log(`  ${ch}: customer_id=null ${nullCount.length}件 (since ${since})`);
  }
  console.log();

  // ── 5. deal_activities: mail_sent / mail_received 直近14日 ──
  const acts = await query(`${BASE}/deal_activities?select=activity_type,created_at&created_at=gte.${since}&limit=5000`, H);
  const actAgg = {};
  for (const row of acts) {
    const t = row.activity_type || 'null';
    actAgg[t] = (actAgg[t] || 0) + 1;
  }
  console.log('=== deal_activities: activity_type別 件数 (2026-10-30以降) ===');
  for (const [t, c] of Object.entries(actAgg)) {
    const latest = acts.filter(a => a.activity_type === t).sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    console.log(`  ${t}: ${c}件, 最新=${latest?.created_at}`);
  }
  console.log();

  // ── 6. channel_messages の channel 一覧 ──
  const distinctCh = [...new Set(all.map(r => r.channel).filter(Boolean))];
  console.log('=== channel_messages: 全チャンネル一覧 ===');
  for (const ch of distinctCh) {
    const cnt = all.filter(r => r.channel === ch).length;
    console.log(`  ${ch}: ${cnt}件`);
  }
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
