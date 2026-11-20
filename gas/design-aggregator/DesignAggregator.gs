/**
 * Design Aggregator - 案件管理シートの企画URL巡回 メインロジック
 *
 * 案件管理シートのURL列から各デザインツールの企画ページを開き、
 * og:image 等からプレビュー画像を取得して新規シートに一覧化する。
 *
 * デザインツール判定: Figma / Canva / ChatGPT画像生成 / Miro / Notion / 他
 * 画像取得: og:image > twitter:image > favicon
 */

// ---- 設定キー ----
var SHEET_ID_KEY_ = 'TARGET_SPREADSHEET_ID';
var URL_COL_NAME_KEY_ = 'URL_COLUMN_NAME';

// ---- デザインツール定義 ----
var DESIGN_TOOLS_ = [
  { domain: 'figma.com',        name: 'Figma' },
  { domain: 'canva.com',        name: 'Canva' },
  { domain: 'chatgpt.com',      name: 'ChatGPT画像生成' },
  { domain: 'openai.com',       name: 'ChatGPT画像生成' },
  { domain: 'miro.com',         name: 'Miro' },
  { domain: 'notion.site',      name: 'Notion' },
  { domain: 'notion.so',        name: 'Notion' },
  { domain: 'vercel.app',       name: 'Vercel' },
  { domain: 'google.com',       name: 'Google系' },
  { domain: 'google.co.jp',     name: 'Google系' },
  { domain: 'github.com',       name: 'GitHub' },
  { domain: 'x.com',            name: 'X/Twitter' },
  { domain: 'twitter.com',      name: 'X/Twitter' },
  { domain: 'instagram.com',    name: 'Instagram' },
  { domain: 'youtube.com',      name: 'YouTube' },
  { domain: 'youtu.be',         name: 'YouTube' },
  { domain: 'zenn.dev',         name: 'Zenn' },
  { domain: 'note.com',         name: 'note' },
];

var HEADERS_ = ['案件名', 'デザインツール', 'プレビュー画像（埋込）', 'URL'];
var SHEET_NAME_ = 'デザイン一覧';

/**
 * URL を解析してデザインツール名を返す。
 * @param {string} url
 * @returns {string}
 */
function classifyDesignTool_(url) {
  if (!url) return '';
  var lower = url.toLowerCase();
  for (var i = 0; i < DESIGN_TOOLS_.length; i++) {
    if (lower.indexOf(DESIGN_TOOLS_[i].domain) !== -1) {
      return DESIGN_TOOLS_[i].name;
    }
  }
  return 'その他';
}

/**
 * HTML 文字列から og:image / twitter:image の content 値を抽出する。
 * @param {string} html
 * @returns {string|null}
 */
