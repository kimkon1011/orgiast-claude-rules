# Ahrefs監査 × GSC 優先度判定レポート

生成日時: 2026-11-11T16:22:44.847Z
対象エラー数: 22

## 優先度サマリ

| 優先度 | 件数 | 割合 |
|--------|------|------|
| P0-CRITICAL | 1 | 5% |
| P1-HIGH | 6 | 27% |
| P2-MEDIUM | 12 | 55% |
| P3-LOW | 3 | 14% |
| P4-NEGLIGIBLE | 0 | 0% |

## エラー種別内訳（降順）

| エラー種別 | 件数 | 重大性 |
|------------|------|--------|
| 404 Not Found(404) | 5 | 🔴致命的(8) |
| タイトル欠落(missing_title) | 3 | 🔴致命的(9) |
| タイトル重複(duplicate_title) | 2 | 🟠重大(7) |
| メタ記述欠落(missing_meta_description) | 2 | 🟡中(4) |
| H1欠落(missing_h1) | 2 | 🟡中(5) |
| 薄いコンテンツ(thin_content) | 1 | 🟠重大(7) |
| 低速ページ(slow_page) | 1 | 🟠重大(6) |
| 正規URL問題(canonical_issue) | 1 | 🟡中(5) |
| ソフト404(soft_404) | 1 | 🔴致命的(8) |
| noindex矛盾(noindex_with_indexed) | 1 | 🔴致命的(8) |
| リダイレクトチェーン(redirect_chain) | 1 | 🟠重大(6) |
| 内部リンク無し(no_internal_links) | 1 | 🟠重大(6) |
| 孤立ページ(orphan_page) | 1 | 🟠重大(6) |

## 修正優先度一覧（上位22件）

| # | 優先度 | URL | エラー種別 | スコア | 流入(C/I) | 影響範囲 | 理由 |
|---|--------|-----|------------|--------|----------|----------|------|
| 1 | 🔴P0-CRITICAL | https://www.orgiast.jp/blog/ | タイトル重複 | 78.2 | 120/8500 | 52 | 重大なエラー／流入影響大（120クリック/月）／52ページに影響（広範囲） |
| 2 | 🟠P1-HIGH | https://www.orgiast.jp/service/booth-construction | タイトル欠落 | 63.3 | 195/6100 | 1 | 致命的エラー（クローラー・UX直撃）／流入影響大（195クリック/月） |
| 3 | 🟠P1-HIGH | https://www.orgiast.jp/service/ | 薄いコンテンツ | 59.8 | 280/9800 | 1 | 重大なエラー／流入影響大（280クリック/月） |
| 4 | 🟠P1-HIGH | https://www.orgiast.jp/works/ | タイトル欠落 | 58.7 | 89/4100 | 1 | 致命的エラー（クローラー・UX直撃）／流入影響大（89クリック/月） |
| 5 | 🟠P1-HIGH | https://www.orgiast.jp/case/ | 低速ページ | 56 | 340/12500 | 1 | 重大なエラー／流入影響大（340クリック/月） |
| 6 | 🟠P1-HIGH | https://www.orgiast.jp/news/ | タイトル欠落 | 48.8 | 45/3200 | 1 | 致命的エラー（クローラー・UX直撃）／流入影響あり（45クリック/月） |
| 7 | 🟠P1-HIGH | https://www.orgiast.jp/faq/ | 正規URL問題 | 47.7 | 210/6400 | 1 | 中程度の問題／流入影響大（210クリック/月） |
| 8 | 🟡P2-MEDIUM | https://www.orgiast.jp/case/hitachi-2025 | 404 Not Found | 43.8 | 28/980 | 3 | 致命的エラー（クローラー・UX直撃）／流入影響あり（28クリック/月）／3ページに影響 |
| 9 | 🟡P2-MEDIUM | https://www.orgiast.jp/contact/ | メタ記述欠落 | 41 | 950/4200 | 1 | 中程度の問題／流入影響大（950クリック/月） |
| 10 | 🟡P2-MEDIUM | https://www.orgiast.jp/event/seminar-ai-2025 | 404 Not Found | 37 | 0/0 | 2 | 致命的エラー（クローラー・UX直撃）／GSCデータなし or 流入無し／2ページに影響 |
| 11 | 🟡P2-MEDIUM | https://www.orgiast.jp/downloads/catalog-2025.pdf | 404 Not Found | 37 | 22/480 | 1 | 致命的エラー（クローラー・UX直撃）／流入影響あり（22クリック/月） |
| 12 | 🟡P2-MEDIUM | https://www.orgiast.jp/images/old-logo.png | 404 Not Found | 37 | 0/0 | 5 | 致命的エラー（クローラー・UX直撃）／GSCデータなし or 流入無し／5ページに影響 |
| 13 | 🟡P2-MEDIUM | https://www.orgiast.jp/case/mitsubishi-2025 | ソフト404 | 35.8 | 15/670 | 1 | 致命的エラー（クローラー・UX直撃）／流入影響あり（15クリック/月） |
| 14 | 🟡P2-MEDIUM | https://www.orgiast.jp/service/event-planning | メタ記述欠落 | 35.7 | 78/3400 | 1 | 中程度の問題／流入影響大（78クリック/月） |
| 15 | 🟡P2-MEDIUM | https://www.orgiast.jp/blog/booth-design-tips-2025 | noindex矛盾 | 33.5 | 6/280 | 1 | 致命的エラー（クローラー・UX直撃）／流入影響小（6クリック/月） |
| 16 | 🟡P2-MEDIUM | https://www.orgiast.jp/case-summary/ | タイトル重複 | 33 | 0/0 | 2 | 重大なエラー／GSCデータなし or 流入無し／2ページに影響 |
| 17 | 🟡P2-MEDIUM | https://www.orgiast.jp/case/nissan-2025 | リダイレクトチェーン | 32.2 | 34/1200 | 1 | 重大なエラー／流入影響あり（34クリック/月） |
| 18 | 🟡P2-MEDIUM | https://www.orgiast.jp/case/toshiba-2024 | 404 Not Found | 32 | 0/0 | 1 | 致命的エラー（クローラー・UX直撃）／GSCデータなし or 流入無し |
| 19 | 🟡P2-MEDIUM | https://www.orgiast.jp/case/panasonic-2025 | H1欠落 | 30.9 | 42/2100 | 1 | 中程度の問題／流入影響あり（42クリック/月） |
| 20 | ⚪P3-LOW | https://www.orgiast.jp/privacy/ | 内部リンク無し | 27.6 | 15/520 | 1 | 重大なエラー／流入影響あり（15クリック/月） |
| 21 | ⚪P3-LOW | https://www.orgiast.jp/case/daikin-2024 | 孤立ページ | 26 | 8/340 | 1 | 重大なエラー／流入影響小（8クリック/月） |
| 22 | ⚪P3-LOW | https://www.orgiast.jp/case/fujitsu-2026 | H1欠落 | 20 | 0/0 | 1 | 中程度の問題／GSCデータなし or 流入無し |

