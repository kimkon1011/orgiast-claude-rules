# Critical event の二重通知詳細

ONBOARDING.compressed.md §1.1（Critical event 単一webhook依存禁止）の詳細。

## Critical event は単一 Discord webhook に依存しない（2026-06-16）

ユーザーの実害につながる critical event (新規 signup / 相談・問合せ送信 / 障害アラート 等) の Discord 通知は、kim さんが日常的に確認するチャンネル (#claude-code 等) を含む 2 系統以上に並列送信する。単一 webhook 依存は禁止。

### Why

2026-06-16: 学会協賛ナビで 6/9 岡山大学 (hiro-okamura@okayama-u.ac.jp) signup → `DISCORD_WEBHOOK_URL` (古川さん相談通知用、kim 不可視チャンネル) のみに通知 → 7 日見落とし。サービス信頼に関わる重大事案。日次提案ルーチンでも 6/15 に同じ配信先ミスが発覚しており、critical event 全般を二重通知化する必要が判明。

### 実装パターン

```typescript
const payload = {
  username: 'XXX 受付BOT',
  content: `<@${kimUserId}> @here 🆕 **新規 XX が届きました**`,
  allowed_mentions: { parse: ['everyone'], users: [kimUserId] },
  embeds: [{ ... }]
};

const webhooks = [
  process.env.DISCORD_ROUTINE_WEBHOOK_URL,  // kim 確実視認 (#claude-code 等)
  process.env.DISCORD_WEBHOOK_URL            // 担当者通知用
].filter(Boolean);

await Promise.all(webhooks.map(async (webhook) => {
  try {
    await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  } catch (e) { console.error('Discord notify failed for one webhook', e); }
}));
```

### 二重チェック層 (見落とし時の安全網)

webhook 通知を見落とした場合に備え、日次ルーチンに pending 件数 + 最古経過時間を表示する:

- 24h 超 → 🚨
- 72h 超 → 🔥
- 168h 超 → 「信頼危機」レベル
- 提案本文の最初に強調表示

これで Discord 通知見落とし時も最大 24h で気付ける運用に。

### Env var 命名規約

| Env var | 用途 |
|---|---|
| `DISCORD_ROUTINE_WEBHOOK_URL` | kim 確実視認チャンネル (#claude-code 等)。日次ルーチン + critical event |
| `DISCORD_WEBHOOK_URL` | 担当者通知用 (古川さん DM 等)。critical event の併送先 |
| `DISCORD_MENTION_USER_ID` | kim の Discord user ID (`<@id>` mention 用) |

### やってはいけない

- 単一 webhook 依存
- メンション省略 (`<@kim> @here` なし)
- `try/catch` を 1 webhook で包んで他系統まで止める
- critical event を「軽い通知」扱いする (ベストエフォートでなく必達)
