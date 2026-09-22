/**
 * master の案件別実行パネルを booth 側から構築する。
 * 機能を変更したら Panel_rebuildAllCasePanels() を必ず実行すること。
 * 機能定義とレイアウトの単一ソースはこのファイルに置く。
 */

const _PANEL_MASTER_SS = '1t6eMvbPIu17m7hbv6foJcvd-fXrJkZqrePb8P6njxGI';
const _PANEL_NAME = '🚀実行パネル';
// 案件パネルの識別マーカー (G1)。master bound 側 TaskButtons.js の PANEL_MARKER と一致必須
const _PANEL_MARKER_V2 = 'BOOTH_PANEL_V2';
const _PANEL_MARKER_V3 = 'BOOTH_PANEL_V3';
const PANEL_HEADER_ROW = 6;
const PANEL_FIRST_FEATURE_ROW = PANEL_HEADER_ROW + 1;

function _Panel_isMarker(marker) { return marker === _PANEL_MARKER_V2 || marker === _PANEL_MARKER_V3; }

function _Panel_legacyFeatures() {
  var checklistLinks = typeof Checklist_panelLinks === 'function' && typeof ScriptApp !== 'undefined' ? Checklist_panelLinks() : [];
  var features = [
    { label: '📥 最新の打合せ・メールを取り込む', command: 'Case_refreshClientContext', args: [], tasks: '【普段は押さなくてOK】打合せ議事録は毎晩・メールは毎時、自動で反映されます。今日の打合せ/メールをすぐ使って作り直したい時だけ押す' },
    { label: '🧭 残タスクを洗い出して台帳を更新', command: 'TaskLedger_sync', args: [], tasks: '工程タスク・お客様メール・議事録・確認シート・手配物から「まだ終わっていない事」を全部集めて、実施計画書「Claude_タスク台帳」に1枚でまとめます。ヌケモレ確認はこのシートを見てください／ 毎晩21時に自動で洗い出し、22時〜朝5時にAIが「下書きを作るだけ」のタスクを自動実行します。台帳の ▶AI実行 にチェックを入れると最大20分以内に実行されます／ 時間のかかる書類(レイアウト・搬入出計画・施工手順・資料チェック等)は台帳からではなく、このパネルの該当機能から実行してください' },
    { label: '🧭 全案件の残タスク一覧を作り直す', command: 'TaskLedger_rebuildRollup', args: [], tasks: '全案件の残タスクを1枚にまとめた「🧭タスク台帳(全案件)」シート(案件一覧のスプレッドシート)を作り直します。毎晩22時に自動更新されるので普段は押さなくてOK', noCase: true },
    { label: '💰 仕入先ごとの原価を全案件で集計する', command: 'CostRollup_rebuild', args: [], tasks: '協力会社・仕入先・手配先にいくらで頼んでいるかを案件をまたいで一覧にします。見積を作る前の相場確認に使います', noCase: true },
    { label: '📧 お客様メールの返信文とタスクを作る', command: 'Phase_MailResponse_generate', args: [], tasks: 'お客様からの最新メールを読んで、返信文の下書きと やるべきタスク一覧を実施計画書「Claude_メール対応」シートに作ります' },
    { label: '📩 お客様メールの添付を預かり素材に取り込む', command: 'MailAttachments_syncCase', args: [], tasks: '【普段は押さなくてOK】お客様がメールで送ってきた資料(出展マニュアル・図面・写真等)は15分毎に自動で預かり素材フォルダへ保存されます。今届いた添付をすぐ反映したい時だけ押す。取込結果は案件一覧の「Claude_メール添付取込」シートに出ます' },
    { label: '📦 ギガファイル便を取り込む', command: 'TransferLinks_syncCase', args: [], tasks: '【普段は押さなくてOK】メールに届いたギガファイル便URLは毎日3時に取込キューへ登録されます。今すぐ登録したい時だけ押す。完了後は預かり素材フォルダに入り、結果は「Claude_ギガファイル取込」シートに出ます' },
    { label: '📎 議事録をこの案件に取り込む', command: 'Meeting_linkTranscript', args: [], tasks: '会議の件名から案件が判らず自動で紐付かなかった議事録(tl;dv)を、選択中イベントの案件に手動で紐付けます。まず何も書かずに▶すると候補一覧がF列に出ます。次に下部の📎入力欄に日時(例: 8/17 16:00)を書いてから▶' },
    { label: '🗓 次回ミーティングのアジェンダを作る', command: 'Phase_MeetingAgenda_generate', args: [], tasks: 'これまでの議事録・メールを全部読んで、次回の打合せで決めることを整理します。未完了の宿題・残っている工程タスク・更新が必要な書類も一覧にして、実施計画書「Claude_次回MTGアジェンダ」シートに書き出します' },
    { label: '🙋 アサイン依頼の下書きを作る (送信前に直せます)', command: 'Phase_AssignRequest_draft', args: [], tasks: '案件概要・日程・必要な人員をまとめた依頼書の下書きを作ります。この時点ではアサインチームに送られません。依頼書(Doc)を直し、不要な行は下の📝欄に「除外:施工スタッフ」のように書いてから、次の「下書きを確認して送る」を押してください' },
    { label: '📨 下書きを確認してアサインチームへ送る', command: 'Phase_AssignRequest_sendDraft', args: [], tasks: '下書きをアサイン依頼シートに登録し、アサインチームへDiscordで通知します。📝欄に「除外:施工スタッフ」等を書くとその行を送りません(何も書かなければ全部送ります)。2回目以降は【修正版】として送られます' },
    { label: '🧾 手配物リストを作る (議事録・メールから)', command: 'Phase_ProcurementRequest_generate', args: [], tasks: '打合せ議事録とお客様メールを読んで「買う必要がある物」を洗い出し、実施計画書「アイテムリスト」に追記します。保有機材で足りる物は出しません。各行に根拠(議事録の日付と発言)が入ります。作成後、kim へ承認依頼が飛びます' },
    { label: '📮 承認済みを購買部へ手配依頼', command: 'Phase_ProcurementRequest_submit', args: [], tasks: 'アイテムリストで kim が「承認(kim)」にチェックした手配物だけを、購買依頼フォームへ送って購買部の案件を立てます。送信済みの行は何度押しても再送されません' },
    { label: '🛒 貼ったURLと個数で購買部へ手配依頼', command: 'Phase_ProcurementRequest_quickSubmit', args: [], tasks: '下の🛒欄に「買いたい物のURL 個数」を1行1品で貼って▶。品名はURLから自動で取ります。実施計画書のアイテムリストに承認済みで登録し、そのまま購買依頼フォームへ送ります。※アイテムリストに承認済みのまま未送信だった物も一緒に送られます' },
    { label: '⏳ 未完了リストを今すぐ更新', command: 'PanelPending_refresh', args: [], tasks: 'パネル最下部の「⏳ 依頼したけれど、まだ終わっていないこと」を今すぐ作り直します（普段は各機能の実行後に自動更新されます）' },
    { label: '✅ ⏳でチェックした分を「完了」にする', command: 'PanelPending_applyChecked', args: [],
      tasks: '最下部の ⏳ 一覧で「✅済」にチェックを入れた項目を、台帳で「完了」にして一覧から消します（チェックだけでも最大10分で自動反映されます）' },
    { label: '見積書を作る', command: 'Phase1_Estimate_generate', args: [], tasks: '見積のたたき台を作ります。新規案件なら実施計画書とフォルダも一緒に作成。もう一度押すと新しいファイルができます(上書きしません)' },
    { label: '📝 文章・口頭指示から書類を作る', command: 'Phase_FromText_generate', args: [], tasks: '下の📝欄にお客様のメール本文や打合せの口頭メモを貼って▶。内容から見積書・請求書・送付文のどれが必要かを判断して作ります。まずこれを押せばOKです' },
    { label: '🧾 請求書を作る', command: 'Phase_Invoice_generate', args: [], tasks: 'オージャストの正式な請求書（インボイス対応）をPDFまで作ります。金額は📝欄の指示 →最新の自社見積 の順で拾います。送信は中身を確認してから人が行ってください' },
    { label: '✉ 見積・請求の送付文を作る', command: 'Phase_CoverLetter_generate', args: [], tasks: '見積書・請求書を送るときのメール件名と本文を作り、添付すべきファイルのDrive URLも一緒に実施計画書「Claude_送付文」シートに出します' },
    { label: '💰 原価・請求・粗利を出す', command: 'Phase_CostProfit_generate', args: [], tasks: 'メールで届いた仕入先の見積を読んで原価にし、自社見積・価格表から請求金額と粗利を出して実施計画書「Claude_原価粗利」シートに追記します' },
    { label: 'デザイナー依頼文を作る', command: 'Phase1_DesignerBrief_generate', args: [], tasks: '【緊急時のみ】普段はアサインチームが実施。デザイナーへ送る依頼文の下書きを作ります(ブース装飾プラン・装飾提案のタスクで)', rare: true },
    { label: '全体スケジュールを作る', command: 'Phase1_Schedule_generate', args: [], tasks: '本番までの全体スケジュール表を作ります' },
    { label: 'アイテムリストを作る', command: 'Phase2_ItemList_generate', args: [], tasks: '持って行く備品リストの案を作ります(実施計画書に書き込まれます)' },
    { label: 'レイアウトシートを作る', command: 'Phase2_LayoutPlan_generate', args: [], tasks: 'レイアウト仕様書と、AI画像生成用プロンプト(ChatGPTに貼ってパース画像を作る文章)を作ります' },
    { label: '搬入出計画を作る', command: 'Phase2_LogisticsPlan_generate', args: [], tasks: 'トラック・荷物の搬入出計画を作ります(荷物の容積からトラック台数も自動計算)' },
    { label: '提出書類チェックリストを作る', command: 'Phase2_Submission_generate', args: [], tasks: '主催者への提出書類一覧と締切チェックリストを作ります' },
    { label: '設営撤去手順を作る', command: 'Phase2_SetupTeardownPlan_generate', args: [], tasks: '設営・撤去の手順書(文書版)を作ります' },
    { label: '施工手順書スライドを作る', command: '', args: [], tasks: 'スライド26枚の本格的な施工手順書。右の🔗リンクを開いてブラウザで作ります(このシートでは動きません)', link: 'https://construction-manual-app.vercel.app' },
    { label: '施工会社への打診文を作る', command: 'Phase2_AssignBrief_generate', args: ['construction'], tasks: '施工会社へ見積・日程を打診するメール文の下書き' },
    { label: '運営スタッフへの打診文を作る', command: 'Phase2_AssignBrief_generate', args: ['ops'], tasks: '【緊急時のみ】普段はアサインチームが実施。当日スタッフを募集・打診するメール文の下書き', rare: true },
    { label: 'ドライバーへの打診文を作る', command: 'Phase2_AssignBrief_generate', args: ['driver'], tasks: '【緊急時のみ】普段はアサインチームが実施。搬入出ドライバーを手配するメール文の下書き', rare: true },
    { label: 'クライアント当日案内を作る', command: 'Phase4_DayBrief_generate', args: ['client'], tasks: '本番1週間前ごろ、お客様へ送る当日案内の下書き' },
    { label: '施工会社当日案内を作る', command: 'Phase4_DayBrief_generate', args: ['construction'], tasks: '本番1週間前ごろ、施工会社へ送る当日案内の下書き' },
    { label: '運営スタッフ当日案内を作る', command: 'Phase4_DayBrief_generate', args: ['ops'], tasks: '本番1週間前ごろ、当日スタッフへ送る案内の下書き' },
    { label: 'ドライバー当日案内を作る', command: 'Phase4_DayBrief_generate', args: ['driver'], tasks: '本番1週間前ごろ、ドライバーへ送る案内の下書き' },
    { label: '📝 もらった資料をチェックする (誤字脱字・寸法)', command: 'Phase_ProofCheck_generate', args: [], tasks: 'デザイナーや協力会社から上がってきたパース・図面・提案書を読んで、誤字脱字・案件情報の食い違い・連絡先ミス、そして造作が小間から四方100mm内側に収まっているかをチェックし、実施計画書「Claude_資料チェック」シートに指摘を書き出します' },
    { label: '入稿データチェックをする', command: 'Phase3_NyukoCheck_generate', args: [], tasks: '印刷物・グラフィックの入稿データに不備がないかチェックします' },
    { label: '報告書を作る', command: 'Phase6_PostReport_generate', args: [], tasks: '【開催後】お客様向け報告書の下書きを作ります' },
    { label: '改善指示書を作る', command: 'Phase6_ImprovementBrief_generate', args: [], tasks: '【開催後】次回に向けた改善点のまとめを作ります' },
    { label: '最終見積を作る', command: 'Phase6_FinalEstimate_generate', args: [], tasks: '【開催後】精算用の最終見積を作ります' },
    { label: 'スタッフ評価を作る', command: 'Phase6_StaffEval_generate', args: [], tasks: '【開催後】当日スタッフの評価シートを作ります' },
    { label: '📤 資料をアップ (出展マニュアル/図面/パース等)', command: '', args: [], tasks: '上のメニュー「ブース制作アプリ→預かり素材PDFをアップロード」から。自動でプロジェクトフォルダに保存され、taskシート下部の📎行にリンクが出ます。図面・パースを入れると次の生成から自動で反映。Google スライドは PDF に書き出さずそのまま案件フォルダに置けば読み込まれ、測定結果・パース検証も対象です', menu: 'メニュー「ブース制作アプリ」→「預かり素材PDFをアップロード」から実行' },
    { label: 'master → アプリ 同期', command: 'BulkImportFromTaskMgmt_run', args: [{}], tasks: '【普段は押さなくてOK】毎朝9時に自動同期され、▶実行時に新イベントが見つからない場合も自動で同期→再実行されます。すぐ同期だけしたい時に押す', noCase: true },
    { label: 'master 進捗を引き戻し', command: 'MasterSync_pullProgress', args: [], tasks: 'アプリ側の進捗を案件一覧シートへ反映したい時(通常は使いません)', noCase: true },
    { label: '🐛 不具合・要望を報告 (画像OK)', command: '', args: [], tasks: 'アプリの不具合や「こうしてほしい」を開発に送る。画面キャプチャは Ctrl+V で貼れます', menu: 'メニュー「ブース制作アプリ」→「🐛 不具合・要望を報告 (画像OK)」から実行', noCase: true },
  ];
  checklistLinks.forEach(function (item) {
    features.push({ label: item.label, command: '', args: [], tasks: '当日スタッフ向けチェックリスト Web アプリを開きます', link: item.url, noCase: true });
  });
  if (!checklistLinks.length) {
    features.push({ label: '📋 当日チェックリスト（スタッフ用）', command: '', args: [], tasks: '当日スタッフ向けチェックリスト Web アプリを開きます', noCase: true });
    features.push({ label: '⚙ チェックリスト管理', command: '', args: [], tasks: 'チェックリストの項目と進捗を管理します', noCase: true });
  }
  return features;
}

