# Genspark Tool API（`gsk`）の使いどころ

Genspark Pro（`seisaku-team@orgiast.jp`）の **前払いクレジット枠**で動くツール群。
従量課金（OpenAI 等）より先にこちらを使う（[[feedback-cost-effectiveness-first]] / §1.17.1）。

| 用途 | 経路 | 実体 |
|---|---|---|
| 画像生成 | `node tools/image-gen.mjs "<英語プロンプト>"` | `gsk img` |
| Web 検索 | `node tools/web-search.mjs "<調べたいこと>" --provider gsk` | `gsk search` |
| ページ本文抽出 | `node tools/web-search.mjs --crawl <url>` | `gsk crawl` |
| Claude Code 用スキル生成 | `gsk init-skills --agent claude` | 60 個の `SKILL.md` を `.gsk/skills/` へ |

キーは `~/.claude/genspark.env` の `GSK_API_KEY`（Tool API 用 `gsk_...`）。
LLM proxy 用の `GSK_PROXY_KEY`（`gsk-eyJ...`）とは**別物**なので混同しない。
残高と消費は `gsk me` の `credit_balance` で確認する。

## 画像生成: OpenAI 従量から前払い枠へ

`tools/image-gen.mjs` が既定経路。`tools/web-search.mjs` と同じ作法で、
**プロンプトは argv に乗せず `--args-file` の JSON で渡す**（日本語や記号の argv 破壊を避ける）。

```bash
node tools/image-gen.mjs "A minimalist flat illustration of a paper plane icon, no text" \
  --out ./out.png --json
node tools/image-gen.mjs "商品写真を白背景に" --ref https://example.com/src.png --aspect 16:9
node tools/image-gen.mjs "..." --model nano-banana-pro --size 2K   # 高精細が要るときだけ
```

- 既定モデル `nano-banana-2-flash-lite`（`gsk img` の既定）。
- 参照画像を渡すときは **毎回・リトライ時も `--ref` を付ける**。付け忘れるとテキストから作り直され、
  元画像が黙って捨てられる。
- 戻り値: `{ provider, model, taskId, imageUrl, imageUrlNoWatermark, localPath, width, height }`。
- コードからは `import { generateImage } from './tools/image-gen.mjs'`。

**実測（2026-09-13）**: 1024×1024 を 1 枚 = **44〜45 クレジット**。
`gsk me` の残高が 124,946.7 → 124,901.7 → 124,857.7 と減り、
**OpenAI の従量課金ではなく Genspark 前払い枠から引かれることを確認済み**（画像はローカル PNG として保存される）。

## Web 検索・本文抽出

`tools/web-search.mjs` の `gsk` レーンとして実装済み（`--provider auto` の第4候補）。
`auto` は無料枠の gemini / groq を先に試し、落ちたときだけ gsk に来る。

```bash
node tools/web-search.mjs "調べたいこと" --provider gsk --json
node tools/web-search.mjs --crawl https://example.com --json
```

**実測（2026-09-13）**: `--provider gsk` で `provider: "gsk"` の結果が返ることを確認済み。

## Claude Code 用スキルの生成

`gsk init-skills --agent claude` は GSK の 60 スキル（image-generation / aidrive / google-sheets 等）を
`.gsk/skills/` にコピーする。**生成物は自動生成のベンダー成果物なのでコミットしない**。
必要になったときに各自の環境で実行する:

```bash
gsk init-skills --agent claude -o .gsk/skills   # .gsk/ は .gitignore 済み
```

## 注意

- `gsk` は stdio をブロックしうるので、**背景実行時は必ずタイムアウトを付ける**
  （`tools/image-gen.mjs` は既定 300 秒で `AbortError`）。
- 秘匿値（`GSK_API_KEY`）をログやコミットに含めない。
- `claude-fable-5` 系は別課金枠のため組織ルールで全用途禁止（LLM proxy 側の話。Tool API には無関係）。
