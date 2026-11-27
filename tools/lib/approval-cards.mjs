import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { addresses, normalizeSubject } from './send-consistency.mjs';

export const CARD_NOTICE = '送信済みなのでカードは押さないで';
const fileFor = home => path.join(home ?? process.env.ORGIAST_HOME ?? os.homedir(), '.claude', 'approval-cards.jsonl');
function append(row, home) {
  const file = fileFor(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + '\n', { encoding: 'utf8', mode: 0o600 });
}
export function listCards({ home } = {}) {
  let rows;
  try { rows = fs.readFileSync(fileFor(home), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const cards = new Map();
  for (const row of rows) {
    if (row.event === 'shown') cards.set(row.cardId, row);
    if (row.event === 'sent' && cards.has(row.cardId)) cards.set(row.cardId, { ...cards.get(row.cardId), status: 'sent', sentAt: row.at, by: row.by });
  }
  return [...cards.values()];
}
export const listActiveCards = options => listCards(options).filter(c => c.status === 'active');
export function matchesCard(card, target) {
  if (typeof target === 'string') return card.draftId === target;
  return Boolean(target?.draftId && card.draftId === target.draftId) || Boolean(target?.subject && normalizeSubject(card.subject) === normalizeSubject(target.subject) && addresses(card.to).some(a => addresses(target.to).includes(a)) && (!target.channel || card.channel === target.channel));
}
export function registerCard({ draftId, to, subject, channel = 'gmail', shownTo = 'user', at = new Date().toISOString() }, { home } = {}) {
  if (!draftId && !(to && subject)) throw Error('承認カードには draftId または宛先と件名が必要です');
  const existing = listActiveCards({ home }).find(c => matchesCard(c, { draftId, to, subject, channel }));
  if (existing) return existing;
  const card = { event: 'shown', cardId: randomUUID(), draftId, to, subject, channel, shownTo, at, status: 'active' };
  append(card, home);
  return card;
}
export function markCardSent(target, { by = 'AI', home, at = new Date().toISOString() } = {}) {
  const cards = listActiveCards({ home }).filter(c => matchesCard(c, target));
  for (const card of cards) append({ event: 'sent', cardId: card.cardId, at, by }, home);
  return cards;
}
export function registerCardFromText(text, { home, shownTo = 'user' } = {}) {
  const draftId = String(text).match(/(?:draftId|draft-id|下書きID|下書き ID)\s*[:：=]\s*([\w-]+)/i)?.[1];
  const to = String(text).match(/(?:宛先|To)\s*[:：]\s*([^\n]+)/i)?.[1];
  const subject = String(text).match(/(?:件名|用件|Subject)\s*[:：]\s*([^\n]+)/i)?.[1];
  return draftId || (to && subject) ? registerCard({ draftId, to, subject, shownTo }, { home }) : null;
}
export function missingCardNotice(text, { home, now = Date.now(), raw = '', cards = listCards({ home }) } = {}) {
  if (!/(?:送信しました|送りました|送信済み)/.test(text) || /カード[^。\n]*押さないで/.test(text)) return false;
  // 他案件のカードで通常の送信報告を止めない。ID、件名、宛先を同じ報告文で照合する。
  const generic = /^(?:メールを)?(?:送信しました|送りました|送信済み)[。！\s]*$/.test(String(text).trim());
  return cards.some(c => (c.status === 'active' || (now - Date.parse(c.sentAt) >= 0 && now - Date.parse(c.sentAt) <= 600000)) &&
    ((generic && (cards.length === 1 || (c.draftId && raw.includes(c.draftId)))) || String(text).split(/\n\s*\n/).some(line => /送信しました|送りました|送信済み/.test(line) &&
      ((c.draftId && line.includes(c.draftId)) || (c.subject && line.includes(c.subject)) || addresses(c.to).some(a => line.toLowerCase().includes(a))))));
}
