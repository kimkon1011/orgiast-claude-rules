/**
 * Phase1: 見積 初版 を生成（B方式: 固定テンプレ + makeCopy + 管理画面記入 + 実施計画書作成）。
 *
 * 流れ:
 *  1) 見積テンプレ (ESTIMATE_TEMPLATE_ID) を案件 Drive フォルダに複製
 *  2) 価格表シートを Claude context に load
 *  3) Claude で明細案 + 案件情報 + 客様情報 + 確認事項を JSON 生成
 *  4) 管理画面シートに案件/客様情報を書き込み（ラベル検索ベース）
 *  5) 明細セクションにアイテム書き込み
 *  6) 実施計画書テンプレを案件フォルダに複製
 *  7) 実施計画書 URL を見積の管理画面（実施計画URL欄）に書き込み
 *  8) 確認事項を確認シートに積む
 */

const ESTIMATE_TEMPLATE_ID = '14AI5KO0VGHSG2arGKxTPqq_M82BpxlTn3kWeY5r2Rcs';
const ESTIMATE_PRICE_LIST_ID = '18Z6KHgEKNq1Okqx-fvoFmTgMVIBcmmMajhExk7csBWI';
const ESTIMATE_INTERNAL_STOCK_SHEET_NAME = '見積テンプレストック';

// legacy 統合用の定数（見積 bound script `14rDBGxVmN.../1vUBTHWC...` の global var から）
const LEGACY_ZISSI_TEMPLATE_ID = '1gtViI90jp32cnd93x-_x0USBVq6Ym72ZQyeUha6vIgI';
const LEGACY_TEISYUTU_TEMPLATE_ID = '1eVsrADlRFwxyoHzlgwqXUqDx3jwwrgNaHP-k5hi_h2U';
const LEGACY_APPROACH_LIST_FOLDER_ID = '0B4U7jwDkjHb_b2lsa1lFLUZZTkE'; // アプローチリストFOLDER[0]
const LEGACY_ANKEN_MASTER_URL = 'https://docs.google.com/spreadsheets/d/14RC6og1ma_I3LGHwCVwswKArgHwCOPxWlPB3g8adaYY/edit';

// カテゴリ別 プロジェクトフォルダコピー用テンプレ (プロジェクトフォルダコピー用FOLDER_V2 from legacy)
const LEGACY_PROJECT_FOLDER_TEMPLATES = {
  'イベント': '0B2MWlP7nRqQjazhjMzRqbGRrcUE',
  '映像制作': '1AfwRBSZLYffxQYTXfh3XxT5kE549ANeU',
  'WEB': '1AfwRBSZLYffxQYTXfh3XxT5kE549ANeU',
  'GRAPHIC': '1AfwRBSZLYffxQYTXfh3XxT5kE549ANeU',
  '取材・ライティング': '1AfwRBSZLYffxQYTXfh3XxT5kE549ANeU',
  'クリエイティブ全般': '1AfwRBSZLYffxQYTXfh3XxT5kE549ANeU',
  'その他': '1AfwRBSZLYffxQYTXfh3XxT5kE549ANeU'
};

const ESTIMATE_PRICE_RELEVANT_SHEETS = [
  '新）展示会ブース（木工パターン）',
  'Reブース初回価格表（2025.9）',
  'Reブース初回基礎コマプラン（2026.1）',
  'Reブース2回目テンプレート（2026.1）',
  'Reブース1カ月レンタル価格表',
  'Reブース　備品レンタル',
  '依頼費用(イベント用)',
  'アシスタント依頼単価'
];

// 管理画面シート（正式 or 仮）に記入するフィールド。Claude には客様情報・案件情報の埋め可能項目を出してもらう。
const ESTIMATE_MGMT_FIELDS = [
  '商品カテゴリ', 'サービス希望者', '担当者氏名', 'ヨミガナ', '所属部署',
  '役職', '電話番号', '携帯番号', 'メールアドレス', '郵便番号', '住所',
  '案件名', '希望納期', 'FAX', 'URL', '弊社担当', 'コード',
  '備考', '案件ルート', '内容', '初回訪問', '企画提出日',
  '場所', '進捗', '利用回数', 'Gmailアドレス'
];