function extractPreviewUrlFromHtml_(html) {
  if (!html) return null;
  // <meta property="og:image" content="...">
  var m = html.match(/<meta\s+(?:[^>]*?\s+)?property=["']og:image["']\s+content=["']([^"']+)["']/i);
  if (m) return m[1];
  // <meta content="..." property="og:image">
  m = html.match(/<meta\s+content=["']([^"']+)["']\s+(?:[^>]*?\s+)?property=["']og:image["']/i);
  if (m) return m[1];
  // <meta name="twitter:image" content="...">
  m = html.match(/<meta\s+(?:[^>]*?\s+)?name=["']twitter:image["']\s+content=["']([^"']+)["']/i);
  if (m) return m[1];
  // <meta content="..." name="twitter:image">
  m = html.match(/<meta\s+content=["']([^"']+)["']\s+(?:[^>]*?\s+)?name=["']twitter:image["']/i);
  if (m) return m[1];
  return null;
}

/**
 * URL からプレビュー画像 URL を取得する。
 * @param {string} url
 * @returns {{previewUrl: string|null, error: string|null, toolName: string}}
 */
function fetchPreviewImage_(url) {
  var toolName = classifyDesignTool_(url);
  if (!url || url.indexOf('http') !== 0) {
    return { previewUrl: null, error: 'URLが無効です', toolName: toolName };
  }
  try {
    var response = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    var code = response.getResponseCode();
    if (code < 200 || code >= 400) {
      return { previewUrl: null, error: 'HTTP ' + code, toolName: toolName };
    }
    var html = response.getContentText();
    var previewUrl = extractPreviewUrlFromHtml_(html);
    if (previewUrl) {
      return { previewUrl: previewUrl, error: null, toolName: toolName };
    }
    // og:image が無ければ favicon をフォールバックとする
    try {
      var urlObj = new URL(url, 'https://example.com');
      var domain = urlObj.hostname;
      var favicon = 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(domain) + '&sz=128';
      return { previewUrl: favicon, error: null, toolName: toolName };
    } catch (e) {
      return { previewUrl: null, error: 'og:image なし / favicon 生成失敗', toolName: toolName };
    }
  } catch (e) {
    return { previewUrl: null, error: e.message, toolName: toolName };
  }
}

/**
 * 対象のスプレッドシートを取得する。
 * 設定があれば openById、なければ getActiveSpreadsheet。
 * @returns {Spreadsheet|{error: string}}
 */
function getTargetSpreadsheet_() {
  var id = PropertiesService.getScriptProperties().getProperty(SHEET_ID_KEY_);
  if (id) {
    try {
      return SpreadsheetApp.openById(id);
    } catch (e) {
      return { error: 'Spreadsheet openById 失敗: ' + e.message };
    }
  }
  try {
    return SpreadsheetApp.getActiveSpreadsheet();
  } catch (e) {
    return { error: 'アクティブなスプレッドシートがありません: ' + e.message };
  }
}

/**
 * シート内のURL列を自動検出する。
 * ヘッダー行を走査し、"URL" / "企画URL" / "デザインURL" / "リンク" 等のラベルを探す。
 * @param {Sheet} sheet
 * @returns {number|null} 列番号（1基点）or null
 */
function detectUrlColumn_(sheet) {
  var lastCol = sheet.getLastColumn();
  if (lastCol < 1) return null;
  var headers = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
  var keywords = ['企画URL', 'デザインURL', 'URL', 'リンク', 'url', 'Url'];
  for (var k = 0; k < keywords.length; k++) {
    for (var c = 0; c < headers.length; c++) {
      if (headers[c] && headers[c].trim() === keywords[k]) {
        return c + 1;
      }
    }
  }
  // 部分一致で再試行
  for (var p = 0; p < keywords.length; p++) {
    for (var d = 0; d < headers.length; d++) {
      if (headers[d] && headers[d].indexOf(keywords[p]) !== -1) {
        return d + 1;
      }
    }
  }
  return null;
}

/**
 * 案件名をシートのヘッダー/データから推測する。
 * 「案件名」列があれば最初のデータ行の値を使う。
 * なければシート名を案件名として使う。
 * @param {Sheet} sheet
 * @returns {string}
 */
function detectCaseName_(sheet) {
  var lastCol = sheet.getLastColumn();
  if (lastCol < 1) return sheet.getName() || '';
  var headers = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
  var caseNameCol = -1;
  var keywords = ['案件名', '案件', 'プロジェクト名', 'タイトル'];
  for (var k = 0; k < keywords.length; k++) {
    for (var c = 0; c < headers.length; c++) {
      if (headers[c] && headers[c].trim() === keywords[k]) {
        caseNameCol = c + 1;
        break;
      }
    }
    if (caseNameCol > 0) break;
  }
  if (caseNameCol > 0 && sheet.getLastRow() >= 2) {
    var val = sheet.getRange(2, caseNameCol).getDisplayValue();
    if (val && val.trim()) return val.trim();
  }
  return sheet.getName() || '';
}

/**
 * シートのURL列からURL一覧を収集する。
 * @param {Sheet} sheet
 * @param {number} urlCol 列番号（1基点）
 * @returns {{row: number, url: string}[]}
 */
function collectUrlsFromColumn_(sheet, urlCol) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, urlCol, lastRow - 1, 1).getDisplayValues();
  var results = [];
  for (var i = 0; i < values.length; i++) {
    var url = (values[i][0] || '').trim();
    if (!url) continue;
    // URL らしいパターン（http:// または https:// で始まる）のみ対象
    if (url.indexOf('http://') === 0 || url.indexOf('https://') === 0) {
      results.push({ row: i + 2, url: url });
    }
  }
  return results;
}

/**
 * デザイン一覧シートを確保する（存在しなければ作成）。
 * @param {Spreadsheet} ss
 * @returns {Sheet}
 */
function ensureDesignSheet_(ss) {
  var sheet = ss.getSheetByName(SHEET_NAME_);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME_);
  } else {
    // 既存シートはクリア
    sheet.clear();
  }
  // ヘッダー書き込み
  sheet.getRange(1, 1, 1, HEADERS_.length).setValues([HEADERS_]);
  // ヘッダー書式
  sheet.getRange(1, 1, 1, HEADERS_.length).setFontWeight('bold');
  sheet.getRange(1, 1, 1, HEADERS_.length).setBackground('#f0f0f0');
  // 列幅
  sheet.setColumnWidth(1, 200); // 案件名
  sheet.setColumnWidth(2, 150); // デザインツール
  sheet.setColumnWidth(3, 300); // プレビュー画像（埋込）
  sheet.setColumnWidth(4, 400); // URL
  return sheet;
}

/**
 * プレビュー結果をシートに書き込み、read-back verify する。
 * @param {Sheet} sheet
 * @param {Array} rows 書き込む行データの配列
 *    各要素: [caseName, toolName, imageFormula, url]
 * @returns {{written: number, verified: number, errors: string[]}}
 */
function writeResultsWithVerify_(sheet, rows) {
  if (!rows.length) {
    return { written: 0, verified: 0, errors: [] };
  }
  var numCols = HEADERS_.length;
  var range = sheet.getRange(2, 1, rows.length, numCols);
  range.setValues(rows);
  SpreadsheetApp.flush();

  // read-back verify
  var errors = [];
  var verified = 0;
  var readBack = sheet.getRange(2, 1, rows.length, numCols).getDisplayValues();
  for (var i = 0; i < rows.length; i++) {
    // 案件名 と URL を検証（IMAGE 数式は getDisplayValues で画像URLが表示されることを確認）
    if (readBack[i][0] !== rows[i][0]) {
      errors.push('行' + (i + 2) + ' 案件名 mismatch: expected="' + rows[i][0] + '" actual="' + readBack[i][0] + '"');
    }
    if (readBack[i][3] !== rows[i][3]) {
      errors.push('行' + (i + 2) + ' URL mismatch: expected="' + rows[i][3] + '" actual="' + readBack[i][3] + '"');
    }
    verified++;
  }
  // 数式の検証: 画像URL列に =IMAGE( が入っているか
  var formulaRange = sheet.getRange(2, 3, rows.length, 1);
  var formulas = formulaRange.getFormulas();
  for (var j = 0; j < formulas.length; j++) {
    var formula = formulas[j][0];
    if (formula && formula.indexOf('=IMAGE') !== 0) {
      errors.push('行' + (j + 2) + ' 画像列の数式が不正: ' + formula);
    }
  }
  return { written: rows.length, verified: verified, errors: errors };
}

// ===== Command エクスポート関数 =====

/**
 * 案件管理シートからURLを巡回し、デザイン一覧シートを作成する。
 * @param {{spreadsheetId?: string, sheetName?: string, urlColumnName?: string, caseName?: string}} args
 * @returns {{ok: boolean, summary: Object, errors: string[]}}
 */
function fetchPreviews(args) {
  args = args || {};

  // スプレッドシートID の上書き
  var ssId = args.spreadsheetId || PropertiesService.getScriptProperties().getProperty(SHEET_ID_KEY_) || '';
  var ss;
  if (ssId) {
    try {
      ss = SpreadsheetApp.openById(ssId);
    } catch (e) {
      return { ok: false, error: 'Spreadsheet を開けません: ' + e.message };
    }
  } else {
    ss = getTargetSpreadsheet_();
    if (ss.error) return { ok: false, error: ss.error };
  }

  // 対象シート
  var sheetName = args.sheetName || '';
  var sheet;
  if (sheetName) {
    sheet = ss.getSheetByName(sheetName);
    if (!sheet) return { ok: false, error: 'シート "' + sheetName + '" が見つかりません' };
  } else {
    // 案件管理らしいシートを自動検出
    var candidates = ['案件管理', '案件一覧', '企画管理', 'Sheet1'];
    for (var s = 0; s < candidates.length; s++) {
      sheet = ss.getSheetByName(candidates[s]);
      if (sheet) break;
    }
    if (!sheet) {
      // 最初のシートを使う
      sheet = ss.getSheets()[0];
    }
    if (!sheet) return { ok: false, error: 'シートが見つかりません' };
  }

  console.log('対象シート: ' + sheet.getName());

  // URL列の検出
  var urlCol = args.urlColumnName
    ? (function() {
        var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
        for (var i = 0; i < headers.length; i++) {
          if (headers[i] && headers[i].indexOf(args.urlColumnName) !== -1) return i + 1;
        }
        return null;
      })()
    : detectUrlColumn_(sheet);

  if (!urlCol) {
    return { ok: false, error: 'URL列が見つかりません。ヘッダー行に "URL" または "企画URL" を含む列が必要です' };
  }

  console.log('URL列: 列' + urlCol);

  // 案件名
  var caseName = args.caseName || detectCaseName_(sheet);
  console.log('案件名: ' + caseName);

  // URL収集
  var urlEntries = collectUrlsFromColumn_(sheet, urlCol);
  console.log('URL件数: ' + urlEntries.length);

  if (!urlEntries.length) {
    return { ok: false, error: 'URLが見つかりませんでした' };
  }

  // デザイン一覧シートの準備
  var designSheet = ensureDesignSheet_(ss);
  console.log('出力シート: ' + designSheet.getName());

  // 各URLを巡回
  var rows = [];
  var previewErrors = [];
  for (var i = 0; i < urlEntries.length; i++) {
    var entry = urlEntries[i];
    var result = fetchPreviewImage_(entry.url);
    var imageFormula = result.previewUrl
      ? '=IMAGE("' + result.previewUrl.replace(/"/g, '""') + '")'
      : '';
    rows.push([caseName, result.toolName, imageFormula, entry.url]);
    if (result.error) {
      previewErrors.push('行' + entry.row + ': ' + entry.url + ' -> ' + result.error);
    }
    // 進捗ログ（10件ごと）
    if ((i + 1) % 10 === 0) {
      console.log('進捗: ' + (i + 1) + '/' + urlEntries.length);
    }
  }

  // 書き込み + read-back verify
  var writeResult = writeResultsWithVerify_(designSheet, rows);

  var summary = {
    totalUrls: urlEntries.length,
    written: writeResult.written,
    verified: writeResult.verified,
    toolNames: unique_(rows.map(function(r) { return r[1]; })),
    previewErrors: previewErrors.length
  };

  return {
    ok: writeResult.errors.length === 0,
    summary: summary,
    errors: writeResult.errors,
    previewErrors: previewErrors
  };
}

function unique_(arr) {
  var seen = {};
  return arr.filter(function(v) {
    if (seen[v]) return false;
    seen[v] = true;
    return true;
  });
}

/**
 * 案件管理シートのURL列一覧を表示する（確認用）。
 * @param {{spreadsheetId?: string, sheetName?: string}} args
 * @returns {{ok: boolean, urls: Array, urlColumn: number|null, caseName: string}}
 */
function listUrls(args) {
  args = args || {};
  var ssId = args.spreadsheetId || PropertiesService.getScriptProperties().getProperty(SHEET_ID_KEY_) || '';
  var ss;
  if (ssId) {
    try { ss = SpreadsheetApp.openById(ssId); } catch (e) {
      return { ok: false, error: e.message };
    }
  } else {
    ss = getTargetSpreadsheet_();
    if (ss.error) return { ok: false, error: ss.error };
  }
  var sheetName = args.sheetName || '';
  var sheet;
  if (sheetName) {
    sheet = ss.getSheetByName(sheetName);
    if (!sheet) return { ok: false, error: 'シート "' + sheetName + '" が見つかりません' };
  } else {
    sheet = ss.getSheets()[0];
  }
  var urlCol = args.urlColumnName
    ? (function() {
        var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
        for (var i = 0; i < headers.length; i++) {
          if (headers[i] && headers[i].indexOf(args.urlColumnName) !== -1) return i + 1;
        }
        return null;
      })()
    : detectUrlColumn_(sheet);
  var caseName = detectCaseName_(sheet);
  var urlEntries = urlCol ? collectUrlsFromColumn_(sheet, urlCol) : [];
  return {
    ok: true,
    sheetName: sheet.getName(),
    urlColumn: urlCol,
    caseName: caseName,
    urls: urlEntries.map(function(e) { return { row: e.row, url: e.url, tool: classifyDesignTool_(e.url) }; })
  };
}

/**
 * 対象スプレッドシートIDを設定する。
 * @param {{spreadsheetId: string}} args
 */
function setSpreadsheetId(args) {
  var id = args && args.spreadsheetId;
  if (!id || typeof id !== 'string' || !id.trim()) throw new Error('spreadsheetId が必要です');
  PropertiesService.getScriptProperties().setProperty(SHEET_ID_KEY_, id.trim());
  return { ok: true, spreadsheetId: id.trim() };
}

/**
 * URL列名を設定する（自動検出を使わず固定する場合）。
 * @param {{columnName: string}} args
 */
function setUrlColumnName(args) {
  var name = args && args.columnName;
  if (!name || typeof name !== 'string' || !name.trim()) throw new Error('columnName が必要です');
  PropertiesService.getScriptProperties().setProperty(URL_COL_NAME_KEY_, name.trim());
  return { ok: true, columnName: name.trim() };
}

/**
 * 現在の設定を表示する。
 */
function describeConfig() {
  var props = PropertiesService.getScriptProperties();
  var sheetId = props.getProperty(SHEET_ID_KEY_);
  var colName = props.getProperty(URL_COL_NAME_KEY_);
  var cmdFolderId = props.getProperty('CMD_FOLDER_ID');
  var result = {
    spreadsheetId: sheetId || '(未設定: setSpreadsheetId で設定 / アクティブなシートを使用)',
    urlColumnName: colName || '(未設定: 自動検出)',
    cmdFolderId: cmdFolderId || '(未設定)',
    triggerCount: ScriptApp.getProjectTriggers().length
  };
  if (sheetId) {
    try {
      var ss = SpreadsheetApp.openById(sheetId);
      result.spreadsheetName = ss.getName();
    } catch (e) {
      result.spreadsheetName = '(開けません: ' + e.message + ')';
    }
  }
  return result;
}

/**
 * 指定URLのプレビュー画像をテスト取得する（単体検証用）。
 * @param {{url: string}} args
 */
function testFetchPreview(args) {
  var url = args && args.url;
  if (!url) throw new Error('url が必要です');
  var result = fetchPreviewImage_(url);
  return {
    ok: !result.error,
    url: url,
    toolName: result.toolName,
    previewUrl: result.previewUrl,
    error: result.error
  };
}