function _Panel_features() {
  var meta = [
    ['refreshContext','common','📥 最新の打合せ・メールを取り込む'], ['taskLedger','common','🧭 残タスクを洗い出して台帳を更新'], ['taskLedgerRollup','common','🧭 全案件の残タスク一覧を作り直す'], ['costRollup','common','💰 仕入先ごとの原価を全案件で集計する'], ['mailAttachments','common','📩 お客様メールの添付を預かり素材に取り込む'],
    ['transferLinks','common','📦 ギガファイル便を取り込む'],
    ['linkTranscript','common','📎 議事録をこの案件に取り込む'], ['uploadMaterials','common','📤 資料をアップ (出展マニュアル/図面/パース等)'],
    ['masterSyncPull','common','master → アプリ 同期'], ['masterProgressPull','common','master 進捗を引き戻し'], ['procurementQuick','common','🛒 貼ったURLと個数で購買部へ手配依頼'], ['pendingRefresh','common','⏳ 未完了リストを今すぐ更新'], ['pendingApply','common','✅ ⏳でチェックした分を「完了」にする'], ['feedback','common','🐛 不具合・要望を報告 (画像OK)'],
    ['fromText','sales','📝 文章・口頭指示から書類を作る'], ['estimate','sales','見積書を作る'], ['invoice','sales','🧾 請求書を作る'], ['coverLetter','sales','✉ 見積・請求の送付文を作る'],
    ['mailResponse','sales','📧 お客様メールの返信文とタスクを作る'], ['meetingAgenda','sales','🗓 次回ミーティングのアジェンダを作る'], ['costProfit','sales','💰 原価・請求・粗利を出す'],
    ['assignRequestDraft','p1','🙋 アサイン依頼の下書きを作る (送信前に直せます)'], ['assignRequest','p1','📨 下書きを確認してアサインチームへ送る'], ['schedule','p1','全体スケジュールを作る'], ['designerBrief','p1','デザイナー依頼文を作る'],
    ['itemList','p2','アイテムリストを作る'], ['layoutPlan','p2','レイアウトシートを作る'], ['logisticsPlan','p2','搬入出計画を作る'], ['submission','p2','提出書類チェックリストを作る'],
    ['setupTeardown','p2','設営撤去手順を作る'], ['constructionManual','p2','施工手順書スライドを作る'], ['procurementRequest','p2','🧾 手配物リストを作る (議事録・メールから)'],
    ['procurementSubmit','p2','📮 承認済みを購買部へ手配依頼'], ['assignConstruction','p2','施工会社への打診文を作る'], ['assignOps','p2','運営スタッフへの打診文を作る'], ['assignDriver','p2','ドライバーへの打診文を作る'],
    ['proofCheck','p2','📝 もらった資料をチェックする (誤字脱字・寸法)'],
    ['nyukoCheck','p3','入稿データチェックをする'], ['dayBriefClient','p3','クライアント当日案内を作る'], ['dayBriefConstruction','p3','施工会社当日案内を作る'],
    ['dayBriefOps','p3','運営スタッフ当日案内を作る'], ['dayBriefDriver','p3','ドライバー当日案内を作る'],
    ['checklistStaff','onsite','📋 当日チェックリスト（スタッフ用）'], ['checklistAdmin','onsite','⚙ チェックリスト管理'], ['onsitePlaceholder','onsite','当日の質問対応・トラブル対応'], ['postReport','after','報告書を作る'], ['improvementBrief','after','改善指示書を作る'],
    ['finalEstimate','after','最終見積を作る'], ['staffEval','after','スタッフ評価を作る']
  ];
  var byLabel = {};
  _Panel_legacyFeatures().forEach(function (feature) { byLabel[feature.label] = feature; });
  return meta.map(function (item) {
    var feature = item[0] === 'onsitePlaceholder' ? {
      label: item[2], command: '', args: [],
      tasks: '本番当日はDiscordと現地対応です。当日向けの自動機能はまだありません（今後ここに追加予定）'
    } : byLabel[item[2]];
    if (!feature) throw new Error('機能定義不足: ' + item[2]);
    var result = {};
    Object.keys(feature).forEach(function (key) { result[key] = feature[key]; });
    result.key = item[0]; result.phase = item[1];
    return result;
  });
}

