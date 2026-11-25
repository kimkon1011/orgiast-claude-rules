export const GATE_CONTRACT = {"name": "answer-canonical-gate", "remedies": [{"kind": "repo-file", "ref": "tools/gate-remedies.md", "section": "answer-canonical-gate"}]};

const missingSource = /(?:専用|まとめた|説明(?:する|した)?)?(?:ページ|資料|マニュアル|FAQ|記載)(?:は|が)?(?:現在|今は|まだ)?(?:ありません|ない(?:です|ため|ので)|見つかりません|存在しません)/;
const directAnswer = /(?:直接|個別に?|この文面で|以下の文面で)(?:ご)?(?:回答|返信|返答|お伝え)/;
const draft = /【kim 確認用の全文】|返信案|回答案/;
const undecided = /(?:記載|規定)(?:が|は)?(?:ありません|ない)|決まって(?:いません|いない)/;
const canonical = /^\s*正本化\s*[:：]\s*\S/;
const exception = /\[CANON-OK\][ \t]+(?=\S)([^\r\n]+)/;

export function enabled() {
  return process.env.ORGIAST_ANSWER_CANONICAL_GATE !== '0';
}

// 引用・コード内の兆候も免除マーカーも判定に使わない。
function proseLines(text) {
  let fence;
  return String(text || '').split(/\r?\n/).map(line => {
    if (/^\s*>/.test(line)) return '';
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      return '';
    }
    if (marker) { fence = marker[1]; return ''; }
    if (/^(?: {4}|\t)/.test(line)) return '';
    return line;
  });
}

export function judgeAnswerCanonical(text) {
  const code = 'ANSWER-CANONICAL';
  if (!enabled()) return { decision: 'pass', code, reason: 'disabled' };
  const lines = proseLines(text);
  const singleAnswer = (lines.some(line => missingSource.test(line)) && lines.some(line => directAnswer.test(line)))
    || (lines.some(line => draft.test(line)) && lines.some(line => undecided.test(line)));
  if (singleAnswer && !lines.some(line => canonical.test(line) || exception.test(line))) return {
    decision: 'block', code,
    reason: '[ANSWER-CANONICAL] 人の質問への回答をその場限りの文面で終えています。答えを正本（社内マニュアル・FAQ・応募者向け案内ページ・テンプレート・memory・コード）に追記し、次から相手や担当者が自分で引ける形にしてください。追記したら `正本化: <追記先の名前とリンク>` を1行書く。正本に答えが無い（規定が未決）なら、決める項目を user に1回で聞き、決まり次第そこへ書く。個別事情で汎用性が無い回答だけ `[CANON-OK] <理由>`。',
  };
  return { decision: 'pass', code, reason: '単発回答の兆候なし、または正本化・例外理由あり' };
}
