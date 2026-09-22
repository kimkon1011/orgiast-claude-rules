/**
 * 保有機材スライド (1GPaySeZy7wyMIIHLQ3cY2yyJv44PwKClgcMSIJGm2go) の各スライドから
 * 機材写真 (PNG) を抽出 → Drive フォルダに保存 + 案件一覧 SS に「保有機材カタログ」シートを作成。
 *
 * LayoutPlan / ItemList で機材を指定する際、このカタログから現物写真の URL を引いて
 * ChatGPT 等への参考画像として使う。
 */

const EQUIPMENT_SLIDES_ID = '1GPaySeZy7wyMIIHLQ3cY2yyJv44PwKClgcMSIJGm2go';
const EQUIPMENT_CATALOG_FOLDER_NAME = '保有機材カタログ画像';
const EQUIPMENT_CATALOG_SHEET_NAME = '保有機材カタログ';
const EQUIPMENT_LAST_BUILT_KEY = 'EquipmentImages_lastBuiltTs';

/**
 * Slides の更新を検知して必要なら再ビルド。毎日 04:00 (JST) の trigger から呼ばれる。
 *
 * 動作:
 *   - Slides の modifiedTime > 前回ビルド時刻 → カタログフォルダを wipe → buildCatalog 実行
 *   - buildCatalog が errorCount=0 で完走 → 前回ビルド時刻を Slides の modifiedTime に更新
 *   - partial（429 残あり）→ 時刻更新せず、次回 trigger で同じ判定が走り resume される
 *
 * @return {{needsUpdate, slidesModified, lastBuilt, ...buildResult}}
 */
function EquipmentImages_checkAndUpdate() {
  const slidesFile = DriveApp.getFileById(EQUIPMENT_SLIDES_ID);
  const slidesModifiedMs = slidesFile.getLastUpdated().getTime();
  const props = PropertiesService.getScriptProperties();
  const lastBuiltStr = props.getProperty(EQUIPMENT_LAST_BUILT_KEY);
  const lastBuiltMs = lastBuiltStr ? parseInt(lastBuiltStr, 10) : 0;

  if (slidesModifiedMs <= lastBuiltMs) {
    return {
      needsUpdate: false,
      slidesModified: new Date(slidesModifiedMs).toISOString(),
      lastBuilt: new Date(lastBuiltMs).toISOString(),
      message: 'Slides 未変更、スキップ'
    };
  }

  // wipe（既存ファイル全部 trash）
  let wipedCount = 0;
  try {
    const root = DriveApp.getFolderById(APP_ROOT_FOLDER_ID);
    const folders = root.getFoldersByName(EQUIPMENT_CATALOG_FOLDER_NAME);
    if (folders.hasNext()) {
      const folder = folders.next();
      const files = folder.getFiles();
      while (files.hasNext()) {
        try { files.next().setTrashed(true); wipedCount++; } catch (e) {}
      }
    }
  } catch (e) {}

  const result = EquipmentImages_buildCatalog();
  // 完走時のみ時刻を進める
  if (result && result.errorCount === 0) {
    props.setProperty(EQUIPMENT_LAST_BUILT_KEY, String(slidesModifiedMs));
  }
  return {
    needsUpdate: true,
    slidesModified: new Date(slidesModifiedMs).toISOString(),
    lastBuilt: new Date(lastBuiltMs).toISOString(),
    wipedCount: wipedCount,
    build: result
  };
}

/**
 * 毎日 04:00 (JST) に EquipmentImages_checkAndUpdate を実行する trigger 登録。
 * 既存トリガーは削除して再作成。
 */
function EquipmentImages_setupDailyTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  let removed = 0;
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'EquipmentImages_checkAndUpdate') {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  ScriptApp.newTrigger('EquipmentImages_checkAndUpdate')
    .timeBased()
    .everyDays(1)
    .atHour(4)
    .create();
  return { removedOld: removed, created: true, hourJst: 4 };
}

/**
 * 保有機材カタログを構築 (一度実行すれば OK、機材入れ替え時に再実行)。
 *
 * 流れ:
 *   1) Slides を開く
 *   2) 各スライドのタイトル + IMAGE 要素を抽出
 *   3) 各 IMAGE を PNG として案件一覧 SS と同じフォルダ配下の「保有機材カタログ画像」に保存
 *   4) 案件一覧 SS の「保有機材カタログ」シートに 1 行 / スライドで登録
 *
 * @return {{folderUrl, sheetUrl, slideCount, imageCount, errors}}
 */