/**
 * パネルの案件名セル (プルダウンが載る所)。
 * 新レイアウトは A3:B3 がラベル結合で案件名は C3、旧レイアウト (再構築前のパネル) は B3。
 * Panel_rebuildAllCasePanels で全部移行するが、移行前でも毎分の同期が壊れないよう自動判定する。
 */
function _Panel_eventCell(p) {
  try {
    const merged = p.getRange('A3').getMergedRanges();
    if (merged.length > 0 && merged[0].getNumColumns() >= 2) return p.getRange(3, 3);
  } catch (e) { /* 判定できなければ旧レイアウト扱い */ }
  return p.getRange(3, 2);
}

/** 案件専用パネルをゼロから再構築する。 */
/** 旧リモートコマンド互換: インデックスと全案件パネルを再構築。 */
function Panel_rebuild() {
  Panel_rebuildIndex();
  return Panel_rebuildAllCasePanels();
}

function Panel_phaseKeyFromDates(startDate, endDate, today) {
  function dayMs(value) {
    var date = value instanceof Date ? value : new Date(value);
    if (isNaN(date.getTime())) return NaN;
    return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  }
  var startMs = dayMs(startDate);
  if (isNaN(startMs)) return 'p2';
  var endMs = dayMs(endDate);
  var todayMs = dayMs(today);
  if (isNaN(todayMs)) return 'p2';
  if (!isNaN(endMs) && endMs < todayMs) return 'after';
  if ((todayMs >= startMs && (isNaN(endMs) || todayMs <= endMs)) || todayMs === startMs - 86400000) return 'onsite';
  var days = (startMs - todayMs) / 86400000;
  if (days <= 14) return 'p3';
  if (days <= 60) return 'p2';
  return 'p1';
}

/** 次のパネル再構築を開始すると時間予算を超える見込みか。 */
function Panel_shouldStopRebuilding(elapsedMs, lastPanelMs, budgetMs) {
  if (Number(elapsedMs) <= 0) return false;
  return Number(elapsedMs) + Number(lastPanelMs) * 1.3 > Number(budgetMs);
}

function Panel_currentPhaseKey(caseId, eventLabel) {
  var c = caseId ? CaseList_getById(caseId) : null;
  if (!c) return Panel_phaseKeyFromDates('', '', new Date());
  var raw = SpreadsheetApp.getActive().getSheetByName(CASE_LIST_SHEET_NAME).getRange(c.rowIndex, 4, 1, 2).getValues()[0];
  return Panel_phaseKeyFromDates(raw[0], raw[1], new Date());
}

function _Panel_formatCaseDate(value) {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date && !isNaN(value.getTime())) {
    if (typeof Utilities !== 'undefined') return Utilities.formatDate(value, 'Asia/Tokyo', 'yyyy/MM/dd');
    return value.getFullYear() + '/' + String(value.getMonth() + 1).padStart(2, '0') + '/' + String(value.getDate()).padStart(2, '0');
  }
  return String(value).trim();
}

/** 案件情報行の表示要素を、値が取れた項目だけ組み立てる。 */
function Panel_buildCaseInfoItems(c, venue, estimateUrl) {
  c = c || {};
  var items = [], start = _Panel_formatCaseDate(c.startDate), end = _Panel_formatCaseDate(c.endDate);
  if (start || end) items.push({ label: '📅 開催日: ' + (start && end && start !== end ? start + ' 〜 ' + end : (start || end)) });
  if (String(venue || '').trim()) items.push({ label: '📍 会場: ' + String(venue).trim() });
  if (c.zissiId) items.push({ label: '📋 実施計画書', url: 'https://docs.google.com/spreadsheets/d/' + c.zissiId + '/edit' });
  if (estimateUrl) items.push({ label: '💰 見積書', url: String(estimateUrl) });
  var folderId = c.projectFolderId || c.folderId;
  if (folderId) items.push({ label: '📂 制作フォルダ', url: 'https://drive.google.com/drive/folders/' + folderId });
  return items;
}

/**
 * 見積候補ファイルの配列から、パネルに出す1件を選ぶ純粋関数。
 * @param {Array<{name:string, url:string, updatedAt:number}>} candidates
 * @return {string} 採用する URL（該当なしなら ''）
 */
function Panel_pickEstimateFile(candidates) {
  var excluded = /(テンプレ|ストック|サンプル|雛形|ひな形)/;
  var picked = null;
  Panel_dedupeFileCandidates(candidates).forEach(function (candidate) {
    if (!candidate || String(candidate.name || '').indexOf('見積') < 0 || excluded.test(String(candidate.name || ''))) return;
    if (!picked || Number(candidate.updatedAt) > Number(picked.updatedAt)) picked = candidate;
  });
  return picked ? String(picked.url || '') : '';
}

/** 複数の走査経路で拾った同一ファイルを URL 単位で除外する純粋関数。 */
function Panel_dedupeFileCandidates(candidates) {
  var seen = {};
  return (candidates || []).filter(function (candidate) {
    if (!candidate) return false;
    var url = String(candidate.url || '');
    if (!url || seen[url]) return false;
    seen[url] = true;
    return true;
  });
}

