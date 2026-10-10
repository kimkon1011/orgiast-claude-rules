// 送信前 egress ガード: 中国系・無料学習利用系プロバイダへ機密を出さないための純粋関数群。
// - 機密そのもの(秘密鍵/APIキー/JWT/カード/マイナンバー/.env 代入)は「どこへも送らない」(プロバイダ非依存のハードブロック)
// - メール・電話の大量列挙は「restricted プロバイダにだけ送らない」(ソフトブロック)
// 設計方針: 迂回路(--allow-sensitive 等)は作らない。llm-ask は不許可時に exit 3 で送信しない。

// 学習利用・国外移転のリスクがあるプロバイダ。restricted でない先へは「大量の個人情報」以外は通す。
export const RESTRICTED_PROVIDERS = Object.freeze(['kimi', 'deepseek', 'glm']);

// 無料枠は入力を学習に使い得るため、明示フラグがある時は restricted に加える。
const FREE_TIER_PROVIDERS = Object.freeze(['gemini', 'gemini-cli']);

// 追加の restricted プロバイダ(カンマ区切り)。設定で拡張できる。
const RESTRICTED_ENV = 'ORGIAST_EGRESS_RESTRICTED_PROVIDERS';

// プロバイダ非依存で常にブロックする種別。
const HARD_TYPES = Object.freeze(['private_key', 'pem_block', 'api_key', 'jwt', 'credential_assignment', 'credit_card', 'mynumber']);
// restricted プロバイダの時だけブロックする種別。
const SOFT_TYPES = Object.freeze(['email_bulk', 'phone_bulk']);

const SAMPLE_KEEP = 4;

function mask(value) {
  const text = String(value ?? '');
  return `${text.slice(0, SAMPLE_KEEP)}***`;
}

function firstMatch(pattern, text) {
  const match = String(text ?? '').match(pattern);
  return match ? match[0] : '';
}

