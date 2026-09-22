/**
 * 実行パネル「③ 結果」列に貼るリンクを、コマンドの戻り値から拾う。
 *
 * 以前は url = ret.docUrl || ret.slidesUrl || ret.url || ret.estimateSheetUrl の4キー限定で、
 * sheetUrl / proposalSheetUrl / scheduleSheetUrl / checkSheetUrl / itemListUrl 等で返す
 * コマンドが全部「完了 (リンクは Claude生成物 シート参照)」に落ちていた
 * (URL は取れているのに書いていなかった)。キーを列挙で足すのは同じ漏れを繰り返すので、
 * 末尾が Url のキーを総なめして拾う。ラベルは既知キーだけ人の言葉に置き換える。
 */
var PANEL_LINK_LABELS = {
  zissiSheetUrl: '📋 実施計画書(全体)',
  docUrl: '📄 議事録',
  sheetUrl: '📄 シート',
  proposalSheetUrl: '📑 提案書',
  slidesUrl: '🖼 スライド',
  estimateSheetUrl: '💰 見積書',
  scheduleSheetUrl: '📅 スケジュール',
  itemListUrl: '📦 アイテムリスト',
  checkSheetUrl: '✅ チェックリスト',
  approvalSheetUrl: '🖊 承認シート',
  purchaseSheetUrl: '🛒 購買依頼',
  promptSheetUrl: '🎨 画像プロンプト',
  azukariFolderUrl: '📂 預かり素材フォルダ',
  folderUrl: '📂 フォルダ',
  clientProposalUrl: '📑 提案書(顧客提出済)',
  assignSheetUrl: '📋 アサイン依頼シート',
  url: '📄 開く'
};

// ラベルの並び順 (既知キーはこの順、未知の *Url キーは後ろへ)。
var PANEL_LINK_ORDER = ['docUrl', 'sheetUrl', 'proposalSheetUrl', 'slidesUrl',
  'estimateSheetUrl', 'scheduleSheetUrl', 'itemListUrl', 'checkSheetUrl', 'approvalSheetUrl',
  'purchaseSheetUrl', 'promptSheetUrl', 'azukariFolderUrl', 'folderUrl', 'clientProposalUrl',
  'assignSheetUrl', 'url', 'zissiSheetUrl'];

var PANEL_LINK_MAX = 4;