// 見積探索で 1 回に見てよいファイル数の上限。マイドライブ直下のような巨大フォルダを
// 掴んだときにパネル再構築ごと 6 分制限で落ちるのを防ぐ (2026-09-05 実害)。
var _PANEL_ESTIMATE_SCAN_FILE_LIMIT = 400;

/**
 * そのフォルダを「親として走査してよいか」。マイドライブ/共有ドライブのルートは走査しない。
 * ルート直下に案件フォルダを置く運用があり、親を辿るとドライブ全体を列挙してしまう。
 */
function Panel_isScannableParent(folder) {
  try {
    if (!folder) return false;
    if (folder.getId() === DriveApp.getRootFolder().getId()) return false;
    // 自分の親を持たない = ルート相当 (共有ドライブのルートを含む)
    return folder.getParents().hasNext();
  } catch (e) { return false; }
}

/** 案件フォルダから見積ファイルを探す（Claude生成物シートに無い案件のフォールバック）。 */
function _Panel_findEstimateInFolder(c) {
  try {
    var folderId = Case_resolveProjectRoot(c);
    if (!folderId) return '';
    var root = DriveApp.getFolderById(folderId);
    var candidates = [];
    var scanned = 0;
    var scanFiles = function (files) {
      while (files.hasNext() && scanned < _PANEL_ESTIMATE_SCAN_FILE_LIMIT) {
        var file = files.next();
        scanned++;
        var mimeType = file.getMimeType();
        if (mimeType !== 'application/vnd.google-apps.spreadsheet' && mimeType !== 'application/pdf') continue;
        candidates.push({ name: file.getName(), url: file.getUrl(), updatedAt: file.getLastUpdated().getTime() });
      }
    };
    scanFiles(root.getFiles());
    var folders = root.getFolders();
    while (folders.hasNext() && scanned < _PANEL_ESTIMATE_SCAN_FILE_LIMIT) scanFiles(folders.next().getFiles());
    try {
      var parents = root.getParents();
      if (parents.hasNext()) {
        var parent = parents.next();
        if (Panel_isScannableParent(parent)) scanFiles(parent.getFiles());
      }
    } catch (parentError) {}
    return Panel_pickEstimateFile(candidates);
  } catch (e) { return ''; }
}

function _Panel_writeCaseInfo(range, items) {
  var plain = [], links = [];
  (items || []).forEach(function (item) {
    if (item.url) links.push({ label: item.label, url: item.url });
    else plain.push(item.label);
  });
  PanelLinks_write(range, plain.join('  /  '), links);
}