function Phase1_Estimate_generate(caseId, pastedText) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);

  // 0) 実施計画書が既にある案件 → フォルダ/実施計画書の再作成はせず「見積のみ」生成
  //    (2026-07-12: 旧仕様は skip だったが、実行パネル/メニューから既存案件の見積が作れなかったため変更。
  //     zissi/フォルダの重複作成ガードとしての役割は EstimateOnly 側が担う)
  if (c.zissiId) {
    return Phase1_EstimateOnly_generate(caseId, pastedText);
  }

  // 1) テンプレ複製
  const templateFile = DriveApp.getFileById(ESTIMATE_TEMPLATE_ID);
  const newName = c.caseId + '_' + c.caseName + '_見積_初版';
  const caseFolder = DriveApp.getFolderById(c.folderId);
  const existingCopies = caseFolder.getFilesByName(newName);
  const hasExistingCopy = existingCopies.hasNext();
  const copy = hasExistingCopy ? existingCopies.next() : templateFile.makeCopy(newName, caseFolder);
  if (hasExistingCopy) console.log('既存を再利用: ' + newName);
  const ss = SpreadsheetApp.openById(copy.getId());

  const innerStockSheet = ss.getSheetByName(ESTIMATE_INTERNAL_STOCK_SHEET_NAME);
  if (innerStockSheet) {
    try { ss.deleteSheet(innerStockSheet); } catch (e) { /* 唯一なら削除不可 */ }
  }

  // 2) 価格表ロード
  const priceListText = _Estimate_loadPriceList();

  // 3) マニュアル
  const manualPages = ManualLoader_findPages([
    '見積書に売値をいれる',
    '原価の反映',
    '見積書をPDFにしてお客様へ送る'
  ]);
  const cachedContext = [
    Case_loadClientContext(c),
    '【関連マニュアル抜粋】',
    ...manualPages.map(p => '# ' + p.title + '\nパス: ' + p.path + '\n\n' + p.body),
    '【価格表抜粋】\n' + priceListText
  ].filter(Boolean);

  // 3.5) ヒアリング/議事録 (T列) — sales-app から書き込まれる顧客コンテキスト。あれば Claude prompt に追加。
  let hearingNotes = '';
  try {
    const appSheet = SpreadsheetApp.getActive().getSheetByName(CASE_LIST_SHEET_NAME);
    if (appSheet && appSheet.getLastRow() >= 2) {
      const data = appSheet.getRange(2, 1, appSheet.getLastRow() - 1, 20).getValues();
      for (let i = 0; i < data.length; i++) {
        if (String(data[i][0] || '').trim() === c.caseId) {
          // T列(顧客コンテキスト) 優先。M列は master 連携行では masterSsId が入っているため
          // スプレッドシートIDっぽい値は議事録として扱わない
          const tVal = String(data[i][19] || '').trim();
          const mVal = String(data[i][12] || '').trim();
          hearingNotes = tVal || (/^[a-zA-Z0-9_-]{30,60}$/.test(mVal) ? '' : mVal);
          break;
        }
      }
    }
  } catch (e) {
    console.warn('hearing notes load err: ' + e);
  }

  // 4) Claude 生成プロンプト
  const promptHeader = [
    '以下の展示会ブース案件について、見積の明細項目（初版）と管理画面の埋められる項目を提案してください。',
    '',
    '## 案件情報',
    '- クライアント: ' + c.clientName,
    '- 案件名: ' + c.caseName,
    '- 出展期間: ' + _fmtDate(c.startDate) + ' 〜 ' + _fmtDate(c.endDate),
    '- ブースサイズ: ' + (c.boothSize || '未確定'),
    '- 案件ID: ' + c.caseId,
    '',
  ];
  if (hearingNotes) {
    promptHeader.push('## ヒアリング/議事録 (この内容を最優先で 項目選定・数量・単位 に反映)');
    promptHeader.push(hearingNotes.slice(0, 8000));
    promptHeader.push('');
    promptHeader.push('上記の議事録から読み取れる以下を 見積項目に反映してください:');
    promptHeader.push('- 顧客が必要と言った機材/演出 → 該当項目を明細に追加');
    promptHeader.push('- 顧客が「不要」「やめる」と言った項目 → 明細から除外');
    promptHeader.push('- 開催日数・参加人数・予算上限 → 数量と単価で反映');
    promptHeader.push('- 議事録で明示的に言及が無い項目 → confirmations に「○○要確認」を入れる');
    promptHeader.push('');
  }
  if (String(pastedText || '').trim()) {
    promptHeader.push('## 📝貼付欄の直接指示（他の情報より優先）');
    promptHeader.push(String(pastedText).trim().slice(0, 12000));
    promptHeader.push('');
  }
  const userPrompt = promptHeader.concat([
    '## 出力形式（厳守・前後の説明文不要）',
    '{',
    '  "items": [',
    '    {"category": "イベント|運営・制作", "itemName": "...", "content": "...", "unitPrice": 60000, "qty": 1, "qtyUnit": "式", "note": "..."}',
    '  ],',
    '  "mgmt": {',
    '    "商品カテゴリ": "イベント",',
    '    "サービス希望者": "<クライアント名>",',
    '    "案件名": "<案件名>",',
    '    "弊社担当": "金功勇",',
    '    "コード": "<アルファベットのみ>",',
    '    "利用回数": "新規",',
    '    "案件ルート": "...",',
    '    "場所": "...",',
    '    "希望納期": "..."',
    '  },',
    '  "confirmations": [',
    '    {"category": "...", "content": "..."}',
    '  ]',
    '}',
    '',
    '## 重要ルール',
    '- 単価は「価格表抜粋」の該当項目から該当する価格を選んで設定すること。価格表にない場合は 0 にして confirmations に「○○の単価要確認」を入れる。',
    '- mgmt の項目は案件情報や価格表から確実に決められるもののみ記入。担当者氏名・電話・メールなどお客様情報は記入せず confirmations に「○○未取得」と入れること（捏造禁止）。',
    '- mgmt の弊社担当は不明なら空欄。コードはアルファベットのみ（例: CTKTSS）。',
    '- 利用回数は新規/2回目以降 を案件状況から判断。',
    '- qtyUnit は「式」「日」「人」など。',
    '- category は見積テンプレで使われる大分類「イベント」「運営・制作」など。',
    '- 議事録に記載がある場合は その内容を優先し、 一般論より具体的に。',
  ]).join('\n');

  const res = ClaudeClient_call({
    cachedContext: cachedContext,
    userMessage: userPrompt,
    maxTokens: 6000
  });

  const parsed = _Phase1_parseJson(res.text);
  const items = parsed.items || [];
  const mgmt = parsed.mgmt || {};

  // 5) 管理画面に案件/客様情報を書き込み
  const mgmtSheet = _Estimate_findMgmtSheet(ss);
  if (mgmtSheet) {
    _Estimate_fillMgmtFields(mgmtSheet, mgmt);
  }

  // 6) 明細セクションに書き込み
  //   - 開始行: ヘッダ + 4（ヘッダ／ガード／イベント placeholder／運営制作 placeholder の次）
  //   - 各行で 項目小計 (col L) と 消費税 (col M) に数式を明示的に設定
  const target = _Estimate_findDetailHeaderRow(ss);
  if (target) {
    const startRow = target.row + 4;
    items.forEach((it, idx) => {
      const row = startRow + idx;
      target.sheet.getRange(row, 1).setValue(it.category || '');
      target.sheet.getRange(row, 2).setValue(it.itemName || '');
      target.sheet.getRange(row, 3).setValue(it.content || '');
      if (it.note) target.sheet.getRange(row, 4).setValue(it.note);
      target.sheet.getRange(row, 5).setValue(it.unitPrice || 0);
      target.sheet.getRange(row, 6).setValue(it.qty || 1);
      target.sheet.getRange(row, 7).setValue(it.qtyUnit || '式');
      target.sheet.getRange(row, 12).setFormula('=E' + row + '*F' + row);   // 項目小計
      target.sheet.getRange(row, 13).setFormula('=L' + row + '*0.1');       // 消費税
    });
    // 7-pre) オプション欄のテンプレ既存項目（木槌レンタル等）をクリア
    _Estimate_clearOptionSection(target.sheet, startRow + items.length);
  }

  // 7) legacy 統合: アプローチリストFOLDER 下にプロジェクトフォルダ作成 + 見積を移動
  let projectFolderUrl = null;
  let projectFolderId = null;
  let zissiUrl = null;
  let teisyutuUrl = null;
  try {
    const approachList = DriveApp.getFolderById(LEGACY_APPROACH_LIST_FOLDER_ID);
    const category = (mgmt['商品カテゴリ'] || 'イベント');
    const projectFolderName = (mgmt['コード'] || c.caseId) + '_' + c.clientName + '_' + c.caseName;
    const existingProjectFolders = approachList.getFoldersByName(projectFolderName);
    const hasExistingProjectFolder = existingProjectFolders.hasNext();
    const projectFolder = hasExistingProjectFolder ? existingProjectFolders.next() : approachList.createFolder(projectFolderName);
    if (hasExistingProjectFolder) console.log('既存を再利用: ' + projectFolderName);
    projectFolderId = projectFolder.getId();
    projectFolderUrl = projectFolder.getUrl();

    // 見積を案件フォルダ (My Drive 配下) から legacy プロジェクトフォルダへ移動
    DriveApp.getFileById(copy.getId()).moveTo(projectFolder);

    // 見積の解説!B75 にプロジェクトフォルダID（legacy 慣習）
    const kaisetuSheet = ss.getSheetByName('解説');
    if (kaisetuSheet) {
      kaisetuSheet.getRange('B75').setValue(projectFolderId);
    }

    // 8) 実施計画書テンプレを複製 → legacy プロジェクトフォルダへ
    const zissiTemplate = DriveApp.getFileById(LEGACY_ZISSI_TEMPLATE_ID);
    const zissiName = (mgmt['コード'] || c.caseId) + '_' + c.caseName + '_実施計画書';
    const existingZissi = projectFolder.getFilesByName(zissiName);
    const hasExistingZissi = existingZissi.hasNext();
    const zissiCopy = hasExistingZissi ? existingZissi.next() : zissiTemplate.makeCopy(zissiName, projectFolder);
    if (hasExistingZissi) console.log('既存を再利用: ' + zissiName);
    const zissiSs = SpreadsheetApp.openById(zissiCopy.getId());
    zissiUrl = zissiSs.getUrl();

    // 9) 提出フォーマットテンプレを複製 → legacy プロジェクトフォルダへ
    const teisyutuTemplate = DriveApp.getFileById(LEGACY_TEISYUTU_TEMPLATE_ID);
    const teisyutuName = (mgmt['コード'] || c.caseId) + '_' + c.caseName + '_ご提出フォーマット';
    const existingTeisyutu = projectFolder.getFilesByName(teisyutuName);
    const hasExistingTeisyutu = existingTeisyutu.hasNext();
    const teisyutuCopy = hasExistingTeisyutu ? existingTeisyutu.next() : teisyutuTemplate.makeCopy(teisyutuName, projectFolder);
    if (hasExistingTeisyutu) console.log('既存を再利用: ' + teisyutuName);
    const teisyutuSs = SpreadsheetApp.openById(teisyutuCopy.getId());
    teisyutuUrl = teisyutuSs.getUrl();

    // 10) 実施計画書 settei シートに URL 群を埋め込み (legacy MakeZissiSS と同様)
    const settei = zissiSs.getSheetByName('settei');
    if (settei) {
      settei.getRange('B1').setValue(zissiUrl);      // 実施計画書URL
      settei.getRange('B3').setValue(ss.getUrl());   // 見積URL
      settei.getRange('B4').setValue(teisyutuUrl);   // 提出フォーマットURL
      settei.getRange('B6').setValue(projectFolderUrl); // 製作フォルダURL
    }

    // 11) 実施計画の task シートに 納品日 を埋め込み (legacy MakeZissiSS line 514-)
    const taskSheet = zissiSs.getSheetByName('task');
    if (taskSheet) {
      const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd');
      taskSheet.getRange('E6').setValue(today);
      taskSheet.getRange('E10').setValue(today);
      if (c.endDate) {
        const nouki = (c.endDate instanceof Date)
          ? Utilities.formatDate(c.endDate, 'Asia/Tokyo', 'yyyy/MM/dd')
          : String(c.endDate);
        taskSheet.getRange('S2').setValue(nouki);
      }
    }

    // 12) 管理画面の「実施計画URL」フィールドにも書き込み
    if (mgmtSheet) _Estimate_fillMgmtFields(mgmtSheet, { '実施計画URL': zissiUrl });

    // 12.5) 案件一覧の K列(実施計画書ID)・L列(プロジェクトフォルダID) に保存
    //       → ③ スケジュール生成がこの実施計画書を直接開けるようにする
    CaseList_setZissiInfo(caseId, zissiCopy.getId(), projectFolderId);

    // 案件一覧 master 登録 (legacy AddtoYosanUrl 相当の最小実装)
    const ankenRegistered = _Estimate_registerInAnkenMaster({
      clientName: c.clientName,
      caseName: c.caseName,
      mitumoriUrl: ss.getUrl(),
      zissiUrl: zissiUrl
    });
    if (ankenRegistered === true) {
      parsed.confirmations = (parsed.confirmations || []).concat([{
        category: '見積/案件マスタ',
        content: '案件マスタ ' + LEGACY_ANKEN_MASTER_URL + ' に新規行を追加しました。予算項目セルは隣接行から自動継承。確認・修正してください。'
      }]);
    } else {
      parsed.confirmations = (parsed.confirmations || []).concat([{
        category: '見積/案件マスタエラー',
        content: '案件マスタ登録失敗: ' + ankenRegistered
      }]);
    }
  } catch (e) {
    // legacy 統合に失敗しても見積生成は続行
    parsed.confirmations = (parsed.confirmations || []).concat([{
      category: '見積/legacy統合エラー',
      content: 'プロジェクトフォルダ作成/実施計画複製で失敗: ' + e.toString()
    }]);
  }

  // 8) 確認事項
  if (parsed.confirmations && parsed.confirmations.length > 0) {
    ConfirmationSheet_appendItems(caseId, parsed.confirmations.map(x => ({
      ...x, category: '見積/' + (x.category || '')
    })), 1);
  }
  CaseList_touchUpdatedAt(caseId);

  MasterWriteBack_recordArtifact(caseId, '見積', '見積初版', ss.getUrl());
  if (zissiUrl) MasterWriteBack_recordArtifact(caseId, '実施計画書', '実施計画書', zissiUrl);

  let costProfitQueued = false;
  try { costProfitQueued = _CostProfit_enqueue(caseId); } catch (e) {}

  return {
    estimateSheetUrl: ss.getUrl(),
    projectFolderUrl: projectFolderUrl,
    zissiSheetUrl: zissiUrl,
    teisyutuSheetUrl: teisyutuUrl,
    itemCount: items.length,
    mgmtFilledCount: Object.keys(mgmt).length,
    confirmationCount: (parsed.confirmations || []).length,
    headerRow: target ? target.row : null,
    detailSheetName: target ? target.sheet.getName() : null,
    mgmtSheetName: mgmtSheet ? mgmtSheet.getName() : null,
    usage: res.usage,
    costProfit: { queued: costProfitQueued }
  };
}

