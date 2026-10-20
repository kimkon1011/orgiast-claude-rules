/** 案件の確定情報。テンプレートと同じSSの1シートだけに保存する。 */
var CHECKLIST_CASE_CONFIG_SHEET = 'Checklist_CaseConfig';
var CHECKLIST_CASE_CONFIG_HEADERS = ['caseId', 'vehicles', 'parkingName', 'parkingNote', 'parkingUrl',
  'directorName', 'directorTel', 'supervisorName', 'supervisorTel', 'meetingPoint', 'notes', 'qrImageUrl', 'updatedAt', 'updatedBy'];
var _Checklist_caseConfigQueue = false;

function _Checklist_caseConfigObject(row) {
  var cfg = {};
  CHECKLIST_CASE_CONFIG_HEADERS.forEach(function (key, i) {
    var value = row && row[i];
    cfg[key] = value instanceof Date ? value.toISOString() : String(value == null ? '' : value);
  });
  cfg.vehicles = cfg.vehicles ? JSON.parse(cfg.vehicles) : [];
  if (!Array.isArray(cfg.vehicles)) throw new Error('vehicles は配列で指定してください');
  return cfg;
}

/** 管理画面がcontext/configを並行取得する初回も、同名シート作成の競合を回復。 */
function _Checklist_caseConfigSheet_() {
  try { return _Checklist_sheet(CHECKLIST_CASE_CONFIG_SHEET, CHECKLIST_CASE_CONFIG_HEADERS); }
  catch (e) {
    if (!SpreadsheetApp.getActive().getSheetByName(CHECKLIST_CASE_CONFIG_SHEET)) throw e;
    return _Checklist_sheet(CHECKLIST_CASE_CONFIG_SHEET, CHECKLIST_CASE_CONFIG_HEADERS);
  }
}

function Checklist_getCaseConfig(caseId) {
  var sh = _Checklist_caseConfigSheet_();
  var rows = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, CHECKLIST_CASE_CONFIG_HEADERS.length).getValues() : [];
  var row = rows.filter(function (r) { return String(r[0]) === String(caseId || ''); })[0];
  return _Checklist_caseConfigObject(row);
}

function _Checklist_saveCaseConfig_(caseId, cfg) {
  var id = String(caseId || '').trim();
  if (!id || !CaseList_getById(id)) throw new Error('案件が見つかりません');
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('cfg を指定してください');
  var vehicles = cfg.vehicles == null || cfg.vehicles === '' ? [] : cfg.vehicles;
  if (typeof vehicles === 'string') vehicles = JSON.parse(vehicles);
  if (!Array.isArray(vehicles) || vehicles.some(function (v) { return typeof v !== 'string'; })) throw new Error('vehicles は文字列の配列で指定してください');
  vehicles = vehicles.map(Checklist_normalizeVehicleName).filter(function (v, i, all) { return v && all.indexOf(v) === i; });
  var lock = _Checklist_caseConfigQueue ? null : LockService.getScriptLock();
  if (lock) lock.waitLock(10000);
  try {
    var sh = _Checklist_caseConfigSheet_();
    var rows = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, CHECKLIST_CASE_CONFIG_HEADERS.length).getValues() : [];
    var index = rows.findIndex(function (r) { return String(r[0]) === id; });
    var previous = _Checklist_caseConfigObject(index < 0 ? null : rows[index]);
    if (!Object.prototype.hasOwnProperty.call(cfg, 'vehicles')) vehicles = previous.vehicles;
    var saved = { caseId: id, vehicles: JSON.stringify(vehicles), updatedAt: new Date().toISOString(),
      updatedBy: _Checklist_caseConfigActor() };
    CHECKLIST_CASE_CONFIG_HEADERS.slice(2, -2).forEach(function (key) { saved[key] = Object.prototype.hasOwnProperty.call(cfg, key) ? String(cfg[key] == null ? '' : cfg[key]).trim() : previous[key]; });
    var row = CHECKLIST_CASE_CONFIG_HEADERS.map(function (key) { return saved[key]; });
    // 文字列列をtext形式にし、TELの先頭0と自由入力の先頭「=」を保持する。
    var range = sh.getRange(index < 0 ? sh.getLastRow() + 1 : index + 2, 1, 1, row.length);
    range.setNumberFormat('@');
    range.setValues([row.map(function (value) { return /^=/.test(value) ? "'" + value : value; })]);
    SpreadsheetApp.flush();
    var actual = range.getValues()[0];
    var verified = row.every(function (value, i) { return String(actual[i] == null ? '' : actual[i]) === value; });
    var cache = CacheService.getScriptCache();
    cache.remove('checklist:ctx:' + id);
    cache.remove('cklinks_' + id);
    if (!verified) throw new Error('保存後の読み戻しが一致しません。案件設定を再読み込みしてください');
    return { ok: true, config: _Checklist_caseConfigObject(actual) };
  } finally { if (lock) lock.releaseLock(); }
}

