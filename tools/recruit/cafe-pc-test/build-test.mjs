import ExcelJS from 'exceljs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const sourceRows = [
  ['第14回', '青空総合ケア研究会'], ['第8回', 'みらい栄養フォーラム'],
  ['第21回', '地域データ活用学会'], ['第21回', '地域データ活用学会'],
  ['第6回', '星野リハビリテーション会議'], ['第12回', 'こもれび医療安全学会'],
  ['第4回', '次世代受付システム研究会'], ['第9回', '北浜ウェルネス大会'],
  ['第9回', '北浜ウェルネス大会'], ['第7回', 'さくら在宅支援フォーラム'],
  ['第13回', '緑川臨床技術研究会'], ['第3回', 'ひかり健康情報学会']
];

const info = [
  ['青空総合ケア研究会', '第14回大会は2027年8月1日（日）～2日（月）、架空都青葉市の青葉コンベンションホールで開催。現地開催。大会長：空野 葵。'],
  ['みらい栄養フォーラム', '第8回フォーラムは2027/9/18（土）13:00～17:30。Zoomウェビナーで実施。代表：未来 花。'],
  ['地域データ活用学会', '第21回年会は2027年10月6日（水）から8日（金）。展示は10月7日（木）から8日（金）。架空県中央市 データプラザとオンラインのハイブリッド。'],
  ['地域データ活用学会（再掲）', '第21回年会：2027年10月6日～8日。データプラザ＋WEB併催。これは同じ案内の再掲です。'],
  ['星野リハビリテーション会議', '第6回は2027年11月4日（木）13：00～17：30、星野市民会館（架空県）で開催します。'],
  ['こもれび医療安全学会', '第12回大会の詳細日は未定。前回（2026年）は1月開催でした。2027年1月頃を予定。会場・開催方式は調整中。'],
  ['次世代受付システム研究会', '第4回研究会は2027年12月10日（金）～11日（土）。オンデマンド配信は12月20日まで。会場は架空府の新町交流館。'],
  ['北浜ウェルネス大会', '第9回大会：2028年2月3日（木）～4日（金）、北浜国際館（架空道）。会場参加のみ。'],
  ['北浜ウェルネス大会（再掲）', '第9回、2028/2/3-2/4。北浜国際館。先ほどと同一の大会です。'],
  ['さくら在宅支援フォーラム', '第7回は2028年3月12日（日）、13:00～17:30。Zoomによるオンライン開催。'],
  ['緑川臨床技術研究会', '掲載一覧は「第13回」ですが、公式案内は第14回。2028年4月20日（木）～21日（金）、緑川ホール（架空県）とWEBの併催。'],
  ['ひかり健康情報学会', '第3回大会は2028年6月頃。前回は6月開催。日付、会場、開催方法はいずれも未定。']
];

const rules = [
  ['1. 作業の流れ', '「一覧」を上から確認し、同じ学会名＋同じ会期が先にあれば重複です。「作業」へ値だけを入力し、最後に対応者名を書いてください。'],
  ['2. 変更禁止', '一覧にある会期・学会名は書き換えません。公式情報と違う場合は、備考に「第14回に変更」のように書きます。'],
  ['3. 開催開始日', '半角数字、西暦、ゼロ埋めなし（例：2027/8/1）。詳細日未定なら、前回と同じ月の1日を翌年で入力します。展示期間が学会期間と違う場合は展示開始日です。'],
  ['4. 開催期間', '例：2027年8月1日(日)～2日(月)。詳細日未定は「2027年1月頃予定(詳細日未定)」。1日開催は時間も「2027年11月4日(木) 13:00～17:30」と入力します。曜日も確認してください。'],
  ['5. 開催種類', '会場名だけなら「リアル」、ウェビナー・Zoomなら「WEB」、会場とWEB併催・ハイブリッドなら「混合WEB/リアル」。オンデマンド配信だけでは混合にしません。不明なら「不明」。'],
  ['6. 場所', '都道府県・会場が分からなければ「不明」と入力します。'],
  ['7. 重複', '重複行は「重複」列に「重複」と入力します。重複でない行は空欄にします。']
];

