import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BLOCK_RE = /\[TEMA-CHECK\]([\s\S]*?)\[\/TEMA-CHECK\]/i;
const REQUEST_RE = /お願い|ください|していただけ|頼み|依頼|ご対応|送ってください|署名して|押印|郵送して|来所|窓口へ|持参|ログインして|サインイン|パスワード|認証/;
const PAPER_RE = /紙に書き直|印刷して|手書き|押印|郵送|窓口|来所|持参|写真を撮って送|原本提出/;
const DIGITAL_RE = /スマホ署名|電子署名|電子提出|オンライン|電子申請|AIが代行|まとめて1回/;
const LEGAL_RE = /法令|規則|原本提出が必要|先方指定|裁判所指定|民事訴訟規則/;
const EXTRA_RE = /取り消し|取消し|訂正|念のため|先ほどの件|再送|お詫び訂正/;
const AI_TASK_RE = /調べて|確認して|検索して|予約して|入力して/;
const SIGNIN_RE = /サインイン|ログイン|パスワード|認証して|認証コードを入力して/;
const PUBLIC_WIFI_RE = /空港|カフェ|ホテルのWi-?Fi|公共Wi-?Fi|フリーWi-?Fi/;
const MANUAL_RE = /(?:ユーザー|本人|金さん).{0,12}(?:手入力|入力してもら|パスワードを入力)/;
const NEG = /(?:しない|不要|禁止|求めない|頼まない|案内しない)/;

function activeSentences(text) {
  return String(text || '').split(/(?<=[。！？])|\r?\n/).filter((s) => s && !NEG.test(s)).join('\n');
}
export function stripPoliteClosings(text) {
  // 作業対象が前にある「ご確認をよろしくお願いします」は依頼として残す。
  return String(text ?? '').replace(/(^|[。！？\n、])([ \t]*(?:(?:引き続き|今後とも|何卒)[、\s]*)?(?:(?:どうぞ[、\s]*)?よろしく[、\s]*(?:お願い(?:いた|致)?します|お願い申し上げます|お願いいたします|お願い致します|お願い)?|お願い申し上げます))/g, '$1');
}

