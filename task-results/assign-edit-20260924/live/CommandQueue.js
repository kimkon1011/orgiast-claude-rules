/**
 * コマンドキュー方式（ONBOARDING §1.4.1 標準パターン）
 *
 * Drive フォルダ `claude-booth-cmds` を 1 分ごとの time-based トリガーで監視。
 * Claude が cmd_<unique>.json をフォルダに投げる → トリガーが拾って実行 → result_<unique>.txt を書き戻す。
 *
 * 初回 1 クリック (setupCommandQueue ▶実行) で OAuth 同意 + トリガー作成 → 以降は手作業ゼロ。
 *
 * セキュリティ:
 * - COMMANDS ホワイトリスト方式（動的呼び出し禁止）
 * - フォルダはオーナー専用、外部に共有しない
 * - コマンドファイルは JSON のみ、コード文字列禁止
 */

const CMD_FOLDER_ID = '1W9uuMTPO_rduhD3l2a7eLxuU0bngRjPz'; // Downloads/ブース制作アプリ/claude-booth-cmds
const CMD_RUNNING_STALE_MS = 12 * 60 * 1000;
const CMD_RECENT_RESULT_MS = 30 * 60 * 1000;
const CMD_QUEUE_HOUSEKEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CMD_QUEUE_HOUSEKEEP_AT = 'CMD_QUEUE_HOUSEKEEP_AT';

function _cmdQueue_markerName(kind, uniq) {
  return String(kind) + '_' + String(uniq) + (kind === 'cmd' ? '.json' : '.txt');
}

function _cmdQueue_uniqFromName(name) {
  const match = String(name || '').match(/^(?:cmd_([^/]+)\.json|running_([^/]+)\.txt|result_([^/]+)\.txt)$/i);
  return match ? (match[1] || match[2] || match[3]) : null;
}

function _cmdQueue_selectStale(markers, nowMs, staleMs, resultUniqs) {
  const completed = resultUniqs instanceof Set ? resultUniqs : new Set(resultUniqs || []);
  return (markers || []).filter(function (marker) {
    return Number(nowMs) - Number(marker.createdMs) >= Number(staleMs);
  }).map(function (marker) {
    return { uniq: marker.uniq, hasResult: completed.has(marker.uniq) };
  });
}

function _cmdQueue_sameArgs(a, b) {
  const left = a === undefined ? [] : a;
  const right = b === undefined ? [] : b;
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every(function (value, index) {
    return JSON.stringify(value) === JSON.stringify(right[index]);
  });
}

function _cmdQueue_selectArchivable(files, nowMs, olderThanMs, limit) {
  const results = (files || []).filter(function (file) {
    return String(file.name || '').indexOf('result_') === 0;
  });
  const eligible = results.filter(function (file) {
    return Number(nowMs) - Number(file.createdMs) >= Number(olderThanMs);
  }).sort(function (a, b) {
    return Number(a.createdMs) - Number(b.createdMs);
  });
  const max = Math.max(0, Number(limit) || 0);
  return {
    targets: eligible.slice(0, max).map(function (file) {
      const jst = new Date(Number(file.createdMs) + 9 * 60 * 60 * 1000);
      return {
        name: file.name,
        createdMs: file.createdMs,
        ym: String(jst.getUTCFullYear()) + '-' + String(jst.getUTCMonth() + 1).padStart(2, '0')
      };
    }),
    scanned: results.length,
    truncated: eligible.length > max
  };
}

