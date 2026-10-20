const ELECTRICAL_PHASE = 2;

function Phase2_ElectricalApplication_generate(caseId, opts) {
  opts = opts || {};
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  const failures = [], artifacts = [], confirmations = [];
  let sourceText = '', source = '';
  try { sourceText = _Electrical_readItemList(c.zissiId); if (sourceText) source = '実施計画書「アイテムリスト」'; } catch (e) { console.warn('electrical item list load err: ' + e); }
  if (!sourceText) {
    try { sourceText = _Electrical_readLayoutFiles(c.folderId); if (sourceText) source = '案件フォルダ内レイアウト／パース資料'; } catch (e) { console.warn('electrical layout load err: ' + e); }
  }
  if (!sourceText && String(opts.equipmentText || '').trim()) { sourceText = String(opts.equipmentText).trim(); source = '貼り付けテキスト'; }
  let mapped = [];
  if (sourceText) {
    try { mapped = _Electrical_mapEquipment(sourceText, c, opts); }
    catch (e) { failures.push({ artifact: '機材抽出', error: e.message }); confirmations.push({ category: '電気/使用機材', content: '機材テキストの自動解析に失敗しました。使用機材・数量・消費電力を確認してください: ' + e.message }); }
  } else confirmations.push({ category: '電気/使用機材', content: '使用機材リストが未確定です。機材名・数量・100V/200Vを確認してください。部分成果物を作成しました。' });

  const exception = ElectricalApplication_clientException(c.clientName);
  let calc = ElectricalCalc_calculate(mapped, { boothSize: opts.boothSizeOverride || c.boothSize, highLoadOutletCount: opts.highLoadOutletCount });
  if (exception && exception.fixedApplicationWatts !== undefined) {
    calc.applicationWatts = exception.fixedApplicationWatts; calc.applicationKw = Math.ceil(exception.fixedApplicationWatts / 1000);
    calc.requiredOutlets = calc.applicationKw; calc.needsDistributionBoard = calc.applicationKw >= 3; calc.needsElectricianDispatch = calc.applicationKw >= 3 || ElectricalCalc_parseBoothSize(opts.boothSizeOverride || c.boothSize).exceeds6x6;
  }
  calc.unknownEquipment.forEach(function (x) { confirmations.push({ category: '電気/推定値', content: '機器マスタ未登録「' + x.name + '」のW値' + (x.unresolved ? 'が未確定です。計算には含めていません。' : 'は推定値 ' + x.watts + 'W です。確認してください。') }); });
  _Electrical_addFlagConfirmations(calc, confirmations);
  const date = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd');
  try { const a = _Electrical_createCalcSheet(c, calc, date); artifacts.push(a); } catch (e) { failures.push({ artifact: '電気容量計算書', error: e.message }); }
  try { const a = _Electrical_createApplicationDoc(c, calc, opts, exception, date); artifacts.push(a); } catch (e) { failures.push({ artifact: '電気申請書 記入データ一覧', error: e.message }); }
  try { const a = Phase2_ElectricalDrawing_generate(c, calc, { boothSize: opts.boothSizeOverride || c.boothSize, hasLayout: source === '案件フォルダ内レイアウト／パース資料' }); artifacts.push(a); if (a.simplified) confirmations.push({category:'電気/レイアウト',content:'最新レイアウト未取得のため、ブース外形だけの簡易図です。'}); } catch (e) { failures.push({ artifact: '電気設備取付位置図', error: e.message }); }
  failures.forEach(function (f) { confirmations.push({ category: '電気/生成エラー', content: f.artifact + 'を生成できませんでした: ' + f.error }); });
  if (confirmations.length) ConfirmationSheet_appendItems(caseId, confirmations, ELECTRICAL_PHASE);
  artifacts.forEach(function (a) { MasterWriteBack_recordArtifact(caseId, '電気申請書類', a.title, a.url); });
  CaseList_touchUpdatedAt(caseId);
  return { ok: failures.length === 0, partial: failures.length > 0, source: source || '未取得', artifacts: artifacts, failures: failures,
    summary: { totalWatts: calc.totalWatts, applicationWatts: calc.applicationWatts, applicationKw: calc.applicationKw, requiredOutlets: calc.requiredOutlets,
      needsDistributionBoard: calc.needsDistributionBoard, needsElectricianDispatch: calc.needsElectricianDispatch, needsPrimaryTrunkWork: calc.needsPrimaryTrunkWork,
      needsPrimaryTrunkWorkUncertain: calc.needsPrimaryTrunkWorkUncertain, has200V: calc.has200V } };
}

