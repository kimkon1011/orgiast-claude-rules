/**
 * Phase3: 入稿データチェック を生成。
 *
 * 目的:
 *   印刷物 (壁面グラフィック / 看板 / ロゴボックス / LEDUP / バナー 等) を入稿する前に、
 *   Claude が PDF の内容を読んで誤字脱字・案件情報の整合性・連絡先誤記・サイズ表記等を指摘する。
 *
 * 入稿 PDF 探索:
 *   1) projectFolder 配下のサブフォルダで「入稿」「印刷」「最終データ」「制作物」「デザイン」「校了」を含むものから PDF を採集
 *   2) 上記が見つからなければ 預かり素材 配下 → さらに無ければ案件フォルダ直下の PDF
 *   3) マニュアル/申込/申請系 PDF は除外
 *   4) 最大 5 ファイル (token / レイテンシ抑制)
 *
 * 出力:
 *   zissi 内に「Claude_入稿データチェック」シート を作成 (or 上書き):
 *     A 制作物名 / B 重要度 / C カテゴリ / D 指摘内容 / E 修正案 / F 確認状況
 */

const NYUKO_CHECK_SHEET_NAME = 'Claude_入稿データチェック';
const NYUKO_CHECK_HEADERS = ['制作物名', '重要度', 'カテゴリ', '指摘内容', '修正案', '確認状況'];
const _NYUKO_FOLDER_KEYWORDS = ['入稿', '印刷', '最終データ', '最終', '制作物', 'デザイン', '校了', 'プリント', 'グラフィック', 'final', 'Final', 'FINAL', 'data'];
const _NYUKO_FILENAME_EXCLUDES = [
  '出展マニュアル', '主催者', '出展規定', '出展ガイド', 'マニュアル_', 'manual_',
  '申請', '申込', '提出フォーマット'
];