function title(ws, text, endColumn = 2) {
  ws.mergeCells(1, 1, 1, endColumn);
  const cell = ws.getCell('A1'); cell.value = text; cell.font = { bold: true, size: 18, color: { argb: 'FFFFFFFF' } };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF355E3B' } }; cell.alignment = { vertical: 'middle' }; ws.getRow(1).height = 28;
}

export async function build(outputPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cafe-pc-test.xlsx')) {
  const wb = new ExcelJS.Workbook(); wb.creator = '採用担当'; wb.subject = 'PC事務テスト';
  const intro = wb.addWorksheet('はじめに'); title(intro, 'カフェスタッフ応募者向け PC事務テスト');
  intro.getColumn(1).width = 24; intro.getColumn(2).width = 85;
  [['制限時間', '60分を目安にしてください。'], ['提出方法', '入力後、このファイルを保存して採用担当へ提出してください。'], ['課題', '「ルール」と「学会情報」を読み、「一覧」の12行を「作業」へ値のみで転記・整理してください。'], ['注意', '数式や書式のコピーは不要です。会期・学会名は一覧の表記を保ってください。']].forEach((r, i) => { intro.getRow(i + 3).values = r; });
  const ruleWs = wb.addWorksheet('ルール'); title(ruleWs, '入力ルール'); ruleWs.columns = [{ width: 22 }, { width: 100 }];
  rules.forEach((r, i) => { ruleWs.getRow(i + 3).values = r; ruleWs.getRow(i + 3).alignment = { wrapText: true, vertical: 'top' }; ruleWs.getRow(i + 3).height = 46; });
  const infoWs = wb.addWorksheet('学会情報'); title(infoWs, '架空の学会ホームページ情報'); infoWs.columns = [{ width: 7 }, { width: 32 }, { width: 100 }];
  infoWs.getRow(3).values = ['No.', 'ページ見出し', '掲載内容']; info.forEach((r, i) => { infoWs.getRow(i + 4).values = [i + 1, ...r]; infoWs.getRow(i + 4).alignment = { wrapText: true, vertical: 'top' }; infoWs.getRow(i + 4).height = 42; });
  const list = wb.addWorksheet('一覧'); title(list, '転記元一覧', 3); list.columns = [{ width: 10 }, { width: 16 }, { width: 34 }]; list.getRow(3).values = ['行番号', '会期', '学会名'];
  sourceRows.forEach((r, i) => { list.getRow(i + 4).values = [i + 1, ...r]; });
  const work = wb.addWorksheet('作業'); title(work, '回答欄', 11);
  const headers = ['行番号', '会期', '学会名', '開催開始日', '開催期間', '開催種類', '都道府県', '会場', '備考', '重複', '対応者名'];
  work.getRow(3).values = headers; work.columns = [9, 13, 30, 16, 38, 18, 14, 28, 22, 12, 18].map(width => ({ width }));
  for (let i = 0; i < 12; i++) { work.getCell(i + 4, 1).value = i + 1; work.getRow(i + 4).height = 28; }
  for (const ws of wb.worksheets) {
    ws.views = [{ state: 'frozen', ySplit: ws.name === '作業' || ws.name === '一覧' || ws.name === '学会情報' ? 3 : 1 }];
    ws.eachRow(row => row.eachCell(cell => { cell.alignment = { ...cell.alignment, vertical: 'middle', wrapText: true }; }));
    if (ws.getRow(3).cellCount > 1) ws.getRow(3).eachCell(c => { c.font = { bold: true }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBDD' } }; });
  }
  await wb.xlsx.writeFile(outputPath); return outputPath;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = await build(); console.log(`生成しました: ${out}`);
}
