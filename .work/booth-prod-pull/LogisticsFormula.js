/**
 * 搬入出計画シートに「倉庫発送容積 → トラック自動判定」 数式を設置。
 *
 * 想定シート構造 (orgiast 実施計画書テンプレ標準):
 *   C16     倉庫発送分容積 (m³) — 既存
 *   O17:U28 トラック容積表 — 既存
 *     T18 = 日産キャラバン容量 (7.59 m³)
 *     T19 = デュトロ容量 (9.51 m³)
 *     T20-T28 = レンタル候補 (軽トラ/2t/4t 各クラス)
 *   行 29 以降 空 → ここに判定セクションを設置 (A30:B39。トヨエース容量の定数行を含む)
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
/** 判定ブロックの先頭行(A30)。行番号参照はこの値からの相対で組む。 */
const LOGISTICS_FORMULA_START_ROW = 30;
/** トヨエース荷台容積(暫定)。シートのトラック表に依存させず、ブロック内の定数セルに持つ。Phase2_VolumeCalc.js の PHASE2_TOYOACE_CAPACITY と同値。 */
const LOGISTICS_TOYOACE_CAPACITY = 5.95;
const LOGISTICS_RECOMMEND_LABEL = '推奨車両（空き加味・自動）';

/**
 * 判定ブロックの [ラベル, 値/数式] 配列を組む(純関数・テスト用に分離)。
 * 行構成(startRow 起点): +0 タイトル / +1 倉庫発送容積 / +2 デュトロ / +3 キャラバン / +4 トヨエース(定数)
 *   / +5 自社便合計 / +6 判定 / +7 レンタル必要容量 / +8 推奨レンタルクラス / +9 推奨車両(空き加味・GASが値で書く)
 * 自社便の組合せは容量昇順: デュトロ → デュトロ+トヨエース → デュトロ+キャラバン → 3台 → 自社便全部+レンタル。
 */
function Phase2_LogisticsFormula_blockLabels(startRow) {
  const r = function (offset) { return 'B' + (startRow + offset); };
  const vol = r(1), dutro = r(2), caravan = r(3), toyo = r(4), total = r(5), need = r(7);
  return [
    ['■積載判定 (自動)', ''],
    ['倉庫発送容積 (m³)', '=C16'],
    ['デュトロ容量 (m³)', '=T19'],
    ['日産キャラバン容量 (m³)', '=T18'],
    ['トヨエース容量 (m³・暫定/要実測)', LOGISTICS_TOYOACE_CAPACITY],
    ['自社便合計 (m³)', '=' + dutro + '+' + caravan + '+' + toyo],
    ['判定', '=IF(' + vol + '<=' + dutro + ',"デュトロ 1台 (自社便のみ)",IF(' + vol + '<=' + dutro + '+' + toyo + ',"デュトロ + トヨエース (自社便のみ)",IF(' + vol + '<=' + dutro + '+' + caravan + ',"デュトロ + 日産キャラバン (自社便のみ)",IF(' + vol + '<=' + total + ',"デュトロ + トヨエース + 日産キャラバン (自社便のみ)","自社便全部 + レンタルトラック"))))'],
    ['レンタル必要容量 (m³)', '=IF(' + vol + '<=' + total + ',0,' + vol + '-' + total + ')'],
    ['推奨レンタルクラス', '=IF(' + need + '<=0,"なし",IFERROR(INDEX($O$20:$O$28&"・"&$P$20:$P$28&" ("&TEXT($T$20:$T$28,"0.0")&"m³ × 1台)",MATCH(TRUE,ARRAYFORMULA($T$20:$T$28>=' + need + '),0)),"4トン フルワイド箱車 ("&TEXT($T$28,"0.0")&"m³) × "&CEILING(' + need + '/$T$28)&"台 (残量 "&TEXT(' + need + ',"0.0")&"m³)"))'],
    [LOGISTICS_RECOMMEND_LABEL, '']
  ];
}

function Phase2_LogisticsFormula_install(ssId, gid) {
  const ss = SpreadsheetApp.openById(ssId);
  let sheet = null;
  ss.getSheets().forEach(function (s) { if (s.getSheetId() === Number(gid)) sheet = s; });
  if (!sheet) throw new Error('sheet gid not found in ' + ssId + ': gid=' + gid);

  const startRow = LOGISTICS_FORMULA_START_ROW;
  const labels = Phase2_LogisticsFormula_blockLabels(startRow);
  // 旧ブロックは 8 行(A30:B37)、新ブロックは 10 行。再設置で古い式・ラベルが残らないよう、
  // 新旧どちらの範囲も覆う A30:B41 を先に空にしてから書く。
  const clearRows = Math.max(labels.length, 8) + 2;
  const checkRange = sheet.getRange(startRow, 1, clearRows, 2);
  const hasContent = checkRange.getValues().some(function (r) { return String(r[0]).trim() || String(r[1]).trim(); });
  checkRange.clearContent();

  // ラベル列 A 設置
  const aValues = labels.map(function (p) { return [p[0]]; });
  sheet.getRange(startRow, 1, labels.length, 1).setValues(aValues);

  // 数式列 B 設置 (formula と plain value を分けて書く)
  labels.forEach(function (p, i) {
    const target = sheet.getRange(startRow + i, 2);
    if (p[1] === '') {
      target.setValue('');
    } else if (typeof p[1] === 'string' && p[1].charAt(0) === '=') {
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

/**
 * 「推奨車両（空き加味・自動）」行へ GAS が値で推奨を書く(式ではなく、倉庫稼働表の空きを見た結果)。
 * 判定ブロックが設置済みのシートだけが対象。ラベル行が見つからなければ書かず理由を返す(例外にしない)。
 * 搬入出計画の本文は A21 以降(A列)へ出力されるため、本文がブロックのラベルを上書きしている場合は
 * 行が見つからない — その場合は本文側の「自社トラックの空き状況」節が正本。
 */
function Phase2_LogisticsFormula_writeRecommendation(sheet, text) {
  try {
    const start = LOGISTICS_FORMULA_START_ROW;
    const scan = sheet.getRange(start, 1, 16, 1).getDisplayValues();
    let row = 0;
    scan.forEach(function (r, i) { if (!row && String(r[0]).trim() === LOGISTICS_RECOMMEND_LABEL) row = start + i; });
    if (!row) {
      scan.forEach(function (r, i) { if (!row && String(r[0]).trim() === '推奨レンタルクラス') row = start + i + 1; });
      if (!row) return { ok: false, reason: '判定ブロック(推奨レンタルクラス行)が見つかりません' };
      sheet.getRange(row, 1).setValue(LOGISTICS_RECOMMEND_LABEL);
    }
    sheet.getRange(row, 2).setValue(String(text || ''));
    return { ok: true, row: row };
  } catch (e) {
    return { ok: false, reason: String(e && e.message ? e.message : e) };
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = {
  Phase2_LogisticsFormula_blockLabels: Phase2_LogisticsFormula_blockLabels,
  LOGISTICS_FORMULA_START_ROW: LOGISTICS_FORMULA_START_ROW,
  LOGISTICS_TOYOACE_CAPACITY: LOGISTICS_TOYOACE_CAPACITY,
  LOGISTICS_RECOMMEND_LABEL: LOGISTICS_RECOMMEND_LABEL
};