function Panel_rebuildCasePanel(eventLabel, opts) {
  opts = opts || {};
  var ms = SpreadsheetApp.openById(_PANEL_MASTER_SS);
  var blockStart = Number(opts.blockStart) || (_Panel_eventMap(ms)[eventLabel] || 0);
  var names = ms.getSheets().map(function (s) { return s.getName(); });
  var p = ms.getSheetByName(opts.sheetName || '') || ms.insertSheet(opts.sheetName || JobQueue_makePanelSheetName(eventLabel, blockStart, names), ms.getSheets().length);
  try { p.getRange(1, 1, p.getMaxRows(), 1).shiftRowGroupDepth(-1); } catch (e) {}
  // パネルは 90 行前後まで書く。行数が足りないシートだとヒント行や 🛒/⏳ 欄の描画で
  // 「範囲の座標がシートのサイズから外れています」で落ち、p.clear() 済みの空パネルが残る
  // (2026-09-05 C0006 クラフトフィック様 FOOD STYLE JAPAN Kyushu で実際に発生)
  try {
    var needRows = 120;
    if (p.getMaxRows() < needRows) p.insertRowsAfter(p.getMaxRows(), needRows - p.getMaxRows());
  } catch (e) { console.warn('Panel ensure rows failed: ' + e); }
  p.clear();
  p.getRange(1, 1, p.getMaxRows(), Math.min(p.getMaxColumns(), 10)).breakApart();
  var caseId = String(opts.caseId || '');
  if (!caseId) try { caseId = String(_JobQueue_resolveCase(eventLabel, _JobQueue_loadResolution(ms)).caseId || ''); } catch (e) {}
  var progress = caseId ? PanelProgress_load(caseId) : {};
  var features = _Panel_features();
  var counts = PanelProgress_countByPhase(features, progress);
  var current = Panel_currentPhaseKey(caseId, eventLabel);
  var phaseKeys = PANEL_PHASES.map(function (phase) { return phase.key; });
  var currentIndex = phaseKeys.indexOf(current);

  p.getRange('A1:F1').merge().setValue('🚀 実行パネル — Claude 機能をワンクリック実行').setFontSize(14).setFontWeight('bold').setBackground('#37474f').setFontColor('#ffffff').setVerticalAlignment('middle');
  p.getRange('A2:F2').merge().setValue('使い方: ① やりたいことの ▶ をチェック → ② 1〜2分で同じ行の「結果」にリンクが出ます。このシートはこの案件専用なので、他の人が別案件を動かしても混ざりません ／ ✅ は「この案件で終わった作業」の記録です（生成が成功すると自動で付きます）').setFontSize(10).setFontColor('#616161').setWrap(true);
  p.getRange('A3:B3').merge().setValue('この案件専用パネル：').setFontWeight('bold').setHorizontalAlignment('right').setVerticalAlignment('middle');
  p.getRange('C3:E3').merge().setValue(eventLabel).setBackground('#fff2cc').setFontWeight('bold').setFontSize(11).setVerticalAlignment('middle');
  p.getRange('A4:F4').merge().setValue(TaskLedger_panelSummaryValue(caseId)).setBackground('#e8f5e9').setFontColor('#1b5e20').setFontSize(10).setVerticalAlignment('middle');
  var caseInfoRange = p.getRange('A5:F5').merge().setBackground('#e3f2fd').setFontColor('#0d47a1').setFontSize(10).setVerticalAlignment('middle');
  try {
    var caseInfo = caseId ? CaseList_getById(caseId) : null, venue = '', estimateUrl = '';
    if (caseInfo) {
      try { if (caseInfo.masterSsId && caseInfo.masterCol) venue = SpreadsheetApp.openById(caseInfo.masterSsId).getSheetByName('task').getRange(3, caseInfo.masterCol).getDisplayValue(); } catch (e) {}
      try { estimateUrl = MasterWriteBack_findArtifactUrl(caseId, '見積'); } catch (e) {}
      if (!estimateUrl) estimateUrl = _Panel_findEstimateInFolder(caseInfo);
    }
    _Panel_writeCaseInfo(caseInfoRange, Panel_buildCaseInfoItems(caseInfo, venue, estimateUrl));
  } catch (e) { caseInfoRange.clearContent(); }
  p.getRange('G1:G5').setValues([[_PANEL_MARKER_V3], [eventLabel], [blockStart], [caseId], [new Date()]]);
  p.getRange(PANEL_HEADER_ROW, 1, 1, 6).setValues([['▶実行','✅済','② 機能','どのタスクの時に使うか','③ 結果 (クリックで開く)','状態']]).setFontWeight('bold').setBackground('#37474f').setFontColor('#ffffff');
  p.setRowHeight(1, 34); p.setRowHeight(2, 30); p.setRowHeight(3, 30); p.setRowHeight(4, 26); p.setRowHeight(5, 34);

  var row = PANEL_FIRST_FEATURE_ROW;
  var phaseHeaders = [];
  var panelValues = [];
  var hiddenValues = [];
  var backgrounds = [];
  var fontWeights = [];
  var fontSizes = [];
  var fontColors = [];
  var wraps = [];
  PANEL_PHASES.forEach(function (phase) {
    var list = features.filter(function (feature) { return feature.phase === phase.key; }).sort(function (a, b) { return Number(a.rare) - Number(b.rare); });
    var count = counts[phase.key] || { done: 0, total: list.length };
    var headerText = phase.label + '　—　' + count.done + '/' + count.total + ' 完了';
    phaseHeaders.push({ phaseKey: phase.key, row: row, text: headerText, total: list.length });
    panelValues.push([headerText, '', '', '', '', '']);
    hiddenValues.push(['', '', '', '__PHASE__:' + phase.key]);
    backgrounds.push([phase.background, phase.background, phase.background, phase.background, phase.background, phase.background]);
    fontWeights.push(['bold', 'bold', 'bold', 'bold', 'bold', 'bold']);
    fontSizes.push([10, 10, 10, 10, 10, 10]);
    fontColors.push([phase.color, phase.color, phase.color, phase.color, phase.color, phase.color]);
    wraps.push([false, false, false, false, false, false]);
    p.setRowHeight(row, 26); row++;
    var first = row;
    list.forEach(function (f, i) {
      var resultValue = f.menu || '';
      if (f.link) {
        var url = String(f.link).replace(/\/+$/, '');
        resultValue = '=HYPERLINK("' + url + '/?event="&ENCODEURL($C$3),"🔗 アプリを開く (選択中の案件が自動入力されます)")';
      }
      panelValues.push([f.command ? false : '', Boolean(progress[f.key] && progress[f.key].done), f.label, f.tasks, resultValue, f.key === 'onsitePlaceholder' ? '—' : (f.link ? '🔗 常時利用可' : (f.menu ? '📋 メニューから' : ''))]);
      hiddenValues.push([f.command || '', JSON.stringify(f.args || []), f.noCase ? '1' : '', f.key]);
      var background = f.rare ? '#f3e5f5' : (i % 2 ? null : '#f5f5f5');
      backgrounds.push([background, background, background, background, background, background]);
      fontWeights.push(['normal', 'normal', 'bold', 'normal', 'normal', 'normal']);
      fontSizes.push([10, 10, 10, 9, 10, 10]);
      fontColors.push([null, null, null, '#616161', null, null]);
      wraps.push([false, false, false, true, false, false]);
    });
    row += list.length;
  });
  var panelRowCount = row - PANEL_FIRST_FEATURE_ROW;
  p.getRange(PANEL_FIRST_FEATURE_ROW, 7, panelRowCount, 4).setValues(hiddenValues);
  p.getRange(PANEL_FIRST_FEATURE_ROW, 1, panelRowCount, 6).setBackgrounds(backgrounds);
  p.getRange(PANEL_FIRST_FEATURE_ROW, 1, panelRowCount, 6).setFontWeights(fontWeights).setFontSizes(fontSizes).setFontColors(fontColors).setWraps(wraps);
  p.getRange(PANEL_FIRST_FEATURE_ROW, 1, panelRowCount, 2).insertCheckboxes();
  phaseHeaders.forEach(function (header) {
    p.getRange(header.row, 1, 1, 2).clearDataValidations().clearContent();
  });
  p.getRange(PANEL_FIRST_FEATURE_ROW, 1, panelRowCount, 6).setValues(panelValues);
  phaseHeaders.forEach(function (header) {
    p.getRange(header.row, 1, 1, 6).merge();
    var first = header.row + 1;
    p.getRange(first, 1, header.total, 1).shiftRowGroupDepth(1);
    var group = p.getRowGroup(first, 1);
    var expand = header.phaseKey !== 'common' && (header.phaseKey === current || phaseKeys.indexOf(header.phaseKey) === currentIndex - 1);
    if (group && !expand) group.collapse();
  });
  p.hideColumns(7, 4);
  [46,46,220,330,280,150].forEach(function (width, i) { p.setColumnWidth(i + 1, width); });
  p.setFrozenRows(PANEL_HEADER_ROW);
  var hintStart = row + 1;
  var hints = [
    '💡 ヒント',
    '・できあがるのは「下書き(初版)」です。必ず中身を確認・修正してから使ってください',
    '・結果は「結果」列のリンクのほか、「Claude生成物」シートと Drive のプロジェクトフォルダにも残ります',
    '・❌が出たら「状態」列の理由を確認(新イベントは自動で同期→再実行されるので通常そのまま待てばOK)',
    '・同じ▶をもう一度押すと新しい版が別ファイルでできます。前のファイルは消えません'
  ];
  hints.forEach(function (hint, i) {
    var range = p.getRange(hintStart + i, 1, 1, 6).merge().setValue(hint).setFontSize(9).setFontColor('#616161').setWrap(true);
    if (i === 0) range.setFontWeight('bold').setFontColor('#37474f');
  });
  var meeting = hintStart + hints.length + 1;
  p.getRange(meeting, 1, 1, 6).merge().setValue('📎 議事録の日時か件名(候補一覧はF列に出ます)').setFontWeight('bold').setBackground('#e3f2fd').setFontColor('#0d47a1');
  p.getRange(meeting + 1, 2).setValue('日時か件名').setFontWeight('bold');
  p.getRange(meeting + 1, 3, 1, 4).merge().setBorder(true,true,true,true,false,false);
  var inputRow = meeting + 3;
  p.getRange(inputRow, 1, 1, 6).merge().setValue('📝 お客様の文章・口頭メモをここに貼る（見積書・請求書・送付文の材料）').setFontWeight('bold').setBackground('#fff3e0').setFontColor('#e65100');
  p.getRange(inputRow + 1, 2).setValue('貼付欄').setFontWeight('bold');
  p.getRange(inputRow + 1, 3, 1, 4).merge().setWrap(true).setVerticalAlignment('top').setBorder(true,true,true,true,false,false);
  p.setRowHeight(inputRow + 1, 90);
  var purchaseRow = inputRow + 3;
  p.getRange(purchaseRow, 1, 1, 6).merge().setValue('🛒 買う物の URL と個数をここに貼る（1行1品／例: https://... 3個）').setFontWeight('bold').setBackground('#e8f5e9').setFontColor('#1b5e20');
  p.getRange(purchaseRow + 1, 2).setValue('貼付欄').setFontWeight('bold');
  p.getRange(purchaseRow + 1, 3, 1, 4).merge().setWrap(true).setVerticalAlignment('top').setBorder(true,true,true,true,false,false);
  p.setRowHeight(purchaseRow + 1, 90);
  var backfilled = 0;
  try { if (caseId) backfilled = (Panel_backfillResultLinks({ dryRun: false, includeEmpty: true, caseId: caseId, sheetName: p.getName() }) || {}).written || 0; } catch (e) { console.warn('Panel rebuild backfill failed: ' + e); }
  if (backfilled > 0) {
    progress = PanelProgress_load(caseId);
    counts = PanelProgress_countByPhase(features, progress);
    phaseHeaders.forEach(function (header) {
      var updated = counts[header.phaseKey] || { done: 0, total: header.total };
      var suffix = '　—　' + updated.done + '/' + updated.total + ' 完了';
      p.getRange(header.row, 1).setValue(header.text.replace(/　—　\d+\/\d+ 完了$/, suffix));
    });
  }
  try { PanelPending_write(p, caseId); } catch (e) { console.warn('Panel pending write failed: ' + e); }
  return { rebuilt: true, sheetName: p.getName(), gid: p.getSheetId(), featureCount: features.length, meetingRow: meeting, inputRow: inputRow, purchaseRow: purchaseRow, backfilled: backfilled };
}

/** 案件パネルのフェーズ見出し・折りたたみ・B列実値を読み取る（検証専用）。 */
function _debug_panelPhaseState(caseId) {
  caseId = String(caseId || '');
  var ms = SpreadsheetApp.openById(_PANEL_MASTER_SS);
  var panel = ms.getSheets().filter(function (sheet) {
    try {
      return _Panel_isMarker(String(sheet.getRange('G1').getValue())) &&
        String(sheet.getRange('G4').getValue() || '') === caseId;
    } catch (e) { return false; }
  })[0];
  if (!panel) return { error: 'パネルなし: ' + caseId };

  var lastRow = panel.getLastRow();
  var markers = panel.getRange(1, 10, lastRow, 1).getValues();
  var headers = [];
  markers.forEach(function (value, index) {
    var marker = String(value[0] || '');
    if (marker.indexOf('__PHASE__:') !== 0) return;
    headers.push({ phaseKey: marker.slice('__PHASE__:'.length), headerRow: index + 1 });
  });
  var features = _Panel_features();
  return headers.map(function (header, index) {
    var firstRow = header.headerRow + 1;
    var total = features.filter(function (feature) { return feature.phase === header.phaseKey; }).length;
    var doneInSheet = total ? panel.getRange(firstRow, 2, total, 1).getValues().filter(function (row) { return row[0] === true; }).length : 0;
    var collapsed = null;
    try {
      var group = panel.getRowGroup(firstRow, 1);
      collapsed = group ? group.isCollapsed() : null;
    } catch (e) { collapsed = null; }
    return {
      phaseKey: header.phaseKey,
      headerRow: header.headerRow,
      headerText: String(panel.getRange(header.headerRow, 1).getDisplayValue() || ''),
      collapsed: collapsed,
      doneInSheet: doneInSheet,
      total: total
    };
  });
}