function config() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'tema-check.json'), 'utf8')); }
  catch { return { roles: {}, storeBound: [], storeLeavingTasks: [] }; }
}
export function parseTemaRecord(text) {
  const match = String(text || '').match(BLOCK_RE);
  if (!match) return null;
  const values = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.trim().match(/^([^:：]+)[:：]\s*(.*)$/);
    if (m) values[m[1].trim()] = m[2].trim();
  }
  const candidates = String(values['候補'] || '').split(/\s*[\/／]\s*/).filter(Boolean);
  return { raw: match[0], values, candidates };
}
export function stripTemaRecord(text) { return String(text ?? '').replace(BLOCK_RE, '').replace(/\n{3,}/g, '\n\n'); }
function add(findings, code, message) { findings.push({ code, message }); }
export function checkTema(text, opts = {}) {
  const source = String(text || '');
  const body = activeSentences(stripPoliteClosings(stripTemaRecord(source)));
  const record = parseTemaRecord(source);
  const applies = REQUEST_RE.test(body.replace(/認証(?!して|コードを入力して)/g, ''));
  const findings = [];
  if (!applies) return { ok: true, applies: false, findings };
  if (!record) {
    add(findings, 'TEMA_NO_RECORD', '依頼・提案に [TEMA-CHECK] の検証記録がありません');
    return { ok: opts.mode === 'warn', applies, findings };
  }
  const v = record.values;
  if (record.candidates.length < 2) add(findings, 'TEMA_FEW_CANDIDATES', '候補を2つ以上比較してください');
  const paper = PAPER_RE.test(body) || PAPER_RE.test(v['選択'] || '');
  if (paper && (!DIGITAL_RE.test(v['候補'] || '') || !v['紙理由'] || /^なし$/.test(v['紙理由']))) {
    if (!LEGAL_RE.test(v['紙理由'] || '') && !LEGAL_RE.test(body)) add(findings, 'TEMA_PAPER_NO_REASON', '紙・郵送・来所を選ぶ法令または相手指定の理由と電子候補が必要です');
  }
  if (!v['手順数'] || !v['読む量']) add(findings, 'TEMA_NO_COUNT', '手順数と読む量を記録してください');
  if (EXTRA_RE.test(body) && !/(まとめ|不要にできない理由|送らずに済ませ)/.test(v['追加連絡'] || '')) add(findings, 'TEMA_EXTRA_CONTACT', '追加連絡を送らずに済ませるか次の連絡にまとめる検討がありません');
  if (/3通に分け|読む量[^\n]*3通/.test(source) && !/(まとめて1回|次の連絡にまとめ)/.test(`${v['候補'] || ''} ${v['追加連絡'] || ''}`)) add(findings, 'TEMA_EXTRA_CONTACT', '複数通を1回にまとめる候補がありません');
  if (!v['前提'] || !/(所在|期限|順番)/.test(v['前提'])) add(findings, 'TEMA_NO_PREMISE', '所在・期限・順番などの前提確認がありません');
  const cfg = config();
  const backup = opts.backup || Object.entries(cfg.roles || {}).some(([name, role]) => role === '予備' && body.includes(name));
  if (backup && !/順番[^\n]*(?:アシスタント|先に当たる人)[^\n]*(?:確認済|不在|不可|断ら|対応不能)/.test(v['前提'] || '')) add(findings, 'TEMA_ORDER_SKIP', '予備へ頼む前のアシスタント確認結果がありません');
  const storeBound = (cfg.storeBound || []).some((x) => body.includes(x));
  const leaving = (cfg.storeLeavingTasks || []).some((x) => body.includes(x));
  if (storeBound && leaving) add(findings, 'TEMA_STORE_BOUND', '店を離れられない人へ外出作業を依頼しています');
  if (AI_TASK_RE.test(body) && (!v['AI代行'] || /^可/.test(v['AI代行']))) add(findings, 'TEMA_AI_CAN_DO', 'AIでできる確認・検索・予約・入力を人へ戻しています');
  if (SIGNIN_RE.test(body)) {
    const signin = v['サインイン'] || '';
    if (!/(出どころ=.*(?:既存セッション|1Password|保存ログイン))/.test(signin)) add(findings, 'SIGNIN_NO_SOURCE', 'サインイン資格情報の出どころがありません');
    if (/(古い|拒否された|失効した|旧保存)/.test(source) && !/禁止=/.test(signin)) add(findings, 'SIGNIN_STALE_NOT_FORBIDDEN', '拒否・失効済みの古い資格情報を禁止していません');
    const failure = signin.match(/失敗時=(.*)/)?.[1] || '';
    if (!/^出どころ切替→経路切替→本人の一点/.test(failure) || MANUAL_RE.test(failure.split(/→/)[0] || '')) add(findings, 'SIGNIN_MANUAL_FIRST', '失敗時は出どころ切替→経路切替→本人の一点の順にしてください');
    if (PUBLIC_WIFI_RE.test(body) && (MANUAL_RE.test(body) || /パスワード.{0,8}(?:表示|入力)/.test(body))) add(findings, 'SIGNIN_PUBLIC_WIFI', '公共Wi-Fiでパスワードの手入力・表示入力を求めています');
  }
  return { ok: findings.length === 0 || opts.mode === 'warn', applies, findings };
}
export function formatTemaFindings(findings = []) {
  const lines = findings.map((f) => `・${f.code}: ${f.message}`);
  return `手間チェック: ${lines.join('\n')}\n直し方: [TEMA-CHECK] に候補比較・手順数・読む量・追加連絡・前提・AI代行・必要ならサインイン経路を記録してください。`;
}
