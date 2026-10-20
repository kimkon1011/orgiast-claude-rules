/**
 * 印刷会社へ渡す印刷物チェックシートを、全案件の実施計画と制作フォルダから漏れ優先で生成する。
 */

const PRINT_CHECKLIST_SS_NAME = '【印刷会社様用】印刷物チェックシート';
const PRINT_CHECKLIST_SS_ID_KEY = 'PRINT_CHECKLIST_SS_ID';
const PRINT_CHECKLIST_CURSOR_KEY = 'PRINT_CHECKLIST_CURSOR';
const PRINT_CHECKLIST_LAST_RUN_DATE_KEY = 'PRINT_CHECKLIST_LAST_RUN_DATE';
// 収集の上限。実際は前回の書き込み・同期時間と次の1案件分を5分枠から予約する。
// カーソルは書き込み・同期完了後だけ進める。
const PRINT_CHECKLIST_TIME_LIMIT_MS = 120000;
const PRINT_CHECKLIST_TOTAL_BUDGET_MS = 300000;
const PRINT_CHECKLIST_DESC_ROW = 1;
const PRINT_CHECKLIST_HEADER_ROW = 2;
const PRINT_CHECKLIST_FIRST_DATA_ROW = 3;
const PRINT_CHECKLIST_PRINTER_SHEET = '印刷会社様用';
const PRINT_CHECKLIST_PRINTER_MASTER_SHEET = '印刷会社マスタ';
const PRINT_CHECKLIST_PRINTER_MASTER_HEADERS = ['印刷会社名', '共有メール（カンマ区切り）', '既定（○）', '専用シートURL', '専用シートID', '備考'];
const PRINT_CHECKLIST_DEFAULT_PRINTER = ['プロテック', 'yoshida@kk-protech.jp', '○', '', '', '既存の「印刷会社様用」タブも引き続き使用'];
const PRINT_CHECKLIST_MAIN_SHEET = '印刷物（元データ社内用）';
const PRINT_CHECKLIST_LEGACY_MAIN_SHEET = '印刷物リスト';
const PRINT_CHECKLIST_SUMMARY_SHEET = '案件サマリ';
const PRINT_CHECKLIST_DESIGN_SHEET = 'デザインデータ一覧';
const PRINT_CHECKLIST_PAST_SHEET = '過去案件(参考)';
const PRINT_CHECKLIST_EXCLUDED_SHEET = '対象外(除外済)';
const PRINT_CHECKLIST_EXCLUSION_RULE_SHEET = '除外ルール';
const PRINT_CHECKLIST_GUIDE_SHEET = '凡例・使い方';
const PRINT_CHECKLIST_DESCRIPTIONS = {
  [PRINT_CHECKLIST_PRINTER_MASTER_SHEET]: '【社内用】印刷会社の一覧です。印刷会社を増やすときは、空いている行に「印刷会社名」と「共有メール」を書いてください。翌朝の自動更新で専用シートが作られ、共有メールの人だけが開けるように共有されます。専用シートID・URL は自動で入ります。',
  '印刷会社様用': '【印刷会社様はこのシートをご覧ください】これから入稿するもの（未入稿）と入稿済みのものだけを表示しています。オレンジ色の R〜W 列にご記入ください。毎朝自動更新されますが、ご記入内容は消えません。',
  [PRINT_CHECKLIST_MAIN_SHEET]: '【社内用・全件リスト】自動で拾った印刷物の候補をすべて表示しています。拾ったばかりの行は状態が「未確認」です。印刷するものは B列「状態」を「未入稿」（これから入稿）か「入稿済」に、印刷しないものは「対象外」にしてください。未入稿・入稿済の行だけが「印刷会社様用」シートに載ります（毎朝更新）。入稿データ（校了データ）は、AA列「制作物一覧リンク」から各案件の実施計画書「制作物一覧」を開き、「校了ﾃﾞｰﾀ」列にリンクを貼ってください。翌朝の自動更新で N列「デザインデータ」に反映されます。詳しい更新方法は「凡例・使い方」タブ先頭の更新マニュアルを見てください。AB列「印刷会社」で、どの印刷会社の専用シートに載せるかを選べます。',
  '案件サマリ': '【社内用】案件ごとの印刷物の件数と棚卸しの状況です。自動で作られるので手で書き込まないでください。',
  'デザインデータ一覧': '【参考】各案件の実施計画書「制作物一覧」から拾ったデザインデータの一覧です。自動で作られます。',
  '過去案件(参考)': '【参考】会期が終わった案件の印刷物です。自動で作られます。',
  '対象外(除外済)': '【社内用】印刷しないと判断した行の保管場所です。間違えて入れた行は Z列「社内確認(PD)」を「復活」にすると、翌朝「' + PRINT_CHECKLIST_MAIN_SHEET + '」に状態「未確認」で戻ります。',
  '除外ルール': '【社内用・自動管理】対象外にした品名を覚えておく表です。手で編集しないでください（戻すときは「対象外(除外済)」シートの Z列を「復活」に）。',
  '凡例・使い方': 'このファイルの使い方と各列の意味です。印刷会社様は「印刷会社様用」シートだけご覧ください。'
};
// 「🐛 不具合・要望」フォーム(GAS Web アプリ)の /exec URL。Admin_setFeedbackRelay の第4引数で入れる。
const PRINT_CHECKLIST_FORM_URL_KEY = 'FEEDBACK_FORM_URL';
const PRINT_CHECKLIST_FORM_APP_NAME = '印刷物チェックシート';
// 誰でも読める更新マニュアル（Google ドキュメント、orgiast.jp ドメイン閲覧可）。2026-10-09 kim 依頼。
const PRINT_CHECKLIST_MANUAL_URL = 'https://docs.google.com/a/orgiast.jp/document/d/1mKOXPBz_wariZ_jXGukl_aV8DPa0a_q1SqjhYEm3zjg/edit';
const PRINT_CHECKLIST_MANUAL_TEXT = '📘 更新マニュアル（印刷物の追加・入稿データの貼り方・更新方法）はこちら';
const PRINT_CHECKLIST_TZ = 'Asia/Tokyo';
const PRINT_CHECKLIST_HEADERS = [
  '印刷ID', '状態', '案件ID', 'クライアント名', '案件名', '会期', '会期初日', '印刷締切目安',
  '区分', '品名', 'サイズ', '数量', '仕様・加工', 'デザインデータ', 'データ有無', '発生源',
  '備考', '受領', 'データ確認', '印刷予定日', '納品予定日', '御社担当者', '印刷会社メモ',
  'AIへの指示', '最終更新', '社内確認(PD)', '制作物一覧リンク', '印刷会社'
];
const PRINT_CHECKLIST_EXCLUSION_RULE_HEADERS = [
  'ルールID', '対象 (この案件のみ|全案件)', '案件ID', '品名パターン', '追加日時', '由来の印刷ID'
];
const PRINT_CHECKLIST_PRESERVED_HEADERS = ['状態', '受領', 'データ確認', '印刷予定日', '納品予定日', '御社担当者', '印刷会社メモ', 'AIへの指示', '社内確認(PD)', '印刷会社'];
const PRINT_CHECKLIST_PD_REVIEW_VALUES = ['未確認', '確認済', '対象外', '復活'];
const PRINT_CHECKLIST_PD_REVIEW_COL = 25;
const PRINT_CHECKLIST_PD_CACHE_KEY = 'pcPdReview:v2';
const PRINT_CHECKLIST_PD_ASOF_KEY = 'PRINT_CHECKLIST_PD_ASOF';
const PRINT_CHECKLIST_STATUS_VALUES = ['未確認', '未入稿', '入稿済', '印刷手配済', '印刷完了', '発送済', '対象外'];
const PRINT_CHECKLIST_DATA_CHECK_VALUES = ['未確認', 'OK', '要修正', 'データ不足'];
const PRINT_CHECKLIST_SUMMARY_HEADERS = [
  '案件ID', 'クライアント', '案件名', '会期', '印刷締切目安', '印刷物件数', 'データあり件数',
  'データなし件数', '未入稿件数', '実施計画書リンク', '制作物一覧リンク', '制作フォルダリンク', '備考', '棚卸し未確認件数'
];
const PRINT_CHECKLIST_DESIGN_HEADERS = ['案件ID', 'クライアント', '入稿確度(高/中/低)', '直上フォルダ', 'ファイル名', '種別(拡張子)',
  '更新日', '主表とのマッチ(済/未)', 'リンク'];
const PRINT_CHECKLIST_MAX_ITEM_ROWS = 3000;
const PRINT_CHECKLIST_DESIGN_MAX_FILES = 400;
const PRINT_CHECKLIST_DESIGN_TIME_LIMIT_MS = 25000;
const PRINT_CHECKLIST_DESIGN_PROPERTY_TTL_MS = 24 * 60 * 60 * 1000;
const PRINT_CHECKLIST_DESIGN_PROPERTY_MAX_BYTES = 9000;
// 実フォルダ名は「03ネガチェック・打合せ資料」「見積り（社外見積もり）」のように後ろが続くので前方一致で判定する。
// 完全一致にすると除外が効かず、走査上限(400件)をノイズで食い潰して本命の入稿データが truncate で落ちる。
const PRINT_CHECKLIST_DESIGN_SKIP_RE = /^(?:当日写真|当日映像|06アフターフォロー|03ネガチェック|見積|バックアップ)/;
const PRINT_CHECKLIST_CATEGORY_RULES = [
  ['バックパネル', /バックパネル|背面|メインパネル|壁面|隣接壁|側壁|壁グラフィック/i],
  ['ポスター', /ポスター|(?:^|[^a-z0-9])(?:A0|A1|A2|A3|B0|B1|B2)(?:[^a-z0-9]|$)|パネル|ボードパネル|スチレン/i],
  ['バナー・幕', /バナー|タペストリー|のぼり|幟|横断幕|懸垂幕|垂れ幕|幕|ターポリン|トロマット|クロス|ロールアップ|バナースタンド|Xバナー/i],
  ['看板・サイン', /看板|案内板|サイン|標識|社名|表示板|切り文字|切文字|カッティング|カルプ|司会台|演台/i],
  ['名札・カード', /名札|ネームプレート|スタッフ証|来場者証|入館証|名刺|番号札|テーブル名札|テーブル番号札|席札/i],
  ['紙モノ', /チラシ|フライヤー|リーフレット|パンフ|カタログ|冊子|POP|ポップ|プライスカード|アンケート|許可証|証明書|マニュアル|台本|進行表/i],
  ['その他印刷物', /印刷|出力|インクジェット|ラミネート|シート|ステッカー|シール|グラフィック|デザイン|データ|入稿|掲示/i]
];

// AB列「印刷会社」の空欄を補う既定ルール（2026-10-18 W2 要望）。
// 大判の合成紙は看板宝屋、LED UP の印刷物はプロテックに出す運用が実際の受発注と一致している。
// 人が AB 列に書いた値は絶対に上書きしない（空欄のときだけ補う）。
const PRINT_CHECKLIST_PRINTER_RULES = [
  ['看板宝屋', /合成紙/],
  ['プロテック', /LED\s*UP|LEDUP/i]
];

// 名前だけを変更し、既存gidと保護オブジェクトを継続利用する。
function _PrintChecklist_migrateMainSheet(ss) {
  const legacy = ss.getSheetByName(PRINT_CHECKLIST_LEGACY_MAIN_SHEET);
  const current = ss.getSheetByName(PRINT_CHECKLIST_MAIN_SHEET);
  if (legacy && current) return { warnings: ['旧タブ「' + PRINT_CHECKLIST_LEGACY_MAIN_SHEET +
    '」が残っています。正本は「' + PRINT_CHECKLIST_MAIN_SHEET + '」です。旧タブは削除していません。'] };
  if (legacy && !current) {
    legacy.setName(PRINT_CHECKLIST_MAIN_SHEET);
    // 保護の識別名も追従させる。再生成による重複追加を避け、保護ID・範囲・権限を保持する。
    const prefix = 'PrintChecklist:' + PRINT_CHECKLIST_LEGACY_MAIN_SHEET + ':';
    legacy.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(function (p) {
      const description = p.getDescription() || '';
      if (description.indexOf(prefix) === 0) {
        p.setDescription('PrintChecklist:' + PRINT_CHECKLIST_MAIN_SHEET + ':' + description.slice(prefix.length));
      }
    });
  }
  return { warnings: [] };
}

// 各段階の開始を先に保存する。強制終了でも最後の段階を読み取り専用診断で確認できる。
let _printChecklistTiming = null;
function _PrintChecklist_writeReserve(previous) {
  const tail = (previous || []).filter(function (t) { return ['writeAll', 'syncPrinterFiles', 'recordNewPending'].indexOf(t.stage) >= 0; });
  return tail.length === 3 && tail.every(function (t) { return typeof t.ms === 'number' && !t.error; })
    ? Math.max(60000, Math.ceil(tail.reduce(function (n, t) { return n + t.ms; }, 0) * 1.3)) : 120000;
}
function _PrintChecklist_collectionBudget(previous, current) {
  const caseReserve = Math.max(15000, Math.ceil((previous || []).concat(current || []).reduce(function (n, t) {
    return t.stage.indexOf('collect:') === 0 && typeof t.ms === 'number' ? Math.max(n, t.ms) : n;
  }, 0) * 1.3));
  return Math.max(0, Math.min(PRINT_CHECKLIST_TIME_LIMIT_MS, PRINT_CHECKLIST_TOTAL_BUDGET_MS - _PrintChecklist_writeReserve(previous) - caseReserve));
}

// GAS の同期 RPC は途中キャンセルできない。各 RPC / 行 / フォルダの間で止め、後段の予約を守る。
let _printChecklistReadDeadline = null;
let _printChecklistPrimaryProgress = null;
function _PrintChecklist_checkReadBudget() {
  if (_printChecklistReadDeadline !== null && Date.now() >= _printChecklistReadDeadline) {
    const error = new Error('[前回結果を使用: 読取時間超過]'); error.printReadTimeout = true; throw error;
  }
}
const PRINT_CHECKLIST_CASE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// 収集ロジック（印刷物キーワード・列検出など）を変えたらこの値を上げる。
// 案件キャッシュの署名に含めないと、修正しても最長7日間は古い収集結果が使われて直らない。
const PRINT_CHECKLIST_COLLECT_RULES_VERSION = '2026-10-18.1';
function _PrintChecklist_cacheSignature(c) {
  return JSON.stringify([PRINT_CHECKLIST_COLLECT_RULES_VERSION, c.zissiId || '', c.clientName || '', c.caseName || '', c.startDate || '', c.endDate || '', c.folderId || '', c.projectFolderId || '']);
}
function _PrintChecklist_modifiedTime(c) {
  if (!c.zissiId) return 'no-zissi';
  if (typeof Drive !== 'undefined' && Drive.Files) {
    try {
      const value = Drive.Files.get(c.zissiId, { fields: 'modifiedTime' }).modifiedTime;
      if (value) return value;
    } catch (e) { /* DriveApp fallback */ }
  }
  return DriveApp.getFileById(c.zissiId).getLastUpdated().toISOString();
}
function _PrintChecklist_cacheJson(value) {
  return JSON.stringify(value, function (key, v) {
    return this[key] instanceof Date ? { printDate: this[key].toISOString() } : v;
  });
}
function _PrintChecklist_readCaseCache(c) {
  const id = PropertiesService.getScriptProperties().getProperty('pc_case_file_' + c.caseId);
  if (!id) return null;
  try {
    const saved = JSON.parse(DriveApp.getFileById(id).getBlob().getDataAsString(), function (key, v) {
      return v && typeof v === 'object' && v.printDate ? new Date(v.printDate) : v;
    });
    return saved.version === 1 && Array.isArray(saved.rows) && Array.isArray(saved.designRows) ? saved : null;
  } catch (e) { return null; }
}
function _PrintChecklist_saveCaseCache(c, saved) {
  const props = PropertiesService.getScriptProperties(), key = 'pc_case_file_' + c.caseId;
  const json = _PrintChecklist_cacheJson(saved), id = props.getProperty(key);
  if (id) {
    try { DriveApp.getFileById(id).setContent(json); return; } catch (e) { /* deleted cache: recreate */ }
  }
  let folder, folderId = props.getProperty('pc_case_cache_folder');
  if (folderId) { try { folder = DriveApp.getFolderById(folderId); } catch (e) { /* recreate */ } }
  if (!folder) {
    const root = DriveApp.getFolderById(APP_ROOT_FOLDER_ID), found = root.getFoldersByName('print-checklist-cache');
    folder = found.hasNext() ? found.next() : root.createFolder('print-checklist-cache');
    props.setProperty('pc_case_cache_folder', folder.getId());
  }
  const found = folder.getFilesByName(c.caseId + '.json');
  const file = found.hasNext() ? found.next().setContent(json) : folder.createFile(c.caseId + '.json', json, 'application/json');
  props.setProperty(key, file.getId());
}
function _PrintChecklist_cacheReusable(saved, c, modifiedTime, now) {
  return !!(saved && !saved.pendingPrimary && modifiedTime && saved.modifiedTime === modifiedTime && saved.signature === _PrintChecklist_cacheSignature(c) &&
    Number(saved.collectedAt) <= now && now - Number(saved.collectedAt) < PRINT_CHECKLIST_CASE_CACHE_TTL_MS);
}
function _PrintChecklist_designCacheValid(saved, c, now) {
  // 上限到達も明示付きの走査結果。旧キャッシュの0は収集開始時刻で保守的に補う。
  const scannedAt = saved && (saved.designScannedAt || (saved.truncated ? saved.collectedAt : 0));
  if (scannedAt && Number(scannedAt) <= now && now - Number(scannedAt) < PRINT_CHECKLIST_DESIGN_PROPERTY_TTL_MS) return true;
  try {
    const old = JSON.parse(PropertiesService.getScriptProperties().getProperty('pc_design_' + c.caseId) || 'null');
    return !!(old && old.result && now - Number(old.scannedAt) < PRINT_CHECKLIST_DESIGN_PROPERTY_TTL_MS);
  } catch (e) { return false; }
}
function _PrintChecklist_collectCached(c, existing, deadline) {
  const saved = _PrintChecklist_readCaseCache(c);
  const modifiedTime = _PrintChecklist_modifiedTime(c), now = Date.now();
  if (_PrintChecklist_cacheReusable(saved, c, modifiedTime, now) && _PrintChecklist_designCacheValid(saved, c, now)) {
    saved.cacheHit = true;
    return saved;
  }
  _printChecklistPrimaryProgress = saved && saved.pendingPrimary && now - Number(saved.collectedAt) < PRINT_CHECKLIST_CASE_CACHE_TTL_MS && saved.modifiedTime === modifiedTime &&
    saved.signature === _PrintChecklist_cacheSignature(c) ? saved.pendingPrimary : null;
  const collectedAt = _printChecklistPrimaryProgress ? Number(saved.collectedAt) : now;
  _printChecklistReadDeadline = Math.min(deadline, now + PRINT_CHECKLIST_TIME_LIMIT_MS);
  try {
    _PrintChecklist_checkReadBudget();
    if (_PrintChecklist_cacheReusable(saved, c, modifiedTime, now)) {
      // フォルダの24h期限だけが切れても、7日以内の実施計画書は開き直さない。
      const design = _PrintChecklist_timed('case:' + c.caseId + ':design', function () { return _PrintChecklist_collectDesignFiles(c); });
      _PrintChecklist_checkReadBudget();
      const refreshed = Object.assign({}, saved, { designRows: design.files.map(function (p) {
        const matched = saved.rows.some(function (r) { return _PrintChecklist_namesMatch(r[9], p.name); });
        return [c.caseId, c.clientName || '', p.conf, p.parent, p.name, p.ext, p.updated, matched ? '済' : '未', p.url];
      }), designScannedAt: design.scannedAt || now, truncated: design.truncated });
      _PrintChecklist_saveCaseCache(c, refreshed);
      refreshed.cacheHit = true;
      return refreshed;
    }
    const result = _PrintChecklist_collectCase(c, false);
    _PrintChecklist_checkReadBudget();
    // 読取中にソースが編集された結果は再利用可能なキャッシュにしない。
    if (_PrintChecklist_modifiedTime(c) === modifiedTime) {
      const entry = { version: 1, signature: _PrintChecklist_cacheSignature(c), modifiedTime: modifiedTime, collectedAt: collectedAt,
        designScannedAt: result.designScannedAt || now, rows: result.rows, designRows: result.designRows,
        kouryouLink: result.kouryouLink, notes: result.notes, truncated: result.truncated };
      _PrintChecklist_saveCaseCache(c, entry);
    }
    return result;
  } catch (e) {
    if (!e.printReadTimeout) throw e;
    const progress = e.primaryProgress || _printChecklistPrimaryProgress;
    if (progress && progress.values) {
      _PrintChecklist_saveCaseCache(c, { version: 1, signature: _PrintChecklist_cacheSignature(c), modifiedTime: modifiedTime,
        collectedAt: collectedAt, pendingPrimary: progress, rows: saved ? saved.rows : [], designRows: saved ? saved.designRows : [] });
    }
    // 部分的に収集した行は reconcile へ渡さない。現行表を保ち、次の案件へ進む。
    return { rows: [], designRows: [], retainExisting: true, readTimeout: true, resumePending: !!(progress && progress.values),
      notes: ['[前回結果を使用: 読取時間超過]'] };
  } finally { _printChecklistReadDeadline = null; _printChecklistPrimaryProgress = null; }
}

function _PrintChecklist_timed(name, run, flush) {
  const timing = _printChecklistTiming;
  if (!timing) return run();
  if (name.indexOf('case:') === 0) _PrintChecklist_checkReadBudget();
  const entry = { stage: name, startMs: Date.now() - timing.started };
  timing.timings.push(entry);
  const save = function () {
    const entries = timing.timings.slice(-60);
    let json;
    do {
      json = JSON.stringify({ startedAt: timing.startedAt, elapsedMs: Date.now() - timing.started,
        timings: entries, omitted: timing.timings.length - entries.length });
      // 日本語のAPIエラーを含んでもPropertiesの1値9KBを超えない。
      if (encodeURIComponent(json).replace(/%[A-F0-9]{2}/g, 'x').length <= 8000 || entries.length <= 1) break;
      entries.shift();
    } while (true);
    PropertiesService.getScriptProperties().setProperty('PRINT_CHECKLIST_LAST_TIMINGS', json);
  };
  save();
  try {
    const result = run();
    if (flush) SpreadsheetApp.flush();
    return result;
  } catch (e) { entry.error = String(e.message || e).slice(0, 200); throw e; }
  finally { entry.ms = Date.now() - timing.started - entry.startMs; save(); }
}

function PrintChecklist_build(opts) {
  const started = Date.now();
  let previous = null;
  try { previous = JSON.parse(PropertiesService.getScriptProperties().getProperty('PRINT_CHECKLIST_LAST_TIMINGS') || 'null'); } catch (e) { /* 初回の既定予算 */ }
  _printChecklistTiming = { started: started, startedAt: new Date(started).toISOString(), timings: [], previous: previous && previous.timings || [] };
  try {
    const result = _PrintChecklist_buildTimed(opts);
    result.timings = _printChecklistTiming.timings;
    result.collectionBudgetMs = _PrintChecklist_collectionBudget(_printChecklistTiming.previous, _printChecklistTiming.timings);
    result.elapsedMs = Date.now() - started;
    return result;
  } finally { _printChecklistTiming = null; }
}