if (typeof module !== 'undefined' && module.exports) module.exports = { _Panel_features: _Panel_features, Panel_phaseKeyFromDates: Panel_phaseKeyFromDates, Panel_shouldStopRebuilding: Panel_shouldStopRebuilding, Panel_buildCaseInfoItems: Panel_buildCaseInfoItems, Panel_pickEstimateFile: Panel_pickEstimateFile, Panel_dedupeFileCandidates: Panel_dedupeFileCandidates, PANEL_HEADER_ROW: PANEL_HEADER_ROW, PANEL_FIRST_FEATURE_ROW: PANEL_FIRST_FEATURE_ROW };

/** master task シートからイベントラベル一覧 (動的・最終列まで) */
function _Panel_eventLabels(ms) {
  const task = ms.getSheetByName('task');
  const out = [];
  if (!task) return out;
  const lastCol = task.getLastColumn();
  const width = Math.max(3, lastCol - 13 + 1);
  const clients = task.getRange(1, 13, 1, width).getValues()[0];
  const events = task.getRange(2, 13, 1, width).getValues()[0];
  for (let bs = 13; bs + 2 <= lastCol; bs += 3) {
    const idx = bs - 13;
    const ev = String(events[idx] || '').replace(/\s+/g, ' ').trim();
    const cl = String(clients[idx] || '').replace(/\s+/g, ' ').trim();
    if (!ev) continue;
    out.push((cl ? cl + ' / ' : '') + ev.slice(0, 40));
  }
  return out;
}

function _Panel_eventMap(ms) {
  const task = ms.getSheetByName('task');
  const out = {};
  if (!task) return out;
  const lastCol = task.getLastColumn();
  const width = Math.max(3, lastCol - 13 + 1);
  const clients = task.getRange(1, 13, 1, width).getValues()[0];
  const events = task.getRange(2, 13, 1, width).getValues()[0];
  for (let bs = 13; bs + 2 <= lastCol; bs += 3) {
    const idx = bs - 13;
    const ev = String(events[idx] || '').replace(/\s+/g, ' ').trim();
    const cl = String(clients[idx] || '').replace(/\s+/g, ' ').trim();
    if (ev) out[(cl ? cl + ' / ' : '') + ev.slice(0, 40)] = bs;
  }
  return out;
}

/** イベントラベル → 案件パネルの gid。全シートの G1/G2 を 1 回だけ読む。 */
function _Panel_gidMap(ms) {
  const out = {};
  ms.getSheets().forEach(function (sheet) {
    try {
      const marker = sheet.getRange('G1:G2').getValues();
      if (!_Panel_isMarker(String(marker[0][0]))) return;
      const label = String(marker[1][0] || '');
      if (label) out[label] = sheet.getSheetId();
    } catch (e) {}
  });
  return out;
}

function _Panel_findByLabel(ms, eventLabel) {
  const sheets = ms.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    try {
      if (_Panel_isMarker(String(sheets[i].getRange('G1').getValue())) &&
          String(sheets[i].getRange('G2').getValue()) === String(eventLabel)) return sheets[i];
    } catch (e) {}
  }
  return null;
}

function Panel_ensureCasePanel(eventLabel) {
  const ms = SpreadsheetApp.openById(_PANEL_MASTER_SS);
  const found = _Panel_findByLabel(ms, eventLabel);
  var builtV3 = found && String(found.getRange('J6').getValue() || '').indexOf('__PHASE__') === 0;
  var builtV2 = found && String(found.getRange('G6').getValue() || '') !== '';
  if (found && found.getLastRow() >= 6 && (builtV3 || builtV2)) {
    return { sheetName: found.getName(), gid: found.getSheetId(), created: false };
  }
  const map = _Panel_eventMap(ms);
  if (!map[eventLabel]) throw new Error('イベント特定失敗: ' + eventLabel);
  const resolution = _JobQueue_loadResolution(ms);
  const resolved = _JobQueue_resolveCase(eventLabel, resolution);
  const result = Panel_rebuildCasePanel(eventLabel, {
    blockStart: map[eventLabel], caseId: resolved.caseId,
    sheetName: found ? found.getName() : ''
  });
  return { sheetName: result.sheetName, gid: result.gid, created: true };
}

/**
 * 既に存在する案件パネルだけを作り直す (機能リストを変えた後に実行する)。
 * - 新規パネルは作らない。パネルは「その案件を開いた人」の分だけ増やす方針 (タブ増殖防止)
 * - 1 実行あたり opts.limit 枚まで。GAS 6 分制限に対して 1 枚あたり数十回の書き込みがあるため、
 *   残りは戻り値 remaining を見て再実行する (全部を 1 実行でやろうとすると確実に落ちる)
 */
function Panel_rebuildAllCasePanels(opts) {
  opts = opts || {};
  const startedAt = Date.now();
  const limit = Number(opts.limit) || 2;
  const ms = SpreadsheetApp.openById(_PANEL_MASTER_SS);
  const eventMap = _Panel_eventMap(ms); // ループ内で読み直すと task シートを枚数分スキャンしてしまう
  const targets = ms.getSheets().map(function (sheet) {
    try {
      if (sheet.isSheetHidden()) return null;
      const m = sheet.getRange('G1:G5').getValues(); // 1 シート 1 read に抑える
      if (!_Panel_isMarker(String(m[0][0]))) return null;
      return { name: sheet.getName(), label: String(m[1][0] || ''), built: m[4][0], marker: String(m[0][0]) };
    } catch (e) { return null; }
  }).filter(function (t) { return t && t.label && eventMap[t.label]; });
  // 未構築(プレースホルダ)を先に、次に古い順
  targets.sort(function (a, b) { return Number(a.built || 0) - Number(b.built || 0); });
  const batch = targets.slice(0, limit);
  var rebuilt = 0;
  var rebuiltNames = [];
  var rebuiltV2 = 0;
  var timedOut = false;
  var lastPanelMs = 0;
  for (var i = 0; i < batch.length; i++) {
    // 1 枚目は必ず実行し、その実測値を 2 枚目以降の見積もりに使う。
    var elapsedMs = rebuilt === 0 ? 0 : Date.now() - startedAt;
    var estimatedPanelMs = lastPanelMs || 180000;
    if (Panel_shouldStopRebuilding(elapsedMs, estimatedPanelMs, 270000)) {
      timedOut = true;
      break;
    }
    var t = batch[i];
    var panelStartedAt = Date.now();
    Panel_rebuildCasePanel(t.label, { blockStart: eventMap[t.label], sheetName: t.name });
    lastPanelMs = Date.now() - panelStartedAt;
    rebuilt++;
    rebuiltNames.push(t.name);
    if (t.marker === _PANEL_MARKER_V2) rebuiltV2++;
  }
  Panel_rebuildIndex();
  const processedMs = Date.now() - startedAt;
  const outsideBatch = targets.length - batch.length;
  const unfinishedBatch = batch.length - rebuilt;
  const remaining = outsideBatch + unfinishedBatch;
  const v2Remaining = targets.filter(function (t) { return t.marker === _PANEL_MARKER_V2; }).length - rebuiltV2;
  return { rebuilt: rebuilt, rebuiltNames: rebuiltNames, targets: targets.length, remaining: remaining, v2Remaining: v2Remaining, processedMs: processedMs, timedOut: timedOut, lastPanelMs: lastPanelMs };
}

/**
 * まだパネルが無い「会期がこれからの案件」に専用パネルを先に作っておく (limit 枚ずつ)。
 * 現場に「まず自分でパネルを作る」1手間を残さないための先回り。残りは remaining を見て再実行。
 */
