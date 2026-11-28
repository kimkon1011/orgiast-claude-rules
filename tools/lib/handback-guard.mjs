import { checkTema, formatTemaFindings, stripTemaRecord, parseTemaRecord } from './tema-check.mjs';
import { saveTemaRecord, findTemaRecord, temaRecordText } from './tema-record-store.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// 2026-11-26 kim 絶対方針: AIが確認・実行できることを人（金さん・社員）へ戻す文面を、送信の手前で止める。
// 人にしかできない依頼（ログイン・本人確認・支払い・社外送信の最終承認・現地作業）だけ、本文に
// [HUMAN-ONLY: 理由] を付ければ通す（タグは送信前に外す）。ORGIAST_HANDBACK_GUARD=0 で無効化（緊急時のみ）。
export const HUMAN_ONLY_TAG = /\[HUMAN-ONLY:\s*([^\]]+)\]\s*/g;
export const HANDBACK_PATTERNS = Object.freeze([
  /(ご)?確認(を|の程)?(よろしく)?お願い/,
  /確認(を)?よろしく/,
  /(ご)?確認(して|を)?いただけ(ます|ません)/,
  /(ご)?(対応|判断|連絡|手配|調整|打診|返信)(を|の程)?(よろしく)?お願い(します|いたします|できます|致します)/,
  /(ご)?(対応|判断|連絡|手配|調整|打診|返信)(して|を)?いただけ(ます|ません)/,
  /(して|てもらえ|て)いただけ(ます|ません)(か|でしょうか)/,
  /お願いでき(ます|ません)(か|でしょうか)/,
  /(連絡|確認|対応)してください/,
  /(聞いて|確かめて|調べて)(もらう|ください|いただ)/,
  /(判断|対応)(は|を).{0,6}(お任せ|任せます)/,
]);
export function findHandback(text) {
  const body = String(text ?? '').replace(HUMAN_ONLY_TAG, '');
  const hits = [];
  for (const line of body.split(/\r?\n/)) for (const re of HANDBACK_PATTERNS) { const m = line.match(re); if (m) { hits.push({ phrase: m[0], line: line.trim() }); break; } }
  return hits;
}
export function stripHumanOnly(text) { return stripTemaRecord(String(text ?? '').replace(HUMAN_ONLY_TAG, '')); }
export function hasHumanOnly(text) { return /\[HUMAN-ONLY:\s*[^\]]+\]/.test(String(text ?? '')); }
export function assertNoHandback(text, { env = process.env, temaMode = 'block', kind = 'send', backup = false, home, channel = kind, temaRecord, source = kind, dryRun = false } = {}) {
  if (env.ORGIAST_HANDBACK_GUARD === '0') return { ok: true, hits: [] };
  const body = stripHumanOnly(text);
  const inline = parseTemaRecord(text);
  const record = inline ?? temaRecord ?? findTemaRecord(body, { home });
  const inspection = record ? `${body}\n${temaRecordText(record)}` : body;
  const tema = checkTema(inspection, { mode: temaMode, kind, backup });
  if (!dryRun && temaMode === 'warn' && tema.findings.length) {
    const file = path.join(home ?? process.env.ORGIAST_HOME ?? os.homedir(), '.claude', 'tema-check', 'warn.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), channel, source, text: body, findings: tema.findings }) + '\n', 'utf8');
  }
  if (!tema.ok) { const error = new Error(formatTemaFindings(tema.findings)); error.code = 'TEMA_BLOCKED'; error.findings = tema.findings; throw error; }
  const humanOnly = hasHumanOnly(text) || Boolean(record?.humanOnly);
  const hits = humanOnly ? [] : findHandback(body);
  if (!hits.length) {
    if (!dryRun && record && !tema.findings.length) saveTemaRecord(body, { ...parseTemaRecord(inspection), ...(humanOnly ? { humanOnly: true } : {}) }, { home, channel });
    return { ok: true, hits, tema };
  }
  const error = new Error('相手に作業を戻す表現があるため送信を止めました（kim 2026-11-26 絶対方針）。\n'
    + hits.map(h => `  ・「${h.phrase}」: ${h.line}`).join('\n')
    + '\n送る前に自己点検: ①記録（メール・Drive・tl;dv・台帳・セッション記録・受信箱）でAIが調べられないか ②打診・連絡・予約をAIが実行できないか（社外送信は本文を確定して承認へ回す）。'
    + '\nAIで済むなら実行して結果だけ伝える文面に直す。ログイン・本人確認・支払い・社外送信の最終承認・現地作業など人にしかできない依頼だけ、本文に [HUMAN-ONLY: 理由] を付けて再送する。');
  error.code = 'HANDBACK_BLOCKED'; error.hits = hits;
  throw error;
}
