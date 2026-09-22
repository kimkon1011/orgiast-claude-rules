/**
 * 施工手順書 Fable5 版の Slides レンダラー。
 * 参考 PDF (26 ページ) と同レベルのレイアウトを Google Slides で再現:
 *  - チャコール表紙 + 章扉 (dark bg 全画面)
 *  - 2-7 列の Table shape (項目/内容, 班/構成/主担当, 時刻×6人 等)
 *  - 赤ハイライト帯 (絶対ルール #1, フェーズ P3/P4)
 *  - 灰色 code ブロック (完了報告テンプレ)
 *  - 見開き 2 列レイアウト (フェーズ手順)
 *
 * 標準 スライドサイズ: 720×405 pt (10×5.625 in)
 */

// カラーパレット (PDF に近い色調)
const _CP_COLOR_DARK_BG = '#37474F';    // 表紙のチャコール
const _CP_COLOR_DARK_HEADER = '#37474F'; // テーブルヘッダー
const _CP_COLOR_LIGHT_ROW = '#F5F5F5';  // 交互行ライト
const _CP_COLOR_HIGHLIGHT_BG = '#FCE4E4'; // 赤ハイライト背景
const _CP_COLOR_HIGHLIGHT_TEXT = '#C62828'; // 赤テキスト
const _CP_COLOR_WHITE = '#FFFFFF';
const _CP_COLOR_GRAY_TEXT = '#616161';
const _CP_COLOR_TITLE_BAR = '#37474F';
const _CP_COLOR_TUBE_LIT = '#69F0AE';
const _CP_COLOR_TUBE_DARK = '#263238';
const _CP_COLOR_TRUSS = '#B0BEC5';
const _CP_COLOR_OK = '#1B5E20';

const _CP_SLIDE_W = 720;
const _CP_SLIDE_H = 405;

/**
 * 施工手順書 Slides をゼロから生成し 案件フォルダに保存。
 */
function _Phase2_buildConstructionPlanSlides(c, parsed, designFigures, folderId) {
  const title = parsed.title || '施工手順書【設営+撤去】';
  const presName = c.caseId + '_' + c.caseName + '_施工手順書_Fable5';
  const pres = SlidesApp.create(presName);
  // Google Slides の作成直後は default slide 1枚。 全部削除して自作する
  try { pres.getSlides()[0].remove(); } catch (e) {}

  // 1. 表紙
  _cp_addCoverSlide(pres, parsed);
  // 2. 前提条件サマリー
  _cp_addPrerequisitesSlide(pres, parsed);
  // 3. 体制 (仮置き)
  _cp_addTeamPlaceholderSlide(pres, parsed);
  // 4. 絶対に守るべき 5 項目
  _cp_addAbsoluteRulesSlide(pres, parsed);
  // 5. 先行リスク
  _cp_addCriticalRisksSlide(pres, parsed);
  // 6. 章扉 第1部 設営手順書
  _cp_addChapterCoverSlide(pres, '第1部', '設営手順書', (parsed.setup && parsed.setup.date_time) || '');
  // 7-17. 設営部
  if (parsed.setup) {
    _cp_addTeamAssignmentSlide(pres, parsed.setup.team_assignment, '設営 ─ 体制と班分け (4班以内)');
    _cp_addOverallScheduleSlide(pres, parsed.setup.overall_schedule, '設営 ─ 全体スケジュール');
    _cp_addTaskMatrixSlide(pres, parsed.setup.task_matrix1);
    _cp_addTaskMatrixSlide(pres, parsed.setup.task_matrix2);
    _cp_addPhaseDetailsSlides(pres, parsed.setup.phase_details, '設営');
    _cp_addFixedProcedureSlides(pres, parsed);
    _cp_addSafetyCheckSlide(pres, parsed.setup.safety_check, '設営 ─ 破損防止ルール & 立会チェック', true);
    _cp_addRisksCheckpointsSlide(pres, parsed.setup.risks_checkpoints, '設営 ─ 想定リスク & 進捗チェックポイント');
    _cp_addEmergencyReportSlide(pres, parsed.setup.emergency_report, '設営 ─ 緊急時対応 & 完了報告');
  } else {
    _cp_addFixedProcedureSlides(pres, parsed);
  }
  // 18. 章扉 第2部 撤去手順書
  _cp_addChapterCoverSlide(pres, '第2部', '撤去手順書', (parsed.teardown && parsed.teardown.date_time) || '');
  // 19-24. 撤去部
  if (parsed.teardown) {
    _cp_addTeamAndScheduleSideBySide(pres,
      parsed.teardown.team_assignment,
      parsed.teardown.overall_schedule,
      '撤去 ─ 班分け & 全体スケジュール');
    _cp_addPhaseDetailsSlides(pres, parsed.teardown.phase_details, '撤去');
    _cp_addFixedProcedureSlides(pres, parsed, 'teardown');
    _cp_addSafetyCheckSlide(pres, parsed.teardown.safety_check, '撤去 ─ 破損防止・立会・リスク', false, parsed.teardown.risks_checkpoints);
    _cp_addRisksCheckpointsSlide(pres, parsed.teardown.risks_checkpoints, '撤去 ─ チェックポイント & リスク');
    _cp_addEmergencyReportSlide(pres, parsed.teardown.emergency_report, '撤去 ─ 緊急時 & 完了報告');
  }
  // 25. 確定後差替項目
  _cp_addUnconfirmedItemsSlide(pres, parsed);
  // 26. 最終メッセージ
  _cp_addFooterMessageSlide(pres, parsed);

  pres.saveAndClose();
  if (folderId) {
    try { DriveApp.getFileById(pres.getId()).moveTo(DriveApp.getFolderById(folderId)); } catch (e) {}
  }
  return { id: pres.getId(), url: pres.getUrl() };
}

// ─────────────────────────────────────────────────────────────
// ヘルパー: プリミティブ描画
// ─────────────────────────────────────────────────────────────

function _cp_setSlideBackground(slide, hexColor) {
  try { slide.getBackground().setSolidFill(hexColor); } catch (e) {}
}

/** ページ左上に色バー付きの タイトル領域 (H1 見出し) を挿入 */
function _cp_addPageTitle(slide, badgeText, title) {
  // 左端に短い色バッジ
  try {
    const badge = slide.insertShape(SlidesApp.ShapeType.RECTANGLE, 20, 22, 22, 28);
    badge.getFill().setSolidFill(_CP_COLOR_TITLE_BAR);
    badge.getBorder().setTransparent();
    badge.getText().setText(badgeText || '0');
    badge.getText().getTextStyle().setFontSize(14).setBold(true).setForegroundColor(_CP_COLOR_WHITE);
    try { badge.getText().getParagraphStyle().setParagraphAlignment(SlidesApp.ParagraphAlignment.CENTER); } catch (e) {}
  } catch (e) {}
  // タイトル
  try {
    const tb = slide.insertTextBox(title, 50, 20, 660, 34);
    tb.getText().getTextStyle().setFontSize(20).setBold(true).setForegroundColor('#212121');
  } catch (e) {}
}