function Panel_precreateActive(limit) {
  const max = Number(limit) || 1;
  const ms = SpreadsheetApp.openById(_PANEL_MASTER_SS);
  const eventMap = _Panel_eventMap(ms);
  const dates = _Panel_caseDates();
  const today = new Date();
  const gidMap = _Panel_gidMap(ms); // ラベルごとに全シート走査すると案件数×シート数になる
  const pending = Object.keys(eventMap).filter(function (label) {
    if (gidMap[label]) return false;
    const d = dates[eventMap[label]] || {};
    const end = d.end instanceof Date ? d.end : (d.end ? new Date(d.end) : null);
    return !end || end >= today; // 会期不明も対象 (未同期の新規案件)
  }).sort(function (a, b) {
    const ea = dates[eventMap[a]] || {}, eb = dates[eventMap[b]] || {};
    return Number(ea.start || 8640000000000000) - Number(eb.start || 8640000000000000);
  });
  const batch = pending.slice(0, max);
  const made = batch.map(function (label) { return Panel_ensureCasePanel(label).sheetName; });
  const remaining = Math.max(0, pending.length - batch.length);
  // インデックス再構築は最後の1回だけ。毎回やると master の再計算に巻き込まれて 6 分制限に届く
  if (remaining === 0 || made.length === 0) Panel_rebuildIndex();
  // master は IMPORTRANGE が多く 1 枚作るだけで数十秒かかる。まとめて作ると 6 分制限で落ちるので
  // 「残りがあれば自分をもう 1 件キューに積む」= worker が 1 分ごとに 1 枚ずつ作る自己継続方式にする
  if (remaining > 0) {
    try {
      JobQueue_enqueue({
        panelSheetName: _PANEL_NAME, row: 0, requester: '', eventLabel: '',
        featureLabel: '専用パネル先行作成 (残り' + remaining + ')',
        command: 'Panel_precreateActive', args: [max], noCase: true
      });
    } catch (e) {}
  }
  return { created: made, pending: pending.length, remaining: remaining };
}

function _Panel_caseDates() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(CASE_LIST_SHEET_NAME);
  const out = {};
  if (!sheet || sheet.getLastRow() < 2) return out;
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][12]) !== _PANEL_MASTER_SS) continue;
    out[Number(data[i][13]) || 0] = { start: data[i][3], end: data[i][4] };
  }
  return out;
}

function Panel_rebuildIndex() {
  const ms = SpreadsheetApp.openById(_PANEL_MASTER_SS);
  let p = ms.getSheetByName(_PANEL_NAME);
  if (!p) p = ms.insertSheet(_PANEL_NAME, 0);
  p.clear();
  p.getRange(1, 1, p.getMaxRows(), Math.min(p.getMaxColumns(), 6)).breakApart();
  p.getRange('A1:F1').merge().setValue('🚀 実行パネル — 案件を選んでください').setFontSize(14).setFontWeight('bold').setBackground('#37474f').setFontColor('#ffffff');
  p.getRange('A2:F2').merge().setValue('案件ごとに専用パネルがあります。使う案件の行の「▶ 開く」にチェックを入れると、その案件専用パネルが作られて D 列にリンクが出ます。以降はそのシートで作業してください（他の人が別案件を動かしても混ざりません）').setWrap(true);
  p.getRange(4, 1, 1, 6).setValues([['▶開く', '社名', 'イベント名', '専用パネル(リンク)', '会期', '最近の実行']]).setFontWeight('bold').setBackground('#37474f').setFontColor('#ffffff');
  const map = _Panel_eventMap(ms);
  const dates = _Panel_caseDates();
  let recent = {};
  try {
    _JobQueue_rows(JobQueue_ensureSheet()).forEach(function (j) { recent[j.eventLabel] = j; });
  } catch (e) {}
  const today = new Date();
  const active = [], finished = [];
  Object.keys(map).forEach(function (label) {
    const split = label.split(' / ');
    const client = split.shift() || '';
    const eventName = split.join(' / ');
    const d = dates[map[label]] || {};
    const end = d.end instanceof Date ? d.end : (d.end ? new Date(d.end) : null);
    const item = { label: label, client: client, eventName: eventName, start: d.start, end: end, recent: recent[label] };
    (end && end < today ? finished : active).push(item);
  });
  active.sort(function (a, b) { return Number(a.start || 8640000000000000) - Number(b.start || 8640000000000000); });
  finished.sort(function (a, b) { return Number(b.end || 0) - Number(a.end || 0); });
  // パネル一覧は 1 回だけ作る。行ごとに全シートを走査すると案件数×シート数の
  // getValue になり 6 分制限を超える (2026-08-21 実際に落ちた)
  const panelGidByLabel = _Panel_gidMap(ms);
  function dateText(value) { return value instanceof Date ? Utilities.formatDate(value, 'Asia/Tokyo', 'yyyy/MM/dd') : String(value || ''); }
  function toRow(item) {
    const recentText = item.recent ? ((item.recent.status === '完了' ? '✅ ' : '') + item.recent.featureLabel + ' ' + Utilities.formatDate(new Date(item.recent.receivedAt), 'Asia/Tokyo', 'MM/dd HH:mm')) : '';
    const startText = dateText(item.start);
    const endText = dateText(item.end);
    const period = startText && endText && startText !== endText ? startText + '〜' + endText : (startText || endText);
    return { values: [false, item.client, item.eventName, '', period, recentText], gid: panelGidByLabel[item.label] || 0 };
  }
  // 表の行を先に組み立てる (終了案件の見出し行は values=null で表現)
  const plan = active.map(toRow);
  if (finished.length) {
    plan.push({ header: '■ 終了した案件' });
    finished.forEach(function (item) { plan.push(toRow(item)); });
  }
  let row = 5;
  const firstRow = row;
  if (plan.length) {
    const values = plan.map(function (item) { return item.header ? [item.header, '', '', '', '', ''] : item.values; });
    p.getRange(firstRow, 1, values.length, 6).setValues(values);
    const formulas = plan.map(function (item) { return [item.gid ? '=HYPERLINK("#gid=' + item.gid + '","🚀 開く")' : '']; });
    p.getRange(firstRow, 4, formulas.length, 1).setFormulas(formulas);
    p.getRange(firstRow, 1, plan.length, 1).insertCheckboxes();
    plan.forEach(function (item, i) {
      if (!item.header) return;
      const r = firstRow + i;
      p.getRange(r, 1).clearDataValidations();
      p.getRange(r, 1, 1, 6).merge().setValue(item.header).setFontWeight('bold').setBackground('#eeeeee');
    });
    row = firstRow + plan.length;
  }
  p.setFrozenRows(4);
  p.setColumnWidth(1, 75); p.setColumnWidth(2, 180); p.setColumnWidth(3, 240); p.setColumnWidth(4, 150); p.setColumnWidth(5, 120); p.setColumnWidth(6, 240);
  return { active: active.length, finished: finished.length };
}

function Panel_hideFinishedPanels(days) {
  const ms = SpreadsheetApp.openById(_PANEL_MASTER_SS);
  const dates = _Panel_caseDates();
  const cutoff = new Date().getTime() - (Number(days) || 30) * 86400000;
  let hidden = 0;
  ms.getSheets().forEach(function (sheet) {
    try {
      if (!_Panel_isMarker(String(sheet.getRange('G1').getValue()))) return;
      const blockStart = Number(sheet.getRange('G3').getValue()) || 0;
      const end = dates[blockStart] && dates[blockStart].end;
      const endMs = end instanceof Date ? end.getTime() : (end ? new Date(end).getTime() : 0);
      if (endMs && endMs < cutoff && !sheet.isSheetHidden()) { sheet.hideSheet(); hidden++; }
    } catch (e) {}
  });
  return { hidden: hidden, days: Number(days) || 30 };
}

/**
 * 案件の 00預かり素材 フォルダを master task シート 306行以下の「📎」行へ登録し直す。
 * (master 側 Upload.js の _Upload_writeRegistry と同じ出力。アップロード無しでも一覧を更新できる)
 */