## 🔴 P0-CRITICAL 一覧（即日対応推奨）

- [ ] **https://www.orgiast.jp/blog/** — Duplicate title tag (50+ pages share same title)
  - スコア: 78.2 | 流入: 120クリック/8500表示 | 影響: 52ページ
  - 理由: 重大なエラー／流入影響大（120クリック/月）／52ページに影響（広範囲）

## 🟠 P1-HIGH 一覧（週内対応推奨）

- [ ] **https://www.orgiast.jp/service/booth-construction** — Missing title tag
  - スコア: 63.3 | 流入: 195クリック/6100表示 | 影響: 1ページ
  - 理由: 致命的エラー（クローラー・UX直撃）／流入影響大（195クリック/月）

- [ ] **https://www.orgiast.jp/service/** — Thin content (<300 words)
  - スコア: 59.8 | 流入: 280クリック/9800表示 | 影響: 1ページ
  - 理由: 重大なエラー／流入影響大（280クリック/月）

- [ ] **https://www.orgiast.jp/works/** — Missing title tag
  - スコア: 58.7 | 流入: 89クリック/4100表示 | 影響: 1ページ
  - 理由: 致命的エラー（クローラー・UX直撃）／流入影響大（89クリック/月）

- [ ] **https://www.orgiast.jp/case/** — Slow page (3.2s load time)
  - スコア: 56 | 流入: 340クリック/12500表示 | 影響: 1ページ
  - 理由: 重大なエラー／流入影響大（340クリック/月）

- [ ] **https://www.orgiast.jp/news/** — Missing title tag
  - スコア: 48.8 | 流入: 45クリック/3200表示 | 影響: 1ページ
  - 理由: 致命的エラー（クローラー・UX直撃）／流入影響あり（45クリック/月）

- [ ] **https://www.orgiast.jp/faq/** — Canonical URL points to different page
  - スコア: 47.7 | 流入: 210クリック/6400表示 | 影響: 1ページ
  - 理由: 中程度の問題／流入影響大（210クリック/月）

## 推奨アクション

1. **P0-CRITICAL（1件）**: 即日着手。エラーの種類に応じて404リダイレクト/復旧/削除→301。
2. **P1-HIGH（6件）**: 週内に対応。タイトル・メタ・H1の修正は即効性が高い。
3. **P2-MEDIUM（12件）**: 月内に対応。孤立ページは内部リンク設置で改善。
4. **P3-LOW / P4-NEGLIGIBLE（3件）**: 余力があれば対応。新規コンテンツ作成時のついでに。

---
*Generated by X-0024 ahrefs-gsc-priority.mjs v1.0.0*