/**
 * 過去の実行パネルに残った「Claude生成物 シート参照」を、成果物へのリンクに置き換える。
 * dryRun が既定。対象文言と成果物が一意に特定できたセルだけを書き換える。
 */

var _PANEL_BACKFILL_LEGACY_TEXT = [
  '完了 (リンクは Claude生成物 シート参照)',
  '完了（このコマンドは成果物リンクを返しません）'
];

var _PANEL_BACKFILL_ARTIFACT_TYPES = {
  Phase_MailResponse_generate: 'メール返信対応',
  Phase_MeetingAgenda_generate: '次回MTGアジェンダ',
  Phase1_Schedule_generate: 'スケジュール',
  Phase1_EstimateOnly_generate: '見積',
  Phase1_Estimate_generate: '見積',
  Phase6_FinalEstimate_generate: '最終見積',
  Phase2_ItemList_generate: 'アイテムリスト',
  Phase2_LayoutPlan_generate: 'レイアウトシート',
  Phase2_Submission_generate: '提出書類チェックリスト',
  Phase3_NyukoCheck_generate: '入稿データチェック',
  Phase_ProcurementRequest_generate: '手配物リスト',
  Phase1_DesignerBrief_generate: 'デザイナー依頼文',
  Phase_AssignRequest_generate: 'アサイン依頼',
  Phase6_PostReport_generate: '報告書',
  Phase6_ImprovementBrief_generate: '改善指示書',
  Phase6_StaffEval_generate: 'スタッフ評価'
};

function PanelBackfill_isTarget(value, opts) {
  if (opts && String(opts.formula || '').trim() !== '') return false;
  if (_PANEL_BACKFILL_LEGACY_TEXT.indexOf(value) >= 0) return true;
  // 'undefined' は _admin_repairPanelLinks の初版がラベルを取り違えて書いた壊れた値
  // (2026-09-03)。人が書くことはない文字列なので、backfill の復旧対象に含める。
  if (String(value || '').trim() === 'undefined') return true;
  return !!(opts && opts.includeEmpty && String(value || '').trim() === '');
}

function PanelBackfill_defaultConfigs() {
  return {
    OPS_PLAN_CONFIG: typeof _OPS_PLAN_CONFIG === 'undefined' ? undefined : _OPS_PLAN_CONFIG,
    // 打診文の config は Phase2_AssignBrief.js の _PARTY_CONFIG (construction/ops/driver)
    ASSIGN_BRIEF_CONFIG: typeof _PARTY_CONFIG === 'undefined' ? undefined : _PARTY_CONFIG,
    DAY_BRIEF_CONFIG: typeof _DAY_BRIEF_CONFIG === 'undefined' ? undefined : _DAY_BRIEF_CONFIG,
    CONSTRUCTION_PLAN_CONFIG: typeof _CONSTRUCTION_PLAN_CONFIG === 'undefined' ? undefined : _CONSTRUCTION_PLAN_CONFIG
  };
}

function PanelBackfill_artifactTypeForCommand(command, args, configs) {
  var artifactType = _PANEL_BACKFILL_ARTIFACT_TYPES[String(command || '')];
  if (artifactType) return { ok: true, artifactType: artifactType };

  configs = configs || PanelBackfill_defaultConfigs();
  args = Array.isArray(args) ? args : [];
  var cfg;
  if (command === 'Phase2_SetupTeardownPlan_generate') {
    cfg = configs.OPS_PLAN_CONFIG && configs.OPS_PLAN_CONFIG.setup_teardown;
  } else if (command === 'Phase2_LogisticsPlan_generate') {
    cfg = configs.OPS_PLAN_CONFIG && configs.OPS_PLAN_CONFIG.logistics;
  } else if (command === 'Phase2_AssignBrief_generate') {
    cfg = configs.ASSIGN_BRIEF_CONFIG && configs.ASSIGN_BRIEF_CONFIG[args[0]];
    if (cfg && cfg.displayName) artifactType = cfg.displayName + '打診文';
  } else if (command === 'Phase4_DayBrief_generate') {
    cfg = configs.DAY_BRIEF_CONFIG && configs.DAY_BRIEF_CONFIG[args[0]];
    if (cfg && cfg.displayName) artifactType = cfg.displayName + '当日案内';
  } else if (command === 'Phase2_ConstructionPlan_generate') {
    cfg = configs.CONSTRUCTION_PLAN_CONFIG;
  }
  if (!artifactType && cfg && cfg.displayName) artifactType = cfg.displayName;
  if (!artifactType) return { ok: false, reason: 'unsupported_command' };
  return { ok: true, artifactType: artifactType };
}

/** rows は Claude生成物シートのデータ行 (A:I)。同一キーが複数なら末尾を最新として使う。 */
function PanelBackfill_findArtifact(rows, caseId, artifactType) {
  var matchedWithoutUrl = false;
  for (var i = (rows || []).length - 1; i >= 0; i--) {
    var row = rows[i] || [];
    if (String(row[0] || '') !== String(caseId || '') ||
        String(row[3] || '') !== String(artifactType || '')) continue;
    if (String(row[5] || '')) return { ok: true, url: String(row[5]) };
    matchedWithoutUrl = true;
  }
  return { ok: false, reason: matchedWithoutUrl ? 'artifact_url_empty' : 'artifact_not_found' };
}