function _PrintChecklist_buildTimed(opts) {
  opts = opts || {};
  const started = Date.now();
  const props = PropertiesService.getScriptProperties();
  const explicitIds = Array.isArray(opts.caseIds) && opts.caseIds.length ? opts.caseIds.map(String) : null;
  const cases = _PrintChecklist_timed('getCases', function () { return _PrintChecklist_getCases(explicitIds); });
  let index = explicitIds ? 0 : Math.max(0, Number(props.getProperty(PRINT_CHECKLIST_CURSOR_KEY)) || 0);
  if (index >= cases.length) index = 0;
  const ss = _PrintChecklist_getOrCreateSpreadsheet();
  const sheetMigration = _PrintChecklist_migrateMainSheet(ss);
  const existing = _PrintChecklist_timed('readExisting', function () { return _PrintChecklist_readExisting(ss); });
  const master = _PrintChecklist_readPrinterMaster(ss);
  const rulePrintersAdded = _PrintChecklist_ensureRulePrinters(ss, master);
  const printerWriteBack = _PrintChecklist_timed('writeBack', function () { return _PrintChecklist_writeBackAllPrinters(ss, existing, master); });
  const exclusionRules = _PrintChecklist_readExclusionRules(ss);
  const restoration = _PrintChecklist_applyRestore(existing.rows, exclusionRules, new Date());
  _PrintChecklist_applyPdReview(existing.rows, new Date());
  _PrintChecklist_learnExclusionRules(existing.rows, exclusionRules, new Date());
  const processedIds = {};
  const caseLinks = {};
  const freshRows = [];
  const freshDesign = [];
  const scanNotes = {};
  const errors = [];
  let processed = 0, cacheHits = 0, readTimeouts = 0;
  const writeReserve = _PrintChecklist_writeReserve(_printChecklistTiming.previous);
  const readDeadline = started + PRINT_CHECKLIST_TOTAL_BUDGET_MS - writeReserve - 15000;

  for (; index < cases.length; index++) {
    if (processed > 0 && Date.now() - started >= _PrintChecklist_collectionBudget(_printChecklistTiming.previous, _printChecklistTiming.timings)) break;
    if (Date.now() >= readDeadline) break;
    const c = cases[index];
    try {
      const collected = _PrintChecklist_timed('collect:' + c.caseId, function () { return _PrintChecklist_collectCached(c, existing, readDeadline); });
      if (collected.cacheHit) cacheHits++;
      if (collected.readTimeout) readTimeouts++;
      if (collected.retainExisting) {
        existing.rows.forEach(function (r) { if (String(r[2]) === c.caseId) r[16] = _PrintChecklist_uniqueLines(r[16], '[前回結果を使用: 読取時間超過]'); });
        scanNotes[c.caseId] = collected.notes.join(' / ');
        processed++;
        if (collected.resumePending) break; // 保存済みの列の次から、同じ案件を次tickで再開する。
        continue;
      }
      existing.rows.forEach(function (r) {
        if (String(r[2]) === c.caseId) r[16] = String(r[16] || '').split('\n').filter(function (note) { return note !== '[前回結果を使用: 読取時間超過]'; }).join('\n');
      });
      Array.prototype.push.apply(freshRows, collected.rows);
      Array.prototype.push.apply(freshDesign, collected.designRows);
      const notes = (collected.notes || []).slice();
      if (collected.truncated) notes.push('デザインデータ走査を上限で打ち切り');
      if (notes.length) scanNotes[c.caseId] = notes.join(' / ');
      processedIds[c.caseId] = true;
      const link = collected.kouryouLink;
      caseLinks[c.caseId] = { zissiId: c.zissiId, gid: link ? link.gid : null, col: link ? link.col : -1 };
    } catch (e) {
      errors.push({ caseId: c.caseId, message: String(e && e.message ? e.message : e) });
    }
    processed++;
  }

  if (Date.now() - started + writeReserve >= PRINT_CHECKLIST_TOTAL_BUDGET_MS) {
    if (!explicitIds) props.setProperty(PRINT_CHECKLIST_CURSOR_KEY, String(Math.max(0, Number(props.getProperty(PRINT_CHECKLIST_CURSOR_KEY)) || 0)));
    return { ok: true, deferredWrite: true, partial: true, cases: processed, cacheHits: cacheHits, readTimeouts: readTimeouts,
      nextIndex: explicitIds ? 0 : Number(props.getProperty(PRINT_CHECKLIST_CURSOR_KEY)), errors: errors };
  }
  const now = new Date();
  const reconciliation = _PrintChecklist_timed('reconcile', function () { return _PrintChecklist_reconcileRows(existing, freshRows, processedIds, exclusionRules, now); });
  const merged = reconciliation.rows;
  // ソース消滅として保持された旧行も、処理済み案件なら最新の追記先へ案内する。
  merged.forEach(function (r) {
    const link = caseLinks[String(r[2])];
    if (!link) return;
    const match = String(r[15] || '').match(/制作物一覧\(行(\d+)\)/);
    r[26] = _PrintChecklist_seisakubutsuUrl(link.zissiId, link.gid, link.col, match ? Number(match[1]) : null);
  });
  _PrintChecklist_applyPdReview(merged, now);
  // AB列（印刷会社）が空の行に既定ルールを適用する。人の記入がある行は触らない。
  const printerRuleAssigned = _PrintChecklist_applyPrinterRules(merged, master);
  merged.sort(_PrintChecklist_compareRows);

  const pendingInstructions = _PrintChecklist_pendingInstructions(merged);

  const designRows = existing.designRows.filter(function (row) { return !processedIds[String(row[0] || '')]; });
  Array.prototype.push.apply(designRows, freshDesign);
  const errorMap = _PrintChecklist_readErrorMap(ss);
  Object.keys(processedIds).forEach(function (caseId) { delete errorMap[caseId]; });
  errors.forEach(function (x) { errorMap[x.caseId] = x.message; });
  const written = _PrintChecklist_timed('writeAll', function () { return _PrintChecklist_writeAll(ss, merged, designRows, cases, errorMap, scanNotes, now, exclusionRules, pendingInstructions, master); }, true);
  const printerFiles = _PrintChecklist_timed('syncPrinterFiles', function () { return _PrintChecklist_syncPrinterFiles(ss, written.mainRows, master); }, true);

  _PrintChecklist_timed('recordNewPending', function () { return _PrintChecklist_recordNewPending(ss, existing.rows); });

  const partial = index < cases.length;
  if (!explicitIds && partial) {
    props.setProperty(PRINT_CHECKLIST_CURSOR_KEY, String(index));
  } else if (!explicitIds) {
    props.deleteProperty(PRINT_CHECKLIST_CURSOR_KEY);
    props.setProperty(PRINT_CHECKLIST_LAST_RUN_DATE_KEY, Utilities.formatDate(now, PRINT_CHECKLIST_TZ, 'yyyy/MM/dd'));
  }
  const counts = _PrintChecklist_counts(merged, designRows);
  return {
    ok: true, ssId: ss.getId(), url: _PrintChecklist_ssUrl(ss.getId()), cases: processed, cacheHits: cacheHits, readTimeouts: readTimeouts,
    rows: counts.rows, missingData: counts.missingData, unmatchedFiles: counts.unmatchedFiles,
    elapsedMs: Date.now() - started, partial: partial, nextIndex: partial ? index : null, errors: errors,
    pendingInstructions: pendingInstructions,
    migrated: reconciliation.migrated, mergedDuplicates: reconciliation.mergedDuplicates,
    restored: restoration.restored, restoreBlocked: restoration.restoreBlocked,
    printerViewRows: written.printerViewRows, printerWriteBack: printerWriteBack.updated,
    printerWriteBackIgnored: printerWriteBack.ignored, printerFiles: printerFiles,
    printerRuleAssigned: printerRuleAssigned, printerRulePrintersAdded: rulePrintersAdded,
    warnings: sheetMigration.warnings.concat(printerWriteBack.warnings)
  };
}

/** 一度限りの未整理行移行。再実行しても対象は増えない。 */
function _admin_printChecklistResetUnreviewed(opts) {
  opts = opts || {};
  const id = PropertiesService.getScriptProperties().getProperty(PRINT_CHECKLIST_SS_ID_KEY);
  if (!id) throw new Error('印刷物チェックシートが未設定です');
  const ss = SpreadsheetApp.openById(id);
  const existing = _PrintChecklist_readExisting(ss);
  // 元データ側に入力がある場合も保護する。ビューの空欄で判定を緩めない。
  const before = {};
  existing.rows.forEach(function (r) { before[String(r[0])] = r.slice(); });
  _PrintChecklist_writeBackAllPrinters(ss, existing, _PrintChecklist_readPrinterMaster(ss));
  const empty = function (v) { return v === '' || v === null || v === undefined; };
  const hasInput = function (r) {
    // R〜Wは共通判定。X列の社内指示も従来どおり移行から保護する。
    return _PrintChecklist_hasPrinterInput(r) || !empty(r[23]);
  };
  const targets = [];
  let skippedWithPrinterInput = 0;
  existing.rows.forEach(function (r) {
    const old = before[String(r[0])];
    if (!existing.mainIds[String(r[0])] || old[1] !== '未入稿' || old[25] !== '未確認' ||
        r[1] !== '未入稿' || r[25] !== '未確認') return;
    if (hasInput(old) || hasInput(r)) { skippedWithPrinterInput++; return; }
    targets.push(r);
  });
  if (opts.dryRun === true) return { changed: targets.length, skippedWithPrinterInput: skippedWithPrinterInput,
    printIds: targets.slice(0, 20).map(function (r) { return r[0]; }) };
  const now = new Date();
  targets.forEach(function (r) { r[1] = '未確認'; r[24] = now; });
  // 書き戻し後に移行し、同じデータから全タブを再生成する。外部ソースの再走査は不要。
  const written = _PrintChecklist_writeAll(ss, existing.rows, existing.designRows, _PrintChecklist_getCases(null),
    _PrintChecklist_readErrorMap(ss), {}, now, _PrintChecklist_readExclusionRules(ss),
    _PrintChecklist_pendingInstructions(existing.rows));
  return { changed: targets.length, skippedWithPrinterInput: skippedWithPrinterInput,
    printerViewRowsAfter: written.printerViewRows };
}

function PrintChecklist_buildOne(caseId) {
  return PrintChecklist_build({ caseIds: [String(caseId || '')] });
}

function PrintChecklist_menuBuild() {
  const result = PrintChecklist_build({});
  try {
    SpreadsheetApp.getUi().alert(
      result.partial ? '印刷物チェックシートを途中まで更新しました（自動継続します）' : '印刷物チェックシートを更新しました',
      result.url,
      SpreadsheetApp.getUi().ButtonSet.OK
    );
  } catch (e) { /* トリガーやコマンドキューには UI がない */ }
  return result;
}

function PrintChecklist_installTrigger() {
  let triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function (t) {
    const handler = t.getHandlerFunction();
    if (handler === 'PrintChecklist_build' || handler === 'PrintChecklist_resumeBuild') ScriptApp.deleteTrigger(t);
  });
  triggers = ScriptApp.getProjectTriggers();
  const tickTriggers = triggers.filter(function (t) { return t.getHandlerFunction() === 'PrintChecklist_tick'; });
  tickTriggers.slice(1).forEach(function (t) { ScriptApp.deleteTrigger(t); });
  if (tickTriggers.length) return { ok: true, alreadyExists: true };
  try {
    ScriptApp.newTrigger('PrintChecklist_tick').timeBased().everyMinutes(10).create();
    return { ok: true, alreadyExists: false };
  } catch (e) {
    return { ok: false, reason: 'trigger-limit', triggerCount: ScriptApp.getProjectTriggers().length };
  }
}

function PrintChecklist_tick() {
  // コマンドキューも同じScriptLockを保持する。並行ビルドが古い入力を戻すのを防ぐ。
  const lock = LockService.getScriptLock();
  const alreadyLocked = lock.hasLock();
  if (!alreadyLocked && !lock.tryLock(0)) return { ok: true, skipped: true, reason: 'busy' };
  try {
    const props = PropertiesService.getScriptProperties();
    if (props.getProperty(PRINT_CHECKLIST_CURSOR_KEY) !== null) return PrintChecklist_build({});
    const now = new Date();
    const today = Utilities.formatDate(now, PRINT_CHECKLIST_TZ, 'yyyy/MM/dd');
    const hour = Number(Utilities.formatDate(now, PRINT_CHECKLIST_TZ, 'H'));
    if (hour < 6 || props.getProperty(PRINT_CHECKLIST_LAST_RUN_DATE_KEY) === today) {
      return { ok: true, skipped: true };
    }
    return PrintChecklist_build({});
  } finally {
    if (!alreadyLocked) lock.releaseLock();
  }
}

function _debug_listTriggers() {
  const triggers = ScriptApp.getProjectTriggers().map(function (t) {
    const handler = t.getHandlerFunction();
    const item = {
      handler: handler,
      type: String(t.getEventType()),
      uniqueId: t.getUniqueId()
    };
    if (handler === 'PrintChecklist_tick') item.everyMinutes = 10;
    return item;
  });
  return { total: triggers.length, triggers: triggers };
}

function _debug_printChecklistCase(caseId) {
  const c = CaseList_getById(String(caseId || ''));
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  const result = _PrintChecklist_collectCase(c, true);
  const out = {
    caseId: c.caseId,
    itemSheetName: result.debug.itemListSheet,
    headerRow: result.debug.headerRow,
    cols: result.debug.columns,
    itemRowsTotal: result.debug.itemRowsTotal,
    itemRowsAdopted: result.debug.itemRowsAdopted,
    adoptedBy: result.debug.adoptedBy,
    itemSamples: result.debug.itemSamples,
    designRoot: result.debug.designRoot,
    designFilesTotal: result.debug.designFilesTotal,
    designByConfidence: result.debug.designByConfidence,
    designSamples: result.debug.designSamples,
    seisakubutsu: result.debug.seisakubutsu,
    // 「校了データがN列に反映されない」調査はここを見れば1回で済む(検出列・ヘッダー行・拾えた件数)。
    kouryou: result.debug.kouryou,
    kouryouError: result.debug.kouryouError || '',
    notes: result.notes || [],
    truncated: result.truncated,
    elapsedMs: result.debug.elapsedMs
  };
  // 壁面系の項目が収集結果に載っているかを、ヘッドレスから読める目印にも残す。
  try {
    out.wallRows = (result.rows || []).filter(function (r) {
      return /隣接壁|側壁|壁面/.test(String(r[9] || '') + ' ' + String(r[12] || '') + ' ' + String(r[16] || ''));
    }).slice(0, 20).map(function (r) {
      return String(r[9] || '').slice(0, 30) + '|' + String(r[10] || '') + '|' + String(r[1] || '');
    });
    const summary = { caseId: c.caseId, itemSheetName: out.itemSheetName, headerRow: out.headerRow,
      itemRowsTotal: out.itemRowsTotal, itemRowsAdopted: out.itemRowsAdopted, adoptedBy: out.adoptedBy,
      itemSamples: out.itemSamples, wallRows: out.wallRows, notes: out.notes, elapsedMs: out.elapsedMs };
    const folder = DriveApp.getFolderById(CMD_FOLDER_ID);
    const f = folder.createFile('cm_' + c.caseId + '_' + new Date().toISOString().replace(/[:.]/g, '-') + '.txt',
      JSON.stringify(summary), MimeType.PLAIN_TEXT);
    try { f.setDescription(JSON.stringify(summary).slice(0, 8000)); } catch (e2) { /* best-effort */ }
  } catch (eMarker) { out.markerError = String(eMarker && eMarker.message ? eMarker.message : eMarker); }
  return out;
}

// CaseList_getById は毎回 getDataRange().getValues() を走らせるので、1 実行につき 1 回だけ全案件を
// 引き当ててメモ化する(素朴に呼ぶと build 1 回で 80 回シートを読み直して数十秒を捨てる)。
let _printChecklistCaseCache = null;

function _PrintChecklist_getCases(caseIds) {
  if (!_printChecklistCaseCache) {
    let base = [];
    if (typeof CASE_LIST_SHEET_NAME !== 'undefined') {
      // CaseList_getByIdを案件数だけ呼ぶと同じ表を数十回読み直す（実測24〜32秒）。
      const sheet = SpreadsheetApp.getActive().getSheetByName(CASE_LIST_SHEET_NAME);
      const data = sheet ? sheet.getDataRange().getValues() : [];
      const date = function (v, pattern) { return v instanceof Date ? Utilities.formatDate(v, PRINT_CHECKLIST_TZ, pattern || 'yyyy/MM/dd') : String(v || ''); };
      base = data.slice(1).map(function (r, i) {
        return { rowIndex: i + 2, caseId: String(r[0] || '').trim(), clientName: String(r[1] || ''),
          caseName: String(r[2] || ''), startDate: date(r[3]), endDate: date(r[4]), boothSize: String(r[5] || ''),
          phase: Number(r[6]) || 1, unresolvedCount: Number(r[7]) || 0, folderId: String(r[8] || ''),
          updatedAt: date(r[9], 'yyyy/MM/dd HH:mm'), zissiId: String(r[10] || ''), projectFolderId: String(r[11] || ''),
          masterSsId: String(r[12] || ''), masterCol: Number(r[13]) || 0 };
      });
    } else {
      if (typeof CaseList_getAll === 'function') base = CaseList_getAll() || [];
      else if (typeof CaseList_listAll === 'function') base = CaseList_listAll() || [];
      base = base.map(function (x) { return CaseList_getById(x.caseId) || x; });
    }
    _printChecklistCaseCache = base.filter(function (c) {
      if (!c || !c.caseId) return false;
      return !/(?:テスト|TEST|__DELETED)/i.test(String(c.clientName || '') + ' ' + String(c.caseName || ''));
    });
  }
  if (!caseIds) return _printChecklistCaseCache;
  const wanted = caseIds.reduce(function (m, id) { m[String(id)] = true; return m; }, {});
  return _printChecklistCaseCache.filter(function (c) { return wanted[c.caseId]; });
}

function _PrintChecklist_collectCase(c, debugOnly) {
  const started = Date.now(), rows = [], designRows = [];
  const debug = { itemListSheet: '', headerRow: 0, columns: {}, itemRowsTotal: 0, itemRowsAdopted: 0,
    adoptedBy: { keyword: 0, link: 0 },
    itemSamples: [], designRoot: null, designFilesTotal: 0, designByConfidence: { '高': 0, '中': 0, '低': 0 }, designSamples: [] };
  let zissi = null;
  if (c.zissiId) zissi = _PrintChecklist_timed('case:' + c.caseId + ':open', function () { return SpreadsheetApp.openById(c.zissiId); });
  if (zissi) {
    const primary = _PrintChecklist_timed('case:' + c.caseId + ':primary', function () { return _PrintChecklist_readPrimary(zissi, c, debug); });
    Array.prototype.push.apply(rows, primary);
    const proposals = _PrintChecklist_timed('case:' + c.caseId + ':proposals', function () { return _PrintChecklist_readProposals(zissi, c); });
    Array.prototype.push.apply(rows, proposals);
  }
  const design = _PrintChecklist_timed('case:' + c.caseId + ':design', function () { return _PrintChecklist_collectDesignFiles(c); });
  debug.designRoot = design.root; debug.designFilesTotal = design.files.length;
  design.files.forEach(function (p) {
    debug.designByConfidence[p.conf]++;
    const targets = rows.filter(function (r) { return _PrintChecklist_namesMatch(r[9], p.name); });
    designRows.push([c.caseId, c.clientName || '', p.conf, p.parent, p.name, p.ext, p.updated, targets.length ? '済' : '未', p.url]);
  });
  const kouryou = zissi ? _PrintChecklist_timed('case:' + c.caseId + ':kouryou', function () { return _PrintChecklist_readKouryouMap(zissi, debug); }) : null;
  debug.kouryou = kouryou ? {
    sheetName: kouryou.sheetName, headerRow: kouryou.headerRow + 1,
    kouryouCols: kouryou.kouryouCols.map(function (c2) { return c2 + 1; }),
    itemCols: kouryou.itemCols.map(function (c2) { return c2 + 1; }),
    entries: kouryou.entries.length,
    entriesWithUrl: kouryou.entries.filter(function (e) { return e.urls.length > 0; }).length,
    linklessCount: kouryou.linklessCount, linklessSamples: kouryou.linklessSamples
  } : null;
  // 校了データが N列に載らない不具合(row40)は、この3つが原因になり得る。
  // どれも黙って空欄になるだけだったので、案件サマリに残して次の調査が1回で済むようにする。
  const notes = [];
  if (kouryou) {
    if (!kouryou.kouryouCols.length) notes.push('制作物一覧の「校了ﾃﾞｰﾀ」列を検出できませんでした');
    else if (!kouryou.entries.length) notes.push('制作物一覧から項目行を1件も読めませんでした');
    if (kouryou.linklessCount) notes.push('校了ﾃﾞｰﾀ列に値はあるのにURLを抽出できないセルが' +
      kouryou.linklessCount + '件あります（セル内チップ/数式のリンクは読めません）');
  }
  const stats = { rows: kouryou ? kouryou.entries.length : 0, adopted: 0, matched: 0, created: 0 };
  // 元のアイテムリスト／提案だけを照合対象にする。新規候補同士の部分一致で別の品を吸収しない。
  const kouryouTargets = rows.slice();
  if (kouryou) kouryou.entries.forEach(function (e) {
    const targets = kouryouTargets.filter(function (r) { return _PrintChecklist_namesMatch(r[9], e.name); });
    const source = '制作物一覧(行' + e.rowNum + ')';
    if (targets.length) {
      stats.matched++; stats.adopted++;
      targets.forEach(function (r) {
        if (e.urls.length) {
          r[13] = _PrintChecklist_uniqueLines(r[13], e.urls.join('\n'));
          r[14] = 'あり';
        }
        r[15] = _PrintChecklist_unique(String(r[15] || '').split(' / ').concat([source])).join(' / ');
      });
    } else {
      const text = e.name + ' ' + e.spec;
      if (_PrintChecklist_isToolOrConsumable(text)) return;
      stats.created++; stats.adopted++;
      rows.push(_PrintChecklist_makeRow(c, _PrintChecklist_itemKey(c.caseId, e.name),
        _PrintChecklist_classify(text, e.urls.length > 0), e.name, e.size, e.qty, e.spec,
        e.urls.join('\n'), e.urls.length ? 'あり' : 'なし', source,
        _PrintChecklist_join([e.note, e.urls.length ? '校了データあり・アイテムリスト未マッチ' : '']), new Date()));
    }
  });
  if (kouryou && !debugOnly) {
    PropertiesService.getScriptProperties().setProperty('PRINT_CHECKLIST_KOURYOU_GID_' + c.caseId,
      JSON.stringify({ gid: kouryou.sheetId, col: kouryou.kouryouCol }));
  }
  rows.forEach(function (r) {
    const match = String(r[15] || '').match(/制作物一覧\(行(\d+)\)/);
    r[26] = _PrintChecklist_seisakubutsuUrl(c.zissiId, kouryou && kouryou.sheetId,
      kouryou ? kouryou.kouryouCol : -1, match ? Number(match[1]) : null);
  });
  debug.kouryouMatched = stats.matched;
  debug.seisakubutsu = stats;
  debug.itemRowsAdopted = rows.filter(function (r) { return String(r[15]).indexOf('アイテムリスト') === 0; }).length;
  debug.designSamples = design.files.slice(0, 15).map(function (p) { return { name: p.name, parent: p.parent, conf: p.conf, url: p.url }; });
  debug.elapsedMs = Date.now() - started;
  return { rows: rows, designRows: designRows, truncated: design.truncated, designScannedAt: design.scannedAt || started, debug: debug,
    notes: notes, kouryouLink: kouryou ? { gid: kouryou.sheetId, col: kouryou.kouryouCol } : null };
}

// 値・表示値・セル内リンクを1回で読む。GASの列別RichText RPCの大きなばらつきを避ける。
function _PrintChecklist_primaryGrid(zissi, sheet, rowCount, colCount) {
  if (typeof UrlFetchApp === 'undefined' || typeof ScriptApp === 'undefined' || !zissi.getId) return null;
  _PrintChecklist_checkReadBudget();
  try {
    let n = colCount, lastCol = '';
    while (n > 0) { n--; lastCol = String.fromCharCode(65 + n % 26) + lastCol; n = Math.floor(n / 26); }
    const range = "'" + sheet.getName().replace(/'/g, "''") + "'!A1:" + lastCol + rowCount;
    const response = UrlFetchApp.fetch('https://sheets.googleapis.com/v4/spreadsheets/' + zissi.getId() +
      '?ranges=' + encodeURIComponent(range) + '&fields=sheets(data(rowData(values(effectiveValue,formattedValue,hyperlink,textFormatRuns(format(link))))))',
      { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } });
    _PrintChecklist_checkReadBudget();
    const body = JSON.parse(response.getContentText());
    if (!body.sheets || !body.sheets[0] || !body.sheets[0].data) throw new Error('primary grid missing');
    const data = body.sheets[0].data[0].rowData || [], values = [], displays = [], richCols = {};
    for (let r = 0; r < rowCount; r++) {
      const cells = data[r] && data[r].values || [], raw = [], display = [];
      for (let col = 0; col < colCount; col++) {
        const cell = cells[col] || {}, v = cell.effectiveValue || {};
        raw.push(v.numberValue !== undefined ? v.numberValue : v.boolValue !== undefined ? v.boolValue : v.stringValue || '');
        display.push(cell.formattedValue === undefined ? String(raw[col]) : cell.formattedValue);
        const links = (cell.textFormatRuns || []).map(function (run) { return run.format && run.format.link && run.format.link.uri; }).filter(Boolean);
        if (cell.hyperlink || links.length) {
          if (!richCols[col]) richCols[col] = [];
          richCols[col][r] = [{ getLinkUrl: function () { return cell.hyperlink || null; },
            getRuns: function () { return links.map(function (url) { return { getLinkUrl: function () { return url; } }; }); } }];
        }
      }
      values.push(raw); displays.push(display);
    }
    return { values: values, displays: displays, richCols: richCols };
  } catch (e) {
    if (e.printReadTimeout) throw e;
    if (_printChecklistTiming) _printChecklistTiming.timings[_printChecklistTiming.timings.length - 1].apiError = String(e.message || e).slice(0, 350);
    _PrintChecklist_checkReadBudget();
    return null; // 追加サービスの有効化・権限の変更は不要。利用不可時は既存読取へ戻る。
  }
}