function Phase3_NyukoCheck_generate(caseId) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);

  // 実施計画書取得 (出力先)
  let zissiSs = null;
  if (c.zissiId) {
    try { zissiSs = SpreadsheetApp.openById(c.zissiId); } catch (e) {}
  }
  if (!zissiSs) {
    try {
      const folder = DriveApp.getFolderById(c.projectFolderId || c.folderId);
      const files = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
      while (files.hasNext()) {
        const f = files.next();
        if (f.getName().indexOf('実施計画書') >= 0 && f.getName().indexOf('提出') < 0) {
          zissiSs = SpreadsheetApp.openById(f.getId());
          break;
        }
      }
    } catch (e) {}
  }
  if (!zissiSs) {
    throw new Error('実施計画書が見つかりません。');
  }

  // 入稿 PDF を収集
  const nyukoPdfs = _Phase3_collectNyukoPdfs(c);
  if (nyukoPdfs.length === 0) {
    throw new Error('入稿対象 PDF が見つかりません。projectFolder 配下に「入稿」「印刷」「制作物」「最終データ」名のサブフォルダ＋PDFを置くか、案件フォルダ直下に入稿 PDF を置いてください。');
  }

  // アイテムリスト / 確認シート / 修正要望シート など参照可能なら context に追加
  const cachedContext = [
    Case_loadClientContext(c),
    _Phase3_loadProjectInfoContext(c),
    _Phase3_loadItemListContext(zissiSs)
  ].filter(Boolean);

  const userPrompt = [
    '以下の展示会ブース案件の入稿予定 PDF を、印刷前のチェック観点で精査し、修正が必要な箇所を全て列挙してください。',
    '',
    '## 案件情報',
    '- クライアント: ' + c.clientName,
    '- 案件名: ' + c.caseName,
    '- 出展期間: ' + _fmtDate(c.startDate) + ' 〜 ' + _fmtDate(c.endDate),
    '- ブースサイズ: ' + (c.boothSize || '未確定'),
    '- 許容される最大の造作範囲: ' + (_Phase1_insetBoothSize(c.boothSize, _PHASE1_BOOTH_INSET_MM) || '小間実寸が不明（要確認）。小間実寸から四方100mm内側'),
    '',
    '## チェック観点（必ず全観点を確認）',
    '1. **誤字脱字**: クライアント社名・展示会名・キャッチコピー・本文の typo / 半角全角の混在 / 不要なスペース',
    '2. **案件情報の整合性**: クライアント名/イベント名/会場/日付/小間番号 が案件情報と一致するか',
    '3. **連絡先**: 電話番号 / メール / URL / QR コードのドメイン と公式情報の食い違い',
    '4. **ロゴ・社名表記**: 株式会社・(株)・正式社名 のゆれ。商標表記 (®/™) の有無',
    '5. **サイズ表記**: パネル/グラフィックの寸法表記が他制作物と矛盾しないか',
    '6. **画像品質の懸念**: 視認できる範囲で解像度低そう/ジャギー/ブロックノイズが見える箇所',
    '7. **色味・カラーモード**: 明らかな RGB 想定の鮮やかすぎる色 / CMYK 印刷で変色しそうな箇所',
    '8. **塗り足し・トンボ**: 端まで色やデザインが伸びているが塗り足しが足りない可能性',
    '9. **不適切な内容**: 別案件のロゴ・テキスト混入、テストデータ残置 (lorem ipsum / ダミー画像)',
    '10. **その他のリスク**: ハレーション/ハーフトーン化/小サイズ文字 (4pt 未満) など',
    '11. **小間実寸からの逃げ**: 図面・レイアウトを含む資料では、造作が小間実寸から四方100mm内側に収まっているか。収まっていなければ severity=high',
    '',
    '## 出力形式（厳守・前後の説明文や ```json``` ブロック禁止・JSON 単体）',
    '{',
    '  "checks": [',
    '    {',
    '      "pdfLabel": "<該当 PDF のファイル名>",',
    '      "severity": "high|mid|low",',
    '      "category": "<上記カテゴリのいずれか>",',
    '      "issue": "<具体的な指摘 (ページ番号や位置がわかれば明記)>",',
    '      "suggestion": "<どう直すべきか具体的に>"',
    '    }',
    '  ],',
    '  "summary": "<全体所感を 200 字以内>"',
    '}',
    '',
    '注意:',
    '- 推測でなく PDF から実際に観察できた事項のみ書く。判断つかない場合は severity=low + issue 末尾に「※要確認」と記載。',
    '- 問題がなければ checks は空配列で良い。summary には「問題は確認できず」と書く。',
    '- 各 PDF 1 件あたりの指摘は重要度高いものから順に並べる。'
  ].join('\n');

  const res = ClaudeClient_call({
    cachedContext: cachedContext,
    userMessage: userPrompt,
    documents: nyukoPdfs.map(function (p) { return { driveFileId: p.driveFileId, label: p.label }; }),
    maxTokens: 6000
  });

  const parsed = _Phase1_parseJson(res.text);
  const checks = parsed.checks || [];

  // 出力シート
  let outSheet = zissiSs.getSheetByName(NYUKO_CHECK_SHEET_NAME);
  if (!outSheet) {
    try { outSheet = zissiSs.insertSheet(NYUKO_CHECK_SHEET_NAME); }
    catch (e) { outSheet = zissiSs.getSheetByName(NYUKO_CHECK_SHEET_NAME); }
  } else {
    outSheet.clear();
  }
  outSheet.getRange(1, 1, 1, NYUKO_CHECK_HEADERS.length).setValues([NYUKO_CHECK_HEADERS])
    .setFontWeight('bold').setBackground('#fce5cd');
  outSheet.setFrozenRows(1);

  // メタ情報行 (チェック対象 PDF / 生成日時 / Claude summary)
  const metaRows = [
    ['【チェック対象 PDF】', '', '', nyukoPdfs.map(function (p) { return p.label; }).join('\n'), '', ''],
    ['【全体所感】', '', '', String(parsed.summary || '').slice(0, 500), '', ''],
    ['【生成日時】', '', '', Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm'), '', '']
  ];
  outSheet.getRange(2, 1, metaRows.length, NYUKO_CHECK_HEADERS.length).setValues(metaRows)
    .setBackground('#f3f3f3').setFontStyle('italic');

  if (checks.length > 0) {
    // 重要度順ソート (high → mid → low)
    const rank = { high: 0, mid: 1, low: 2 };
    checks.sort(function (a, b) {
      return (rank[a.severity] || 9) - (rank[b.severity] || 9);
    });
    const rows = checks.map(function (ck) {
      return [
        ck.pdfLabel || '',
        ck.severity || '',
        ck.category || '',
        ck.issue || '',
        ck.suggestion || '',
        '未対応'
      ];
    });
    const startRow = 2 + metaRows.length;
    outSheet.getRange(startRow, 1, rows.length, NYUKO_CHECK_HEADERS.length).setValues(rows);

    // 重要度の色付け
    for (let i = 0; i < checks.length; i++) {
      const sev = checks[i].severity;
      const bg = sev === 'high' ? '#f4cccc' : sev === 'mid' ? '#fff2cc' : '#d9ead3';
      outSheet.getRange(startRow + i, 2).setBackground(bg);
    }
  }

  // 列幅
  outSheet.setColumnWidth(1, 220); // 制作物名
  outSheet.setColumnWidth(2, 70);  // 重要度
  outSheet.setColumnWidth(3, 120); // カテゴリ
  outSheet.setColumnWidth(4, 380); // 指摘内容
  outSheet.setColumnWidth(5, 320); // 修正案
  outSheet.setColumnWidth(6, 90);  // 確認状況
  outSheet.getRange(1, 1, outSheet.getMaxRows(), NYUKO_CHECK_HEADERS.length).setWrap(true);

  const sheetUrl = PanelLinks_sheetUrl(zissiSs, outSheet);

  CaseList_touchUpdatedAt(caseId);
  MasterWriteBack_recordArtifact(caseId, '入稿データチェック',
    '入稿チェック (' + checks.length + ' 指摘 / ' + nyukoPdfs.length + ' PDF)', sheetUrl);

  return {
    zissiSheetUrl: zissiSs.getUrl(),
    checkSheetUrl: sheetUrl,
    checkSheetName: NYUKO_CHECK_SHEET_NAME,
    pdfCount: nyukoPdfs.length,
    pdfLabels: nyukoPdfs.map(function (p) { return p.label; }),
    issueCount: checks.length,
    severityCount: {
      high: checks.filter(function (c) { return c.severity === 'high'; }).length,
      mid: checks.filter(function (c) { return c.severity === 'mid'; }).length,
      low: checks.filter(function (c) { return c.severity === 'low'; }).length
    },
    summary: parsed.summary || '',
    usage: res.usage
  };
}