// 実施計画書(zissi) 内の固定名シートへ書く登録コマンド。
// 通常の戻り値リンクを優先し、リンク欠落時と過去セルの復旧にだけ使う。
// 読み取り元・別ブック・実行時に名前が決まるシートは含めない。
var PANEL_ZISSI_OUTPUT_SHEETS = {
  'TaskLedger_runTask': ['Claude_タスク台帳'], // TaskLedger.js:307
  'TaskLedger_pollChecked': ['Claude_タスク台帳'], // TaskLedger.js:739
  'TaskLedger_syncAllNightly': ['Claude_タスク台帳'], // TaskLedger.js:24
  'TaskLedger_autoRunNightly': ['Claude_タスク台帳'], // TaskLedger.js:307
  '_admin_taskLedgerSetRow': ['Claude_タスク台帳'], // TaskLedger.js:739
  '_test_procurementApprovalSync': ['アイテムリスト', 'Claude_手配物承認'], // Phase_ProcurementRequest.js:1083, Phase_ProcurementRequest.js:977
  '_test_procurementSubmitRoundTrip': ['アイテムリスト', 'Claude_手配物承認'], // Phase_ProcurementRequest.js:863, Phase_ProcurementRequest.js:1031
  '_test_procurementQuickRoundTrip': ['アイテムリスト', 'Claude_手配物承認'], // Phase_ProcurementRequest.js:863, Phase_ProcurementRequest.js:1031
  'CaseDigest_nightlyRun': ['Claude_案件資料ダイジェスト'], // CaseDigest.js:216
  Phase2_LogisticsPlan_generate: ['搬入出計画'], // Phase2_OperationsPlan.js:364-371
  Phase2_Submission_generate: ['Claude_提出書類チェックリスト'], // Phase2_Submission.js:81-103
  Phase1_Schedule_generate: ['Claude_マイルストーン提案', 'スケジュール', 'summary', '企画'], // Phase1_Schedule.js:34-55,142-155,418-469
  Phase2_ItemList_generate: ['Claude_アイテムリスト提案'], // Phase2_ItemList.js:173
  Phase2_LayoutPlan_generate: ['Claude_レイアウト提案', 'Claude_レイアウト画像プロンプト'], // Phase2_LayoutPlan.js:120-167
  Phase_MailResponse_generate: ['Claude_メール対応'], // Phase_MailResponse.js:88-131
  Phase_MeetingAgenda_generate: ['Claude_次回MTGアジェンダ'], // Phase_MeetingAgenda.js:89-107
  Phase_ProofCheck_generate: ['Claude_資料チェック'], // Phase_ProofCheck.js:127-150
  Phase3_NyukoCheck_generate: ['Claude_入稿データチェック'], // Phase3_NyukoCheck.js:120-157
  Phase6_FinalEstimate_generate: ['Claude_最終見積'], // Phase6_FinalEstimate.js:100-136
  Phase6_StaffEval_generate: ['Claude_スタッフ評価'], // Phase6_StaffEval.js:95-122
  Phase6_PostReport_generate: ['Claude_報告書'], // Phase6_PostReport.js:123
  Phase6_ImprovementBrief_generate: ['Claude_改善指示書'], // Phase6_ImprovementBrief.js:149
  Phase5_Qna_ask: ['Claude_QAログ'], // Phase5_Qna.js:218
  Phase2_EstimateRevision_generate: ['Claude_修正履歴'], // Phase_RevisionBrief.js:175-194,228
  Phase2_DesignRevision_generate: ['Claude_修正履歴'], // Phase_RevisionBrief.js:175-194,231
  Phase4_FinalCheckRevision_generate: ['Claude_修正履歴'], // Phase_RevisionBrief.js:175-194,234
  Phase_CoverLetter_generate: ['Claude_送付文'], // Phase_CoverLetter.js:50-54
  Phase_CostProfit_generate: ['Claude_原価粗利', 'Claude_原価粗利_ファイル'], // Phase_CostProfit.js:28-35,152-183,506-538
  Phase_ProcurementRequest_generate: ['アイテムリスト', 'Claude_手配物承認'], // Phase_ProcurementRequest.js:139,293,837,1030
  Phase_ProcurementRequest_requestApproval: ['アイテムリスト', 'Claude_手配物承認'], // Phase_ProcurementRequest.js:321-356
  Phase_ProcurementRequest_openApproval: ['Claude_手配物承認', 'アイテムリスト'], // Phase_ProcurementRequest.js:364-373
  Phase_ProcurementRequest_submit: ['アイテムリスト', 'Claude_手配物承認'], // Phase_ProcurementRequest.js:377-505
  Phase_ProcurementRequest_quickSubmit: ['アイテムリスト', 'Claude_手配物承認'], // Phase_ProcurementRequest.js:526-590 → submit
  CaseDigest_buildForCase: ['Claude_案件資料ダイジェスト'], // CaseDigest.js:213-238
  TaskLedger_sync: ['Claude_タスク台帳'] // TaskLedger.js:23-25,212
};

/** GAS 側のリンク解決。実在するシートだけを案内し、取得失敗でパネルを止めない。 */
function PanelLinks_zissiOutputLinks(caseId, command) {
  try {
    if (!Object.prototype.hasOwnProperty.call(PANEL_ZISSI_OUTPUT_SHEETS, command)) return [];
    var names = PANEL_ZISSI_OUTPUT_SHEETS[command];
    var c = CaseList_getById(caseId);
    if (!c || !c.zissiId) return [];
    var ss = SpreadsheetApp.openById(c.zissiId);
    var links = [];
    names.forEach(function (name) {
      var sheet = ss.getSheetByName(name);
      if (sheet && links.length < PANEL_LINK_MAX) {
        links.push({ label: '📋 実施計画書「' + name + '」', url: PanelLinks_sheetUrl(ss, sheet) });
      }
    });
    return links;
  } catch (e) { return []; }
}