// 実行可能関数のホワイトリスト
function _cmdQueue_commands() {
  return {
    'AssignNag_nagPending': function (opts) { return AssignNag_nagPending(opts || {}); },
    'AssignNag_installTrigger': function () { return AssignNag_installTrigger(); },
    'AssignNag_testDm': function () { return AssignNag_testDm(); },
    '_admin_printChecklistReview': function (caseId, patches) { return _admin_printChecklistReview(caseId, patches); },
    '_debug_printChecklistSsId': function () { return _debug_printChecklistSsId(); },
    '_debug_printChecklistSharing': function () { return _debug_printChecklistSharing(); },
    'PrintChecklist_pendingReviewCount': function (caseId) { return PrintChecklist_pendingReviewCount(caseId); },
    'PrintChecklist_installReviewTrigger': function () { return PrintChecklist_installReviewTrigger(); },
    'PrintChecklist_build': function (opts) { return PrintChecklist_build(opts || {}); },
    'PrintChecklist_buildOne': function (caseId) { return PrintChecklist_buildOne(caseId); },
    'PrintChecklist_tick': function () { return PrintChecklist_tick(); },
    'PrintChecklist_installTrigger': function () { return PrintChecklist_installTrigger(); },
    'PrintChecklist_protectSheets': function () { return PrintChecklist_protectSheets(); },
    '_debug_printChecklistCase': function (caseId) { return _debug_printChecklistCase(caseId); },
    '_debug_kouryouSurvey': function (startIndex) { return _debug_kouryouSurvey(startIndex); },
    '_debug_printChecklistVerify': function (caseId) { return _debug_printChecklistVerify(caseId); },
    '_debug_listTriggers': function () { return _debug_listTriggers(); },
    '_admin_dedupeTriggers': function (opts) { return _admin_dedupeTriggers(opts || {}); },
    'NewCaseForm_build': function () { return NewCaseForm_build(); },
    'EventShipping_buildPayload': function (caseId) { return EventShipping_buildPayload(caseId); },
    'EventShipping_saveInput': function (caseId, payload) { return EventShipping_saveInput(caseId, payload); },
    'EventShipping_submit': function (caseId, opts) { return EventShipping_submit(caseId, opts); },
    'EventShipping_ensureRoomAccess': function (caseId) { return EventShipping_ensureRoomAccess(caseId); },
    'EventShipping_reconcile': function (caseId) { return EventShipping_reconcile(caseId); },
    'EventShipping_relayWarehouseNotice': function () { return EventShipping_relayWarehouseNotice(); },
    'EventShipping_cancel': function (caseId, reason) { return EventShipping_cancel(caseId, reason); },
    'NewCase_register': function (payload, opts) { return NewCase_register(payload, opts); },
    'CaseMeet_ensure': function (caseId, opts) { return CaseMeet_ensure(caseId, opts); },
    'CaseMeet_backfillAll': function (opts) { return CaseMeet_backfillAll(opts); },
    'NewCase_removeBlock': function (blockStart, expectClientName, opts) { return NewCase_removeBlock(blockStart, expectClientName, opts); },
    '_admin_removeTestCase': function (caseId, opts) { return _admin_removeTestCase(caseId, opts); },
    '_debug_queueInFlight': function () { return _debug_queueInFlight(); },
    'CmdQueue_housekeep': function (opts) { return CmdQueue_housekeep(opts); },
    'PanelProgress_applyManual': function (caseId, eventLabel, featureKey, done, user) { return PanelProgress_applyManual(caseId, eventLabel, featureKey, done, user); },
    'listFailureCounters': function () { return listFailureCounters(); },
    'resetAutoProcessFailures': function (caseId) { return resetAutoProcessFailures(caseId); },
    'resetDigestFailures': function (caseId) { return resetDigestFailures(caseId); },
    'Case_refreshClientContext': function (caseId) { return Case_refreshClientContext(caseId); },
    'TaskLedger_sync': function (caseId) { return TaskLedger_sync(caseId); },
    'TaskLedger_readRows': function (caseId) { return TaskLedger_readRows(caseId); },
    'TaskLedger_runTask': function (caseId, taskId) { return TaskLedger_runTask(caseId, taskId, { auto: false }); },
    'TaskLedger_pollChecked': function () { return TaskLedger_pollChecked(); },
    'TaskLedger_syncAllNightly': function () { return TaskLedger_syncAllNightly(); },
    'TaskLedger_autoRunNightly': function () { return TaskLedger_autoRunNightly(); },
    'TaskLedger_rebuildRollup': function () { return TaskLedger_rebuildRollup(); },
    'CostRollup_rebuild': function () { return CostRollup_rebuild(); },
    '_admin_taskLedgerPurgeSource': function (caseId, source, opts) { return _admin_taskLedgerPurgeSource(caseId, source, opts); },
    '_admin_taskLedgerCompact': function (caseId, opts) { return _admin_taskLedgerCompact(caseId, opts); },
    '_admin_taskLedgerCompactAll': function (opts) { return _admin_taskLedgerCompactAll(opts || {}); },
    '_debug_taskLedger': function (caseId) { return _debug_taskLedger(caseId); },
    '_debug_taskLedgerFeature': function (caseId, taskId) { return _debug_taskLedgerFeature(caseId, taskId); },
    '_admin_taskLedgerSetRow': function (caseId, taskId, patch) { return _admin_taskLedgerSetRow(caseId, taskId, patch); },
    'Meeting_linkTranscript': function (caseId) { return Meeting_linkTranscript(caseId); },
    'Meeting_linkTranscriptWithQuery': function (caseId, query) { return Meeting_linkTranscriptWithQuery(caseId, query); },
    'Phase_MeetingAgenda_generate': function (caseId) { return Phase_MeetingAgenda_generate(caseId); },
    'Admin_getSafeScriptProperties': function () { return Admin_getSafeScriptProperties(); },
    'Admin_setEventShippingMode': function (mode, opts) { return Admin_setEventShippingMode(mode, opts); },
    'Admin_setEventShippingTestEmail': function (email) { return Admin_setEventShippingTestEmail(email); },
    'Admin_setSalesContextConfig': function (url, token) { return Admin_setSalesContextConfig(url, token); },
    'Admin_setTldvApiKey': function (key) { PropertiesService.getScriptProperties().setProperty('TLDV_API_KEY', String(key || '')); return { ok: true, set: Boolean(key) }; },
    'Admin_setAssignWebhook': function (url) {
      PropertiesService.getScriptProperties().setProperty('DISCORD_ASSIGN_WEBHOOK', String(url || ''));
      return { ok: true, set: Boolean(url) };
    },
    'Phase_AssignRequest_testNotify': function () { return Phase_AssignRequest_testNotify(); },
    // アサイン依頼シートへの書き込み権テスト: ダミー行を書いて即削除
    '_test_assignSheetAppend': function () {
      const row = _AssignSheet_emptyRow();
      row[0] = new Date(); row[1] = '接続テスト(自動・無視してください)'; row[2] = '(テスト)';
      const rowNum = _AssignSheet_append(row);
      const readBack = SpreadsheetApp.openById('1a3VlFzkuH8jMJZhIPZPekWfdpJ7NgPo5p3fQqHelzmU')
        .getSheetByName('マスター').getRange(rowNum, 2).getValue();
      SpreadsheetApp.openById('1a3VlFzkuH8jMJZhIPZPekWfdpJ7NgPo5p3fQqHelzmU')
        .getSheetByName('マスター').deleteRow(rowNum);
      return { ok: true, wroteRow: rowNum, readBack: String(readBack), cleaned: true };
    },
    // 上部挿入(_AssignSheet_insertRowsTop)の実シート挙動テスト: ダミー2行を先頭に入れて読み戻し、即削除
    '_test_assignInsertTop': function () {
      const rows = [['(テスト)施工', '接続テスト(自動・無視してください)', '(テスト施工)'], ['(テスト)イベント', '接続テスト(自動・無視してください)', '(テストイベント)']]
        .map(function (head) {
          const row = _AssignSheet_emptyRow();
          row[0] = new Date(); row[1] = head[1]; row[2] = head[2];
          return row;
        });
      const inserted = _AssignSheet_insertRowsTop(rows);
      const sheet = SpreadsheetApp.openById(_ASSIGN_SS_ID).getSheetByName(_ASSIGN_SHEET_NAME);
      const readBack = sheet.getRange(2, 1, inserted.length, 3).getDisplayValues();
      const rowAfter = sheet.getRange(2 + inserted.length, 1, 1, 3).getDisplayValues()[0];
      inserted.slice().sort(function (a, b) { return b - a; }).forEach(function (row) { sheet.deleteRow(row); });
      SpreadsheetApp.flush();
      return { ok: true, inserted: inserted, readBack: readBack, rowBelowAfterInsert: rowAfter, cleaned: true, lastRowAfter: sheet.getLastRow() };
    },
    '_admin_deleteAssignRows': function (rowNums, expectTsPrefix) { return _admin_deleteAssignRows(rowNums, expectTsPrefix); },
    '_admin_backfillAssignRequester': function (items) { return _admin_backfillAssignRequester(items); },
    '_admin_setTaskProducer': function (col, name, expectEventName) { return _admin_setTaskProducer(col, name, expectEventName); },
    '_admin_replaceMasterProducers': function (oldNames, newName, opts) { return _admin_replaceMasterProducers(oldNames, newName, opts); },
    'Phase1_DesignerBrief_generate': function (caseId) { return Phase1_DesignerBrief_generate(caseId); },
    'Phase_AssignRequest_generate': function (caseId, opts) { return Phase_AssignRequest_generate(caseId, opts); },
    'Phase_ProcurementRequest_generate': function (caseId) { return Phase_ProcurementRequest_generate(caseId); },
    'Phase_ProcurementRequest_requestApproval': function (caseId) { return Phase_ProcurementRequest_requestApproval(caseId); },
    'Phase_ProcurementRequest_openApproval': function (caseId) { return Phase_ProcurementRequest_openApproval(caseId); },
    '_test_procurementApprovalSync': function (caseId) { return _test_procurementApprovalSync(caseId); },
    'Admin_setProcurementWebhook': function (url) {
      PropertiesService.getScriptProperties().setProperty('DISCORD_PROCUREMENT_WEBHOOK', String(url || ''));
      return { ok: true, set: Boolean(url) };
    },
    'Admin_setProcurementApprovers': function (emails) {
      PropertiesService.getScriptProperties().setProperty('PROCUREMENT_APPROVERS', String(emails || ''));
      return { ok: true, approvers: String(emails || '') };
    },
    'Phase_ProcurementRequest_submit': function (caseId) { return Phase_ProcurementRequest_submit(caseId); },
    'Phase_ProcurementRequest_quickSubmit': function (caseId) { return Phase_ProcurementRequest_quickSubmit(caseId); },
    'PanelPending_refresh': function (caseId) { return PanelPending_refresh(caseId); },
    'PanelPending_applyChecked': function (caseId) { return PanelPending_applyChecked(caseId); },
    '_test_procurementSubmitRoundTrip': function (caseId) { return _test_procurementSubmitRoundTrip(caseId); },
    '_test_procurementQuickRoundTrip': function (caseId) { return _test_procurementQuickRoundTrip(caseId); },
    'Phase_ProcurementRequest_debugRows': function (caseId) { return Phase_ProcurementRequest_debugRows(caseId); },
    'Phase1_Estimate_generate': function (caseId, pastedText) { return Phase1_Estimate_generate(caseId, pastedText); },
    'Phase1_EstimateOnly_generate': function (caseId, pastedText) { return Phase1_EstimateOnly_generate(caseId, pastedText); },
    'Phase_FromText_generate': function (caseId) { return Phase_FromText_generate(caseId); },
    'Phase_Invoice_generate': function (caseId, pastedText) { return Phase_Invoice_generate(caseId, pastedText); },
    'Phase_CoverLetter_generate': function (caseId, pastedText) { return Phase_CoverLetter_generate(caseId, pastedText); },
    '_debug_panelInputSection': function (caseId) { return _debug_panelInputSection(caseId); },
    'Phase_CostProfit_generate': function (caseId) { return Phase_CostProfit_generate(caseId); },
    '_debug_costProfitSheet': function (caseId) { return _debug_costProfitSheet(caseId); },
    'Phase1_Schedule_generate': function (caseId) { return Phase1_Schedule_generate(caseId); },
    'Phase_MailResponse_generate': function (caseId) { return Phase_MailResponse_generate(caseId); },
    'Phase2_AssignBrief_generate': function (caseId, partyType) { return Phase2_AssignBrief_generate(caseId, partyType); },
    'Phase2_SetupTeardownPlan_generate': function (caseId) { return Phase2_SetupTeardownPlan_generate(caseId); },
    'Phase2_LogisticsPlan_generate': function (caseId) { return Phase2_LogisticsPlan_generate(caseId); },
    'Phase2_ItemList_generate': function (caseId) { return Phase2_ItemList_generate(caseId); },
    'Phase2_Submission_generate': function (caseId) { return Phase2_Submission_generate(caseId); },
    'Phase2_ElectricalApplication_generate': function (caseId, opts) { return Phase2_ElectricalApplication_generate(caseId, opts || {}); },
    '_test_electricalApplicationQuickRoundTrip': function (caseId) { return _test_electricalApplicationQuickRoundTrip(caseId); },
    'Phase2_LayoutPlan_generate': function (caseId) { return Phase2_LayoutPlan_generate(caseId); },
    'Phase4_DayBrief_generate': function (caseId, partyType) { return Phase4_DayBrief_generate(caseId, partyType); },
    'CaseList_listAll': function () { return CaseList_listAll(); },
    '_admin_deleteDuplicateCaseRow': function (caseId, opts) { return _admin_deleteDuplicateCaseRow(caseId, opts); },
    '_debug_duplicateCaseIds': function () {
      const cases = CaseList_listAll();
      const byCaseId = {};
      const emptyCaseIdRows = [];
      cases.forEach(function (c, index) {
        const caseId = String(c.caseId || '').trim();
        if (!caseId) {
          emptyCaseIdRows.push(index);
          return;
        }
        if (!byCaseId[caseId]) {
          byCaseId[caseId] = {
            caseId: caseId,
            count: 0,
            rows: [],
            clientNames: [],
            caseNames: [],
            zissiIds: []
          };
        }
        const duplicate = byCaseId[caseId];
        duplicate.count++;
        duplicate.rows.push(index);
        duplicate.clientNames.push(c.clientName);
        duplicate.caseNames.push(c.caseName);
      });
      const duplicates = Object.keys(byCaseId).map(function (caseId) {
        return byCaseId[caseId];
      }).filter(function (duplicate) {
        return duplicate.count >= 2;
      });
      return {
        total: duplicates.length,
        duplicates: duplicates,
        emptyCaseIdRows: emptyCaseIdRows
      };
    },
    'HowTo_setupSheetCore': function () { return HowTo_setupSheetCore(); },
    'HowTo_setupMasterSheet': function () { return HowTo_setupMasterSheet(); },
    'EquipmentImages_buildCatalog': function () { return EquipmentImages_buildCatalog(); },
    'EquipmentImages_exportSlidesPdf': function () { return EquipmentImages_exportSlidesPdf(); },
    'EquipmentImages_checkAndUpdate': function () { return EquipmentImages_checkAndUpdate(); },
    'EquipmentImages_setupDailyTrigger': function () { return EquipmentImages_setupDailyTrigger(); },
    'MailAttachments_pollAll': function () { return MailAttachments_pollAll(); },
    'MailAttachments_syncCase': function (caseId) {
      const r = MailAttachments_syncCase(caseId);
      // 実行パネルは saved/skipped 配列を読めないので、人が読める1行に畳んで渡す。
      // (skipped は配列なので真偽値の「スキップ」規約とは無関係)
      return _MailAttach_withPanelResult(r);
    },
    'MailAttachments_setupTrigger': function () { return MailAttachments_setupTrigger(); },
    'TransferLinks_pollAll': function () { return TransferLinks_pollAll(); },
    'TransferLinks_syncCase': function (caseId) {
      return _TransferLinks_withPanelResult(TransferLinks_syncCase(caseId));
    },
    'TransferLinks_setupTrigger': function () { return TransferLinks_setupTrigger(); },
    '_debug_transferLinks': function (caseId) { return _debug_transferLinks(caseId); },
    'Azukari_repairMisplaced': function (caseId, dryRun) { return Azukari_repairMisplaced(caseId, dryRun); },
    '_debug_mailAttachments': function (caseId) { return _debug_mailAttachments(caseId); },
    '_debug_mailAttachmentsPlanAll': function () { return _debug_mailAttachmentsPlanAll(); },
    '_debug_testKeepFormat': function () { return _debug_testKeepFormat(); },
    'Admin_setOpenRouterKey': function (key) {
      PropertiesService.getScriptProperties().setProperty('OPENROUTER_API_KEY', String(key || ''));
      return { ok: true, set: Boolean(key) };
    },
    'CaseDigest_buildForCase': function (caseId) { return CaseDigest_buildForCase(caseId); },
    'CaseDigest_nightlyRun': function () { return CaseDigest_nightlyRun(); },
    'CaseDigest_setupNightlyTrigger': function () { return CaseDigest_setupNightlyTrigger(); },
    '_debug_caseDigest': function (caseId) {
      const c = CaseList_getById(caseId);
      if (!c) return { error: 'not found' };
      const materials = Case_collectCaseMaterials(c, { unlimited: true });
      const digest = CaseDigest_load(c);
      return {
        caseId: caseId,
        files: materials.map(function (m) {
          return { fileId: m.driveFileId, label: m.label, kind: m.kind, bytes: m.bytes, lastUpdated: m.lastUpdated };
        }),
        fingerprint: CaseDigest_fingerprint(materials),
        digestHead: digest.slice(0, 800),
        digestChars: digest.length
      };
    },
    '_debug_digestSkipProbe': function (caseId) {
      const c = CaseList_getById(caseId);
      if (!c) return { error: 'not found' };
      const materials = Case_collectCaseMaterials(c, { unlimited: true });
      const computedFp = CaseDigest_fingerprint(materials);
      const sh = CaseDigest_sheet_(c);
      const stored = sh ? sh.getRange('B1:B5').getDisplayValues() : [];
      const storedGeneratedAt = String(stored[0] && stored[0][0] || '');
      const storedFp = String(stored[1] && stored[1][0] || '');
      const storedState = String(stored[3] && stored[3][0] || '');
      const storedProgress = String(stored[4] && stored[4][0] || '');
      return {
        caseId: caseId,
        zissiId: c.zissiId,
        sheetFound: Boolean(sh),
        files: materials.length,
        computedFp: computedFp,
        storedRaw: stored,
        storedGeneratedAt: storedGeneratedAt,
        storedFp: storedFp,
        storedFpLen: storedFp.length,
        computedFpLen: computedFp.length,
        storedState: storedState,
        storedProgress: storedProgress,
        fpEqual: storedFp === computedFp,
        stateEqual: storedState === '完了',
        skipWouldApply: stored.length && String(stored[1][0] || '') === computedFp && String(stored[3][0] || '') === '完了'
      };
    },
    'CaseManualPdf_find': function (caseId) {
      const c = CaseList_getById(caseId);
      if (!c) return { error: 'case not found: ' + caseId };
      const pdfs = CaseManualPdf_find(c);
      return {
        caseId: caseId,
        clientName: c.clientName,
        caseName: c.caseName,
        zissiId: c.zissiId,
        foundCount: pdfs.length,
        pdfs: pdfs
      };
    },
    'CaseList_getById': function (caseId) { return CaseList_getById(caseId); },
    'Checklist_getItemList': function (caseId, refresh) { return Checklist_getItemList(caseId, refresh === true || refresh === 'true'); },
    'CaseList_importFromZissiUrl': function (urlOrId, override) { return CaseList_importFromZissiUrl(urlOrId, override); },
    'CaseList_deleteCase': function (caseId) { return CaseList_deleteCase(caseId); },
    'CaseList_setZissiInfo': function (caseId, zissiId, projectFolderId) { return CaseList_setZissiInfo(caseId, zissiId, projectFolderId); },
    'Phase_ProofCheck_generate': function (caseId) { return Phase_ProofCheck_generate(caseId); },
    'Phase3_NyukoCheck_generate': function (caseId) { return Phase3_NyukoCheck_generate(caseId); },
    'Phase2_BihinVolume_fillAP': function (forceOverwrite) { return Phase2_BihinVolume_fillAP(forceOverwrite); },
    'Phase2_BihinVolume_refineWithClaude': function (maxBatches) { return Phase2_BihinVolume_refineWithClaude(maxBatches); },
    'Phase2_BihinVolume_refineCloth': function () { return Phase2_BihinVolume_refineCloth(); },
    'Phase2_LogisticsFormula_install': function (ssId, gid) { return Phase2_LogisticsFormula_install(ssId, gid); },
    '_debug_taskBlockShape': function (blockStart) { return _debug_taskBlockShape(blockStart); },
    'Panel_rebuild': function () { return Panel_rebuild(); },
    'Panel_ensureCasePanel': function (eventLabel) { return Panel_ensureCasePanel(eventLabel); },
    'Panel_rebuildCasePanel': function (eventLabel, opts) { return Panel_rebuildCasePanel(eventLabel, opts); },
    'Panel_backfillResultLinks': function (opts) { return Panel_backfillResultLinks(opts); },
    'Panel_backfillResultLinksNightly': function () { return Panel_backfillResultLinksNightly(); },
    '_admin_upgradeGidLinks': function (opts) { return _admin_upgradeGidLinks(opts); },
    '_debug_panelResultLinks': function (caseId) { return _debug_panelResultLinks(caseId); },
    '_admin_repairPanelLinks': function (opts) { return _admin_repairPanelLinks(opts); },
    // limit を渡せるようにする。関数側が 270 秒予算で自分で打ち切って remaining を返すので、
    // 大きい limit を渡しても安全 (既定 2 枚だと全案件の展開に何十回も叩く必要がある)。
    'Panel_rebuildAllCasePanels': function (opts) { return Panel_rebuildAllCasePanels(opts || {}); },
    'Panel_rebuildIndex': function () { return Panel_rebuildIndex(); },
    'Panel_hideFinishedPanels': function (days) { return Panel_hideFinishedPanels(days); },
    'Panel_precreateActive': function (limit) { return Panel_precreateActive(limit); },
    'Admin_installTriggers': function () { return Admin_installTriggers(); },
    'JobQueue_housekeep': function () { return JobQueue_housekeep(); },
    'JobQueue_enqueue': function (job) { return JobQueue_enqueue(job); },
    '_debug_jobQueue': function (limit) { return _debug_jobQueue(limit); },
    '_admin_deleteJobRows': function (jobIds) { return _admin_deleteJobRows(jobIds); },
    '_debug_sleepEcho': function (caseId, seconds) { return _debug_sleepEcho(caseId, seconds); },
    'Panel_selfTest': function () { return Panel_selfTest(); },
    '_debug_panelPhaseState': function (caseId) { return _debug_panelPhaseState(caseId); },
    // 案件IDからパネルを引いて再構築する (再構築後もリンクが残るかの検証用。ラベル手打ちに頼らない)
    '_debug_panelRebuildByCase': function (caseId) {
      const ms = SpreadsheetApp.openById(_PANEL_MASTER_SS);
      const resolution = _JobQueue_loadResolution(ms);
      const target = ms.getSheets().filter(function (sheet) {
        try { return _Panel_isMarker(String(sheet.getRange('G1').getValue())); } catch (e) { return false; }
      }).filter(function (sheet) {
        return _JobQueue_resolveCase(String(sheet.getRange('G2').getValue() || ''), resolution).caseId === String(caseId);
      })[0];
      if (!target) return { error: 'パネルなし: ' + caseId };
      return Panel_rebuildCasePanel(String(target.getRange('G2').getValue() || ''),
        { sheetName: target.getName(), caseId: String(caseId) });
    },
    // 案件IDからパネルを引いて ▶ を押したのと同じ enqueue をする (ラベル文字列の完全一致に頼らない検証用)
    '_debug_panelEnqueueByCase': function (caseId, featureLabel) {
      const ms = SpreadsheetApp.openById(_PANEL_MASTER_SS);
      const resolution = _JobQueue_loadResolution(ms);
      const target = ms.getSheets().filter(function (sheet) {
        try { return _Panel_isMarker(String(sheet.getRange('G1').getValue())); } catch (e) { return false; }
      }).filter(function (sheet) {
        const label = String(sheet.getRange('G2').getValue() || '');
        return _JobQueue_resolveCase(label, resolution).caseId === String(caseId);
      })[0];
      if (!target) return { error: 'パネルなし: ' + caseId };
      return Panel_simulateCheck(String(featureLabel), String(target.getRange('G2').getValue() || ''));
    },
    // 結果セルが本当にクリック可能になっているかの read-back verify 用 (表示文字とリンク先を返す)
    '_debug_panelResultCell': function (eventLabel, row) {
      const ms = SpreadsheetApp.openById(_PANEL_MASTER_SS);
      let p = null;
      if (/^C\d+$/.test(String(eventLabel))) {
        // 案件ID指定 (ラベル文字列の完全一致に頼らない)
        const resolution = _JobQueue_loadResolution(ms);
        p = ms.getSheets().filter(function (sheet) {
          try { return _Panel_isMarker(String(sheet.getRange('G1').getValue())); } catch (e) { return false; }
        }).filter(function (sheet) {
          return _JobQueue_resolveCase(String(sheet.getRange('G2').getValue() || ''), resolution).caseId === String(eventLabel);
        })[0] || null;
      } else {
        p = _Panel_findByLabel(ms, eventLabel);
      }
      if (!p) return { error: 'パネルなし: ' + eventLabel };
      const rows = row ? [Number(row)] : [];
      if (!rows.length) for (let r = 6; r <= p.getLastRow(); r++) rows.push(r);
      return {
        sheet: p.getName(),
        cells: rows.map(function (r) {
          const rich = p.getRange(r, 4).getRichTextValue();
          const runs = rich ? rich.getRuns() : [];
          return {
            row: r,
            feature: String(p.getRange(r, 2).getValue() || ''),
            text: String(p.getRange(r, 4).getDisplayValue() || ''),
            formula: String(p.getRange(r, 4).getFormula() || ''),
            links: runs.map(function (run) { return { text: run.getText(), url: run.getLinkUrl() }; })
              .filter(function (x) { return x.url; }),
            status: String(p.getRange(r, 6).getDisplayValue() || '')
          };
        })
      };
    },
    // 任意セル範囲のリッチテキストのリンクURLを読む。
    // _debug_panelResultCell は D 列固定なので、F 列の ⏳ リンク等を検証できない。
    '_debug_cellLinks': function (ssId, gid, a1Range) {
      const ss = SpreadsheetApp.openById(String(ssId));
      const sheet = ss.getSheets().filter(function (s2) { return s2.getSheetId() === Number(gid); })[0];
      if (!sheet) return { error: 'シートなし: gid=' + gid };
      const range = sheet.getRange(String(a1Range));
      const rich = range.getRichTextValues();
      const out = [];
      rich.forEach(function (rowValues, r) {
        rowValues.forEach(function (cell, c) {
          const links = (cell ? cell.getRuns() : []).map(function (run) {
            return { text: run.getText(), url: run.getLinkUrl() };
          }).filter(function (x) { return x.url; });
          if (links.length) out.push({ row: range.getRow() + r, col: range.getColumn() + c, links: links });
        });
      });
      return { sheetName: sheet.getName(), gid: sheet.getSheetId(), a1Range: String(a1Range), cells: out };
    },
    'Panel_simulateCheck': function (f, e) { return Panel_simulateCheck(f, e); },
    'Azukari_refreshRegistry': function (caseId) { return Azukari_refreshRegistry(caseId); },
    // 読み取り専用: 手配物生成に実際に渡っている顧客コンテキストを語で検査する
    '_debug_contextGrep': function (caseId, words) {
      const c = CaseList_getById(caseId);
      if (!c) return { error: 'case not found: ' + caseId };
      const list = String(words || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
      const out = {};
      function scan(label, text) {
        const t = String(text || '');
        const hits = {};
        list.forEach(function (w) {
          const i = t.indexOf(w);
          hits[w] = i < 0 ? null : t.slice(Math.max(0, i - 60), i + 80);
        });
        out[label] = { chars: t.length, hits: hits, head: t.slice(0, 300), tail: t.slice(-300) };
      }
      // 1) 案件一覧 T列 に保存済みの顧客コンテキスト
      let stored = '';
      try {
        const sh = SpreadsheetApp.getActive().getSheetByName(CASE_LIST_SHEET_NAME);
        stored = String(sh.getRange(c.rowIndex, 20).getValue() || '');
      } catch (e) { stored = 'ERROR: ' + e; }
      scan('storedT', stored);
      // 2) 生成時に実際に使われる Case_loadClientContext の戻り値
      try {
        CacheService.getScriptCache().remove('clictx_' + c.caseId);
      } catch (e) {}
      scan('liveContext', Case_loadClientContext(c) || '');
      // 3) zissi 議事録シート
      try {
        const zissi = SpreadsheetApp.openById(c.zissiId);
        const ms = zissi.getSheetByName('議事録');
        if (ms) {
          const lr = Math.min(ms.getLastRow(), 400);
          const lc = Math.min(ms.getLastColumn(), 20);
          scan('zissiGijiroku', lr > 0 ? ms.getRange(1, 1, lr, lc).getDisplayValues().map(function (r) { return r.join(' '); }).join(String.fromCharCode(10)) : '');
        } else { out.zissiGijiroku = { error: '議事録シートなし' }; }
      } catch (e) { out.zissiGijiroku = { error: String(e) }; }
      return out;
    },
    // 読み取り専用: 任意シートの先頭行レイアウトを確認する調査用コマンド
    '_debug_sheetLayout': function (ssId, sheetName, rows) {
      const ss = SpreadsheetApp.openById(ssId);
      const names = ss.getSheets().map(function (s) { return s.getName(); });
      const sh = sheetName ? ss.getSheetByName(sheetName) : null;
      if (!sh) return { sheetNames: names, found: false };
      const n = Math.min(Number(rows) || 6, 20);
      const lastCol = sh.getLastColumn();
      const vals = sh.getRange(1, 1, Math.min(n, sh.getLastRow() || 1), lastCol).getDisplayValues();
      return {
        sheetNames: names, sheetName: sh.getName(), sheetId: sh.getSheetId(),
        lastRow: sh.getLastRow(), lastColumn: lastCol,
        af1: String(sh.getRange('AF1').getDisplayValue()),
        head: vals
      };
    },
    // 読み取り専用: ClaudeClient の添付変換ロジックを単体で確認する (Slides/Docs → PDF)
    '_debug_attachProbe': function (fileId) {
      const file = DriveApp.getFileById(fileId);
      const fileMimeType = file.getMimeType();
      let blob = file.getBlob();
      let converted = false;
      if (blob.getContentType() !== 'application/pdf') {
        if (fileMimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
          blob = CaseMaterials_pptxToPdf(fileId);
          if (!blob) return { name: file.getName(), fileMimeType: fileMimeType, attachable: false, reason: 'pptx conversion failed' };
          converted = true;
        } else if (fileMimeType === 'application/vnd.google-apps.presentation' ||
            fileMimeType === 'application/vnd.google-apps.document') {
          blob = file.getAs('application/pdf');
          converted = true;
        } else {
          return { name: file.getName(), fileMimeType: fileMimeType, attachable: false, reason: 'unsupported mimeType' };
        }
      }
      return {
        name: file.getName(), fileMimeType: fileMimeType, converted: converted,
        blobContentType: blob.getContentType(), bytes: blob.getBytes().length, attachable: true
      };
    },
    '_debug_caseMaterials': function (caseId) {
      const c = CaseList_getById(caseId);
      if (!c) return { error: 'not found' };
      const selected = Case_collectCaseMaterials(c);
      function view(x) {
        return {
          label: x.label || '', kind: x.kind || '', bytes: x.bytes || 0,
          updated: x.lastUpdated ? Utilities.formatDate(new Date(x.lastUpdated), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss') : '',
          folderPath: x.folderPath || '', reason: x.reason || ''
        };
      }
      return { caseId: caseId, selected: selected.map(view), excluded: Case_collectCaseMaterials_lastSkipped.map(view) };
    },
    '_debug_findDesignDocs': function (caseId) {
      const c = CaseList_getById(caseId);
      if (!c) return { error: 'not found' };
      return _Phase2_findDesignDocs(c).map(function (d) {
        return { label: d.label, updated: d.lastUpdated ? Utilities.formatDate(new Date(d.lastUpdated), 'Asia/Tokyo', 'MM/dd HH:mm') : '' };
      });
    },
    'Feedback_submitFromPanel': function () { return Feedback_submitFromPanel(); },
    'Feedback_notifyExternal': function (payload) { return Feedback_notifyExternal(payload); },
    '_debug_feedbackLog': function (limit) { return _debug_feedbackLog(limit); },
    '_test_feedbackPanelImage': function (panelName) { return _test_feedbackPanelImage(panelName); },
    '_debug_feedbackPanelImages': function (panelName) { return _debug_feedbackPanelImages(panelName); },
    '_admin_clearPanelImages': function (panelName) { return _admin_clearPanelImages(panelName); },
    'Admin_setFeedbackRelay': function (url, secret, appName, formUrl) { return Admin_setFeedbackRelay(url, secret, appName, formUrl); },
    'FeedbackRelay_ping': function () { return FeedbackRelay_ping(); },
    'Admin_setFeedbackDiscord': function (botToken, dmUserId) { return Admin_setFeedbackDiscord(botToken, dmUserId); },
    'FeedbackRelay_nagPending': function (opts) { return FeedbackRelay_nagPending(opts || {}); },
    'FeedbackRelay_installNagTrigger': function () { return FeedbackRelay_installNagTrigger(); },
    'FeedbackRelay_testDm': function () { return FeedbackRelay_testDm(); },
    'Phase2_ConstructionPlan_generate': function (caseId) { return Phase2_ConstructionPlan_generate(caseId); },
    'Phase2_ConstructionPlan_callFable5': function (caseId, attachPdfs) { return Phase2_ConstructionPlan_callFable5(caseId, attachPdfs); },
    'Phase2_Fable5_ping': function () { return Phase2_Fable5_ping(); },
    'Phase2_ConstructionPlan_callFable5_setup': function (caseId, useOpus) { return Phase2_ConstructionPlan_callFable5_setup(caseId, useOpus); },
    'Phase2_ConstructionPlan_callFable5_teardown': function (caseId, useOpus) { return Phase2_ConstructionPlan_callFable5_teardown(caseId, useOpus); },
    'Phase2_ConstructionPlan_buildFromParts': function (caseId, setupId, teardownId) { return Phase2_ConstructionPlan_buildFromParts(caseId, setupId, teardownId); },
    'Phase2_ConstructionPlan_buildFromJson': function (caseId, jsonFileId) { return Phase2_ConstructionPlan_buildFromJson(caseId, jsonFileId); },
    'Phase2_VolumeCalc_estimateTrucks': function (caseId) { return Phase2_VolumeCalc_estimateTrucks(caseId); },
    'Phase5_Qna_ask': function (caseId, question) { return Phase5_Qna_ask(caseId, question); },
    '_debug_qnaContext': function (caseId, question) { return _debug_qnaContext(caseId, question); },
    'Phase2_EstimateRevision_generate': function (caseId, fb) { return Phase2_EstimateRevision_generate(caseId, fb); },
    'Phase2_DesignRevision_generate': function (caseId, fb) { return Phase2_DesignRevision_generate(caseId, fb); },
    'Phase4_FinalCheckRevision_generate': function (caseId, fb) { return Phase4_FinalCheckRevision_generate(caseId, fb); },
    'Phase6_PostReport_generate': function (caseId) { return Phase6_PostReport_generate(caseId); },
    'Phase6_ImprovementBrief_generate': function (caseId) { return Phase6_ImprovementBrief_generate(caseId); },
    'Phase6_FinalEstimate_generate': function (caseId) { return Phase6_FinalEstimate_generate(caseId); },
    'Phase6_StaffEval_generate': function (caseId) { return Phase6_StaffEval_generate(caseId); },
    'BulkImportFromTaskMgmt_run': function (opts) { return BulkImportFromTaskMgmt_run(opts); },
    'BulkImportFromTaskMgmt_setupDailyTrigger': function () { return BulkImportFromTaskMgmt_setupDailyTrigger(); },
    'MasterSync_pullProgress': function () { return MasterSync_pullProgress(); },
    'MasterSync_setupDailyTrigger': function () { return MasterSync_setupDailyTrigger(); },
    'MasterWriteBack_recordArtifact': function (caseId, type, title, url, note) { return MasterWriteBack_recordArtifact(caseId, type, title, url, note); },
    'MasterWriteBack_dedupe': function () { return MasterWriteBack_dedupe(); },
    'CaseList_ensureSchema': function () { return CaseList_ensureSchema(); },
    'CaseList_setMasterInfo': function (caseId, masterSsId, masterCol) { return CaseList_setMasterInfo(caseId, masterSsId, masterCol); },
    'ClaudeClient_pingTest': function () { return ClaudeClient_pingTest(); },
    'ManualLoader_freshnessCheck': function () { return ManualLoader_freshnessCheck(); },
    '_debug_listSheets': function (caseId) {
      const c = CaseList_getById(caseId);
      if (!c || !c.zissiId) return { error: 'no zissiId for ' + caseId };
      const ss = SpreadsheetApp.openById(c.zissiId);
      const sheets = ss.getSheets();
      return {
        zissiName: ss.getName(),
        zissiUrl: ss.getUrl(),
        sheetCount: sheets.length,
        sheets: sheets.map(function (s) {
          return {
            name: s.getName(),
            gid: s.getSheetId(),
            hidden: s.isSheetHidden(),
            lastRow: s.getLastRow(),
            lastCol: s.getLastColumn()
          };
        })
      };
    },
    '_debug_readExternalSheet': function (ssId, gid, a1Range) {
      // 外部 spreadsheet の任意 gid シート / 任意 range を読む
      const ss = SpreadsheetApp.openById(ssId);
      const sheets = ss.getSheets();
      let target = null;
      sheets.forEach(function (s) { if (s.getSheetId() === gid) target = s; });
      if (!target) return { error: 'gid not found', sheets: sheets.map(function (s) { return { name: s.getName(), gid: s.getSheetId() }; }) };
      const range = target.getRange(a1Range);
      return {
        sheetName: target.getName(),
        gid: target.getSheetId(),
        a1Range: a1Range,
        lastRow: target.getLastRow(),
        lastCol: target.getLastColumn(),
        values: range.getValues(),
        formulas: range.getFormulas()
      };
    },
    '_debug_readCells': function (caseId, sheetName, a1Range) {
      const c = CaseList_getById(caseId);
      if (!c || !c.zissiId) return { error: 'no zissiId for ' + caseId };
      const ss = SpreadsheetApp.openById(c.zissiId);
      const sheet = ss.getSheetByName(sheetName);
      if (!sheet) return { error: 'sheet not found: ' + sheetName, availableSheets: ss.getSheets().map(function (s) { return s.getName(); }) };
      const range = sheet.getRange(a1Range);
      return {
        sheetName: sheetName,
        sheetGid: sheet.getSheetId(),
        a1Range: a1Range,
        values: range.getValues(),
        formulas: range.getFormulas()
      };
    },
    '_debug_e2eUploadChain': function (caseId, sourcePdfId) {
      // フルチェーン Layer 1 テスト:
      //   1) sourcePdfId から bytes を取り出し (≒ 7 MB)
      //   2) base64 encode して frontend が送るペイロード相当を生成
      //   3) bound script Upload_saveToAzukari と同じ処理:
      //      a) 預かり素材 folder lookup (recursive depth=3)
      //      b) Utilities.base64Decode → newBlob → createFile
      //   4) 保存ファイルを read-back: size 一致, MIME 一致, 先頭/末尾 4 byte 一致
      const c = CaseList_getById(caseId);
      if (!c || !c.zissiId) return { error: 'no zissi' };
      // 元 PDF 読み込み
      const srcFile = DriveApp.getFileById(sourcePdfId);
      const srcBlob = srcFile.getBlob();
      const srcBytes = srcBlob.getBytes();
      const srcSize = srcBytes.length;
      const srcMime = srcBlob.getContentType();
      // base64 化 (frontend 想定のペイロード)
      const t1 = new Date().getTime();
      const b64 = Utilities.base64Encode(srcBytes);
      const t2 = new Date().getTime();
      // base64 decode (backend 想定)
      const decoded = Utilities.base64Decode(b64);
      const t3 = new Date().getTime();
      if (decoded.length !== srcSize) {
        return { error: 'base64 roundtrip size mismatch', srcSize: srcSize, decodedSize: decoded.length };
      }
      // 本番と同じ共通 resolver で預かり素材を解決
      const azukariId = Azukari_resolveFolderId(c, { create: false, noCache: true });
      if (!azukariId) return { error: 'azukari not found' };
      // createFile
      const testName = '__e2etest_' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMddHHmmss') + '.pdf';
      const newBlob = Utilities.newBlob(decoded, srcMime, testName);
      const folder = DriveApp.getFolderById(azukariId);
      const t4 = new Date().getTime();
      const file = folder.createFile(newBlob);
      const t5 = new Date().getTime();
      // read-back
      const created = DriveApp.getFileById(file.getId());
      const readBackBlob = created.getBlob();
      const readBackBytes = readBackBlob.getBytes();
      const sizeMatch = readBackBytes.length === srcSize;
      // 先頭/末尾 4 byte 比較
      function head4(arr) { return [arr[0], arr[1], arr[2], arr[3]].join(','); }
      function tail4(arr) {
        const n = arr.length;
        return [arr[n - 4], arr[n - 3], arr[n - 2], arr[n - 1]].join(',');
      }
      const headMatch = head4(srcBytes) === head4(readBackBytes);
      const tailMatch = tail4(srcBytes) === tail4(readBackBytes);
      return {
        ok: sizeMatch && headMatch && tailMatch,
        srcSize: srcSize,
        readBackSize: readBackBytes.length,
        sizeMatch: sizeMatch,
        headBytesMatch: headMatch,
        tailBytesMatch: tailMatch,
        createdFileId: file.getId(),
        createdFileName: file.getName(),
        azukariId: azukariId,
        timings_ms: {
          base64Encode: t2 - t1,
          base64Decode: t3 - t2,
          createFile: t5 - t4
        }
      };
    },
    '_debug_testAzukariCreateFile': function (caseId) {
      // bound script Upload_saveToAzukari の folder lookup + createFile を同等再現テスト
      const c = CaseList_getById(caseId);
      if (!c || !c.zissiId) return { error: 'no zissi' };
      const azukariId = Azukari_resolveFolderId(c, { create: false, noCache: true });
      if (!azukariId) return { error: '預かり素材 folder not found' };
      // テスト用に小ファイルを書き込み (text/plain で 1 KB 弱)
      const folder = DriveApp.getFolderById(azukariId);
      const testName = '__test_upload_' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMddHHmmss') + '.txt';
      const file = folder.createFile(Utilities.newBlob('hello from app debug — folder lookup + createFile worked.', 'text/plain', testName));
      // read-back
      const created = DriveApp.getFileById(file.getId());
      const readBackName = created.getName();
      return {
        azukariId: azukariId,
        azukariName: folder.getName(),
        createdFileId: file.getId(),
        createdFileName: file.getName(),
        readBackName: readBackName,
        ok: readBackName === testName
      };
    },
    '_debug_listProjectSubfolders': function (caseId) {
      const c = CaseList_getById(caseId);
      if (!c) return { error: 'no case' };
      const projectFolderId = Case_resolveProjectRoot(c);
      if (!projectFolderId) return { error: 'no projectFolderId' };
      const detected = Azukari_findWorkRoot(projectFolderId);
      const workRoot = detected || { id: projectFolderId, name: DriveApp.getFolderById(projectFolderId).getName() };
      const workItems = _Azukari_collectFolders(workRoot.id, 2, '');
      let rootItems = _Azukari_collectFolders(projectFolderId, 3, workRoot.id !== projectFolderId ? workRoot.id : '');
      if (workRoot.id === projectFolderId) rootItems = rootItems.filter(function (item) { return item.depth > 2; });
      let candidates = _Azukari_scoreCandidates(workItems, workRoot.id, true, /預かり/)
        .concat(_Azukari_scoreCandidates(rootItems, workRoot.id, false, /預かり/));
      if (!candidates.length) {
        candidates = _Azukari_scoreCandidates(workItems, workRoot.id, true, /^\d*\s*素材(?:フォルダ)?\s*$/);
      }
      candidates.sort(_Azukari_oldestFirst);
      return {
        projectFolderId: projectFolderId,
        workRoot: workRoot,
        resolvedAzukariId: Azukari_resolveFolderId(c, { create: false, noCache: true }),
        candidates: candidates.map(function (item) {
          return { id: item.folder.getId(), name: item.folder.getName(), parent: item.parentId, score: item.score };
        })
      };
    },
    '_debug_simulateUploadAzukariLookup': function (caseId) {
      // 本番と同じ共通 resolver の動作と所要時間を返す
      const c = CaseList_getById(caseId);
      if (!c) return { error: 'no case' };
      const t0 = new Date().getTime();
      const rootId = Case_resolveProjectRoot(c);
      const workRoot = rootId ? (Azukari_findWorkRoot(rootId) || { id: rootId }) : null;
      const azukariId = Azukari_resolveFolderId(c, { create: false, noCache: true });
      return { caseId: caseId, rootId: rootId, workRoot: workRoot, azukariId: azukariId, totalMs: new Date().getTime() - t0 };
    },
    '_debug_simulateUploadListCases': function () {
      // bound script Upload.js の Upload_listCases ロジックを再現して、
      // 各 master col の hasZissi 状態 (修正後の fallback 反映) を返す。
      const MASTER_SS_ID = '1t6eMvbPIu17m7hbv6foJcvd-fXrJkZqrePb8P6njxGI';
      const ms = SpreadsheetApp.openById(MASTER_SS_ID);
      const sheet = ms.getSheetByName('task');
      if (!sheet) return { error: 'master task sheet not found' };
      const lastCol = sheet.getLastColumn();
      const valuesRange = sheet.getRange(1, 1, 6, lastCol);
      const values = valuesRange.getValues();
      const zissiRange = sheet.getRange(6, 1, 1, lastCol);
      const zissiRichTextRow = zissiRange.getRichTextValues()[0];
      const zissiFormulasRow = zissiRange.getFormulas()[0];

      // app 案件一覧 を参照 (bound script 側と同じく col K=zissiId, col N=masterCol)
      const masterColToCase = {};
      const appSheet = SpreadsheetApp.getActive().getSheetByName(CASE_LIST_SHEET_NAME);
      if (appSheet && appSheet.getLastRow() >= 2) {
        const appData = appSheet.getDataRange().getValues();
        for (let i = 1; i < appData.length; i++) {
          const mc = Number(appData[i][13]) || 0;
          if (mc) {
            masterColToCase[mc] = {
              caseId: String(appData[i][0] || ''),
              zissiId: String(appData[i][10] || '')
            };
          }
        }
      }

      const out = [];
      for (let i = 0; i < 21; i++) {
        const col1 = 13 + 3 * i;
        const c = col1 - 1;
        const clientName = String(values[0][c] || '').trim();
        const eventName = String(values[1][c] || '').trim();
        if (!clientName && !eventName) continue;
        let zissiUrl = '';
        const rich = zissiRichTextRow[c];
        if (rich) {
          zissiUrl = rich.getLinkUrl() || '';
          if (!zissiUrl) {
            const runs = rich.getRuns();
            for (let k = 0; k < runs.length; k++) {
              const u = runs[k].getLinkUrl();
              if (u) { zissiUrl = u; break; }
            }
          }
        }
        if (!zissiUrl) {
          const m = String(zissiFormulasRow[c] || '').match(/HYPERLINK\(\s*["']([^"']+)["']/i);
          if (m) zissiUrl = m[1];
        }
        const appEntry = masterColToCase[col1];
        const usedAppFallback = !zissiUrl && appEntry && appEntry.zissiId;
        if (usedAppFallback) {
          zissiUrl = 'https://docs.google.com/spreadsheets/d/' + appEntry.zissiId + '/edit';
        }
        out.push({
          masterCol: col1,
          caseId: (appEntry && appEntry.caseId) || '',
          clientName: clientName,
          eventName: eventName.slice(0, 40),
          hasZissi: !!zissiUrl,
          fallbackUsed: !!usedAppFallback
        });
      }
      const summary = {
        total: out.length,
        selectable: out.filter(function (x) { return x.hasZissi; }).length,
        unlinked: out.filter(function (x) { return !x.hasZissi; }).length,
        fallbackCount: out.filter(function (x) { return x.fallbackUsed; }).length
      };
      return { summary: summary, cases: out };
    },
    '_debug_findImagesInProject': function (caseId) {
      const c = CaseList_getById(caseId);
      if (!c) return { error: 'case not found' };
      const projRoot = Case_resolveProjectRoot(c);
      if (!projRoot) return { error: 'no project folder' };
      const out = [];
      function walk(folderId, depth, path) {
        if (depth > 5 || out.length > 200) return;
        let folder;
        try { folder = DriveApp.getFolderById(folderId); } catch (e) { return; }
        const files = folder.getFiles();
        while (files.hasNext()) {
          const f = files.next();
          const mt = f.getMimeType();
          const name = f.getName();
          // 画像 + pptx + パース系 PDF
          if (/^image\//.test(mt) ||
              mt === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
              mt === 'application/vnd.google-apps.presentation' ||
              (mt === 'application/pdf' && /パース|施工手順|設営|完成|イメージ|外観|内観|測定|実測|採寸|寸法|現調|下見|検証|寸法確認/.test(name))) {
            out.push({
              path: path + '/' + name,
              id: f.getId(),
              mimeType: mt,
              sizeMB: Math.round(f.getSize() / 1024 / 1024 * 10) / 10
            });
          }
        }
        const subs = folder.getFolders();
        while (subs.hasNext()) {
          const sub = subs.next();
          walk(sub.getId(), depth + 1, path + '/' + sub.getName());
        }
      }
      walk(projRoot, 0, '');
      return { count: out.length, files: out };
    },
    '_debug_walkProjectFolder': function (caseId) {
      const c = CaseList_getById(caseId);
      if (!c) return { error: 'case not found' };
      const projRoot = Case_resolveProjectRoot(c);
      if (!projRoot) return { error: 'no project folder' };
      const out = [];
      function walk(folderId, depth, path) {
        if (depth > 4 || out.length > 500) return;
        let folder;
        try { folder = DriveApp.getFolderById(folderId); } catch (e) { return; }
        const files = folder.getFiles();
        while (files.hasNext()) {
          const f = files.next();
          out.push({
            path: path + '/' + f.getName(),
            id: f.getId(),
            mimeType: f.getMimeType(),
            sizeMB: Math.round(f.getSize() / 1024 / 1024 * 10) / 10
          });
          if (out.length > 500) return;
        }
        const subs = folder.getFolders();
        while (subs.hasNext()) {
          const sub = subs.next();
          walk(sub.getId(), depth + 1, path + '/' + sub.getName());
        }
      }
      walk(projRoot, 0, '');
      // パース/perspective/イメージ/CG キーワードでフィルタしたもの と 全ファイル
      const persFilter = out.filter(function (f) {
        return /パース|perspective|イメージ|CG|外観|内観|完成|3D/i.test(f.path);
      });
      return { totalFiles: out.length, paasuLikeFiles: persFilter, allFiles: out.slice(0, 100) };
    },
    '_debug_inspectSlideImages': function (presentationId) {
      const pres = SlidesApp.openById(presentationId);
      const slides = pres.getSlides();
      const out = [];
      slides.forEach(function (s, i) {
        const images = s.getImages();
        const placeholders = s.getPlaceholders();
        let titleText = '';
        placeholders.forEach(function (ph) {
          try {
            const t = ph.getPlaceholderType();
            if (t === SlidesApp.PlaceholderType.TITLE || t === SlidesApp.PlaceholderType.CENTERED_TITLE) {
              titleText = ph.asShape().getText().asString().slice(0, 60);
            }
          } catch (e) {}
        });
        out.push({
          slideIndex: i, title: titleText.replace(/\n/g, ' '),
          imageCount: images.length
        });
      });
      const totalImages = out.reduce(function (a, b) { return a + b.imageCount; }, 0);
      return {
        presentationId: presentationId,
        slideCount: slides.length,
        totalImages: totalImages,
        slides: out
      };
    },
    '_debug_assertMilestones': function (caseId, expected) {
      // expected: [{row, col, contains}] のリスト
      const c = CaseList_getById(caseId);
      if (!c || !c.zissiId) return { error: 'no zissiId' };
      const ss = SpreadsheetApp.openById(c.zissiId);
      const sch = ss.getSheetByName('スケジュール');
      const results = expected.map(function (e) {
        const v = String(sch.getRange(e.row, e.col).getValue());
        return {
          row: e.row, col: e.col, expected_contains: e.contains,
          actual: v, ok: v.indexOf(e.contains) >= 0
        };
      });
      return { allOk: results.every(function (r) { return r.ok; }), results: results };
    },
    '_debug_restoreScheduleLabelsV2': function (caseId) {
      // V2: 同一 merge top-left への二重書き込みを排除 + 非数式セルを destroy しない recalc
      const c = CaseList_getById(caseId);
      if (!c || !c.zissiId) return { error: 'no zissiId for ' + caseId };
      const ss = SpreadsheetApp.openById(c.zissiId);
      const sch = ss.getSheetByName('スケジュール');
      if (!sch) return { error: 'スケジュール シートなし' };

      // すべての candidate を merge top-left key にまとめ、1 merge につき 1 write のみ採用。
      // priority: formula > label (formula が必要なセルはそちら優先)
      const candidates = [
        { cell: 'A1',  type: 'value',   payload: '　■制作スケジュール' },
        { cell: 'N1',  type: 'value',   payload: '開催日' },
        { cell: 'S1',  type: 'value',   payload: '開催日' },
        { cell: 'W1',  type: 'formula', payload: '=summary!D19' },
        { cell: 'X1',  type: 'value',   payload: '内容' },
        { cell: 'AC1', type: 'value',   payload: '内容' },
        { cell: 'AG1', type: 'formula', payload: '=summary!D5&"様 "&summary!D13' },
        { cell: 'BF1', type: 'value',   payload: '作成日' },
        { cell: 'BJ1', type: 'formula', payload: '=TODAY()' },
        { cell: 'BK1', type: 'value',   payload: '作成日' },
        { cell: 'BO1', type: 'formula', payload: '=TODAY()' },
        { cell: 'BT1', type: 'formula', payload: '=summary!D5&"様 "&summary!D13' },
        // row 6 ヘッダー
        { cell: 'A6',  type: 'value', payload: '日付' },
        { cell: 'F6',  type: 'value', payload: '内容' },
        { cell: 'S6',  type: 'value', payload: '日付' },
        { cell: 'X6',  type: 'value', payload: '内容' },
        { cell: 'AK6', type: 'value', payload: '日付' },
        { cell: 'AP6', type: 'value', payload: '内容' },
        { cell: 'BC6', type: 'value', payload: '日付' },
        { cell: 'BH6', type: 'value', payload: '内容' }
      ];

      // 各 candidate の merge top-left を求めて、key にまとめる
      const grouped = {}; // key=topLeftA1 → ordered list of {cell, type, payload}
      candidates.forEach(function (cand) {
        const range = sch.getRange(cand.cell);
        const merges = range.getMergedRanges();
        const writeTarget = merges.length > 0 ? merges[0] : range;
        // top-left の row/col
        const topRow = writeTarget.getRow();
        const topCol = writeTarget.getColumn();
        const key = topRow + ',' + topCol;
        if (!grouped[key]) {
          grouped[key] = { topLeft: writeTarget.getA1Notation(), candidates: [], targetRange: sch.getRange(topRow, topCol) };
        }
        grouped[key].candidates.push(cand);
      });

      // 各 group で 1 つ採用 (formula > value)
      const log = [];
      Object.keys(grouped).forEach(function (key) {
        const g = grouped[key];
        let chosen = g.candidates.find(function (c) { return c.type === 'formula'; });
        if (!chosen) chosen = g.candidates[0];
        if (chosen.type === 'formula') {
          g.targetRange.setFormula(chosen.payload);
        } else {
          g.targetRange.setValue(chosen.payload);
        }
        SpreadsheetApp.flush();
        const actual = chosen.type === 'formula' ? g.targetRange.getFormula() : String(g.targetRange.getValue());
        log.push({
          mergeTopLeft: g.topLeft,
          fromCandidates: g.candidates.map(function (c) { return c.cell + '(' + c.type + ')'; }).join(','),
          chosen: chosen.cell + '/' + chosen.type,
          payload: chosen.payload,
          actual: actual,
          ok: actual === chosen.payload
        });
      });

      // 数式キャッシュ強制再評価: 非数式セルを destroy しない (=空文字 setFormula を回避)
      const lastRow = sch.getLastRow();
      const lastCol = sch.getLastColumn();
      const formulas = sch.getRange(1, 1, lastRow, lastCol).getFormulas();
      let recalcCount = 0;
      for (let r = 0; r < lastRow; r++) {
        for (let cc = 0; cc < lastCol; cc++) {
          if (formulas[r][cc]) {
            try { sch.getRange(r + 1, cc + 1).setFormula(formulas[r][cc]); recalcCount++; } catch (e) {}
          }
        }
      }
      SpreadsheetApp.flush();

      // row 1 / row 6 を読み直して最終 verify
      const finalRow1 = sch.getRange('A1:BU1').getValues()[0];
      const finalRow6 = sch.getRange('A6:BU6').getValues()[0];
      const labelsFound = {
        制作スケジュール: finalRow1.indexOf('　■制作スケジュール') >= 0,
        開催日_count: finalRow1.filter(function (v) { return v === '開催日'; }).length,
        内容_count_row1: finalRow1.filter(function (v) { return v === '内容'; }).length,
        作成日_count: finalRow1.filter(function (v) { return v === '作成日'; }).length,
        日付_count_row6: finalRow6.filter(function (v) { return v === '日付'; }).length,
        内容_count_row6: finalRow6.filter(function (v) { return v === '内容'; }).length
      };

      const failed = log.filter(function (e) { return !e.ok; });
      return {
        caseId: caseId,
        writeOps: log.length,
        writeFailures: failed.length,
        recalcedFormulaCells: recalcCount,
        finalLabelsCheck: labelsFound,
        log: log
      };
    },
    '_debug_restoreScheduleLabelsReadBack': function (caseId) {
      // row 1 / row 6 のラベルを merge top-left に確実に書く + 書き込み後 read-back で verify。
      // setValue が silent ignore されるケース (merge non-top-left) を補正して再書込。
      const c = CaseList_getById(caseId);
      if (!c || !c.zissiId) return { error: 'no zissiId for ' + caseId };
      const ss = SpreadsheetApp.openById(c.zissiId);
      const sch = ss.getSheetByName('スケジュール');
      if (!sch) return { error: 'スケジュール シートなし' };

      // 試したい (cell, expected) ペア。 merge の場合は top-left に書き直す。
      const targets = [
        { cell: 'A1',  value: '　■制作スケジュール' },
        { cell: 'N1',  value: '開催日' },
        { cell: 'S1',  value: '開催日' },
        { cell: 'X1',  value: '内容' },
        { cell: 'AC1', value: '内容' },
        { cell: 'BF1', value: '作成日' },
        { cell: 'BK1', value: '作成日' },
        // row 6 ヘッダー
        { cell: 'A6',  value: '日付' },
        { cell: 'F6',  value: '内容' },
        { cell: 'S6',  value: '日付' },
        { cell: 'W6',  value: '日付' },
        { cell: 'X6',  value: '内容' },
        { cell: 'AB6', value: '内容' },
        { cell: 'AK6', value: '日付' },
        { cell: 'AP6', value: '内容' },
        { cell: 'AS6', value: '日付' },
        { cell: 'AX6', value: '内容' },
        { cell: 'BC6', value: '日付' },
        { cell: 'BH6', value: '内容' },
        { cell: 'BO6', value: '日付' },
        { cell: 'BT6', value: '内容' }
      ];

      const log = [];
      targets.forEach(function (t) {
        const range = sch.getRange(t.cell);
        // merge 範囲確認 → top-left に書く
        const merges = range.getMergedRanges();
        const writeTarget = merges.length > 0 ? merges[0] : range;
        writeTarget.setValue(t.value);
        SpreadsheetApp.flush();
        // read-back: writeTarget の left-top セル
        const wtA1 = writeTarget.getA1Notation();
        const readBack = writeTarget.getValue();
        log.push({
          requested: t.cell,
          writeTarget: wtA1,
          mergedTopLeft: merges.length > 0,
          expected: t.value,
          actual: String(readBack),
          ok: String(readBack) === t.value
        });
      });

      // 数式系も書き直し + read-back
      const formulaTargets = [
        { cell: 'BJ1', formula: '=TODAY()' },
        { cell: 'BO1', formula: '=TODAY()' },
        { cell: 'BT1', formula: '=summary!D5&"様 "&summary!D13' }
      ];
      formulaTargets.forEach(function (t) {
        const range = sch.getRange(t.cell);
        const merges = range.getMergedRanges();
        const writeTarget = merges.length > 0 ? merges[0] : range;
        writeTarget.setFormula(t.formula);
        SpreadsheetApp.flush();
        const wtA1 = writeTarget.getA1Notation();
        const readBack = writeTarget.getFormula();
        log.push({
          requested: t.cell,
          writeTarget: wtA1,
          mergedTopLeft: merges.length > 0,
          expectedFormula: t.formula,
          actualFormula: String(readBack),
          ok: String(readBack) === t.formula
        });
      });

      // 数式キャッシュ強制再評価
      const lastRow = sch.getLastRow();
      const lastCol = sch.getLastColumn();
      const formulas = sch.getRange(1, 1, lastRow, lastCol).getFormulas();
      sch.getRange(1, 1, lastRow, lastCol).setFormulas(formulas);
      SpreadsheetApp.flush();

      const failed = log.filter(function (e) { return !e.ok; });
      return {
        caseId: caseId,
        allOk: failed.length === 0,
        successCount: log.length - failed.length,
        failureCount: failed.length,
        log: log
      };
    },
    '_debug_rebuildScheduleFromTemplate': function (caseId) {
      // 既存「スケジュール」シートを削除し、テンプレ (1_zbmz8...) から copyTo で作り直す。
      // 内容列の ↓ 式 / 日付の自動算出も丸ごと復元される。
      const c = CaseList_getById(caseId);
      if (!c || !c.zissiId) return { error: 'no zissiId for ' + caseId };
      const ss = SpreadsheetApp.openById(c.zissiId);
      const TEMPLATE_SS_ID = '1_zbmz8LReBsLRynQ7oIxdyXEwzw7mMnnbULsQcAFfio';
      const TEMPLATE_GID = 1089324704;
      const TARGET_NAME = 'スケジュール';

      // 既存スケジュール削除
      let removed = false;
      const old = ss.getSheetByName(TARGET_NAME);
      if (old) {
        ss.deleteSheet(old);
        removed = true;
      }
      // テンプレからコピー
      const tmplSs = SpreadsheetApp.openById(TEMPLATE_SS_ID);
      const sheets = tmplSs.getSheets();
      let sourceSheet = null;
      for (let i = 0; i < sheets.length; i++) {
        if (sheets[i].getSheetId() === TEMPLATE_GID) { sourceSheet = sheets[i]; break; }
      }
      if (!sourceSheet) return { error: 'template schedule gid not found' };
      const newSheet = sourceSheet.copyTo(ss);
      newSheet.setName(TARGET_NAME);

      // row 1 ラベル復元
      try {
        newSheet.getRange('A1').setValue('　■制作スケジュール');
        newSheet.getRange('N1').setValue('開催日');
        newSheet.getRange('S1').setValue('開催日');
        newSheet.getRange('X1').setValue('内容');
        newSheet.getRange('AC1').setValue('内容');
        newSheet.getRange('BF1').setValue('作成日');
        newSheet.getRange('BK1').setValue('作成日');
        newSheet.getRange('BJ1').setFormula('=TODAY()');
        newSheet.getRange('BO1').setFormula('=TODAY()');
        newSheet.getRange('BT1').setFormula('=summary!D5&"様 "&summary!D13');
        ['R1', 'W1', 'BJ1', 'BO1'].forEach(function (a) {
          try { newSheet.getRange(a).setNumberFormat('yyyy/MM/dd'); } catch (e) {}
        });
        ['A6', 'W6', 'AS6', 'BO6', 'S6', 'AK6', 'BC6'].forEach(function (a) {
          try { newSheet.getRange(a).setValue('日付'); } catch (e) {}
        });
        ['F6', 'AB6', 'AX6', 'BT6', 'X6', 'AP6', 'BH6'].forEach(function (a) {
          try { newSheet.getRange(a).setValue('内容'); } catch (e) {}
        });
      } catch (e) {}

      // 数式キャッシュ強制再評価
      const lastRow = newSheet.getLastRow();
      const lastCol = newSheet.getLastColumn();
      const formulas = newSheet.getRange(1, 1, lastRow, lastCol).getFormulas();
      newSheet.getRange(1, 1, lastRow, lastCol).setFormulas(formulas);
      SpreadsheetApp.flush();

      return {
        ok: true, caseId: caseId,
        removedOldSchedule: removed,
        newSheetName: newSheet.getName(),
        newSheetGid: newSheet.getSheetId(),
        recalced: lastRow * lastCol
      };
    },
    '_debug_fillScheduleHeaders': function (caseId) {
      // Phase1_Schedule_generate を走らせていない zissi のスケジュールシート row 1 ラベルを補修。
      // テンプレ版 / コピー版 両系統に setValue するので、merge top-left でないセルは無害に無視される。
      const c = CaseList_getById(caseId);
      if (!c || !c.zissiId) return { error: 'no zissiId for ' + caseId };
      const ss = SpreadsheetApp.openById(c.zissiId);
      const sch = ss.getSheetByName('スケジュール');
      if (!sch) return { error: 'スケジュール シートなし' };
      try {
        sch.getRange('A1').setValue('　■制作スケジュール');
        sch.getRange('N1').setValue('開催日');
        sch.getRange('S1').setValue('開催日');
        sch.getRange('X1').setValue('内容');
        sch.getRange('AC1').setValue('内容');
        sch.getRange('BF1').setValue('作成日');
        sch.getRange('BK1').setValue('作成日');
        sch.getRange('BJ1').setFormula('=TODAY()');
        sch.getRange('BO1').setFormula('=TODAY()');
        sch.getRange('BT1').setFormula('=summary!D5&"様 "&summary!D13');
        ['R1', 'W1', 'BJ1', 'BO1'].forEach(function (a) {
          try { sch.getRange(a).setNumberFormat('yyyy/MM/dd'); } catch (e) {}
        });
        // row 6 ヘッダーも念のため復元
        ['A6', 'W6', 'AS6', 'BO6', 'S6', 'AK6', 'BC6'].forEach(function (a) {
          try { sch.getRange(a).setValue('日付'); } catch (e) {}
        });
        ['F6', 'AB6', 'AX6', 'BT6', 'X6', 'AP6', 'BH6'].forEach(function (a) {
          try { sch.getRange(a).setValue('内容'); } catch (e) {}
        });
        // 念のため数式再評価
        const lastRow = sch.getLastRow();
        const lastCol = sch.getLastColumn();
        const formulas = sch.getRange(1, 1, lastRow, lastCol).getFormulas();
        sch.getRange(1, 1, lastRow, lastCol).setFormulas(formulas);
        SpreadsheetApp.flush();
        return { ok: true, caseId: caseId, recalced: lastRow * lastCol };
      } catch (e) {
        return { error: e.toString() };
      }
    },
    '_debug_inspectScheduleDeps': function (caseId) {
      const c = CaseList_getById(caseId);
      if (!c || !c.zissiId) return { error: 'no zissiId for ' + caseId };
      const ss = SpreadsheetApp.openById(c.zissiId);
      const out = { caseId: caseId, zissiName: ss.getName(), zissiUrl: ss.getUrl() };
      const kikaku = ss.getSheetByName('企画');
      if (kikaku) {
        const v = kikaku.getRange('B30').getValue();
        out.kikakuB30 = { value: String(v), isDate: v instanceof Date, raw: v };
      } else {
        out.kikakuB30 = '(企画 シートなし)';
      }
      const summary = ss.getSheetByName('summary');
      if (summary) {
        out.summaryD5 = String(summary.getRange('D5').getValue());
        out.summaryD13 = String(summary.getRange('D13').getValue());
        const d19 = summary.getRange('D19').getValue();
        out.summaryD19 = { value: String(d19), isDate: d19 instanceof Date };
      } else {
        out.summary = '(summary シートなし)';
      }
      const sch = ss.getSheetByName('スケジュール');
      if (sch) {
        out.scheduleA7 = { value: String(sch.getRange('A7').getValue()), formula: sch.getRange('A7').getFormula() };
      }
      out.caseStartDate = String(c.startDate);
      out.caseEndDate = String(c.endDate);
      return out;
    },
    '_debug_fillKikakuDateAndRecalc': function (caseId, isoDate) {
      // ユーザー指定の出展日 (yyyy/MM/dd) を 企画!B30 + summary!D19 にセットして
      // スケジュール の数式を強制再評価する。bulk import で startDate が拾えなかったとき用。
      const c = CaseList_getById(caseId);
      if (!c || !c.zissiId) return { error: 'no zissiId for ' + caseId };
      const dt = new Date(String(isoDate).replace(/-/g, '/'));
      if (isNaN(dt.getTime())) return { error: 'invalid date: ' + isoDate };
      const ss = SpreadsheetApp.openById(c.zissiId);
      const kikaku = ss.getSheetByName('企画');
      if (kikaku) kikaku.getRange('B30').setValue(dt);
      const summary = ss.getSheetByName('summary');
      if (summary) {
        ['D19', 'I19', 'AV19'].forEach(function (a) { summary.getRange(a).setValue(dt); });
      }
      // スケジュール 数式を強制再評価
      const sch = ss.getSheetByName('スケジュール');
      let recalced = 0;
      if (sch) {
        const lastRow = sch.getLastRow();
        const lastCol = sch.getLastColumn();
        const formulas = sch.getRange(1, 1, lastRow, lastCol).getFormulas();
        sch.getRange(1, 1, lastRow, lastCol).setFormulas(formulas);
        SpreadsheetApp.flush();
        recalced = formulas.length * (formulas[0] || []).length;
      }
      // case list の startDate も更新
      try {
        const sheet = SpreadsheetApp.getActive().getSheetByName(CASE_LIST_SHEET_NAME);
        if (sheet) {
          const lastRow = sheet.getLastRow();
          const data = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
          for (let i = 0; i < data.length; i++) {
            if (String(data[i][0]) === caseId) {
              sheet.getRange(i + 2, 4).setValue(Utilities.formatDate(dt, 'Asia/Tokyo', 'yyyy/MM/dd'));
              break;
            }
          }
        }
      } catch (e) {}
      return {
        ok: true, caseId: caseId,
        kikakuB30Written: Utilities.formatDate(dt, 'Asia/Tokyo', 'yyyy/MM/dd'),
        summaryD19Written: Utilities.formatDate(dt, 'Asia/Tokyo', 'yyyy/MM/dd'),
        scheduleFormulasRecalced: recalced
      };
    },
    '_debug_inspectKessanMaster': function () {
      // 案件一覧マスター (14RC6...) の構造調査 (gid=849096576)
      const ss = SpreadsheetApp.openById('14RC6og1ma_I3LGHwCVwswKArgHwCOPxWlPB3g8adaYY');
      const sheets = ss.getSheets();
      let sheet = null;
      const allSheetNames = [];
      for (let i = 0; i < sheets.length; i++) {
        allSheetNames.push({ name: sheets[i].getName(), gid: sheets[i].getSheetId() });
        if (sheets[i].getSheetId() === 849096576) sheet = sheets[i];
      }
      if (!sheet) return { error: 'gid 849096576 not found', sheets: allSheetNames };
      const lastRow = sheet.getLastRow();
      const lastCol = sheet.getLastColumn();
      // header の手がかりとして 1〜5 行目を取得
      const headerArea = sheet.getRange(1, 1, Math.min(5, lastRow), Math.min(10, lastCol)).getValues();
      // 末尾 3 行
      const tailStart = Math.max(1, lastRow - 2);
      const tailArea = sheet.getRange(tailStart, 1, lastRow - tailStart + 1, Math.min(10, lastCol)).getValues();
      // 該当しそうな行を探す: col C contains 'PDR' or 'マークスライフ' or 'トラストスタジオ'
      const searchKeys = ['PDR', 'マークスライフ', 'トラストスタジオ'];
      const dataC = sheet.getRange(1, 3, lastRow, 1).getValues();
      const matches = [];
      for (let i = 0; i < dataC.length; i++) {
        const cv = String(dataC[i][0] || '');
        if (searchKeys.some(function (k) { return cv.indexOf(k) >= 0; })) {
          const row = sheet.getRange(i + 1, 1, 1, Math.min(10, lastCol)).getValues()[0];
          matches.push({ row: i + 1, values: row });
        }
      }
      return {
        sheetName: sheet.getName(),
        lastRow: lastRow, lastCol: lastCol,
        headerArea: headerArea,
        tailArea: tailArea,
        matchesFromColC: matches.slice(0, 30)
      };
    },
    '_debug_inspectMasterRow6': function (colsOpt) {
      // master の指定列 row 6 を直接調べる
      const ss = SpreadsheetApp.openById('1t6eMvbPIu17m7hbv6foJcvd-fXrJkZqrePb8P6njxGI');
      const sheet = ss.getSheets()[0];
      const cols = (colsOpt && colsOpt.length) ? colsOpt : [22, 64, 70];
      const out = [];
      cols.forEach(function (c) {
        const cell = sheet.getRange(6, c);
        const value = cell.getValue();
        const formula = cell.getFormula();
        const rich = cell.getRichTextValue();
        const linkUrl = rich ? rich.getLinkUrl() : null;
        let runs = [];
        if (rich) {
          const r = rich.getRuns();
          for (let i = 0; i < r.length; i++) {
            runs.push({ text: r[i].getText(), linkUrl: r[i].getLinkUrl() });
          }
        }
        out.push({
          col: c, a1: sheet.getRange(6, c).getA1Notation(),
          value: String(value), formula: formula,
          richLinkUrl: linkUrl, runs: runs
        });
      });
      return out;
    },
    '_debug_findSheetRefs': function (ssId, needle) {
      // 全シートの数式を走査して needle (シート名など) を参照している箇所を返す
      const ss = SpreadsheetApp.openById(ssId);
      const hits = [];
      ss.getSheets().forEach(function (s) {
        const lastRow = s.getLastRow();
        const lastCol = s.getLastColumn();
        if (!lastRow || !lastCol) return;
        const formulas = s.getRange(1, 1, lastRow, lastCol).getFormulas();
        for (let r = 0; r < formulas.length; r++) {
          for (let c = 0; c < formulas[r].length; c++) {
            const f = formulas[r][c];
            if (f && f.indexOf(needle) >= 0) {
              hits.push({ sheet: s.getName(), a1: s.getRange(r + 1, c + 1).getA1Notation(), formula: f });
              if (hits.length > 300) return;
            }
          }
        }
      });
      return { ssName: ss.getName(), needle: needle, hitCount: hits.length, hits: hits };
    },
    '_debug_listSheetsBySs': function (ssId) {
      const ss = SpreadsheetApp.openById(ssId);
      const sheets = ss.getSheets();
      return {
        zissiName: ss.getName(),
        sheetCount: sheets.length,
        sheets: sheets.map(function (s) {
          return { name: s.getName(), gid: s.getSheetId(), hidden: s.isSheetHidden(), lastRow: s.getLastRow(), lastCol: s.getLastColumn() };
        })
      };
    },
    '_debug_writeAndRead': function (ssId, sheetName, a1Cell, formulaToWrite) {
      // テスト用: a1Cell に formula を書いて、すぐ評価値と数式を読み戻す
      const ss = SpreadsheetApp.openById(ssId);
      const sheet = ss.getSheetByName(sheetName);
      if (!sheet) return { error: 'sheet not found: ' + sheetName };
      const cell = sheet.getRange(a1Cell);
      const before = { value: cell.getValue(), formula: cell.getFormula() };
      cell.setFormula(formulaToWrite);
      SpreadsheetApp.flush();
      const after = { value: cell.getValue(), formula: cell.getFormula() };
      return { sheetName: sheetName, a1Cell: a1Cell, wrote: formulaToWrite, before: before, after: after };
    },
    '_debug_forceRecalc': function (ssId, sheetName, a1Cell) {
      // セルを clear → 同じ formula を再設定 → 再評価
      const ss = SpreadsheetApp.openById(ssId);
      const sheet = ss.getSheetByName(sheetName);
      if (!sheet) return { error: 'sheet not found: ' + sheetName };
      const cell = sheet.getRange(a1Cell);
      const origFormula = cell.getFormula();
      const origValue = cell.getValue();
      if (!origFormula) return { error: 'cell has no formula', value: origValue };
      cell.clear({ contentsOnly: true });
      SpreadsheetApp.flush();
      cell.setFormula(origFormula);
      SpreadsheetApp.flush();
      return {
        a1Cell: a1Cell,
        origFormula: origFormula,
        origValue: origValue,
        newValue: cell.getValue(),
        newFormula: cell.getFormula()
      };
    },
    '_debug_listMerges': function (ssId, sheetName, a1Range) {
      const ss = SpreadsheetApp.openById(ssId);
      const sheet = ss.getSheetByName(sheetName);
      if (!sheet) return { error: 'sheet not found: ' + sheetName };
      const range = sheet.getRange(a1Range);
      const merges = range.getMergedRanges();
      return {
        a1Range: a1Range,
        mergeCount: merges.length,
        merges: merges.map(function (m) { return m.getA1Notation(); })
      };
    },
    // 全案件パネルの 3 行目 (ラベル / 案件名 / 結合状態) をシート名に依存せず一括で読む。
    // レイアウト変更後の read-back verify 用 (シート名は絵文字入りで手打ち一致が難しい)
    // 全パネルに 🛒 入力欄と ⏳ ブロックが行き渡ったかを1回で確かめる (展開漏れの検出用)。
    /**
     * 任意シートの指定列の右に列を挿入して値を書く (一回限りのデータ投入用)。
     * 誤爆防止: expect = {a1, value} が一致しないと何も書かない。既存列は上書きせず「挿入」する。
     * @param {string} ssId
     * @param {string} sheetName
     * @param {number} afterCol 何列目の右に挿入するか (1=A)
     * @param {Array<Array<*>>} block 書き込む2次元配列 (startRow から下へ)
     * @param {number} startRow 書き込み開始行 (1 始まり)
     * @param {{a1:string, value:string}} expect 事前確認するセルとその値
     */
    '_admin_insertColumnsWithValues': function (ssId, sheetName, afterCol, block, startRow, expect) {
      const ss = SpreadsheetApp.openById(ssId);
      const sheet = ss.getSheetByName(sheetName);
      if (!sheet) return { ok: false, error: 'sheet not found: ' + sheetName, availableSheets: ss.getSheets().map(function (s) { return s.getName(); }) };
      if (!expect || !expect.a1) return { ok: false, error: 'expect {a1,value} は必須です (誤爆防止)' };
      const actual = String(sheet.getRange(expect.a1).getDisplayValue() || '');
      if (actual !== String(expect.value)) {
        return { ok: false, error: 'expect 不一致のため中止', a1: expect.a1, expected: String(expect.value), actual: actual };
      }
      if (!Array.isArray(block) || !block.length || !Array.isArray(block[0])) return { ok: false, error: 'block が2次元配列ではありません' };
      const width = block[0].length;
      for (let i = 0; i < block.length; i++) {
        if (block[i].length !== width) return { ok: false, error: 'block の行ごとに列数が違います (row ' + i + ')' };
      }
      sheet.insertColumnsAfter(Number(afterCol), width);
      const target = sheet.getRange(Number(startRow), Number(afterCol) + 1, block.length, width);
      target.setValues(block);
      SpreadsheetApp.flush();
      return {
        ok: true,
        sheetName: sheetName,
        insertedAfterCol: Number(afterCol),
        width: width,
        wroteRange: target.getA1Notation(),
        readBack: sheet.getRange(Number(startRow), Number(afterCol) + 1, Math.min(block.length, 3), width).getDisplayValues()
      };
    },
    // 案件情報行と アサイン依頼 の外部リンク解決を、書き込みなしで確かめる (読み取り専用)
    '_debug_caseLinks': function (caseId) {
      const c = CaseList_getById(caseId);
      if (!c) return { error: 'case not found: ' + caseId };
      let artifactEstimate = '';
      try { artifactEstimate = MasterWriteBack_findArtifactUrl(caseId, '見積'); } catch (e) {}
      let folderEstimate = '';
      try { folderEstimate = _Panel_findEstimateInFolder(c); } catch (e) { folderEstimate = 'ERROR: ' + e; }
      let proposal = '';
      try { proposal = _AssignSheet_findProposalUrl(c); } catch (e) { proposal = 'ERROR: ' + e; }
      let projectRoot = '';
      try { projectRoot = Case_resolveProjectRoot(c); } catch (e) {}
      return {
        caseId: caseId,
        projectRoot: projectRoot,
        zissiId: c.zissiId || '',
        estimateFromArtifactSheet: artifactEstimate,
        estimateFromFolderScan: folderEstimate,
        proposalUrl: proposal
      };
    },
    '_debug_panelSectionsAll': function () {
      const ss = SpreadsheetApp.openById(_PANEL_MASTER_SS);
      const rows = [];
      ss.getSheets().forEach(function (sheet) {
        let marker = '';
        try { marker = String(sheet.getRange('G1').getValue()); } catch (e) { return; }
        if (!_Panel_isMarker(marker)) return;
        const lastRow = sheet.getLastRow();
        const colA = lastRow >= 1 ? sheet.getRange(1, 1, lastRow, 1).getDisplayValues() : [];
        const colG = lastRow >= 1 ? sheet.getRange(1, 7, lastRow, 1).getDisplayValues() : [];
        rows.push({
          name: sheet.getName(),
          caseId: String(sheet.getRange('G4').getValue() || ''),
          builtAt: String(sheet.getRange('G5').getDisplayValue() || ''),
          purchaseRow: colA.reduce(function (acc, r, i) { return acc || (String(r[0] || '').indexOf(PANEL_PURCHASE_TITLE_PREFIX) === 0 ? i + 1 : 0); }, 0),
          pendingRow: colG.reduce(function (acc, r, i) { return acc || (String(r[0] || '') === PANEL_PENDING_MARKER ? i + 1 : 0); }, 0),
          pendingTitle: colA.reduce(function (acc, r) { return acc || (String(r[0] || '').indexOf(PANEL_PENDING_TITLE) === 0 ? String(r[0]) : ''); }, '')
        });
      });
      return {
        panels: rows.length,
        missingPurchase: rows.filter(function (r) { return !r.purchaseRow; }).map(function (r) { return r.name; }),
        missingPending: rows.filter(function (r) { return !r.pendingRow; }).map(function (r) { return r.name; }),
        rows: rows
      };
    },
    // G4 の caseId が空で label も master に無い孤立パネルの復旧用。
    // 名前の一部で引いて caseId を明示して作り直す (_debug_panelRebuildByCase は
    // label→caseId が解決できないこの状態では使えない)。
    '_debug_panelRebuildByNameFragment': function (fragment, caseId) {
      const ms = SpreadsheetApp.openById(_PANEL_MASTER_SS);
      const needle = String(fragment || '');
      if (!needle) throw new Error('fragment が空です');
      const target = ms.getSheets().filter(function (sheet) {
        try { return _Panel_isMarker(String(sheet.getRange('G1').getValue())); } catch (e) { return false; }
      }).filter(function (sheet) { return sheet.getName().indexOf(needle) >= 0; });
      if (target.length !== 1) {
        return { error: '一意に決まりません: ' + target.length + '件', names: target.map(function (s) { return s.getName(); }) };
      }
      const sheet = target[0];
      const label = String(sheet.getRange('G2').getValue() || '');
      const result = Panel_rebuildCasePanel(label, { sheetName: sheet.getName(), caseId: String(caseId || '') });
      result.caseIdAfter = String(sheet.getRange('G4').getValue() || '');
      return result;
    },
    '_debug_panelRow3All': function () {
      const ss = SpreadsheetApp.openById(_PANEL_MASTER_SS);
      const out = [];
      ss.getSheets().forEach(function (sheet) {
        let marker = '';
        try { marker = String(sheet.getRange('G1').getValue()); } catch (e) { return; }
        if (!_Panel_isMarker(marker)) return;
        const row = sheet.getRange('A3:F3');
        out.push({
          name: sheet.getName(),
          gid: sheet.getSheetId(),
          values: row.getValues()[0].map(function (v) { return String(v); }),
          merges: row.getMergedRanges().map(function (m) { return m.getA1Notation(); }),
          eventCell: _Panel_eventCell(sheet).getA1Notation(),
          eventCellValue: String(_Panel_eventCell(sheet).getValue()),
          hasDropdown: Boolean(_Panel_eventCell(sheet).getDataValidation()),
          appLinkFormula: String(sheet.getRange('D6:D30').getFormulas().reduce(function (acc, r) {
            return acc || (r[0] && r[0].indexOf('HYPERLINK') >= 0 ? r[0] : '');
          }, ''))
        });
      });
      return { panels: out.length, rows: out };
    },
    '_debug_readCellsBySs': function (ssId, sheetName, a1Range) {
      const ss = SpreadsheetApp.openById(ssId);
      const sheet = ss.getSheetByName(sheetName);
      if (!sheet) return { error: 'sheet not found: ' + sheetName, availableSheets: ss.getSheets().map(function (s) { return s.getName(); }) };
      const range = sheet.getRange(a1Range);
      return {
        sheetName: sheetName,
        sheetGid: sheet.getSheetId(),
        a1Range: a1Range,
        values: range.getValues(),
        formulas: range.getFormulas()
      };
    },
    'Checklist_seedIfEmpty': function () { return Checklist_seedIfEmpty(); },
    'Checklist_seedMerge': function () { return Checklist_seedMerge(); },
    'Checklist_adminTokenInfo': function () { return Checklist_adminTokenInfo(); },
    'Checklist_getUrls': function () { return Checklist_getUrls(); },
    'Checklist_bootstrap': function () { return Checklist_bootstrap(); },
    'Checklist_getItems': function (role, day) { return Checklist_getItems(role, day); },
    'Checklist_getCaseLinks': function (caseId, role) { return Checklist_getCaseLinks(caseId, role); },
    'Checklist_adminProgressSummary': function (token, caseId) { return Checklist_adminProgressSummary(token, caseId); }
  };
}

function listFailureCounters() {
  const properties = PropertiesService.getScriptProperties().getProperties();
  const result = { autoProcess: [], digest: [] };
  const prefixes = [
    { key: 'AUTOPROC_FAIL_', target: result.autoProcess },
    { key: 'DIGEST_FAIL_', target: result.digest }
  ];

  Object.keys(properties).forEach(function (key) {
    const prefix = prefixes.find(function (item) { return key.indexOf(item.key) === 0; });
    if (!prefix) return;

    const caseId = key.slice(prefix.key.length);
    let fail = {};
    try { fail = JSON.parse(properties[key] || '{}'); } catch (e) {}
    const n = Number(fail.n) || 0;
    const lastMs = Number(fail.lastMs) || 0;
    const item = {
      caseId: caseId,
      n: n,
      lastMs: lastMs,
      lastAt: lastMs ? new Date(lastMs).toISOString() : null,
      blocked: n >= 5,
      clientName: null,
      caseName: null
    };
    try {
      const c = CaseList_getById(caseId);
      if (c) {
        item.clientName = c.clientName || null;
        item.caseName = c.caseName || null;
      }
    } catch (e) {}
    prefix.target.push(item);
  });

  return result;
}

function _resetFailureCounters(prefix, caseId) {
  const props = PropertiesService.getScriptProperties();
  const requestedCaseId = String(caseId || '').trim();
  const cleared = [];
  if (requestedCaseId) {
    props.deleteProperty(prefix + requestedCaseId);
    cleared.push(requestedCaseId);
    return { cleared: cleared };
  }

  Object.keys(props.getProperties()).forEach(function (key) {
    if (key.indexOf(prefix) !== 0) return;
    props.deleteProperty(key);
    cleared.push(key.slice(prefix.length));
  });
  return { cleared: cleared };
}

function resetAutoProcessFailures(caseId) {
  return _resetFailureCounters('AUTOPROC_FAIL_', caseId);
}

function resetDigestFailures(caseId) {
  return _resetFailureCounters('DIGEST_FAIL_', caseId);
}

/** CLOCK 型トリガーをハンドラ単位で整理する。既定は削除予定だけを返す dry-run。 */
function _admin_dedupeTriggers(opts) {
  opts = opts || {};
  const dryRun = opts.dryRun !== false;
  const handlerFilter = Array.isArray(opts.handlers) ? opts.handlers.reduce(function (map, handler) {
    map[String(handler)] = true;
    return map;
  }, Object.create(null)) : null;
  const triggers = ScriptApp.getProjectTriggers();
  const grouped = Object.create(null);

  triggers.forEach(function (trigger) {
    if (trigger.getEventType() !== ScriptApp.EventType.CLOCK) return;
    const handler = trigger.getHandlerFunction();
    if (handlerFilter && !handlerFilter[handler]) return;
    if (!grouped[handler]) grouped[handler] = [];
    grouped[handler].push(trigger);
  });

  const targets = [];
  const kept = {};
  Object.keys(grouped).forEach(function (handler) {
    const duplicates = grouped[handler];
    if (duplicates.length < 2) return;
    kept[handler] = 1;
    duplicates.slice(1).forEach(function (trigger) {
      if (targets.length >= 10) return;
      targets.push({ trigger: trigger, handler: handler, uniqueId: trigger.getUniqueId() });
    });
  });

  if (!dryRun) {
    targets.forEach(function (target) { ScriptApp.deleteTrigger(target.trigger); });
  }
  return {
    ok: true,
    dryRun: dryRun,
    before: triggers.length,
    deleted: targets.map(function (target) {
      return { handler: target.handler, uniqueId: target.uniqueId };
    }),
    kept: kept,
    after: triggers.length - targets.length
  };
}

/** タイムスタンプを照合し、アサイン依頼シートの誤登録行を安全に削除する。 */
function _admin_deleteAssignRows(rowNums, expectTsPrefix) {
  if (!Array.isArray(rowNums)) throw new Error('rowNums は行番号の配列で指定してください');
  if (rowNums.length > 5) throw new Error('一度に削除できるのは5件までです');
  const prefix = String(expectTsPrefix || '').trim();
  if (!prefix) throw new Error('expectTsPrefix は必須です');

  const rows = rowNums.map(function (row) {
    const number = Number(row);
    if (!isFinite(number) || number % 1 !== 0 || number < 1) throw new Error('不正な行番号です: ' + row);
    return number;
  }).sort(function (a, b) { return b - a; });
  const sheet = SpreadsheetApp.openById('1a3VlFzkuH8jMJZhIPZPekWfdpJ7NgPo5p3fQqHelzmU').getSheetByName('マスター');
  if (!sheet) throw new Error('アサイン依頼シート「マスター」が見つかりません');
  const deleted = [];
  const skipped = [];

  rows.forEach(function (row) {
    if (row > sheet.getLastRow()) {
      skipped.push({ row: row, ts: '', reason: '行番号が最終行を超えています' });
      return;
    }
    const values = sheet.getRange(row, 1, 1, 3).getDisplayValues()[0];
    const ts = String(values[0] || '');
    if (ts.indexOf(prefix) !== 0) {
      skipped.push({ row: row, ts: ts, reason: 'タイムスタンプが指定の接頭辞と一致しません' });
      return;
    }
    const maxRowsBefore = sheet.getMaxRows();
    sheet.deleteRow(row);
    SpreadsheetApp.flush();
    if (sheet.getMaxRows() !== maxRowsBefore - 1) throw new Error('行削除の read-back verify に失敗しました: ' + row);
    deleted.push({ row: row, ts: ts, requester: String(values[1] || ''), type: String(values[2] || '') });
  });

  return { ok: true, deleted: deleted, skipped: skipped, lastRowAfter: sheet.getLastRow() };
}

function _DupRow_isDominated(keepValue, dropValue) {
  if (dropValue === '' || dropValue === null || typeof dropValue === 'undefined' || dropValue === 0) return true;

  function timestamp(value) {
    if (value instanceof Date) {
      return isNaN(value.getTime()) ? null : value.getTime();
    }
    if (typeof value !== 'string') return null;
    if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2}))?$/.test(value)) return null;
    const parsed = Date.parse(value);
    return isNaN(parsed) ? null : parsed;
  }

  const keepTime = timestamp(keepValue);
  const dropTime = timestamp(dropValue);
  if (keepTime !== null && dropTime !== null && dropTime < keepTime) return true;
  if (typeof keepValue === 'number' && typeof dropValue === 'number' && dropValue === 0) return true;
  return false;
}

