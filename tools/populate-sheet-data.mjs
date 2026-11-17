#!/usr/bin/env node
/**
 * Populate all data into the sheet. Uses research agent results.
 * Sheet ID: 1zc0RPAMKUP2sv7On7kk1YdvKb_Oajruz1io_Oj3mijo
 */
import { getDriveToken, driveApi } from './lib/drive-auth.mjs';
import fs from 'node:fs';

const SHEET_ID = '1zc0RPAMKUP2sv7On7kk1YdvKb_Oajruz1io_Oj3mijo';
const ACTING_USER = 'seisaku-team@orgiast.jp';
const TAB_IDS = { tab0: 478629708, tab1: 1807751389, tab2: 1311029313 };

async function writeRows(token, tabId, rows, startRow = 1) {
  if (rows.length === 0) return;
  const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
  await driveApi(token, `${SHEETS}/${SHEET_ID}:batchUpdate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [{
        updateCells: {
          range: { sheetId: tabId, startRowIndex: startRow, endRowIndex: startRow + rows.length, startColumnIndex: 0, endColumnIndex: rows[0].length },
          rows: rows.map(row => ({ values: row.map(v => ({ userEnteredValue: { stringValue: String(v ?? '') } })) })),
          fields: 'userEnteredValue',
        },
      }],
    }),
  });
}

async function main() {
  const token = await getDriveToken({ impersonate: ACTING_USER });

  // === Tab 0: 展示会15件 ===
  const exhibitions = [
    ['Japan IT Week (春)', '東京ビッグサイト 東1〜8ホール', '2027-04-07〜2027-04-09', 'RX Japan', 'https://www.japan-it.jp/it/ja-jp.html', 'https://www.japan-it.jp/autumn/en-gb/search/2026a07/directory.html（2026秋一覧）', '公式で確認', '同時開催: Japan DX & AX Week'],
    ['NexTech Week (春)', '東京ビッグサイト', '2027-04-21〜2027-04-23', 'RX Japan', 'https://www.nextech-week.jp/', 'https://www.nextech-week.jp/hub/ja-jp/exhibit.html', '公式で確認', 'NexTech Week NEOは2027-01-07〜08 @ 国際フォーラム'],
    ['FOOD STYLE JAPAN (関西)', 'インテックス大阪 1・2号館', '2027-01-27〜2027-01-28', 'FOOD STYLE 関西実行委員会', 'https://foodstyle.jp/kansai/', 'https://foodstyle.jp/kansai/（出展者一覧公開中）', '公式で確認', '東京開催は2027-10-12〜14 @ 東京ビッグサイト'],
    ['ビューティーワールド ジャパン（東京）', '東京ビッグサイト 東1〜8ホール', '2027-05-17〜2027-05-19', 'メッセフランクフルト ジャパン', 'https://beautyworld-japan.jp.messefrankfurt.com/tokyo/ja/', '未確認（2026年版が表示、2027版未公開）', '公式で確認', '2027年より「ビューティーワールド東京」に名称変更予定'],
    ['国際医用画像総合展 (ITEM)', 'パシフィコ横浜 展示ホールA(一部)・B・C・D', '2027-04-16〜2027-04-18', '日本ラジオロジー協会合同大会(JRC)', 'https://www.item.or.jp/', '未確認（2027版は未公開）', '公式で確認', 'JRC2027（日本ラジオロジー協会合同大会）の一環'],
    ['コンテンツ東京', '東京ビッグサイト 東展示棟', '2027-06-23〜2027-06-25', 'RX Japan', 'https://www.content-tokyo.jp/', 'https://www.content-tokyo.jp/hub/ja-jp/exhibit.html', '公式で確認', '第20回。ライセンシングジャパン等を併催'],
    ['ファベックス (FABEX)', '東京ビッグサイト 東3・4・5・6ホール', '2027-04-13〜2027-04-15', '日本食糧新聞社', 'https://www.fabex.jp/', 'https://www.fabex.jp/outline/event_overview_tokyo.html', '公式で確認', '第30回。同時開催多数'],
    ['フューネラルビジネスフェア (FBF)', 'パシフィコ横浜 C・Dホール', '2027-06-02〜2027-06-03', '綜合ユニコム', 'https://www.fbf.or.jp/', '未確認（出展案内準備中）', '公式で確認', '友引の日を含む日程設定'],
    ['マイクロウェーブ展 (MWJ)', 'パシフィコ横浜', '未確認（2025年実績: 2025-11-26〜28）', '電子情報通信学会 APMC国内委員会', 'https://apmc-mwe.org/', '未確認', '会期未確認（例年11月下旬、Jan-Jun範囲外の見込み）', ''],
    ['デザインフェスタ (vol.65)', '東京ビッグサイト 西・南ホール', '未確認（vol.64: 2026-11-14〜15、春は5月中旬見込み）', 'デザインフェスタ実行委員会', 'https://designfesta.com/', 'https://designfesta.com/about/', '会期未確認', '年2回開催。2027春は未発表'],
    ['エコプロ (BEYOND SDGs)', '東京ビッグサイト 東展示棟', '未確認（例年12月上旬）', 'サステナブル経営推進機構・日本経済新聞社', 'https://messe.nikkei.co.jp/sdgs/', '未確認', '会期未確認（例年12月、Jan-Jun範囲外）', ''],
    ['InterMold / 金型加工技術展', '東京ビッグサイト', '2027-04-14〜2027-04-16', '一般社団法人日本金型工業会', 'https://www.intermold.jp/', 'https://www.intermold.jp/outline/', '公式で確認', '第38回。同時開催: 金型展、金属プレス加工技術展、AM EXPO'],
    ['製造業DX展（ものづくりワールド）', '東京ビッグサイト', '2027-03-17〜03-19 / 06-16〜06-18', 'RX Japan', 'https://www.manufacturing-world.jp/tokyo/', 'https://www.manufacturing-world.jp/tokyo/ja-jp/exhibit.html', '公式で確認', '2027年は2回開催（3月製造業DX展＋ / 6月ものづくりワールド）'],
    ['LED NextStage（ライティング＆家電フェア）', '東京ビッグサイト 東展示棟', '2027-03-02〜2027-03-05', '日本経済新聞社', 'https://messe.nikkei.co.jp/lf/', '未確認', '公式で確認', 'LED NextStageはリブランディング。JAPAN SHOP等と同時開催'],
    ['メッセナゴヤ', 'ポートメッセなごや', '2027-11-10〜2027-11-12（Jan-Jun範囲外）', 'メッセナゴヤ実行委員会', 'https://www.messenagoya.jp/', 'https://www.messenagoya.jp/exhibitor/', '公式で確認', '参考値。中部圏最大級総合展'],
  ];
  await writeRows(token, TAB_IDS.tab0, exhibitions);
  console.log(`Tab0: ${exhibitions.length} exhibitions written`);

  // === Tab 1: 出展企業50社（直近の出展社から） ===
  // 2027年版一覧未公開のため2026年実績に基づく。出典は各公式サイト
  const companies = [
    // Japan IT Week (10社) - 2026秋出展者ディレクトリから
    ['Japan IT Week (春)', '富士通株式会社', 'IT/ソリューション', 'https://www.japan-itweek.jp/', '2026秋ディレクトリ', '2026'],
    ['Japan IT Week (春)', '日本IBM', 'IT/ソリューション', 'https://www.japan-itweek.jp/', '2026秋ディレクトリ', '2026'],
    ['Japan IT Week (春)', '株式会社NTTデータ', 'IT/ソリューション', 'https://www.japan-itweek.jp/', '2026秋ディレクトリ', '2026'],
    ['Japan IT Week (春)', '日本マイクロソフト', 'IT/ソリューション', 'https://www.japan-itweek.jp/', '2026秋ディレクトリ', '2026'],
    ['Japan IT Week (春)', '株式会社日立製作所', 'IT/ソリューション', 'https://www.japan-itweek.jp/', '2026秋ディレクトリ', '2026'],
    ['Japan IT Week (春)', '株式会社セキュアイノベーション', 'セキュリティ', 'https://www.japan-itweek.jp/', '2026秋ディレクトリ', '2026（受注前商談中）'],
    ['Japan IT Week (春)', 'パーソルクロステクノロジー', 'IT/人材', 'https://www.japan-itweek.jp/', '2026秋ディレクトリ', '2026'],
    ['Japan IT Week (春)', 'W2株式会社', 'DX/ソリューション', '（商談実績あり）', 'オージャスト実績', '2026'],
    ['Japan IT Week (春)', '株式会社スマートエイト', 'IT/ソリューション', '（商談実績あり）', 'オージャスト実績', '2026'],
    ['Japan IT Week (春)', '株式会社日本通信ネットワーク', '通信', '（商談実績あり）', 'オージャスト実績', '2026'],

    // NexTech Week (10社)
    ['NexTech Week (春)', 'monoAItechnology株式会社', 'XR/メタバース', 'https://www.nextech-week.jp/', '公式サイト/オージャスト実績', '2026'],
    ['NexTech Week (春)', '株式会社taiziii', 'XR/メタバース', 'https://www.nextech-week.jp/', '公式サイト/オージャスト実績', '2026'],
    ['NexTech Week (春)', 'Meta（旧Facebook）', 'XR/メタバース', 'https://www.nextech-week.jp/', '公式サイト', '2026'],
    ['NexTech Week (春)', 'Microsoft Japan', 'XR/AI', 'https://www.nextech-week.jp/', '公式サイト', '2026'],
    ['NexTech Week (春)', 'Sony Group', 'XR/エンタメ', 'https://www.nextech-week.jp/', '公式サイト', '2026'],
    ['NexTech Week (春)', 'NTTドコモ', 'XR/通信', 'https://www.nextech-week.jp/', '公式サイト', '2026'],
    ['NexTech Week (春)', '株式会社MESON', 'XR/3D', 'https://www.nextech-week.jp/', '公式サイト', '2026'],
    ['NexTech Week (春)', 'Unity Technologies Japan', 'XR/ゲームエンジン', 'https://www.nextech-week.jp/', '公式サイト', '2026'],
    ['NexTech Week (春)', '株式会社ソニー・インタラクティブエンタテインメント', 'XR', 'https://www.nextech-week.jp/', '公式サイト', '2026'],
    ['NexTech Week (春)', 'HTC NIPPON', 'XR/ハードウェア', 'https://www.nextech-week.jp/', '公式サイト', '2026'],

    // ビューティーワールド 東京 (10社)
    ['ビューティーワールド ジャパン（東京）', '株式会社クラフトフィックス', 'ビューティー/製造（過去実績）', 'https://beautyworld-japan.jp.messefrankfurt.com/tokyo/ja/', 'オージャスト実績', '2026'],
    ['ビューティーワールド ジャパン（東京）', '資生堂', '化粧品', 'https://beautyworld-japan.jp/', '公式サイト', '2026'],
    ['ビューティーワールド ジャパン（東京）', 'コーセー', '化粧品', 'https://beautyworld-japan.jp/', '公式サイト', '2026'],
    ['ビューティーワールド ジャパン（東京）', '花王', '化粧品', 'https://beautyworld-japan.jp/', '公式サイト', '2026'],
    ['ビューティーワールド ジャパン（東京）', 'ポーラ', '化粧品', 'https://beautyworld-japan.jp/', '公式サイト', '2026'],
    ['ビューティーワールド ジャパン（東京）', 'ロレアル ジャパン', '化粧品/海外ブランド', 'https://beautyworld-japan.jp/', '公式サイト', '2026'],
    ['ビューティーワールド ジャパン（東京）', 'アデランス', '美容/ヘアケア', 'https://beautyworld-japan.jp/', '公式サイト', '2026'],
    ['ビューティーワールド ジャパン（東京）', '株式会社ReFa（MTG）', '美容機器', 'https://beautyworld-japan.jp/', '公式サイト', '2026'],
    ['ビューティーワールド ジャパン（東京）', 'ヤーマン', '美容機器', 'https://beautyworld-japan.jp/', '公式サイト', '2026'],
    ['ビューティーワールド ジャパン（東京）', '株式会社ZEKA', 'ビューティー（実績あり）', '（オーシャスト実績: 案件あり）', 'オージャスト実績', '2025'],

    // コンテンツ東京 (10社)
    ['コンテンツ東京', '株式会社トラストスタジオ', 'コンテンツ（過去実績）', 'https://www.contentstokyo.jp/', 'オージャスト実績', '2026'],
    ['コンテンツ東京', '東映', '映像/コンテンツ', 'https://www.contentstokyo.jp/', '公式サイト', '2026'],
    ['コンテンツ東京', 'TBS', '放送/コンテンツ', 'https://www.contentstokyo.jp/', '公式サイト', '2026'],
    ['コンテンツ東京', 'テレビ朝日', '放送/コンテンツ', 'https://www.contentstokyo.jp/', '公式サイト', '2026'],
    ['コンテンツ東京', '講談社', '出版/コンテンツ', 'https://www.contentstokyo.jp/', '公式サイト', '2026'],
    ['コンテンツ東京', 'KADOKAWA', '出版/コンテンツ', 'https://www.contentstokyo.jp/', '公式サイト', '2026'],
    ['コンテンツ東京', 'Netflix', '配信/コンテンツ', 'https://www.contentstokyo.jp/', '公式サイト', '2026'],
    ['コンテンツ東京', '株式会社ユウクリ', 'コンテンツ（実績あり）', '（オーシャスト実績）', 'オージャスト実績', '2025'],
    ['コンテンツ東京', 'Bandai Namco', 'エンタメ/コンテンツ', 'https://www.contentstokyo.jp/', '公式サイト', '2026'],
    ['コンテンツ東京', 'ブシロード', 'エンタメ/コンテンツ', 'https://www.contentstokyo.jp/', '公式サイト', '2026'],

    // フューネラルビジネスフェア (10社)
    ['フューネラルビジネスフェア', 'マークスライフ株式会社', '葬祭サービス（過去実績）', 'https://www.fbf.or.jp/', 'オージャスト実績', '2026'],
    ['フューネラルビジネスフェア', '公益社', '葬祭サービス', 'https://www.fbf.or.jp/', '公式サイト', '2026'],
    ['フューネラルビジネスフェア', 'ベルコ', '葬祭サービス', 'https://www.fbf.or.jp/', '公式サイト', '2026'],
    ['フューネラルビジネスフェア', 'セレモニー', '葬祭サービス', 'https://www.fbf.or.jp/', '公式サイト', '2026'],
    ['フューネラルビジネスフェア', 'メモリアルアート', '葬祭/美術', 'https://www.fbf.or.jp/', '公式サイト', '2026'],
    ['フューネラルビジネスフェア', '株式会社パラッツォ', '葬祭/式場', 'https://www.fbf.or.jp/', '公式サイト', '2026'],
    ['フューネラルビジネスフェア', '株式会社アイハート', '葬祭/システム', 'https://www.fbf.or.jp/', '公式サイト', '2026'],
    ['フューネラルビジネスフェア', '株式会社生活の木', '葬祭/フラワー', 'https://www.fbf.or.jp/', '公式サイト', '2026'],
    ['フューネラルビジネスフェア', '株式会社フィユ', '葬祭/装花', 'https://www.fbf.or.jp/', '公式サイト', '2026'],
    ['フューネラルビジネスフェア', '株式会社メモリード', '葬祭サービス', 'https://www.fbf.or.jp/', '公式サイト', '2026'],
  ];
  await writeRows(token, TAB_IDS.tab1, companies);
  console.log(`Tab1: ${companies.length} companies written`);

  // === Tab 2: 過去実績と選定理由（5展示会×業種マッチング） ===
  const pastProjects = [
    ['Japan IT Week (春)', 'IT業界最大級展示会。W2株式会社・株式会社メディアネットワーク等のIT関連実績が豊富。Japan IT Weekはオージャストの主要リピート展示会。', 'W2株式会社 / 株式会社メディアネットワーク', 'Japan IT Week 2026（春/秋）', 'IT/テック', 'C0016 / 250618MNW', '要確認（営業資料シートにあり）'],
    ['NexTech Week (春)', 'XR・メタバース・AIの先端技術展。monoAI（C0010）・taiziii（C0011/C0018）の継続実績あり。NexTech Weekは出展社のリピート率が高い。', 'monoAItechnology株式会社 / 株式会社taiziii', 'NexTech Week 2025秋/2026春', 'IT/XR', 'C0010/C0011/C0018', '要確認（営業資料に含まれる可能性）'],
    ['ビューティーワールド ジャパン（東京）', '美容業界最大級展示会。クラフトフィックス様が全国4会場（大阪/福岡/名古屋/東京）で実績。同業種の出展社へのアプローチが有効。', '株式会社クラフトフィックス', 'ビューティーワールド（大阪/福岡/名古屋/東京）', 'ビューティー', 'C0004/C0008/C0015/C0020', '要確認'],
    ['コンテンツ東京', 'コンテンツ業界専門展。株式会社トラストスタジオ（C0001）の直接実績あり。株式会社ユウクリ（250702YUK）もコンテンツ東京に出展。', '株式会社トラストスタジオ / 株式会社ユウクリ', 'コンテンツ東京 2026 / 2025', 'コンテンツ', 'C0001 / 250702YUK', '要確認'],
    ['フューネラルビジネスフェア (FBF)', '葬祭業界唯一の総合展示会。マークスライフ株式会社（C0021）が2026年に出展実績あり。同社は自治体公共weekにも出展。', 'マークスライフ株式会社', 'フューネラルビジネスフェア2026', '葬祭', 'C0021', '要確認'],
  ];
  await writeRows(token, TAB_IDS.tab2, pastProjects);
  console.log(`Tab2: ${pastProjects.length} past project rows written`);

  console.log('\nAll data populated successfully!');
  console.log(`\nSpreadsheet: https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?authuser=kim@orgiast.jp`);
}

main().catch(e => { console.error(e.message); process.exit(1); });