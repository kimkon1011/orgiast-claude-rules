/** Read-only audit. Missing links are not proof that files do not exist elsewhere. */
function _debug_missingEstimateDocs() {
  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName('案件一覧');
  if (!sheet) throw new Error('案件一覧シートがありません');
  var data = sheet.getDataRange().getDisplayValues();
  var masterId = '1t6eMvbPIu17m7hbv6foJcvd-fXrJkZqrePb8P6njxGI';
  var masters = {}, cases = [];
  function str(value) { return String(value || '').trim(); }
  function link(range) {
    var formula = range.getFormula();
    var match = String(formula).match(/^=HYPERLINK\s*\(\s*"(https?:\/\/[^"\s]+)"/i);
    if (match) return match[1];
    var rich = range.getRichTextValue();
    if (rich) {
      var url = rich.getLinkUrl();
      if (url) return url;
      var runs = rich.getRuns();
      for (var i = 0; i < runs.length; i++) if (runs[i].getLinkUrl()) return runs[i].getLinkUrl();
    }
    var value = str(range.getDisplayValue());
    return /^https?:\/\//.test(value) ? value : '';
  }
  function master(id) {
    if (!masters[id]) {
      try {
        var book = SpreadsheetApp.openById(id), task = book.getSheetByName('task');
        var artifacts = book.getSheetByName('Claude生成物');
        masters[id] = { task: task, headers: task ? task.getRange(1, 1, 5, task.getLastColumn()).getDisplayValues() : [],
          artifacts: artifacts ? artifacts.getDataRange().getDisplayValues() : [], error: task ? '' : 'taskシートなし' };
      } catch (e) { masters[id] = { error: String(e.message || e), artifacts: [] }; }
    }
    return masters[id];
  }
  data.slice(1).forEach(function (row, index) {
    if (!str(row[0])) return;
    var result = { caseId: str(row[0]), clientName: str(row[1]), caseName: str(row[2]), row: index + 2,
      folderUrl: row[8] ? 'https://drive.google.com/drive/folders/' + row[8] : '',
      projectFolderUrl: row[11] ? 'https://drive.google.com/drive/folders/' + row[11] : '',
      implementationPlanUrl: row[10] ? 'https://docs.google.com/spreadsheets/d/' + row[10] + '/edit' : '',
      estimateUrl: '', estimateSource: '', task: null, missing: [], errors: [] };
    var source = master(str(row[12]) || masterId);
    if (source.error) result.errors.push('master: ' + source.error);
    if (source.task) {
      try {
        /* Validate the event as well as the client; never trust a stale masterCol. */
        var resolved = CaseApi_resolveMasterCol(source.headers, result.clientName, result.caseName, Number(row[13]) || 0,
          { startDate: str(row[3]), endDate: str(row[4]), dateRows: [source.headers[3] || [], source.headers[4] || []] });
        if (resolved.col) {
          result.task = { masterSsId: str(row[12]) || masterId, col: resolved.col,
            implementationPlanUrl: link(source.task.getRange(6, resolved.col)),
            estimateUrl: link(source.task.getRange(6, resolved.col + 1)) };
          if (!result.implementationPlanUrl) result.implementationPlanUrl = result.task.implementationPlanUrl;
          result.estimateUrl = result.task.estimateUrl;
          if (result.estimateUrl) result.estimateSource = 'task';
        }
      } catch (e) { result.errors.push('task: ' + String(e.message || e)); }
    }
    for (var a = source.artifacts.length - 1; a > 0 && !result.estimateUrl; a--) {
      var artifact = source.artifacts[a];
      if (str(artifact[0]) === result.caseId && /見積/.test(str(artifact[3])) && /^https?:\/\//.test(str(artifact[5]))) {
        result.estimateUrl = str(artifact[5]); result.estimateSource = 'Claude生成物';
      }
    }
    if (!result.estimateUrl) {
      /* Only explicit case folders and their direct children: no parent/sibling search. */
      var seen = {}, scanned = 0, candidates = [];
      function scan(folder) {
        var files = folder.getFiles();
        while (files.hasNext() && scanned < 400) {
          var file = files.next(); scanned++;
          if (/見積/.test(file.getName()) && !/テンプレ|ストック|サンプル|雛形|ひな形/.test(file.getName())) {
            candidates.push({ url: file.getUrl(), updated: file.getLastUpdated().getTime() });
          }
        }
        if (files.hasNext()) result.errors.push('フォルダ走査上限400件: ' + folder.getId());
      }
      [str(row[11]), str(row[8])].filter(Boolean).forEach(function (id) {
        if (seen[id]) return;
        seen[id] = true;
        try {
          var folder = DriveApp.getFolderById(id); scan(folder);
          var children = folder.getFolders();
          while (children.hasNext() && scanned < 400) {
            var child = children.next();
            if (!seen[child.getId()]) { seen[child.getId()] = true; scan(child); }
          }
          if (children.hasNext()) result.errors.push('子フォルダ走査未完了: ' + id);
        } catch (e) { result.errors.push('folder ' + id + ': ' + String(e.message || e)); }
      });
      candidates.sort(function (a, b) { return b.updated - a.updated; });
      if (candidates.length) { result.estimateUrl = candidates[0].url; result.estimateSource = 'caseFolder'; }
    }
    if (!result.implementationPlanUrl) result.missing.push('実施計画書URL');
    if (!result.estimateUrl) result.missing.push('見積URL');
    cases.push(result);
  });
  return { readOnly: true, checked: cases.length, cases: cases,
    missing: cases.filter(function (c) { return c.missing.length; }),
    note: 'URL未検出はファイル不存在や権限不備の断定ではありません。errorsも確認してください。実施計画書の内容・共有権限は検証しません。' };
}