/** テーブルを描画。 rows は 2 次元配列。 opts.headerRow で 0 行目 dark bg */
function _cp_drawTable(slide, x, y, w, h, rows, opts) {
  opts = opts || {};
  if (!rows || rows.length === 0) return null;
  const nRows = rows.length;
  const nCols = rows[0].length;
  const table = slide.insertTable(nRows, nCols);
  try { table.setLeft(x).setTop(y).setWidth(w).setHeight(h); } catch (e) {}
  for (let r = 0; r < nRows; r++) {
    for (let c = 0; c < nCols; c++) {
      const cell = table.getCell(r, c);
      const val = rows[r][c] == null ? '' : String(rows[r][c]);
      try { cell.getText().setText(val); } catch (e) {}
      const fontSize = opts.fontSize || 9;
      try { cell.getText().getTextStyle().setFontSize(fontSize); } catch (e) {}
      const isHeader = r === 0 && opts.headerRow;
      if (isHeader) {
        try { cell.getFill().setSolidFill(_CP_COLOR_DARK_HEADER); } catch (e) {}
        try { cell.getText().getTextStyle().setBold(true).setForegroundColor(_CP_COLOR_WHITE); } catch (e) {}
      } else if (opts.highlightRows && opts.highlightRows.indexOf(r) >= 0) {
        try { cell.getFill().setSolidFill(_CP_COLOR_HIGHLIGHT_BG); } catch (e) {}
        try { cell.getText().getTextStyle().setForegroundColor(_CP_COLOR_HIGHLIGHT_TEXT); } catch (e) {}
      } else if (opts.stripe && r % 2 === 0) {
        try { cell.getFill().setSolidFill(_CP_COLOR_LIGHT_ROW); } catch (e) {}
      }
    }
  }
  return table;
}

/** 幅で分けたテキストボックスを配置 (bullet list) */
function _cp_addBulletList(slide, x, y, w, h, lines, opts) {
  opts = opts || {};
  const body = (lines || []).map(function (l) { return '・' + l; }).join('\n');
  const tb = slide.insertTextBox(body, x, y, w, h);
  try { tb.getText().getTextStyle().setFontSize(opts.fontSize || 10).setForegroundColor(opts.color || '#333333'); } catch (e) {}
  return tb;
}

function _cp_addPlainText(slide, x, y, w, h, text, opts) {
  opts = opts || {};
  const tb = slide.insertTextBox(text || '', x, y, w, h);
  try {
    const st = tb.getText().getTextStyle();
    st.setFontSize(opts.fontSize || 10);
    if (opts.color) st.setForegroundColor(opts.color);
    if (opts.bold) st.setBold(true);
  } catch (e) {}
  if (opts.bg) {
    try { tb.getFill().setSolidFill(opts.bg); } catch (e) {}
  }
  return tb;
}

// ─────────────────────────────────────────────────────────────
// 個別スライド関数
// ─────────────────────────────────────────────────────────────

/** 1. 表紙 (dark bg, 巨大タイトル) */
function _cp_addCoverSlide(pres, parsed) {
  const slide = pres.appendSlide(SlidesApp.PredefinedLayout.BLANK);
  _cp_setSlideBackground(slide, _CP_COLOR_DARK_BG);
  // タイトル (巨大)
  const t = slide.insertTextBox(parsed.title || '施工手順書', 60, 130, 600, 80);
  try { t.getText().getTextStyle().setFontSize(52).setBold(true).setForegroundColor(_CP_COLOR_WHITE); } catch (e) {}
  // 【設営+撤去】
  const sub = slide.insertTextBox('【設営＋撤去】', 60, 210, 600, 40);
  try { sub.getText().getTextStyle().setFontSize(24).setBold(true).setForegroundColor('#B0BEC5'); } catch (e) {}
  // 案件名+会場
  const meta = slide.insertTextBox(parsed.subtitle || '', 60, 275, 600, 28);
  try { meta.getText().getTextStyle().setFontSize(14).setBold(true).setForegroundColor(_CP_COLOR_WHITE); } catch (e) {}
  const info = parsed.cover_info || {};
  const infoLines = [];
  if (info.venue) infoLines.push('会場: ' + info.venue);
  if (info.setup_date) infoLines.push('設営: ' + info.setup_date + '　／　撤去: ' + (info.teardown_date || ''));
  const info2 = slide.insertTextBox(infoLines.join('\n'), 60, 305, 600, 40);
  try { info2.getText().getTextStyle().setFontSize(11).setForegroundColor('#CFD8DC'); } catch (e) {}
  // note
  if (info.note) {
    const nt = slide.insertTextBox(info.note, 60, 355, 600, 30);
    try { nt.getText().getTextStyle().setFontSize(9).setForegroundColor('#B0BEC5'); } catch (e) {}
  }
}

/** 2. 前提条件サマリー */
function _cp_addPrerequisitesSlide(pres, parsed) {
  const slide = pres.appendSlide(SlidesApp.PredefinedLayout.BLANK);
  _cp_addPageTitle(slide, '0', '前提条件サマリー(案件概要)');
  const rows = [['項目', '内容']];
  (parsed.prerequisites || []).forEach(function (p) {
    rows.push([p.key || '', p.value || '']);
  });
  _cp_drawTable(slide, 30, 70, 660, 310, rows, { headerRow: true, fontSize: 10, stripe: true });
}

/** 3. 体制 (仮置き) */
function _cp_addTeamPlaceholderSlide(pres, parsed) {
  const slide = pres.appendSlide(SlidesApp.PredefinedLayout.BLANK);
  _cp_addPageTitle(slide, '0', '体制【仮置き／確定後に差替】');
  const tp = parsed.team_placeholder || { rows: [] };
  if (tp.note) {
    const note = slide.insertTextBox(tp.note, 30, 62, 660, 24);
    try { note.getText().getTextStyle().setFontSize(11).setBold(true).setForegroundColor(_CP_COLOR_HIGHLIGHT_TEXT); } catch (e) {}
  }
  const rows = [['区分', '設営', '撤去']];
  (tp.rows || []).forEach(function (r) {
    rows.push([r.role || '', r.setup || '', r.teardown || '']);
  });
  _cp_drawTable(slide, 30, 92, 660, 280, rows, { headerRow: true, fontSize: 11, stripe: true });
}