function _PrintChecklist_readPrimary(zissi, c, debug) {
  const progress = _printChecklistPrimaryProgress || { values: null, displays: null, richUrls: {}, nextCol: 0 };
  try {
  let sheet = zissi.getSheetByName('アイテムリスト');
  if (!sheet) sheet = zissi.getSheets().filter(function (s) {
    return s.getName().indexOf('アイテムリスト') >= 0 && s.getName().indexOf('Claude_') !== 0;
  })[0];
  if (!sheet || sheet.getLastRow() < 2 || sheet.getLastColumn() < 1) return [];
  // 実施計画書は 3〜10MB あり、getRichTextValues() をシート全域に掛けると GAS の 6 分制限で必ず落ちる
  // (実測: C0040/C0038 のプローブがここで無応答になった)。全域は表示値だけ読み、
  // リンク付きセルの取得は、入稿データが記載され得る品名・備考・注意事項列だけに絞る。
  const rowCount = Math.min(sheet.getLastRow(), PRINT_CHECKLIST_MAX_ITEM_ROWS);
  const colCount = sheet.getLastColumn();
  let grid = null;
  if (!progress.values) grid = _PrintChecklist_primaryGrid(zissi, sheet, rowCount, colCount);
  if (_printChecklistTiming) {
    const entry = _printChecklistTiming.timings[_printChecklistTiming.timings.length - 1];
    if (entry) entry.readMethod = grid ? 'Sheets API' : progress.values ? 'checkpoint' : 'SpreadsheetApp';
  }
  const range = !grid && (!progress.values || !progress.displays) ? sheet.getRange(1, 1, rowCount, colCount) : null;
  _PrintChecklist_checkReadBudget();
  if (!progress.values) progress.values = grid ? grid.values : range.getValues();
  _PrintChecklist_checkReadBudget();
  if (!progress.displays) progress.displays = grid ? grid.displays : range.getDisplayValues();
  _PrintChecklist_checkReadBudget();
  const values = progress.values, displays = progress.displays;
  const detected = _PrintChecklist_detectHeaders(displays);
  const linkCols = _PrintChecklist_uniqueColumns(detected.nameCols.map(function (entry) { return entry.col; })
    .concat([detected.note, detected.note2, detected.caution]));
  if (grid) {
    Object.keys(grid.richCols).forEach(function (col) {
      progress.richUrls[col] = grid.richCols[col].map(function (row) { return _PrintChecklist_urlsForRow([''], row || []); });
    });
    progress.nextCol = linkCols.length;
  }
  // RichTextのGASオブジェクトをDriveへ直接保存しない。リンク文字列だけを保存・復元する。
  for (let i = progress.nextCol; i < linkCols.length; i++) {
    _PrintChecklist_checkReadBudget();
    const col = linkCols[i];
    const cells = sheet.getRange(1, col + 1, rowCount, 1).getRichTextValues();
    progress.richUrls[col] = cells.map(function (row) { return _PrintChecklist_urlsForRow([''], row || []); });
    progress.nextCol = i + 1;
  }
  const richCols = {};
  Object.keys(progress.richUrls).forEach(function (col) {
    richCols[col] = progress.richUrls[col].map(function (urls) { urls = urls || []; return [{
      getLinkUrl: function () { return urls[0] || null; },
      getRuns: function () { return urls.map(function (url) { return { getLinkUrl: function () { return url; } }; }); }
    }]; });
  });
  debug.itemListSheet = sheet.getName(); debug.headerRow = detected.row + 1; debug.columns = detected.labels;
  debug.itemRowsTotal = Math.max(0, values.length - detected.row - 1);
  // ヘッダーを見つけられなくてもシートを丸ごと捨ててはいけない(=その案件の印刷物が黙って全部消える)。
  // 品名列が特定できない場合は「行内で最も長いテキストセル」を品名とみなして全行を走査する。
  // 採否は下の「印刷キーワード or 入稿データらしいリンク」判定に任せる。
  const nameless = detected.nameCols.length === 0;
  if (nameless) debug.columns = { fallback: '品名列を検出できずフォールバック走査' };
  const out = [];
  for (let r = detected.row + 1; r < values.length; r++) {
    _PrintChecklist_checkReadBudget();
    const names = nameless ? [_PrintChecklist_longestCellWithCol(displays[r])] : detected.nameCols.map(function (entry) {
      return { col: entry.col, value: String(displays[r][entry.col] || '').trim() };
    });
    const notes = _PrintChecklist_join([_PrintChecklist_cell(displays[r], detected.note), _PrintChecklist_cell(displays[r], detected.note2)]);
    const caution = _PrintChecklist_cell(displays[r], detected.caution);
    const scopedCols = nameless ? _PrintChecklist_uniqueColumns([names[0].col, detected.note, detected.note2, detected.caution]) : linkCols;
    const scopedDisplay = scopedCols.map(function (col) { return displays[r][col]; });
    const scopedRich = scopedCols.map(function (col) { return _PrintChecklist_richCellAt(richCols, r, col); });
    const sourceUrls = _PrintChecklist_urlsForRow(scopedDisplay, scopedRich);
    names.forEach(function (name) {
      const fullName = name.value;
      if (!fullName) return;
      const haystack = _PrintChecklist_join([fullName, notes, caution]);
      const byKeyword = _PrintChecklist_hasKeyword(haystack);
      const byLink = sourceUrls.some(_PrintChecklist_isSubmissionLink);
      if (!byKeyword && !byLink) return;
      // ここでは元セルのリンクを残す。子ファイル列挙は時間上限付きのdesign走査に集約する。
      const urls = sourceUrls;
      debug.adoptedBy[byKeyword ? 'keyword' : 'link']++;
      const cleanName = _PrintChecklist_removeUrls(fullName) || fullName;
      const size = _PrintChecklist_size(displays[r], detected);
      const qty = _PrintChecklist_number(_PrintChecklist_cell(values[r], detected.qty));
      const spec = _PrintChecklist_extractSpecs(_PrintChecklist_join([fullName, notes, caution]));
      const place = _PrintChecklist_cell(displays[r], detected.place);
      const status = _PrintChecklist_cell(displays[r], detected.status);
      const note = _PrintChecklist_join([notes, caution, '元セル全文: ' + fullName,
        urls.length ? '参考URL(元セル): ' + urls.join(' ') : '',
        place ? '倉庫: ' + place : '', status ? '状態: ' + status : '']);
      const id = _PrintChecklist_itemKey(c.caseId, cleanName);
      out.push(_PrintChecklist_makeRow(c, id,
        _PrintChecklist_classify(haystack, urls.length > 0), cleanName, size, qty, spec,
        '', 'なし', 'アイテムリスト(行' + (r + 1) + ')', note, new Date()));
      if (debug.itemSamples.length < 10) debug.itemSamples.push({ name: cleanName, qty: qty, urls: urls });
    });
  }
  if (_printChecklistReadDeadline !== null) _printChecklistPrimaryProgress = progress;
  return out;
  } catch (e) {
    if (e.printReadTimeout && progress.values) e.primaryProgress = progress;
    throw e;
  }
}

function _PrintChecklist_readProposals(zissi, c) {
  const sheet = zissi.getSheetByName('Claude_アイテムリスト提案');
  if (!sheet || sheet.getLastRow() < 2) return [];
  const count = sheet.getLastRow() - 1;
  const range = sheet.getRange(2, 1, count, Math.max(8, sheet.getLastColumn()));
  const values = range.getValues(), displays = range.getDisplayValues();
  let rich = null;
  try { rich = range.getRichTextValues(); } catch (e) { rich = null; }
  const allowed = /^(グラフィック|印刷物|造作物|サイン|什器)$/;
  const out = [];
  displays.forEach(function (r, i) {
    _PrintChecklist_checkReadBudget();
    const category = String(r[0] || '').trim(), fullName = String(r[1] || '').trim();
    if (!fullName || (!allowed.test(category) && !_PrintChecklist_hasKeyword(fullName))) return;
    const urls = _PrintChecklist_urlsForRow(r, rich ? rich[i] : []);
    const cleanName = _PrintChecklist_removeUrls(fullName) || fullName;
    out.push(_PrintChecklist_makeRow(c, _PrintChecklist_itemKey(c.caseId, cleanName),
      _PrintChecklist_classify(category + ' ' + fullName, urls.length > 0), cleanName,
      r[3], _PrintChecklist_number(values[i][2]), r[3], '', 'なし',
      'Claude提案', _PrintChecklist_join([r[6], 'カテゴリ: ' + category,
        urls.length ? '参考URL(元セル): ' + urls.join(' ') : '']), new Date()));
  });
  return out;
}

// 不具合 row40(2026-10-13 報告): 制作物一覧の「校了ﾃﾞｰﾀ」列にリンクを貼っても
// N列「デザインデータ」に反映されない。旧実装はヘッダー行を「項目」セルの完全一致だけで探し、
// 列名も「項目」「校了ﾃﾞｰﾀ(URL)」の完全一致だけを受けていた。表記が少し違うだけで
// 全行が黙って捨てられ(N列は空のまま)、拾えなかった理由はどこにも残らなかった。
// 表記ゆれを許容し、拾えなかった理由を metadata に残す。
const PRINT_CHECKLIST_KOURYOU_ITEM_HEADER = /^(?:項目|項目名|品名|品目|制作物|制作物名|名称|アイテム名|ｱｲﾃﾑ名)$/;
// 「校了ﾃﾞｰﾀ」「校了データ」「校了ﾃﾞｰﾀURL」「校了ﾃﾞｰﾀ(URL)」を許容する。
// 「制作ﾃﾞｰﾀ」を巻き込まないよう「校了」を先頭に要求する。
const PRINT_CHECKLIST_KOURYOU_COL_HEADER = /^校了(?:ﾃﾞｰﾀ|データ)/;
// セルにURL以外の形でリンクが入っている疑い(セル内チップ・HYPERLINK関数)を拾うための目印。
const PRINT_CHECKLIST_LINKISH_TEXT = /https?:\/\/|drive\.google\.com|\.(?:pdf|ai|eps|psd|indd|zip|png|jpe?g|tiff?)/i;

/** 項目列を特定できない表で、行内のURLでない最長セルを品名の代わりにする。 */
function _PrintChecklist_kouryouFallbackName(row, excludeCols) {
  let best = '';
  (row || []).forEach(function (v, col) {
    if (excludeCols.indexOf(col) >= 0) return;
    const s = String(v === null || v === undefined ? '' : v).trim();
    if (!s || /https?:\/\//.test(s)) return;
    if (s.length > best.length) best = s;
  });
  return best;
}

function _PrintChecklist_readKouryouMap(zissi, debug) {
  debug = debug || {};
  try {
    let sheet = zissi.getSheetByName('制作物一覧');
    if (!sheet) sheet = zissi.getSheets().filter(function (s) {
      return s.getName().indexOf('制作物一覧') >= 0 && s.getName().indexOf('Claude_') !== 0;
    })[0];
    if (!sheet) return null;
    const lastRow = sheet.getLastRow(), lastColumn = sheet.getLastColumn();
    const sheetId = sheet.getSheetId();
    debug.kouryouSheetId = sheetId;
    const columns = { size: -1, qty: -1, spec: -1, note: -1 };
    if (lastColumn < 1) return { sheetName: sheet.getName(), sheetId: sheetId, headerRow: -1,
      kouryouCols: [], kouryouCol: -1, itemCols: [], columns: columns, rowsScanned: 0, entries: [],
      linklessCount: 0, linklessSamples: [] };
    const headerCount = Math.min(20, Math.max(1, lastRow));
    const headerValues = sheet.getRange(1, 1, headerCount, lastColumn).getDisplayValues();
    const normalizeHeader = function (v) { return String(v || '').replace(/[\s　\n]/g, ''); };
    // ヘッダー行は「校了ﾃﾞｰﾀ列」「項目列」を持つ行。片方だけの表でも拾い、同点なら上の行を採る。
    // どちらも無ければ従来どおり6行目(0-index 5)をヘッダーとみなす。
    let headerRow = -1, bestScore = 0;
    headerValues.forEach(function (values, r) {
      let score = 0;
      values.forEach(function (v) {
        const h = normalizeHeader(v);
        if (PRINT_CHECKLIST_KOURYOU_COL_HEADER.test(h)) score += 2;
        if (PRINT_CHECKLIST_KOURYOU_ITEM_HEADER.test(h)) score += 2;
      });
      if (score > bestScore) { bestScore = score; headerRow = r; }
    });
    if (headerRow < 0) headerRow = 5;
    const headers = headerValues[headerRow] || [];
    debug.kouryouHeaders = headers.slice(0, 60);
    // 調査で確認: 項目 / 仕様 / 数量 / 撮影対象・その他備考。独立サイズ列はない案件もある。
    const itemCols = [], kouryouCols = [];
    headers.forEach(function (v, col) {
      const h = normalizeHeader(v);
      if (PRINT_CHECKLIST_KOURYOU_ITEM_HEADER.test(h)) itemCols.push(col);
      if (columns.size < 0 && /^(?:サイズ|ｻｲｽﾞ)$/.test(h)) columns.size = col;
      if (columns.qty < 0 && /^数量$/.test(h)) columns.qty = col;
      if (columns.spec < 0 && /^(?:仕様|仕様・加工)$/.test(h)) columns.spec = col;
      if (columns.note < 0 && /^(?:撮影対象・その他備考|備考)$/.test(h)) columns.note = col;
      if (PRINT_CHECKLIST_KOURYOU_COL_HEADER.test(h)) kouryouCols.push(col);
    });
    const metadata = { sheetName: sheet.getName(), sheetId: sheetId, headerRow: headerRow,
      kouryouCols: kouryouCols, kouryouCol: kouryouCols.length ? kouryouCols[0] : -1,
      itemCols: itemCols, columns: columns, linklessCount: 0, linklessSamples: [] };
    const endRow = Math.min(lastRow, PRINT_CHECKLIST_MAX_ITEM_ROWS);
    const rowsScanned = Math.max(0, endRow - headerRow - 1);
    if (!rowsScanned) return Object.assign(metadata, { rowsScanned: 0, entries: [] });
    const displays = sheet.getRange(headerRow + 2, 1, rowsScanned, lastColumn).getDisplayValues();
    const richCols = {};
    kouryouCols.forEach(function (col) {
      try { richCols[col] = sheet.getRange(1, col + 1, endRow, 1).getRichTextValues(); }
      catch (e) { richCols[col] = null; }
    });
    const entries = [];
    displays.forEach(function (row, i) {
      const named = itemCols.map(function (col) { return String(row[col] || '').trim(); }).filter(Boolean)[0];
      const displayCells = kouryouCols.map(function (col) { return row[col]; });
      const richCells = kouryouCols.map(function (col) {
        const grid = richCols[col];
        const cell = grid && grid[headerRow + 1 + i];
        return cell ? cell[0] : null;
      });
      const urls = _PrintChecklist_urlsForRow(displayCells, richCells);
      // 値は入っているのにURLを取れないセルはリンクの形式が原因(セル内チップ・HYPERLINK関数など)。
      // ここを数えないと「貼ったのに反映されない」理由がどこにも残らない。
      if (!urls.length) displayCells.forEach(function (value) {
        const text = String(value || '').trim();
        if (!text || !PRINT_CHECKLIST_LINKISH_TEXT.test(text)) return;
        metadata.linklessCount++;
        if (metadata.linklessSamples.length < 5) metadata.linklessSamples.push({ rowNum: headerRow + 2 + i, value: text.slice(0, 80) });
      });
      // 品名セルが空の行・項目列が無い表でも、校了データが入っている行だけは拾う。
      const name = named || (urls.length ? _PrintChecklist_kouryouFallbackName(row, kouryouCols) : '');
      if (!name) return;
      // 項目列が無い表は、校了URLを持つ行だけを採用して誤検出を抑える。
      if (!itemCols.length && !urls.length) return;
      entries.push({ name: name, urls: urls, rowNum: headerRow + 2 + i,
        size: _PrintChecklist_cell(row, columns.size), qty: _PrintChecklist_cell(row, columns.qty),
        spec: _PrintChecklist_cell(row, columns.spec), note: _PrintChecklist_cell(row, columns.note) });
    });
    return Object.assign(metadata, { rowsScanned: rowsScanned, entries: entries });
  } catch (e) {
    debug.kouryouError = String(e && e.stack ? e.stack : e);
    // 読取り障害を「シートなし」と扱うと既存行・校了URLが消えるため、案件単位で更新を止める。
    throw e;
  }
}

function _PrintChecklist_detectHeaders(rows) {
  const result = { row: 0, name: -1, nameCols: [], qty: -1, size: -1, height: -1, width: -1, depth: -1,
    note: -1, note2: -1, status: -1, caution: -1, place: -1, code: -1, labels: {} };
  let best = null;
  const nameRowsByCol = {};
  for (let r = 0; r < Math.min(40, rows.length); r++) {
    const candidate = { row: r, score: 0 };
    rows[r].forEach(function (v, col) {
      const h = String(v || '').trim().toLowerCase().replace(/[\s　]/g, '');
      if (/^(アイテム名|品名|品目|品目名|item|name)$/.test(h)) {
        if (nameRowsByCol[col] === undefined) nameRowsByCol[col] = r;
        candidate.name = col; candidate.score += 10;
      }
      if (/^(現場必要数|数量|個数|必要数|qty|quantity)$/.test(h)) { candidate.qty = col; candidate.score += 3; }
      if (/^サイズ$/.test(h)) candidate.size = col;
      if (/^サイズ縦$|^縦$/.test(h)) candidate.height = col;
      if (/^サイズ横$|^横$/.test(h)) candidate.width = col;
      if (/^サイズ高さ$|^高さ$|^奥行$/.test(h)) candidate.depth = col;
      if (/^備考(:手入力)?$/.test(h)) candidate.note = col;
      if (/^備考[２2]$/.test(h)) candidate.note2 = col;
      if (/^(ｽﾃｰﾀｽ|ステータス)$/.test(h)) candidate.status = col;
      if (/^注意事項$/.test(h)) candidate.caution = col;
      if (/^場所$/.test(h)) candidate.place = col;
      if (/^(ｺｰﾄﾞ|コード)$/.test(h)) candidate.code = col;
    });
    if (candidate.name !== undefined && (!best || candidate.score > best.score)) best = candidate;
  }
  if (best) Object.keys(result).forEach(function (key) { if (best[key] !== undefined) result[key] = best[key]; });
  result.nameCols = Object.keys(nameRowsByCol).map(function (col) {
    return { col: Number(col), row: nameRowsByCol[col] };
  }).sort(function (a, b) { return a.col - b.col; });
  if (result.nameCols.length) {
    result.row = Math.min.apply(null, result.nameCols.map(function (entry) { return entry.row; }));
    result.name = result.nameCols[0].col;
  }
  Object.keys(result).forEach(function (key) {
    if (key !== 'row' && key !== 'labels' && key !== 'nameCols' && result[key] >= 0) result.labels[key] = result[key] + 1;
  });
  result.labels.nameCols = result.nameCols.map(function (entry) { return entry.col + 1; });
  return result;
}

function _PrintChecklist_collectDesignFiles(c) {
  const cache = CacheService.getScriptCache();
  const props = PropertiesService.getScriptProperties();
  const cacheKey = 'pc_design_' + c.caseId;
  try {
    const cached = cache.get(cacheKey);
    if (cached) {
      const result = JSON.parse(cached);
      if (result.scannedAt && Date.now() - Number(result.scannedAt) < PRINT_CHECKLIST_DESIGN_PROPERTY_TTL_MS) return result;
    }
  } catch (e) { /* キャッシュ障害時は通常走査を続ける */ }
  try {
    const saved = JSON.parse(props.getProperty(cacheKey) || 'null');
    if (saved && Number(saved.scannedAt) > Date.now() - PRINT_CHECKLIST_DESIGN_PROPERTY_TTL_MS && saved.result) {
      saved.result.scannedAt = Number(saved.scannedAt);
      return saved.result;
    }
  } catch (e) { /* 壊れた値や Properties 障害時は通常走査を続ける */ }
  const started = Date.now();
  const candidates = _PrintChecklist_unique([Case_resolveProjectRoot(c), c.projectFolderId, c.folderId]);
  let work = null;
  for (let i = 0; i < candidates.length && !work; i++) {
    const rootId = candidates[i];
    try {
      work = Azukari_findWorkRoot(rootId);
      if (!work) {
        const f = DriveApp.getFolderById(rootId);
        work = { id: f.getId(), name: f.getName() };
      }
    } catch (e) { work = null; }
  }
  if (!work) return { root: null, files: [], truncated: false };
  const out = [], queue = [{ folder: DriveApp.getFolderById(work.id), depth: 0 }];
  let truncated = false;
  while (queue.length) {
    _PrintChecklist_checkReadBudget();
    if (out.length >= PRINT_CHECKLIST_DESIGN_MAX_FILES || Date.now() - started >= PRINT_CHECKLIST_DESIGN_TIME_LIMIT_MS) { truncated = true; break; }
    const node = queue.shift(), parentName = node.folder.getName(), files = node.folder.getFiles();
    while (files.hasNext()) {
      _PrintChecklist_checkReadBudget();
      if (out.length >= PRINT_CHECKLIST_DESIGN_MAX_FILES || Date.now() - started >= PRINT_CHECKLIST_DESIGN_TIME_LIMIT_MS) { truncated = true; break; }
      const f = files.next(), info = _PrintChecklist_designFileInfo(f, parentName);
      if (info) out.push(info);
    }
    if (truncated || node.depth >= 4) continue;
    const folders = node.folder.getFolders();
    while (folders.hasNext()) {
      _PrintChecklist_checkReadBudget();
      const child = folders.next();
      if (!PRINT_CHECKLIST_DESIGN_SKIP_RE.test(String(child.getName() || '').replace(/[\s　]/g, ''))) queue.push({ folder: child, depth: node.depth + 1 });
    }
  }
  const result = { root: { id: work.id, name: work.name }, files: out, truncated: truncated, scannedAt: Date.now() };
  if (!truncated) {
    try {
      const json = JSON.stringify(result);
      if (Utilities.newBlob(json).getBytes().length <= 100 * 1024) cache.put(cacheKey, json, 21600);
      const savedJson = JSON.stringify({ scannedAt: result.scannedAt, result: result });
      if (Utilities.newBlob(savedJson).getBytes().length <= PRINT_CHECKLIST_DESIGN_PROPERTY_MAX_BYTES) {
        props.setProperty(cacheKey, savedJson);
      }
    } catch (e) { /* 容量超過やキャッシュ障害時は保存せず、次回走査する */ }
  }
  return result;
}

function _PrintChecklist_designFileInfo(file, parentName) {
  const name = file.getName(), mime = file.getMimeType(), lower = name.toLowerCase();
  if (/^(?:result_|cmd_|construction_plan_setup_)/i.test(name)) return null;
  if (mime === 'application/vnd.google-apps.spreadsheet') return null;
  if (mime === 'application/vnd.google-apps.document' && /フォルダがない場合は作成してください/.test(name)) return null;
  const m = lower.match(/\.([a-z0-9]+)$/), ext = m ? m[1] : (mime === 'application/vnd.google-apps.presentation' ? 'Google Slides' : mime === 'application/vnd.google-apps.document' ? 'Google Docs' : '');
  if (!/^(?:ai|eps|psd|indd|pdf|svg|zip|png|jpg|jpeg|tif|tiff)$/.test(ext) && ext !== 'Google Slides' && ext !== 'Google Docs') return null;
  const text = name + ' ' + parentName;
  const high = /入稿|入校|outline|アウトライン|印刷|出力|データ入稿|完全データ|CMYK|原寸|K100/i.test(text);
  const medium = /^(?:ai|eps|psd|indd)$/.test(ext) || /パネル|ポスター|バナー|幕|看板|サイン|名札|ロゴ|グラフィック|タペストリー|のぼり|シート/i.test(text);
  return { id: file.getId(), name: name, parent: parentName, ext: ext, updated: file.getLastUpdated(), url: file.getUrl(), conf: high ? '高' : medium ? '中' : '低' };
}

function _PrintChecklist_makeRow(c, id, category, name, size, qty, spec, urls, dataState, source, note, updated) {
  const start = _PrintChecklist_date(c.startDate), end = _PrintChecklist_date(c.endDate);
  const deadline = start ? new Date(start.getFullYear(), start.getMonth(), start.getDate() - 14) : '';
  return [id, '未確認', c.caseId, c.clientName || '', c.caseName || '', _PrintChecklist_period(start, end),
    start || '', deadline, category, name, size || '', qty === null ? '' : qty, spec || '', urls || '',
    dataState || '要確認', source, note || '', false, '未確認', '', '', '', '', '', updated || new Date(), '未確認'];
}

function _PrintChecklist_getOrCreateSpreadsheet() {
  const props = PropertiesService.getScriptProperties();
  const saved = props.getProperty(PRINT_CHECKLIST_SS_ID_KEY);
  if (saved) {
    try { return SpreadsheetApp.openById(saved); } catch (e) { /* 作り直す */ }
  }
  const ss = SpreadsheetApp.create(PRINT_CHECKLIST_SS_NAME);
  const file = DriveApp.getFileById(ss.getId());
  file.moveTo(DriveApp.getFolderById(APP_ROOT_FOLDER_ID));
  props.setProperty(PRINT_CHECKLIST_SS_ID_KEY, ss.getId());
  return ss;
}

// A1 が既知の見出しなら旧版。列順も見出し名で解決して移行する。
function _PrintChecklist_readTable(sheet, firstHeader) {
  if (!sheet || !sheet.getLastRow()) return { headers: [], rows: [], firstDataRow: PRINT_CHECKLIST_FIRST_DATA_ROW };
  const values = sheet.getDataRange().getValues();
  const headerRow = String((values[0] || [])[0] || '').trim() === firstHeader ? 1 : PRINT_CHECKLIST_HEADER_ROW;
  if (String((values[headerRow - 1] || [])[0] || '').trim() !== firstHeader) {
    throw new Error('印刷物の見出しを読めません（空として上書きしません）: ' + sheet.getName());
  }
  return { headers: (values[headerRow - 1] || []).map(function (v) { return String(v || '').trim(); }),
    rows: values.slice(headerRow), firstDataRow: headerRow + 1 };
}

function _PrintChecklist_tableRows(table, headers) {
  if (table.rows.length && headers.some(function (header, i) {
    // 後から追加された列は従来どおり空欄で補完する。ID/状態/案件/品名は必須。
    return (i === 0 || ['状態', '案件ID', '品名', '品名パターン'].indexOf(header) >= 0) && table.headers.indexOf(header) < 0;
  })) throw new Error('印刷物の必須列がありません（空として上書きしません）');
  return table.rows.map(function (source) {
    return headers.map(function (header) {
      const col = table.headers.indexOf(header);
      return col < 0 || source[col] == null ? '' : source[col];
    });
  });
}

function _PrintChecklist_readExisting(ss) {
  const rows = [], mainIds = Object.create(null);
  [PRINT_CHECKLIST_MAIN_SHEET, PRINT_CHECKLIST_PAST_SHEET, PRINT_CHECKLIST_EXCLUDED_SHEET].forEach(function (name) {
    const table = _PrintChecklist_readTable(ss.getSheetByName(name), '印刷ID');
    _PrintChecklist_tableRows(table, PRINT_CHECKLIST_HEADERS).forEach(function (row) {
      row[PRINT_CHECKLIST_PD_REVIEW_COL] = row[PRINT_CHECKLIST_PD_REVIEW_COL] || '未確認';
      if (row[0]) {
        rows.push(row);
        if (name === PRINT_CHECKLIST_MAIN_SHEET) mainIds[String(row[0])] = true;
      }
    });
  });
  const byId = Object.create(null);
  rows.forEach(function (r) { byId[String(r[0])] = r; });
  const designRows = _PrintChecklist_tableRows(
    _PrintChecklist_readTable(ss.getSheetByName(PRINT_CHECKLIST_DESIGN_SHEET), '案件ID'), PRINT_CHECKLIST_DESIGN_HEADERS)
    .filter(function (r) { return r[0]; });
  return { rows: rows, byId: byId, mainIds: mainIds, designRows: designRows };
}

// 印刷会社様用はB/R〜Wのみ入力口。空欄への変更やFALSEも正本として取り込む。
function _PrintChecklist_writeBackPrinter(sheet, existing, printerName, defaultName) {
  const table = _PrintChecklist_readTable(sheet, '印刷ID');
  // 前回表示したBをメモに保持し、社内側だけの状態変更を古いビューで巻き戻さない。
  const statusCol = table.headers.indexOf('状態');
  const notes = table.rows.length && statusCol >= 0 ? sheet.getRange(table.firstDataRow, statusCol + 1, table.rows.length, 1).getNotes() : [];
  const inputNotes = table.rows.length ? sheet.getRange(table.firstDataRow, 18, table.rows.length, 6).getNotes() : [];
  const result = { updated: 0, ignored: 0 };
  _PrintChecklist_tableRows(table, PRINT_CHECKLIST_HEADERS).forEach(function (source, index) {
    if (!source[0]) return;
    const target = existing.byId[String(source[0])];
    if (!target || !existing.mainIds[String(source[0])] ||
        (printerName !== undefined && _PrintChecklist_printerName(target, defaultName) !== printerName)) { result.ignored++; return; }
    let changed = false;
    [1, 17, 18, 19, 20, 21, 22].forEach(function (col) {
      const note = (notes[index] || [])[0] || '';
      if (col === 1 && note === 'PrintChecklist:lastStatus:' + String(source[1])) return;
      if (col >= 17 && (inputNotes[index] || [])[col - 17] === _PrintChecklist_inputNote(source[col])) return;
      const a = target[col], b = source[col];
      if (String(a) !== String(b) || typeof a !== typeof b) { target[col] = b; changed = true; }
    });
    if (changed) result.updated++;
  });
  return result;
}

// values は説明・見出しを含むシート全体。row は実シートの行番号。
function _PrintChecklist_parsePrinterMaster(values) {
  const seen = Object.create(null), result = [];
  (values || []).slice(2).forEach(function (r, i) {
    const name = String(r[0] || '').trim();
    if (!name || seen[name]) return;
    seen[name] = true;
    const emails = String(r[1] || '').split(',').map(function (v) { return v.trim().toLowerCase(); })
      .filter(function (v, j, all) { return v.indexOf('@') >= 0 && all.indexOf(v) === j; });
    result.push({ name: name, emails: emails, isDefault: String(r[2] || '').trim() === '○',
      url: String(r[3] || '').trim(), ssId: String(r[4] || '').trim(), note: String(r[5] || ''), row: i + 3 });
  });
  const first = result.findIndex(function (p) { return p.isDefault; });
  result.forEach(function (p, i) { p.isDefault = i === (first < 0 ? 0 : first); });
  return result;
}

function _PrintChecklist_readPrinterMaster(ss) {
  const sheet = ss.getSheetByName(PRINT_CHECKLIST_PRINTER_MASTER_SHEET);
  return _PrintChecklist_parsePrinterMaster(sheet ? sheet.getDataRange().getValues() :
    [[], PRINT_CHECKLIST_PRINTER_MASTER_HEADERS, PRINT_CHECKLIST_DEFAULT_PRINTER]);
}

function _PrintChecklist_ensurePrinterMaster(ss) {
  let sheet = ss.getSheetByName(PRINT_CHECKLIST_PRINTER_MASTER_SHEET);
  if (sheet) return sheet;
  try { sheet = ss.insertSheet(PRINT_CHECKLIST_PRINTER_MASTER_SHEET); }
  catch (e) {
    // 作成要求の再送や他実行による作成後は、古いSSハンドルの不在キャッシュを使わない。
    sheet = SpreadsheetApp.openById(ss.getId()).getSheetByName(PRINT_CHECKLIST_PRINTER_MASTER_SHEET);
    if (!sheet) throw e;
    if (sheet.getLastRow()) return sheet;
  }
  _PrintChecklist_writeSimpleSheet(sheet, PRINT_CHECKLIST_PRINTER_MASTER_HEADERS, [PRINT_CHECKLIST_DEFAULT_PRINTER]);
  sheet.setColumnWidth(1, 160); sheet.setColumnWidth(2, 300);
  sheet.setColumnWidth(4, 300); sheet.setColumnWidth(5, 300); sheet.setColumnWidth(6, 400);
  return sheet;
}

function _PrintChecklist_defaultPrinterName(master) {
  const printer = master.find(function (p) { return p.isDefault; }) || master[0];
  return printer ? printer.name : '';
}

function _PrintChecklist_printerName(row, defaultName) { return String(row[27] || '').trim() || defaultName; }

// 印刷会社マスタから会社名で引く。表記ゆれ（全角/半角・空白）は normalize で吸収する。
function _PrintChecklist_findPrinter(master, name) {
  const key = _PrintChecklist_normalize(name);
  return (master || []).filter(function (p) { return _PrintChecklist_normalize(p.name) === key; })[0] || null;
}

// ルールで使う会社がマスタに無ければ足す。共有メールは空のまま（後から人が書けば翌朝共有される）。
function _PrintChecklist_ensureRulePrinters(ss, master) {
  const sheet = ss.getSheetByName(PRINT_CHECKLIST_PRINTER_MASTER_SHEET);
  if (!sheet) return [];
  const added = [];
  let lastRow = Math.max(sheet.getLastRow(), PRINT_CHECKLIST_HEADER_ROW + 1);
  PRINT_CHECKLIST_PRINTER_RULES.forEach(function (rule) {
    const name = rule[0];
    if (_PrintChecklist_findPrinter(master, name)) return;
    lastRow++;
    sheet.getRange(lastRow, 1, 1, 6).setValues([[
      name, '', '', '', '', '自動追加: AB列の自動割当用（共有メール未設定）'
    ]]);
    master.push({ name: name, emails: [], isDefault: false, url: '', ssId: '', note: '自動追加', row: lastRow });
    added.push(name);
  });
  return added;
}

// AB列が空の行だけ、品名・仕様・備考から印刷会社を推定して補う。
// 推定先がマスタに無い場合は何もしない（存在しない会社の専用シートを作らない）。
function _PrintChecklist_applyPrinterRules(rows, master) {
  let assigned = 0;
  (rows || []).forEach(function (row) {
    if (String(row[27] || '').trim()) return;
    const text = [row[9], row[12], row[15]].map(function (v) { return String(v == null ? '' : v); }).join(' ');
    const rule = PRINT_CHECKLIST_PRINTER_RULES.filter(function (r) { return r[1].test(text); })[0];
    if (!rule) return;
    const printer = _PrintChecklist_findPrinter(master, rule[0]);
    if (!printer) return;
    row[27] = printer.name;
    assigned++;
  });
  return assigned;
}

function _PrintChecklist_rowsForPrinter(rows, printerName, defaultName) {
  if (!printerName) return [];
  return rows.filter(function (r) {
    return (r[1] === '未入稿' || r[1] === '入稿済') && _PrintChecklist_printerName(r, defaultName) === printerName;
  }).map(function (r) {
    const copy = PRINT_CHECKLIST_HEADERS.map(function (_, i) { return r[i] == null ? '' : r[i]; });
    copy[26] = ''; copy[27] = ''; return copy;
  });
}

function _PrintChecklist_inputNote(value) {
  return 'PrintChecklist:lastInput:' + JSON.stringify(value == null ? '' : value);
}

function _PrintChecklist_writeBackAllPrinters(ss, existing, master) {
  const defaultName = _PrintChecklist_defaultPrinterName(master);
  const total = { updated: 0, ignored: 0, warnings: [] }, used = Object.create(null);
  const apply = function (sheet, name) {
    const r = _PrintChecklist_writeBackPrinter(sheet, existing, name, defaultName);
    total.updated += r.updated; total.ignored += r.ignored;
  };
  apply(ss.getSheetByName(PRINT_CHECKLIST_PRINTER_SHEET), defaultName);
  master.forEach(function (p) {
    if (!p.ssId) return;
    if (p.ssId === ss.getId() || used[p.ssId]) throw new Error('専用シートIDが社内ファイルまたは他社と重複しています: ' + p.name);
    used[p.ssId] = true;
    let printerSs;
    try { printerSs = SpreadsheetApp.openById(p.ssId); }
    catch (e) { p.unreadable = true; total.warnings.push(p.name + ': 専用ファイルを開けないため再作成対象'); return; }
    // 開けたファイルの読取り失敗は停止する。入力を読めないまま再生成しない。
    apply(printerSs.getSheetByName(PRINT_CHECKLIST_PRINTER_SHEET), p.name);
  });
  return total;
}

function _PrintChecklist_printerNote(ss, printer, kind, error) {
  const sheet = ss.getSheetByName(PRINT_CHECKLIST_PRINTER_MASTER_SHEET);
  const cell = sheet.getRange(printer.row, 6);
  const note = String(cell.getValues()[0][0] || '');
  const line = '[' + kind + ' ' + Utilities.formatDate(new Date(), PRINT_CHECKLIST_TZ, 'yyyy/MM/dd') + '] ' + String(error.message || error);
  if (note.split('\n').indexOf(line) < 0) cell.setValue(note ? note + '\n' + line : line);
}

// Advanced Drive API を優先し、通知メールを送らずに共有する。
function _PrintChecklist_sharePrinterFile(id, printer) {
  if (typeof Drive !== 'undefined' && Drive.Permissions) {
    const permissions = []; let pageToken;
    do {
      const page = Drive.Permissions.list(id, { fields: 'nextPageToken,permissions(id,type,role,emailAddress,domain)', pageToken: pageToken, pageSize: 100 });
      Array.prototype.push.apply(permissions, page.permissions || []); pageToken = page.nextPageToken;
    } while (pageToken);
    permissions.filter(function (p) { return p.type === 'anyone'; }).forEach(function (p) { Drive.Permissions.remove(id, p.id); });
    const desired = [{ type: 'domain', domain: 'orgiast.jp', role: 'writer', allowFileDiscovery: false }]
      .concat(printer.emails.map(function (email) { return { type: 'user', emailAddress: email, role: 'writer' }; }));
    desired.forEach(function (p) {
      const found = permissions.find(function (v) {
        return v.type === p.type && (p.type === 'domain' ? v.domain === p.domain : String(v.emailAddress || '').toLowerCase() === p.emailAddress);
      });
      if (!found) Drive.Permissions.create(p, id, { sendNotificationEmail: false });
      else if (['writer', 'owner', 'organizer', 'fileOrganizer'].indexOf(found.role) < 0) Drive.Permissions.update({ role: 'writer' }, id, found.id);
    });
    return { notificationSuppressed: true };
  }
  const file = DriveApp.getFileById(id);
  file.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.EDIT);
  printer.emails.forEach(function (email) { file.addEditor(email); });
  return { notificationSuppressed: false };
}