/** 1案件ずつ実行。既存 Phase1_Estimate_generate のキュー登録を使う。 */
function MissingEstimateDocs_repair(caseId, options) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  if (!options.expectedClientName || options.expectedClientName !== c.clientName) throw new Error('復旧対象のクライアント名が一致しません');
  const knownPlan = _Estimate_existingPlan(c); // 権限エラーを不存在扱いしない
  const folders = {}, estimates = {}, plans = {};
  let count = 0;
  function scan(folder, depth) {
    if (folders[folder.getId()]) return;
    folders[folder.getId()] = folder;
    const files = folder.getFiles();
    while (files.hasNext()) {
      if (++count > 800) throw new Error('復旧走査上限800件。個別確認が必要です');
      const file = files.next(), name = file.getName();
      if (file.isTrashed() || file.getMimeType() !== 'application/vnd.google-apps.spreadsheet' || /テンプレ|ストック|サンプル|雛形|ひな形/.test(name)) continue;
      if (/見積/.test(name)) estimates[file.getId()] = file;
      if (/実施計画/.test(name)) plans[file.getId()] = file;
    }
    if (depth > 0) {
      const children = folder.getFolders();
      while (children.hasNext()) {
        if (++count > 800) throw new Error('復旧走査上限800件。個別確認が必要です');
        scan(children.next(), depth - 1);
      }
    }
  }
  [c.folderId, c.projectFolderId].filter(Boolean).forEach(function (id) { scan(DriveApp.getFolderById(id), 1); });
  // 旧処理は L 列保存前に見積を移動していた。案件フォルダに見積が無い時だけ、名前の末尾が完全一致する案件を探す。
  // legacy は2000件超あり、案件フォルダで見つかった案件まで走査上限で止めない。
  if (!Object.keys(estimates).length) {
    const legacy = DriveApp.getFolderById(LEGACY_APPROACH_LIST_FOLDER_ID).getFolders();
    const suffix = '_' + c.clientName + '_' + c.caseName;
    let legacyCount = 0;
    while (legacy.hasNext()) {
      if (++legacyCount > 2000) throw new Error('legacyフォルダ走査未完了。復旧を中止します');
      const folder = legacy.next();
      if (folder.getName().slice(-suffix.length) === suffix) scan(folder, 1);
    }
  }
  // task のリンクだけ残っている場合も重複作成しない。列は案件名・会期まで照合する。
  const taskLinks = _MissingEstimateDocs_taskLinks(c);
  function addLinkedFile(url, target) {
    if (!url) return;
    const match = String(url).match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (!match) throw new Error('成果物URLを解釈できません: ' + url);
    const file = DriveApp.getFileById(match[1]);
    if (file.isTrashed()) throw new Error('登録済み成果物がゴミ箱にあります: ' + match[1]);
    if (file.getMimeType() !== 'application/vnd.google-apps.spreadsheet' ||
        [ESTIMATE_TEMPLATE_ID, LEGACY_ZISSI_TEMPLATE_ID, LEGACY_TEISYUTU_TEMPLATE_ID].indexOf(file.getId()) >= 0) {
      throw new Error('成果物リンクがスプレッドシートでないかテンプレートを指しています');
    }
    target[file.getId()] = file;
  }
  addLinkedFile(MasterWriteBack_findArtifactUrl(caseId, '見積'), estimates);
  addLinkedFile(taskLinks.estimateUrl, estimates);
  addLinkedFile(taskLinks.zissiUrl, plans);
  if (knownPlan) plans[knownPlan.getId()] = knownPlan;
  const estimateIds = Object.keys(estimates), planIds = Object.keys(plans);
  if (estimateIds.length > 1 || planIds.length > 1) throw new Error('複数候補があるため自動復旧中止: ' + JSON.stringify({ estimateIds: estimateIds, planIds: planIds }));
  const result = { caseId: caseId, clientName: c.clientName, dryRun: options.dryRun !== false,
    estimateId: estimateIds[0] || '', zissiId: planIds[0] || '',
    missing: [].concat(estimateIds.length ? [] : ['見積'], planIds.length ? [] : ['実施計画書']) };
  const pendingId = PropertiesService.getScriptProperties().getProperty('ESTIMATE_PENDING_' + caseId);
  result.pendingEstimateId = pendingId || '';
  if (pendingId && pendingId !== result.estimateId) throw new Error('生成途中の見積IDが候補と一致しません: ' + pendingId);
  if (result.dryRun) return result;
  const folder = DriveApp.getFolderById(c.folderId);
  CaseSharing_ensureEditor(folder, caseId);
  let estimate = estimates[result.estimateId];
  if (result.zissiId && !c.zissiId) {
    // 未完成の固定名コピーは ensurePlan で設定を再開する。既存運用の計画は登録して再利用。
    const book = SpreadsheetApp.openById(result.zissiId), settei = book.getSheetByName('settei');
    if (!settei) throw new Error('実施計画書にsetteiがありません');
    const complete = String(settei.getRange('B1').getValue()) === book.getUrl() && String(settei.getRange('B3').getValue()) && String(settei.getRange('B4').getValue());
    if (complete) c.zissiId = result.zissiId;
    else if (plans[result.zissiId].getName() !== c.caseId + '_' + c.caseName + '_実施計画書') throw new Error('既存実施計画書の設定が不完全です。個別確認が必要です');
  }
  if (pendingId) {
    if (c.zissiId) Phase1_EstimateOnly_generate(caseId, '', estimate);
    else _Estimate_generateInitial(caseId, '');
    return MissingEstimateDocs_repair(caseId, options);
  }
  if (!estimate) {
    // 初版または既存計画の見積生成を通常経路で行う。1コマンドで1案件だけ。
    if (c.zissiId) {
      CaseList_setZissiInfo(caseId, c.zissiId, c.projectFolderId || c.folderId);
      Phase1_EstimateOnly_generate(caseId, '');
      return MissingEstimateDocs_repair(caseId, options);
    }
    return _Estimate_generateInitial(caseId, '');
  }
  CaseSharing_ensureEditor(estimate, caseId);
  const book = SpreadsheetApp.openById(estimate.getId());
  const plan = _Estimate_ensurePlan(c, book);
  // IDを維持して旧移動先から回収。所有ドメインは上で検証済み。
  [estimate, DriveApp.getFileById(CaseList_getById(caseId).zissiId)].forEach(function (file) {
    file.moveTo(folder);
    const parents = file.getParents();
    let found = false;
    while (parents.hasNext()) if (parents.next().getId() === folder.getId()) found = true;
    if (!found) throw new Error('案件フォルダへの配置読み戻し不一致: ' + file.getId());
  });
  _ConfirmationSheet_open(c.folderId, c);
  MasterWriteBack_recordArtifact(caseId, '見積', '見積（復旧）', estimate.getUrl());
  MasterWriteBack_recordArtifact(caseId, '実施計画書', '実施計画書（復旧）', plan.zissiSheetUrl);
  CaseList_touchUpdatedAt(caseId);
  return { caseId: caseId, repaired: true, estimateSheetUrl: estimate.getUrl(),
    zissiSheetUrl: plan.zissiSheetUrl, projectFolderUrl: plan.projectFolderUrl,
    note: '既存見積の本文は保持しました。金額・明細の完成状態は別途確認してください。' };
}