/** 4. 絶対に守るべき項目 */
function _cp_addAbsoluteRulesSlide(pres, parsed) {
  const slide = pres.appendSlide(SlidesApp.PredefinedLayout.BLANK);
  const rules = parsed.absolute_rules || [];
  _cp_addPageTitle(slide, '0', '絶対に守るべきこと(共通 ' + rules.length + '項目)');
  const startY = 70;
  const rowH = Math.min(55, Math.floor((_CP_SLIDE_H - 70 - 10) / Math.max(rules.length, 1)));
  const fontSize = rowH < 45 ? 8 : 9;
  rules.slice(0, 8).forEach(function (r, i) {
    const y = startY + i * rowH;
    const bg = r.highlight ? _CP_COLOR_HIGHLIGHT_BG : _CP_COLOR_LIGHT_ROW;
    // バッジ
    const badge = slide.insertShape(SlidesApp.ShapeType.RECTANGLE, 30, y, 40, rowH - 5);
    badge.getFill().setSolidFill(bg);
    badge.getBorder().setTransparent();
    badge.getText().setText(String(r.no || (i + 1)));
    try { badge.getText().getTextStyle().setFontSize(20).setBold(true).setForegroundColor(r.highlight ? _CP_COLOR_HIGHLIGHT_TEXT : '#212121'); } catch (e) {}
    try { badge.getText().getParagraphStyle().setParagraphAlignment(SlidesApp.ParagraphAlignment.CENTER); } catch (e) {}
    // 本文行 (タイトル+ボディを同一 shape に)
    const bar = slide.insertShape(SlidesApp.ShapeType.RECTANGLE, 75, y, 615, rowH - 5);
    bar.getFill().setSolidFill(bg);
    bar.getBorder().setTransparent();
    const combined = (r.title || '') + '  ' + (r.body || '');
    bar.getText().setText(combined);
    try {
      // タイトル部分と本文で色を出し分けたいが Slides API は 単一文字列内の部分スタイルは
      // getRange 経由でしかできない → title 長を基に range 切って強調
      const rng = bar.getText();
      rng.getTextStyle().setFontSize(fontSize).setForegroundColor('#333333');
      const titleLen = (r.title || '').length;
      if (titleLen > 0) {
        try { rng.getRange(0, titleLen).getTextStyle().setBold(true).setForegroundColor(r.highlight ? _CP_COLOR_HIGHLIGHT_TEXT : '#212121'); } catch (e) {}
      }
    } catch (e) {}
  });
}

/** 5. 先行リスク */
function _cp_addCriticalRisksSlide(pres, parsed) {
  const slide = pres.appendSlide(SlidesApp.PredefinedLayout.BLANK);
  _cp_addPageTitle(slide, '0', '先行して潰すべき重大リスク(手順書外だが必読)');
  const risks = parsed.critical_risks || [];
  const rows = [['事象', '推奨アクション ／ 担当']];
  const highlightRows = [];
  risks.forEach(function (r, i) {
    rows.push([r.issue || '', r.action || '']);
    if (r.highlight) highlightRows.push(i + 1);
  });
  _cp_drawTable(slide, 30, 70, 660, 300, rows, {
    headerRow: true, fontSize: 9, highlightRows: highlightRows
  });
}

/** 6/18. 章扉 (dark bg) */
function _cp_addChapterCoverSlide(pres, chapter, title, dateTime) {
  const slide = pres.appendSlide(SlidesApp.PredefinedLayout.BLANK);
  _cp_setSlideBackground(slide, _CP_COLOR_DARK_BG);
  const c = slide.insertTextBox(chapter, 60, 140, 600, 30);
  try { c.getText().getTextStyle().setFontSize(20).setBold(true).setForegroundColor('#B0BEC5'); } catch (e) {}
  const t = slide.insertTextBox(title, 60, 175, 600, 80);
  try { t.getText().getTextStyle().setFontSize(56).setBold(true).setForegroundColor(_CP_COLOR_WHITE); } catch (e) {}
  const dt = slide.insertTextBox(dateTime || '', 60, 265, 600, 30);
  try { dt.getText().getTextStyle().setFontSize(14).setForegroundColor('#CFD8DC'); } catch (e) {}
}

/** 7/19. 班分け */
function _cp_addTeamAssignmentSlide(pres, ta, pageTitle) {
  const slide = pres.appendSlide(SlidesApp.PredefinedLayout.BLANK);
  _cp_addPageTitle(slide, '0', pageTitle);
  if (!ta) return;
  const rows = [['班', '構成', '主担当作業', '兼務']];
  const highlightRows = [];
  (ta.groups || []).forEach(function (g, i) {
    rows.push([g.name || '', g.members || '', g.role || '', g.concurrent || '']);
    if (g.highlight) highlightRows.push(i + 1);
  });
  _cp_drawTable(slide, 30, 70, 660, 180, rows, { headerRow: true, fontSize: 9, highlightRows: highlightRows });
  // 各班長注意事項
  if (Array.isArray(ta.leader_notes) && ta.leader_notes.length > 0) {
    const nt = slide.insertTextBox('各班長への重点注意', 30, 260, 660, 20);
    try { nt.getText().getTextStyle().setFontSize(11).setBold(true).setForegroundColor('#212121'); } catch (e) {}
    _cp_addBulletList(slide, 30, 280, 660, 110, ta.leader_notes, { fontSize: 10 });
  }
}

/** 8. 全体スケジュール */
function _cp_addOverallScheduleSlide(pres, sched, pageTitle) {
  const slide = pres.appendSlide(SlidesApp.PredefinedLayout.BLANK);
  _cp_addPageTitle(slide, '0', pageTitle + ' (' + ((sched && sched.range) || '') + ')');
  if (!sched) return;
  const rows = [['フェーズ', '時刻', '所要', '主担当', '内容']];
  const highlightRows = [];
  (sched.phases || []).forEach(function (p, i) {
    rows.push([p.phase || '', p.time || '', p.duration || '', p.owner || '', p.content || '']);
    if (p.highlight) highlightRows.push(i + 1);
  });
  _cp_drawTable(slide, 15, 68, 690, 320, rows, { headerRow: true, fontSize: 8, highlightRows: highlightRows });
}

/** 9/10. 15分刻み task_matrix */
function _cp_addTaskMatrixSlide(pres, m) {
  if (!m) return;
  const slide = pres.appendSlide(SlidesApp.PredefinedLayout.BLANK);
  _cp_addPageTitle(slide, '0', m.title || '役割分担(当日タスク)');
  if (m.sub_title) {
    const st = slide.insertTextBox(m.sub_title, 30, 62, 660, 20);
    try { st.getText().getTextStyle().setFontSize(9).setBold(true).setForegroundColor('#616161'); } catch (e) {}
  }
  const rows = [];
  rows.push(m.columns || ['時刻', '担当1', '担当2', '担当3', '担当4', '担当5', '担当6']);
  (m.rows || []).forEach(function (r) { rows.push(r); });
  _cp_drawTable(slide, 15, 88, 690, 200, rows, { headerRow: true, fontSize: 8 });
  if (Array.isArray(m.notes) && m.notes.length > 0) {
    const y = 300;
    _cp_addBulletList(slide, 30, y, 660, 90, m.notes, { fontSize: 9, color: _CP_COLOR_HIGHLIGHT_TEXT });
  }
}

