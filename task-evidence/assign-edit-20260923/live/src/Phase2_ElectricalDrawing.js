/** 電気設備取付位置図をGoogle Slidesで簡易描画する。 */
function Phase2_ElectricalDrawing_generate(c, calc, opts) {
  opts = opts || {};
  const name = c.caseName + '_電気設備取付位置図_' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd');
  const pres = SlidesApp.create(name);
  const slide = pres.getSlides()[0];
  try { slide.getPageElements().forEach(function (el) { el.remove(); }); } catch (e) {}
  _cp_addPageTitle(slide, '電', '電気設備取付位置図（確認用）');
  const booth = ElectricalCalc_parseBoothSize(opts.boothSize || c.boothSize);
  const x = 90, y = 85, w = 540, h = 240;
  const outline = slide.insertShape(SlidesApp.ShapeType.RECTANGLE, x, y, w, h);
  outline.getFill().setTransparent(); outline.getBorder().setWeight(2);
  slide.insertTextBox('ブース外形 ' + (booth.widthM || '?') + 'm × ' + (booth.depthM || '?') + 'm', x + 8, y + 8, 220, 24);
  if (calc.needsDistributionBoard) {
    const board = slide.insertShape(SlidesApp.ShapeType.RECTANGLE, x + w / 2 - 30, y + 20, 60, 30);
    board.getFill().setSolidFill('#F4CCCC'); board.getText().setText('分電盤');
  }
  const count = calc.requiredOutlets;
  for (let i = 0; i < count; i++) {
    const leftSide = i % 2 === 0;
    const sideIndex = Math.floor(i / 2) + 1;
    const px = leftSide ? x + 22 : x + w - 38;
    const py = y + Math.min(h - 35, 45 + sideIndex * (h - 70) / (Math.ceil(count / 2) + 1));
    const dot = slide.insertShape(SlidesApp.ShapeType.ELLIPSE, px, py, 16, 16);
    dot.getFill().setSolidFill('#333333'); dot.getBorder().setTransparent();
  }
  slide.insertTextBox('凡例：■ 分電盤 ／ ● コンセント（1口1000W想定）', 90, 337, 420, 22);
  slide.insertTextBox('※位置は都度プロデューサー確認が必要。壁面・柱沿いに配線し、来場者動線を横断させない。', 90, 365, 560, 22).getText().getTextStyle().setForegroundColor('#C62828');
  pres.saveAndClose();
  DriveApp.getFileById(pres.getId()).moveTo(DriveApp.getFolderById(c.folderId));
  return { id: pres.getId(), url: pres.getUrl(), title: name, simplified: !opts.hasLayout };
}
