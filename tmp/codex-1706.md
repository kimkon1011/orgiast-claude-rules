# 指示: tools/schema-audit.mjs の main ガード修正
CI失敗: `tools の main ガードは isEntry を使う`。
tools/schema-audit.mjs 末尾の `if (import.meta.url === \`file://${process.argv[1]}\`)` を、他ツール同様 `import { isEntry } from './is-entry.mjs'` と `if (isEntry(import.meta.url))` に置換する。
他ファイルは変更しない。完了後 `node --test tools/*.test.mjs` の該当テスト(main ガード)が通ることを確認。git commit/push はしない。
