import fs from 'node:fs';

const CONFIG_URL = new URL('../../config/invoice-cc.json', import.meta.url);

function addressList(value) {
  return (Array.isArray(value) ? value : [value ?? ''])
    .flatMap(item => String(item).split(','))
    .map(item => item.trim())
    .filter(Boolean);
}

function bareAddress(value) {
  return value.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+/iu)?.[0]?.toLowerCase();
}

function configCcList(config) {
  return addressList(config.cc);
}

function matchKeyword(text, keywords) {
  const haystack = String(text ?? '').toLocaleLowerCase('ja');
  return (keywords ?? []).find(keyword => haystack.includes(String(keyword).toLocaleLowerCase('ja')));
}

function attachmentNames(attachments) {
  return (Array.isArray(attachments) ? attachments : [attachments ?? []])
    .flat()
    .map(item => (typeof item === 'string' ? item : item?.name ?? ''))
    .map(name => String(name).trim())
    .filter(Boolean);
}

export function loadInvoiceCcConfig(readFile = fs.readFileSync) {
  return JSON.parse(readFile(CONFIG_URL, 'utf8').replace(/^\uFEFF/u, ''));
}

/** Gmail API の payload から添付ファイル名を集める（送信時の欠落検査用）。 */
export function draftAttachmentNames(payload) {
  const names = [];
  const walk = part => {
    if (!part) return;
    if (part.filename) names.push(String(part.filename));
    for (const child of part.parts || []) walk(child);
  };
  walk(payload);
  return names;
}

/**
 * 請求書メール判定は件名か添付ファイル名のみ（本文の言及だけでは対象外）。
 * 既に To/CC に経理アドレスがある場合は追加しない。
 */
export function applyInvoiceCc({ to, cc, subject = '', body: _body = '', attachments = [] } = {}, config = loadInvoiceCcConfig()) {
  const copies = addressList(cc);
  const subjectHit = matchKeyword(subject, config.subjectKeywords ?? config.keywords);
  const attachmentHit = attachmentNames(attachments)
    .map(name => matchKeyword(name, config.attachmentKeywords ?? ['請求書', 'invoice']))
    .find(Boolean);
  if (!subjectHit && !attachmentHit) return { cc: copies, added: false, reason: 'not_invoice' };

  const existing = new Set([...addressList(to), ...copies].map(bareAddress).filter(Boolean));
  const additions = configCcList(config).filter(address => !existing.has(address.toLowerCase()));
  return {
    cc: [...copies, ...additions],
    added: additions.length > 0,
    reason: subjectHit ? `subject:${subjectHit}` : `attachment:${attachmentHit}`,
  };
}
