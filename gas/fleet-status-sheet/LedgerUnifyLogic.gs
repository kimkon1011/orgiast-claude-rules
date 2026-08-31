const LEDGER_UNIFIED_PREFIX_ = '【移行済】';
// 移行元の稼働状況タブは実名が 'Untitled' で、台帳に入れても中身が分からない。
// 台帳側では人が読める名前に統一する(タブ探索はヘッダ一致なので改名しても壊れない)。
const LEDGER_FLEET_TAB_NAME_ = 'PC稼働状況';

function unifyLegacyTabName(name) {
  var value = String(name || '');
  return value.indexOf(LEDGER_UNIFIED_PREFIX_) === 0 ? value : LEDGER_UNIFIED_PREFIX_ + value;
}

// 移行先での名前。稼働状況タブだけ改名し、他はそのままの名前で移す。
function unifyDestTabName(name, fleetTabName) {
  return fleetTabName && name === fleetTabName ? LEDGER_FLEET_TAB_NAME_ : name;
}

function unifyPlanTabs(srcTabNames, destTabNames, targets, fleetTabName) {
  var src = Array.isArray(srcTabNames) ? srcTabNames : [];
  var dest = Array.isArray(destTabNames) ? destTabNames : [];
  var wanted = Array.isArray(targets) ? targets : [];
  var toCopy = [];
  var toSkip = [];
  wanted.forEach(function(name) {
    // 冪等性は「移行先に置いたときの名前」で判定する。元の名前で見ると改名済みのタブを二重に作る。
    if (src.indexOf(name) < 0 || name.indexOf(LEDGER_UNIFIED_PREFIX_) === 0 ||
        dest.indexOf(unifyDestTabName(name, fleetTabName)) >= 0) {
      toSkip.push(name);
    } else {
      toCopy.push(name);
    }
  });
  return { toCopy: toCopy, toSkip: toSkip };
}

function _ledgerIndexTimestamp_() {
  var parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date());
  var values = {};
  parts.forEach(function(part) { values[part.type] = part.value; });
  return values.year + '-' + values.month + '-' + values.day + ' ' + values.hour + ':' + values.minute + ' JST';
}

function buildIndexRows(tabNames, ledgerId, pcInventoryId, legacyFleetId) {
  var names = Array.isArray(tabNames) ? tabNames : [];
  var fleetName = names.filter(function(name) {
    return name && name !== '目次' && name !== 'プロジェクト所在地図' && name !== 'クラウド契約' &&
      name !== 'PCログイン' && name !== '拡張機能監査' && name.indexOf(LEDGER_UNIFIED_PREFIX_) !== 0;
  })[0] || LEDGER_FLEET_TAB_NAME_;
  var inventoryUrl = pcInventoryId
    ? 'https://docs.google.com/a/orgiast.jp/spreadsheets/d/' + pcInventoryId + '/edit'
    : '(未設定)';
  var legacyUrl = 'https://docs.google.com/a/orgiast.jp/spreadsheets/d/' + legacyFleetId + '/edit';
  return [
    ['オージャスト クラウド契約・プロジェクト台帳 ｜ このスプレッドシートだけ見れば全部わかる', '', '', '', ''],
    ['最終更新(自動): ' + _ledgerIndexTimestamp_(), '', '', '', ''],
    ['', '', '', '', ''],
    ['タブ名', '1行の単位', '何が分かるか', '誰が書くか', '更新タイミング'],
    ['目次', '–', 'このシートの案内', '機械', '統合ジョブ実行時'],
    ['プロジェクト所在地図', '1プロジェクト', 'どのリポ/Vercel/本番URL/どのPCで開発しているか', '機械(project-locator) + 人', 'kim機で実行時'],
    ['クラウド契約', '1契約', '何を契約していて誰のアカウントか・支払い元', '人 + 機械(検出済みフラグ)', '随時'],
    ['PCログイン', 'PC×サービス', '各PCがどのクラウドにログインしているか', '全PCが自己申告', '毎日夜間'],
    [fleetName, '1PC', '各PCの稼働状態・Claudeコスト・委譲率・開発中プロジェクト', '全PCが自己申告 + 人', '毎日夜間 / 毎朝09:23'],
    ['拡張機能監査', 'PC×ブラウザ×拡張', '各PCのブラウザ拡張とリスク', '全PCが自己申告', '毎日夜間'],
    ['Discordチャンネル', '1チャンネル', 'Discord のチャンネル名とチャンネルID・何のチャンネルか', '機械(discord-channel-ledger) + 人', '随時'],
    ['Webhook', '1webhook', 'どの通知先がどのチャンネル用か・生きているか（URLは載せない）', '全PCが自己申告 + 人', '毎日夜間'],
    ['APIクライアント(DWD)', '1クライアント', 'どのサービスアカウントに Google のどのデータへの委任を与えているか', '人(管理コンソールを見て追記)', '随時'],
    ['列名に【手入力】が付いた列は人が自由に書ける欄です。機械は絶対に上書きしません。', '', '', '', ''],
    ['', '', '', '', ''],
    ['関連する外部シート・画面', '', '', '', ''],
    ['名前', 'URL', '内容', '', ''],
    ['PC管理表(備品管理表関係データ保管用)', inventoryUrl, '各PCのハードウェアスペック。別ブック(seisaku-team 所有)', '', ''],
    ['旧・オージャストAI設定 実施状況＆整合性チェック', legacyUrl, '移行元。参照のみ・更新されない', '', '']
  ];
}