function DuplicateCaseRow_plan(headers, rows, keep, opts) {
  headers = headers || [];
  rows = rows || [];
  opts = opts || {};
  keep = keep === 'last' ? 'last' : 'first';
  if (rows.length !== 2) {
    return { error: '対象が2行ではない', rows: rows, diffColumns: [], mergedColumns: [], skippedColumns: [], dominatedColumns: [], blockingColumns: [], orphanFolderId: '' };
  }

  const keepRow = keep === 'last' ? rows[1] : rows[0];
  const dropRow = keep === 'last' ? rows[0] : rows[1];
  const keepValues = keepRow.values || [];
  const dropValues = dropRow.values || [];
  const width = Math.max(headers.length, keepValues.length, dropValues.length);
  const diffColumns = [];
  const mergedColumns = [];
  const skippedColumns = [];
  const dominatedColumns = [];
  const blockingColumns = [];
  let orphanFolderId = '';

  function empty(value) { return value === '' || value === null || typeof value === 'undefined'; }
  function same(a, b) {
    if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
    return a === b;
  }

  for (let i = 0; i < width; i++) {
    const keepValue = keepValues[i];
    const dropValue = dropValues[i];
    if (same(keepValue, dropValue)) continue;
    const header = String(headers[i] || '');
    const diff = { col: i + 1, header: header, keepValue: keepValue, dropValue: dropValue };
    diffColumns.push(diff);
    if (header === 'Drive フォルダID' && !empty(dropValue) && !same(keepValue, dropValue)) {
      orphanFolderId = String(dropValue);
      if (String(opts.acceptOrphanFolderId || '') === orphanFolderId) {
        skippedColumns.push({ col: i + 1, header: header, reason: '明示承認された孤児フォルダIDのため' });
      } else {
        blockingColumns.push(diff);
      }
    } else if ((header === '残タスク' || header === '顧客コンテキスト') && (empty(keepValue) || empty(dropValue))) {
      skippedColumns.push({ col: i + 1, header: header, reason: header === '残タスク' ? 'MasterSync が更新する列のため' : '巨大文字列のため' });
    } else if (empty(keepValue) && !empty(dropValue)) {
      mergedColumns.push(diff);
    } else if (_DupRow_isDominated(keepValue, dropValue)) {
      dominatedColumns.push(diff);
    } else {
      blockingColumns.push(diff);
    }
  }

  return {
    error: blockingColumns.length ? '手動確認が必要' : '',
    keepRow: keepRow.rowNumber,
    dropRow: dropRow.rowNumber,
    diffColumns: diffColumns,
    mergedColumns: mergedColumns,
    skippedColumns: skippedColumns,
    dominatedColumns: dominatedColumns,
    blockingColumns: blockingColumns,
    orphanFolderId: orphanFolderId,
    note: orphanFolderId ? 'このフォルダは孤児として残る。棚卸しは別途' : ''
  };
}

