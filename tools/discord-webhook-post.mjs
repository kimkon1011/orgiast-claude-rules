// 本文を Discord webhook content の2000文字上限に沿って分割する。
// 行単位（改行区切り）で分割し、1行が長すぎる場合だけ文字数で強制分割する。
// コードフェンスや装飾を使っている場合、閉じ忘れが起きないよう分割箇所を調整する。
// 2通目以降に短い見出し（例: 「（続き 2/3）」）を付ける。
export function splitDiscordContent(text, maxLen = 2000) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  const lines = text.split('\n');
  let current = '';
  let fenceOpen = false;

  for (const line of lines) {
    if (/^```/.test(line.trim())) fenceOpen = !fenceOpen;
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > maxLen) {
      if (current) {
        // 現在のチャンクを確定。開きフェンスがあれば閉じる。
        chunks.push(fenceOpen ? `${current}\n\`\`\`` : current);
        current = line;
      } else {
        // 1行がmaxLenを超えている → 文字数で強制分割
        let remaining = line;
        while (remaining.length > maxLen) {
          chunks.push(remaining.slice(0, maxLen));
          remaining = remaining.slice(maxLen);
        }
        current = remaining;
      }
    } else {
      current = candidate;
    }
  }

  if (current) chunks.push(fenceOpen ? `${current}\n\`\`\`` : current);

  // 2通目以降に継続見出しを追加
  if (chunks.length > 1) {
    for (let i = 1; i < chunks.length; i++) {
      chunks[i] = `（続き ${i + 1}/${chunks.length}）\n${chunks[i]}`;
    }
  }

  return chunks;
}

export async function postToDiscordWebhook(webhook, content, { fetchImpl = globalThis.fetch, label = 'fleet-liveness', maxLen = 2000 } = {}) {
  const chunks = splitDiscordContent(content, maxLen);
  const errors = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    try {
      const response = await fetchImpl(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': `orgiast-${label}/1.0` },
        body: JSON.stringify({ content: chunk }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        let bodyText = '';
        try { bodyText = await response.text(); } catch {}
        const msg = `Discord送信(${i + 1}/${chunks.length})が HTTP ${response.status}${bodyText ? ` — ${bodyText}` : ''}`;
        console.error(`fleet-liveness: ${msg}`);
        errors.push(msg);
      }
    } catch (error) {
      const msg = `Discord送信(${i + 1}/${chunks.length})が ${error?.name || 'error'}${error?.message ? `: ${error.message}` : ''}`;
      console.error(`fleet-liveness: ${msg}`);
      errors.push(msg);
    }
  }

  if (errors.length) {
    console.error(`fleet-liveness: Discord送信に${errors.length}件失敗しました`);
  }
  return errors.length === 0;
}