/** 11-14 / 20-22. フェーズ手順 (見開き 2 列。 2 phase / スライド) */
function _cp_addPhaseDetailsSlides(pres, phases, sectionLabel) {
  if (!phases || phases.length === 0) return;
  for (let i = 0; i < phases.length; i += 2) {
    const p1 = phases[i];
    const p2 = phases[i + 1];
    const slide = pres.appendSlide(SlidesApp.PredefinedLayout.BLANK);
    const heading = sectionLabel + ' ─ フェーズ手順 ' + (p1 ? p1.phase.split(' ')[0] : '') + (p2 ? '・' + p2.phase.split(' ')[0] : '');
    _cp_addPageTitle(slide, '0', heading);
    _cp_renderPhaseBox(slide, p1, 15, 70, 345, 320);
    if (p2) _cp_renderPhaseBox(slide, p2, 370, 70, 335, 320);
  }
}

/** 標準施工手順 (1 手順ブロック / 1 スライド)。 */
function _cp_addFixedProcedureSlides(pres, parsed, part) {
  const wanted = part || null;
  const procedures = (parsed && Array.isArray(parsed.fixed_procedures) ? parsed.fixed_procedures : [])
    .filter(function (p) { return (p.part || null) === wanted; });
  procedures.forEach(function (p) {
    const slide = pres.appendSlide(SlidesApp.PredefinedLayout.BLANK);
    _cp_addPageTitle(slide, '0', p.title);
    _cp_addPlainText(slide, 30, 62, 660, 34, p.intro, { fontSize: 10, bold: true, color: '#212121' });
    const text = (p.steps || []).map(function (step, index) { return (index + 1) + '. ' + step; }).join('\n');
    const stepsBox = slide.insertTextBox(text, 30, 100, 660, 210);
    try { stepsBox.getText().getTextStyle().setFontSize(10).setForegroundColor('#333333'); } catch (e) {}
    const notes = (p.notes || []).map(function (note) { return '⚠ ' + note; }).join('\n');
    _cp_addPlainText(slide, 30, 318, 660, 70, notes, { fontSize: 10, bold: true, color: _CP_COLOR_HIGHLIGHT_TEXT, bg: _CP_COLOR_HIGHLIGHT_BG });
    if (p.figure === 'tube_light') _cp_addTubeLightFigureSlide(pres, p);
    if (p.figure === 'tube_light') _cp_addTubeLightPlacementSlide(pres, p);
  });
}

/** チューブライト断面。darkSide 側に非発光の平らな面を重ねる。 */
function _cp_drawTubeSection(slide, cx, cy, d, darkSide) {
  try {
    const tube = slide.insertShape(SlidesApp.ShapeType.ELLIPSE, cx - d / 2, cy - d / 2, d, d);
    tube.getFill().setSolidFill(_CP_COLOR_TUBE_LIT);
    tube.getBorder().getLineFill().setSolidFill('#00897B');
    tube.getBorder().setWeight(1);

    let x = cx - d * 0.3;
    let y = cy - d / 2;
    let w = d * 0.6;
    let h = d * 0.12;
    if (darkSide === 'bottom') y = cy + d / 2 - d * 0.12;
    if (darkSide === 'left' || darkSide === 'right') {
      x = darkSide === 'left' ? cx - d / 2 : cx + d / 2 - d * 0.12;
      y = cy - d * 0.3;
      w = d * 0.12;
      h = d * 0.6;
    }
    // 円の縁のアンチエイリアスがはみ出ないよう外側へ 1.5pt 広げる
    const pad = 1.5;
    if (darkSide === 'top') { y -= pad; h += pad; }
    else if (darkSide === 'bottom') { h += pad; }
    else if (darkSide === 'left') { x -= pad; w += pad; }
    else if (darkSide === 'right') { w += pad; }
    const dark = slide.insertShape(SlidesApp.ShapeType.RECTANGLE, x, y, w, h);
    dark.getFill().setSolidFill(_CP_COLOR_TUBE_DARK);
    dark.getBorder().setTransparent();
  } catch (e) {}
}

/** 細長いチューブライト。darkSide 側に非発光の平らな面を重ねる。 */
function _cp_drawTubeRun(slide, x, y, w, h, darkSide) {
  try {
    const tube = slide.insertShape(SlidesApp.ShapeType.RECTANGLE, x, y, w, h);
    tube.getFill().setSolidFill(_CP_COLOR_TUBE_LIT);
    tube.getBorder().getLineFill().setSolidFill('#00897B');
    tube.getBorder().setWeight(1);

    const pad = 1.5;
    const darkThickness = Math.max(3, (darkSide === 'top' || darkSide === 'bottom' ? h : w) * 0.3);
    let darkX = x;
    let darkY = y;
    let darkW = w;
    let darkH = h;
    if (darkSide === 'top') { darkY = y - pad; darkH = darkThickness + pad; }
    else if (darkSide === 'bottom') { darkY = y + h - darkThickness; darkH = darkThickness + pad; }
    else if (darkSide === 'left') { darkX = x - pad; darkW = darkThickness + pad; }
    else if (darkSide === 'right') { darkX = x + w - darkThickness; darkW = darkThickness + pad; }
    const dark = slide.insertShape(SlidesApp.ShapeType.RECTANGLE, darkX, darkY, darkW, darkH);
    dark.getFill().setSolidFill(_CP_COLOR_TUBE_DARK);
    dark.getBorder().setTransparent();
  } catch (e) {}
}