/**
 * PDF 一括エクスポート版（追加スコープ不要、即動く）。
 * Slides 全体を 1 個の PDF として「保有機材カタログ画像」フォルダに保存する。
 * ChatGPT 等にこの PDF を添付すれば全機材を一気に参照させられる。
 */
function EquipmentImages_exportSlidesPdf() {
  const root = DriveApp.getFolderById(APP_ROOT_FOLDER_ID);
  let folder;
  const folders = root.getFoldersByName(EQUIPMENT_CATALOG_FOLDER_NAME);
  if (folders.hasNext()) folder = folders.next();
  else folder = root.createFolder(EQUIPMENT_CATALOG_FOLDER_NAME);

  // 既存ファイル削除
  const existing = folder.getFilesByName('保有機材カタログ_全機材.pdf');
  while (existing.hasNext()) {
    try { existing.next().setTrashed(true); } catch (e) {}
  }

  const exported = Doc_exportPdf(EQUIPMENT_SLIDES_ID, '保有機材カタログ_全機材.pdf', folder);
  return {
    ok: true,
    pdfUrl: exported.pdfUrl,
    folderUrl: folder.getUrl(),
    sizeKb: exported.sizeKb
  };
}

function EquipmentImages_buildCatalog() {
  const presentation = SlidesApp.openById(EQUIPMENT_SLIDES_ID);
  const slides = presentation.getSlides();
  const presentationUrl = presentation.getUrl();
  // 1 スライド = 1 サムネ画像で完結（per-image 抽出は重すぎて 6 min 超え）
  return _EquipmentImages_buildCatalogFast(presentation, slides, presentationUrl);
}