function Azukari_refreshRegistry(caseId) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  if (!c.masterCol) throw new Error('masterCol 未設定 (master 同期を先に)');
  const azukariId = Azukari_resolveFolderId(c, { create: true, noCache: true });
  if (!azukariId) throw new Error('預かり素材フォルダを解決できません');
  const azukari = DriveApp.getFolderById(azukariId);

  const ms = SpreadsheetApp.openById(_PANEL_MASTER_SS);
  const sheet = ms.getSheetByName('task');
  const FOLDER_LABEL = '📎 預かり資料フォルダ';
  const FILES_LABEL = '📎 最新アップ資料 (5件)';
  const SCAN_FROM = 300, SCAN_ROWS = 130;
  const dVals = sheet.getRange(SCAN_FROM, 4, SCAN_ROWS, 1).getValues();
  let folderRow = 0, filesRow = 0, lastUsed = 305;
  for (let i = 0; i < dVals.length; i++) {
    const v = String(dVals[i][0] || '').trim();
    if (!v) continue;
    lastUsed = SCAN_FROM + i;
    if (v.indexOf(FOLDER_LABEL) === 0) folderRow = SCAN_FROM + i;
    if (v.indexOf(FILES_LABEL) === 0) filesRow = SCAN_FROM + i;
  }
  if (!folderRow) { folderRow = lastUsed + 1; sheet.getRange(folderRow, 4).setValue(FOLDER_LABEL).setFontWeight('bold'); }
  if (!filesRow) { filesRow = folderRow + 1; sheet.getRange(filesRow, 4).setValue(FILES_LABEL).setFontWeight('bold'); }

  sheet.getRange(folderRow, c.masterCol).setFormula('=HYPERLINK("' + azukari.getUrl() + '","📂 開く")');

  const files = [];
  const it = azukari.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    files.push({ name: f.getName(), url: f.getUrl(), t: f.getDateCreated().getTime() });
  }
  files.sort(function (a, b) { return b.t - a.t; });
  const top = files.slice(0, 5);
  if (top.length > 0) {
    const text = top.map(function (f) { return f.name.slice(0, 40); }).join(String.fromCharCode(10));
    const rb = SpreadsheetApp.newRichTextValue().setText(text);
    let pos = 0;
    top.forEach(function (f) {
      const nm = f.name.slice(0, 40);
      rb.setLinkUrl(pos, pos + nm.length, f.url);
      pos += nm.length + 1;
    });
    sheet.getRange(filesRow, c.masterCol).setRichTextValue(rb.build()).setWrap(true);
  }
  return { caseId: caseId, masterCol: c.masterCol, folderRow: folderRow, filesRow: filesRow, fileCount: files.length, folderUrl: azukari.getUrl() };
}

/**
 * パネル自己テスト: 全イベント列について「ラベル→物理列→案件ID」の解決チェーンを
 * 生成なしで一括検証する。パネル/同期/列構成を変えたら必ずこれを回す (2026-08-16 誤案件生成事故の再発防止)。
 */
function Panel_selfTest() {
  const ms = SpreadsheetApp.openById(_PANEL_MASTER_SS);
  const task = ms.getSheetByName('task');
  const appSheet = SpreadsheetApp.getActive().getSheetByName(CASE_LIST_SHEET_NAME);
  const appData = appSheet ? appSheet.getDataRange().getValues() : [];
  const MASTER_SS = _PANEL_MASTER_SS;
  const appRows = [];
  for (let i = 1; i < appData.length; i++) {
    if (String(appData[i][12]) !== MASTER_SS) continue;
    appRows.push({ caseId: String(appData[i][0]), client: String(appData[i][1] || ''), caseName: String(appData[i][2] || ''), masterCol: Number(appData[i][13]) || 0 });
  }
  const norm = function (x) { return String(x || '').normalize('NFC').toLowerCase().replace(/様$/, '').replace(/[\s　]+/g, '').replace(/＆/g, '&'); };
  const lastCol = task.getLastColumn();
  const width = Math.max(3, lastCol - 13 + 1);
  const clients = task.getRange(1, 13, 1, width).getValues()[0];
  const events = task.getRange(2, 13, 1, width).getValues()[0];
  const results = [];
  for (let bs = 13; bs + 2 <= lastCol; bs += 3) {
    const idx = bs - 13;
    const ev = String(events[idx] || '').replace(/\s+/g, ' ').trim();
    const cl = String(clients[idx] || '').replace(/\s+/g, ' ').trim();
    if (!ev) continue;
    const clientN = norm(cl), eventN = norm(ev).slice(0, 25);
    const cands = appRows.filter(function (r) { return norm(r.client) === clientN && (eventN === '' || norm(r.caseName).indexOf(eventN) === 0); });
    let method = '', caseId = '';
    if (cands.length === 1) { caseId = cands[0].caseId; method = 'name'; }
    else if (cands.length > 1) {
      const exact = cands.filter(function (r) { return r.masterCol === bs; })[0];
      caseId = (exact || cands[0]).caseId; method = exact ? 'name+col' : 'name(ambiguous)';
    } else {
      const byCol = appRows.filter(function (r) { return r.masterCol === bs; })[0];
      if (byCol) { caseId = byCol.caseId; method = 'masterColのみ(名前不一致⚠)'; }
      else method = '❌未同期';
    }
    const stored = appRows.filter(function (r) { return r.caseId === caseId; })[0];
    results.push({ col: bs, event: (cl + '/' + ev).slice(0, 30), caseId: caseId || '-', method: method, colDrift: stored ? (stored.masterCol !== bs) : false });
  }
  const eventMap = _Panel_eventMap(ms);
  const panels = ms.getSheets().filter(function (sheet) {
    try { return _Panel_isMarker(String(sheet.getRange('G1').getValue())); } catch (e) { return false; }
  }).map(function (sheet) {
    const label = String(sheet.getRange('G2').getValue() || '');
    const storedBlock = Number(sheet.getRange('G3').getValue()) || 0;
    // 実行時の案件解決は G2(イベントラベル) → 現在の物理列 → 名前照合 の順で行うので、
    // G3 のズレは NG ではなく「情報」。NG は「ラベルが task シートに存在しない」場合だけ。
    return {
      sheetName: sheet.getName(), eventLabel: label, storedBlock: storedBlock,
      currentBlock: eventMap[label] || 0,
      ok: Boolean(eventMap[label]),
      blockDrift: Boolean(eventMap[label]) && storedBlock !== eventMap[label]
    };
  });
  const bad = results.filter(function (r) { return r.method.indexOf('❌') === 0 || r.method.indexOf('⚠') >= 0; });
  return {
    total: results.length,
    ngCount: bad.length + panels.filter(function (p) { return !p.ok; }).length,
    drifted: results.filter(function (r) { return r.colDrift; }).length,
    panelCount: panels.length,
    panelBlockDrift: panels.filter(function (p) { return p.blockDrift; }).length,
    panels: panels, results: results
  };
}

/** E2Eテスト用: パネルの▶チェックと同じジョブを1件積む。 */
function Panel_simulateCheck(featureLabel, eventLabel) {
  const ms = SpreadsheetApp.openById(_PANEL_MASTER_SS);
  Panel_ensureCasePanel(eventLabel);
  const p = _Panel_findByLabel(ms, eventLabel);
  if (!p) throw new Error('パネルなし');
  const lastRow = p.getLastRow();
  const labels = p.getRange(PANEL_FIRST_FEATURE_ROW, 3, lastRow - PANEL_FIRST_FEATURE_ROW + 1, 1).getValues();
  for (let i = 0; i < labels.length; i++) {
    if (String(labels[i][0]) === featureLabel) {
      const row = PANEL_FIRST_FEATURE_ROW + i;
      const command = String(p.getRange(row, 7).getValue() || '');
      let args = [];
      try { args = JSON.parse(p.getRange(row, 8).getValue() || '[]'); } catch (e) {}
      const result = JobQueue_enqueue({ panelSheetName: p.getName(), row: row, requester: '', eventLabel: eventLabel, featureLabel: featureLabel, command: command, args: args, noCase: String(p.getRange(row, 9).getValue() || '') === '1' });
      if (!result.duplicate) p.getRange(row, 6).setValue('⏳ 順番待ち');
      return { row: row, feature: featureLabel, event: eventLabel, enqueue: result };
    }
  }
  throw new Error('機能行が見つからない: ' + featureLabel);
}