/** チューブライトの向きを 断面／屋根／柱 の 3 パネルで示す。 */
function _cp_addTubeLightFigureSlide(pres, p) {
  const slide = pres.appendSlide(SlidesApp.PredefinedLayout.BLANK);
  _cp_addPageTitle(slide, '0', 'チューブライトの向き ─ 図解(平らな面=光らない 40° を客から隠す)');
  const panelXs = [20, 250, 480];
  panelXs.forEach(function (x) {
    try {
      const panel = slide.insertShape(SlidesApp.ShapeType.RECTANGLE, x, 62, 220, 328);
      panel.getFill().setSolidFill(_CP_COLOR_LIGHT_ROW);
      panel.getBorder().setTransparent();
    } catch (e) {}
  });

  _cp_addPlainText(slide, 30, 70, 200, 28, '① 断面 ─ 320° 光る / 40° 光らない', { fontSize: 10, bold: true });
  _cp_addPlainText(slide, 50, 112, 160, 20, '光らない 40°(平らな面)', { fontSize: 9, bold: true, color: _CP_COLOR_TUBE_DARK });
  _cp_drawTubeSection(slide, 130, 210, 110, 'top');
  _cp_addPlainText(slide, 55, 272, 150, 20, '光る 320°(円形の面)', { fontSize: 9, bold: true, color: _CP_COLOR_OK });
  _cp_addPlainText(slide, 30, 325, 200, 42, 'アクリルケースに入れても向きは同じ。挿入時にねじれないこと', { fontSize: 8 });

  const roofX = 250;
  _cp_addPlainText(slide, roofX + 10, 70, 200, 28, '② 屋根トラス ─ 平らな面を「上(天井側)」に', { fontSize: 10, bold: true });
  _cp_addPlainText(slide, roofX + 15, 94, 190, 14, 'トラス(屋根)', { fontSize: 8, bold: true, color: _CP_COLOR_GRAY_TEXT });
  try {
    const truss = slide.insertShape(SlidesApp.ShapeType.RECTANGLE, roofX + 15, 116, 190, 12);
    truss.getFill().setSolidFill(_CP_COLOR_TRUSS);
    truss.getBorder().setTransparent();
  } catch (e) {}
  _cp_drawTubeSection(slide, roofX + 60, 170, 70, 'top');
  _cp_drawTubeSection(slide, roofX + 160, 170, 70, 'bottom');
  _cp_addPlainText(slide, roofX + 25, 202, 70, 18, 'OK', { fontSize: 12, bold: true, color: _CP_COLOR_OK });
  _cp_addPlainText(slide, roofX + 8, 221, 100, 34, '平らな面が上=客に見えない', { fontSize: 8, color: _CP_COLOR_OK });
  _cp_addPlainText(slide, roofX + 135, 202, 70, 18, 'NG', { fontSize: 12, bold: true, color: _CP_COLOR_HIGHLIGHT_TEXT });
  _cp_addPlainText(slide, roofX + 116, 221, 96, 34, '暗い帯が下から見える', { fontSize: 8, color: _CP_COLOR_HIGHLIGHT_TEXT });
  try {
    const arrow = slide.insertShape(SlidesApp.ShapeType.UP_ARROW, roofX + 95, 300, 30, 45);
    arrow.getFill().setSolidFill('#616161');
    arrow.getBorder().setTransparent();
  } catch (e) {}
  _cp_addPlainText(slide, roofX + 45, 350, 130, 20, '客は下から見上げる', { fontSize: 9, bold: true });

  const pillarX = 480;
  _cp_addPlainText(slide, pillarX + 10, 70, 200, 28, '③ 柱 ─ 2本を「背中合わせ」に', { fontSize: 10, bold: true });
  _cp_addPlainText(slide, pillarX + 15, 98, 190, 18, 'OK: 平らな面同士を合わせる', { fontSize: 9, bold: true, color: _CP_COLOR_OK });
  try {
    const truss = slide.insertShape(SlidesApp.ShapeType.RECTANGLE, pillarX + 100, 120, 12, 170);
    truss.getFill().setSolidFill(_CP_COLOR_TRUSS);
    truss.getBorder().setTransparent();
  } catch (e) {}
  _cp_drawTubeSection(slide, pillarX + 70, 190, 56, 'right');
  _cp_drawTubeSection(slide, pillarX + 142, 190, 56, 'left');
  _cp_drawTubeSection(slide, pillarX + 60, 335, 40, 'left');
  _cp_addPlainText(slide, pillarX + 85, 314, 125, 42, 'NG: 1本だと暗い帯がどこかから見える', { fontSize: 8, bold: true, color: _CP_COLOR_HIGHLIGHT_TEXT });
}

/** ブース全体に対するチューブライトの配置原則を正面図と平面図で示す。 */
function _cp_addTubeLightPlacementSlide(pres, p) {
  const slide = pres.appendSlide(SlidesApp.PredefinedLayout.BLANK);
  _cp_addPageTitle(slide, '0', 'チューブライト配置計画 ─ ブース全体図(正面図 / 平面図)');

  [[20, 62, 350, 328], [385, 62, 315, 328]].forEach(function (box) {
    try {
      const panel = slide.insertShape(SlidesApp.ShapeType.RECTANGLE, box[0], box[1], box[2], box[3]);
      panel.getFill().setSolidFill(_CP_COLOR_LIGHT_ROW);
      panel.getBorder().setTransparent();
    } catch (e) {}
  });

  // 正面図: 屋根梁の下面と、3 本の柱の両側にチューブを配置する。
  _cp_addPlainText(slide, 30, 68, 330, 18, '正面図 ─ 通路(客側)から見る', { fontSize: 10, bold: true });
  try {
    const ground = slide.insertShape(SlidesApp.ShapeType.RECTANGLE, 35, 330, 320, 2);
    ground.getFill().setSolidFill('#9E9E9E');
    ground.getBorder().setTransparent();
    [55, 188, 321].forEach(function (px) {
      const pillar = slide.insertShape(SlidesApp.ShapeType.RECTANGLE, px, 130, 14, 200);
      pillar.getFill().setSolidFill(_CP_COLOR_TRUSS);
      pillar.getBorder().setTransparent();
    });
    const roof = slide.insertShape(SlidesApp.ShapeType.RECTANGLE, 45, 112, 300, 18);
    roof.getFill().setSolidFill(_CP_COLOR_TRUSS);
    roof.getBorder().setTransparent();
  } catch (e) {}
  _cp_drawTubeRun(slide, 50, 130, 290, 8, 'top');
  [55, 188, 321].forEach(function (px) {
    _cp_drawTubeRun(slide, px - 9, 140, 7, 180, 'right');
    _cp_drawTubeRun(slide, px + 16, 140, 7, 180, 'left');
  });
  _cp_addPlainText(slide, 95, 95, 200, 14, '屋根: 平らな面を上(天井側)へ', { fontSize: 8, bold: true, color: _CP_COLOR_OK });
  _cp_addPlainText(slide, 70, 340, 260, 14, '柱: 2本を背中合わせ(平らな面同士を内側)', { fontSize: 8, bold: true, color: _CP_COLOR_OK });
  _cp_addPlainText(slide, 150, 364, 100, 16, '👁 客(通路)', { fontSize: 9, bold: true });

  // 平面図: 奥・左右の 3 方を囲み、手前を通路側の開口とする。
  _cp_addPlainText(slide, 395, 68, 300, 18, '平面図 ─ 上から見る(通路側が開口)', { fontSize: 10, bold: true });
  try {
    [[420, 105, 250, 10], [420, 105, 10, 200], [660, 105, 10, 200]].forEach(function (box) {
      const truss = slide.insertShape(SlidesApp.ShapeType.RECTANGLE, box[0], box[1], box[2], box[3]);
      truss.getFill().setSolidFill(_CP_COLOR_TRUSS);
      truss.getBorder().setTransparent();
    });
  } catch (e) {}
  _cp_drawTubeRun(slide, 430, 116, 230, 6, 'top');
  _cp_drawTubeRun(slide, 431, 116, 6, 185, 'left');
  _cp_drawTubeRun(slide, 653, 116, 6, 185, 'right');
  [[419, 104], [659, 104], [419, 299], [659, 299]].forEach(function (pos) {
    try {
      const pillar = slide.insertShape(SlidesApp.ShapeType.RECTANGLE, pos[0], pos[1], 12, 12);
      pillar.getFill().setSolidFill('#78909C');
      pillar.getBorder().setTransparent();
    } catch (e) {}
  });
  [[425, 110], [665, 110], [425, 305], [665, 305]].forEach(function (center) {
    _cp_drawTubeSection(slide, center[0] - 12, center[1], 9, 'right');
    _cp_drawTubeSection(slide, center[0] + 12, center[1], 9, 'left');
  });
  _cp_addPlainText(slide, 470, 318, 160, 16, '通路(客側) ─ 開口', { fontSize: 9, bold: true });
  [470, 540, 610].forEach(function (x) {
    try {
      const arrow = slide.insertShape(SlidesApp.ShapeType.UP_ARROW, x, 333, 12, 16);
      arrow.getFill().setSolidFill('#616161');
      arrow.getBorder().setTransparent();
    } catch (e) {}
  });
  _cp_addPlainText(slide, 395, 353, 300, 12, '本数・長さ・電源位置は案件のアイテムリスト/図面に従う。この図は向きと配置の原則。', { fontSize: 7, color: _CP_COLOR_GRAY_TEXT });
  try {
    [[395, _CP_COLOR_TUBE_LIT], [487, _CP_COLOR_TUBE_DARK], [621, _CP_COLOR_TRUSS]].forEach(function (item) {
      const swatch = slide.insertShape(SlidesApp.ShapeType.RECTANGLE, item[0], 374, 7, 7);
      swatch.getFill().setSolidFill(item[1]);
      swatch.getBorder().setTransparent();
    });
  } catch (e) {}
  _cp_addPlainText(slide, 405, 369, 80, 16, '緑=発光面', { fontSize: 7 });
  _cp_addPlainText(slide, 497, 369, 122, 16, '黒帯=非発光面(客から隠す)', { fontSize: 7 });
  _cp_addPlainText(slide, 631, 369, 62, 16, '灰=トラス', { fontSize: 7 });
}