// -------- internals --------

function _Estimate_loadPriceList() {
  const ss = SpreadsheetApp.openById(ESTIMATE_PRICE_LIST_ID);
  const sheets = ss.getSheets();
  const out = [];
  ESTIMATE_PRICE_RELEVANT_SHEETS.forEach(name => {
    const sheet = sheets.find(function (s) { return s.getName() === name; });
    if (!sheet) return;
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    if (lastRow === 0 || lastCol === 0) return;
    const values = sheet.getRange(1, 1, Math.min(lastRow, 200), Math.min(lastCol, 12)).getValues();
    const text = values.map(function (row) {
      return row.map(function (v) { return String(v); }).join('\t');
    }).filter(function (line) { return line.replace(/[\t\s]/g, '').length > 0; }).join('\n');
    out.push('### ' + name + '\n' + text);
  });
  return out.join('\n\n');
}

function _Estimate_findDetailHeaderRow(ss) {
  const sheets = ss.getSheets();
  for (let s = 0; s < sheets.length; s++) {
    const sheet = sheets[s];
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) continue;
    const lastCol = Math.min(sheet.getLastColumn(), 14);
    if (lastCol < 5) continue;
    const data = sheet.getRange(1, 1, lastRow, lastCol).getValues();
    for (let r = 0; r < data.length; r++) {
      if (data[r][0] === 'カテゴリ' && data[r][1] === '項目' && data[r][4] === '単価') {
        return { sheet: sheet, row: r + 1 };
      }
    }
  }
  return null;
}