function _Electrical_readItemList(zissiId) {
  if (!zissiId) return '';
  const sh = SpreadsheetApp.openById(zissiId).getSheetByName('アイテムリスト');
  if (!sh || !sh.getLastRow()) return '';
  return sh.getDataRange().getDisplayValues().map(function (r) { return r.join('\t'); }).join('\n').slice(0, 30000);
}

function _Electrical_readLayoutFiles(folderId) {
  const folder = DriveApp.getFolderById(folderId), it = folder.getFiles(), lines = [];
  while (it.hasNext() && lines.length < 30) { const f = it.next(), n = f.getName(); if (/レイアウト|パース|図面/i.test(n)) lines.push('資料名: ' + n); }
  return lines.join('\n');
}

function _Electrical_mapEquipment(text, c, opts) {
  const pages = ManualLoader_findPages(['電灯・電力に関する申込','ブース内で利用する電気容量','電気設備取付位置図面の作り方']);
  const masterText = Object.keys(ELECTRICAL_EQUIPMENT_MASTER).map(function (n) { return n + ': ' + ELECTRICAL_EQUIPMENT_MASTER[n] + 'W'; }).join('\n');
  const res = ClaudeClient_call({ cachedContext: ['【確定機器マスタ】\n' + masterText].concat(pages.map(function (p) { return '# ' + p.title + '\n' + p.body; })), maxTokens: 3000,
    userMessage: '次の記載から電気を使う機材を抽出し、JSON配列だけを返してください。形式: [{"name":"原文の機器名","quantity":1,"watts":null,"voltage":100,"note":""}]。既知機器のwattsはnullのまま（コードがマスタから引く）。マスタ外のみ一般的W値を提案しnoteに「推定値」と書く。W値を捏造しない。200Vは明記時だけ200。\n案件: ' + c.caseName + '\n\n' + String(text).slice(0,30000) });
  const m = String(res.text || '').match(/\[[\s\S]*\]/); if (!m) throw new Error('機材JSONを抽出できません');
  const rows = JSON.parse(m[0]); if (!Array.isArray(rows)) throw new Error('機材JSONが配列ではありません'); return rows;
}

function _Electrical_createCalcSheet(c, calc, date) {
  const title = c.caseName + '_電気容量計算書_' + date, ss = SpreadsheetApp.create(title), sh = ss.getActiveSheet(); sh.setName('電気容量計算書');
  const rows = [['機器名','数量','単体ワット数(W)','合計ワット数(W)','備考欄']].concat(calc.equipment.map(function (x) { return [x.name,x.quantity,x.watts == null ? '' : x.watts,x.totalWatts,(x.estimated?'推定値 ':'') + x.note]; }));
  rows.push(['合計 w','','',calc.totalWatts,''],['合計（申請目安 w）+ バッファ 15.00%','','',calc.applicationWatts,''],['申請時に必要なkw数','','',calc.applicationKw,'kw'],['必要コンセント数（上限1000W/口計算）','','',calc.requiredOutlets,'口']);
  sh.getRange(1,1,rows.length,5).setValues(rows); sh.getRange(1,1,1,5).setFontWeight('bold').setBackground('#cfe2f3'); sh.setFrozenRows(1); sh.autoResizeColumns(1,5);
  DriveApp.getFileById(ss.getId()).moveTo(DriveApp.getFolderById(c.folderId)); return {title:title,url:ss.getUrl(),id:ss.getId()};
}