function _cp_renderPhaseBox(slide, phase, x, y, w, h) {
  if (!phase) return;
  // 見出し帯
  const isMostImportant = /最重要/.test(phase.phase || '');
  const headerBg = isMostImportant ? _CP_COLOR_HIGHLIGHT_BG : _CP_COLOR_DARK_HEADER;
  const headerColor = isMostImportant ? _CP_COLOR_HIGHLIGHT_TEXT : _CP_COLOR_WHITE;
  const headerBar = slide.insertShape(SlidesApp.ShapeType.RECTANGLE, x, y, w, 24);
  headerBar.getFill().setSolidFill(headerBg);
  headerBar.getBorder().setTransparent();
  headerBar.getText().setText(phase.phase || '');
  try { headerBar.getText().getTextStyle().setFontSize(11).setBold(true).setForegroundColor(headerColor); } catch (e) {}
  // meta 行
  const meta = (phase.time || '') + ' ／ 担当: ' + (phase.owner || '');
  const metaTb = slide.insertTextBox(meta, x, y + 26, w, 18);
  try { metaTb.getText().getTextStyle().setFontSize(9).setForegroundColor(_CP_COLOR_GRAY_TEXT).setItalic(true); } catch (e) {}
  // steps
  const steps = phase.steps || [];
  const highlightSet = {};
  (phase.highlight_indexes || []).forEach(function (idx) { highlightSet[idx] = true; });
  const bodyLines = steps.map(function (s) { return '・' + s; }).join('\n');
  const body = slide.insertTextBox(bodyLines, x, y + 48, w, h - 50);
  try {
    body.getText().getTextStyle().setFontSize(9).setForegroundColor('#333333');
    // 強調行に色を当てる: 各 step は 「・...\n」 で連結。 開始 offset を line ごとに計算
    let offset = 0;
    steps.forEach(function (s, idx) {
      const len = ('・' + s).length;
      if (highlightSet[idx]) {
        try { body.getText().getRange(offset, offset + len).getTextStyle().setBold(true).setForegroundColor(_CP_COLOR_HIGHLIGHT_TEXT); } catch (e) {}
      }
      offset += len + 1; // '\n'
    });
  } catch (e) {}
}

/** 15/23. 破損防止 & 立会 */
function _cp_addSafetyCheckSlide(pres, sc, pageTitle, includeCheckItems, teardownRisks) {
  if (!sc) return;
  const slide = pres.appendSlide(SlidesApp.PredefinedLayout.BLANK);
  _cp_addPageTitle(slide, '0', pageTitle);
  // 左: prevention_notes
  const leftTitle = slide.insertTextBox('重要パーツの破損防止', 30, 70, 340, 20);
  try { leftTitle.getText().getTextStyle().setFontSize(11).setBold(true).setForegroundColor('#212121'); } catch (e) {}
  _cp_addBulletList(slide, 30, 92, 340, 290, sc.prevention_notes || [], { fontSize: 9 });
  // 右: check_items (設営用) or teardown risks (撤去用)
  if (includeCheckItems && Array.isArray(sc.check_items)) {
    const rightTitle = slide.insertTextBox('立会者チェック(収納前・完成時)', 375, 70, 320, 20);
    try { rightTitle.getText().getTextStyle().setFontSize(11).setBold(true).setForegroundColor('#212121'); } catch (e) {}
    const rows = [['No', 'チェック項目', 'サイン']];
    sc.check_items.forEach(function (ci) {
      rows.push([String(ci.no || ''), ci.item || '', ci.sign || '—']);
    });
    _cp_drawTable(slide, 375, 92, 320, 280, rows, { headerRow: true, fontSize: 8 });
  } else if (teardownRisks && Array.isArray(teardownRisks.risks)) {
    // 撤去では右側に想定リスク表
    const rightTitle = slide.insertTextBox('想定リスクと対策', 375, 70, 320, 20);
    try { rightTitle.getText().getTextStyle().setFontSize(11).setBold(true).setForegroundColor('#212121'); } catch (e) {}
    const rows = [['リスク', '対策', '担当']];
    teardownRisks.risks.forEach(function (r) {
      rows.push([r.risk || '', r.action || '', r.owner || '']);
    });
    _cp_drawTable(slide, 375, 92, 320, 280, rows, { headerRow: true, fontSize: 8, highlightRows: [1] });
  }
}