function _Estimate_registerInAnkenMaster(payload) {
  // legacy AddtoYosanUrl の setList 構造を踏襲し、案件マスタの案件一覧シート2行目に新規行を挿入。
  // setList 9列: [予算項目, "アプローチリスト", 顧客名, 実施計画URL, 見積URL, 範囲指定, vlookup式, countif式, importrange式]
  try {
    const target = SpreadsheetApp.openByUrl(LEGACY_ANKEN_MASTER_URL);
    const sheet = target.getSheetByName('案件一覧');
    if (!sheet) return '案件一覧 シートが見つかりません: ' + LEGACY_ANKEN_MASTER_URL;

    // 予算項目: 既存3行目の A列を継承（同じ期を使う）
    let yosanName = '';
    try { yosanName = String(sheet.getRange(3, 1).getValue() || ''); } catch (e) { /* keep empty */ }

    sheet.insertRowsBefore(2, 1);
    sheet.getRange(2, 1, 1, 9).setValues([[
      yosanName,
      'アプローチリスト',
      payload.clientName || '',
      payload.zissiUrl || '',
      payload.mitumoriUrl || '',
      '管理画面（正式）※シート名変更禁止!A2:AE2',
      "=vlookup(E2, '請求コードチェック'!A:P, 16, false)",
      '=countif(E:E, E2)',
      '=importrange(indirect("E"&row()),indirect("F"&row()))'
    ]]);
    try {
      sheet.getRange('BG2:CF2').setBorder(true, true, true, true, true, true);
    } catch (e) { /* 罫線失敗は無視 */ }
    SpreadsheetApp.flush();
    return true;
  } catch (e) {
    return e.toString();
  }
}