function _admin_deleteDuplicateCaseRow(caseId, opts) {
  opts = opts || {};
  const dryRun = opts.dryRun !== false;
  const keep = opts.keep === 'last' ? 'last' : 'first';
  const sheet = SpreadsheetApp.getActive().getSheetByName(CASE_LIST_SHEET_NAME);
  if (!sheet) throw new Error('案件一覧シートが存在しません');
  const values = sheet.getDataRange().getValues();
  const headers = values.length ? values[0] : [];
  const needle = String(caseId || '').trim();
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0] || '').trim() === needle) rows.push({ rowNumber: i + 1, values: values[i] });
  }
  const plan = DuplicateCaseRow_plan(headers, rows, keep, opts);
  plan.caseId = needle;
  plan.dryRun = dryRun;
  plan.afterCount = rows.length;
  if (plan.error || dryRun) return plan;

  plan.mergedColumns.forEach(function (item) {
    sheet.getRange(plan.keepRow, item.col).setValue(item.dropValue);
  });
  sheet.deleteRow(plan.dropRow);
  SpreadsheetApp.flush();
  plan.afterCount = CaseList_listAll().filter(function (item) {
    return String(item.caseId || '').trim() === needle;
  }).length;
  if (plan.afterCount !== 1) plan.error = '削除後の確認に失敗';
  return plan;
}

