#!/usr/bin/env node
/**
 * Populate data into the sheet. Run after create-booth-deliverables.mjs and research completion.
 * Usage: node tools/populate-sheet-data.mjs
 */
import { getDriveToken, driveApi } from './lib/drive-auth.mjs';
import fs from 'node:fs';

const SHEET_ID = '1zc0RPAMKUP2sv7On7kk1YdvKb_Oajruz1io_Oj3mijo';
const ACTING_USER = 'seisaku-team@orgiast.jp';

const TAB_IDS = { tab0: 478629708, tab1: 1807751389, tab2: 1311029313 };

async function main() {
  const token = await getDriveToken({ impersonate: ACTING_USER });
  const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

  // Helper: write rows to a sheet tab
  const writeRows = async (tabId, rows) => {
    if (rows.length === 0) return;
    await driveApi(token, `${SHEETS}/${SHEET_ID}:batchUpdate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{
          updateCells: {
            range: { sheetId: tabId, startRowIndex: 1, endRowIndex: 1 + rows.length, startColumnIndex: 0, endColumnIndex: rows[0].length },
            rows: rows.map(row => ({ values: row.map(v => ({ userEnteredValue: { stringValue: String(v ?? '') } })) })),
            fields: 'userEnteredValue',
          },
        }],
      }),
    });
  };

  // === Tab 2: 過去実績と選定理由 ===
  // First write past projects data that we know from the sheets
  const pastProjects = [
    ['NexTech Week', 'IT・テックの主要展示会。NexTech Week実績が豊富（monoAI・taiziii）', 'monoAItechnology株式会社', 'NexTech Week 2026 春', 'IT/テック', 'C0010', '要確認'],
    ['NexTech Week', 'IT・テックの主要展示会。NexTech Week実績が豊富（monoAI・taiziii）', '株式会社taiziii', 'NexTech Week 2025 秋 / 2026 春', 'IT/テック', 'C0011/C0018', '要確認'],
    ['Japan IT Week', 'IT業界最大級展示会。Japan IT Week実績あり', 'W2株式会社', 'Japan IT Week 春/秋 2026', 'IT/テック', 'C0016', '要確認'],
    ['Japan IT Week', 'IT業界最大級展示会。Japan IT Week実績あり', '株式会社メディアネットワーク', 'Japan IT Week 秋 2026', 'IT/テック', '要確認', '要確認'],
    ['コンテンツ東京', 'コンテンツ業界専門展。直接実績あり', '株式会社トラストスタジオ', 'コンテンツ東京 2026', 'コンテンツ', 'C0001', '要確認'],
    ['FOOD STYLE JAPAN', 'フード業界展示会。クラフトフィックスが13プロジェクトの全国実績', '株式会社クラフトフィックス', 'FOOD STYLE JAPAN（名古屋/福岡/大阪/沖縄）', 'フード', 'C0005-C0009', '要確認'],
    ['ビューティーワールド', '美容業界展示会。クラフトフィックスが全国4会場で実績', '株式会社クラフトフィックス', 'ビューティーワールド（大阪/福岡/名古屋/東京）', 'ビューティー', 'C0004/C0008/C0015/C0020', '要確認'],
    ['ファベックス', '飲料食品製造展。実績あり', '株式会社クラフトフィックス', '第29回ファベックス2026', 'フード', 'C0017', '要確認'],
    ['国際医用画像総合展', '医療画像専門展。実績あり', 'PDRファーマ', '2026国際医用画像総合展', '医療', 'C0019', '要確認（学会資料あり）'],
    ['フューネラルビジネスフェア', '葬祭サービス総合展。実績あり', 'マークスライフ株式会社', 'フューネラルビジネスフェア2026', '葬祭', 'C0021', '要確認'],
    ['マイクロウェーブ展', '研究機関向け専門展。継続受注実績あり', '国立研究開発法人海上・港湾・航空技術研究所', 'マイクロウェーブ展 2025/2026', '研究・政府系', 'C0012', '要確認'],
    ['エコプロ（サステナブル経営WEEK）', 'サステナビリティ関連展示会。実績あり', '株式会社グリーンエナジー＆カンパニー', 'サステナブル経営WEEK 秋 2026', 'エネルギー・環境', '要確認', '要確認'],
    ['オートモーティブワールド', '自動車技術展。実績あり', 'ファインスティールエンジニアリング', 'オートモーティブワールド東京2027', '製造・自動車', '要確認', '要確認（FINE_STEEL事例集あり）'],
    ['メッセナゴヤ', '中部地区最大級の展示会。自動車・製造業の実績あり', 'ファインスチール様', 'EV・HV・FCV技術展 名古屋 2026', '製造・自動車', '要確認', '要確認'],
    ['居酒屋JAPAN', '外食産業展示会。大阪・東京で実績あり', '株式会社クラフトフィックス', '居酒屋JAPAN（大阪/東京）', 'フード', 'C0013/C0014', '要確認'],
  ];
  await writeRows(TAB_IDS.tab2, pastProjects);
  console.log(`Wrote ${pastProjects.length} past project rows`);

  // === Tab 0: 展示会15件 (pre-populate with confirmed from past data + research) ===
  // We'll update this after the research agent completes
  const exhibitions = [
    ['Japan IT Week 春', '東京ビッグサイト', '未確認（2026年実績: 4/8〜4/10）', 'RX Japan', 'https://www.japan-itweek.jp/', '未確認', '業界最大級展示会。出展社一覧未公開', '要調査'],
    ['NexTech Week 春', '東京ビッグサイト', '未確認（2026年実績: 4/15〜4/17）', 'RX Japan', 'https://www.nextech-week.jp/', '未確認', 'XR・AI・IoT先端技術展', '要調査'],
    ['FOOD STYLE JAPAN (春)', '幕張メッセ', '未確認', 'ics', 'https://www.foodstyle-japan.jp/', '未確認', '業務用食品・食材の専門展', '要調査'],
    ['ビューティーワールド ジャパン 東京', '東京ビッグサイト', '未確認（2026年実績: 5/18〜5/20）', 'RX Japan', 'https://www.beautyworldjapan.jp/', '未確認', '美容業界最大級展示会', '要調査'],
    ['国際医用画像総合展（ITEM）', 'パシフィコ横浜', '未確認（2026年実績: 4/17〜4/19）', '日本医用画像機器工業会', 'https://www.item.or.jp/', '未確認', '医用画像機器の専門展', '要調査'],
    ['コンテンツ東京', '東京ビッグサイト', '未確認（2026年実績: 6/17〜6/19）', 'RX Japan', 'https://www.contentstokyo.jp/', '未確認', 'コンテンツ業界総合展', '要調査'],
    ['ファベックス', '東京ビッグサイト', '未確認（2026年実績: 4/15〜4/17）', '日本能率協会', 'https://www.fabex.jp/', '未確認', '飲料・食品製造総合展', '要調査'],
    ['フューネラルビジネスフェア', 'パシフィコ横浜', '未確認（2026年実績: 6/22〜）', 'フューネラルビジネスフェア', 'https://www.fbf.or.jp/', '未確認', '葬祭サービス総合展', '要調査'],
    ['マイクロウェーブ展（MWJ）', 'パシフィコ横浜', '未確認（2025年実績: 11/26〜11/28）', '電子情報技術産業協会', 'https://www.mwe.jp/', '未確認', '高周波・マイクロ波技術展', '要調査'],
    ['エコプロ（サステナブル経営WEEK）', '東京ビッグサイト', '未確認', '日本能率協会', 'https://econetworks.jp/', '未確認', 'サステナビリティ展示会', '要調査'],
    ['オートモーティブワールド', '東京ビッグサイト', '未確認（2027年1月予定）', 'RX Japan', 'https://www.automotiveworld.jp/', '未確認', '自動車技術展', '要調査'],
    ['InterMold（金型加工技術展）', 'インテックス大阪 or 幕張メッセ', '未確認', '日本金型工業会', 'https://www.intermold.jp/', '未確認', '金型・加工技術専門展', '要調査'],
    ['ものづくりDX展', '幕張メッセ', '未確認', '日本能率協会', 'https://www.dx-tokyo.jp/', '未確認', '製造業デジタル変革展', '要調査'],
    ['LED NextStage', '東京ビッグサイト', '未確認', '日本能率協会', 'https://www.led-nextstage.jp/', '未確認', 'LED・照明技術専門展', '要調査'],
    ['メッセナゴヤ', 'ポートメッセなごや', '未確認', '名古屋国際見本市委員会', 'https://www.messenagoya.jp/', '未確認', '中部圏最大級の総合展示会', '要調査'],
  ];
  await writeRows(TAB_IDS.tab0, exhibitions);
  console.log(`Wrote ${exhibitions.length} exhibition rows`);

  console.log('\nData populated. Update exhibition data after research completes.');
}

main().catch(e => { console.error(e.message); process.exit(1); });