/** 16. 想定リスク & 進捗チェックポイント */
function _cp_addRisksCheckpointsSlide(pres, rc, pageTitle) {
  if (!rc) return;
  const slide = pres.appendSlide(SlidesApp.PredefinedLayout.BLANK);
  _cp_addPageTitle(slide, '0', pageTitle);
  // 左: リスク表
  const leftTitle = slide.insertTextBox('想定リスクと対策', 30, 68, 340, 20);
  try { leftTitle.getText().getTextStyle().setFontSize(11).setBold(true).setForegroundColor('#212121'); } catch (e) {}
  const risksRows = [['リスク', '対策', '担当']];
  (rc.risks || []).forEach(function (r) {
    risksRows.push([r.risk || '', r.action || '', r.owner || '']);
  });
  _cp_drawTable(slide, 30, 90, 340, 220, risksRows, { headerRow: true, fontSize: 8, highlightRows: [1] });
  // 右: 15分単位チェックポイント表
  const rightTitle = slide.insertTextBox('15分単位チェックポイント(抜粋)', 375, 68, 320, 20);
  try { rightTitle.getText().getTextStyle().setFontSize(11).setBold(true).setForegroundColor('#212121'); } catch (e) {}
  const cpRows = [['時刻', '完了すべき項目']];
  (rc.checkpoints || []).forEach(function (cp) {
    cpRows.push([cp.time || '', cp.item || '']);
  });
  _cp_drawTable(slide, 375, 90, 320, 220, cpRows, { headerRow: true, fontSize: 9 });
  // priority_note (下部帯)
  if (rc.priority_note) {
    const note = slide.insertTextBox(rc.priority_note, 30, 340, 665, 40);
    try { note.getText().getTextStyle().setFontSize(9).setItalic(true).setForegroundColor(_CP_COLOR_GRAY_TEXT); } catch (e) {}
  }
}

/** 17/24. 緊急時 & 完了報告 */
function _cp_addEmergencyReportSlide(pres, er, pageTitle) {
  if (!er) return;
  const slide = pres.appendSlide(SlidesApp.PredefinedLayout.BLANK);
  _cp_addPageTitle(slide, '0', pageTitle);
  // 左: 緊急時表
  const leftTitle = slide.insertTextBox('緊急時・人員変更', 30, 68, 340, 20);
  try { leftTitle.getText().getTextStyle().setFontSize(11).setBold(true).setForegroundColor('#212121'); } catch (e) {}
  const rows = [['事象', '対応']];
  (er.emergencies || []).forEach(function (e2) {
    rows.push([e2.issue || '', e2.action || '']);
  });
  _cp_drawTable(slide, 30, 90, 340, 260, rows, { headerRow: true, fontSize: 8 });
  // 右: 完了報告テンプレ (灰色ボックス)
  const rightTitle = slide.insertTextBox('完了報告テンプレート', 375, 68, 320, 20);
  try { rightTitle.getText().getTextStyle().setFontSize(11).setBold(true).setForegroundColor('#212121'); } catch (e) {}
  const box = slide.insertShape(SlidesApp.ShapeType.RECTANGLE, 375, 90, 320, 260);
  box.getFill().setSolidFill(_CP_COLOR_LIGHT_ROW);
  box.getBorder().setTransparent();
  box.getText().setText(er.report_template || '');
  try { box.getText().getTextStyle().setFontSize(9).setForegroundColor('#333333'); } catch (e) {}
}

/** 19. 撤去 班分け + 全体スケジュール 併設 */
function _cp_addTeamAndScheduleSideBySide(pres, ta, sched, pageTitle) {
  const slide = pres.appendSlide(SlidesApp.PredefinedLayout.BLANK);
  _cp_addPageTitle(slide, '0', pageTitle + ' (' + ((sched && sched.range) || '') + ')');
  // 左: 班分け
  if (ta) {
    const leftTitle = slide.insertTextBox('班分け', 30, 68, 340, 20);
    try { leftTitle.getText().getTextStyle().setFontSize(11).setBold(true).setForegroundColor('#212121'); } catch (e) {}
    if (ta.note) {
      const nt = slide.insertTextBox(ta.note, 30, 88, 340, 16);
      try { nt.getText().getTextStyle().setFontSize(8).setForegroundColor(_CP_COLOR_HIGHLIGHT_TEXT); } catch (e) {}
    }
    const rows = [['班', '構成', '主担当作業']];
    const highlightRows = [];
    (ta.groups || []).forEach(function (g, i) {
      rows.push([g.name || '', g.members || '', g.role || '']);
      if (g.highlight) highlightRows.push(i + 1);
    });
    _cp_drawTable(slide, 30, 106, 340, 240, rows, { headerRow: true, fontSize: 8, highlightRows: highlightRows });
  }
  // 右: 全体スケジュール
  if (sched) {
    const rightTitle = slide.insertTextBox('全体スケジュール', 375, 68, 320, 20);
    try { rightTitle.getText().getTextStyle().setFontSize(11).setBold(true).setForegroundColor('#212121'); } catch (e) {}
    const rows = [['フェーズ', '時刻', '担当']];
    const highlightRows = [];
    (sched.phases || []).forEach(function (p, i) {
      rows.push([p.phase || '', p.time || '', p.owner || '']);
      if (p.highlight) highlightRows.push(i + 1);
    });
    _cp_drawTable(slide, 375, 90, 320, 260, rows, { headerRow: true, fontSize: 8, highlightRows: highlightRows });
  }
}

/** 25. 確定後差替項目 */
function _cp_addUnconfirmedItemsSlide(pres, parsed) {
  const slide = pres.appendSlide(SlidesApp.PredefinedLayout.BLANK);
  _cp_addPageTitle(slide, '0', '確定後に差し替える項目(未確定事項)');
  const items = parsed.unconfirmed_items || [];
  _cp_addBulletList(slide, 30, 70, 665, 320, items, { fontSize: 11 });
}

/** 26. 最終メッセージ (dark bg) */
function _cp_addFooterMessageSlide(pres, parsed) {
  const slide = pres.appendSlide(SlidesApp.PredefinedLayout.BLANK);
  _cp_setSlideBackground(slide, _CP_COLOR_DARK_BG);
  const fm = parsed.footer_message || {};
  const main = slide.insertTextBox(fm.main || '', 60, 150, 600, 60);
  try { main.getText().getTextStyle().setFontSize(30).setBold(true).setForegroundColor(_CP_COLOR_WHITE); } catch (e) {}
  const sub = slide.insertTextBox(fm.sub || '', 60, 215, 600, 40);
  try { sub.getText().getTextStyle().setFontSize(16).setForegroundColor('#CFD8DC'); } catch (e) {}
  const footer = slide.insertTextBox(fm.footer || '', 60, 350, 600, 20);
  try { footer.getText().getTextStyle().setFontSize(9).setForegroundColor('#B0BEC5'); } catch (e) {}
}

// ─────────────────────────────────────────────────────────────
// Doc 版 (バックアップ・検索用)
// ─────────────────────────────────────────────────────────────

/**
 * 施工手順書 Doc 版 (プレーンテキスト版)。 検索・共有・貼付用途。
 */