/** master タスク進捗管理表の担当制作プロデューサーを安全に一括置換する。 */
function _admin_replaceMasterProducers(oldNames, newName, opts) {
  if (!Array.isArray(oldNames) || oldNames.length === 0) {
    throw new Error('oldNames は空でない氏名の配列で指定してください');
  }
  const replacement = String(newName || '').trim();
  if (!replacement) throw new Error('newName は必須です');

  const normalizeName = function (name) {
    return String(name || '').replace(/[\s　]+/g, '');
  };
  const oldNameMap = {};
  oldNames.forEach(function (name) {
    const normalized = normalizeName(name);
    if (!normalized) throw new Error('oldNames に空の氏名を含めることはできません');
    oldNameMap[normalized] = true;
  });

  const dryRun = Boolean(opts && opts.dryRun === true);
  const ss = SpreadsheetApp.openById('1t6eMvbPIu17m7hbv6foJcvd-fXrJkZqrePb8P6njxGI');
  const sheet = ss.getSheetByName('task');
  if (!sheet) throw new Error('master タスク進捗管理表の「task」シートが見つかりません');

  const lastCol = sheet.getLastColumn();
  const width = Math.max(0, lastCol - 13 + 1);
  const clients = width ? sheet.getRange(1, 13, 1, width).getValues()[0] : [];
  const events = width ? sheet.getRange(2, 13, 1, width).getValues()[0] : [];
  const producers = width ? sheet.getRange(8, 13, 1, width).getValues()[0] : [];
  const changes = [];
  let scannedBlocks = 0;
  let untouched = 0;

  for (let bs = 13; bs + 2 <= lastCol; bs += 3) {
    const idx = bs - 13;
    const eventName = String(events[idx] || '');
    if (!eventName.trim()) continue;
    scannedBlocks++;

    const before = String(producers[idx] || '');
    const prefixMatch = before.match(/^(制作P[：:])/);
    const prefix = prefixMatch ? prefixMatch[1] : '';
    const producerName = prefix ? before.slice(prefix.length) : before;
    if (!oldNameMap[normalizeName(producerName)]) {
      untouched++;
      continue;
    }
    changes.push({
      col: bs,
      clientName: String(clients[idx] || ''),
      eventName: eventName,
      before: before,
      after: prefix + replacement
    });
  }

  if (changes.length > 50) throw new Error('一度に置換できるのは50セルまでです: ' + changes.length);

  const failed = [];
  if (!dryRun && changes.length > 0) {
    changes.forEach(function (change) {
      sheet.getRange(8, change.col).setValue(change.after);
    });
    SpreadsheetApp.flush();

    const readBack = sheet.getRange(8, 13, 1, width).getValues()[0];
    changes.forEach(function (change) {
      const actual = String(readBack[change.col - 13] || '');
      if (actual !== change.after) {
        failed.push({ col: change.col, expected: change.after, actual: actual });
      }
    });
  }

  return {
    ok: true,
    dryRun: dryRun,
    scannedBlocks: scannedBlocks,
    changes: changes,
    failed: failed,
    untouched: untouched
  };
}