function PanelBackfill_plan(value, command, caseId, artifactRows, opts) {
  if (!PanelBackfill_isTarget(value, opts)) return { ok: false, reason: 'not_target' };
  // GAS API は呼び出し側で注入。空セルは既存の成果物記録で実行済みと判定する。
  var zissiLinks = [];
  if (opts && typeof opts.resolveZissiLinks === 'function') {
    try { zissiLinks = opts.resolveZissiLinks(caseId, command) || []; } catch (e) {}
  }
  function zissiPlan() {
    var links = zissiLinks.slice(0, typeof PANEL_LINK_MAX === 'undefined' ? 4 : PANEL_LINK_MAX);
    return {
      ok: true,
      source: _PANEL_BACKFILL_LEGACY_TEXT.indexOf(value) >= 0 ? 'legacy_text' : 'empty',
      artifactType: '', label: links[0].label, url: links[0].url, links: links
    };
  }
  if (_PANEL_BACKFILL_LEGACY_TEXT.indexOf(value) >= 0 && zissiLinks.length) return zissiPlan();
  var mapped = PanelBackfill_artifactTypeForCommand(command, opts && opts.args, opts && opts.configs);
  if (!mapped.ok) {
    if (_PANEL_BACKFILL_LEGACY_TEXT.indexOf(value) >= 0 &&
        typeof MasterWriteBack_artifactSheetUrl === 'function') {
      var artifactSheetUrl = String(MasterWriteBack_artifactSheetUrl(caseId) || '');
      if (artifactSheetUrl) {
        var fallbackLabel = '📄 Claude生成物シートを開く';
        return {
          ok: true,
          source: 'legacy_text',
          artifactType: '',
          label: fallbackLabel,
          url: artifactSheetUrl,
          links: [{ label: fallbackLabel, url: artifactSheetUrl }]
        };
      }
    }
    return mapped;
  }
  var artifact = PanelBackfill_findArtifact(artifactRows, caseId, mapped.artifactType);
  var slide = PanelBackfill_findArtifact(artifactRows, caseId, mapped.artifactType + '(スライド版)');
  if (!slide.ok) slide = PanelBackfill_findArtifact(artifactRows, caseId, mapped.artifactType + '（スライド版）');
  if (!artifact.ok && !slide.ok) {
    var reason = artifact.reason === 'artifact_url_empty' || slide.reason === 'artifact_url_empty' ?
      'artifact_url_empty' : 'artifact_not_found';
    return { ok: false, reason: reason, artifactType: mapped.artifactType };
  }
  // 空セルの復旧では成果物 Doc/Slides を先に出し、実施計画書シートは補助として後ろに足す
  // (Doc を作るコマンドで zissi シートだけ貼ると、本体の成果物が見えなくなる)。
  var links = [];
  if (artifact.ok) links.push({ label: '📄 ' + mapped.artifactType, url: artifact.url });
  if (slide.ok) links.push({ label: '🖼 スライド', url: slide.url });
  zissiLinks.forEach(function (link) {
    var max = typeof PANEL_LINK_MAX === 'undefined' ? 4 : PANEL_LINK_MAX;
    if (links.length < max) links.push(link);
  });
  return {
    ok: true,
    source: _PANEL_BACKFILL_LEGACY_TEXT.indexOf(value) >= 0 ? 'legacy_text' : 'empty',
    artifactType: mapped.artifactType,
    label: links[0].label,
    url: links[0].url,
    links: links
  };
}

