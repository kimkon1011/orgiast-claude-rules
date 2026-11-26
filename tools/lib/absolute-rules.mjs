// 2026-11-26 kim 厳命の絶対ルールを、ルーチンが使う全 LLM（Gemini / OpenRouter / Groq 等、llm-fallback 経由）の
// system へ先頭付与する。全文は ONBOARDING.md §1「🛑 絶対ルール」/ rules/absolute-rules.md。
export const ABSOLUTE_RULES_SYSTEM = '【絶対ルール】スピードの経済価値を最重視。早ければ後で間違いを訂正でき、手配先も見つかり、安い方法を選べる。遅いと人探しが困難、間違えても止める時間がなく、人間の心的ストレスも高くなり、問題解決が圧倒的に困難になる。受けたら即着手、前倒しで進める。スケジュールや段取りを提案するときは期限日から逆算し、郵送・処理・確認・返信待ちの日数に20%以上のバッファを上乗せした着手期限を示し、その中で間に合う最安の方法（オンライン・郵送）を選ぶ。人が窓口へ行く・余計な手数料が出るような無駄を出さない。AIが確認できていないことを人（金さん・社員）に投げない。人への依頼・確認を書く前に、記録を調べてAIで実行できるかを確かめ、できるならAIが実行して結果だけ伝える。社員からの依頼・相談を社員に戻さない。人に戻してよいのはログイン・本人確認・支払い・社外送信の最終承認・現地作業だけ。案件の開始・再開は担当PCのルールで決める。前の作業が別のPCにあっても担当外では再開せず、成果物を担当PCへ移して続ける。担当PCの障害は復旧してから続け、別PCへ逃がさない。';
export function withAbsoluteRules(messages) {
  if (!Array.isArray(messages) || process.env.ORGIAST_ABSOLUTE_RULES === '0') return messages;
  if (messages.some(m => typeof m?.content === 'string' && m.content.includes('【絶対ルール】'))) return messages;
  const [first, ...rest] = messages;
  if (first?.role === 'system' && typeof first.content === 'string') return [{ ...first, content: `${ABSOLUTE_RULES_SYSTEM}\n\n${first.content}` }, ...rest];
  return [{ role: 'system', content: ABSOLUTE_RULES_SYSTEM }, ...messages];
}
export function injectAbsoluteRules(request) {
  const body = request?.init?.body;
  if (typeof body !== 'string') return request;
  let payload; try { payload = JSON.parse(body); } catch { return request; }
  if (!Array.isArray(payload?.messages)) return request;
  return { ...request, init: { ...request.init, body: JSON.stringify({ ...payload, messages: withAbsoluteRules(payload.messages) }) } };
}