/**
 * UI を使わないトリガー整備。コマンドキュー経由 (Claude 側) から叩けるので
 * 「メニューから setupCommandQueue を押してください」という手作業を残さないための入口。
 * 既存トリガーは handlerFunction 名で判定し、同名を二重作成しない。削除は一切しない。
 */
function Admin_installTriggers() {
  const handlers = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  const created = [];
  function ensureMinutely(name) {
    if (handlers.indexOf(name) >= 0) return;
    ScriptApp.newTrigger(name).timeBased().everyMinutes(1).create();
    created.push(name);
  }
  ensureMinutely('processCommandQueue');
  ensureMinutely('JobQueue_worker1');
  ensureMinutely('JobQueue_worker2');
  if (handlers.indexOf('EventShipping_relayWarehouseNotice') < 0) {
    ScriptApp.newTrigger('EventShipping_relayWarehouseNotice').timeBased().everyMinutes(10).create();
    created.push('EventShipping_relayWarehouseNotice');
  }
  if (handlers.indexOf('TaskLedger_pollChecked') < 0) {
    ScriptApp.newTrigger('TaskLedger_pollChecked').timeBased().everyMinutes(10).create();
    created.push('TaskLedger_pollChecked');
  }
  if (handlers.indexOf('TaskLedger_autoRunNightly') < 0) {
    ScriptApp.newTrigger('TaskLedger_autoRunNightly').timeBased().atHour(22).nearMinute(0).everyDays(1).create();
    created.push('TaskLedger_autoRunNightly');
  }
  if (handlers.indexOf('TaskLedger_syncAllNightly') < 0) {
    ScriptApp.newTrigger('TaskLedger_syncAllNightly').timeBased().atHour(21).nearMinute(0).everyDays(1).create();
    created.push('TaskLedger_syncAllNightly');
  }
  if (handlers.indexOf('TaskLedger_rebuildRollup') < 0) {
    ScriptApp.newTrigger('TaskLedger_rebuildRollup').timeBased().atHour(5).nearMinute(30).everyDays(1).create();
    created.push('TaskLedger_rebuildRollup');
  }
  if (handlers.indexOf('JobQueue_housekeep') < 0) {
    ScriptApp.newTrigger('JobQueue_housekeep').timeBased().atHour(3).nearMinute(40).everyDays(1).create();
    created.push('JobQueue_housekeep');
  }
  if (handlers.indexOf('Panel_backfillResultLinksNightly') < 0) {
    ScriptApp.newTrigger('Panel_backfillResultLinksNightly').timeBased().atHour(4).nearMinute(10).everyDays(1).create();
    created.push('Panel_backfillResultLinksNightly');
  }
  return { created: created, existing: handlers };
}

