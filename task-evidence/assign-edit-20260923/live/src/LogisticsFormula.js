/**
 * 搬入出計画シートに「倉庫発送容積 → トラック自動判定」 数式を設置。
 *
 * 想定シート構造 (orgiast 実施計画書テンプレ標準):
 *   C16     倉庫発送分容積 (m³) — 既存
 *   O17:U28 トラック容積表 — 既存
 *     T18 = 日産キャラバン容量 (7.59 m³)
 *     T19 = デュトロ容量 (9.51 m³)
 *     T20-T28 = レンタル候補 (軽トラ/2t/4t 各クラス)
 *   行 29 以降 空 → ここに判定セクションを設置
 *
 * 優先順位 (user 指示):
 *   1) デュトロ 1 台
 *   2) オーバー → 日産キャラバン 追加 (自社便のみ)
 *   3) なおオーバー → キャラバンをやめて デュトロ + レンタル
 *      残量を吸収できる最小クラスを推奨
 *
 * formula は完全に sheet 内で完結 (GAS 不要)。 GAS は数式を設置するためだけに 1 回だけ呼ぶ。
 * ブース以外のイベント案件でも同じシート構造なら使い回せる。
 */
function Phase2_LogisticsFormula_install(ssId, gid) {
  const ss = SpreadsheetApp.openById(ssId);
  let sheet = null;
  ss.getSheets().forEach(function (s) { if (s.getSheetId() === Number(gid)) sheet = s; });
  if (!sheet) throw new Error('sheet gid not found in ' + ssId + ': gid=' + gid);

  // 既存値が無いことを確認 (上書きを避ける)
  const checkRow30 = sheet.getRange(30, 1, 8, 2).getValues();
  const hasContent = checkRow30.some(function (r) { return String(r[0]).trim() || String(r[1]).trim(); });

  const labels = [
    ['■積載判定 (自動)', ''],
    ['倉庫発送容積 (m³)', '=C16'],
    ['デュトロ容量 (m³)', '=T19'],
    ['日産キャラバン容量 (m³)', '=T18'],
    ['自社便合計 (m³)', '=B32+B33'],
    ['判定', '=IF(B31<=B32,"デュトロ 1台 (自社便のみ)",IF(B31<=B34,"デュトロ + 日産キャラバン (自社便のみ)","デュトロ + レンタルトラック (キャラバン外し)"))'],
    ['レンタル必要容量 (m³)', '=IF(B31<=B34,0,B31-B32)'],
    ['推奨レンタルクラス', '=IF(B36<=0,"なし",IFERROR(INDEX($O$20:$O$28&"・"&$P$20:$P$28&" ("&TEXT($T$20:$T$28,"0.0")&"m³ × 1台)",MATCH(TRUE,ARRAYFORMULA($T$20:$T$28>=B36),0)),"4トン フルワイド箱車 ("&TEXT($T$28,"0.0")&"m³) × "&CEILING(B36/$T$28)&"台 (残量 "&TEXT(B36,"0.0")&"m³)"))']
  ];

  const startRow = 30;
  // ラベル列 A 設置
  const aValues = labels.map(function (p) { return [p[0]]; });
  sheet.getRange(startRow, 1, labels.length, 1).setValues(aValues);

  // 数式列 B 設置 (formula と plain value を分けて書く)
  labels.forEach(function (p, i) {
    const target = sheet.getRange(startRow + i, 2);
    if (p[1] === '') {
      target.setValue('');
    } else if (p[1].charAt(0) === '=') {
      target.setFormula(p[1]);
    } else {
      target.setValue(p[1]);
    }
  });
  SpreadsheetApp.flush();

  // タイトル行を太字
  sheet.getRange(startRow, 1, 1, 2).setFontWeight('bold').setBackground('#fff2cc');

  // 読み戻し検証 (display value)
  const verify = [];
  for (let i = 0; i < labels.length; i++) {
    verify.push({
      row: startRow + i,
      a: sheet.getRange(startRow + i, 1).getValue(),
      b_formula: sheet.getRange(startRow + i, 2).getFormula() || sheet.getRange(startRow + i, 2).getValue(),
      b_display: sheet.getRange(startRow + i, 2).getDisplayValue()
    });
  }

  return {
    ssId: ssId,
    gid: gid,
    sheetName: sheet.getName(),
    startRow: startRow,
    rowsWritten: labels.length,
    hadExistingContent: hasContent,
    verify: verify
  };
}
