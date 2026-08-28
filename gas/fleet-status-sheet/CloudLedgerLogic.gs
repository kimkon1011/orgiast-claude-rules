var CLOUD_PROJECT_HEADERS_ = ['プロジェクト名','用途・説明','GitHubリポジトリ','GitHubアカウント','可視性','本番URL','Vercelプロジェクト','Vercelアカウント/チーム','Supabaseプロジェクト','GASスクリプトID','関連スプレッドシート','開発PC','ローカルパス(basename)','最終コミット','状態','備考','更新日時(JST)'];
var CLOUD_CONTRACT_HEADERS_ = ['サービス','アカウント(ログインID)','プラン','月額(税込)','通貨','支払い元カード(下4桁)','支払い元(名義)','契約者・管理者','用途','関連プロジェクト','管理画面URL','請求サイクル','次回更新日','解約可否メモ','最終確認日','自動検出'];
var CLOUD_LOGIN_HEADERS_ = ['PC名/ホスト名','実ホスト名','OSユーザー名','サービス','ログインアカウント','スコープ/組織','検出元','状態','CLIバージョン','最終報告(JST)'];

function cloudNonEmpty(value) {
  return value !== '' && value !== null && value !== undefined;
}
function cloudColumn(headers, name, required) {
  var index = fleetFindHeaderIndex(headers, name);
  if (required && index < 0) throw new Error('required header not found: ' + name);
  return index;
}
function cloudMergeLabels(existing, label) {
  var values = String(existing == null ? '' : existing)
    .split(',')
    .map(function(value) { return value.trim(); })
    .filter(Boolean);
  var next = String(label == null ? '' : label).trim();
  if (next && values.indexOf(next) < 0) values.push(next);
  return values.join(', ');
}
function cloudPlanLoginReplace(headers, rows, payload) {
  var label = String(payload && payload.label || '').trim();
  if (!label) throw new Error('label_required');
  var columns = {};
  CLOUD_LOGIN_HEADERS_.forEach(function(name) {
    columns[name] = cloudColumn(headers, name, true);
  });
  var deleteRowNumbers = [];
  rows.forEach(function(row, index) {
    if (String(row[columns['PC名/ホスト名']] || '').trim() === label) {
      deleteRowNumbers.push(index + 2);
    }
  });
  var appendRows = (Array.isArray(payload.rows) ? payload.rows : []).map(function(item) {
    var output = headers.map(function() { return ''; });
    var values = {
      'PC名/ホスト名': label, '実ホスト名': payload.hostname, 'OSユーザー名': payload.username,
      'サービス': item.service, 'ログインアカウント': item.account, 'スコープ/組織': item.scope,
      '検出元': item.source, '状態': item.status || '判定不能', 'CLIバージョン': item.version,
      '最終報告(JST)': payload.reportedAt
    };
    Object.keys(values).forEach(function(name) {
      if (cloudNonEmpty(values[name])) output[columns[name]] = values[name];
    });
    return output;
  });
  return { deleteRowNumbers: deleteRowNumbers, appendRows: appendRows };
}

function cloudPlanProjectUpsert(headers, rows, payload) {
  // 人が管理する列は許可リストから外すことで、列順が変わっても構造的に守る。
  var allowed = {'プロジェクト名':'project','GitHubリポジトリ':'repo','GitHubアカウント':'ghAccount','可視性':'visibility','本番URL':'prodUrl','Vercelプロジェクト':'vercelProject','Vercelアカウント/チーム':'vercelScope','開発PC':'devPc','ローカルパス(basename)':'localName','最終コミット':'lastCommit','更新日時(JST)':'updatedAt'};
  var repoCol = cloudColumn(headers, 'GitHubリポジトリ', true);
  var nameCol = cloudColumn(headers, 'プロジェクト名', true);
  var updates = [];
  var appendRows = [];
  (Array.isArray(payload.projects) ? payload.projects : []).forEach(function(item) {
    var repo = String(item.repo || '').trim();
    var name = String(item.project || '').trim();
    var index = -1;
    if (repo) index = rows.findIndex(function(row) { return String(row[repoCol] || '').trim() === repo; });
    if (index < 0 && !repo && name) {
      index = rows.findIndex(function(row) {
        return String(row[repoCol] || '').trim() === '' && String(row[nameCol] || '').trim() === name;
      });
    }
    if (index < 0) {
      var output = headers.map(function() { return ''; });
      Object.keys(allowed).forEach(function(header) {
        var value = item[allowed[header]];
        if (cloudNonEmpty(value)) output[cloudColumn(headers, header, true)] = value;
      });
      appendRows.push(output);
      return;
    }
    Object.keys(allowed).forEach(function(header) {
      var col = cloudColumn(headers, header, true);
      var value = item[allowed[header]];
      if (header === '開発PC' && cloudNonEmpty(value)) value = cloudMergeLabels(rows[index][col], value);
      // 取得失敗時の空値で既存セルを潰さず、取得できた機械値だけを最新化する。
      if (cloudNonEmpty(value)) {
        updates.push({ rowNumber: index + 2, columnIndex: col + 1, value: value });
      }
    });
  });
  return { updates: updates, appendRows: appendRows };
}

function cloudPlanContractUpsert(headers, rows, payload) {
  // カード等の人の列は許可リストに含めず、機械からは書けない構造にする。
  var allowed = {'サービス':'service','アカウント(ログインID)':'account','プラン':'plan','月額(税込)':'monthlyAmount','通貨':'currency','契約者・管理者':'administrator','用途':'purpose','関連プロジェクト':'projects','管理画面URL':'adminUrl','請求サイクル':'billingCycle','次回更新日':'renewalDate','解約可否メモ':'cancelMemo','最終確認日':'checkedAt','自動検出':'detected'};
  var serviceCol = cloudColumn(headers, 'サービス', true);
  var accountCol = cloudColumn(headers, 'アカウント(ログインID)', true);
  var updates = [];
  var appendRows = [];
  (Array.isArray(payload.contracts) ? payload.contracts : [payload]).forEach(function(item) {
    var service = String(item.service || '').trim();
    var account = String(item.account || '').trim();
    if (!service) return;
    var index = rows.findIndex(function(row) { return String(row[serviceCol] || '').trim() === service && String(row[accountCol] || '').trim() === account; });
    if (index < 0) {
      var output = headers.map(function() { return ''; });
      Object.keys(allowed).forEach(function(header) {
        var value = item[allowed[header]];
        if (cloudNonEmpty(value)) output[cloudColumn(headers, header, true)] = value;
      });
      appendRows.push(output);
      return;
    }
    Object.keys(allowed).forEach(function(header) {
      if (header === 'サービス' || header === 'アカウント(ログインID)') return;
      var value = item[allowed[header]];
      var col = cloudColumn(headers, header, true);
      if (cloudNonEmpty(value) && (payload.force === true || !cloudNonEmpty(rows[index][col]))) {
        updates.push({ rowNumber: index + 2, columnIndex: col + 1, value: value });
      }
    });
  });
  return { updates: updates, appendRows: appendRows };
}

function cloudPlanContractSeed(headers, rows, discovered, today) {
  var contracts = (Array.isArray(discovered) ? discovered : [])
    .filter(function(item) { return cloudNonEmpty(item.account); })
    .map(function(item) {
      return { service: item.service, account: item.account, checkedAt: today, detected: '検出済み' };
    });
  return cloudPlanContractUpsert(headers, rows, { force: true, contracts: contracts });
}