/**
 * 初回 1 クリック実行用。OAuth 同意 + 1 分トリガー作成。
 * すでにトリガー存在時はスキップ。
 */
function setupCommandQueue() {
  const ui = SpreadsheetApp.getUi();
  const triggers = ScriptApp.getProjectTriggers();
  const handlers = triggers.map(function (t) { return t.getHandlerFunction(); });
  if (handlers.indexOf('processCommandQueue') < 0) ScriptApp.newTrigger('processCommandQueue').timeBased().everyMinutes(1).create();
  if (handlers.indexOf('JobQueue_worker1') < 0) ScriptApp.newTrigger('JobQueue_worker1').timeBased().everyMinutes(1).create();
  if (handlers.indexOf('JobQueue_worker2') < 0) ScriptApp.newTrigger('JobQueue_worker2').timeBased().everyMinutes(1).create();
  if (handlers.indexOf('JobQueue_housekeep') < 0) ScriptApp.newTrigger('JobQueue_housekeep').timeBased().atHour(3).nearMinute(40).everyDays(1).create();
  // 動作確認のため即時 1 回実行
  processCommandQueue();
  ui.alert('コマンドキュー初期化完了。\n\n1分ごとに ' + CMD_FOLDER_ID + ' フォルダの cmd_*.json を拾って実行します。\n以降は Claude 側で自動操作可能。');
}

/**
 * トリガー or 手動実行用。cmd_*.json を全部読んで実行 → result_*.txt を書き戻し → cmd_*.json は trash。
 *
 * 重複実行防止:
 *   - LockService で並走トリガー shutout (tryLock 0ms = 既走中なら即座に return)
 *   - 各 cmd は 読み込み直後に trash → 次のトリガーが同じファイルを拾わない
 */
/**
 * master タスク進捗管理表 の「🚀実行パネル」を処理。
 * F列 (状態) が「⏳実行待ち | <イベントラベル>」の行を実行し、
 * D=結果リンク / E=実行日時 / F=状態 を同じ行に書き戻す。
 * master 側は simple onEdit で状態を書くだけ (追加権限なし)。 実行はここ (booth・認可済み)。
 */
function _MasterQueue_poll() {
  const MASTER_SS = '1t6eMvbPIu17m7hbv6foJcvd-fXrJkZqrePb8P6njxGI';
  const PANEL = '🚀実行パネル';
  const FIRST_ROW = 6;
  let ms;
  try { ms = SpreadsheetApp.openById(MASTER_SS); } catch (e) { return; }
  const p = ms.getSheetByName(PANEL);
  if (!p) return;
  const lastRow = p.getLastRow();
  if (lastRow < FIRST_ROW) return;
  // A..H (H=argsJSON)
  const data = p.getRange(FIRST_ROW, 1, lastRow - FIRST_ROW + 1, 9).getValues();

  // イベントラベル → blockStart の対応を master task シートから構築 (master 側 _eventList と同一ロジック)
  const task = ms.getSheetByName('task');
  const labelToBlock = {};
  let blockInfo = {}; // blockStart -> {client, event} (現在の物理位置の生値)
  if (task) {
    const taskLastCol = task.getLastColumn();
    const width = Math.max(3, taskLastCol - 13 + 1);
    const clients = task.getRange(1, 13, 1, width).getValues()[0];
    const events = task.getRange(2, 13, 1, width).getValues()[0];
    for (let bs = 13; bs + 2 <= taskLastCol; bs += 3) {
      const idx = bs - 13;
      const ev = String(events[idx] || '').replace(/\s+/g, ' ').trim();
      const cl = String(clients[idx] || '').replace(/\s+/g, ' ').trim();
      if (!ev) continue;
      labelToBlock[(cl ? cl + ' / ' : '') + ev.slice(0, 40)] = bs;
      blockInfo[bs] = { client: cl, event: ev };
    }
  }

  // パネルの案件名セル (新: C3 / 旧: B3) のイベントプルダウンをイベント一覧の変化に追従させる
  // (シート右側に新イベントが追加されても再設置なしで選べるように)
  try {
    const labels = Object.keys(labelToBlock);
    const b3 = _Panel_eventCell(p);
    const rule = b3.getDataValidation();
    const current = (rule && rule.getCriteriaValues && rule.getCriteriaValues()[0]) || [];
    const currentList = Array.isArray(current) ? current.map(String) : [];
    if (labels.length > 0 && labels.join('') !== currentList.join('')) {
      b3.setDataValidation(SpreadsheetApp.newDataValidation()
        .requireValueInList(labels, true).setAllowInvalid(false).build());
    }
  } catch (e) { /* dropdown refresh は best-effort */ }

  // 実行待ち行が無ければここまで (毎分呼ばれるので軽く)
  const hasPending = data.some(function (r) { return String(r[5] || '').indexOf('⏳実行待ち') === 0; });
  if (!hasPending) return;

  const commands = _cmdQueue_commands();

  // caseId 逆引き用に案件一覧を一度だけ読む
  let appSheet = null;
  let caseIdByBlock = {};
  let appRows = []; // master 連携済みの案件行 (名前照合用)
  function _reloadCaseResolutionData() {
    blockInfo = {};
    if (task) {
      const taskLastCol = task.getLastColumn();
      const width = Math.max(3, taskLastCol - 13 + 1);
      const clients = task.getRange(1, 13, 1, width).getValues()[0];
      const events = task.getRange(2, 13, 1, width).getValues()[0];
      for (let bs = 13; bs + 2 <= taskLastCol; bs += 3) {
        const idx = bs - 13;
        const ev = String(events[idx] || '').replace(/\s+/g, ' ').trim();
        const cl = String(clients[idx] || '').replace(/\s+/g, ' ').trim();
        if (ev) blockInfo[bs] = { client: cl, event: ev };
      }
    }
    appSheet = SpreadsheetApp.getActive().getSheetByName(CASE_LIST_SHEET_NAME);
    const appData = appSheet ? appSheet.getDataRange().getValues() : [];
    caseIdByBlock = {};
    appRows = [];
    for (let i = 1; i < appData.length; i++) {
      if (String(appData[i][12]) !== MASTER_SS) continue;
      caseIdByBlock[Number(appData[i][13])] = String(appData[i][0]);
      appRows.push({
        rowNum: i + 1,
        caseId: String(appData[i][0]),
        client: String(appData[i][1] || ''),
        caseName: String(appData[i][2] || ''),
        masterCol: Number(appData[i][13]) || 0
      });
    }
  }
  _reloadCaseResolutionData();

  // 案件解決: 「現在の物理列の 社名+イベント名」で名前照合 (task シートの列増減に耐える)。
  // 2026-08-16 事故: 列削除で全イベントが左にズレ、保存済み masterCol が別案件を指して
  // グリーンエナジー選択で Trip.com が生成された。名前照合を一次、masterCol を最後の砦にする。
  function _resolveCaseAtBlock(blockStart) {
    const label = Object.keys(labelToBlock).filter(function (key) { return labelToBlock[key] === blockStart; })[0] || '';
    return _JobQueue_resolveCase(label, {
      labelToBlock: labelToBlock, blockInfo: blockInfo, appSheet: appSheet,
      appRows: appRows, caseIdByBlock: caseIdByBlock
    }).caseId || null;
  }

  let autoSyncAttempted = false;
  for (let i = 0; i < data.length; i++) {
    const status = String(data[i][5] || '');
    if (status.indexOf('⏳実行待ち') !== 0) continue;
    const rowNum = FIRST_ROW + i;
    const eventLabel = status.split('|').slice(1).join('|').trim();
    const command = String(data[i][6] || '');
    let args = [];
    try { args = JSON.parse(data[i][7] || '[]'); } catch (e) { args = []; }
    const noCase = String(data[i][8] || '') === '1';

    const nowStr = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'MM/dd HH:mm');
    const panelLayout = PanelLinks_resolveLayout(p);
    if (!command) {
      p.getRange(rowNum, panelLayout.statusCol).setValue('📋 メニュー/リンクから利用');
      continue;
    }
    if (noCase) {
      // 案件不要コマンド (同期系): caseId 解決をスキップして直接実行
      if (!commands[command]) {
        PanelLinks_writePanelOutcome(p, rowNum, '', nowStr, '❌ 不明な機能: ' + command, []);
        continue;
      }
      p.getRange(rowNum, panelLayout.statusCol).setValue('🔄実行中…');
      SpreadsheetApp.flush();
      try {
        const noCaseRet = commands[command].apply(null, args);
        const noCaseLinks = PanelLinks_collect(noCaseRet);
        PanelLinks_writePanelOutcome(p, rowNum, noCaseRet && noCaseRet.panelResult ? String(noCaseRet.panelResult).slice(0, 200) : '完了', nowStr, noCaseRet && noCaseRet.panelStatus ? String(noCaseRet.panelStatus) : '✅ 完了', noCaseLinks);
      } catch (err2) {
        PanelLinks_writePanelOutcome(p, rowNum, '', nowStr, '❌ ' + String(err2).slice(0, 200), []);
      }
      continue;
    }
    const blockStart = labelToBlock[eventLabel];
    if (!blockStart) {
      PanelLinks_writePanelOutcome(p, rowNum, '', nowStr, '❌ イベント特定失敗: ' + eventLabel.slice(0, 30), []);
      continue;
    }
    let caseId = _resolveCaseAtBlock(blockStart);
    if (!caseId && !autoSyncAttempted) {
      autoSyncAttempted = true;
      p.getRange(rowNum, panelLayout.statusCol).setValue('⏳ 新イベントを自動同期中…');
      SpreadsheetApp.flush();
      try { BulkImportFromTaskMgmt_run({}); } catch (e) {}
      _reloadCaseResolutionData();
      caseId = _resolveCaseAtBlock(blockStart);
    }
    if (!caseId) {
      PanelLinks_writePanelOutcome(p, rowNum, '', nowStr, '❌ 案件未同期: 自動同期を試みましたが見つかりません。task シートのイベント列(クライアント名/展示会名)を確認してください', []);
      continue;
    }
    if (!commands[command]) {
      PanelLinks_writePanelOutcome(p, rowNum, '', nowStr, '❌ 不明な機能: ' + command, []);
      continue;
    }
    // 実行中マーク (二重実行防止)
    p.getRange(rowNum, panelLayout.statusCol).setValue('🔄実行中… (' + eventLabel.slice(0, 20) + ')');
    SpreadsheetApp.flush();
    try {
      const ret = commands[command].apply(null, [caseId].concat(args));
      // skipped は真偽値の規約 (配列を返すコマンドがあるため === true。JobQueue.js と同じ)
      if (ret && ret.skipped === true) {
        // 冪等ガード等でスキップされた場合は理由をそのまま見せる
        PanelLinks_writePanelOutcome(p, rowNum, '⚠ ' + String(ret.reason || 'スキップされました').slice(0, 200), nowStr, '⚠ スキップ', []);
        continue;
      }
      // 拾えるキーを列挙で持つと漏れる (JobQueue.js と同じ PanelLinks_collect に寄せる)
      const links = PanelLinks_collect(ret);
      let resultText = '';
      let resultLinks = links;
      if (links.length) {
        resultText = (ret && ret.panelResult) ? String(ret.panelResult).slice(0, 200) : '';
      } else if (ret && ret.panelResult) {
        resultText = String(ret.panelResult).slice(0, 200);
      } else {
        const artifactSheetUrl = MasterWriteBack_artifactSheetUrl(caseId);
        const zissiLinks = PanelLinks_zissiOutputLinks(caseId, command);
        const fallback = PanelLinks_completionFallback(artifactSheetUrl, zissiLinks);
        resultText = fallback.text;
        resultLinks = fallback.links;
      }
      const panelStatus = ret && ret.panelStatus ? String(ret.panelStatus) : '✅ 完了';
      PanelLinks_writePanelOutcome(p, rowNum, resultText, nowStr, panelStatus, resultLinks);
    } catch (err) {
      PanelLinks_writePanelOutcome(p, rowNum, '', nowStr, '❌ ' + String(err).slice(0, 200), []);
    }
  }
}