function _EquipmentImages_buildCatalogFast(presentation, slides, presentationUrl) {

  // フォルダ
  const root = DriveApp.getFolderById(APP_ROOT_FOLDER_ID);
  let folder;
  const folders = root.getFoldersByName(EQUIPMENT_CATALOG_FOLDER_NAME);
  if (folders.hasNext()) {
    folder = folders.next();
    // 既存ファイルは残す（429 リトライ時の再開対応）
  } else {
    folder = root.createFolder(EQUIPMENT_CATALOG_FOLDER_NAME);
  }
  // フォルダ自体を「リンクを知っている全員 (Workspace 内)」で閲覧可に
  try { folder.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}

  // シート（案件一覧 SS 内）
  const appSs = SpreadsheetApp.getActive();
  let sheet = appSs.getSheetByName(EQUIPMENT_CATALOG_SHEET_NAME);
  if (!sheet) {
    sheet = appSs.insertSheet(EQUIPMENT_CATALOG_SHEET_NAME);
  } else {
    sheet.clear();
  }
  sheet.appendRow(['スライド番号', 'タイトル', 'スライドURL', '画像数', '画像URL (改行区切り)', '抽出メモ', '本文テキスト']);
  sheet.getRange(1, 1, 1, 7).setFontWeight('bold').setBackground('#cfe2f3');
  sheet.setFrozenRows(1);

  const errors = [];
  let totalImages = 0;
  const rows = [];
  const presId = EQUIPMENT_SLIDES_ID;

  // 既存ファイルマップ（再開時のスキップ用）: slideNum -> file URL
  const existingByNum = {};
  const existingIt = folder.getFiles();
  while (existingIt.hasNext()) {
    const f = existingIt.next();
    const m = f.getName().match(/^slide_(\d{2})_/);
    if (m) existingByNum[parseInt(m[1], 10)] = f.getUrl();
  }

  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    const slideNum = i + 1;
    const slideObjectId = slide.getObjectId();
    const slideUrl = presentationUrl.replace(/\/edit.*$/, '/edit') + '#slide=id.' + slideObjectId;

    // タイトルと、全 Shape / Table の本文テキストを抽出。
    let title = '';
    const bodyParts = [];
    const elements = slide.getPageElements();
    for (let j = 0; j < elements.length; j++) {
      try {
        if (elements[j].getPageElementType() === SlidesApp.PageElementType.SHAPE) {
          const text = String(elements[j].asShape().getText().asString() || '').trim();
          if (text) bodyParts.push(text);
          if (text && !title) {
            const firstLine = text.split('\n')[0].trim();
            if (firstLine && firstLine.length < 200) {
              title = firstLine;
            }
          }
        } else if (elements[j].getPageElementType() === SlidesApp.PageElementType.TABLE) {
          const table = elements[j].asTable();
          for (let tr = 0; tr < table.getNumRows(); tr++) {
            const cells = [];
            for (let tc = 0; tc < table.getNumColumns(); tc++) {
              try { cells.push(String(table.getCell(tr, tc).getText().asString() || '').trim()); } catch (e) { cells.push(''); }
            }
            if (cells.some(Boolean)) bodyParts.push(cells.join(' | '));
          }
        }
      } catch (e) {}
    }
    if (!title) title = '(タイトル不明)';
    let bodyText = bodyParts.join('\n');
    if (bodyText.length > 40000) bodyText = bodyText.slice(0, 39992) + '…(切り詰め)';

    // スライド全体を 1 枚の PNG として export（レガシーexport URL 経由）
    // 既存ファイルがあればスキップ（再開対応）
    let imageUrl = existingByNum[slideNum] || '';
    let noteParts = [];
    if (imageUrl) {
      noteParts.push('既存スキップ');
      totalImages++;
    } else {
      try {
        // レート制限回避: 各リクエスト間に 1.5 秒スリープ
        if (i > 0) Utilities.sleep(1500);
        const legacyUrl = 'https://docs.google.com/presentation/d/' + presId +
          '/export/png?id=' + presId + '&pageid=' + slideObjectId;
        // 429 再試行: backoff 2s, 5s, 10s
        let imgRes = null;
        let lastCode = 0;
        const delays = [0, 2000, 5000, 10000];
        for (let attempt = 0; attempt < delays.length; attempt++) {
          if (delays[attempt] > 0) Utilities.sleep(delays[attempt]);
          imgRes = UrlFetchApp.fetch(legacyUrl, {
            headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
            muteHttpExceptions: true,
            followRedirects: true
          });
          lastCode = imgRes.getResponseCode();
          if (lastCode === 200) break;
          if (lastCode !== 429 && lastCode !== 500 && lastCode !== 503) break;
        }
        if (lastCode === 200) {
          const sanitized = (title || 'untitled').replace(/[\\/:*?"<>|\n\r\t]/g, '_').substring(0, 40);
          const filename = 'slide_' + ('0' + slideNum).slice(-2) + '_' + sanitized + '.png';
          const blob = imgRes.getBlob().setName(filename).setContentType('image/png');
          const file = folder.createFile(blob);
          imageUrl = file.getUrl();
          totalImages++;
        } else {
          errors.push({ slide: slideNum, error: 'export: ' + lastCode });
          noteParts.push('画像取得失敗 ' + lastCode);
        }
      } catch (e) {
        errors.push({ slide: slideNum, error: e.message });
        noteParts.push('エラー: ' + e.message);
      }
    }

    rows.push([
      slideNum,
      title,
      slideUrl,
      imageUrl ? 1 : 0,
      imageUrl,
      noteParts.join(' / '),
      bodyText
    ]);
  }

  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, 7).setValues(rows);
  }
  // 列幅
  sheet.setColumnWidth(1, 80);
  sheet.setColumnWidth(2, 280);
  sheet.setColumnWidth(3, 320);
  sheet.setColumnWidth(4, 60);
  sheet.setColumnWidth(5, 360);
  sheet.setColumnWidth(6, 200);
  sheet.setColumnWidth(7, 420);
  if (rows.length) sheet.getRange(2, 1, rows.length, 7).setWrap(true).setVerticalAlignment('top');

  return {
    folderId: folder.getId(),
    folderUrl: folder.getUrl(),
    sheetUrl: PanelLinks_sheetUrl(appSs, sheet),
    slideCount: slides.length,
    imageCount: totalImages,
    rowCount: rows.length,
    errorCount: errors.length,
    errors: errors.slice(0, 10) // sample
  };
}
