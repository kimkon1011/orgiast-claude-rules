const REASON = [
  '[PR-HANDOFF] `gh` 未認証は PR 作成を手渡す理由にならない。',
  'credential helper に PAT が入っているので、`git push` が通る機体なら必ず作れる。',
  'Git Bash 等で次のコマンドを使い、作成・ラベル付けを人に手渡さず実行すること:',
  "GH_TOKEN=$(printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill | sed -n 's/^password=//p') gh pr create --base main --head <branch> --title \"<題>\" --body-file <本文ファイル>",
].join('\n');

function proseOnly(text) {
  return text
    .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm, ' ')
    .replace(/(`+)[^\n]*?\1/g, ' ');
}

// I/O を行わず、本文だけから判定する。
export function evaluatePrHandoff(assistantText) {
  const pass = { decision: 'pass', reason: '' };
  try {
    if (typeof assistantText !== 'string' || !assistantText.trim()) return pass;
    const text = proseOnly(assistantText);
    if (/https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/new\/[^\s]*/i.test(text)) {
      return { decision: 'block', reason: REASON };
    }
    const pr = /(?:\bPR\b|\bpull\s+request\b|プルリク)/;
    const request = /(?:ください|下さい|お願いします|お願いいたします|お願い致します|が必要です|が必要があります|をお願い|を頼みます)/;
    // マージ・レビューの依頼だけを除外し、同じ文に残る作成依頼は評価する。
    const humanOperation = /(?:マージ|レビュー|merge|review)(?:を)?(?:して(?:いただく|頂く|もらう)こと|すること|する|して|の実施)?(?:ください|下さい|を?お願いします|を?お願いいたします|を?お願い致します|が必要です|が必要があります)/gi;
    for (const sentence of text.split(/[。！？!?\r\n]+/)) {
      if (!pr.test(sentence)) continue;
      const remaining = sentence.replace(humanOperation, ' ');
      // 「作成して、マージしてください」の共有された依頼語を取りこぼさない。
      const sharedRequest = request.test(sentence)
        && /(?:作って|作成して|ラベルを付けて|ラベル付けして)/.test(remaining);
      if (request.test(remaining) || sharedRequest) return { decision: 'block', reason: REASON };
    }
    return pass;
  } catch {
    return pass;
  }
}