function _Estimate_clearOptionSection(sheet, fromRow) {
  // 「オプション」見出し行を fromRow 以降で探し、その下から次の「項目計」行の手前まで
  // 明細列（A〜G）をクリア。テンプレデフォルトの木槌レンタル等を削除する目的。
  // セル結合があっても拾えるよう全列をスキャンして文字列結合で判定する。
  const lastRow = sheet.getLastRow();
  if (lastRow <= fromRow) return;
  const lastCol = Math.min(sheet.getLastColumn(), 14);
  if (lastCol < 1) return;
  const range = sheet.getRange(fromRow, 1, lastRow - fromRow + 1, lastCol).getValues();
  let optRow = -1;
  let nextKei = -1;
  for (let i = 0; i < range.length; i++) {
    const rowText = range[i].map(function (v) { return String(v || ''); }).join(' ');
    if (optRow < 0 && rowText.indexOf('オプション') >= 0) {
      optRow = fromRow + i;
      continue;
    }
    if (optRow > 0 && rowText.indexOf('項目計') >= 0) {
      nextKei = fromRow + i;
      break;
    }
  }
  if (optRow > 0 && nextKei > optRow + 1) {
    sheet.getRange(optRow + 1, 1, nextKei - optRow - 1, 7).clearContent();
  }
}

