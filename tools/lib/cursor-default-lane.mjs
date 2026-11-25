// 2026-11-25 金さん指示: Cursor の使用量がグロボの追加料金に加算されるため既定停止。
// 互換用の明示オプトインがある場合だけ旧経路を許可する。

export const CURSOR_DEFAULT_KINDS = Object.freeze([
  'implement',
  'verify',
  'investigate',
  'summarize',
  'classify',
]);

export const CURSOR_LONG_TIMEOUT_KINDS = Object.freeze([
  'implement',
  'verify',
  'investigate',
  'summarize',
]);

export function isCursorDefaultKind(kind) {
  return CURSOR_DEFAULT_KINDS.includes(String(kind || ''));
}

export function isCursorLongTimeoutKind(kind) {
  return CURSOR_LONG_TIMEOUT_KINDS.includes(String(kind || ''));
}

// 指示が「Claude Code に残す最終作業」だけを指しているか。
export function isClaudeFinalOnly(instruction) {
  const text = String(instruction || '');
  if (/lane:\s*claude\b/i.test(text)) return true;
  if (/\[CLAUDE-FINAL\]/i.test(text)) return true;
  const kimFinal = /金さん向け.{0,20}最終(判断|確認)|最終(判断|確認).{0,12}金さん/;
  const externalFinal = /社外文面.{0,16}最終(確認|判断)|対外文面.{0,16}最終(確認|判断)|最終確認（社外）/;
  return kimFinal.test(text) || externalFinal.test(text);
}

export function shouldPreferCursorAgent({
  kind,
  instruction,
  env = process.env,
  halt = false,
} = {}) {
  if (String(env.CODEX_DO_ENABLE_CURSOR_AGENT || '') !== '1') return false;
  if (String(env.CODEX_DO_SKIP_CURSOR_AGENT || '') === '1') return false;
  if (String(env.CURSOR_USAGE_HALT || '') === '1') return false;
  if (halt) return false;
  if (/lane:\s*codex\b/i.test(String(instruction || ''))) return false;
  if (isClaudeFinalOnly(instruction)) return false;
  return isCursorDefaultKind(kind);
}