function _MissingEstimateDocs_taskLinks(c) {
  if (!c.masterSsId || !c.masterCol) return {};
  const sheet = SpreadsheetApp.openById(c.masterSsId).getSheetByName('task');
  if (!sheet) throw new Error('masterにtaskシートがありません');
  const headers = sheet.getRange(1, 1, 5, sheet.getLastColumn()).getDisplayValues();
  const resolved = CaseApi_resolveMasterCol(headers, c.clientName, c.caseName, Number(c.masterCol), {
    startDate: c.startDate, endDate: c.endDate, dateRows: [headers[3] || [], headers[4] || []]
  });
  if (!resolved.col) throw new Error('masterの対象案件を一意に照合できません');
  function link(col) {
    const range = sheet.getRange(6, col);
    const formula = String(range.getFormula()).match(/^=HYPERLINK\s*\(\s*"(https?:\/\/[^"\s]+)"/i);
    if (formula) return formula[1];
    const rich = range.getRichTextValue();
    if (rich) {
      if (rich.getLinkUrl()) return rich.getLinkUrl();
      const urls = rich.getRuns().map(function (r) { return r.getLinkUrl(); }).filter(Boolean);
      if (urls.length) return urls[0];
    }
    const value = String(range.getDisplayValue() || '').trim();
    return /^https?:\/\//.test(value) ? value : '';
  }
  return { zissiUrl: link(resolved.col), estimateUrl: link(resolved.col + 1) };
}