function _Phase2_buildConstructionPlanDoc(c, parsed, folderId) {
  const docName = c.caseId + '_' + c.caseName + '_施工手順書_Fable5';
  const doc = DocumentApp.create(docName);
  const body = doc.getBody();
  body.appendParagraph(parsed.title || '施工手順書【設営+撤去】').setHeading(DocumentApp.ParagraphHeading.TITLE);
  if (parsed.subtitle) body.appendParagraph(parsed.subtitle);
  if (parsed.cover_info) {
    const ci = parsed.cover_info;
    if (ci.venue) body.appendParagraph('会場: ' + ci.venue);
    if (ci.setup_date) body.appendParagraph('設営: ' + ci.setup_date + ' / 撤去: ' + (ci.teardown_date || ''));
  }
  body.appendParagraph('');

  // 前提条件
  body.appendParagraph('■ 前提条件サマリー').setHeading(DocumentApp.ParagraphHeading.HEADING1);
  (parsed.prerequisites || []).forEach(function (p) {
    body.appendParagraph('・' + p.key + ': ' + p.value);
  });
  body.appendParagraph('');

  // 絶対に守るべき項目
  const rules = parsed.absolute_rules || [];
  body.appendParagraph('■ 絶対に守るべきこと (共通 ' + rules.length + '項目)').setHeading(DocumentApp.ParagraphHeading.HEADING1);
  rules.forEach(function (r) {
    body.appendParagraph((r.no || '') + '. ' + (r.title || '') + ' — ' + (r.body || ''));
  });
  body.appendParagraph('');

  // 先行リスク
  body.appendParagraph('■ 先行して潰すべき重大リスク').setHeading(DocumentApp.ParagraphHeading.HEADING1);
  (parsed.critical_risks || []).forEach(function (r) {
    body.appendParagraph('・' + (r.issue || '') + ' → ' + (r.action || ''));
  });
  body.appendParagraph('');

  // 設営 / 撤去 それぞれ
  ['setup', 'teardown'].forEach(function (key) {
    const s = parsed[key];
    if (!s) return;
    const label = key === 'setup' ? '第1部 設営手順書' : '第2部 撤去手順書';
    body.appendParagraph(label + ' (' + (s.date_time || '') + ')').setHeading(DocumentApp.ParagraphHeading.HEADING1);
    // 班分け
    if (s.team_assignment && s.team_assignment.groups) {
      body.appendParagraph('■ 班分け').setHeading(DocumentApp.ParagraphHeading.HEADING2);
      s.team_assignment.groups.forEach(function (g) {
        body.appendParagraph('・' + (g.name || '') + ' / ' + (g.members || '') + ' / ' + (g.role || ''));
      });
      (s.team_assignment.leader_notes || []).forEach(function (n) {
        body.appendParagraph('  ' + n);
      });
    }
    // 全体スケジュール
    if (s.overall_schedule && s.overall_schedule.phases) {
      body.appendParagraph('■ 全体スケジュール (' + (s.overall_schedule.range || '') + ')').setHeading(DocumentApp.ParagraphHeading.HEADING2);
      s.overall_schedule.phases.forEach(function (p) {
        body.appendParagraph('・' + (p.phase || '') + ' | ' + (p.time || '') + ' | ' + (p.duration || '') + ' | ' + (p.owner || '') + ' | ' + (p.content || ''));
      });
    }
    // フェーズ詳細
    if (Array.isArray(s.phase_details)) {
      body.appendParagraph('■ フェーズ手順').setHeading(DocumentApp.ParagraphHeading.HEADING2);
      s.phase_details.forEach(function (p) {
        body.appendParagraph(p.phase + '  ' + (p.time || '') + ' / ' + (p.owner || '')).setHeading(DocumentApp.ParagraphHeading.HEADING3);
        (p.steps || []).forEach(function (st) {
          body.appendParagraph('・' + st);
        });
      });
    }
    {
      const fixedPart = key === 'teardown' ? 'teardown' : null;
      (parsed.fixed_procedures || []).filter(function (p) { return (p.part || null) === fixedPart; }).forEach(function (p) {
        body.appendParagraph('■ ' + p.title).setHeading(DocumentApp.ParagraphHeading.HEADING2);
        body.appendParagraph(p.intro || '');
        (p.steps || []).forEach(function (step, index) {
          body.appendParagraph((index + 1) + '. ' + step);
        });
        (p.notes || []).forEach(function (note) {
          body.appendParagraph('⚠ ' + note);
        });
        if (p.figure) body.appendParagraph('※ 図解(向き・ブース全体の配置計画)は Slides 版を参照。');
      });
    }
    // 完了報告テンプレ
    if (s.emergency_report && s.emergency_report.report_template) {
      body.appendParagraph('■ 完了報告テンプレート').setHeading(DocumentApp.ParagraphHeading.HEADING2);
      body.appendParagraph(s.emergency_report.report_template);
    }
    body.appendParagraph('');
  });

  // 確定後差替項目
  body.appendParagraph('■ 確定後に差し替える項目').setHeading(DocumentApp.ParagraphHeading.HEADING1);
  (parsed.unconfirmed_items || []).forEach(function (u) { body.appendParagraph('・' + u); });

  // フッターメッセージ
  if (parsed.footer_message) {
    body.appendParagraph('');
    body.appendParagraph(parsed.footer_message.main || '').setHeading(DocumentApp.ParagraphHeading.HEADING1);
    if (parsed.footer_message.sub) body.appendParagraph(parsed.footer_message.sub);
  }

  doc.saveAndClose();
  if (folderId) {
    try { DriveApp.getFileById(doc.getId()).moveTo(DriveApp.getFolderById(folderId)); } catch (e) {}
  }
  return { id: doc.getId(), url: doc.getUrl() };
}

/** 固定コンテンツだけの Slides を生成して PDF も保存する(実描画確認用)。 */
function _debug_renderFixedProcedureSlides() {
  const parsed = Phase2_ConstructionPlan_ensureFixedContent({ title: 'debug', setup: {} });
  const name = 'debug_fixed_procedures_' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmmss');
  const pres = SlidesApp.create(name);
  try { pres.getSlides()[0].remove(); } catch (e) {}
  _cp_addAbsoluteRulesSlide(pres, parsed);
  _cp_addFixedProcedureSlides(pres, parsed);
  _cp_addFixedProcedureSlides(pres, parsed, 'teardown');
  pres.saveAndClose();
  const folder = _cmdQueue_childFolder(DriveApp.getFolderById(CMD_FOLDER_ID), 'debug_renders');
  const slidesFile = DriveApp.getFileById(pres.getId());
  slidesFile.moveTo(folder);
  const pdf = folder.createFile(slidesFile.getAs('application/pdf').setName(name + '.pdf'));
  return { slidesId: pres.getId(), slidesUrl: pres.getUrl(), pdfId: pdf.getId(), pdfName: name + '.pdf', slideCount: SlidesApp.openById(pres.getId()).getSlides().length };
}