/**
 * 案件フォルダ配下から入稿対象の PDF を最大 5 件採集。
 * 入稿系サブフォルダ → 案件フォルダ直下 → 預かり素材 の順で探索。
 * マニュアル/申請/申込 系は除外。
 */
function _Phase3_collectNyukoPdfs(c) {
  const seen = {};
  const out = [];
  const MAX = 5;

  // (1) projectFolder 直下に 入稿/印刷/制作物... のサブフォルダがあれば優先
  const baseFolderId = c.projectFolderId || c.folderId;
  if (baseFolderId) {
    try {
      const base = DriveApp.getFolderById(baseFolderId);
      const subFolders = base.getFolders();
      while (subFolders.hasNext() && out.length < MAX) {
        const sub = subFolders.next();
        const subName = sub.getName();
        const isNyuko = _NYUKO_FOLDER_KEYWORDS.some(function (k) { return subName.indexOf(k) >= 0; });
        if (!isNyuko) continue;
        // この入稿系フォルダ配下を 2 階層まで再帰
        _Phase3_collectPdfsRecursive(sub.getId(), out, seen, subName, 2, MAX);
      }
    } catch (e) { /* skip */ }
  }

  // (2) 案件フォルダ直下の PDF (フォルダが存在しないケース)
  if (out.length < MAX) {
    [c.folderId, c.projectFolderId].filter(Boolean).forEach(function (fid) {
      if (out.length >= MAX) return;
      try {
        const folder = DriveApp.getFolderById(fid);
        const it = folder.getFilesByType(MimeType.PDF);
        while (it.hasNext() && out.length < MAX) {
          const f = it.next();
          const id = f.getId();
          if (seen[id]) continue;
          const name = f.getName();
          if (_Phase3_isExcluded(name)) continue;
          seen[id] = true;
          out.push({ driveFileId: id, label: name, source: '案件フォルダ直下' });
        }
      } catch (e) {}
    });
  }

  return out.slice(0, MAX);
}

