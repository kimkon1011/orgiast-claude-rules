#!/usr/bin/env node
/**
 * 落札実績データ収集ツール
 *
 * 調達ポータルの落札実績オープンデータをダウンロードしようと試みる。
 * 認証が必要な場合はその旨を記録する。
 *
 * 使い方: node tools/awards.mjs
 *
 * 出力: data/awards.csv
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');

/**
 * 落札実績のCSVヘッダー（調達ポータル公開データの形式に準拠）
 * 実際のデータ項目は以下を想定：
 *   整理番号, 発注機関, 件名, 契約方式, 落札日, 落札金額, 落札者, 予定価格, 備考
 */
const CSV_HEADER = '案件名,発注機関,落札日,落札金額,落札者,入札形式,データ源URL\n';

/**
 * 調達ポータルの落札実績ダウンロードページ
 * 実際のダウンロードには認証（電子証明書/利用者ID）が必要
 */
const AWARD_PAGE_URL = 'https://www.p-portal.go.jp/pps-web-biz/UAB02/OAB0201';

async function fetch(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await globalThis.fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OrgiastBidBot/1.0)' },
      ...options
    });
    return resp;
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  console.log('=== 落札実績データ収集 ===\n');

  // 落札実績ダウンロードページにアクセス
  console.log(`1. ダウンロードページ確認: ${AWARD_PAGE_URL}`);
  let status = '未確認';
  let note = '';

  try {
    const resp = await fetch(AWARD_PAGE_URL);
    const html = await resp.text();

    if (html.includes('ログイン') || html.includes('pps-auth-biz')) {
      status = '認証必須';
      note = '調達ポータルの落札実績ダウンロードにはログイン認証が必要です。\n' +
             '電子証明書または利用者ID・パスワードでの認証後にダウンロード可能。\n' +
             '認証後のセッションでは以下のURLで全年度のCSV(ZIP)が提供されています:\n' +
             '  https://www.p-portal.go.jp/pps-web-biz/UAB02/successful_bid_record_info_all_2026.zip\n' +
             '  https://www.p-portal.go.jp/pps-web-biz/UAB02/successful_bid_record_info_all_2025.zip\n' +
             '  ...（2013年〜2026年）\n' +
             '差分ファイル（日次更新、過去2ヶ月分）も利用可能。';
    } else if (html.includes('successful_bid_record')) {
      status = '閲覧可（ダウンロードには認証）';
      note = '一覧ページは閲覧可。ダウンロードには認証が必要。';
    } else {
      status = '応答あり';
      note = 'ページは取得できたが、内容の解析が必要';
    }
  } catch (e) {
    status = '接続エラー';
    note = `エラー: ${e.message}`;
  }

  console.log(`   状態: ${status}`);
  console.log(`   備考: ${note}\n`);

  // CSV出力（認証が必要なため空のヘッダーのみ）
  const csvPath = path.join(DATA_DIR, 'awards.csv');
  fs.writeFileSync(csvPath, '﻿' + CSV_HEADER, 'utf8');

  console.log(`2. 出力: ${csvPath}`);
  console.log('   認証が必要なためデータ行なし（ヘッダーのみ）\n');

  console.log('=== 代替案 ===');
  console.log('認証不要で利用可能な落札データ源:');
  console.log('  ・各自治体の入札結果公表ページ（自治体ごとに個別収集が必要）');
  console.log('  ・官公需情報ポータル（kkj.go.jp）— ただし現在応答なし');
  console.log('  ・全省庁統一資格の有資格者情報はGEPSサイトで検索可能（ログイン必須）');
  console.log('');
  console.log('認証情報の入手方法:');
  console.log('  1. 全省庁統一資格の申請（随時受付中: 令和7・8・9年度）');
  console.log('     申請窓口: https://www.p-portal.go.jp/');
  console.log('     必要書類: 競争参加資格審査申請書、財務諸表、事業概要書 等');
  console.log('     処理期間: 約2週間〜1ヶ月');
  console.log('  2. 資格取得後に利用者IDを発行 → 調達ポータルにログイン可能に');
  console.log('  3. ログイン後、落札実績オープンデータを全件ダウンロード可能');
}

main().catch(console.error);
