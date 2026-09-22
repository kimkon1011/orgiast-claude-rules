/**
 * エントリポイント。メニュー登録とサイドバー/ダイアログの起動。
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('ブース制作アプリ')
    .addItem('案件一覧シートを初期化', 'CaseList_init')
    .addItem('新規案件を作成', 'showNewCaseDialog')
    .addItem('既存の実施計画を取り込む', 'showImportZissiDialog')
    .addItem('預かり素材PDFをアップロード', 'showUploadDialog')
    .addItem('タスク進捗管理表から一括取り込み', 'showBulkImportConfirm')
    .addItem('サイドバーを開く', 'showSidebar')
    .addSeparator()
    .addItem('使い方手順を見る', 'HowTo_setupSheet')
    .addItem('コマンドキュー初期化 (1回のみ)', 'setupCommandQueue')
    .addItem('毎日同期トリガー設定 (1回のみ)', 'setupBulkImportTrigger')
    .addItem('印刷物チェックシートを更新', 'PrintChecklist_menuBuild')
    .addItem('電気申請書類を作成', 'Phase2_ElectricalApplication_menuGenerate')
    .addItem('Google Meet 連携を承認 (1回のみ)', 'CaseMeet_authorizeOnce')
    .addSeparator()
    .addItem('Claude API キーを設定', 'showApiKeyDialog')
    .addItem('Claude API 疎通テスト', 'ClaudeClient_pingTest')
    .addItem('マニュアル鮮度チェック', 'ManualLoader_freshnessCheck')
    .addToUi();
}

function Phase2_ElectricalApplication_menuGenerate() {
  const c = CaseList_getActive();
  if (!c) throw new Error('案件一覧で対象案件の行を選択してください。');
  const result = Phase2_ElectricalApplication_generate(c.caseId, {});
  SpreadsheetApp.getUi().alert('電気申請書類', '生成 ' + result.artifacts.length + '件／失敗 ' + result.failures.length + '件\n申請 ' + result.summary.applicationKw + 'kw・コンセント ' + result.summary.requiredOutlets + '口', SpreadsheetApp.getUi().ButtonSet.OK);
}

function showSidebar() {
  const html = HtmlService.createTemplateFromFile('ui/Sidebar')
    .evaluate()
    .setTitle('ブース制作アプリ');
  SpreadsheetApp.getUi().showSidebar(html);
}

function showNewCaseDialog() {
  const html = HtmlService.createTemplateFromFile('ui/NewCase')
    .evaluate()
    .setWidth(420)
    .setHeight(520);
  SpreadsheetApp.getUi().showModalDialog(html, '新規案件を作成');
}

function showBulkImportConfirm() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.alert(
    'タスク進捗管理表から一括取り込み',
    '「正式：reブースタスク進捗管理表」(task シート) の案件 21 件を案件一覧に取り込みます。既に登録済みの案件は重複として skip されます。実行してよろしいですか？',
    ui.ButtonSet.OK_CANCEL
  );
  if (res !== ui.Button.OK) return;
  const r = BulkImportFromTaskMgmt_run({});
  ui.alert(
    '取り込み完了',
    '取り込み: ' + r.summary.importedCount + ' 件\n' +
    '重複 skip: ' + r.summary.duplicateCount + ' 件\n' +
    '実計URL なし skip: ' + r.summary.skippedCount + ' 件\n' +
    'エラー: ' + r.summary.errorCount + ' 件',
    ui.ButtonSet.OK
  );
}

function setupBulkImportTrigger() {
  const ui = SpreadsheetApp.getUi();
  const r = BulkImportFromTaskMgmt_setupDailyTrigger();
  if (r.alreadyExists) {
    ui.alert('既に毎日同期トリガーが設定されています。');
  } else {
    ui.alert('毎日 9:00 (JST) に タスク進捗管理表 → 案件一覧 同期が自動実行されます。');
  }
}

function showImportZissiDialog() {
  const html = HtmlService.createTemplateFromFile('ui/ImportZissi')
    .evaluate()
    .setWidth(520)
    .setHeight(560);
  SpreadsheetApp.getUi().showModalDialog(html, '既存の実施計画を取り込む');
}

function showApiKeyDialog() {
  const ui = SpreadsheetApp.getUi();
  const current = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  const masked = current ? current.slice(0, 10) + '...(設定済み)' : '(未設定)';
  const res = ui.prompt(
    'Claude API キーを設定',
    '現在: ' + masked + '\n\n新しい API キー (sk-ant-...) を入力してください。空欄で送信するとキャンセルされます。',
    ui.ButtonSet.OK_CANCEL
  );
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const key = res.getResponseText().trim();
  if (!key) return;
  PropertiesService.getScriptProperties().setProperty('CLAUDE_API_KEY', key);
  ui.alert('Claude API キーを保存しました。');
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
