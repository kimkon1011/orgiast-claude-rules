# B案: assertContextApproved に「社内宛＋明示オプトイン」分岐を追加

## DONE_CRITERIA
- `tools/lib/send-context.mjs` の `assertContextApproved` に `internalOptIn` パラメータを追加
- internalOptIn=true でマーカー無し → `{ reason: 'internal-auto', internalOptIn: true }` を返す（throw しない）
- internalOptIn=true でマーカー有り → 既存チェックを実行（マーカーがあれば通常検証）
- internalOptIn=false（default）→ 既存挙動一切変更なし
- `node --test tools/send-context-check.test.mjs` が既存テストをすべてパス
- 新規テストケース追加（マーカー無し+internalOptIn=true、マーカー有り+internalOptIn=true、マーカー有り期限切れ+internalOptIn=true）

## 問題
`assertContextApproved`（tools/lib/send-context.mjs）は必ず事前の send-context-check.mjs 実行によるマーカーファイルを要求する。無人ジョブ（job-refresh 等）が社内メンバー（辻さん、佐藤優奈等）に Discord DM を送る際、マーカーが無いため SEND_CONTEXT_REQUIRED エラーで停止する。

## 変更対象
`tools/lib/send-context.mjs` のみ。これ以外のファイルは一切変更しない。

## 変更内容
`assertContextApproved` 関数に省略可能な `internalOptIn` パラメータ（boolean, default false）を追加する。

internalOptIn=true かつ マーカーが無い場合:
- throw せず `{ reason: 'internal-auto', internalOptIn: true }` を返す（ソフトパス）
- マーカーが存在する場合は既存の全チェックをそのまま実行する（従来挙動を維持）

internalOptIn=false（デフォルト）:
- 既存挙動を一切変更しない

## 実装の詳細

```js
export async function assertContextApproved({ channel, target, text, home, getLatest, now = Date.now(), internalOptIn = false } = {}) {
  const command = `node tools/send-context-check.mjs --channel ${channel} --target ${JSON.stringify(target)} --text-file <送る本文>`;
  const fail = why => { const error = new Error(`送信前の履歴整合性チェックが必要です: ${why}\n実行: ${command}`); error.code = 'SEND_CONTEXT_REQUIRED'; throw error; };
  const marker = readContextMarker(text, home);
  if (!marker) {
    if (internalOptIn) return { reason: 'internal-auto', internalOptIn: true };
    fail('承認マーカーがありません');
  }
  // 以下既存コードそのまま
  ...
}
```

## 制約
- この関数のエクスポートシグネチャのみ変更。他の関数（writeContextMarker, readContextMarker, latestOf 等）は変更しない。
- internalOptIn は「呼び出し側が社内宛と判断した上で明示的に opt-in した場合」のみ true にする想定。関数内部で内部判定は行わない（単なる pass-through フラグ）。
- internalOptIn=true でもマーカーが存在する場合は既存チェックを実行する — これは「社内宛でも通常のチェックを望む場合」に対応するため（マーカーの有無で分岐）。

## 確認方法
- `node --test tools/send-context-check.test.mjs` が既存テストをすべてパスすること
- 新規テスト: `send-context-check.test.mjs` に internalOptIn 関連テストケースを追加