// Luhn チェック(クレジットカード番号の検査式)。
export function luhnValid(digits) {
  const value = String(digits ?? '').replace(/[^0-9]/g, '');
  if (!value) return false;
  let sum = 0;
  let double = false;
  for (let i = value.length - 1; i >= 0; i--) {
    let digit = value.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

// 札幌の「個人番号」語の近傍だけで 12 桁を拾う。無関係な 12 桁(連番・ID)を避けるため。
function myNumberSample(text) {
  const source = String(text ?? '');
  const keyword = /(個人番号|マイナンバー|個人番号カード)/;
  const digits = /(?<!\d)\d{12}(?!\d)/g;
  let match;
  while ((match = digits.exec(source)) !== null) {
    const windowStart = Math.max(0, match.index - 40);
    const windowEnd = Math.min(source.length, match.index + match[0].length + 40);
    if (keyword.test(source.slice(windowStart, windowEnd))) return match[0];
  }
  return '';
}

// .env / JSON の「値が入った」代入だけを拾う。プレースホルダや変数参照は除く。
function credentialAssignmentSample(text) {
  const source = String(text ?? '');
  const assignment = /(?:^|[\s"'(,;])([A-Za-z][A-Za-z0-9_]*)\s*[=:]\s*(["']?)([^\s"'`,;]{6,})/g;
  const sensitiveName = /(_KEY|_SECRET|_TOKEN|_PASSWORD|_PASSWD|_CREDENTIALS?)$/i;
  const standalone = /^(PASSWORD|PASSWD|SECRET|TOKEN|APIKEY|API_KEY|CREDENTIALS?)$/i;
  const placeholder = /^(?:\*+|<.*|\$\{?[A-Za-z_]|%[A-Za-z_]+%|your|xxx+|todo|changeme|change_me|placeholder|example|dummy|redacted|undefined|null|none|true|false|test)/i;
  let match;
  while ((match = assignment.exec(source)) !== null) {
    const [, name, , value] = match;
    if (!sensitiveName.test(name) && !standalone.test(name)) continue;
    if (placeholder.test(value)) continue;
    return `${name}=${mask(value)}`;
  }
  return '';
}

function creditCardSample(text) {
  const source = String(text ?? '');
  const candidate = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;
  let match;
  while ((match = candidate.exec(source)) !== null) {
    const digits = match[0].replace(/[^0-9]/g, '');
    if (digits.length < 13 || digits.length > 19) continue;
    if (!luhnValid(digits)) continue;
    return match[0];
  }
  return '';
}

// `sk-` 系キーの検出。`risk-management-framework` のように「普通の英単語が sk- をまたぐ」
// 誤検知を避けるため、ハイフン区切りの小文字語の羅列は鍵と見なさない。
function looksLikeSkKey(match) {
  const token = String(match).slice(3);
  if (token.length < 20) return false;
  const body = token.replace(/^(?:(?:ant|proj|svcacct|admin|live|test)-)*(?:api\d*-)?/i, '');
  if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(body)) return false; // 例: management-framework-2026
  if (!/[A-Za-z0-9]/.test(body)) return false;
  return true;
}

function skKeyMatch(text) {
  const candidates = String(text ?? '').match(/sk-[A-Za-z0-9_-]{20,}/g);
  if (!candidates) return '';
  return candidates.find(looksLikeSkKey) || '';
}

function countMatches(pattern, text) {
  const matches = String(text ?? '').match(pattern);
  return matches ? matches.length : 0;
}

// 機密らしき文字列を検出する。返り値は種別ごとに1件へ畳んだ [{type, sample}]。
// sample は「先頭4字 + ***」のみで、原文の秘匿部分は含めない。
export function scanSensitive(text) {
  const source = String(text ?? '');
  const findings = [];
  const add = (type, raw) => {
    if (!raw) return;
    if (findings.some((finding) => finding.type === type)) return;
    findings.push({ type, sample: type === 'credential_assignment' ? raw : mask(raw) });
  };

  add('private_key', firstMatch(/-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/, source));
  // 秘密鍵以外の PEM ブロック(証明書等)。秘密鍵は private_key 側で拾うので二重計上しない。
  const pem = firstMatch(/-----BEGIN(?: [A-Z0-9]+)*-----/, source);
  if (!/PRIVATE KEY/.test(pem)) add('pem_block', pem);
  add('api_key', skKeyMatch(source));
  add('api_key', firstMatch(/AIza[0-9A-Za-z_-]{35}/, source));
  add('api_key', firstMatch(/github_pat_[A-Za-z0-9_]{20,}/, source));
  add('api_key', firstMatch(/gh[pousr]_[A-Za-z0-9]{20,}/, source));
  add('api_key', firstMatch(/xox[baprs]-[A-Za-z0-9-]{10,}/, source));
  add('api_key', firstMatch(/AKIA[0-9A-Z]{16}/, source));
  add('jwt', firstMatch(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/, source));
  add('credential_assignment', credentialAssignmentSample(source));
  add('credit_card', creditCardSample(source));
  add('mynumber', myNumberSample(source));

  const emails = countMatches(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, source);
  if (emails >= 3) add('email_bulk', firstMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, source));

  const phones = countMatches(/(?<!\d)0\d{1,4}-\d{1,4}-\d{3,4}(?!\d)/g, source)
    + countMatches(/(?<!\d)0[789]0-?\d{4}-?\d{4}(?!\d)/g, source);
  if (phones >= 3) add('phone_bulk', firstMatch(/(?<!\d)0\d{1,4}-\d{1,4}-\d{3,4}(?!\d)/, source) || firstMatch(/(?<!\d)0[789]0-?\d{4}-?\d{4}(?!\d)/, source));

  return findings;
}

// 設定で拡張した restricted プロバイダ(環境変数 + 無料枠フラグ)。
export function restrictedProviders(env = process.env) {
  const names = new Set(RESTRICTED_PROVIDERS);
  const extra = String(env?.[RESTRICTED_ENV] || '').split(',').map((name) => name.trim().toLowerCase()).filter(Boolean);
  for (const name of extra) names.add(name);
  if (String(env?.GEMINI_FREE_TIER || '') === '1' || String(env?.GEMINI_FREE_TIER || '').toLowerCase() === 'true') {
    for (const name of FREE_TIER_PROVIDERS) names.add(name);
  }
  return [...names];
}

export function isRestrictedProvider(provider, env = process.env) {
  return restrictedProviders(env).includes(String(provider || '').toLowerCase());
}

export function describeFindings(findings = []) {
  return findings.map((finding) => finding.type).join(', ');
}

// 送信可否の判定。
// - 機密そのもの(HARD)は restricted でなくても不許可
// - メール/電話の大量(SOFT)は restricted の時だけ不許可
export function checkEgress({ provider, text = '', findings, env = process.env } = {}) {
  const detected = Array.isArray(findings) ? findings : scanSensitive(text);
  const name = String(provider || '').toLowerCase();
  const restricted = isRestrictedProvider(name, env);
  const hard = detected.filter((finding) => HARD_TYPES.includes(finding.type));
  const soft = detected.filter((finding) => SOFT_TYPES.includes(finding.type));
  const blocking = restricted ? [...hard, ...soft] : hard;
  if (blocking.length) {
    const reason = restricted
      ? `${name} は入力を学習に使い得る restricted プロバイダです（検出: ${describeFindings(blocking)}）`
      : `機密（${describeFindings(blocking)}）は restricted かどうかに関わらず外部へ送信できません`;
    return { allowed: false, findings: detected, reason };
  }
  return { allowed: true, findings: detected, reason: '' };
}
