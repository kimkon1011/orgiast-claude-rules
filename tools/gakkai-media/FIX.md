# research.ts バグ修正

`tools/gakkai-media/research.ts` の以下のバグを修正せよ。探索不要。

## バグ1: 存在しない関数呼び出し

47行目: `encodeURIComponent(apiKey)` → `encodeURIComponent(apiKey)` に修正。
（JavaScript に `encodeURIComponent` は存在しない。正しくは `encodeURIComponent`。）

- 修正後、`npx tsx -e "console.log(typeof encodeURIComponent)"` が `function` を返すこと。
- `npx tsx tools/gakkai-media/research.ts --help` が正常に Usage を出力すること。

## バグ2（もしあれば同様に修正）

`Buffer.isBuffer` → `Buffer.isBuffer`（存在するAPI名に統一。ただし Node.js 18+ で非推奨なら typeof ガードも検討）

**完了条件**: `npx tsx tools/gakkai-media/research.ts --help` が Usage を出力し exit(0) すること。