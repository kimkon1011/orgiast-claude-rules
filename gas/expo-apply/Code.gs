/**
 * Overseas exhibition intake form receiver.
 * Notifies seisaku-team@orgiast.jp and sends an auto-reply to the submitter.
 *
 * Deploy as a web app: Execute as "Me", Who has access: "Anyone".
 * After deploy, put the /exec URL into apps/expo-apply/config.js FORM_ENDPOINT.
 * Do not store passwords or tokens in this project.
 */

var NOTIFY_EMAIL = 'seisaku-team@orgiast.jp';
var FROM_NAME = 'Re:Booth / Orgiast';

function doGet() {
  return json_({ ok: true, service: 'expo-apply' });
}

function doPost(e) {
  try {
    var data = parseBody_(e);
    if (isHoneypot_(data)) {
      return json_({ ok: true, id: 'ignored' });
    }
    var checked = validatePayload_(data);
    if (!checked.ok) {
      return json_({ ok: false, error: checked.error });
    }
    var id = Utilities.getUuid();
    sendNotify_(id, checked.data);
    sendAutoReply_(id, checked.data);
    return json_({ ok: true, id: id });
  } catch (err) {
    console.error(String(err && err.stack || err));
    return json_({ ok: false, error: 'submit_failed' });
  }
}

function parseBody_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    return {};
  }
  var raw = String(e.postData.contents);
  try {
    return JSON.parse(raw);
  } catch (err) {
    return {};
  }
}

function isHoneypot_(data) {
  var v = data && (data.honeypot || data.websiteExtra || data.fax);
  return !!(v && String(v).trim());
}

function validatePayload_(data) {
  if (!data || typeof data !== 'object') {
    return { ok: false, error: 'invalid_payload' };
  }
  var required = ['companyName', 'country', 'contactPerson', 'email', 'exhibitionName'];
  var out = {};
  required.forEach(function (key) {
    out[key] = String(data[key] || '').trim();
  });
  if (required.some(function (key) { return !out[key]; })) {
    return { ok: false, error: 'required' };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) {
    return { ok: false, error: 'email' };
  }
  var optional = [
    'companyNameJa', 'website', 'phone', 'boothSize', 'boothSizeOther',
    'startDate', 'endDate', 'message', 'lang', 'id'
  ];
  optional.forEach(function (key) {
    out[key] = String(data[key] || '').trim();
  });
  out.periodUndecided = !!data.periodUndecided;
  out.servicesNeeded = Array.isArray(data.servicesNeeded)
    ? data.servicesNeeded.map(function (s) { return String(s); }).filter(Boolean)
    : [];
  return { ok: true, data: out };
}

function sendNotify_(id, data) {
  var lines = [
    '海外企業向け展示会出展フォームから新規問い合わせです。',
    '受付番号: ' + id,
    '',
    'Company: ' + data.companyName,
    'Company (JA): ' + (data.companyNameJa || '-'),
    'Country / Region: ' + data.country,
    'Website: ' + (data.website || '-'),
    'Contact: ' + data.contactPerson,
    'Email: ' + data.email,
    'Phone: ' + (data.phone || '-'),
    'Exhibition: ' + data.exhibitionName,
    'Booth size: ' + (data.boothSize || '-') + (data.boothSizeOther ? ' (' + data.boothSizeOther + ')' : ''),
    'Dates: ' + (data.periodUndecided ? 'Undecided' : ((data.startDate || '-') + ' ~ ' + (data.endDate || '-'))),
    'Services: ' + (data.servicesNeeded.length ? data.servicesNeeded.join(', ') : '-'),
    '',
    'Message:',
    data.message || '-',
    '',
    'Language: ' + (data.lang || '-')
  ];
  MailApp.sendEmail({
    to: NOTIFY_EMAIL,
    subject: '[expo-apply] ' + data.companyName + ' / ' + data.exhibitionName,
    body: lines.join('\n'),
    name: FROM_NAME,
    replyTo: data.email
  });
}

function sendAutoReply_(id, data) {
  var ja = data.lang === 'ja';
  var subject = ja
    ? '【Re:ブース】展示会出展のご相談を受け付けました / ' + id.slice(0, 8)
    : 'We received your Japan exhibition inquiry / ' + id.slice(0, 8);
  var body = ja
    ? [
        data.contactPerson + ' 様',
        '',
        '日本の展示会出展に関するお問い合わせありがとうございます。株式会社オージャスト（Re:ブース）です。',
        '受付番号: ' + id,
        '',
        '担当者より、ご入力のメールアドレスへご連絡いたします。',
        'このメールは送信専用の自動返信です。',
        '',
        '株式会社オージャスト',
        'https://rebooth.co.jp/',
        'https://rebooth.co.jp/en/expo-apply/'
      ].join('\n')
    : [
        'Dear ' + data.contactPerson + ',',
        '',
        'Thank you for your inquiry about exhibiting at a trade show in Japan.',
        'This is an automated confirmation from Orgiast (Re:Booth).',
        'Reference number: ' + id,
        '',
        'Our team will follow up at the email address you provided.',
        'Please do not reply to this automated message.',
        '',
        'Orgiast Co., Ltd. / Re:Booth',
        'https://rebooth.co.jp/',
        'https://rebooth.co.jp/en/expo-apply/'
      ].join('\n');
  MailApp.sendEmail({
    to: data.email,
    subject: subject,
    body: body,
    name: FROM_NAME,
    replyTo: NOTIFY_EMAIL
  });
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
