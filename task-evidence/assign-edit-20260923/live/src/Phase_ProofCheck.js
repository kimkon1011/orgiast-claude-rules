/**
 * もらった資料のチェック（誤字脱字・寸法）を生成。
 *
 * 目的:
 *   デザイナー・協力会社・クライアントから受領したパース・図面・提案書等を読み、
 *   誤字脱字、案件情報との食い違い、小間実寸からの逃げ等を指摘する。
 *
 * 出力:
 *   zissi 内に「Claude_資料チェック」シートを作成（または上書き）する。
 */

const PROOF_CHECK_SHEET_NAME = 'Claude_資料チェック';
const PROOF_CHECK_HEADERS = ['資料名', '重要度', 'カテゴリ', '指摘内容', '修正案', '確認状況'];
const _PROOF_CHECK_MAX_MATERIALS = 5;

function Phase_ProofCheck_generate(caseId) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);

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
  if (!zissiSs) throw new Error('実施計画書が見つかりません。');

  const materials = Case_collectCaseMaterials(c, {
    maxFiles: _PROOF_CHECK_MAX_MATERIALS,
    maxImages: _PROOF_CHECK_MAX_MATERIALS,
    reserveImages: 1
  }).filter(function (m) {
    return !CaseMaterials_isAppGenerated(m.label, c.caseId);
  }).slice(0, _PROOF_CHECK_MAX_MATERIALS);
  if (materials.length === 0) {
    throw new Error('チェック対象の受領資料が見つかりません。案件のプロジェクトフォルダまたは預かり素材フォルダに、パース・平面図・立面図・提案書・スライド・PDF等の資料を置いてください。');
  }

  const manualPages = ManualLoader_findPages([
    '誤字脱字', '校正', 'クオリティチェック', 'クオリティチェックの仕方',
    '品質チェック', 'チェック項目'
  ]);
  const allowedSize = _Phase1_insetBoothSize(c.boothSize, _PHASE1_BOOTH_INSET_MM);
  const cachedContext = [
    Case_loadClientContext(c),
    [
      '【案件情報 (照合用)】',
      '- クライアント正式名: ' + (c.clientName || ''),
      '- 案件名: ' + (c.caseName || ''),
      '- 出展期間: ' + _fmtDate(c.startDate) + ' 〜 ' + _fmtDate(c.endDate),
      '- ブースサイズ（小間の実寸）: ' + (c.boothSize || '小間実寸が不明（要確認）'),
      '- 許容される最大の造作範囲: ' + (allowedSize || '小間実寸が不明（要確認）。基準は小間実寸から四方' + _PHASE1_BOOTH_INSET_MM + 'mm内側')
    ].join('\n'),
    manualPages.length > 0 ? '【関連マニュアル抜粋】\n' + manualPages.map(function (p) {
      return '# ' + p.title + '\nパス: ' + p.path + '\n\n' + p.body;
    }).join('\n\n') : ''
  ].filter(Boolean);

  const userPrompt = [
    '以下の展示会ブース案件で、デザイナー・協力会社・クライアントから上がってきた資料を精査し、修正または確認が必要な箇所を全て列挙してください。',
    '関連マニュアルにチェック項目が書かれている場合は、その項目を必ずチェック観点として適用してください。',
    '',
    '## 案件情報',
    '- クライアント: ' + c.clientName,
    '- 案件名: ' + c.caseName,
    '- 出展期間: ' + _fmtDate(c.startDate) + ' 〜 ' + _fmtDate(c.endDate),
    '- ブースサイズ（小間の実寸）: ' + (c.boothSize || '小間実寸が不明（要確認）'),
    '- 許容される最大の造作範囲: ' + (allowedSize || '小間実寸が不明（要確認）。小間実寸から四方' + _PHASE1_BOOTH_INSET_MM + 'mm内側'),
    '',
    '## チェック観点（必ず全観点を確認）',
    '1. **誤字脱字**: クライアント社名・展示会名・人名・キャッチコピー・本文の typo、半角全角の混在、不要スペース、送り仮名ゆれ',
    '2. **案件情報との整合**: クライアント名/案件名/会期/会場/小間番号が案件情報と一致するか',
    '3. **連絡先**: 電話番号/メール/URL/QRコードのドメインに誤りがないか',
    '4. **社名・敬称・商標表記**: 株式会社/(株)、様、®/™の表記が適切か',
    '5. **数字の整合**: 日付・時刻・金額・数量が資料間で矛盾しないか',
    '6. **寸法の逃げ（最重要）**: パース図・平面図・レイアウト図では、造作が小間実寸から四方' + _PHASE1_BOOTH_INSET_MM + 'mmずつ内側に収まっているか。図面の全体寸法・壁寸法・床敷設範囲を読み取って判定する。逃げが小間ラインいっぱいまたは' + _PHASE1_BOOTH_INSET_MM + 'mm未満なら severity=high とし、修正案に「W○○mm × D○○mm 以内に収める」と具体的な目標寸法を書く。寸法を読み取れない場合は severity=mid で「寸法表記がなく判定不能・要確認」とし、勝手にOKと判定しない',
    '7. **資料間の食い違い**: パースと平面図で什器位置・寸法・色等が違わないか',
    '8. **抜け漏れ**: 決定事項が反映されているか、ダミーテキスト/仮画像が残っていないか',
    '',
    '## 出力形式（厳守・前後の説明文や ```json``` ブロック禁止・JSON単体）',
    '{',
    '  "checks": [',
    '    {',
    '      "materialLabel": "<該当資料のファイル名>",',
    '      "severity": "high|mid|low",',
    '      "category": "<チェックカテゴリ>",',
    '      "issue": "<ページ番号や位置を含む具体的な指摘>",',
    '      "suggestion": "<具体的な修正案>"',
    '    }',
    '  ],',
    '  "summary": "<全体所感を200字以内>"',
    '}',
    '',
    '注意:',
    '- 資料から確認できない事実を推測しない。寸法以外で判断できない事項は severity=low + 「※要確認」とする。',
    '- 問題がなければ checks は空配列でよい。各資料の指摘は重要度の高いものから並べる。'
  ].join('\n');

  const res = ClaudeClient_call({
    cachedContext: cachedContext,
    userMessage: userPrompt,
    documents: materials.map(function (m) {
      return { driveFileId: m.driveFileId, label: m.label, kind: m.kind, mimeType: m.mimeType };
    }),
    maxTokens: 6000
  });
  const parsed = _Phase1_parseJson(res.text);
  const checks = Array.isArray(parsed.checks) ? parsed.checks : [];
  const rank = { high: 0, mid: 1, low: 2 };
  checks.sort(function (a, b) {
    const ar = Object.prototype.hasOwnProperty.call(rank, a.severity) ? rank[a.severity] : 9;
    const br = Object.prototype.hasOwnProperty.call(rank, b.severity) ? rank[b.severity] : 9;
    return ar - br;
  });

  let outSheet = zissiSs.getSheetByName(PROOF_CHECK_SHEET_NAME);
  if (!outSheet) {
    try { outSheet = zissiSs.insertSheet(PROOF_CHECK_SHEET_NAME); }
    catch (e) { outSheet = zissiSs.getSheetByName(PROOF_CHECK_SHEET_NAME); }
  } else {
    outSheet.clear();
  }
  outSheet.getRange(1, 1, 1, PROOF_CHECK_HEADERS.length).setValues([PROOF_CHECK_HEADERS])
    .setFontWeight('bold').setBackground('#fce5cd');
  outSheet.setFrozenRows(1);
  const metaRows = [
    ['【チェック対象資料】', '', '', materials.map(function (m) { return m.label; }).join('\n'), '', ''],
    ['【全体所感】', '', '', String(parsed.summary || '').slice(0, 500), '', ''],
    ['【生成日時】', '', '', Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm'), '', '']
  ];
  outSheet.getRange(2, 1, metaRows.length, PROOF_CHECK_HEADERS.length).setValues(metaRows)
    .setBackground('#f3f3f3').setFontStyle('italic');

  if (checks.length > 0) {
    const rows = checks.map(function (ck) {
      return [ck.materialLabel || '', ck.severity || '', ck.category || '', ck.issue || '', ck.suggestion || '', '未対応'];
    });
    const startRow = 2 + metaRows.length;
    outSheet.getRange(startRow, 1, rows.length, PROOF_CHECK_HEADERS.length).setValues(rows);
    checks.forEach(function (ck, i) {
      const bg = ck.severity === 'high' ? '#f4cccc' : ck.severity === 'mid' ? '#fff2cc' : '#d9ead3';
      outSheet.getRange(startRow + i, 2).setBackground(bg);
    });
  }

  outSheet.setColumnWidth(1, 220);
  outSheet.setColumnWidth(2, 70);
  outSheet.setColumnWidth(3, 140);
  outSheet.setColumnWidth(4, 380);
  outSheet.setColumnWidth(5, 320);
  outSheet.setColumnWidth(6, 90);
  outSheet.getRange(1, 1, outSheet.getMaxRows(), PROOF_CHECK_HEADERS.length).setWrap(true);

  const highChecks = checks.filter(function (ck) { return ck.severity === 'high'; });
  if (highChecks.length > 0) {
    ConfirmationSheet_appendItems(caseId, highChecks.map(function (ck) {
      return {
        category: '[資料チェック] ' + (ck.category || '重要指摘'),
        content: (ck.materialLabel ? ck.materialLabel + ': ' : '') + (ck.issue || '') +
          (ck.suggestion ? '\n修正案: ' + ck.suggestion : '')
      };
    }), 2);
  }

  const sheetUrl = PanelLinks_sheetUrl(zissiSs, outSheet);
  let ledger;
  try {
    const generatedAt = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
    ledger = TaskLedger_upsert(caseId, checks.filter(function (ck) { return ck.severity === 'high' || ck.severity === 'mid'; }).map(function (ck) {
      return { source: '資料チェック', taskName: String('資料修正(' + ck.severity + '): ' + (ck.materialLabel ? ck.materialLabel + ' ' : '') + (ck.category || '')).slice(0, 80), detail: String((ck.issue || '') + (ck.suggestion ? '\n修正案: ' + ck.suggestion : '')).slice(0, 500), evidence: '資料チェック ' + generatedAt, due: '', owner: 'オージャスト', aiFeature: '', sourceStatus: 'open' };
    }));
  } catch (e) { console.warn('Phase_ProofCheck ledger: ' + e); ledger = { error: String(e) }; }
  CaseList_touchUpdatedAt(caseId);
  MasterWriteBack_recordArtifact(caseId, '資料チェック',
    parsed.summary || ('資料チェック (' + checks.length + ' 指摘)'), sheetUrl);

  return {
    zissiSheetUrl: zissiSs.getUrl(),
    checkSheetUrl: sheetUrl,
    checkSheetName: PROOF_CHECK_SHEET_NAME,
    materialCount: materials.length,
    materialLabels: materials.map(function (m) { return m.label; }),
    issueCount: checks.length,
    severityCount: {
      high: highChecks.length,
      mid: checks.filter(function (ck) { return ck.severity === 'mid'; }).length,
      low: checks.filter(function (ck) { return ck.severity === 'low'; }).length
    },
    summary: parsed.summary || '',
    panelStatus: '✅ 資料チェック完了（指摘 ' + checks.length + '件 / うち重要 ' + highChecks.length + '件）',
    usage: res.usage,
    ledger: ledger
  };
}
