// プロンプト本文から作業の種類を決める純関数。Codex が要るのは implement / verify だけ。
// investigate / classify / summarize は llm-ask(gemini → deepseek → groq)へ回して Codex 枠を温存する。
// 迷ったら implement(安全側)。
export const TASK_KINDS = ['implement', 'verify', 'investigate', 'classify', 'summarize'];
export const CODEX_KINDS = new Set(['implement', 'verify']);

// 「レポートを作成」「要約を書いて」は成果物が文章なので implement 扱いにしない。
const DOC_OUTPUT = /(?:レポート|報告(?:書)?|要約|まとめ|サマリ(?:ー)?|一覧|比較表|report|summary|summaries|list)\s*(?:を|の)?\s*(?:作成|作って|書いて|出して|write|create|make|produce|draft)/gi;

const IMPLEMENT = /実装|修正|直して|直す|追加して|追加する|作成して|作成する|作って|書き換|リファクタ|マージ|コミット|\bcommit\b|\bpush\b|プッシュ|\bPR\b|プルリク|テストを書|テスト追加|\bimplement|\bfix\b|\bfixes\b|\badd (?:a |an |the )?(?:feature|function|test|option|flag)|\bcreate (?:a |an |the )?(?:file|script|module|pr|function)|\brefactor|\bpatch\b|\bwrite (?:a |the )?(?:code|test|script)/i;
const VERIFY = /テストを?実行|テスト実行|テストを回|テスト(?:が)?通る|検証|再現|動作確認|実機確認|\brun (?:the )?(?:tests?|suite|build)|\bnode --test\b|\bnpm (?:run )?test\b|\bverify\b|\breproduce\b|\breproduction\b|\bsmoke test/i;
const READ_ONLY = /読み取り|読取り|読むだけ|read-?only|コマンド(?:実行)?(?:は)?(?:なし|不要|しない)|実行しない|without running|do not run/i;
const CLASSIFY = /分類|判定|仕分け|ラベル|振り分け|\bclassif|\bcategori[sz]e|\blabel\b|\btriage\b|\bsort into\b/i;
const SUMMARIZE = /要約|まとめ(?:て|る)|整理|サマリ|\bsummari[sz]|\bsummary\b|\btl;?dr\b|\bcondense|\bdigest\b/i;
const INVESTIGATE = /調査|調べ|原因(?:特定|究明|を探)|比較|確認(?:して|する|だけ)|要検証|レポート|洗い出|棚卸|\binvestigat|\bresearch\b|\banaly[sz]e\b|\broot cause\b|\bcompare\b|\bfind out\b|\breport\b|\baudit\b|\binspect\b|\blook into\b/i;

const INVESTIGATE_STRONG = /調査|調べ|原因(?:特定|究明|を探)|investigat|root cause/i;

export function classifyTaskKind(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) return 'implement';
  const body = raw.replace(DOC_OUTPUT, ' ');
  const implement = IMPLEMENT.test(body);
  const verify = VERIFY.test(body);
  const readOnly = READ_ONLY.test(body);
  // 実装の意図が少しでもあれば Codex(安全側)。「調査して実装」「原因を調べて修正」もここ。
  if (implement) return 'implement';
  // 検証だが「読み取り」「コマンド実行なし」と明示されていれば、コマンドを伴わない調査。
  if (verify && !readOnly) return 'verify';
  if (CLASSIFY.test(body)) return 'classify';
  if (INVESTIGATE_STRONG.test(body)) return 'investigate';
  if (SUMMARIZE.test(body)) return 'summarize';
  if (INVESTIGATE.test(body) || (verify && readOnly)) return 'investigate';
  return 'implement';
}