function _Phase3_collectPdfsRecursive(folderId, out, seen, sourceLabel, maxDepth, MAX) {
  if (maxDepth <= 0 || out.length >= MAX) return;
  let folder;
  try { folder = DriveApp.getFolderById(folderId); } catch (e) { return; }
  const it = folder.getFilesByType(MimeType.PDF);
  while (it.hasNext() && out.length < MAX) {
    const f = it.next();
    const id = f.getId();
    if (seen[id]) continue;
    const name = f.getName();
    if (_Phase3_isExcluded(name)) continue;
    seen[id] = true;
    out.push({ driveFileId: id, label: name, source: sourceLabel });
  }
  const subs = folder.getFolders();
  while (subs.hasNext() && out.length < MAX) {
    const sub = subs.next();
    _Phase3_collectPdfsRecursive(sub.getId(), out, seen, sourceLabel + '/' + sub.getName(), maxDepth - 1, MAX);
  }
}

function _Phase3_isExcluded(filename) {
  const n = String(filename || '');
  for (let i = 0; i < _NYUKO_FILENAME_EXCLUDES.length; i++) {
    if (n.indexOf(_NYUKO_FILENAME_EXCLUDES[i]) >= 0) return true;
  }
  return false;
}

function _Phase3_loadProjectInfoContext(c) {
  const lines = [];
  lines.push('【案件情報 (照合用)】');
  lines.push('- クライアント正式名: ' + (c.clientName || ''));
  lines.push('- 案件名: ' + (c.caseName || ''));
  lines.push('- 出展期間: ' + _fmtDate(c.startDate) + ' 〜 ' + _fmtDate(c.endDate));
  lines.push('- ブースサイズ: ' + (c.boothSize || '未確定'));
  lines.push('- 許容される最大の造作範囲: ' + (_Phase1_insetBoothSize(c.boothSize, _PHASE1_BOOTH_INSET_MM) || '小間実寸が不明（要確認）。小間実寸から四方100mm内側'));
  return lines.join('\n');
}

function _Phase3_loadItemListContext(zissiSs) {
  try {
    const sheet = zissiSs.getSheetByName(ITEMLIST_PROPOSAL_SHEET_NAME);
    if (!sheet) return '';
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return '';
    const data = sheet.getRange(2, 1, Math.min(lastRow - 1, 100), 4).getValues();
    const printingItems = data.filter(function (r) {
      const cat = String(r[0] || '');
      return cat.indexOf('印刷') >= 0 || cat.indexOf('グラフィック') >= 0 || cat.indexOf('看板') >= 0;
    });
    if (printingItems.length === 0) return '';
    const lines = ['【アイテムリスト 印刷・グラフィック関連 (照合用)】'];
    printingItems.forEach(function (r) {
      lines.push('- ' + r[0] + ' / ' + r[1] + ' / ' + r[2] + ' / ' + r[3]);
    });
    return lines.join('\n');
  } catch (e) {
    return '';
  }
}