function processCommandQueue() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    console.log('processCommandQueue: another invocation is running, skip');
    return;
  }
  try {
    const folder = DriveApp.getFolderById(CMD_FOLDER_ID);
    _cmdQueue_recoverStale(folder);
    _cmdQueue_maybeHousekeep();
    const files = folder.getFiles();
    const commands = _cmdQueue_commands();
    while (files.hasNext()) {
      const f = files.next();
      const name = f.getName();
      if (name.indexOf('cmd_') !== 0) continue;
      const uniq = _cmdQueue_uniqFromName(name);
      if (uniq === null) continue;
      let payload = null;
      let parseErr = null;
      try {
        payload = JSON.parse(f.getBlob().getDataAsString());
      } catch (e) {
        parseErr = e.toString();
      }
      const startedAt = Utilities.formatDate(new Date(), 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ssXXX");
      let runningMarker = null;
      try {
        runningMarker = folder.createFile(_cmdQueue_markerName('running', uniq), JSON.stringify({
          state: 'running',
          command: payload && payload.command !== undefined ? payload.command : null,
          args: payload && payload.args !== undefined ? payload.args : null,
          startedAt: startedAt
        }), MimeType.PLAIN_TEXT);
      } catch (e) {
        console.warn('command queue running marker create failed (' + uniq + '): ' + e);
      }
      // マーカー作成後に trash（ロックが切れた異常終了も次回起動で検出可能にする）
      try { f.setTrashed(true); } catch (e) { /* skip */ }
      let result = null;
      if (parseErr) {
        result = { ok: false, error: 'invalid cmd JSON: ' + parseErr };
      } else if (!payload || !payload.command) {
        result = { ok: false, error: 'missing command field' };
      } else if (!commands[payload.command]) {
        result = { ok: false, error: 'unknown command: ' + payload.command, available: Object.keys(commands) };
      } else {
        try {
          const ret = commands[payload.command].apply(null, payload.args || []);
          result = { ok: true, command: payload.command, result: ret };
        } catch (err) {
          result = { ok: false, command: payload.command, error: err.toString(), stack: String(err.stack || '') };
        }
      }
      result.ts = Utilities.formatDate(new Date(), 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ssXXX");
      folder.createFile(_cmdQueue_markerName('result', uniq), JSON.stringify(result), MimeType.PLAIN_TEXT);
      if (runningMarker) {
        try { runningMarker.setTrashed(true); } catch (e) {
          console.warn('command queue running marker cleanup failed (' + uniq + '): ' + e);
        }
      }
    }

    // 案件別ジョブの待ち件数表示だけを更新する。重い実行は専用 worker が担当。
    try {
      JobQueue_refreshWaitingLabels();
    } catch (e) {
      console.warn('JobQueue_refreshWaitingLabels failed: ' + e);
    }

    // 追加: sales-app から append された folder 未生成 case を自動処理する
    // sales-app の「🚀 ブース制作アプリで 見積/実施計画 を作成」 ボタンは sheet 行 append しか
    // しないため、 phase=1 + folderId 空 の row を見つけたら ここで folder 生成 +
    // Phase1_Estimate_generate を chain する。 既に zissiId がある row は skip。
    try {
      _AutoProcess_pendingCases();
    } catch (e) {
      console.warn('_AutoProcess_pendingCases failed: ' + e);
    }
  } finally {
    lock.releaseLock();
  }
}

function _cmdQueue_readJson(file) {
  try { return JSON.parse(file.getBlob().getDataAsString()); } catch (e) { return null; }
}

function _cmdQueue_childFolder(parent, name) {
  const matches = parent.getFoldersByName(name);
  return matches.hasNext() ? matches.next() : parent.createFolder(name);
}

function CmdQueue_housekeep(opts) {
  opts = opts || {};
  const dryRun = opts.dryRun === true;
  const olderThanDays = opts.olderThanDays === undefined ? 3 : Math.max(0, Number(opts.olderThanDays) || 0);
  // moveTo は1件ずつ Drive 往復。同じロック内で走るので1パスの取り分を小さくする。溜まっている分は日をまたいで消化される。
  const limit = opts.limit === undefined ? 50 : Math.max(0, Math.floor(Number(opts.limit) || 0));
  const folder = DriveApp.getFolderById(CMD_FOLDER_ID);
  const archive = _cmdQueue_childFolder(folder, '_archive');
  const iterator = folder.getFiles();
  const records = [];
  const driveFiles = [];
  while (iterator.hasNext()) {
    const file = iterator.next();
    const name = file.getName();
    if (name.indexOf('result_') !== 0) continue;
    const createdMs = file.getDateCreated().getTime();
    records.push({ name: name, createdMs: createdMs });
    driveFiles.push({ file: file, name: name, createdMs: createdMs });
  }
  const selection = _cmdQueue_selectArchivable(
    records, Date.now(), olderThanDays * 24 * 60 * 60 * 1000, limit
  );
  let moved = 0;
  let failed = 0;
  const previews = [];
  const monthFolders = {};
  selection.targets.forEach(function (target) {
    if (dryRun) {
      if (previews.length < 20) previews.push({ name: target.name, createdAt: new Date(target.createdMs).toISOString() });
      return;
    }
    const matchIndex = driveFiles.findIndex(function (entry) {
      return entry.name === target.name && entry.createdMs === target.createdMs && entry.file;
    });
    if (matchIndex < 0) {
      failed++;
      console.warn('command queue housekeep file disappeared: ' + target.name);
      return;
    }
    const entry = driveFiles[matchIndex];
    const file = entry.file;
    entry.file = null;
    try {
      if (!monthFolders[target.ym]) monthFolders[target.ym] = _cmdQueue_childFolder(archive, target.ym);
      // entry.file is reserved above so duplicate names cannot select the same Drive file twice.
      file.moveTo(monthFolders[target.ym]);
      moved++;
    } catch (e) {
      failed++;
      console.warn('command queue housekeep move failed (' + target.name + '): ' + e);
    }
  });
  const result = {
    ok: true,
    scanned: selection.scanned,
    moved: moved,
    skipped: selection.scanned - selection.targets.length,
    failed: failed,
    truncated: selection.truncated,
    dryRun: dryRun,
    archiveFolderId: archive.getId()
  };
  if (dryRun) result.targets = previews;
  return result;
}

function _cmdQueue_maybeHousekeep() {
  try {
    const props = PropertiesService.getScriptProperties();
    const nowMs = Date.now();
    const lastMs = Number(props.getProperty(CMD_QUEUE_HOUSEKEEP_AT)) || 0;
    if (nowMs - lastMs < CMD_QUEUE_HOUSEKEEP_INTERVAL_MS) return;
    // 殺された時に毎分リトライしてキューを殺すより1日スキップの方が軽い。
    props.setProperty(CMD_QUEUE_HOUSEKEEP_AT, String(nowMs));
    try {
      CmdQueue_housekeep();
    } catch (e) {
      console.warn('command queue housekeep failed: ' + e);
    }
  } catch (e) {
    console.warn('command queue housekeep scheduling failed: ' + e);
  }
}

function _cmdQueue_recoverStale(folder) {
  try {
    const files = folder.getFiles();
    const markers = [];
    const markerFiles = {};
    const resultUniqs = new Set();
    while (files.hasNext()) {
      const file = files.next();
      const name = file.getName();
      const uniq = _cmdQueue_uniqFromName(name);
      if (uniq === null) continue;
      if (/^running_/i.test(name)) {
        markers.push({ uniq: uniq, createdMs: file.getDateCreated().getTime() });
        markerFiles[uniq] = file;
      } else if (/^result_/i.test(name)) {
        resultUniqs.add(uniq);
      }
    }
    const stale = _cmdQueue_selectStale(markers, Date.now(), CMD_RUNNING_STALE_MS, resultUniqs);
    stale.forEach(function (entry) {
      const marker = markerFiles[entry.uniq];
      if (!marker) return;
      if (!entry.hasResult) {
        const body = _cmdQueue_readJson(marker) || {};
        const recoveredAt = Utilities.formatDate(new Date(), 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ssXXX");
        folder.createFile(_cmdQueue_markerName('result', entry.uniq), JSON.stringify({
          ok: false,
          command: body.command === undefined ? null : body.command,
          error: 'execution died before writing result (timed out or killed)',
          startedAt: body.startedAt || null,
          recoveredAt: recoveredAt,
          warning: '副作用が残っている可能性がある。再投入の前に生成物を検索して確認すること'
        }), MimeType.PLAIN_TEXT);
      }
      try { marker.setTrashed(true); } catch (e) {
        console.warn('stale command queue marker cleanup failed (' + entry.uniq + '): ' + e);
      }
    });
  } catch (e) {
    console.warn('command queue stale recovery failed: ' + e);
  }
}

function _debug_queueInFlight() {
  const folder = DriveApp.getFolderById(CMD_FOLDER_ID);
  const files = folder.getFiles();
  const nowMs = Date.now();
  const pending = [];
  const running = [];
  const recentResults = [];
  while (files.hasNext()) {
    const file = files.next();
    const name = file.getName();
    const uniq = _cmdQueue_uniqFromName(name);
    if (uniq === null) continue;
    // 古い result_* を全件ダウンロードせず、必要な分岐だけ本文を読む。
    if (/^cmd_/i.test(name)) {
      const body = _cmdQueue_readJson(file) || {};
      pending.push({ uniq: uniq, command: body.command || null, args: body.args === undefined ? null : body.args });
    } else if (/^running_/i.test(name)) {
      const body = _cmdQueue_readJson(file) || {};
      running.push({
        uniq: uniq,
        command: body.command === undefined ? null : body.command,
        args: body.args === undefined ? null : body.args,
        startedAt: body.startedAt || null,
        ageMs: Math.max(0, nowMs - file.getDateCreated().getTime())
      });
    } else if (/^result_/i.test(name) && nowMs - file.getDateCreated().getTime() <= CMD_RECENT_RESULT_MS) {
      const body = _cmdQueue_readJson(file) || {};
      recentResults.push({
        uniq: uniq,
        command: body.command === undefined ? null : body.command,
        ok: body.ok === true,
        ts: body.ts || body.recoveredAt || null,
        createdMs: file.getDateCreated().getTime()
      });
    }
  }
  recentResults.sort(function (a, b) { return b.createdMs - a.createdMs; });
  return {
    pending: pending,
    running: running,
    recentResults: recentResults.slice(0, 20).map(function (item) {
      return { uniq: item.uniq, command: item.command, ok: item.ok, ts: item.ts };
    })
  };
}

/**
 * 案件一覧シートをスキャンし、 folderId 空 + phase=1 (= sales-app 経由で初期登録) の
 * row に対して folder 作成 + Phase1_Estimate_generate を実行する。
 *
 * - Phase1_Estimate_generate は 冪等ガード (zissiId 既存ならスキップ) 付きなので
 *   失敗時に多重実行されても安全
 * - createCaseFolder は同 caseId の既存 folder 作成済みの場合 重複生成しないよう
 *   既存 folderId を最初に再 lookup する (列 I が空でも getFoldersByName で見つかる)
 */
function _AutoProcess_backoffMs(n) {
  const minutes = [5, 15, 60, 180, 360];
  return minutes[Math.min(Math.max(Number(n) || 1, 1), minutes.length) - 1] * 60 * 1000;
}

function _AutoProcess_pendingCases() {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(CASE_LIST_SHEET_NAME);
  if (!sheet) return;
  const props = PropertiesService.getScriptProperties();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  // A:案件ID, B:client, C:case, D:start, E:end, F:size, G:phase, H:confirm, I:folderId, J:updated, K:zissiId
  const data = sheet.getRange(2, 1, lastRow - 1, 11).getValues();
  // 1 row/呼び出し に制限する (Phase1_Estimate_generate が Claude API 呼び出しで
  // 1〜3 分かかるため、 6 分 trigger 上限内で複数 row を処理しようとして timeout する
  // 問題を避ける)。 次の 1-min trigger fire で 次の row が処理される。
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const caseId = String(row[0] || '').trim();
    const clientName = String(row[1] || '').trim();
    const caseName = String(row[2] || '').trim();
    const phase = Number(row[6] || 0);
    const folderId = String(row[8] || '').trim();
    const zissiId = String(row[10] || '').trim();
    if (!caseId) continue;
    // zissiId が既にある → 完了扱い、 何もしない (Phase1 の冪等ガードと同等)
    if (zissiId) continue;
    // phase が 1 でない (≥ 2 で進んでいる or 0) → 触らない
    if (phase !== 1) continue;
    if (!clientName || !caseName) continue;
    const failKey = 'AUTOPROC_FAIL_' + caseId;
    let fail = { n: 0, lastMs: 0 };
    try { fail = JSON.parse(props.getProperty(failKey) || '{}'); } catch (e) {}
    fail.n = Number(fail.n) || 0;
    fail.lastMs = Number(fail.lastMs) || 0;
    if (fail.n >= 5) {
      const now = Date.now();
      fail.lastLogMs = Number(fail.lastLogMs) || 0;
      if (now - fail.lastLogMs >= 60 * 60 * 1000) {
        console.error('caseId=' + caseId + ' は ' + fail.n + ' 回失敗したため自動処理を停止。復帰させるには resetAutoProcessFailures コマンドを使用');
        fail.lastLogMs = now;
        props.setProperty(failKey, JSON.stringify(fail));
      }
      continue;
    }
    if (Date.now() < fail.lastMs + _AutoProcess_backoffMs(fail.n)) continue;
    fail.n += 1;
    fail.lastMs = Date.now();
    props.setProperty(failKey, JSON.stringify(fail));
    try {
      console.log('[_AutoProcess_pendingCases] caseId=' + caseId + ' folder=' + (folderId ? 'exists' : 'create') + ', generating estimate');
      // folder 未生成なら作成 + I 列に書き込み
      if (!folderId) {
        const newFolder = _CaseList_createCaseFolder(caseId, clientName, caseName);
        sheet.getRange(i + 2, 9).setValue(newFolder.getId());
        // (caseList cache が CaseList_getById で参照される為、 書込直後 1 回 flush)
        SpreadsheetApp.flush();
      }
      // 見積/実施計画 生成 (Phase1 側で zissiId 既存なら自動 skip するので安全)
      Phase1_Estimate_generate(caseId);
      props.deleteProperty(failKey);
    } catch (e) {
      console.warn('[_AutoProcess_pendingCases] caseId=' + caseId + ' failed: ' + e);
    }
    // 1 row 処理したら抜ける (timeout 防止)
    break;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    _cmdQueue_markerName: _cmdQueue_markerName,
    _cmdQueue_uniqFromName: _cmdQueue_uniqFromName,
    _cmdQueue_selectStale: _cmdQueue_selectStale,
    _cmdQueue_selectArchivable: _cmdQueue_selectArchivable,
    _cmdQueue_sameArgs: _cmdQueue_sameArgs,
    _DupRow_isDominated: _DupRow_isDominated,
    DuplicateCaseRow_plan: DuplicateCaseRow_plan
  };
}

/**
 * アプリが書いた既存のアサイン依頼行の依頼者名を後から埋める(アサインチーム要望・2026-09-01)。
 * 事故防止のため、B列が「制作P:」等のラベル始まり(=アプリが書いた行)以外はスキップする。
 * items: [{ row: 502, name: '佐藤優奈' }]
 */
function _admin_backfillAssignRequester(items) {
  if (!Array.isArray(items)) throw new Error('items は [{row, name}] の配列で指定してください');
  if (items.length > 20) throw new Error('一度に更新できるのは20件までです');
  const sheet = SpreadsheetApp.openById(_ASSIGN_SS_ID).getSheetByName(_ASSIGN_SHEET_NAME);
  if (!sheet) throw new Error('アサイン依頼シート「マスター」が見つかりません');
  const applied = [];
  const skipped = [];

  items.forEach(function (item) {
    const row = Number(item && item.row);
    const name = String((item && item.name) || '').trim();
    if (!isFinite(row) || row % 1 !== 0 || row < 2) throw new Error('不正な行番号です: ' + (item && item.row));
    if (!name) throw new Error('name は必須です: row ' + row);
    if (row > sheet.getLastRow()) {
      skipped.push({ row: row, reason: '行番号が最終行を超えています' });
      return;
    }
    const before = String(sheet.getRange(row, 2).getDisplayValue() || '');
    const type = String(sheet.getRange(row, 3).getDisplayValue() || '');
    if (!/^制作[PD]\s*[：:]/.test(before)) {
      skipped.push({ row: row, before: before, type: type, reason: 'アプリが書いた行(制作P:始まり)ではないため触りません' });
      return;
    }
    sheet.getRange(row, 2).setValue(name);
    const producerCol = type === '施工スタッフ' ? 65 : (type === 'イベント関連' ? 15 : 0);
    if (producerCol) sheet.getRange(row, producerCol).setValue(name);
    SpreadsheetApp.flush();
    const after = String(sheet.getRange(row, 2).getDisplayValue() || '');
    const afterProducer = producerCol ? String(sheet.getRange(row, producerCol).getDisplayValue() || '') : '';
    if (after !== name || (producerCol && afterProducer !== name)) {
      throw new Error('依頼者名の read-back verify に失敗しました: row ' + row + ' / B=' + after + ' / 担当P=' + afterProducer);
    }
    applied.push({ row: row, type: type, before: before, after: after, producerCol: producerCol, producerAfter: afterProducer });
  });

  return { ok: true, applied: applied, skipped: skipped };
}

/**
 * master タスク進捗管理表 row8 の制作P欄が空ラベル(「制作P:」だけ)の案件ブロックを埋める。
 * アサイン依頼の依頼者名が空になる根本原因の再発防止用(2026-09-01)。
 * expectEventName で対象ブロック(row2 の展示会名)を必ず突き合わせてから書く。
 */
function _admin_setTaskProducer(col, name, expectEventName) {
  const column = Number(col);
  if (!isFinite(column) || column % 1 !== 0 || column < 13) throw new Error('不正な列番号です: ' + col);
  const producer = String(name || '').trim();
  if (!producer) throw new Error('name は必須です');
  const expected = String(expectEventName || '').trim();
  if (!expected) throw new Error('expectEventName は必須です');

  const sheet = SpreadsheetApp.openById('1t6eMvbPIu17m7hbv6foJcvd-fXrJkZqrePb8P6njxGI').getSheetByName('task');
  if (!sheet) throw new Error('master タスク進捗管理表の「task」シートが見つかりません');

  const eventName = String(sheet.getRange(2, column).getDisplayValue() || '').trim();
  if (eventName.indexOf(expected) !== 0) {
    return { ok: false, reason: '展示会名が一致しません', col: column, eventName: eventName, expected: expected };
  }
  const before = String(sheet.getRange(8, column).getDisplayValue() || '');
  if (!/^制作P\s*[：:]\s*$/.test(before)) {
    return { ok: false, reason: '制作P欄が空ラベルではないため触りません', col: column, before: before };
  }
  const after = '制作P：' + producer;
  sheet.getRange(8, column).setValue(after);
  SpreadsheetApp.flush();
  const readBack = String(sheet.getRange(8, column).getDisplayValue() || '');
  if (readBack !== after) throw new Error('制作P の read-back verify に失敗しました: ' + readBack);
  return { ok: true, col: column, eventName: eventName, before: before, after: readBack };
}