function Panel_backfillResultLinks(opts) {
  opts = opts || {};
  var dryRun = opts.dryRun !== false;
  var includeEmpty = opts.includeEmpty === true;
  var onlyCaseId = String(opts.caseId || '');
  var ms = SpreadsheetApp.openById(_PANEL_MASTER_SS);
  var artifactSheet = ms.getSheetByName(_MASTER_ARTIFACT_SHEET);
  var artifactRows = [];
  if (artifactSheet && artifactSheet.getLastRow() >= 2) {
    artifactRows = artifactSheet.getRange(2, 1, artifactSheet.getLastRow() - 1, _MASTER_ARTIFACT_HEADERS.length).getValues();
  }

  var resolution = _JobQueue_loadResolution(ms);
  // resolveCase は masterCol の補正を書き込むことがある。backfill の dry-run/更新範囲に含めない。
  var readOnlyResolution = {};
  Object.keys(resolution).forEach(function (key) { readOnlyResolution[key] = resolution[key]; });
  readOnlyResolution.appSheet = null;

  var result = {
    ok: true,
    dryRun: dryRun,
    caseId: onlyCaseId,
    scannedPanels: 0,
    matchedPanels: 0,
    scannedRows: 0,
    targetRows: 0,
    planned: 0,
    plannedBySource: { legacy_text: 0, empty: 0 },
    written: 0,
    skipped: [],
    changes: []
  };

  // 1枚だけ処理したい呼び出し (パネル再構築の直後) で全シートを舐めない。
  // 舐めると再構築1回あたり全パネル分の read が走り、毎分トリガが6分制限で落ちる。
  var onlySheetName = String(opts.sheetName || '');
  ms.getSheets().forEach(function (panel) {
    if (onlySheetName && panel.getName() !== onlySheetName) return;
    var marker;
    try { marker = String(panel.getRange('G1').getValue()); } catch (e) { return; }
    if (!_Panel_isMarker(marker)) return;
    result.scannedPanels++;

    var eventLabel = String(panel.getRange('G2').getValue() || '');
    var resolved = _JobQueue_resolveCase(eventLabel, readOnlyResolution);
    var caseId = String(resolved.caseId || '');
    if (onlyCaseId && caseId !== onlyCaseId) return;
    if (!caseId) {
      result.skipped.push({ sheet: panel.getName(), reason: 'case_not_resolved' });
      return;
    }
    result.matchedPanels++;

    var lastRow = panel.getLastRow();
    if (lastRow < 6) return;
    var isV3 = marker === _PANEL_MARKER_V3;
    var resultCol = isV3 ? 5 : 4;
    var rowRange = panel.getRange(6, resultCol, lastRow - 5, 5);
    var rows = rowRange.getValues();
    var formulas = rowRange.getFormulas();
    result.scannedRows += rows.length;
    rows.forEach(function (row, index) {
      var rowNumber = index + 6;
      var command = String(row[isV3 ? 2 : 3] || '');
      var args;
      try { args = JSON.parse(String(row[isV3 ? 3 : 4] || '[]')); } catch (e) { args = []; }
      if (!Array.isArray(args)) args = [];
      var formula = String((formulas[index] || [])[0] || '');
      if (formula.trim() !== '') {
        if (_PANEL_BACKFILL_LEGACY_TEXT.indexOf(row[0]) >= 0 || (includeEmpty && String(row[0] || '').trim() === '')) {
          result.skipped.push({ sheet: panel.getName(), row: rowNumber, caseId: caseId, command: command, reason: 'has_formula' });
        }
        return;
      }
      if (!PanelBackfill_isTarget(row[0], { includeEmpty: includeEmpty, formula: formula })) return;
      result.targetRows++;
      var plan = PanelBackfill_plan(row[0], command, caseId, artifactRows, { includeEmpty: includeEmpty, args: args, resolveZissiLinks: PanelLinks_zissiOutputLinks });
      if (!plan.ok) {
        result.skipped.push({ sheet: panel.getName(), row: rowNumber, caseId: caseId, command: command, reason: plan.reason, artifactType: plan.artifactType || '' });
        return;
      }
      // links も残す。スライド版が併存する行は2本貼るので、dry-run で本数まで読めないと検証にならない
      var change = { sheet: panel.getName(), row: rowNumber, caseId: caseId, command: command, artifactType: plan.artifactType, label: plan.label, url: plan.url, links: plan.links, source: plan.source };
      result.planned++;
      result.plannedBySource[plan.source]++;
      result.changes.push(change);
      if (!dryRun) {
        PanelLinks_write(panel.getRange(rowNumber, resultCol), '', plan.links);
        if (isV3) {
          var featureKey = String(panel.getRange(rowNumber, 10).getValue() || '');
          if (featureKey && featureKey.indexOf('__PHASE__:') !== 0) {
            PanelProgress_upsert(caseId, eventLabel, featureKey, true, 'auto', '');
            panel.getRange(rowNumber, 2).setValue(true);
          }
        }
        result.written++;
      }
    });
  });
  if (onlyCaseId && result.matchedPanels === 0) {
    result.skipped.push({ caseId: onlyCaseId, reason: 'requested_case_panel_not_found' });
  }
  result.skippedCount = result.skipped.length;
  result.skipReasons = {};
  result.skipped.forEach(function (item) {
    result.skipReasons[item.reason] = (result.skipReasons[item.reason] || 0) + 1;
  });
  return result;
}

function Panel_backfillResultLinksNightly() {
  try {
    var result = Panel_backfillResultLinks({ dryRun: false, includeEmpty: true });
    console.log('Panel_backfillResultLinksNightly success' +
      ' scannedPanels=' + result.scannedPanels +
      ' matchedPanels=' + result.matchedPanels +
      ' targetRows=' + result.targetRows +
      ' written=' + result.written +
      ' skippedCount=' + result.skippedCount);
    return result;
  } catch (e) {
    console.log('Panel_backfillResultLinksNightly failed error=' + String(e && e.message || e));
    throw e;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PanelBackfill_isTarget: PanelBackfill_isTarget,
    PanelBackfill_artifactTypeForCommand: PanelBackfill_artifactTypeForCommand,
    PanelBackfill_findArtifact: PanelBackfill_findArtifact,
    PanelBackfill_plan: PanelBackfill_plan,
    Panel_backfillResultLinksNightly: Panel_backfillResultLinksNightly
  };
}
