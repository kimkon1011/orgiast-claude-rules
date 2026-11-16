# AIニュース提案 [X-0096]: microsoft/markitdown — LLM前処理のファイル変換統一

観測日: 2026-11-17
出典: microsoft/markitdown README / PyPI / GitHub (microsoft/markitdown)
ライセンス: MIT

## 概要

MarkItDown は Microsoft 製の軽量 Python ユーティリティで、PDF・Word・Excel・PowerPoint・画像・音声・HTML・EPub 等の多様なファイル形式を Markdown に変換する。LLM によるテキスト分析パイプラインの前処理として設計され、textract と同種だが文書構造（見出し・リスト・表・リンク）を Markdown として保持する点が特徴。

## インストール

```bash
pip install 'markitdown[all]'
```

部分インストールも可能: `pip install 'markitdown[pdf, docx, pptx]'`

## CLI 使用法

```bash
markitdown path-to-file.pdf > document.md
markitdown path-to-file.pdf -o document.md
cat path-to-file.pdf | markitdown
```

## Python API 使用法

```python
from markitdown import MarkItDown

md = MarkItDown()
result = md.convert("document.pdf")
print(result.markdown)
```

## 対応形式

| 形式 | 必要依存 | 備考 |
|------|---------|------|
| PDF | `[pdf]` | テキスト抽出 + レイアウト保持 |
| Word (.docx) | `[docx]` | 見出し・表・リスト保持 |
| Excel (.xlsx) | `[xlsx]` | セル内容を表として出力 |
| PowerPoint (.pptx) | `[pptx]` | スライド内容 + ノート |
| HTML | 標準 | 見出し・リンク・リスト保持 |
| 画像 | 標準 | EXIF メタデータ抽出＋キャプション |
| 音声 (wav/mp3) | `[audio-transcription]` | 文字起こし（Web サービス利用） |
| YouTube | `[youtube-transcription]` | 字幕取得 |
| EPub | 標準 | 電子書籍 → Markdown |
| ZIP | 標準 | アーカイブ内ファイルを再帰処理 |
| CSV/JSON/XML | 標準 | 構造化データを表として |
| Outlook .msg | `[outlook]` | メール本文＋添付 |

## セキュリティ考慮

MarkItDown は実行プロセスの権限で I/O を行う。信頼できない環境では `convert_local()` や `convert_stream()` の狭い関数を使う。プラグインはデフォルト無効。

## プラグイン機構

3rd パーティプラグインをサポート。`markitdown-ocr` プラグインが公式サンプルで、LLM Vision を使った OCR を PDF/DOCX/PPTX/XLSX に追加できる。

```python
from markitdown import MarkItDown
from openai import OpenAI

md = MarkItDown(enable_plugins=True, llm_client=OpenAI(), llm_model="gpt-4o")
result = md.convert("scanned_document.pdf")
```

## カスタマイズ計画

MarkItDown はプラグインアーキテクチャにより拡張可能。展示会制作・イベントワークフロー向けに以下が考えられる:

1. **ブース見積書パーサー**: 取引先から届く PDF 見積書を Markdown に変換 → LLM で金額・日程抽出
2. **イベント資料統合**: 配布資料（PPT/PDF/DOCX）を横断的に Markdown 化 → 社内ナレッジベースに投入
3. **取引先 Excel 読取**: 複数ベンダーの見積 Excel を統一 Markdown 形式に変換 → 比較表生成
4. **請求書アーカイブ**: PDF 請求書を Markdown 化 → 全文検索可能なアーカイブ

### サンプルプラグイン案: 展示会見積統合 (booth-quote-to-md)

```python
# plugins/booth_quote_to_md.py — 展示会見積特化プラグイン（計画案）
# 機能: 複数ベンダーから届く異形式の見積書を統一Markdownに変換
# 入力: PDF/Excel/Word
# 出力: 統一フォーマットのMarkdown（見積番号・項目・単価・数量・合計）

# markitdown の標準変換後、LLM で構造化抽出するパイプライン
from markitdown import MarkItDown
import json

def convert_quote(filepath: str) -> dict:
    md = MarkItDown()
    result = md.convert(filepath)
    return {
        "source": filepath,
        "markdown": result.markdown,
        "metadata": {
            "title": result.title,
            "text_length": len(result.markdown),
        }
    }
```

## 展示会ワークフローでの位置づけ

| 工程 | 現状 | markitdown導入後 |
|------|------|-----------------|
| 見積比較 | 手動で各社PDF/Excelを開いて確認 | markitdown→LLM抽出で一覧比較 |
| 配布資料のナレッジ化 | ファイル単位で管理 | Markdown統一で全文検索＋LLM質問 |
| イベント報告書 | 手書き/Wordの報告を読み取り | 報告PDFをMarkdown化→DB保存 |
| 請求書照合 | 紙/PDFから手入力 | markitdown→LLM照合で半自動化 |

## 制約

- **画像キャプション・音声文字起こし**: 外部 Web サービス依存（オフラインでは不可）
- **Azure Content Understanding**: 高品質変換には Azure API が必要（有料）
- **大規模 PDF**: 数百ページのマニュアル等はメモリ使用量に注意
- Python 3.10〜3.14 必須（3.15 での動作は未確認だが互換性高い見込み）

## 評価

| 観点 | 評価 |
|------|------|
| 導入容易性 | ⭐⭐⭐⭐⭐ pip install 一発 |
| 対応形式 | ⭐⭐⭐⭐⭐ 12形式以上 |
| 品質（テキスト抽出） | ⭐⭐⭐⭐ 構造保持良好、ただし数式・複雑表は限界 |
| オフライン対応 | ⭐⭐⭐ 画像・音声は外部依存 |
| カスタマイズ性 | ⭐⭐⭐⭐⭐ プラグインアーキテクチャ充実 |
| ライセンス | ⭐⭐⭐⭐⭐ MIT |