function Checklist_adminSetCaseConfig(token, caseId, cfg) {
  return _Checklist_result(function () {
    if (!_Checklist_authorized(token)) return { ok: false, error: 'unauthorized' };
    return _Checklist_saveCaseConfig_(caseId, cfg);
  });
}

/** whitelist の専用ラッパだけが有効化する。匿名 google.script.run からの保存を拒否。 */
function Checklist_setCaseConfigByQueue(caseId, cfg) {
  return _Checklist_result(function () {
    if (!_Checklist_caseConfigQueue) return { ok: false, error: 'command queue only' };
    return _Checklist_saveCaseConfig_(caseId, cfg);
  });
}

/** 調査結果はJSONとして20KB以内。値から順に削り、切り詰めを明示する。 */
/** 保存者。userinfo.email スコープが無い実行経路（コマンドキュー）では例外になるので 'queue' に落とす。 */
function _Checklist_caseConfigActor() {
  try { return Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail() || 'queue'; } catch (e) { return 'queue'; }
}

function _debug_checklistCaseSources(caseId, rows) {
  var c = CaseList_getById(String(caseId || ''));
  if (!c) return { ok: false, error: '案件が見つかりません' };
  var result = { caseId: String(caseId), sheetNames: [], sheets: [], master: [], warnings: [], truncated: false };
  if (c.zissiId) {
    try {
      SpreadsheetApp.openById(c.zissiId).getSheets().forEach(function (sh) {
        var name = sh.getName();
        result.sheetNames.push(name);
        if (/スタッフ|担当|体制|搬入|車両|駐車/.test(name)) {
          var h = Math.min(Math.max(5, Number(rows) || 5), sh.getLastRow()), w = Math.min(15, sh.getLastColumn());
          result.sheets.push({ name: name, values: h && w ? sh.getRange(1, 1, h, w).getDisplayValues() : [] });
        }
      });
    } catch (e) { result.warnings.push('実施計画書: ' + e.message); }
  }
  if (c.masterSsId && c.masterCol) {
    try {
      var task = SpreadsheetApp.openById(c.masterSsId).getSheetByName('task');
      var width = Math.min(3, task.getLastColumn() - Number(c.masterCol) + 1);
      if (width > 0) result.master = task.getRange(1, Number(c.masterCol), 10, width).getDisplayValues();
    } catch (e) { result.warnings.push('master: ' + e.message); }
  }
  while (Utilities.newBlob(JSON.stringify(result)).getBytes().length > 20 * 1024) {
    result.truncated = true;
    var cells = [];
    result.sheets.forEach(function (s) { s.values.forEach(function (r) { cells.push(r); }); });
    result.master.forEach(function (r) { cells.push(r); });
    var longest = null, at = -1;
    cells.forEach(function (r) { r.forEach(function (v, i) { if (String(v).length > (longest ? String(longest[at]).length : 0)) { longest = r; at = i; } }); });
    if (longest && String(longest[at]).length > 16) longest[at] = String(longest[at]).slice(0, Math.floor(String(longest[at]).length / 2)) + '…';
    else if (result.sheets.length) result.sheets.pop();
    else if (result.sheetNames.length) result.sheetNames.pop();
    else if (result.warnings.length) result.warnings.pop();
    else { result.master = []; result.caseId = result.caseId.slice(0, 100); }
  }
  return result;
}
