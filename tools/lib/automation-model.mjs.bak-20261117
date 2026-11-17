// 自動で動く Claude（スケジュール実行・巡回・ヘッドレス claude -p・自動セッション）のモデル。
// 2026-11-15 kim 指示: 自動実行は Sonnet、対話セッションはそのまま。Opus/Fable 指定も自動実行では Sonnet に倒す。
// ORGIAST_AUTOMATION_MODEL で haiku 等へ下げることはできるが、opus/fable へは上げられない。
const SUPERVISOR = /opus|fable/i;
export function automationModel(requested, env = process.env) {
  const configured = String(env.ORGIAST_AUTOMATION_MODEL || '').trim();
  const fallback = configured && !SUPERVISOR.test(configured) ? configured : 'sonnet';
  const value = String(requested || '').trim();
  return !value || SUPERVISOR.test(value) ? fallback : value;
}