function _PanelLinks_label(key) {
  if (PANEL_LINK_LABELS[key]) return PANEL_LINK_LABELS[key];
  // xxxSheetUrl / xxxFolderUrl → 「📄 xxx」。未知キーでも空ラベルにしない。
  var base = String(key).replace(/(Sheet|Folder|Doc|File)?Url$/i, '');
  return '📄 ' + (base || 'リンク');
}

/**
 * シートを直接開く URL。フラグメントだけの '#gid=' では、同じスプレッドシートを
 * 既に開いているタブがあるときに目的のシートへ移動しない (2026-09-03 実害)。
 * Sheets 自身と同じ ?gid=N#gid=N 形式で組む。
 */
function _PanelLinks_composeSheetUrl(baseUrl, gid) {
  var base = String(baseUrl || '').replace(/[#?].*$/, '');
  var id = String(gid);
  var fragment = '#gid=';
  return base + '?gid=' + id + fragment + id;
}

function PanelLinks_sheetUrl(ss, sheet) {
  return _PanelLinks_composeSheetUrl(ss.getUrl(), sheet.getSheetId());
}

/** シートオブジェクトが無い場所用 (gid を数値で持っている場合)。 */
function PanelLinks_sheetUrlById(ssUrlOrId, gid) {
  var value = String(ssUrlOrId || '');
  var base = /^https:\/\//.test(value) ? value : 'https://docs.google.com/spreadsheets/d/' + value + '/edit';
  return _PanelLinks_composeSheetUrl(base, gid);
}

/** 古い Sheets URL (#gid=N のみ) を query + fragment 形式へ上げる純関数。 */
function PanelLinks_upgradeGidUrl(url) {
  if (url === null || typeof url === 'undefined') return url;
  var value = String(url);
  // /a/{domain}/spreadsheets/ 形式 (Workspace 用パス) も対象。2026-09-03 に取りこぼしを実測。
  if (!value || !/^https?:\/\/docs\.google\.com\/(a\/[^/]+\/)?spreadsheets\//i.test(value)) return url;
  if (/[?&]gid=\d+(?:[&#]|$)/.test(value)) return url;
  var match = value.match(/#gid=(\d+)(?:&([^#]*))?$/);
  if (!match) return url;
  var query = '?gid=' + match[1] + (match[2] ? '&' + match[2] : '');
  var fragment = '#gid=';
  return value.slice(0, match.index) + query + fragment + match[1];
}

function _PanelLinks_richLinkRuns(rich) {
  if (!rich) return [];
  var runs = [];
  try { runs = rich.getRuns(); } catch (e) { runs = []; }
  if (!runs || !runs.length) runs = [rich];
  return runs.map(function (run) {
    var url = '';
    try { url = run.getLinkUrl() || ''; } catch (e) { url = ''; }
    return {
      start: typeof run.getStartIndex === 'function' ? run.getStartIndex() : 0,
      end: typeof run.getEndIndex === 'function' ? run.getEndIndex() : String(rich.getText() || '').length,
      text: String(run.getText() || ''),
      url: url
    };
  });
}

function _PanelLinks_buildUpgradedRich(rich, fallbackValue) {
  var text = rich ? String(rich.getText() || '') : String(fallbackValue || '');
  var runs = _PanelLinks_richLinkRuns(rich);
  var builder = SpreadsheetApp.newRichTextValue().setText(text);
  runs.forEach(function (run) {
    var upgraded = PanelLinks_upgradeGidUrl(run.url);
    if (upgraded) builder.setLinkUrl(run.start, run.end, upgraded);
    try {
      var sourceRuns = rich.getRuns();
      var source = sourceRuns.filter(function (candidate) { return candidate.getStartIndex() === run.start; })[0];
      if (source) builder.setTextStyle(run.start, run.end, source.getTextStyle());
    } catch (e) {}
  });
  return builder.build();
}

/** master「Claude生成物」の既存 gid リンクを一括更新する管理関数。 */
function _admin_upgradeGidLinks(opts) {
  opts = opts || {};
  var dryRun = opts.dryRun !== false;
  var started = Date.now();
  var deadlineMs = 240000;
  // _MASTER_SS_ID は存在しない識別子だった (実行時 ReferenceError。純関数しかテストが叩かないので
  // すり抜けた。2026-09-03 修正)。「Claude生成物」シートを持つ master は実行パネルと同じ SS。
  var ss = SpreadsheetApp.openById(opts.masterSsId || _PANEL_MASTER_SS);
  var sheet = ss.getSheetByName(_MASTER_ARTIFACT_SHEET);
  if (!sheet) return { scanned: 0, willUpdate: 0, samples: [], remainingOldStyle: 0, truncated: false };
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return { scanned: 0, willUpdate: 0, samples: [], remainingOldStyle: 0, truncated: false };
  var headers = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
  var urlCol = headers.map(function (v) { return String(v || '').trim(); }).indexOf('URL') + 1;
  if (!urlCol) throw new Error('Claude生成物シートに URL ヘッダーがありません');
  var range = sheet.getRange(2, urlCol, lastRow - 1, 1);
  var values = range.getValues();
  var richValues = range.getRichTextValues();
  var scanned = 0, willUpdate = 0, samples = [], truncated = false;
  var output = [];
  for (var i = 0; i < values.length; i++) {
    if (Date.now() - started > deadlineMs) { truncated = true; break; }
    var rich = richValues[i][0];
    var linkRuns = _PanelLinks_richLinkRuns(rich).filter(function (run) { return !!run.url; });
    var candidates = linkRuns.length ? linkRuns.map(function (run) { return run.url; }) : [String(values[i][0] || '')];
    var changedPair = candidates.map(function (url) { return { before: url, after: PanelLinks_upgradeGidUrl(url) }; }).filter(function (pair) { return pair.after !== pair.before; })[0];
    var before = changedPair ? changedPair.before : candidates[0];
    var after = changedPair ? changedPair.after : before;
    var changed = !!changedPair;
    scanned++;
    if (changed) {
      willUpdate++;
      if (samples.length < 10) samples.push({ row: i + 2, before: before, after: after });
    }
    if (!dryRun) {
      // セルの表示文字そのものが URL の場合は、リンクだけでなく**表示文字も**上げる。
      // Panel_backfillResultLinks は getValues() (= 表示文字) から URL を読むので、
      // リンクだけ直すと backfill が旧 URL を書き戻してしまう (2026-09-03 実測)。
      var cellText = String((rich ? rich.getText() : '') || values[i][0] || '').trim();
      var textIsUrl = /^https?:\/\/\S+$/.test(cellText);
      if (linkRuns.length && !textIsUrl) {
        output.push([_PanelLinks_buildUpgradedRich(rich, values[i][0])]);
      } else if (textIsUrl) {
        var upgradedText = PanelLinks_upgradeGidUrl(cellText);
        var urlBuilder = SpreadsheetApp.newRichTextValue().setText(upgradedText);
        urlBuilder.setLinkUrl(0, upgradedText.length, upgradedText);
        output.push([urlBuilder.build()]);
      } else {
        var plainText = String(after || '');
        var plainBuilder = SpreadsheetApp.newRichTextValue().setText(plainText);
        if (/^https?:\/\//.test(plainText)) plainBuilder.setLinkUrl(0, plainText.length, plainText);
        output.push([plainBuilder.build()]);
      }
    }
  }
  if (!dryRun && output.length) range.offset(0, 0, output.length, 1).setRichTextValues(output);
  var remainingOldStyle = willUpdate;
  if (!dryRun && output.length && !truncated) {
    remainingOldStyle = 0;
    var readValues = range.getValues();
    var readRich = range.getRichTextValues();
    for (var j = 0; j < readValues.length; j++) {
      var urls = _PanelLinks_richLinkRuns(readRich[j][0]).filter(function (run) { return !!run.url; }).map(function (run) { return run.url; });
      if (!urls.length) urls = [String(readValues[j][0] || '')];
      if (urls.some(function (url) { return PanelLinks_upgradeGidUrl(url) !== url; })) remainingOldStyle++;
    }
  }
  if (!dryRun && truncated) remainingOldStyle = willUpdate + (values.length - scanned);
  return { scanned: scanned, willUpdate: willUpdate, samples: samples, remainingOldStyle: remainingOldStyle, truncated: truncated };
}

/**
 * 既にパネルへ書かれてしまった結果セルのリンクを是正する計画を作る純関数。
 * (1) 旧 '#gid=' だけの Sheets URL を ?gid=N#gid=N へ上げる
 * (2) 同じセルに gid 付きリンクがあるなら、gid の無い Sheets リンク(実施計画書トップ)は落とす
 *     — ラベルは具体的な成果物を指しているのに、開くと直前に見ていた無関係なタブが出るため
 *       (2026-09-03 kim 報告「リンク先がちぐはぐ」の主因)
 * @param {Array<{text:string,url:string}>} links セル内のリンク(表示順)
 * @return {{links: Array<{text:string,url:string}>, changed: boolean}}
 */
function PanelLinks_repairCellLinks(links) {
  var list = (links || []).filter(function (link) { return link && String(link.url || ''); });
  // PanelLinks_buildRichText は {label, url} を受ける契約。text で返すと表示文字が undefined になる
  // (2026-09-03 に実際にパネルへ 'undefined' と書いてしまった)
  var upgraded = list.map(function (link) {
    return { label: String(link.label || link.text || ''), url: PanelLinks_upgradeGidUrl(String(link.url)) };
  });
  var hasGid = upgraded.some(function (link) { return /[?&#]gid=\d+/.test(link.url); });
  var kept = upgraded.filter(function (link) {
    var isSheetsTop = /^https?:\/\/docs\.google\.com\/(a\/[^/]+\/)?spreadsheets\//i.test(link.url) && !/[?&#]gid=\d+/.test(link.url);
    return !(hasGid && isSheetsTop);
  });
  var changed = kept.length !== list.length || kept.some(function (link, i) {
    var src = list[i] || {};
    return link.url !== String(src.url || '') || link.label !== String(src.label || src.text || '');
  });
  return { links: kept, changed: changed };
}

/**
 * パネルの結果セルを PanelLinks_repairCellLinks の計画で書き直す。
 * caseId 省略時は全案件パネル。dryRun 既定 true。
 */
function _admin_repairPanelLinks(opts) {
  opts = opts || {};
  var dryRun = opts.dryRun !== false;
  var caseId = String(opts.caseId || '');
  var started = new Date().getTime();
  var ms = SpreadsheetApp.openById(_PANEL_MASTER_SS);
  var panels = ms.getSheets().filter(function (sheet) {
    try {
      if (!_Panel_isMarker(String(sheet.getRange('G1').getValue()))) return false;
      return !caseId || String(sheet.getRange('G4').getValue() || '') === caseId;
    } catch (e) { return false; }
  });
  var out = { panels: 0, cellsScanned: 0, cellsChanged: 0, samples: [], truncated: false };
  panels.forEach(function (panel) {
    if (new Date().getTime() - started > 240000) { out.truncated = true; return; }
    out.panels++;
    var lastRow = panel.getLastRow();
    if (lastRow < 1) return;
    var resultCol = PanelLinks_resolveLayout(panel).resultCol;
    var range = panel.getRange(1, resultCol, lastRow, 1);
    var richValues = range.getRichTextValues();
    var next = [], dirty = false;
    richValues.forEach(function (row, index) {
      var rich = row[0];
      var runs = _PanelLinks_richLinkRuns(rich).filter(function (run) { return !!run.url; });
      if (!runs.length) { next.push([rich]); return; }
      out.cellsScanned++;
      var plan = PanelLinks_repairCellLinks(runs.map(function (run) { return { text: run.text, url: run.url }; }));
      if (!plan.changed) { next.push([rich]); return; }
      // 説明文(リンクを含まない先頭部分)は保持し、リンク部分だけ組み直す
      var fullText = rich ? String(rich.getText() || '') : '';
      var firstLinkStart = runs[0].start;
      var prefix = fullText.slice(0, firstLinkStart);
      var built = PanelLinks_buildRichText(prefix.replace(/\n$/, ''), plan.links);
      var builder = SpreadsheetApp.newRichTextValue().setText(built.text);
      built.ranges.forEach(function (r) { builder.setLinkUrl(r.start, r.end, r.url); });
      next.push([builder.build()]);
      dirty = true;
      out.cellsChanged++;
      if (out.samples.length < 10) {
        out.samples.push({ sheet: panel.getName(), row: index + 1, before: runs.map(function (r) { return r.text + '=' + r.url; }), after: plan.links.map(function (r) { return r.label + '=' + r.url; }) });
      }
    });
    if (!dryRun && dirty) range.setRichTextValues(next);
  });
  if (!dryRun) SpreadsheetApp.flush();
  out.dryRun = dryRun;
  return out;
}

/** 案件パネルの結果セルに実在する RichText リンクを読む（検証専用）。 */
function _debug_panelResultLinks(caseId) {
  caseId = String(caseId || '');
  var ms = SpreadsheetApp.openById(_PANEL_MASTER_SS);
  var panel = ms.getSheets().filter(function (sheet) {
    try {
      return _Panel_isMarker(String(sheet.getRange('G1').getValue())) && String(sheet.getRange('G4').getValue() || '') === caseId;
    } catch (e) { return false; }
  })[0];
  if (!panel) return { error: 'パネルなし: ' + caseId };
  var lastRow = panel.getLastRow();
  if (lastRow < 1) return [];
  var resultCol = PanelLinks_resolveLayout(panel).resultCol;
  var featureLabels = panel.getRange(1, 1, lastRow, 1).getDisplayValues();
  var range = panel.getRange(1, resultCol, lastRow, 1);
  var richValues = range.getRichTextValues();
  return richValues.map(function (row, index) {
    var rich = row[0];
    var links = _PanelLinks_richLinkRuns(rich).filter(function (run) { return !!run.url; }).map(function (run) { return { label: run.text, url: run.url }; });
    return { row: index + 1, featureLabel: String(featureLabels[index][0] || ''), text: rich ? String(rich.getText() || '') : '', links: links };
  }).filter(function (item) { return item.links.length > 0; });
}

/**
 * @param {*} ret コマンドの戻り値
 * @return {Array<{label: string, url: string}>} 重複 URL を除いた最大 PANEL_LINK_MAX 件
 */
function PanelLinks_collect(ret) {
  if (!ret || typeof ret !== 'object') return [];
  var keys = Object.keys(ret).filter(function (k) { return /url$/i.test(k); });
  var hasDirectSheetUrl = keys.some(function (k) {
    return k !== 'zissiSheetUrl' && typeof ret[k] === 'string' && /^https?:\/\//.test(ret[k]) && /[?&#]gid=/.test(ret[k]);
  });
  keys.sort(function (a, b) {
    var ia = PANEL_LINK_ORDER.indexOf(a), ib = PANEL_LINK_ORDER.indexOf(b);
    if (ia < 0) ia = PANEL_LINK_ORDER.length;
    if (ib < 0) ib = PANEL_LINK_ORDER.length;
    return ia - ib;
  });
  var seen = {}, out = [];
  keys.forEach(function (k) {
    if (k === 'zissiSheetUrl' && hasDirectSheetUrl) return;
    var url = ret[k];
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return;
    if (seen[url]) return;
    seen[url] = true;
    var nameKey = k.replace(/Url$/i, 'Name');
    var name = ret[nameKey];
    var label = typeof name === 'string' && name.trim() ? '📄 ' + name.trim().slice(0, 40) : _PanelLinks_label(k);
    if (out.length < PANEL_LINK_MAX) out.push({ label: label, url: url });
  });
  return out;
}

/**
 * 結果セル1つに「説明文 + 複数リンク」を入れる RichTextValue を組む。
 * リンクが1本でも RichText で統一する (HYPERLINK 数式だと複数本を1セルに入れられない)。
 * @param {string} text 説明文 (panelResult。空でよい)
 * @param {Array<{label: string, url: string}>} links
 * @return {{text: string, ranges: Array<{start: number, end: number, url: string}>}}
 */
function PanelLinks_buildRichText(text, links) {
  var prefix = text ? String(text).slice(0, 200) + '\n' : '';
  var body = '', ranges = [];
  (links || []).forEach(function (link, i) {
    if (i > 0) body += '  /  ';
    var start = prefix.length + body.length;
    body += link.label;
    ranges.push({ start: start, end: prefix.length + body.length, url: link.url });
  });
  return { text: prefix + body, ranges: ranges };
}

/** GAS の Range へ書き込む (Apps Script 実行時のみ)。 */
function PanelLinks_write(range, text, links) {
  var built = PanelLinks_buildRichText(text, links);
  var builder = SpreadsheetApp.newRichTextValue().setText(built.text);
  built.ranges.forEach(function (r) { builder.setLinkUrl(r.start, r.end, r.url); });
  // D 列は既定で折り返さない。wrap しないと説明文の下のリンク行が見えなくなる
  range.setRichTextValue(builder.build()).setWrap(true);
}

/** パネルの G1 マーカーから、結果列と状態の書き方を決める。 */
function PanelLinks_resolveLayout(panel) {
  var marker = '';
  try { marker = String(panel.getRange('G1').getValue() || ''); } catch (e) {}
  var isV3 = marker === 'BOOTH_PANEL_V3';
  return { isV3: isV3, resultCol: isV3 ? 5 : 4, statusCol: isV3 ? 6 : 5 };
}

/** レイアウト差を吸収して結果・日時・状態をパネルへ書く。 */
function PanelLinks_writePanelOutcome(panel, row, resultValue, nowStr, status, links) {
  var layout = PanelLinks_resolveLayout(panel);
  var list = Array.isArray(links) ? links : [];
  if (list.length) PanelLinks_write(panel.getRange(row, layout.resultCol), resultValue || '', list);
  else panel.getRange(row, layout.resultCol).setValue(resultValue || '');
  if (layout.isV3) {
    panel.getRange(row, layout.statusCol).setValue(String(status || '') + (nowStr ? ' (' + nowStr + ')' : ''));
  } else {
    panel.getRange(row, layout.statusCol, 1, 2).setValues([[nowStr, status]]);
  }
  return layout;
}

/** 戻り値にリンクも表示文も無いコマンドの、事実に沿った完了表示。 */
function PanelLinks_completionFallback(artifactSheetUrl, zissiLinks) {
  if (zissiLinks && zissiLinks.length) {
    return {
      text: '完了（成果物は実施計画書の下記シートに直接書き込まれています）',
      links: zissiLinks.slice(0, PANEL_LINK_MAX)
    };
  }
  if (artifactSheetUrl) {
    return {
      text: '完了',
      links: [{ label: '📄 Claude生成物シートを開く', url: String(artifactSheetUrl) }]
    };
  }
  return { text: '完了（このコマンドは成果物ファイルを作りません。実施計画書の該当シートを直接ご確認ください）', links: [] };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    _PanelLinks_composeSheetUrl: _PanelLinks_composeSheetUrl,
    PanelLinks_sheetUrl: PanelLinks_sheetUrl,
    PanelLinks_sheetUrlById: PanelLinks_sheetUrlById,
    PanelLinks_upgradeGidUrl: PanelLinks_upgradeGidUrl,
    PanelLinks_repairCellLinks: PanelLinks_repairCellLinks,
    PanelLinks_collect: PanelLinks_collect,
    PanelLinks_buildRichText: PanelLinks_buildRichText,
    PanelLinks_resolveLayout: PanelLinks_resolveLayout,
    PanelLinks_writePanelOutcome: PanelLinks_writePanelOutcome,
    PanelLinks_completionFallback: PanelLinks_completionFallback,
    PANEL_ZISSI_OUTPUT_SHEETS: PANEL_ZISSI_OUTPUT_SHEETS,
    PanelLinks_zissiOutputLinks: PanelLinks_zissiOutputLinks,
    PANEL_LINK_MAX: PANEL_LINK_MAX,
    PANEL_LINK_LABELS: PANEL_LINK_LABELS,
    PANEL_LINK_ORDER: PANEL_LINK_ORDER
  };
}
