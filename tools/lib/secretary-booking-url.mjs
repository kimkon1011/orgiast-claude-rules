/**
 * 社外文面に秘書の空き日程URLを入れない（kim 2026-11-17）。
 * claude-pc.tailc5d751.ts.net/secretary 配下（/secretary/book を含む）を検出する。
 * 社内で空きを調べる用途は対象外。送る本文だけを渡す。
 */
const SECRETARY_BOOKING_URL = /(?:https?:\/\/|https?%3a%2f%2f)?claude-pc\.tailc5d751\.ts\.net(?:\/|%2f)secretary(?![a-z0-9])(?:(?:\/|%2f)[^\s<>"'）)」』】]*)?/giu;

export const SECRETARY_BOOKING_URL_REASON = '社外の文面に秘書の空き日程URL（claude-pc.tailc5d751.ts.net/secretary 配下）があります。URLは削除し、秘書の空き日程ツールで取った具体的な候補日時だけを本文に並べてください。候補が合わないときは、お客様に別日を聞くか、追加の候補を出してください。';

export function findSecretaryBookingUrls(text) {
  if (!text) return [];
  return [...String(text).matchAll(SECRETARY_BOOKING_URL)].map(match => match[0]);
}
