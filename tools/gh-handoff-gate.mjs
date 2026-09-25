import { latestAssistantText } from './lib/assistant-text.mjs';
import { isEntry } from './is-entry.mjs';

export function formatReason() {
  return `[GH-HANDOFF] gh が未認証であることを理由に GitHub 操作を人に頼んでいますが、git credential fill を試した結果が書かれていません。gh 未認証は手渡しの理由になりません（ONBOARDING §1.1）。\n\n  printf "protocol=https\\nhost=github.com\\n\\n" | git credential fill\n\nの password を GH_TOKEN に入れて gh / gh api で自分で作ってください。試して失敗した場合は、実行したコマンドと結果（exit code・エラー文）を本文に書けば通過します。どうしても不要なときだけ [GH-HANDOFF-OK] と書いてください。`;
}

export function judge(text) {
  // コードフェンスを除去
  const textWithoutCodeFences = text.replace(/```[\s\S]*?```/g, '');

  // 1. 逃がし弁: 本文に [GH-HANDOFF-OK] があれば無条件で通過
  if (textWithoutCodeFences.includes('[GH-HANDOFF-OK]')) {
    return { triggered: false, missing: [] };
  }

  // 2. トリガー判定 (a) GitHub 操作の依頼 & (b) 理由が gh 認証 の両方
  // 「作成しました」などを拾わないために、(a) の「作成」を「作成して」に制限
  const requestRegex = /(PR|プルリク|pull request|マージ|merge|push|リリース|GitHub)[^\n]{0,40}?(作成して|作って|開いて|押して|マージして|実行して|お願いします|してください|して下さい|をお願い)/i;
  const reasonRegex = /(gh\s*(auth|CLI|コマンド)?[^\n]{0,20}(未認証|認証されていない|ログインしていない|not logged in|unauthenticated|認証切れ))|gh auth login/i;

  const hasRequest = requestRegex.test(textWithoutCodeFences);
  const hasReason = reasonRegex.test(textWithoutCodeFences);

  if (!hasRequest || !hasReason) {
    return { triggered: false, missing: [] };
  }

  // 3. トリガー時、本文に credential fill の文字列が1回でもあれば合格
  const hasCredentialFill = /credential fill/i.test(textWithoutCodeFences);
  if (hasCredentialFill) {
    return { triggered: true, missing: [] };
  }

  return { triggered: true, missing: ['credential fill の試行結果'] };
}

function main() {
  try {
    // 標準入力からJSONを読み取り
    let input = '';
    process.stdin.on('data', chunk => {
      input += chunk;
    });

    process.stdin.on('end', () => {
      try {
        const data = JSON.parse(input);

        // ループ防止
        if (data.stop_hook_active) {
          process.exit(0);
        }

        const assistantText = latestAssistantText(data.transcript_path);

        // 空チェック
        if (!assistantText) {
          process.exit(0);
        }

        // 判定実行
        const result = judge(assistantText);

        if (!result.triggered || result.missing.length === 0) {
          process.exit(0);
        }

        // block出力
        console.log(JSON.stringify({
          decision: 'block',
          reason: formatReason()
        }));

      } catch {
        // 想定外エラーはfail-open
        process.exit(0);
      }
    });

  } catch {
    process.exit(0);
  }
}

if (isEntry(import.meta.url)) {
  main();
}