function _PrintChecklist_movePrinterFile(id) {
  if (typeof Drive !== 'undefined' && Drive.Files) {
    const file = Drive.Files.get(id, { fields: 'parents' });
    const parents = file.parents || [];
    if (parents.indexOf(APP_ROOT_FOLDER_ID) < 0) {
      Drive.Files.update({}, id, null, { addParents: APP_ROOT_FOLDER_ID, removeParents: parents.join(','), fields: 'id' });
    }
  } else DriveApp.getFileById(id).moveTo(DriveApp.getFolderById(APP_ROOT_FOLDER_ID));
}

function _PrintChecklist_syncPrinterFiles(ss, mainRows, master) {
  const result = [], used = Object.create(null), defaultName = _PrintChecklist_defaultPrinterName(master);
  master.forEach(function (printer) {
    const status = { name: printer.name, ssId: printer.ssId, rows: 0, created: false, errors: [] };
    result.push(status);
    try {
      if (printer.ssId && (printer.ssId === ss.getId() || used[printer.ssId])) throw new Error('専用シートIDが社内ファイルまたは他社と重複');
      let target;
      if (printer.ssId && !printer.unreadable) { try { target = _PrintChecklist_timed('printer:' + printer.name + ':open', function () { return SpreadsheetApp.openById(printer.ssId); }); } catch (e) { /* 作り直す */ } }
      if (!target) {
        target = SpreadsheetApp.create('【' + printer.name + '様用】印刷物チェックシート');
        status.created = true;
        printer.ssId = target.getId(); printer.url = _PrintChecklist_ssUrl(printer.ssId);
        // 移動・共有の失敗時にも次回同じファイルを再利用する。
        ss.getSheetByName(PRINT_CHECKLIST_PRINTER_MASTER_SHEET).getRange(printer.row, 4, 1, 2).setValues([[printer.url, printer.ssId]]);
      }
      status.ssId = printer.ssId; used[printer.ssId] = true;
      const rows = _PrintChecklist_rowsForPrinter(mainRows, printer.name, defaultName);
      _PrintChecklist_timed('printer:' + printer.name + ':writeList', function () { _PrintChecklist_writeListSheet(_PrintChecklist_sheet(target, PRINT_CHECKLIST_PRINTER_SHEET), rows, null, target.getId()); }, true);
      status.rows = rows.length;
      _PrintChecklist_timed('printer:' + printer.name + ':guide', function () {
      const guide = _PrintChecklist_sheet(target, 'ご利用方法');
      const instructions = [[PRINT_CHECKLIST_DESCRIPTIONS[PRINT_CHECKLIST_PRINTER_SHEET]],
        ['B列「状態」: 進行に合わせて選んでください。'], ['R列「受領」: データを受け取ったらチェックしてください。'],
        ['S列「データ確認」: 未確認・OK・要修正・データ不足から選んでください。'],
        ['T列「印刷予定日」・U列「納品予定日」: 予定日を記入してください。'],
        ['V列「御社担当者」: ご担当者名を記入してください。'], ['W列「印刷会社メモ」: 連絡事項を記入してください。']];
      guide.getRange(1, 1, instructions.length, 1).setValues(instructions).setWrap(true); guide.setColumnWidth(1, 800);
      }, true);
      const blank = target.getSheetByName('シート1') || target.getSheetByName('Sheet1');
      if (blank && target.getSheets().length > 1) target.deleteSheet(blank);
      _PrintChecklist_timed('printer:' + printer.name + ':protect', function () { _PrintChecklist_protectSheets(target, false); }, true);
      target.setActiveSheet(target.getSheetByName(PRINT_CHECKLIST_PRINTER_SHEET)); target.moveActiveSheet(1);
      try { _PrintChecklist_timed('printer:' + printer.name + ':move', function () { _PrintChecklist_movePrinterFile(printer.ssId); }, true); }
      catch (e) { status.errors.push('移動: ' + String(e.message || e)); _PrintChecklist_printerNote(ss, printer, '移動失敗', e); }
      try {
        const sharing = _PrintChecklist_timed('printer:' + printer.name + ':share', function () { return _PrintChecklist_sharePrinterFile(printer.ssId, printer); });
        status.notificationSuppressed = sharing.notificationSuppressed;
        if (!sharing.notificationSuppressed) _PrintChecklist_printerNote(ss, printer, '共有通知', 'DriveApp経由のため通知抑止を保証できません');
      } catch (e) { status.errors.push('共有: ' + String(e.message || e)); _PrintChecklist_printerNote(ss, printer, '共有失敗', e); }
    } catch (e) { status.errors.push(String(e.message || e)); _PrintChecklist_printerNote(ss, printer, '更新失敗', e); }
  });
  return result;
}