function _Estimate_findMgmtSheet(ss) {
  // 「サービス希望者」「商品カテゴリ」が縦並びで A 列に並んでいるシート（管理画面（正式））を検出
  const sheets = ss.getSheets();
  for (let s = 0; s < sheets.length; s++) {
    const sheet = sheets[s];
    const lastRow = sheet.getLastRow();
    if (lastRow < 5) continue;
    const data = sheet.getRange(1, 1, lastRow, 1).getValues();
    let svcRow = -1, catRow = -1;
    for (let r = 0; r < data.length; r++) {
      if (data[r][0] === 'サービス希望者') svcRow = r;
      if (data[r][0] === '商品カテゴリ') catRow = r;
    }
    if (svcRow >= 0 && catRow >= 0) return sheet;
  }
  return null;
}

function _Estimate_fillMgmtFields(sheet, mgmt) {
  // ラベルを A 列で検索し、その同じ行の B 列に値を書き込む
  const lastRow = sheet.getLastRow();
  if (lastRow < 1) return 0;
  const labels = sheet.getRange(1, 1, lastRow, 1).getValues();
  let written = 0;
  Object.keys(mgmt).forEach(function (key) {
    const value = mgmt[key];
    if (value === undefined || value === null || value === '') return;
    for (let r = 0; r < labels.length; r++) {
      if (labels[r][0] === key) {
        sheet.getRange(r + 1, 2).setValue(value);
        written++;
        break;
      }
    }
  });
  return written;
}

