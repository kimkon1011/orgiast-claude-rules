#!/usr/bin/env node
/**
 * track-rpd-quoter-response-time.mjs — rpd quoter 応答時間を計測しレポートを生成
 *
 * 使用法:
 *   SUPABASE_URL=https://xxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=k node tools/track-rpd-quoter-response-time.mjs
 *
 * 環境変数:
 *   SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL — Supabase プロジェクトURL
 *   SUPABASE_SERVICE_ROLE_KEY               — サービスロール鍵
 *   OUTPUT_DIR                              — CSV 出力先（省略時は reports/）
 *   SUPPRESS_STDOUT                         — "1" で標準出力抑制（cron用）
 *
 * 依存: postgres (package.json)
 */

import postgres from 'postgres';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateReport, formatStatsText } from './lib/rpd-quoter-response-report.mjs';

// ── 環境変数読込 ───────────────────────────────────────────────
const env = process.env;
const supabaseUrl = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || '';
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!supabaseUrl || !serviceRoleKey) {
  console.error('Usage: SUPABASE_URL=https://xxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=k node tools/track-rpd-quoter-response-time.mjs');
  process.exit(1);
}

// Supabase project ref を URL から抽出
const projectRef = supabaseUrl.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1];
if (!projectRef) {
  console.error(`Cannot extract project ref from SUPABASE_URL: ${supabaseUrl}`);
  process.exit(1);
}

// 接続文字列（Direct connection、pooler 不使用）
const connectionString = `postgresql://postgres:${encodeURIComponent(serviceRoleKey)}@db.${projectRef}.supabase.co:5432/postgres?sslmode=require`;

// ── 出力先 ─────────────────────────────────────────────────────
const selfDir = dirname(fileURLToPath(import.meta.url));
const outputDir = env.OUTPUT_DIR || join(selfDir, '..', 'reports');
if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

// ── メイン ─────────────────────────────────────────────────────
async function main() {
  const sql = postgres(connectionString);

  try {
    const records = await sql`
      SELECT id, deal_id, quoter_responded_at, created_at, is_pre_generated, pre_generated_at
      FROM rpd_quoter_response_time
      WHERE quoter_responded_at IS NOT NULL
        AND created_at >= NOW() - INTERVAL '7 days'
      ORDER BY created_at
    `;

    // 日付文字列に変換（postgres ライブラリは Date オブジェクトを返す）
    const rows = records.map((r) => ({
      id: r.id,
      deal_id: r.deal_id,
      quoter_responded_at: r.quoter_responded_at?.toISOString?.() ?? r.quoter_responded_at,
      created_at: r.created_at?.toISOString?.() ?? r.created_at,
      is_pre_generated: !!r.is_pre_generated,
      pre_generated_at: r.pre_generated_at?.toISOString?.() ?? r.pre_generated_at,
    }));

    const { csv, stats } = generateReport(rows);

    // CSV 保存
    const csvPath = join(outputDir, 'rpd-quoter-response-time.csv');
    writeFileSync(csvPath, csv, 'utf-8');

    // レポート表示
    if (env.SUPPRESS_STDOUT !== '1') {
      console.log('=== rpd quoter 応答時間レポート ===');
      console.log(formatStatsText(stats));
      console.log(`\nCSV: ${csvPath}`);
    }

    await sql.end();
  } catch (err) {
    console.error('Fatal:', err);
    try { await sql.end(); } catch {}
    process.exit(1);
  }
}

main();