// 行・列位置ではなく、正規化した品名で固定する。既存 EX-ID のハッシュは変更しない。
function _PrintChecklist_stableHash8(value) {
  var h = 2166136261, s = String(value || '');
  for (var i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
}

function _PrintChecklist_itemKey(caseId, name) {
  return String(caseId) + '-IT' + _PrintChecklist_stableHash8(_PrintChecklist_normalize(name));
}

function _PrintChecklist_mergeById(rows) {
  var byId = Object.create(null), result = [];
  var col = function (header) { return PRINT_CHECKLIST_HEADERS.indexOf(header); };
  rows.forEach(function (source) {
    var id = String(source[col('印刷ID')]), row = byId[id];
    if (!row) {
      row = source.slice(); byId[id] = row; result.push(row);
      row[col('数量')] = _PrintChecklist_number(row[col('数量')]) || '';
      return;
    }
    PRINT_CHECKLIST_HEADERS.forEach(function (header, i) {
      if (header === '数量') {
        row[i] = Math.max(_PrintChecklist_number(row[i]) || 0, _PrintChecklist_number(source[i]) || 0) || '';
      } else if (header === '発生源') {
        row[i] = _PrintChecklist_unique(String(row[i] || '').split(' / ').concat(String(source[i] || '').split(' / '))).join(' / ');
      } else if (header === '備考' || header === 'デザインデータ') {
        row[i] = _PrintChecklist_uniqueLines(row[i], source[i]);
      } else if (header === 'データ有無' && source[i] === 'あり') {
        row[i] = 'あり';
      } else if (header === '制作物一覧リンク') {
        if (!row[i] || (String(row[i]).indexOf('range=') < 0 && String(source[i] || '').indexOf('range=') >= 0)) row[i] = source[i] || '';
      } else if (header === '最終更新') {
        if ((new Date(source[i]).getTime() || 0) > (new Date(row[i]).getTime() || 0)) row[i] = source[i];
      } else if (row[i] === '' || row[i] == null) {
        row[i] = source[i];
      }
    });
  });
  return result;
}

// 純ロジックとして分離し、GAS に接続せず移行・再実行・部分更新を検証できるようにする。
function _PrintChecklist_reconcileRows(existing, freshRows, processedIds, exclusionRules, now) {
  var fresh = _PrintChecklist_mergeById(freshRows), freshById = Object.create(null);
  var legacyByName = Object.create(null), consumed = [], migrated = 0;
  var mergedDuplicates = freshRows.length - fresh.length;
  var col = function (header) { return PRINT_CHECKLIST_HEADERS.indexOf(header); };
  var nameKey = function (row) { return row[col('案件ID')] + '|' + _PrintChecklist_normalize(row[col('品名')]); };
  existing.rows.forEach(function (row) {
    // -DF は従来の削除・ソース消滅処理だけに渡す。
    if (!processedIds[String(row[col('案件ID')])] || /-DF\d+$/.test(String(row[col('印刷ID')]))) return;
    var key = nameKey(row);
    if (!legacyByName[key]) legacyByName[key] = [];
    legacyByName[key].push(row);
  });
  fresh.forEach(function (row) {
    freshById[row[col('印刷ID')]] = row;
    var group = legacyByName[nameKey(row)] || [];
    var chosen = existing.byId[row[col('印刷ID')]];
    if (!chosen && group.length) {
      chosen = group.slice().sort(function (a, b) {
        return Number(_PrintChecklist_hasPrinterInput(b)) - Number(_PrintChecklist_hasPrinterInput(a)) ||
          (new Date(b[col('最終更新')]).getTime() || 0) - (new Date(a[col('最終更新')]).getTime() || 0);
      })[0];
    }
    if (chosen) _PrintChecklist_copyPreserved(chosen, row);
    if (group.length) {
      var legacyIds = [];
      group.forEach(function (oldRow) {
        consumed.push(oldRow);
        row[col('備考')] = _PrintChecklist_uniqueLines(row[col('備考')], oldRow[col('備考')]);
        if (oldRow[col('印刷ID')] !== row[col('印刷ID')]) legacyIds.push(oldRow[col('印刷ID')]);
        // 採用されなかった行の異なる記入も監査用に残す（上書きや黙った欠落を避ける）。
        PRINT_CHECKLIST_PRESERVED_HEADERS.forEach(function (header) {
          var i = col(header), value = oldRow[i];
          if (value !== '' && value != null && String(value) !== String(row[i])) {
            row[col('備考')] = _PrintChecklist_uniqueLines(row[col('備考')],
              '旧記入 [' + oldRow[col('印刷ID')] + '] ' + header + ': ' + String(value));
          }
        });
      });
      if (legacyIds.length) {
        migrated++;
        row[col('備考')] = _PrintChecklist_uniqueLines(row[col('備考')], '旧印刷ID: ' + _PrintChecklist_unique(legacyIds).join(' '));
      }
      mergedDuplicates += Math.max(0, group.length - 1);
    }
    // 重複旧行の一方だけが対象外でも、学習済みの除外ルールを優先する。
    if (_PrintChecklist_matchesExclusionRule(row, exclusionRules)) row[col('状態')] = '対象外';
  });
  var merged = [];
  existing.rows.forEach(function (oldRow) {
    if (consumed.indexOf(oldRow) >= 0) return;
    const id = String(oldRow[0] || '');
    const caseId = String(oldRow[2] || '');
    if (!processedIds[caseId]) {
      merged.push(oldRow);
    } else if (!freshById[id]) {
      // -DF 行(制作フォルダ走査から自動起票していた行)は起票をやめたので、行を残さず消す。
      // 残すと N列「デザインデータ」に校了データ以外の Drive URL が居座り続ける
      // (kim 指示: N列は制作物一覧の校了データだけ / 2026-09-03)。
      // 印刷会社の記入欄が空の行だけ消し、何か書かれていたら [ソース消滅] を付けて残す。
      if (/-DF\d+$/.test(id) && !_PrintChecklist_hasPrinterInput(oldRow) &&
          oldRow[PRINT_CHECKLIST_PD_REVIEW_COL] === '未確認' && !oldRow[23]) return;
      // 残す行でも N列は空にする。ソース消滅行は「校了データだけ」の改修より前に入った
      // Drive URL を持ち続けるので、そのままだと N列に非校了データが居座る
      // (実測: C0041 ファインスチール様に 1 行残っていた)。URL は備考へ退避する。
      const goneUrls = String(oldRow[13] || '').split('\n').filter(Boolean);
      const wasGone = String(oldRow[16] || '').indexOf('[ソース消滅]') === 0 && !oldRow[13] && oldRow[14] === 'なし';
      oldRow[16] = _PrintChecklist_sourceGoneNote(_PrintChecklist_join([oldRow[16],
        goneUrls.length ? '参考URL(ソース消滅時): ' + goneUrls.join(' ') : '']));
      oldRow[13] = '';
      oldRow[14] = 'なし';
      if (!wasGone) oldRow[24] = now;
      merged.push(oldRow);
    }
  });
  Array.prototype.push.apply(merged, fresh);
  return { rows: merged, migrated: migrated, mergedDuplicates: mergedDuplicates };
}

function _PrintChecklist_copyPreserved(oldRow, newRow) {
  PRINT_CHECKLIST_PRESERVED_HEADERS.forEach(function (header) {
    const col = PRINT_CHECKLIST_HEADERS.indexOf(header);
    newRow[col] = oldRow[col] == null ? '' : oldRow[col];
  });
}

function _PrintChecklist_applyRestore(rows, rules, now) {
  var result = { restored: 0, restoreBlocked: 0 };
  var dateLabel = Utilities.formatDate(now, PRINT_CHECKLIST_TZ, 'yyyy/MM/dd');
  rows.forEach(function (row) {
    if (row[PRINT_CHECKLIST_PD_REVIEW_COL] !== '復活') return;
    var globalRules = rules.filter(function (rule) {
      return rule[1] === '全案件' && _PrintChecklist_matchesExclusionRule(row, [rule]);
    });
    row[PRINT_CHECKLIST_PD_REVIEW_COL] = '未確認';
    row[24] = now;
    if (globalRules.length) {
      // 拒否時は案件限定ルールも含めて残す（部分的な復活にしない）。
      row[1] = '対象外';
      row[16] = _PrintChecklist_uniqueLines(row[16], '[復活不可 ' + dateLabel + '] 全案件の除外ルール ' +
        _PrintChecklist_unique(globalRules.map(function (rule) { return rule[0]; })).join(', ') +
        ' に一致。管理者に連絡してください');
      result.restoreBlocked++;
      return;
    }
    for (var i = rules.length - 1; i >= 0; i--) {
      if (rules[i][1] === 'この案件のみ' && _PrintChecklist_matchesExclusionRule(row, [rules[i]])) rules.splice(i, 1);
    }
    row[1] = '未確認';
    row[16] = _PrintChecklist_uniqueLines(row[16], '[復活 ' + dateLabel + ']');
    // 未処理の古いX列指示が残っていても復活を優先する。X列自体は変更しない。
    // 指示が変更された場合は再び学習できるよう、復活時の指示を備考へ記録する。
    var instruction = String(row[23] || '').trim();
    if (instruction && !/^\[反映済/.test(instruction) && /今後も除外|常に除外|毎回不要|二度と出さない/.test(instruction)) {
      row[16] = _PrintChecklist_uniqueLines(row[16], '[復活時の除外指示を取消] ' + JSON.stringify(instruction));
    }
    result.restored++;
  });
  return result;
}

function _PrintChecklist_applyPdReview(rows, now) {
  rows.forEach(function (row) {
    row[PRINT_CHECKLIST_PD_REVIEW_COL] = row[PRINT_CHECKLIST_PD_REVIEW_COL] || '未確認';
    if (row[PRINT_CHECKLIST_PD_REVIEW_COL] === '確認済' && row[1] === '未確認') {
      row[1] = '未入稿';
      row[24] = now;
    }
    if (row[PRINT_CHECKLIST_PD_REVIEW_COL] === '対象外' && row[1] !== '対象外') {
      row[1] = '対象外';
      row[24] = now;
    }
  });
}

function _PrintChecklist_readExclusionRules(ss) {
  return _PrintChecklist_tableRows(_PrintChecklist_readTable(ss.getSheetByName(PRINT_CHECKLIST_EXCLUSION_RULE_SHEET), 'ルールID'),
    PRINT_CHECKLIST_EXCLUSION_RULE_HEADERS).filter(function (row) { return row[0] && row[3]; });
}

function _PrintChecklist_learnExclusionRules(rows, rules, now) {
  const triggerRe = /今後も除外|常に除外|毎回不要|二度と出さない/;
  const dateLabel = Utilities.formatDate(now, PRINT_CHECKLIST_TZ, 'yyyy/MM/dd');
  rows.forEach(function (row) {
    const instruction = String(row[23] || '').trim();
    const restoredInstruction = String(row[16] || '').split('\n').indexOf('[復活時の除外指示を取消] ' + JSON.stringify(instruction)) >= 0;
    const explicit = !restoredInstruction && !/^\[反映済/.test(instruction) && triggerRe.test(instruction);
    if (!explicit && row[1] !== '対象外' && row[PRINT_CHECKLIST_PD_REVIEW_COL] !== '対象外') return;
    // 全案件スコープは「全案件」と明記された時だけ。明示トリガーでも既定は この案件のみ
    // (勝手に全案件へ広げると、他案件の印刷物が黙って消える = 印刷漏れになる)。
    const scope = explicit && instruction.indexOf('全案件') >= 0 ? '全案件' : 'この案件のみ';
    const caseId = scope === '全案件' ? '' : String(row[2] || '');
    const pattern = _PrintChecklist_normalize(row[9]);
    if (!pattern) return;
    const duplicate = rules.some(function (rule) {
      // 保存値はすでに正規化済み。寸法の区切り除去で繋がった数字を再正規化すると
      // 日付の6〜8桁除去が働く（床パネル40040018mm → 床パネルmm）。
      // 正規化器を変えると印刷ID/除外結果も変わるため、保存値との直接比較を先に行う。
      return String(rule[1]) === scope && String(rule[2] || '') === caseId &&
        (String(rule[3]) === pattern || _PrintChecklist_normalize(rule[3]) === pattern);
    });
    if (!duplicate) {
      rules.push(['EX-' + _PrintChecklist_stableNumber(scope + '|' + caseId + '|' + pattern), scope, caseId,
        pattern, now, row[0]]);
    }
    if (explicit) row[23] = '[反映済 ' + dateLabel + '] ' + instruction;
  });
}

function _PrintChecklist_matchesExclusionRule(row, rules) {
  return rules.some(function (rule) {
    const inScope = rule[1] === '全案件' || (rule[1] === 'この案件のみ' && String(rule[2] || '') === String(row[2] || ''));
    const name = _PrintChecklist_normalize(row[9]);
    return inScope && ((name && name === _PrintChecklist_normalize(rule[3])) || _PrintChecklist_namesMatch(row[9], rule[3]));
  });
}

function _PrintChecklist_pendingInstructions(rows) {
  return rows.filter(function (row) {
    const instruction = String(row[23] || '').trim();
    return instruction && !/^\[反映済/.test(instruction);
  }).map(function (row) {
    return { printId: row[0], caseId: row[2], itemName: row[9], instruction: row[23] };
  });
}

function _PrintChecklist_dedupeExclusionRules(rules) {
  var byId = Object.create(null), unique = [];
  rules.forEach(function (rule) {
    var id = String(rule[0]), index = byId[id];
    if (index === undefined) {
      byId[id] = unique.length;
      unique.push(rule);
      return;
    }
    var time = new Date(rule[4]).getTime(), previous = new Date(unique[index][4]).getTime();
    if (!isNaN(time) && (isNaN(previous) || time < previous)) unique[index] = rule;
  });
  return unique;
}

function _PrintChecklist_writeExclusionRules(ss, rules) {
  rules = _PrintChecklist_dedupeExclusionRules(rules);
  rules.sort(function (a, b) { return String(a[0]).localeCompare(String(b[0])); });
  const sheet = _PrintChecklist_sheet(ss, PRINT_CHECKLIST_EXCLUSION_RULE_SHEET);
  _PrintChecklist_writeSimpleSheet(sheet, PRINT_CHECKLIST_EXCLUSION_RULE_HEADERS, rules);
  if (rules.length) sheet.getRange(PRINT_CHECKLIST_FIRST_DATA_ROW, 5, rules.length, 1).setNumberFormat('yyyy/MM/dd HH:mm');
  sheet.setColumnWidth(4, 280);
}

// insertCheckboxes() が「固定されている列と固定されていない列は結合できません」等で
// 落ちることがある（2026-10-14〜）。チェックボックスは入力補助なので、失敗しても
// 同等の入力規則へ退避し、シート全体の書き込みを止めない。
function _PrintChecklist_insertCheckboxes(range) {
  try {
    range.insertCheckboxes();
    return true;
  } catch (e) {
    try {
      range.setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
      console.warn('PrintChecklist: insertCheckboxes 失敗→requireCheckbox へ退避: ' + String(e && e.message ? e.message : e));
      return true;
    } catch (e2) {
      console.warn('PrintChecklist: チェックボックス設定を諦めました: ' + String(e && e.message ? e.message : e) +
        ' / ' + String(e2 && e2.message ? e2.message : e2));
      return false;
    }
  }
}

function _PrintChecklist_writeDescription(sheet, columns) {
  const range = sheet.getRange(PRINT_CHECKLIST_DESC_ROW, 1, 1, columns);
  range.breakApart().clearContent().clearDataValidations();
  // 人が固定した列の境界をまたぐ結合は、遅延書き込みで数分後に失敗する。
  // 固定列を維持し、説明文は固定側の範囲だけで結合する。
  const frozen = sheet.getFrozenColumns();
  const mergeColumns = frozen > 0 && frozen < columns ? frozen : columns;
  if (mergeColumns > 1) sheet.getRange(PRINT_CHECKLIST_DESC_ROW, 1, 1, mergeColumns).merge();
  sheet.getRange(PRINT_CHECKLIST_DESC_ROW, 1).setValue(PRINT_CHECKLIST_DESCRIPTIONS[sheet.getName()]);
  range.setWrap(true)
    .setBackground('#eeeeee').setFontWeight('bold').setFontSize(10);
  sheet.setRowHeight(PRINT_CHECKLIST_DESC_ROW, 48);
}

function PrintChecklist_protectSheets(opts) {
  return _PrintChecklist_protectSheets(_PrintChecklist_getOrCreateSpreadsheet(), !!(opts && opts.warningOnly === true));
}

// 保護一覧を Sheets API の1回の応答で照合する。個々の Protection の RPC を数十回繰り返さない。
function _PrintChecklist_protectionsMatch(ss, warningOnly) {
  if (typeof UrlFetchApp === 'undefined' || typeof ScriptApp === 'undefined') return false;
  try {
    const response = UrlFetchApp.fetch('https://sheets.googleapis.com/v4/spreadsheets/' + ss.getId() +
      '?fields=sheets(properties(sheetId,title,gridProperties(rowCount)),protectedRanges(description,range,warningOnly))',
      { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } });
    const sheets = JSON.parse(response.getContentText()).sheets || [];
    if (!sheets.length) return false;
    return sheets.every(function (meta) {
      const name = meta.properties.title;
      if (!PRINT_CHECKLIST_DESCRIPTIONS[name]) return true;
      const sheet = ss.getSheetByName(name), max = meta.properties.gridProperties.rowCount, id = meta.properties.sheetId;
      const expected = [['description', 0, 1, 0, sheet.getLastColumn(), true]];
      if (name === PRINT_CHECKLIST_PRINTER_MASTER_SHEET) {
        expected.push(['headers', 1, 2, 0, 6, warningOnly], ['auto', 2, max, 3, 5, warningOnly]);
      } else if ([PRINT_CHECKLIST_PRINTER_SHEET, PRINT_CHECKLIST_MAIN_SHEET, PRINT_CHECKLIST_PAST_SHEET, PRINT_CHECKLIST_EXCLUDED_SHEET].indexOf(name) >= 0) {
        if (name === PRINT_CHECKLIST_PRINTER_SHEET || name === PRINT_CHECKLIST_MAIN_SHEET) expected.push(['A', 1, max, 0, 1, warningOnly], ['C-Q', 1, max, 2, 17, warningOnly]);
        else expected.push(['A-Q', 1, max, 0, 17, warningOnly]);
        expected.push(['X-Y', 1, max, 23, 25, warningOnly], ['AA', 1, max, 26, 27, warningOnly]);
        if (name === PRINT_CHECKLIST_PRINTER_SHEET) expected.push(['AB', 1, max, 27, 28, warningOnly]);
      }
      const prefix = 'PrintChecklist:' + name + ':';
      const actual = (meta.protectedRanges || []).filter(function (p) { return String(p.description || '').indexOf(prefix) === 0; });
      return actual.length === expected.length && expected.every(function (e) {
        return actual.some(function (p) {
          const r = p.range || {};
          return p.description === prefix + e[0] && !!p.warningOnly === e[5] && r.sheetId === id &&
            (r.startRowIndex || 0) === e[1] && r.endRowIndex === e[2] && (r.startColumnIndex || 0) === e[3] && r.endColumnIndex === e[4];
        });
      });
    });
  } catch (e) {
    if (_printChecklistTiming) _printChecklistTiming.timings[_printChecklistTiming.timings.length - 1].apiError = String(e.message || e).slice(0, 350);
    return false;
  } // APIが使えない場合は従来の厳密な照合・修復を行う。
}

function _PrintChecklist_protectSheets(ss, warningOnly) {
  if (_PrintChecklist_protectionsMatch(ss, warningOnly)) {
    if (_printChecklistTiming) {
      const entry = _printChecklistTiming.timings[_printChecklistTiming.timings.length - 1];
      if (entry) entry.protectionsUnchanged = true;
    }
    return { ok: true, unchanged: true, warningOnly: warningOnly };
  }
  let count = 0;
  Object.keys(PRINT_CHECKLIST_DESCRIPTIONS).forEach(function (name) {
    const sheet = ss.getSheetByName(name);
    if (!sheet) return;
    const existing = {};
    sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(function (p) { existing[p.getDescription()] = p; });
    const prefix = 'PrintChecklist:' + name + ':';
    const used = {};
    const protect = function (suffix, range, warn) {
      const description = prefix + suffix;
      used[description] = true;
      const prior = existing[description];
      const protection = prior || range.protect().setDescription(description);
      const wasWarning = prior ? protection.isWarningOnly() : true;
      if (!prior || protection.getRange().getA1Notation() !== range.getA1Notation()) protection.setRange(range);
      if (!prior || wasWarning !== warn) protection.setWarningOnly(warn);
      // 既存の強制保護は権限を再設定しない。初回と警告→強制への変更時だけ設定する。
      if (!warn && (!prior || wasWarning)) {
        try {
          // 所有者は removeEditors で外れない。userinfo.email の追加認可を不要にする。
          protection.removeEditors(protection.getEditors());
          if (protection.canDomainEdit()) protection.setDomainEdit(false);
        } catch (e) { console.error('PrintChecklist 保護設定失敗: ' + description + ': ' + String(e)); throw e; }
      }
      count++;
    };
    // 保護の分け方を変えたときに前回までの保護が残ると、空けたはずの列が保護されたままになる。
    // 例: 本体を A〜Q 一括から「Bを空ける」形へ変えても旧 'A-Q' が残ると B列が編集できない。
    const dropUnused = function () {
      Object.keys(existing).forEach(function (description) {
        if (description.indexOf(prefix) !== 0 || used[description]) return;
        try { existing[description].remove(); } catch (e) { /* すでに消えていれば無視 */ }
      });
    };
    protect('description', sheet.getRange(PRINT_CHECKLIST_DESC_ROW, 1, 1, sheet.getLastColumn()), true);
    if (name === PRINT_CHECKLIST_PRINTER_MASTER_SHEET) {
      protect('headers', sheet.getRange(2, 1, 1, 6), warningOnly);
      protect('auto', sheet.getRange(3, 4, sheet.getMaxRows() - 2, 2), warningOnly);
      dropUnused();
      return;
    }
    if ([PRINT_CHECKLIST_PRINTER_SHEET, PRINT_CHECKLIST_MAIN_SHEET, PRINT_CHECKLIST_PAST_SHEET, PRINT_CHECKLIST_EXCLUDED_SHEET].indexOf(name) < 0) { dropUnused(); return; }
    // B列「状態」は「印刷する/しない」の仕分け入力列。印刷会社様用(進行の選択)と本体(社内の仕分け)の
    // 両方で人が編集するので、A〜Qの保護をBの両側に分けてBだけ編集できるようにする。
    const editableB = name === PRINT_CHECKLIST_PRINTER_SHEET || name === PRINT_CHECKLIST_MAIN_SHEET;
    const spans = editableB ? [[1, 1, 'A'], [3, 15, 'C-Q'], [24, 2, 'X-Y']] : [[1, 17, 'A-Q'], [24, 2, 'X-Y']];
    spans.push([27, 1, 'AA']);
    if (name === PRINT_CHECKLIST_PRINTER_SHEET) spans.push([28, 1, 'AB']);
    spans.forEach(function (span) {
      protect(span[2], sheet.getRange(PRINT_CHECKLIST_HEADER_ROW, span[0], sheet.getMaxRows() - PRINT_CHECKLIST_HEADER_ROW + 1, span[1]), warningOnly);
    });
    dropUnused();
  });
  return { ok: true, protections: count, warningOnly: warningOnly };
}

function _PrintChecklist_writeAll(ss, rows, designRows, currentCases, errorMap, scanNotes, now, exclusionRules, pendingInstructions, master) {
  master = master || _PrintChecklist_readPrinterMaster(ss);
  const defaultName = _PrintChecklist_defaultPrinterName(master);
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
  const caseMap = {};
  _PrintChecklist_getCases(null).forEach(function (c) { caseMap[c.caseId] = c; });
  const main = [], past = [], excluded = [];
  rows.forEach(function (r) {
    if (r[1] === '対象外') { excluded.push(r); return; }
    const c = caseMap[String(r[2] || '')];
    const eventDate = c ? (_PrintChecklist_date(c.endDate) || _PrintChecklist_date(c.startDate)) : null;
    (eventDate && eventDate < cutoff ? past : main).push(r);
  });
  // 書式・別タブを含め、最初の書き込みより前に全ての減少を検査する。
  const retention = _PrintChecklist_assertRetention(ss, excluded, exclusionRules);
  _PrintChecklist_ensurePrinterMaster(ss);
  const printer = _PrintChecklist_rowsForPrinter(main, defaultName, defaultName);
  _PrintChecklist_timed('writeAll:writeListSheet:PRINT_CHECKLIST_PRINTER_SHEET', function () { _PrintChecklist_writeListSheet(_PrintChecklist_sheet(ss, PRINT_CHECKLIST_PRINTER_SHEET), printer, null, ss.getId()); }, true);
  _PrintChecklist_timed('writeAll:writeListSheet:PRINT_CHECKLIST_MAIN_SHEET', function () { _PrintChecklist_writeListSheet(_PrintChecklist_sheet(ss, PRINT_CHECKLIST_MAIN_SHEET), main, master, ss.getId()); }, true);
  _PrintChecklist_timed('writeAll:writeListSheet:PRINT_CHECKLIST_PAST_SHEET', function () { _PrintChecklist_writeListSheet(_PrintChecklist_sheet(ss, PRINT_CHECKLIST_PAST_SHEET), past, master, ss.getId()); }, true);
  _PrintChecklist_timed('writeAll:writeListSheet:PRINT_CHECKLIST_EXCLUDED_SHEET', function () { _PrintChecklist_writeListSheet(_PrintChecklist_sheet(ss, PRINT_CHECKLIST_EXCLUDED_SHEET), excluded, master, ss.getId()); }, true);
  const rank = { '高': 0, '中': 1, '低': 2 };
  designRows.sort(function (a, b) { return (rank[a[2]] === undefined ? 2 : rank[a[2]]) - (rank[b[2]] === undefined ? 2 : rank[b[2]]) || String(a[0]).localeCompare(String(b[0])); });
  _PrintChecklist_timed('writeAll:writeDesignSheet', function () { _PrintChecklist_writeDesignSheet(_PrintChecklist_sheet(ss, PRINT_CHECKLIST_DESIGN_SHEET), designRows); }, true);
  _PrintChecklist_timed('writeAll:writeSummary', function () { _PrintChecklist_writeSummary(ss, rows, currentCases, caseMap, errorMap, scanNotes, main); }, true);
  _PrintChecklist_invalidateReviewCache(now);
  _PrintChecklist_timed('writeAll:writeExclusionRules', function () { _PrintChecklist_writeExclusionRules(ss, exclusionRules); }, true);
  _PrintChecklist_timed('writeAll:writeGuide', function () { _PrintChecklist_writeGuide(ss, now, pendingInstructions); }, true);
  const obsoleteDesignSheet = ss.getSheetByName('未マッチのデザインデータ');
  if (obsoleteDesignSheet && ss.getSheets().length > 1) ss.deleteSheet(obsoleteDesignSheet);
  const defaultSheet = ss.getSheetByName('シート1') || ss.getSheetByName('Sheet1');
  if (defaultSheet && ss.getSheets().length > 1) ss.deleteSheet(defaultSheet);
  [PRINT_CHECKLIST_PRINTER_SHEET, PRINT_CHECKLIST_MAIN_SHEET, PRINT_CHECKLIST_SUMMARY_SHEET, PRINT_CHECKLIST_DESIGN_SHEET,
    PRINT_CHECKLIST_PAST_SHEET, PRINT_CHECKLIST_EXCLUDED_SHEET, PRINT_CHECKLIST_GUIDE_SHEET,
    PRINT_CHECKLIST_EXCLUSION_RULE_SHEET, PRINT_CHECKLIST_PRINTER_MASTER_SHEET].forEach(function (name, i) {
    const tab = ss.getSheetByName(name);
    if (!tab.getIndex || tab.getIndex() !== i + 1) { ss.setActiveSheet(tab); ss.moveActiveSheet(i + 1); }
  });
  _PrintChecklist_timed('writeAll:protectSheets', function () { _PrintChecklist_protectSheets(ss, false); }, true);
  ss.setActiveSheet(ss.getSheetByName(PRINT_CHECKLIST_PRINTER_SHEET));
  SpreadsheetApp.flush();
  const props = PropertiesService.getScriptProperties();
  props.setProperty('PRINT_CHECKLIST_RETENTION_COUNTS', JSON.stringify(retention));
  props.deleteProperty('PRINT_CHECKLIST_RETENTION_WARNING');
  return { printerViewRows: printer.length, mainRows: main };
}

function _PrintChecklist_retentionDrop(before, after) {
  return before >= 10 && after < before / 2;
}

function _PrintChecklist_assertRetention(ss, excluded, rules) {
  const props = PropertiesService.getScriptProperties();
  const stored = JSON.parse(props.getProperty('PRINT_CHECKLIST_RETENTION_COUNTS') || 'null');
  const previous = stored && stored.ssId === ss.getId() ? stored : {};
  const count = function (name, firstHeader) {
    return _PrintChecklist_readTable(ss.getSheetByName(name), firstHeader).rows.filter(function (r) { return r.some(function (v) { return v !== '' && v != null; }); }).length;
  };
  const before = { excluded: Math.max(previous.excluded || 0, count(PRINT_CHECKLIST_EXCLUDED_SHEET, '印刷ID')),
    rules: Math.max(previous.rules || 0, count(PRINT_CHECKLIST_EXCLUSION_RULE_SHEET, 'ルールID')) };
  const next = { ssId: ss.getId(), excluded: excluded.length, rules: _PrintChecklist_dedupeExclusionRules(rules).length };
  const losses = ['excluded', 'rules'].filter(function (k) { return _PrintChecklist_retentionDrop(before[k], next[k]); });
  if (losses.length) {
    const warning = '⚠ 印刷物の大量消失を検知し、書き込みを中止しました: ' + losses.map(function (k) {
      return (k === 'excluded' ? PRINT_CHECKLIST_EXCLUDED_SHEET : PRINT_CHECKLIST_EXCLUSION_RULE_SHEET) + ' ' + before[k] + ' → ' + next[k] + ' 行';
    }).join(' / ');
    props.setProperty('PRINT_CHECKLIST_RETENTION_WARNING', warning);
    throw new Error(warning);
  }
  return next;
}

// 同じルールを再利用し、他の条件付き書式を保持する。
function _PrintChecklist_highlightPending(sheet) {
  var formula = '=$B3="未確認"';
  var rules = sheet.getConditionalFormatRules().filter(function (rule) {
    var condition = rule.getBooleanCondition();
    return !(condition && String(condition.getCriteriaValues()[0]) === formula &&
      rule.getRanges().length === 1 && rule.getRanges()[0].getColumn() === 2 && rule.getRanges()[0].getNumColumns() === 1);
  });
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(formula).setBackground('#fff2cc')
    .setRanges([sheet.getRange(3, 2, Math.max(1, sheet.getMaxRows() - 2), 1)]).build());
  sheet.setConditionalFormatRules(rules);
}

// ビルドで初めて現れた未確認IDを案件ごとに保持。再ビルドでは増やさず、送信成功時だけ消す。
function _PrintChecklist_recordNewPending(ss, previousRows) {
  var old = {}, byCase = {}, props = PropertiesService.getScriptProperties();
  previousRows.forEach(function (r) { old[String(r[0])] = true; });
  var main = ss.getSheetByName(PRINT_CHECKLIST_MAIN_SHEET);
  var rows = _PrintChecklist_tableRows(_PrintChecklist_readTable(main, '印刷ID'), PRINT_CHECKLIST_HEADERS);
  rows.forEach(function (r) {
    if (r[0] && r[2] && r[1] === '未確認' && !old[String(r[0])]) {
      (byCase[String(r[2])] || (byCase[String(r[2])] = [])).push(String(r[0]));
    }
  });
  Object.keys(byCase).forEach(function (caseId) {
    var key = 'PRINT_CHECKLIST_NEW_PENDING_' + caseId;
    var ids = JSON.parse(props.getProperty(key) || '[]');
    byCase[caseId].forEach(function (id) { if (ids.indexOf(id) < 0) ids.push(id); });
    props.setProperty(key, JSON.stringify(ids));
  });
}

// 書式はデータと分離して保持する。途中失敗した場合は完了印を残さない。
function _PrintChecklist_listLayout(sheet, rows, master, ssId) {
  if (!ssId) return { refresh: true };
  const key = 'PRINT_CHECKLIST_LAYOUT_' + ssId + '_' + sheet.getSheetId();
  const signature = JSON.stringify(['20261015-v1', rows.length, sheet.getMaxRows(), sheet.getMaxColumns(),
    sheet.getFrozenColumns(), sheet.getName(), master ? master.map(function (p) { return p.name; }) : null,
    PRINT_CHECKLIST_HEADERS, PRINT_CHECKLIST_STATUS_VALUES, PRINT_CHECKLIST_PD_REVIEW_VALUES,
    PRINT_CHECKLIST_DATA_CHECK_VALUES, PRINT_CHECKLIST_DESCRIPTIONS[sheet.getName()]]);
  return { key: key, signature: signature,
    refresh: PropertiesService.getScriptProperties().getProperty(key) !== signature };
}

function _PrintChecklist_contentHash(value) {
  const json = JSON.stringify(value);
  if (Utilities.computeDigest && Utilities.DigestAlgorithm) return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, json)
    .map(function (n) { return ('0' + ((n + 256) % 256).toString(16)).slice(-2); }).join('');
  return _PrintChecklist_stableHash8(json);
}
function _PrintChecklist_unchangedWrite(sheet, payload, run, verify) {
  // テストの簡易Sheet / 外部呼出しでも従来どおり動く。
  if (!sheet.getParent || !sheet.getSheetId) return run();
  const props = PropertiesService.getScriptProperties();
  const key = 'pc_content_v1_' + sheet.getParent().getId() + '_' + sheet.getSheetId();
  const hash = _PrintChecklist_contentHash(payload);
  const stage = _printChecklistTiming && _printChecklistTiming.timings[_printChecklistTiming.timings.length - 1];
  if (props.getProperty(key) === hash && (!verify || verify())) {
    if (stage) stage.skippedWrite = true;
    return { unchanged: true };
  }
  if (stage) stage.skippedWrite = false;
  props.deleteProperty(key);
  const result = run();
  SpreadsheetApp.flush();
  props.setProperty(key, hash);
  return result;
}
function _PrintChecklist_writeListSheet(sheet, rows, master, ssId) {
  const sheetName = sheet.getName();
  const output = rows.map(function (r) { return PRINT_CHECKLIST_HEADERS.map(function (_, i) {
    return sheetName === PRINT_CHECKLIST_PRINTER_SHEET && i >= 26 ? '' : r[i] == null ? '' : r[i];
  }); });
  return _PrintChecklist_unchangedWrite(sheet, [output, master, PRINT_CHECKLIST_DESCRIPTIONS[sheetName]], function () {
    return _PrintChecklist_writeListSheetUncached(sheet, rows, master, ssId);
  }, function () {
    // B/R〜X/Z/AB の実入力は Properties のハッシュだけでは検出できない。必ず現物と比較。
    const actual = _PrintChecklist_tableRows(_PrintChecklist_readTable(sheet, '印刷ID'), PRINT_CHECKLIST_HEADERS);
    return _PrintChecklist_contentHash(actual) === _PrintChecklist_contentHash(output);
  });
}

function _PrintChecklist_writeListSheetUncached(sheet, rows, master, ssId) {
  _PrintChecklist_resize(sheet, Math.max(PRINT_CHECKLIST_FIRST_DATA_ROW, rows.length + PRINT_CHECKLIST_HEADER_ROW), PRINT_CHECKLIST_HEADERS.length);
  const layout = _PrintChecklist_listLayout(sheet, rows, master, ssId);
  if (layout.refresh) {
    sheet.getRange(PRINT_CHECKLIST_HEADER_ROW, 1, 1, PRINT_CHECKLIST_HEADERS.length).clearDataValidations();
    sheet.getRange(PRINT_CHECKLIST_HEADER_ROW, 1, 1, PRINT_CHECKLIST_HEADERS.length).setValues([PRINT_CHECKLIST_HEADERS]);
    // 新状態を書き込む前に旧プルダウンを更新する（strict validation対応）。
    if (rows.length) {
      sheet.getRange(PRINT_CHECKLIST_FIRST_DATA_ROW, 2, rows.length, 1).setDataValidation(SpreadsheetApp.newDataValidation()
        .requireValueInList(PRINT_CHECKLIST_STATUS_VALUES, true).setAllowInvalid(false).build());
    }
  }
  if (rows.length) {
    // 列追加時に隣のZ列のPDプルダウンが継承されるため、自動生成URL列の入力規則を解除する。
    if (layout.refresh) sheet.getRange(PRINT_CHECKLIST_FIRST_DATA_ROW, 27, rows.length, 2).clearDataValidations();
    const outputRows = sheet.getName() === PRINT_CHECKLIST_PRINTER_SHEET ? rows.map(function (r) {
      const copy = r.slice(); copy[26] = ''; copy[27] = ''; return copy;
    }) : rows;
    sheet.getRange(PRINT_CHECKLIST_FIRST_DATA_ROW, 1, rows.length, PRINT_CHECKLIST_HEADERS.length).setValues(outputRows.map(function (r) { return PRINT_CHECKLIST_HEADERS.map(function (_, i) { return r[i] == null ? '' : r[i]; }); }));
  }
  if (sheet.getLastRow() > rows.length + PRINT_CHECKLIST_HEADER_ROW) sheet.getRange(rows.length + PRINT_CHECKLIST_FIRST_DATA_ROW, 1, sheet.getLastRow() - rows.length - PRINT_CHECKLIST_HEADER_ROW, PRINT_CHECKLIST_HEADERS.length).clearContent().clearDataValidations();
  if (layout.refresh) {
    sheet.setFrozenRows(PRINT_CHECKLIST_HEADER_ROW);
    if (sheet.getName() === PRINT_CHECKLIST_MAIN_SHEET) _PrintChecklist_highlightPending(sheet);
    _PrintChecklist_writeDescription(sheet, PRINT_CHECKLIST_HEADERS.length);
    sheet.getRange(PRINT_CHECKLIST_HEADER_ROW, 1, 1, PRINT_CHECKLIST_HEADERS.length).setFontWeight('bold').setBackground('#d9ead3');
    sheet.getRange(PRINT_CHECKLIST_HEADER_ROW, 18, 1, 6).setBackground('#fce5cd');
    sheet.getRange(PRINT_CHECKLIST_HEADER_ROW, 24).setBackground('#d0e0e3');
    sheet.getRange(PRINT_CHECKLIST_HEADER_ROW, 26).setBackground('#d9d2e9').setNote('社内用（弊社プロデューサー記入欄）。印刷会社様は記入不要です。');
    sheet.setColumnWidth(26, 160);
    sheet.setColumnWidth(27, 220);
    sheet.setColumnWidth(28, 140);
    sheet.getRange(PRINT_CHECKLIST_HEADER_ROW, 28).setBackground('#d9d2e9');
    if (master && sheet.getName() !== PRINT_CHECKLIST_PRINTER_SHEET) sheet.getRange(3, 28, Math.max(1, rows.length), 1).clearDataValidations();
    if (master && master.length && sheet.getName() !== PRINT_CHECKLIST_PRINTER_SHEET) {
      sheet.getRange(3, 28, Math.max(1, rows.length), 1).setDataValidation(SpreadsheetApp.newDataValidation()
        .requireValueInList(master.map(function (p) { return p.name; }), true).setAllowInvalid(true).build());
    }
  }
  if (rows.length) {
    if (layout.refresh) {
      sheet.getRange(PRINT_CHECKLIST_FIRST_DATA_ROW, 18, rows.length, 6).setBackground('#fce5cd');
      sheet.getRange(PRINT_CHECKLIST_FIRST_DATA_ROW, 26, rows.length, 1).setDataValidation(SpreadsheetApp.newDataValidation()
        .requireValueInList(PRINT_CHECKLIST_PD_REVIEW_VALUES, true).setAllowInvalid(false).build());
      sheet.getRange(PRINT_CHECKLIST_FIRST_DATA_ROW, 7, rows.length, 2).setNumberFormat('yyyy/MM/dd');
      sheet.getRange(PRINT_CHECKLIST_FIRST_DATA_ROW, 20, rows.length, 2).setNumberFormat('yyyy/MM/dd');
      sheet.getRange(PRINT_CHECKLIST_FIRST_DATA_ROW, 25, rows.length, 1).setNumberFormat('yyyy/MM/dd HH:mm');
      sheet.getRange(PRINT_CHECKLIST_FIRST_DATA_ROW, 14, rows.length, 1).setWrap(true);
      sheet.getRange(PRINT_CHECKLIST_FIRST_DATA_ROW, 27, rows.length, 1).setWrap(false);
      // Checkbox規則だけでも空欄がFALSEへ変わるため、元の値を必ず書き戻す。
      // 入力規則の設定は補助書式なので、ここで落ちて本体の書き込みを止めない（PR #31 と同じ退避）。
      _PrintChecklist_insertCheckboxes(sheet.getRange(PRINT_CHECKLIST_FIRST_DATA_ROW, 18, rows.length, 1));
      sheet.getRange(PRINT_CHECKLIST_FIRST_DATA_ROW, 18, rows.length, 1).setValues(rows.map(function (r) { return [r[17]]; }));
      sheet.getRange(PRINT_CHECKLIST_FIRST_DATA_ROW, 19, rows.length, 1).setDataValidation(SpreadsheetApp.newDataValidation()
        .requireValueInList(PRINT_CHECKLIST_DATA_CHECK_VALUES, true).setAllowInvalid(false).build());
    }
    sheet.getRange(PRINT_CHECKLIST_FIRST_DATA_ROW, 26, rows.length, 1).setBackgrounds(rows.map(function (r) {
      return [!r[25] || r[25] === '未確認' ? '#fff2cc' : '#ffffff'];
    }));
    if (sheet.getName() === PRINT_CHECKLIST_PRINTER_SHEET) {
      sheet.getRange(PRINT_CHECKLIST_FIRST_DATA_ROW, 18, rows.length, 6).setNotes(rows.map(function (r) {
        return r.slice(17, 23).map(_PrintChecklist_inputNote);
      }));
      sheet.getRange(PRINT_CHECKLIST_FIRST_DATA_ROW, 2, rows.length, 1).setNotes(rows.map(function (r) { return ['PrintChecklist:lastStatus:' + String(r[1])]; }));
    }
  }
  if (layout.refresh) {
    sheet.setColumnWidth(10, 260); sheet.setColumnWidth(14, 300); sheet.setColumnWidth(17, 320);
    sheet.setColumnWidth(23, 240); sheet.setColumnWidth(24, 300);
    if (layout.key) {
      SpreadsheetApp.flush();
      PropertiesService.getScriptProperties().setProperty(layout.key, layout.signature);
    }
  }
}

function _PrintChecklist_writeSimpleSheet(sheet, headers, rows) {
  _PrintChecklist_resize(sheet, Math.max(PRINT_CHECKLIST_FIRST_DATA_ROW, rows.length + PRINT_CHECKLIST_HEADER_ROW), headers.length);
  sheet.getRange(PRINT_CHECKLIST_HEADER_ROW, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#d9ead3');
  if (rows.length) sheet.getRange(PRINT_CHECKLIST_FIRST_DATA_ROW, 1, rows.length, headers.length).setValues(rows);
  if (sheet.getLastRow() > rows.length + PRINT_CHECKLIST_HEADER_ROW) sheet.getRange(rows.length + PRINT_CHECKLIST_FIRST_DATA_ROW, 1, sheet.getLastRow() - rows.length - PRINT_CHECKLIST_HEADER_ROW, headers.length).clearContent().clearDataValidations();
  sheet.setFrozenRows(PRINT_CHECKLIST_HEADER_ROW);
  _PrintChecklist_writeDescription(sheet, headers.length);
}

function _PrintChecklist_writeDesignSheet(sheet, rows) {
  return _PrintChecklist_unchangedWrite(sheet, [PRINT_CHECKLIST_DESIGN_HEADERS, rows], function () { return _PrintChecklist_writeDesignSheetUncached(sheet, rows); });
}
function _PrintChecklist_writeDesignSheetUncached(sheet, rows) {
  _PrintChecklist_writeSimpleSheet(sheet, PRINT_CHECKLIST_DESIGN_HEADERS, rows);
  if (!rows.length) return;
  sheet.getRange(PRINT_CHECKLIST_FIRST_DATA_ROW, 7, rows.length, 1).setNumberFormat('yyyy/MM/dd HH:mm');
  const colors = rows.map(function (r) {
    return new Array(PRINT_CHECKLIST_DESIGN_HEADERS.length).fill(r[2] === '高' && r[7] === '未' ? '#fff2cc' : '#ffffff');
  });
  sheet.getRange(PRINT_CHECKLIST_FIRST_DATA_ROW, 1, rows.length, PRINT_CHECKLIST_DESIGN_HEADERS.length).setBackgrounds(colors);
  sheet.setColumnWidth(5, 320); sheet.setColumnWidth(9, 300);
}

function _PrintChecklist_writeSummary(ss, rows, currentCases, caseMap, errorMap, scanNotes, main) {
  var reviewCounts = _PrintChecklist_reviewCounts(main || []);
  const counts = {};
  rows.forEach(function (r) {
    const id = String(r[2] || '');
    if (!counts[id]) counts[id] = { total: 0, yes: 0, no: 0, pending: 0 };
    if (r[1] === '未確認' || r[1] === '対象外') return;
    counts[id].total++; if (r[14] === 'あり') counts[id].yes++; if (r[14] === 'なし') counts[id].no++; if (r[1] === '未入稿') counts[id].pending++;
  });
  const ids = {};
  rows.forEach(function (r) { ids[String(r[2] || '')] = true; });
  currentCases.forEach(function (c) { ids[c.caseId] = true; });
  const data = Object.keys(ids).sort().map(function (id) {
    const c = caseMap[id] || CaseList_getById(id) || { caseId: id }, n = counts[id] || { total: 0, yes: 0, no: 0, pending: 0 };
    const start = _PrintChecklist_date(c.startDate), end = _PrintChecklist_date(c.endDate);
    const deadline = start ? new Date(start.getFullYear(), start.getMonth(), start.getDate() - 14) : '';
    let kouryouLink = null;
    try { kouryouLink = JSON.parse(PropertiesService.getScriptProperties().getProperty('PRINT_CHECKLIST_KOURYOU_GID_' + id) || 'null'); } catch (e) { /* 未キャッシュは実施計画書へ */ }
    return [id, c.clientName || '', c.caseName || '', _PrintChecklist_period(start, end), deadline, n.total, n.yes, n.no, n.pending,
      c.zissiId ? _PrintChecklist_ssUrl(c.zissiId) : '',
      _PrintChecklist_seisakubutsuUrl(c.zissiId, kouryouLink && kouryouLink.gid), _PrintChecklist_projectUrl(c), _PrintChecklist_join([errorMap[id] || '', scanNotes[id] || '']), reviewCounts[id] || 0];
  });
  const sheet = _PrintChecklist_sheet(ss, PRINT_CHECKLIST_SUMMARY_SHEET);
  return _PrintChecklist_unchangedWrite(sheet, [PRINT_CHECKLIST_SUMMARY_HEADERS, data, PrintChecklist_feedbackFormUrl(ss.getId())], function () {
  _PrintChecklist_writeSimpleSheet(sheet, PRINT_CHECKLIST_SUMMARY_HEADERS, data);
  if (data.length) {
    sheet.getRange(PRINT_CHECKLIST_FIRST_DATA_ROW, 5, data.length, 1).setNumberFormat('yyyy/MM/dd');
    const backgrounds = data.map(function (r) { return new Array(PRINT_CHECKLIST_SUMMARY_HEADERS.length).fill(Number(r[PRINT_CHECKLIST_SUMMARY_HEADERS.indexOf('データなし件数')]) > 0 ? '#f4cccc' : '#ffffff'); });
    sheet.getRange(PRINT_CHECKLIST_FIRST_DATA_ROW, 1, data.length, PRINT_CHECKLIST_SUMMARY_HEADERS.length).setBackgrounds(backgrounds);
  }
  // 最終行の直下に不具合・要望フォームへの導線を置く(本表のヘッダー位置は動かさない)。
  const linkRow = data.length + PRINT_CHECKLIST_FIRST_DATA_ROW;
  _PrintChecklist_resize(sheet, linkRow, PRINT_CHECKLIST_SUMMARY_HEADERS.length);
  sheet.getRange(linkRow, 1).clearContent().clearDataValidations();
  _PrintChecklist_writeLinkCell(sheet, linkRow, 1, '🐛 不具合・要望を報告する（画像も貼れます）',
    PrintChecklist_feedbackFormUrl(ss.getId()));
  });
}

/** 不具合・要望フォームの URL を組み立てる。未設定なら '' を返す(導線を出さない)。 */
function PrintChecklist_feedbackFormUrl(ssId) {
  var base = '';
  try { base = PropertiesService.getScriptProperties().getProperty(PRINT_CHECKLIST_FORM_URL_KEY) || ''; } catch (e) { base = ''; }
  if (!base) return '';
  const src = ssId ? _PrintChecklist_ssUrl(ssId) : '';
  return base + (base.indexOf('?') >= 0 ? '&' : '?') + 'form=feedback'
    + '&app=' + encodeURIComponent(PRINT_CHECKLIST_FORM_APP_NAME)
    + (src ? '&src=' + encodeURIComponent(src) : '');
}

/** 指定セルにリンク付きテキストを書く。URL が空なら何もしない。 */
function _PrintChecklist_writeLinkCell(sheet, row, col, text, url) {
  if (!url) return false;
  const rich = SpreadsheetApp.newRichTextValue().setText(text).setLinkUrl(url).build();
  sheet.getRange(row, col).setRichTextValue(rich);
  return true;
}

function _PrintChecklist_writeGuide(ss, now, pendingInstructions) {
  const sheet = _PrintChecklist_sheet(ss, PRINT_CHECKLIST_GUIDE_SHEET);
  const formUrl = PrintChecklist_feedbackFormUrl(ss.getId());
  const feedbackText = 'このシートの不具合・要望はこちら → 🐛 不具合・要望を報告する（画像も貼れます）';
  const rows = [
    ['印刷物チェックシート 凡例・使い方'],
    [PRINT_CHECKLIST_MANUAL_TEXT + ' → ' + PRINT_CHECKLIST_MANUAL_URL],
    ['印刷会社様用シートに載っているものが印刷をお願いしたい制作物です。'],
    ['1. 「印刷物（元データ社内用）」を開き、状態が「未確認」（黄色）の行を確認する'],
    ['2. 印刷するものは B列を「未入稿」か「入稿済」に、印刷しないものは「対象外」にする'],
    ['3. 翌朝の自動更新で、未入稿・入稿済の行が「印刷会社様用」に載り、対象外の行は「対象外(除外済)」へ移る'],
    ['B列「状態」の「未確認」は、自動で拾ったばかりで社内がまだ確認していない行です。印刷会社様用シートには出ません。'],
    ['行は絶対に削除しないでください。印刷しないものは B列「状態」を「対象外」にしてください。次回更新時にこの案件の除外ルールへ自動登録され、以後この表には出ず「対象外(除外済)」シートで保持されます。B列を編集できない方は Z列「社内確認(PD)」で対象外にしてください。'],
    ['行を削除すると、次回の自動更新で記入内容が失われたまま同じ品物が「未確認」として復活します（除外ルール登録前の削除に注意してください）。'],
    ['印刷IDは品名から生成される固定値です。実施計画書の行を増やしてもIDは変わりません。'],
    ['入稿データ（校了データ）の追加先: 各案件の実施計画書「制作物一覧」シートの「校了ﾃﾞｰﾀ」列にリンクを貼る。行の品名は「アイテムリスト」と「制作物一覧」の「項目」から自動で拾う。'],
    ['反映タイミング: 毎朝6時以降に自動更新が始まり、10分ごとに数案件ずつ進むので全案件が終わるまで最大1時間程度。すぐ反映したいときはブース制作アプリ「案件一覧」のメニュー「印刷物チェックシートを更新」を実行する。'],
    ['AA列「制作物一覧リンク」は、その行の案件の実施計画書「制作物一覧」を開くリンク。制作物一覧から拾った行は該当行の「校了ﾃﾞｰﾀ」セルに直接飛ぶ。'],
    ['全案件で除外したい場合は X列「AIへの指示」に「今後も除外」「常に除外」「毎回不要」「二度と出さない」のいずれかを記入してください（保護列の編集は管理者へ依頼してください）。'],
    ['オレンジ色の R〜W 列が印刷会社様の記入欄です。ここに書いた内容は自動更新で消えません。'],
    ['印刷会社様は「印刷会社様用」シートに記入してください。'],
    ['印刷会社ごとに専用シートがあります。AB列「印刷会社」で、その行をどの印刷会社に頼むかを選んでください（空欄は「印刷会社マスタ」で既定（○）の会社）。品名・仕様に「合成紙」があれば看板宝屋、「LED UP」があればプロテックを自動で入れます（人が書いた値は上書きしません）。印刷会社を増やすときは「印刷会社マスタ」タブに会社名と共有メールを書くと、翌朝専用シートが作られます。'],
    ['Z列「社内確認(PD)」は弊社プロデューサーの記入欄です。印刷会社様は記入不要です。'],
    ['Z列を「対象外」にすると、翌日の自動更新で状態が「対象外」になり 対象外(除外済) シートへ移動します。'],
    ['間違えて対象外にした行を戻すには、「対象外(除外済)」シートでその行の Z列「社内確認(PD)」を「復活」にしてください。次回の自動更新で「' + PRINT_CHECKLIST_MAIN_SHEET + '」に状態「未確認」で戻り、除外ルールも自動で消えます（印刷会社様の記入内容はそのまま残ります）。'],
    ['B 列「状態」と S 列「データ確認」はプルダウンから選べます。'],
    ['H列「印刷締切目安」は会期初日の14日前を機械的に示した目安であり、確定納期ではありません。'],
    ['N列「デザインデータ」は、各案件の実施計画書「制作物一覧」シートの「校了データ」列だけを表示します。空欄は「まだ校了していない」という意味で、社内マニュアルや参考画像のリンクは載りません。'],
    ['データ有無が「なし」の行は、自社側でデザインデータの入稿待ちです。'],
    ['生成日時: ' + Utilities.formatDate(now, PRINT_CHECKLIST_TZ, 'yyyy/MM/dd HH:mm:ss')],
    ['生成元: ブース制作アプリ 案件一覧']
  ];
  // フォーム URL が未設定のときは導線を出さない(例外にせず空文字で握りつぶす)。
  let feedbackRow = -1;
  if (formUrl) {
    feedbackRow = rows.length + PRINT_CHECKLIST_HEADER_ROW;
    rows.push([feedbackText]);
    rows.push(['送信された内容は開発担当（kim）に直接届きます。返信で対応方針を伝えると、そのまま修正作業に回ります。']);
  }
  rows.push(['未処理のAIへの指示: ' + pendingInstructions.length + ' 件']);
  pendingInstructions.forEach(function (item) {
    rows.push([item.printId + ' / ' + item.caseId + ' / ' + item.itemName + ' / ' + item.instruction]);
  });
  _PrintChecklist_writeSimpleSheet(sheet, rows[0], rows.slice(1));
  sheet.getRange(PRINT_CHECKLIST_HEADER_ROW, 1).setFontSize(14);
  sheet.setColumnWidth(1, 720);
  sheet.getRange(PRINT_CHECKLIST_DESC_ROW, 1, rows.length + 1, 1).setWrap(true);
  if (feedbackRow > 0) _PrintChecklist_writeLinkCell(sheet, feedbackRow, 1, feedbackText, formUrl);
}

function _PrintChecklist_sheet(ss, name) { return ss.getSheetByName(name) || ss.insertSheet(name); }
function _PrintChecklist_resize(sheet, rows, cols) {
  if (sheet.getMaxRows() < rows) sheet.insertRowsAfter(sheet.getMaxRows(), rows - sheet.getMaxRows());
  if (sheet.getMaxColumns() < cols) sheet.insertColumnsAfter(sheet.getMaxColumns(), cols - sheet.getMaxColumns());
}
function _PrintChecklist_readErrorMap(ss) {
  const sheet = ss.getSheetByName(PRINT_CHECKLIST_SUMMARY_SHEET), out = {};
  const table = _PrintChecklist_readTable(sheet, '案件ID');
  _PrintChecklist_tableRows(table, PRINT_CHECKLIST_SUMMARY_HEADERS).forEach(function (r) {
    const note = r[PRINT_CHECKLIST_SUMMARY_HEADERS.indexOf('備考')];
    if (r[0] && note) out[String(r[0])] = String(note);
  });
  return out;
}
function _PrintChecklist_urlsForRow(displayRow, richRow) {
  const urls = [];
  displayRow.forEach(function (value, i) {
    const matches = String(value || '').match(/https?:\/\/[^\s　<>"']+/g) || [];
    Array.prototype.push.apply(urls, matches.map(function (u) { return u.replace(/[),.;、。]+$/, ''); }));
    const rich = richRow[i];
    if (rich && typeof rich.getLinkUrl === 'function') {
      const whole = rich.getLinkUrl(); if (whole) urls.push(whole);
      if (typeof rich.getRuns === 'function') rich.getRuns().forEach(function (run) { const u = run.getLinkUrl(); if (u) urls.push(u); });
    }
  });
  return _PrintChecklist_unique(urls);
}
function _PrintChecklist_isSubmissionLink(url) {
  const text = String(url || '');
  if (/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/[a-zA-Z0-9_-]+/i.test(text)) return true;
  return /入稿|入校|outline|アウトライン|印刷|データ/i.test(text) || /\.(?:ai|eps|psd|indd)(?:[?#].*)?$/i.test(text);
}
function _PrintChecklist_classify(text, hasUrl) {
  for (let i = 0; i < PRINT_CHECKLIST_CATEGORY_RULES.length; i++) if (PRINT_CHECKLIST_CATEGORY_RULES[i][1].test(String(text || ''))) return PRINT_CHECKLIST_CATEGORY_RULES[i][0];
  return '要判断';
}
function _PrintChecklist_hasKeyword(text) {
  text = String(text || '');
  if (_PrintChecklist_isToolOrConsumable(text)) return false;
  return PRINT_CHECKLIST_CATEGORY_RULES.some(function (r) { return r[1].test(text); });
}
// 制作物一覧は肯定キーワードを要求せず、この除外条件だけを共用する。
function _PrintChecklist_isToolOrConsumable(text) {
  text = String(text || '');
  return /養生テープ|梱包用.*テープ|粘着テープ|除菌シート|ウェットティッシュ|文房具セット/i.test(text) &&
    !/入稿|入校|outline|アウトライン|印刷|出力|データ|パネル|ボード|看板|サイン|グラフィック/i.test(text);
}
function _PrintChecklist_normalize(value) {
  let s = String(value || '');
  try { s = s.normalize('NFKC'); } catch (e) { /* V8 は通常対応 */ }
  s = s.replace(/^(?:[●★◆]+|【[^】]*】|メール添付_|\s|コピー)+/i, '')
    .replace(/(?:のコピー|_共有|_更新|見本|閲覧用)/gi, '')
    .replace(/\d{6,8}/g, '').replace(/\.[a-z0-9]{2,5}$/i, '');
  return s.toLowerCase().replace(/https?:\/\/\S+/g, '').replace(/[\s　\p{P}\p{S}]/gu, '');
}
function _PrintChecklist_namesMatch(a, b) {
  a = _PrintChecklist_normalize(a); b = _PrintChecklist_normalize(b);
  if (a.length <= 2 || b.length <= 2) return false;
  return a.indexOf(b) >= 0 || b.indexOf(a) >= 0;
}
function _PrintChecklist_removeUrls(value) { return String(value || '').replace(/https?:\/\/[^\s　<>"']+/g, '').replace(/\s+/g, ' ').trim(); }
function _PrintChecklist_unique(values) { const seen = {}; return values.filter(function (v) { v = String(v || '').trim(); if (!v || seen[v]) return false; seen[v] = true; return true; }); }
function _PrintChecklist_uniqueLines(a, b) { return _PrintChecklist_unique((String(a || '') + '\n' + String(b || '')).split('\n')).join('\n'); }
function _PrintChecklist_join(values) { return values.map(function (v) { return String(v || '').trim(); }).filter(Boolean).join(' / '); }
function _PrintChecklist_richCellAt(richCols, rowIndex, col) {
  const richCol = richCols[col], richRow = richCol && richCol[rowIndex];
  return richRow ? richRow[0] : null;
}
function _PrintChecklist_uniqueColumns(cols) {
  const seen = {};
  return cols.filter(function (col) {
    if (col < 0 || seen[col]) return false;
    seen[col] = true;
    return true;
  });
}
function _PrintChecklist_longestCell(row) {
  return _PrintChecklist_longestCellWithCol(row).value;
}
function _PrintChecklist_longestCellWithCol(row) {
  let best = { col: 0, value: '' };
  (row || []).forEach(function (v, col) {
    const s = String(v === null || v === undefined ? '' : v).trim();
    if (s.length > best.value.length) best = { col: col, value: s };
  });
  return best;
}
function _PrintChecklist_cell(row, col) { return col >= 0 ? row[col] : ''; }
function _PrintChecklist_number(value) { if (value === '' || value === null || value === undefined) return null; const m = String(value).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/); if (!m) return null; const n = Number(m[0]); return isFinite(n) ? n : null; }
function _PrintChecklist_size(row, detected) {
  if (detected.size >= 0 && row[detected.size]) {
    const size = String(row[detected.size]).trim();
    return /^-?\d+(?:\.\d+)?$/.test(size.replace(/,/g, '')) ? '' : size;
  }
  const dimensions = [
    detected.height >= 0 && row[detected.height] ? '縦' + row[detected.height] : '',
    detected.width >= 0 && row[detected.width] ? '横' + row[detected.width] : '',
    detected.depth >= 0 && row[detected.depth] ? '高さ' + row[detected.depth] : ''
  ].filter(Boolean);
  return dimensions.length >= 2 ? dimensions.join(' / ') : '';
}
function _PrintChecklist_extractSpecs(value) {
  const matches = String(value || '').match(/両面|片面|カラー|白黒|モノクロ|防炎|防災|ラミネート|マット|グロス|光沢|ツヤ|ハトメ|袋縫い|周囲縫製|トロマット|ターポリン|スエード|パンチカーペット|スチレン|カルプ|アルミ複合板|塩ビ|ダイノック|インクジェット|出力|W\d+|H\d+|\d+(?:\.\d+)?mm|\d+(?:\.\d+)?cm|A[0-4]|B[0-4]|\d+部|\d+枚/gi) || [];
  return _PrintChecklist_unique(matches).join(' / ');
}
function _PrintChecklist_date(value) { if (!value) return null; const d = value instanceof Date ? new Date(value.getTime()) : new Date(String(value).replace(/\//g, '-')); return isNaN(d.getTime()) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function _PrintChecklist_period(start, end) { if (!start && !end) return '未定'; const f = function (d) { return d ? Utilities.formatDate(d, PRINT_CHECKLIST_TZ, 'yyyy/MM/dd') : '未定'; }; return start && end ? f(start) + '〜' + f(end) : f(start || end); }
function _PrintChecklist_pad(n, width) { return ('000000' + n).slice(-width); }
function _PrintChecklist_stableNumber(value) { let h = 0, s = String(value || ''); for (let i = 0; i < s.length; i++) h = ((h * 31) + s.charCodeAt(i)) >>> 0; return _PrintChecklist_pad(h % 1000000, 6); }
function _PrintChecklist_sourceGoneNote(note) { note = String(note || ''); return note.indexOf('[ソース消滅]') === 0 ? note : '[ソース消滅] ' + note; }
function _PrintChecklist_compareRows(a, b) { const ad = a[6] instanceof Date ? a[6].getTime() : Number.MAX_SAFE_INTEGER, bd = b[6] instanceof Date ? b[6].getTime() : Number.MAX_SAFE_INTEGER; return ad - bd || String(a[2]).localeCompare(String(b[2])) || String(a[0]).localeCompare(String(b[0])); }
// 素のURLを保存する。gid=0も有効。校了データ列がなければA列へ案内する。
function _PrintChecklist_seisakubutsuUrl(zissiId, gid, col, rowNum) {
  if (!zissiId) return '';
  const base = _PrintChecklist_ssUrl(zissiId);
  if (gid === null || gid === undefined || gid === '') return base;
  let url = PanelLinks_sheetUrlById(base, gid);
  if (Number(rowNum) > 0) {
    let n = Math.max(0, Number(col) || 0) + 1, letters = '';
    while (n > 0) { n--; letters = String.fromCharCode(65 + n % 26) + letters; n = Math.floor(n / 26); }
    url += '&range=' + letters + rowNum;
  }
  return url;
}
function _PrintChecklist_ssUrl(id) { return 'https://docs.google.com/a/orgiast.jp/spreadsheets/d/' + id + '/edit'; }
function _PrintChecklist_projectUrl(c) { const id = c.projectFolderId || c.folderId || ''; return id ? 'https://drive.google.com/drive/folders/' + id : ''; }
function _PrintChecklist_counts(rows, designRows) { return { rows: rows.length, missingData: rows.filter(function (r) { return r[14] === 'なし'; }).length, unmatchedFiles: designRows.filter(function (r) { return r[7] === '未'; }).length }; }

/**
 * 校了データ(row40)の実データ検証用: 全案件の「制作物一覧」検出結果を、Drive 権限が弱い PC からでも
 * 読める形で残す。result_*.txt の本文は読めないが、ファイル名と description は読めるため、
 * 「どの案件で校了列を検出でき、何件拾えたか／拾えなかったか」を目印ファイルに載せる。
 * 重い(1案件ごとに実施計画書を開く)ので、survey と同じ 100 秒予算で打ち切り nextIndex を返す。
 */
function _admin_printChecklistKouryouMarker(startIndex) {
  const started = Date.now(), cases = _PrintChecklist_getCases(null);
  let index = Math.max(0, Number(startIndex) || 0), processed = 0;
  const folder = DriveApp.getFolderById(CMD_FOLDER_ID);
  const clean = function (s) { return String(s == null ? '' : s).replace(/[\/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').slice(0, 400); };
  for (; index < cases.length; index++) {
    if (Date.now() - started > 100000) break;
    const c = cases[index];
    const payload = { caseId: c.caseId, clientName: c.clientName || '', caseName: c.caseName || '' };
    try {
      if (!c.zissiId) {
        payload.error = 'zissiIdなし';
      } else {
        const debug = {};
        const map = _PrintChecklist_readKouryouMap(SpreadsheetApp.openById(c.zissiId), debug);
        const kouryouCols = map ? map.kouryouCols.map(function (x) { return x + 1; }) : [];
        const itemCols = map ? map.itemCols.map(function (x) { return x + 1; }) : [];
        const headers = debug.kouryouHeaders || [];
        payload.sheetName = map ? map.sheetName : '';
        payload.headerRow = map ? map.headerRow + 1 : null;
        payload.headers = headers.slice(0, 60);
        payload.kouryouCols = kouryouCols;
        payload.itemCols = itemCols;
        payload.entries = map ? map.entries.length : 0;
        payload.entriesWithUrl = map ? map.entries.filter(function (e) { return e.urls.length > 0; }).length : 0;
        payload.linklessCount = map ? map.linklessCount : 0;
        payload.kouryouError = debug.kouryouError || '';
        payload.headerHasMinato = headers.filter(function (h) { return String(h).indexOf('校了') >= 0; }).length;
        payload.samples = map ? map.entries.slice(0, 2).map(function (e) {
          return { name: e.name, urls: e.urls.map(function (u) { return String(u).slice(0, 100); }) };
        }) : [];
      }
    } catch (e) {
      payload.error = String(e && e.message ? e.message : e);
    }
    processed++;
    const ok = !payload.error;
    const name = 'kmark_' + clean(payload.caseId) +
      '_e' + (payload.entries == null ? 'x' : payload.entries) +
      '_u' + (payload.entriesWithUrl == null ? 'x' : payload.entriesWithUrl) +
      '_l' + (payload.linklessCount == null ? 'x' : payload.linklessCount) +
      '_kc' + ((payload.kouryouCols || []).join('.') || '0') +
      '_he' + (payload.headerHasMinato == null ? 'x' : payload.headerHasMinato) +
      '_' + (ok ? 'ok' : 'err') + '.txt';
    try {
      const f = folder.createFile(name, JSON.stringify(payload), MimeType.PLAIN_TEXT);
      try { f.setDescription(JSON.stringify(payload).slice(0, 8000)); } catch (e2) { /* description は best-effort */ }
    } catch (e3) { /* 目印は best-effort。失敗しても続行 */ }
  }
  let summary = null;
  try {
    summary = folder.createFile('kmark_done_' + index + '_of_' + cases.length + '_p' + processed + '.txt',
      JSON.stringify({ nextIndex: index, total: cases.length, processed: processed }), MimeType.PLAIN_TEXT);
  } catch (e4) { /* ignore */ }
  return { ok: true, nextIndex: index, total: cases.length, processed: processed, done: index >= cases.length };
}

function _debug_kouryouSurvey(startIndex) {
  const started = Date.now(), cases = _PrintChecklist_getCases(null);
  let index = Math.max(0, Number(startIndex) || 0);
  const results = [];
  for (; index < cases.length; index++) {
    // 1案件あたり実施計画書(3〜10MB)を開くので重い。6分制限で死ぬと結果が返らないため
    // 予算は 120 秒に抑え、nextIndex を返して呼び出し側でチェーンする。
    if (Date.now() - started > 120000) return { ok: true, done: false, nextIndex: index, results: results };
    const c = cases[index];
    if (!c.zissiId) {
      results.push({ caseId: c.caseId, error: 'zissiIdなし' });
      continue;
    }
    try {
      const debug = {};
      const map = _PrintChecklist_readKouryouMap(SpreadsheetApp.openById(c.zissiId), debug);
      if (debug.kouryouError) {
        results.push({ caseId: c.caseId, error: debug.kouryouError });
        continue;
      }
      results.push({
        caseId: c.caseId, clientName: c.clientName || '', caseName: c.caseName || '',
        sheetName: map ? map.sheetName : '', headerRow: map ? map.headerRow + 1 : null,
        headers: debug.kouryouHeaders || [], sheetId: debug.kouryouSheetId == null ? null : debug.kouryouSheetId,
        kouryouCols: map ? map.kouryouCols.map(function (col) { return col + 1; }) : [],
        rowsScanned: map ? map.rowsScanned : 0, entries: map ? map.entries.length : 0,
        samples: map ? map.entries.slice(0, 3).map(function (entry) {
          return { name: entry.name, urls: entry.urls.map(function (url) { return String(url).slice(0, 120); }) };
        }) : []
      });
    } catch (e) {
      results.push({ caseId: c.caseId, error: String(e && e.stack ? e.stack : e) });
    }
  }
  return {
    ok: true, done: true, total: cases.length,
    withSheet: results.filter(function (r) { return Boolean(r.sheetName); }).length,
    withEntries: results.filter(function (r) { return r.entries > 0; }).length,
    results: results
  };
}

// 印刷会社側の記入欄(受領・データ確認・印刷予定日・納品予定日・御社担当者・印刷会社メモ)に
// RはTRUEのみ、Sは初期値「未確認」以外を記入とする。T〜Wは非空なら保護する。
// 記入があれば自動生成由来の行でも消さない。
function _PrintChecklist_hasPrinterInput(row) {
  const cols = ['受領', 'データ確認', '印刷予定日', '納品予定日', '御社担当者', '印刷会社メモ'];
  return cols.some(function (header) {
    const v = row[PRINT_CHECKLIST_HEADERS.indexOf(header)];
    const s = String(v === undefined || v === null ? '' : v).trim();
    if (header === '受領') return s.toUpperCase() === 'TRUE';
    if (header === 'データ確認') return Boolean(s) && s !== '未確認';
    return v !== '' && v !== undefined && v !== null;
  });
}

/** 設定の照会のみ。未設定・アクセス不可でも新規作成しない。 */
function _debug_printChecklistSsId() {
  var id = '';
  try {
    id = PropertiesService.getScriptProperties().getProperty(PRINT_CHECKLIST_SS_ID_KEY) || '';
    if (!id) return { id: '', exists: false };
    var ss = SpreadsheetApp.openById(id);
    return { id: id, name: ss.getName(), url: _PrintChecklist_ssUrl(id), exists: true,
      lastRunDate: PropertiesService.getScriptProperties().getProperty(PRINT_CHECKLIST_LAST_RUN_DATE_KEY),
      cursor: PropertiesService.getScriptProperties().getProperty(PRINT_CHECKLIST_CURSOR_KEY),
      timing: JSON.parse(PropertiesService.getScriptProperties().getProperty('PRINT_CHECKLIST_LAST_TIMINGS') || 'null'),
      sheets: ss.getSheets().map(function (sheet) { return { name: sheet.getName(), rows: sheet.getLastRow(),
        columns: sheet.getLastColumn(), maxRows: sheet.getMaxRows(), protections: sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE).length }; }) };
  } catch (e) { return { id: id, name: '', url: id ? _PrintChecklist_ssUrl(id) : '', exists: false }; }
}

/** リンクの全員共有をドメイン内編集に限定する。個別ユーザーの権限は変更しない。 */
function _admin_printChecklistLockdown() {
  try {
    var id = PropertiesService.getScriptProperties().getProperty('PRINT_CHECKLIST_SS_ID');
    if (!id) return { error: 'PRINT_CHECKLIST_SS_ID is not configured' };
    var file = DriveApp.getFileById(id);
    file.setSharing(DriveApp.Access.DOMAIN, DriveApp.Permission.EDIT);
    // 設定後に再取得し、実際の共有状態を読み戻す。
    file = DriveApp.getFileById(id);
    return {
      id: id,
      name: file.getName(),
      owner: file.getOwner().getEmail(),
      editors: file.getEditors().map(function (user) { return user.getEmail(); }),
      viewers: file.getViewers().map(function (user) { return user.getEmail(); }),
      access: String(file.getSharingAccess()),
      permission: String(file.getSharingPermission())
    };
  } catch (e) {
    return { error: String(e && e.message ? e.message : e) };
  }
}

/** 指定された編集者だけを追加し、共有状態を読み戻す。空指定では変更しない。 */
function _admin_printChecklistAddEditor(emails) {
  try {
    var id = PropertiesService.getScriptProperties().getProperty('PRINT_CHECKLIST_SS_ID');
    if (!id) return { error: 'PRINT_CHECKLIST_SS_ID is not configured' };
    var addresses = emails == null ? [] : (Array.isArray(emails) ? emails : [emails]);
    addresses = addresses.map(function (email) {
      if (typeof email !== 'string') throw new Error('emails must be a string or an array of strings');
      return email.trim();
    }).filter(function (email) { return email !== ''; });
    var file = DriveApp.getFileById(id);
    var failed = [];
    addresses.forEach(function (email) {
      try {
        file.addEditor(email);
      } catch (e) {
        failed.push({ email: email, message: String(e && e.message ? e.message : e) });
      }
    });
    file = DriveApp.getFileById(id);
    var owner = file.getOwner();
    return {
      id: id,
      name: file.getName(),
      owner: owner ? owner.getEmail() : null,
      editors: file.getEditors().map(function (user) { return user.getEmail(); }),
      viewers: file.getViewers().map(function (user) { return user.getEmail(); }),
      access: String(file.getSharingAccess()),
      permission: String(file.getSharingPermission()),
      failed: failed
    };
  } catch (e) {
    return { error: String(e && e.message ? e.message : e) };
  }
}

/** 印刷物チェックシートの共有状態を照会する。未設定・アクセス不可でも新規作成しない。 */
function _debug_printChecklistSharing() {
  try {
    var id = PropertiesService.getScriptProperties().getProperty('PRINT_CHECKLIST_SS_ID');
    var file = DriveApp.getFileById(id);
    return {
      id: id,
      name: file.getName(),
      owner: file.getOwner().getEmail(),
      editors: file.getEditors().map(function (user) { return user.getEmail(); }),
      viewers: file.getViewers().map(function (user) { return user.getEmail(); }),
      access: String(file.getSharingAccess()),
      permission: String(file.getSharingPermission())
    };
  } catch (e) {
    return { error: String(e && e.message ? e.message : e) };
  }
}

function _PrintChecklist_reviewCounts(rows) {
  var counts = {};
  (rows || []).forEach(function (r) {
    if (r[0] && r[2] && r[1] === '未確認') {
      counts[String(r[2])] = (counts[String(r[2])] || 0) + 1;
    }
  });
  return counts;
}

function _PrintChecklist_invalidateReviewCache(now) {
  // flush → キャッシュ破棄の順。次の読者が旧サマリを再キャッシュしないようにする。
  SpreadsheetApp.flush();
  PropertiesService.getScriptProperties().setProperty(PRINT_CHECKLIST_PD_ASOF_KEY, (now || new Date()).toISOString());
  try { CacheService.getScriptCache().remove(PRINT_CHECKLIST_PD_CACHE_KEY); } catch (e) {}
}

/** main の棚卸しだけを再集計する。ビルド不要で人の B列編集をサマリへ反映。 */
function _PrintChecklist_refreshReviewSummary(ss) {
  var main = ss.getSheetByName(PRINT_CHECKLIST_MAIN_SHEET);
  var summary = ss.getSheetByName(PRINT_CHECKLIST_SUMMARY_SHEET);
  if (!main || !summary) return false;
  var table = _PrintChecklist_readTable(summary, '案件ID');
  var col = table.headers.indexOf('棚卸し未確認件数');
  if (col < 0 || !table.rows.length) return false;
  var rows = _PrintChecklist_tableRows(_PrintChecklist_readTable(main, '印刷ID'), PRINT_CHECKLIST_HEADERS);
  var counts = _PrintChecklist_reviewCounts(rows);
  summary.getRange(table.firstDataRow, col + 1, table.rows.length, 1).setValues(table.rows.map(function (r) {
    // 最下行の不具合報告リンクは案件として扱わない。
    return [r[col] === '' || r[col] == null ? '' : (counts[String(r[0])] || 0)];
  }));
  _PrintChecklist_invalidateReviewCache(new Date());
  return true;
}

function PrintChecklist_onReviewEdit(e) {
  if (!e || !e.range || e.range.getLastRow() < PRINT_CHECKLIST_FIRST_DATA_ROW) return;
  var first = e.range.getColumn(), last = e.range.getLastColumn();
  if (!(first <= 2 && last >= 2) && !(first <= 26 && last >= 26)) return;
  if (e.range.getSheet().getName() !== PRINT_CHECKLIST_MAIN_SHEET) return;
  var id = PropertiesService.getScriptProperties().getProperty(PRINT_CHECKLIST_SS_ID_KEY);
  if (!e.source || e.source.getId() !== id) return;
  _PrintChecklist_refreshReviewSummary(e.source);
}

function PrintChecklist_installReviewTrigger() {
  var id = PropertiesService.getScriptProperties().getProperty(PRINT_CHECKLIST_SS_ID_KEY);
  if (!id) return { ok: false, reason: '未設定' };
  var existing = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === 'PrintChecklist_onReviewEdit' && t.getTriggerSourceId() === id;
  });
  if (existing.length) return { ok: true, alreadyExists: true };
  ScriptApp.newTrigger('PrintChecklist_onReviewEdit').forSpreadsheet(id).onEdit().create();
  return { ok: true, alreadyExists: false };
}

/**
 * 社内タブのB=未確認を集計する（サマリは0件案件の識別用）。戻り値 {count, url, found, asOf}。
 * キャッシュは10分、SS IDと計算時刻も照合。旧版の列欠落を0件と誤認しない。
 */
function PrintChecklist_pendingReviewCount(caseId) {
  var missing = { found: false, count: 0, url: '', asOf: null };
  try {
    var props = PropertiesService.getScriptProperties();
    var id = props.getProperty(PRINT_CHECKLIST_SS_ID_KEY);
    if (!id) return missing;
    var asOf = props.getProperty(PRINT_CHECKLIST_PD_ASOF_KEY) || '';
    var cache = null, saved = null;
    try {
      cache = CacheService.getScriptCache();
      saved = JSON.parse(cache.get(PRINT_CHECKLIST_PD_CACHE_KEY) || 'null');
    } catch (e) {}
    if (!saved || saved.id !== id || saved.asOf !== asOf) {
      var ss = SpreadsheetApp.openById(id);
      var summary = ss.getSheetByName(PRINT_CHECKLIST_SUMMARY_SHEET);
      if (!summary || summary.getLastRow() < 2) return missing;
      var table = _PrintChecklist_readTable(summary, '案件ID');
      var countCol = table.headers.indexOf('棚卸し未確認件数');
      var idCol = table.headers.indexOf('案件ID');
      if (countCol < 0 || idCol < 0) return missing;
      var main = ss.getSheetByName(PRINT_CHECKLIST_MAIN_SHEET);
      if (!main) return missing;
      var counts = _PrintChecklist_reviewCounts(_PrintChecklist_tableRows(_PrintChecklist_readTable(main, '印刷ID'), PRINT_CHECKLIST_HEADERS));
      saved = { id: id, asOf: asOf, url: (main ? PanelLinks_sheetUrlById(_PrintChecklist_ssUrl(id), main.getSheetId()) : _PrintChecklist_ssUrl(id)), counts: {} };
      table.rows.forEach(function (row) {
        var n = row[countCol];
        if (row[idCol] && n !== '' && n != null && isFinite(Number(n)) && Number(n) >= 0) {
          saved.counts[String(row[idCol])] = counts[String(row[idCol])] || 0;
        }
      });
      Object.keys(counts).forEach(function (caseId) { saved.counts[caseId] = counts[caseId]; });
      try {
        // 案件ごとの値は件数のみ。巨大ならキャッシュを諦めても結果は返す。
        var json = JSON.stringify(saved);
        if (cache && Utilities.newBlob(json).getBytes().length < 95 * 1024) cache.put(PRINT_CHECKLIST_PD_CACHE_KEY, json, 600);
      } catch (e) {}
    }
    var found = Object.prototype.hasOwnProperty.call(saved.counts, String(caseId));
    return { found: found, count: found ? saved.counts[String(caseId)] : 0, url: saved.url,
      asOf: saved.asOf && !isNaN(new Date(saved.asOf).getTime()) ? new Date(saved.asOf) : null };
  } catch (e) { return missing; }
}

/** 通知本文のdry-run。シート・送信済日・新規IDを変更せず、投稿もしない。 */
function PrintChecklist_pendingReviewMessage(caseIds) {
  var props = PropertiesService.getScriptProperties(), id = props.getProperty(PRINT_CHECKLIST_SS_ID_KEY);
  if (!id) return { content: '', heading: '', pendingCases: 0, caseIds: [] };
  var ss = SpreadsheetApp.openById(id), main = ss.getSheetByName(PRINT_CHECKLIST_MAIN_SHEET);
  if (!main) return { content: '', heading: '', pendingCases: 0, caseIds: [] };
  var rows = _PrintChecklist_tableRows(_PrintChecklist_readTable(main, '印刷ID'), PRINT_CHECKLIST_HEADERS);
  var counts = _PrintChecklist_reviewCounts(rows), pending = {}, entries = [];
  rows.forEach(function (r) { if (r[0] && r[1] === '未確認') pending[String(r[0])] = true; });
  var today = Utilities.formatDate(new Date(), PRINT_CHECKLIST_TZ, 'yyyy/MM/dd');
  (caseIds || TaskLedger_activeCaseIds()).forEach(function (caseId) {
    var count = counts[String(caseId)] || 0;
    if (!count) return;
    var c = CaseList_getById(caseId);
    if (!c) return;
    var due = TaskLedger_printReviewDue(c.startDate);
    var overdue = !!due && due < today;
    var newIds = JSON.parse(props.getProperty('PRINT_CHECKLIST_NEW_PENDING_' + caseId) || '[]');
    var newCount = newIds.filter(function (id) { return pending[id]; }).length;
    var start = _PrintChecklist_date(c.startDate);
    var line = (overdue ? '⚠期限切れ ' : '') + String(c.caseName || c.clientName || caseId).replace(/[\r\n]+/g, ' ') +
      '（' + caseId + '） / 制作P：' + TaskLedger_producerName(c) + ' / 仕分け待ち ' + count + '件' +
      (newCount ? '（新規 ' + newCount + '件）' : '') + ' / 会期初日 ' +
      (start ? Utilities.formatDate(start, PRINT_CHECKLIST_TZ, 'yyyy/MM/dd') : '未定') + ' / 期限 ' + (due || '未定');
    entries.push({ caseId: String(caseId), overdue: overdue, due: due || '9999/99/99', line: line });
  });
  entries.sort(function (a, b) { return Number(b.overdue) - Number(a.overdue) || a.due.localeCompare(b.due) || a.caseId.localeCompare(b.caseId); });
  var url = PanelLinks_sheetUrlById(_PrintChecklist_ssUrl(id), main.getSheetId());
  var heading = url + '\n印刷するものは B列を『未入稿』か『入稿済』に、印刷しないものは『対象外』にしてください\n' +
    '印刷物の仕分け（仕分け待ち ' + entries.length + '案件）\n';
  return { heading: heading, content: entries.length ? heading + entries.map(function (e) { return e.line; }).join('\n') : '',
    pendingCases: entries.length, caseIds: entries.map(function (e) { return e.caseId; }) };
}

function _PrintChecklist_staleWarning(lastRun, now) {
  const yesterday = Utilities.formatDate(new Date(now.getTime() - 86400000), PRINT_CHECKLIST_TZ, 'yyyy/MM/dd');
  return lastRun && lastRun < yesterday ? '⚠ 印刷物チェックシートの自動更新が ' + lastRun + ' から止まっています\n' : '';
}

/** 夜間巡回の先頭で1回実行。タイムアウトで巡回末尾へ届かなくても通知を落とさない。 */
function PrintChecklist_nagPendingReview(caseIds) {
  var lock = null, locked = false;
  try {
    var props = PropertiesService.getScriptProperties();
    var webhook = props.getProperty('DISCORD_ASSIGN_WEBHOOK');
    var id = props.getProperty(PRINT_CHECKLIST_SS_ID_KEY);
    if (!webhook || !id) return { sent: false, skipped: true };
    var now = new Date(), day = Utilities.formatDate(now, PRINT_CHECKLIST_TZ, 'yyyy/MM/dd');
    lock = LockService.getScriptLock();
    locked = lock.tryLock(1000);
    if (!locked) return { sent: false, skipped: true };
    if (props.getProperty('PRINT_CHECKLIST_PD_NAG_DATE') === day) return { sent: false, skipped: true };
    var warning = _PrintChecklist_staleWarning(props.getProperty(PRINT_CHECKLIST_LAST_RUN_DATE_KEY), now);
    var retentionWarning = props.getProperty('PRINT_CHECKLIST_RETENTION_WARNING');
    if (retentionWarning) warning += retentionWarning + '\n';
    // シートの読取りに失敗しても、完了日だけで判定できる更新停止警告は届ける。
    var message;
    try {
      _PrintChecklist_refreshReviewSummary(SpreadsheetApp.openById(id));
      message = PrintChecklist_pendingReviewMessage(caseIds);
    } catch (e) {
      if (!warning) throw e;
      message = { heading: '', content: '', pendingCases: 0, caseIds: [] };
    }
    if (!message.pendingCases && !warning) return { sent: false, pendingCases: 0 };
    var heading = warning + message.heading, content = warning + message.content;
    var payload = { content: content, allowed_mentions: { parse: [] } };
    var options = { method: 'post', muteHttpExceptions: true };
    if (content.length <= 2000) {
      options.contentType = 'application/json'; options.payload = JSON.stringify(payload);
    } else {
      // Discord の2000文字制限でも分割投稿しない。全文を1通の添付に保持。
      payload.content = heading + '案件別の一覧は添付をご確認ください。';
      options.payload = { payload_json: JSON.stringify(payload), 'files[0]': Utilities.newBlob(content, 'text/plain', 'print-review.txt') };
    }
    var response = UrlFetchApp.fetch(webhook, options);
    var status = response.getResponseCode();
    if (status < 200 || status >= 300) return { sent: false, pendingCases: message.pendingCases, httpStatus: status };
    props.setProperty('PRINT_CHECKLIST_PD_NAG_DATE', day);
    message.caseIds.forEach(function (caseId) { props.deleteProperty('PRINT_CHECKLIST_NEW_PENDING_' + caseId); });
    return { sent: true, pendingCases: message.pendingCases, httpStatus: status };
  } catch (e) { return { sent: false, error: '仕分け通知に失敗しました' }; }
  finally { if (locked) lock.releaseLock(); }
}

/** 管理者の棚卸し入力口。印刷IDで照合し、R〜Xは一切書き換えない。 */
function _admin_printChecklistReview(caseId, patches) {
  // 既存の管理コマンドから限定復元を呼ぶ。CommandQueueの本番差し替えは不要。
  if (caseId === 'restoreExcludedFromSnapshot') return _admin_printChecklistRestoreExcluded(patches);
  if (!Array.isArray(patches)) throw new Error('patches は配列で指定してください');
  var id = PropertiesService.getScriptProperties().getProperty(PRINT_CHECKLIST_SS_ID_KEY);
  if (!id) throw new Error('印刷物チェックシートが未設定です');
  var ss = SpreadsheetApp.openById(id), targets = {}, changes = [];
  [PRINT_CHECKLIST_MAIN_SHEET, PRINT_CHECKLIST_EXCLUDED_SHEET, PRINT_CHECKLIST_PAST_SHEET].forEach(function (name) {
    var sheet = ss.getSheetByName(name);
    if (!sheet || sheet.getLastRow() < 2 || sheet.getLastColumn() < 26) return;
    var table = _PrintChecklist_readTable(sheet, '印刷ID');
    table.rows.forEach(function (r, i) {
      if (String(r[2]) === String(caseId)) targets[String(r[0])] = { sheet: sheet, row: i + table.firstDataRow, values: r };
    });
  });
  // 書き込み前に全件検証。expectedReviewで他の編集者の変更を上書きしない。
  patches.forEach(function (p) {
    var target = targets[String(p.printId)];
    if (!target) throw new Error('印刷IDが案件にありません: ' + p.printId);
    if (PRINT_CHECKLIST_PD_REVIEW_VALUES.indexOf(p.review) < 0) throw new Error('不正な社内確認値');
    if (p.expectedReview !== undefined && (target.values[25] || '未確認') !== p.expectedReview) throw new Error('棚卸し入力が変更されています: ' + p.printId);
    if (p.restoreStatus !== undefined && PRINT_CHECKLIST_STATUS_VALUES.indexOf(p.restoreStatus) < 0) throw new Error('不正な状態');
  });
  patches.forEach(function (p) {
    var t = targets[String(p.printId)];
    t.sheet.getRange(t.row, 26).setValue(p.review);
    if (p.restoreStatus !== undefined) t.sheet.getRange(t.row, 2).setValue(p.restoreStatus);
  });
  SpreadsheetApp.flush();
  patches.forEach(function (p) {
    var t = targets[String(p.printId)];
    var actual = t.sheet.getRange(t.row, 1, 1, 26).getValues()[0];
    if (actual[25] !== p.review || (p.restoreStatus !== undefined && actual[1] !== p.restoreStatus)) throw new Error('棚卸し入力の読み戻し不一致: ' + p.printId);
    if (JSON.stringify(actual.slice(17, 24)) !== JSON.stringify(t.values.slice(17, 24))) throw new Error('印刷会社入力の読み戻し不一致: ' + p.printId);
    changes.push({ printId: p.printId, sheet: t.sheet.getName(), status: actual[1], review: actual[25], printerInputPreserved: true });
  });
  _PrintChecklist_refreshReviewSummary(ss);
  return { updated: changes.length, changes: changes, pending: PrintChecklist_pendingReviewCount(caseId) };
}

// 読み取り専用の read-back verify。安定ID化(2026-09-22)が実データで効いたかを小さな JSON で返す。
// 旧形式ID(-IL/-CP/-KR)の残存数と、正規化品名の重複数が 0 であることを外から assert できる。
// 保護の状態と AB列（印刷会社）の穴を、ヘッドレスから読める目印ファイルに残す。
// 目印は CMD フォルダへ作り、内容を description にも入れる（result_ は drive.file では読めないため）。
// 2026-10-18: 生成し直しで一時的に消えていたものを復旧し、AB列の空欄集計を追加した。
function _admin_printChecklistProtectMarker() {
  const id = PropertiesService.getScriptProperties().getProperty(PRINT_CHECKLIST_SS_ID_KEY) || '';
  const out = { at: new Date().toISOString(), ssId: id, headerRow: PRINT_CHECKLIST_HEADER_ROW, sheets: {} };
  if (!id) out.error = 'PRINT_CHECKLIST_SS_ID 未設定';
  let ss = null;
  try { if (id) ss = SpreadsheetApp.openById(id); } catch (e) { out.error = String(e && e.message ? e.message : e); }
  [PRINT_CHECKLIST_MAIN_SHEET, PRINT_CHECKLIST_PRINTER_SHEET].forEach(function (sheetName) {
    const info = { name: sheetName };
    out.sheets[sheetName] = info;
    if (!ss) { info.error = 'spreadsheet 未取得'; return; }
    const sh = ss.getSheetByName(sheetName);
    if (!sh) { info.found = false; info.verdict = 'NG'; return; }
    info.found = true;
    info.sheetId = sh.getSheetId();
    info.lastRow = sh.getLastRow();
    info.maxRows = sh.getMaxRows();
    let prot = [];
    try {
      prot = sh.getProtections(SpreadsheetApp.ProtectionType.RANGE).map(function (p) {
        const r = p.getRange();
        return {
          desc: p.getDescription() || '',
          row: r.getRow(), col: r.getColumn(), numRows: r.getNumRows(), numCols: r.getNumColumns(),
          warningOnly: p.warningOnly
        };
      });
    } catch (e) { info.protectError = String(e && e.message ? e.message : e); }
    info.protectionCount = prot.length;
    info.descriptions = prot.map(function (p) { return p.desc + (p.warningOnly ? '(warn)' : ''); });
    info.colSpans = prot.map(function (p) { return p.col + '-' + (p.col + p.numCols - 1); });
    info.protectionsCoveringB = prot.filter(function (p) {
      return p.col <= 2 && (p.col + p.numCols - 1) >= 2 && (p.row + p.numRows - 1) >= 3;
    });
    try {
      const last = sh.getLastRow();
      const n = Math.max(1, last - PRINT_CHECKLIST_HEADER_ROW);
      const dv = sh.getRange(PRINT_CHECKLIST_HEADER_ROW + 1, 2, n, 1).getDataValidations();
      let withRule = 0, sample = null, values = null;
      for (let i = 0; i < dv.length; i++) {
        const r0 = dv[i] && dv[i][0];
        if (!r0) continue;
        withRule++;
        if (!sample) {
          sample = r0.getCriteriaType() + ':' + JSON.stringify(r0.getCriteriaValues());
          try {
            const cv = r0.getCriteriaValues()[0];
            if (cv && cv.map) values = cv.map(function (v) { return String(v); });
          } catch (e) { /* 値を取り出せない形は sample だけで判定できる */ }
        }
      }
      info.bDataRows = n;
      info.bRuleRows = withRule;
      info.bCriteria = sample;
      info.bValidationValues = values;
    } catch (e) { info.dvError = String(e && e.message ? e.message : e); }
    info.verdict = (info.protectionsCoveringB.length === 0 && info.bRuleRows > 0) ? 'OK' : 'NG';
  });
  out.verdict = Object.keys(out.sheets).every(function (k) { return out.sheets[k].verdict === 'OK'; }) ? 'OK' : 'NG';
  // 印刷会社マスタと AB列（印刷会社）の空欄。合成紙=看板宝屋 / LED UP=プロテック の自動割当が効いたかを見る。
  try {
    if (ss) {
      const master = _PrintChecklist_readPrinterMaster(ss);
      out.printerMaster = master.map(function (p) {
        return { name: p.name, default: !!p.isDefault, emails: p.emails.length, ssId: !!p.ssId };
      });
      const main = ss.getSheetByName(PRINT_CHECKLIST_MAIN_SHEET);
      if (main) {
        const table = _PrintChecklist_readTable(main, '印刷ID');
        const rows = _PrintChecklist_tableRows(table, PRINT_CHECKLIST_HEADERS).filter(function (r) { return r[0]; });
        const active = rows.filter(function (r) { return r[1] === '未入稿' || r[1] === '入稿済'; });
        const blank = active.filter(function (r) { return !String(r[27] || '').trim(); });
        const byPrinter = {}, byCase = {};
        active.forEach(function (r) {
          const key = String(r[27] || '').trim() || '(空欄)';
          byPrinter[key] = (byPrinter[key] || 0) + 1;
        });
        blank.forEach(function (r) {
          const k = String(r[2] || '');
          byCase[k] = (byCase[k] || 0) + 1;
        });
        const dateOf = function (v) { return v ? Utilities.formatDate(new Date(v), PRINT_CHECKLIST_TZ, 'MM/dd HH:mm') : ''; };
        const updated = rows.map(function (r) { return new Date(r[24]).getTime() || 0; });
        // 「隣接壁が掲載されない」検証用。壁面系の行がどの状態・印刷会社で載っているかを残す。
        const wallRows = rows.filter(function (r) {
          return /隣接壁|側壁|壁面/.test(String(r[9] || '') + ' ' + String(r[12] || ''));
        });
        out.abAudit = {
          activeRows: active.length,
          blankCount: blank.length,
          byPrinter: byPrinter,
          blankByCase: Object.keys(byCase).sort().slice(0, 15).map(function (k) { return k + ':' + byCase[k]; }),
          blankSamples: blank.slice(0, 8).map(function (r) { return String(r[2]) + '|' + String(r[9]).slice(0, 24) + '|' + String(r[27] || ''); }),
          wallRows: wallRows.slice(0, 10).map(function (r) {
            return String(r[2]) + '|' + String(r[9]).slice(0, 24) + '|' + String(r[1]) + '|' + (String(r[27] || '').trim() || '(空欄)');
          }),
          maxUpdated: dateOf(Math.max.apply(null, updated.concat([0])))
        };
      }
    }
  } catch (eAudit) { out.abAuditError = String(eAudit && eAudit.message ? eAudit.message : eAudit); }
  // 直近のビルドがどこまで進み、どこで失敗したかをヘッドレスから見えるようにする。
  try {
    const timing = JSON.parse(PropertiesService.getScriptProperties().getProperty('PRINT_CHECKLIST_LAST_TIMINGS') || 'null');
    if (timing) {
      out.lastBuild = {
        startedAt: timing.startedAt,
        elapsedMs: timing.elapsedMs,
        stages: (timing.timings || []).slice(-12).map(function (x) {
          return x.stage + (x.error ? '!ERR:' + String(x.error).slice(0, 80) : '');
        })
      };
    }
  } catch (eTiming) { out.lastBuildError = String(eTiming && eTiming.message ? eTiming.message : eTiming); }
  try {
    const folder = DriveApp.getFolderById(CMD_FOLDER_ID);
    const f = folder.createFile('pmark_' + out.verdict + '_' + new Date().toISOString().replace(/[:.]/g, '-') + '.txt',
      JSON.stringify(out), MimeType.PLAIN_TEXT);
    try { f.setDescription(JSON.stringify(out).slice(0, 8000)); } catch (e2) { /* description は best-effort */ }
    out.markerFileId = f.getId();
  } catch (e3) { out.markerError = String(e3 && e3.message ? e3.message : e3); }
  return out;
}

function _debug_printChecklistVerify(caseId) {
  const ss = _PrintChecklist_getOrCreateSpreadsheet();
  const col = function (header) { return PRINT_CHECKLIST_HEADERS.indexOf(header); };
  const out = { caseId: caseId || '(全件)', sheets: {}, legacyIds: 0, legacySamples: [], dupNames: [], excludedInMain: 0 };
  [PRINT_CHECKLIST_MAIN_SHEET, PRINT_CHECKLIST_PAST_SHEET, PRINT_CHECKLIST_EXCLUDED_SHEET].forEach(function (name) {
    const sheet = ss.getSheetByName(name);
    if (!sheet || sheet.getLastRow() < 2) { out.sheets[name] = 0; return; }
    const values = _PrintChecklist_tableRows(_PrintChecklist_readTable(sheet, '印刷ID'), PRINT_CHECKLIST_HEADERS)
      .filter(function (r) { return r[col('印刷ID')] && (!caseId || String(r[col('案件ID')]) === String(caseId)); });
    out.sheets[name] = values.length;
    const seen = {};
    values.forEach(function (r) {
      const id = String(r[col('印刷ID')]);
      if (/-(IL\d+c\d+|CP\d+|KR\d+)$/.test(id)) {
        out.legacyIds++;
        if (out.legacySamples.length < 5) out.legacySamples.push(id);
      }
      if (name === PRINT_CHECKLIST_MAIN_SHEET && String(r[col('状態')]) === '対象外') out.excludedInMain++;
      const updated = new Date(r[col('最終更新')]).getTime();
      if (updated && (!out._maxUpdated || updated > out._maxUpdated)) out._maxUpdated = updated;
      const key = String(r[col('案件ID')]) + '|' + _PrintChecklist_normalize(r[col('品名')]);
      if (seen[key]) { if (out.dupNames.length < 10) out.dupNames.push({ sheet: name, name: String(r[col('品名')]), ids: [seen[key], id] }); }
      else seen[key] = id;
    });
  });
  out.exclusionRules = _PrintChecklist_readExclusionRules(ss).length;
  // 強制保護(2026-09-22)の後も書き込みが通っているかを外から見るための指標。
  // 保護レンジへの setValues が silent ignore されると、ここが更新されず古い時刻で止まる。
  out.maxUpdated = out._maxUpdated ? Utilities.formatDate(new Date(out._maxUpdated), PRINT_CHECKLIST_TZ, 'yyyy/MM/dd HH:mm:ss') : '';
  delete out._maxUpdated;
  return out;
}

// 復元元はDriveに保存した検証済みスナップショット。現行表の全値は変更前に退避する。
function _PrintChecklist_restoreSnapshot(ss) {
  return [PRINT_CHECKLIST_MAIN_SHEET, PRINT_CHECKLIST_PAST_SHEET, PRINT_CHECKLIST_EXCLUDED_SHEET, PRINT_CHECKLIST_EXCLUSION_RULE_SHEET].map(function (name) {
    const sheet = ss.getSheetByName(name);
    if (!sheet) throw new Error('復元対象タブがありません: ' + name);
    return { name: name, values: sheet.getDataRange().getValues() };
  });
}

function _PrintChecklist_restoreTable(tab, firstHeader) {
  const header = String((tab.values[0] || [])[0]) === firstHeader ? 0 : 1;
  if (String((tab.values[header] || [])[0]) !== firstHeader) throw new Error('復元対象の見出し不一致: ' + tab.name);
  return { headers: tab.values[header], rows: tab.values.slice(header + 1), firstDataRow: header + 2 };
}

function _PrintChecklist_restorePlan(snapshot, source) {
  if (!source || source.version !== 1 || !Array.isArray(source.rows) || !Array.isArray(source.rules) ||
      !/^\d{4}\/\d{2}\/\d{2}$/.test(source.sourceDay)) throw new Error('復元元の形式が不正です');
  const blank = function (v) { return v === '' || v == null; };
  const value = function (v) { return v == null ? '' : v; };
  const newerRestore = function (r) {
    const matches = String(r[16] || '').match(/\[復活 \d{4}\/\d{2}\/\d{2}\]/g) || [];
    return r[25] === '復活' || matches.some(function (m) { return m.slice(4, 14) > source.sourceDay; });
  };
  const targets = Object.create(null), all = [];
  snapshot.filter(function (t) { return t.name !== PRINT_CHECKLIST_EXCLUSION_RULE_SHEET; }).forEach(function (tab) {
    const table = _PrintChecklist_restoreTable(tab, '印刷ID');
    _PrintChecklist_tableRows(table, PRINT_CHECKLIST_HEADERS).forEach(function (r, i) {
      if (!r[0]) return;
      const target = { sheet: tab.name, row: i + table.firstDataRow, values: r, headers: table.headers };
      (targets[String(r[0])] || (targets[String(r[0])] = [])).push(target); all.push(target);
    });
  });
  const changes = [], skipped = [], missing = [], seen = Object.create(null);
  source.rows.forEach(function (old) {
    if (!old.printId || old.B !== '対象外' || !old.caseId || !Array.isArray(old.printerInputs) || old.printerInputs.length !== 6) throw new Error('対象外の復元元行が不正です');
    if (seen[old.printId]) throw new Error('復元元の印刷IDが重複しています');
    seen[old.printId] = true;
    const found = targets[old.printId] || [];
    if (!found.length) { missing.push(old.printId); return; }
    // 同一IDの一方に復活の記録があれば、過去案件側も含めて取り消さない。
    if (found.some(function (t) { return newerRestore(t.values); })) { skipped.push(old.printId); return; }
    found.forEach(function (t) {
      if (String(t.values[2]) !== String(old.caseId)) throw new Error('案件ID不一致: ' + old.printId);
      const patch = function (col, next) {
        const before = value(t.values[col]); next = value(next);
        if (JSON.stringify(before) === JSON.stringify(next)) return;
        const physical = t.headers.indexOf(PRINT_CHECKLIST_HEADERS[col]);
        if (physical < 0) throw new Error('復元先の列がありません');
        changes.push({ printId: old.printId, caseId: old.caseId, itemName: t.values[9], sheet: t.sheet, row: t.row,
          column: String.fromCharCode(65 + col), columnNumber: physical + 1, before: before, after: next });
      };
      patch(1, '対象外');
      if (old.Z === '対象外' || old.Z === '復活') patch(25, old.Z);
      old.printerInputs.forEach(function (v, i) { if (blank(t.values[17 + i]) && !blank(v)) patch(17 + i, v); });
    });
  });
  const rulesTab = snapshot.find(function (t) { return t.name === PRINT_CHECKLIST_EXCLUSION_RULE_SHEET; });
  const currentRules = _PrintChecklist_tableRows(_PrintChecklist_restoreTable(rulesTab, 'ルールID'), PRINT_CHECKLIST_EXCLUSION_RULE_HEADERS).filter(function (r) { return r[0]; });
  const protectedRows = all.filter(function (t) { return newerRestore(t.values); });
  const skippedRules = [];
  const recoveredRules = source.rules.filter(function (r) {
    if (!Array.isArray(r) || r.length !== 6 || !r[0] || !r[3] || ['この案件のみ', '全案件'].indexOf(r[1]) < 0) throw new Error('復元元ルールが不正です');
    if (protectedRows.some(function (t) { return _PrintChecklist_matchesExclusionRule(t.values, [r]); })) {
      skippedRules.push(r[0]); return false;
    }
    return true;
  });
  const rules = _PrintChecklist_dedupeExclusionRules(currentRules.concat(recoveredRules));
  rules.sort(function (a, b) { return String(a[0]).localeCompare(String(b[0])); });
  const sortedCurrent = currentRules.slice().sort(function (a, b) { return String(a[0]).localeCompare(String(b[0])); });
  const rulesChanged = JSON.stringify(sortedCurrent) !== JSON.stringify(rules);
  return { sourceDay: source.sourceDay, sourceDescription: source.description, changes: changes, skipped: skipped, missing: missing,
    skippedRules: skippedRules, rules: rules, rulesChanged: rulesChanged,
    counts: { sourceRows: source.rows.length, updatedRows: _PrintChecklist_unique(changes.map(function (c) { return c.sheet + ':' + c.row; })).length,
      updatedCells: changes.length, skippedRows: skipped.length, missingRows: missing.length,
      sourceRules: source.rules.length, currentRules: currentRules.length, nextRules: rules.length } };
}

function _PrintChecklist_restoreDigest(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify(value), Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}

function _admin_printChecklistRestoreExcluded(opts) {
  opts = opts || {};
  if (['dryRun', 'apply'].indexOf(opts.mode) < 0 || !opts.sourceFileId) throw new Error('mode/sourceFileIdが必要です');
  const lock = LockService.getScriptLock(), alreadyLocked = lock.hasLock();
  if (!alreadyLocked && !lock.tryLock(1000)) throw new Error('印刷物の更新中です。復元は未実行です');
  try {
    const id = PropertiesService.getScriptProperties().getProperty(PRINT_CHECKLIST_SS_ID_KEY);
    const source = JSON.parse(DriveApp.getFileById(opts.sourceFileId).getBlob().getDataAsString());
    if (!id || source.ssId !== id) throw new Error('復元先ファイルID不一致');
    const ss = SpreadsheetApp.openById(id), snapshot = _PrintChecklist_restoreSnapshot(ss);
    const plan = _PrintChecklist_restorePlan(snapshot, source);
    // planに含まれない備考・入力の変更も検出する。再実行時は新しいdry-runを要求する。
    const digest = _PrintChecklist_restoreDigest({ source: source, snapshot: snapshot, plan: plan });
    if (opts.mode === 'apply' && opts.expectedDigest !== digest) throw new Error('dry-run以降にデータが変わりました。復元は未実行です');
    const backup = DriveApp.getFolderById(CMD_FOLDER_ID).createFile('print_excluded_backup_' + Utilities.getUuid() + '.json',
      JSON.stringify({ ssId: id, savedAt: new Date().toISOString(), digest: digest, tabs: snapshot }), MimeType.PLAIN_TEXT);
    if (opts.mode === 'dryRun') return { dryRun: true, digest: digest, backupFileId: backup.getId(), plan: plan };
    plan.changes.forEach(function (c) { ss.getSheetByName(c.sheet).getRange(c.row, c.columnNumber).setValue(c.after); });
    if (plan.rulesChanged) _PrintChecklist_writeExclusionRules(ss, plan.rules);
    SpreadsheetApp.flush();
    const actual = _PrintChecklist_restoreSnapshot(ss);
    // 指定セル以外の入力を含め、全リストの全値を読み戻す。
    snapshot.filter(function (t) { return t.name !== PRINT_CHECKLIST_EXCLUSION_RULE_SHEET; }).forEach(function (tab) {
      const expected = tab.values.map(function (r) { return r.slice(); });
      plan.changes.filter(function (c) { return c.sheet === tab.name; }).forEach(function (c) { expected[c.row - 1][c.columnNumber - 1] = c.after; });
      if (JSON.stringify(expected) !== JSON.stringify(actual.find(function (t) { return t.name === tab.name; }).values)) {
        throw new Error('復元の読み戻し不一致（退避ID ' + backup.getId() + '）: ' + tab.name);
      }
    });
    const actualRules = _PrintChecklist_readExclusionRules(ss).sort(function (a, b) { return String(a[0]).localeCompare(String(b[0])); });
    if (JSON.stringify(actualRules) !== JSON.stringify(plan.rules)) throw new Error('復元ルールの読み戻し不一致（退避ID ' + backup.getId() + '）');
    _PrintChecklist_invalidateReviewCache(new Date());
    return { applied: true, verified: true, digest: digest, backupFileId: backup.getId(), counts: plan.counts };
  } finally { if (!alreadyLocked) lock.releaseLock(); }
}
