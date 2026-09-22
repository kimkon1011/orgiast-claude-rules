const ELECTRICAL_CLIENT_EXCEPTIONS = Object.freeze([
  { names: ['クラフトフィックス'], billing: 'orgiast' },
  { names: ['ネクサスエージェント', 'NXA'], fixedApplicationWatts: 500 }
]);

const ELECTRICAL_ORGIAST_BILLING = [
  '会社名：株式会社オージャスト', '住所：〒537-0001 大阪府大阪市東成区深江北2-15-24 東邦ビル 212',
  '担当者：岩本里音', '連絡先①：seisaku-team@orgiast.jp', '連絡先②：r96490955@gmail.com',
  '電話番号：080-9327-5720', '※PDF送付が可能であればPDFでお送りいただきたい旨を記載'
].join('\n');

function ElectricalMailTemplates_build(c, calc, opts) {
  opts = opts || {};
  const eventName = c.caseName || '（展示会名）';
  const producer = opts.producerName || '（プロデューサー名）';
  const clientContact = opts.clientContact || '（クライアント担当者名）';
  return [
    { title: '(a) プロデューサー宛 確認依頼', body: producer + 'さん\n\n' + eventName + 'の電気申請書類を作成しました。申請容量 ' + calc.applicationKw + 'kw、コンセント ' + calc.requiredOutlets + '口です。申請内容と電気設備取付位置をご確認ください。' },
    { title: '(b) クライアント宛 申請書送付', body: clientContact + '様\n\nお世話になっております。' + eventName + 'の電気申請書類をお送りします。必要容量は ' + calc.applicationKw + 'kw、必要コンセント数は ' + calc.requiredOutlets + '口です。内容をご確認のうえ、主催者指定の方法でご提出ください。' },
    { title: '(c) 電気会社／運営事務局宛 申込書送付', body: 'ご担当者様\n\nお世話になっております。' + eventName + 'の電気申込書を送付いたします。ご確認をお願いいたします。\n\n※送信時はクライアント担当者をBCCに入れてください。' }
  ];
}

function ElectricalApplication_clientException(clientName) {
  const name = String(clientName || '');
  return ELECTRICAL_CLIENT_EXCEPTIONS.find(function (rule) { return rule.names.some(function (x) { return name.indexOf(x) >= 0; }); }) || null;
}