/**
 * 見積のみ生成（既存案件用）。 実施計画書 / プロジェクトフォルダは作らない。
 * 実行パネル・メニューから 既に立ち上がっている案件の見積を作りたい時に使う。
 * 出力先: 案件のプロジェクトフォルダ (無ければ案件フォルダ)。 ファイル名に日時を付けて重複回避。
 */
function Phase1_EstimateOnly_generate(caseId, pastedText) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);

  // 1) テンプレ複製 → 既存プロジェクトフォルダへ
  const destFolderId = Case_resolveProjectRoot(c);
  if (!destFolderId) throw new Error('案件フォルダが未設定です (案件一覧 L列)。先に「master → アプリ 同期」を実行してください。');
  const stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'MMdd_HHmm');
  const newName = c.caseId + '_' + c.caseName + '_見積_' + stamp;
  const copy = DriveApp.getFileById(ESTIMATE_TEMPLATE_ID).makeCopy(newName, DriveApp.getFolderById(destFolderId));
  const ss = SpreadsheetApp.openById(copy.getId());
  const innerStockSheet = ss.getSheetByName(ESTIMATE_INTERNAL_STOCK_SHEET_NAME);
  if (innerStockSheet) { try { ss.deleteSheet(innerStockSheet); } catch (e) {} }

  // 2) 価格表 + マニュアル
  const priceListText = _Estimate_loadPriceList();
  const manualPages = ManualLoader_findPages(['見積書に売値をいれる', '原価の反映', '見積書をPDFにしてお客様へ送る']);
  const cachedContext = [
    Case_loadClientContext(c),
    '【関連マニュアル抜粋】',
    ...manualPages.map(p => '# ' + p.title + '\nパス: ' + p.path + '\n\n' + p.body),
    '【価格表抜粋】\n' + priceListText
  ].filter(Boolean);

  // 3) Claude 生成 (新規版と同じ出力形式)
  const userPrompt = [
    '以下の展示会ブース案件について、見積の明細項目と管理画面の埋められる項目を提案してください。',
    '',
    '## 案件情報',
    '- クライアント: ' + c.clientName,
    '- 案件名: ' + c.caseName,
    '- 出展期間: ' + _fmtDate(c.startDate) + ' 〜 ' + _fmtDate(c.endDate),
    '- ブースサイズ: ' + (c.boothSize || '未確定'),
    '- 案件ID: ' + c.caseId,
    '',
    String(pastedText || '').trim() ? '## 📝貼付欄の直接指示（他の情報より優先）\n' + String(pastedText).trim().slice(0, 12000) + '\n' : '',
    '## 出力形式（厳守・前後の説明文不要）',
    '{',
    '  "items": [',
    '    {"category": "イベント|運営・制作", "itemName": "...", "content": "...", "unitPrice": 60000, "qty": 1, "qtyUnit": "式", "note": "..."}',
    '  ],',
    '  "mgmt": { "商品カテゴリ": "イベント", "サービス希望者": "<クライアント名>", "案件名": "<案件名>", "弊社担当": "金功勇", "コード": "<アルファベットのみ>", "利用回数": "2回目以降", "案件ルート": "...", "場所": "...", "希望納期": "..." },',
    '  "confirmations": [ {"category": "...", "content": "..."} ]',
    '}',
    '',
    '## 重要ルール',
    '- 単価は「価格表抜粋」から選ぶ。無い場合は 0 + confirmations に「○○の単価要確認」。',
    '- お客様の担当者情報は捏造せず confirmations に「○○未取得」。',
    '- qtyUnit は「式」「日」「人」など。 category は「イベント」「運営・制作」など。'
  ].join('\n');

  const res = ClaudeClient_call({ cachedContext: cachedContext, userMessage: userPrompt, maxTokens: 6000 });
  const parsed = _Phase1_parseJson(res.text);
  const items = parsed.items || [];
  const mgmt = parsed.mgmt || {};

  // 4) 管理画面 + 明細書き込み (新規版と同一手順)
  const mgmtSheet = _Estimate_findMgmtSheet(ss);
  let mgmtFilled = 0;
  if (mgmtSheet) mgmtFilled = _Estimate_fillMgmtFields(mgmtSheet, mgmt);
  const target = _Estimate_findDetailHeaderRow(ss);
  if (target) {
    const startRow = target.row + 4;
    items.forEach((it, idx) => {
      const row = startRow + idx;
      target.sheet.getRange(row, 1).setValue(it.category || '');
      target.sheet.getRange(row, 2).setValue(it.itemName || '');
      target.sheet.getRange(row, 3).setValue(it.content || '');
      if (it.note) target.sheet.getRange(row, 4).setValue(it.note);
      target.sheet.getRange(row, 5).setValue(it.unitPrice || 0);
      target.sheet.getRange(row, 6).setValue(it.qty || 1);
      target.sheet.getRange(row, 7).setValue(it.qtyUnit || '式');
      target.sheet.getRange(row, 12).setFormula('=E' + row + '*F' + row);
      target.sheet.getRange(row, 13).setFormula('=L' + row + '*0.1');
    });
    _Estimate_clearOptionSection(target.sheet, startRow + items.length);
  }

  // 5) 確認事項 + 生成物記録
  const confirmations = parsed.confirmations || [];
  if (confirmations.length > 0) {
    try { ConfirmationSheet_appendItems(caseId, confirmations, '[見積]'); } catch (e) {}
  }
  const url = ss.getUrl();
  try { MasterWriteBack_recordArtifact(caseId, '見積', newName, url); } catch (e) {}
  CaseList_touchUpdatedAt(caseId);

  let costProfitQueued = false;
  try { costProfitQueued = _CostProfit_enqueue(caseId); } catch (e) {}

  return {
    url: url,
    estimateSheetUrl: url,
    itemCount: items.length,
    mgmtFilledCount: mgmtFilled,
    confirmationCount: confirmations.length,
    usage: res.usage,
    costProfit: { queued: costProfitQueued }
  };
}