function _Electrical_createApplicationDoc(c, calc, opts, exception, date) {
  const title = c.caseName + '_電気申請書_記入データ一覧_' + date, doc = DocumentApp.create(title), body = doc.getBody(); body.appendParagraph(title).setHeading(DocumentApp.ParagraphHeading.HEADING1);
  const blank = '要確認', rows = [['記入欄','値','出どころ'],['小間位置番号',opts.boothNumber||blank,'案件情報'],['展示会名',c.caseName,'案件名'],['会社名（出展者名）',c.clientName,'クライアント'],['所在地',opts.clientAddress||blank,'クライアント'],['所属',opts.clientDepartment||blank,'クライアント'],['担当者',opts.clientContact||blank,'クライアント'],['TEL',opts.clientTel||blank,'クライアント'],['メールアドレス',opts.clientEmail||blank,'クライアント'],['自社で装飾を手配する','☑（欄があれば）','固定'],['小間数',opts.boothCount||blank,'案件情報'],['装飾施工会社名','株式会社オージャスト','固定'],['担当者（施工）',opts.directorName||opts.producerName||blank,'案件情報'],['TEL（施工）',opts.staffTel||blank,'案件情報'],['メールアドレス（施工）',opts.staffEmail||blank,'案件情報'],['使用する電源の種別','【電力】に☑','固定'],['一次側電気幹線工事供給申込容量',calc.applicationKw+' kw','計算結果'],['小間内（二次側）電気工事業者','「事務局指定電気工事業者に電気工事を依頼する」に☑','固定'],['オプション申込 コンセント(100V・15A・アース付)',calc.requiredOutlets+' 口','計算結果']];
  body.appendTable(rows); if (exception && exception.billing === 'orgiast') body.appendParagraph('【請求先特例】\n'+ELECTRICAL_ORGIAST_BILLING);
  body.appendParagraph('注意事項').setHeading(DocumentApp.ParagraphHeading.HEADING2);
  ['電気供給工事とコンセント申込は別申請のことがあります。出展要項で両方の申込方法を確認し、必ず両方提出してください。','「オプション申込内容」が別シートの場合は「照明・コンセント追加申込書」も記入し2枚セットで提出してください。','不明箇所はディレクター → プロデューサー → 社長の順で確認してください。','展示会ごとに申請書の宛先が異なります。','見積・請求・捺印はすべてクライアントに直接送ってもらってください。','記入例: 電気幹線工事申込書 https://drive.google.com/file/d/1-ZaiTv-ROAzSHGZIbau91TFKc3PGsB6k/view ／ 照明・コンセント追加申込書 https://drive.google.com/file/d/1aKybNK_zs953UY8HCpUSObn8r6SFjRAU/view'].forEach(function(x){body.appendListItem(x);});
  body.appendParagraph('メール文面').setHeading(DocumentApp.ParagraphHeading.HEADING2); ElectricalMailTemplates_build(c,calc,opts).forEach(function(x){body.appendParagraph(x.title).setHeading(DocumentApp.ParagraphHeading.HEADING3); body.appendParagraph(x.body);});
  if (/学会|医学会/.test(c.caseName)) { body.appendParagraph('学会案件：アドバイザー確認').setHeading(DocumentApp.ParagraphHeading.HEADING2); body.appendParagraph('福田誠司さんがいるLINEの部屋へ、申請書・ブース画像・小間割・展示マニュアルの小間サイズが分かる指定ページ（または運営マニュアル）を投稿し、確認を依頼してください。'); }
  doc.saveAndClose(); DriveApp.getFileById(doc.getId()).moveTo(DriveApp.getFolderById(c.folderId)); return {title:title,url:doc.getUrl(),id:doc.getId()};
}

function _Electrical_addFlagConfirmations(calc, out) {
  if (calc.needsDistributionBoard) out.push({category:'電気/工事士',content:'分電盤が必要です。電気工事士の手配要否を確認してください（関東: 株式会社電配／関西: 大村利一さん 090-9737-0316 または First、費用3.5〜4万円）。'});
  if (calc.needsPrimaryTrunkWork || calc.needsPrimaryTrunkWorkUncertain) out.push({category:'電気/一次幹線',content:calc.primaryTrunkWorkReason+'。一次幹線工事の要否を主催者に確認してください。'});
  if (calc.has200V) out.push({category:'電気/200V',content:'200V指定機材があります。200V電源の要否・容量・接続方法を確認してください。'});
  out.push({category:'電気/配置',content:'コンセント・分電盤の配置位置をプロデューサーが確認してください。'}, {category:'電気/会場料金',content:'「30ブースまで基本料金」方式の会場か、追加費用の有無を社長に確認してください。'}, {category:'電気/申請区分',content:'電気供給工事とコンセント申込が別申請か、出展要項で確認してください。'});
}

function _test_electricalApplicationQuickRoundTrip(caseId) { const r = Phase2_ElectricalApplication_generate(caseId,{equipmentText:'ノートPC 2台\n42インチモニター 1台\nロゴボックス 1台\n（備品コード2437）LED投光器 6台',highLoadOutletCount:0}); if (!r.artifacts || !r.artifacts.length) throw new Error('成果物が生成されませんでした'); return r; }
