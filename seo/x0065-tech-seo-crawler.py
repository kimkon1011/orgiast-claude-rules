#!/usr/bin/env python3
"""
X-0065: カスタム技術SEOクローラー
==================================
Requests / BeautifulSoup / Pandas で構築した軽量SEO監査ツール。

機能:
  STEP1: ドメインURL入力と検証
  STEP2: ホームページから内部リンク発見（キュー+重複回避）
  STEP3: HTML抽出
  STEP4: 技術チェック（HTTPステータス・欠落タイトル・重複タイトル・H1・canonical・noindex・壊れたリンク）
  STEP5: タイトル・メタ・見出し等をCSVエクスポート

使用方法:
  python seo/x0065-tech-seo-crawler.py https://example.com [--max-pages 50] [--output-dir ./seo-reports]

依存:
  pip install requests beautifulsoup4 pandas lxml
"""

import argparse
import csv
import os
import sys
import time
from collections import deque
from dataclasses import dataclass, field, asdict
from urllib.parse import urljoin, urlparse, urlunparse
from datetime import datetime

import requests
from bs4 import BeautifulSoup
import pandas as pd


# ---------------------------------------------------------------------------
# データ構造
# ---------------------------------------------------------------------------

@dataclass
class PageResult:
    """1ページの監査結果"""
    url: str
    status_code: int = 0
    content_type: str = ""
    title: str = ""
    title_length: int = 0
    meta_description: str = ""
    meta_keywords: str = ""
    h1_tags: list = field(default_factory=list)
    h1_count: int = 0
    canonical: str = ""
    noindex: bool = False
    broken_links: list = field(default_factory=list)
    internal_links: int = 0
    external_links: int = 0
    content_length: int = 0
    load_time_ms: float = 0.0
    error: str = ""


# ---------------------------------------------------------------------------
# クローラー本体
# ---------------------------------------------------------------------------

class TechSEOCrawler:
    """
    技術SEOクローラー。
    同一ドメインの内部リンクをBFSで巡回し、技術メトリクスを収集する。
    """

    USER_AGENT = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    )
    DEFAULT_TIMEOUT = 15  # 秒
    MAX_PAGES_DEFAULT = 50
    REQUEST_DELAY = 0.5  # 秒（同一ドメインへの負荷軽減）

    def __init__(self, start_url: str, max_pages: int = MAX_PAGES_DEFAULT,
                 timeout: int = DEFAULT_TIMEOUT, delay: float = REQUEST_DELAY):
        # URL正規化
        self.start_url = self._normalize_url(start_url)
        parsed = urlparse(self.start_url)
        self.domain = parsed.netloc
        self.base_scheme = parsed.scheme

        self.max_pages = max_pages
        self.timeout = timeout
        self.delay = delay

        self.session = requests.Session()
        self.session.headers.update({"User-Agent": self.USER_AGENT})
        # リ���イレクトは追跡するが最終URLを記録
        self.session.max_redirects = 10

        self.visited: set = set()
        self.queue: deque = deque()
        self.results: dict[str, PageResult] = {}
        self.all_titles: dict[str, str] = {}  # url -> title（重複検出用）

    # -- URL ユーティリティ ------------------------------------------------

    @staticmethod
    def _normalize_url(url: str) -> str:
        """URLを正規化（フラグメント除去・末尾スラッシュ統一）"""
        parsed = urlparse(url)
        # フラグメント除去
        cleaned = parsed._replace(fragment="")
        # schemeがない場合は https を補完
        if not cleaned.scheme:
            cleaned = cleaned._replace(scheme="https")
        return urlunparse(cleaned)

    def _is_same_domain(self, url: str) -> bool:
        """同一ドメインか判定（サブドメイン含む）"""
        try:
            parsed = urlparse(url)
            return parsed.netloc and parsed.netloc == self.domain
        except Exception:
            return False

    def _is_html(self, content_type: str) -> bool:
        """HTMLコンテンツか判定"""
        if not content_type:
            return True  # 不明な場合はHTMLと仮定してパース試行
        ct = content_type.lower()
        return "text/html" in ct or "application/xhtml" in ct

    def _extract_links(self, soup: BeautifulSoup, base_url: str) -> tuple:
        """
        ページから内部リンク・外部リンク・壊れたリンクを抽出。
        戻り値: (internal_urls, external_count, broken_links)
        """
        internal_urls: list[str] = []
        external_count = 0
        broken_links: list[str] = []

        for a_tag in soup.find_all("a", href=True):
            href = a_tag["href"].strip()
            if not href or href.startswith("#") or href.startswith("javascript:"):
                continue

            absolute_url = urljoin(base_url, href)
            absolute_url = self._normalize_url(absolute_url)

            if self._is_same_domain(absolute_url):
                internal_urls.append(absolute_url)
            else:
                external_count += 1

        return internal_urls, external_count, broken_links

    def _check_broken_link(self, url: str) -> bool:
        """
        リンクが壊れているか簡易チェック（HEADリクエスト）。
        実際の巡回時ではなく、収集後のオプションチェック用。
        """
        try:
            resp = self.session.head(url, timeout=self.timeout)
            return resp.status_code >= 400
        except requests.RequestException:
            return True

    # -- ページ処理 --------------------------------------------------------

    def crawl_page(self, url: str) -> PageResult:
        """1ページをクロールし技術メトリクスを収集"""
        result = PageResult(url=url)
        start_time = time.time()

        try:
            resp = self.session.get(url, timeout=self.timeout)
            elapsed_ms = (time.time() - start_time) * 1000
            result.load_time_ms = round(elapsed_ms, 1)
            result.status_code = resp.status_code
            result.content_type = resp.headers.get("Content-Type", "")
            result.content_length = len(resp.content)

            if resp.status_code >= 400:
                result.error = f"HTTP {resp.status_code}"
                return result

            # HTML以外はここで終了
            if not self._is_html(result.content_type):
                return result

            # BeautifulSoupでHTMLパース
            soup = BeautifulSoup(resp.text, "lxml")

            # --- タイトル ---
            title_tag = soup.find("title")
            if title_tag and title_tag.string:
                result.title = title_tag.string.strip()
                result.title_length = len(result.title)

            # --- メタタグ ---
            meta_desc = soup.find("meta", attrs={"name": "description"})
            if meta_desc and meta_desc.get("content"):
                result.meta_description = meta_desc["content"].strip()

            meta_kw = soup.find("meta", attrs={"name": "keywords"})
            if meta_kw and meta_kw.get("content"):
                result.meta_keywords = meta_kw["content"].strip()

            # --- H1見出し ---
            h1_tags = soup.find_all("h1")
            result.h1_tags = [h1.get_text(strip=True) for h1 in h1_tags if h1.get_text(strip=True)]
            result.h1_count = len(result.h1_tags)

            # --- canonical ---
            canonical_tag = soup.find("link", rel="canonical")
            if canonical_tag and canonical_tag.get("href"):
                result.canonical = canonical_tag["href"].strip()

            # --- noindex ---
            meta_robots = soup.find("meta", attrs={"name": "robots"})
            if meta_robots and meta_robots.get("content"):
                result.noindex = "noindex" in meta_robots["content"].lower()

            # --- リンク抽出 ---
            internal_urls, ext_count, broken = self._extract_links(soup, url)
            result.internal_links = len(internal_urls)
            result.external_links = ext_count
            result.broken_links = broken

        except requests.exceptions.SSLError as e:
            result.error = f"SSL Error: {e}"
        except requests.exceptions.ConnectionError as e:
            result.error = f"Connection Error: {e}"
        except requests.exceptions.Timeout as e:
            result.error = f"Timeout: {e}"
        except requests.exceptions.TooManyRedirects as e:
            result.error = f"Too Many Redirects: {e}"
        except Exception as e:
            result.error = f"Unexpected Error: {e}"

        return result

    # -- メイン実行 --------------------------------------------------------

    def run(self) -> list[PageResult]:
        """クロールを実行し全結果を返す"""
        self.queue.append(self.start_url)
        self.visited.add(self.start_url)

        while self.queue and len(self.visited) <= self.max_pages:
            url = self.queue.popleft()
            print(f"[{len(self.visited)}/{self.max_pages}] Crawling: {url}")

            result = self.crawl_page(url)
            self.results[url] = result
            self.all_titles[url] = result.title

            # キューに内部リンクを追加（成功ページのみ・同一ドメイン・未訪問）
            if result.status_code == 200 and not result.error:
                # ページからリンク抽出のために再パース（crawl_pageで既に取得済みだが
                # 別メソッドで抽出ロジックを再利用）
                try:
                    resp = self.session.get(url, timeout=self.timeout)
                    soup = BeautifulSoup(resp.text, "lxml")
                    internal_urls, _, _ = self._extract_links(soup, url)
                    for link in internal_urls:
                        if link not in self.visited:
                            self.visited.add(link)
                            self.queue.append(link)
                except Exception:
                    pass  # リンク抽出失敗は無視（ページ自体は記録済み）

            # 負荷軽減のディレイ
            time.sleep(self.delay)

            if len(self.visited) >= self.max_pages:
                print(f"Reached max pages limit ({self.max_pages})")
                break

        return list(self.results.values())

    # -- 分析・レポート ----------------------------------------------------

    def analyze(self, results: list[PageResult]) -> dict:
        """結果を分析しサマリを生成"""
        total = len(results)
        if total == 0:
            return {"error": "No pages crawled"}

        status_ok = sum(1 for r in results if r.status_code == 200)
        status_4xx = sum(1 for r in results if 400 <= r.status_code < 500)
        status_5xx = sum(1 for r in results if r.status_code >= 500)
        status_other = total - status_ok - status_4xx - status_5xx

        missing_title = sum(1 for r in results if not r.title)
        # 重複タイトル
        title_counts = {}
        for r in results:
            if r.title:
                title_counts[r.title] = title_counts.get(r.title, 0) + 1
        duplicate_titles = {t: c for t, c in title_counts.items() if c > 1}

        no_h1 = sum(1 for r in results if r.h1_count == 0)
        multiple_h1 = sum(1 for r in results if r.h1_count > 1)
        has_canonical = sum(1 for r in results if r.canonical)
        no_canonical = total - has_canonical
        noindex_count = sum(1 for r in results if r.noindex)
        no_meta_desc = sum(1 for r in results if not r.meta_description)
        errors = sum(1 for r in results if r.error)

        avg_load = 0.0
        load_times = [r.load_time_ms for r in results if r.load_time_ms > 0]
        if load_times:
            avg_load = round(sum(load_times) / len(load_times), 1)

        return {
            "total_pages": total,
            "status_200": status_ok,
            "status_4xx": status_4xx,
            "status_5xx": status_5xx,
            "status_other": status_other,
            "missing_title": missing_title,
            "duplicate_titles_count": len(duplicate_titles),
            "duplicate_titles": duplicate_titles,
            "no_h1": no_h1,
            "multiple_h1": multiple_h1,
            "has_canonical": has_canonical,
            "no_canonical": no_canonical,
            "noindex_count": noindex_count,
            "no_meta_description": no_meta_desc,
            "errors": errors,
            "avg_load_time_ms": avg_load,
            "crawl_date": datetime.now().isoformat(),
            "start_url": self.start_url,
            "domain": self.domain,
        }

    def export_csv(self, results: list[PageResult], filepath: str):
        """全ページの詳細データをCSVに出力"""
        if not results:
            print("No data to export.")
            return

        rows = []
        for r in results:
            rows.append({
                "url": r.url,
                "status_code": r.status_code,
                "content_type": r.content_type,
                "title": r.title,
                "title_length": r.title_length,
                "meta_description": r.meta_description,
                "meta_keywords": r.meta_keywords,
                "h1_tags": " | ".join(r.h1_tags),
                "h1_count": r.h1_count,
                "canonical": r.canonical,
                "noindex": r.noindex,
                "internal_links": r.internal_links,
                "external_links": r.external_links,
                "load_time_ms": r.load_time_ms,
                "content_length": r.content_length,
                "error": r.error,
            })

        df = pd.DataFrame(rows)
        df.to_csv(filepath, index=False, encoding="utf-8-sig")
        print(f"Exported {len(rows)} rows to {filepath}")

    def export_analysis_csv(self, analysis: dict, filepath: str):
        """分析サマリをCSVに出力（1行のサマリ）"""
        flat = {k: v for k, v in analysis.items() if not isinstance(v, dict)}
        df = pd.DataFrame([flat])
        df.to_csv(filepath, index=False, encoding="utf-8-sig")
        print(f"Exported analysis summary to {filepath}")

    def print_report(self, analysis: dict):
        """分析結果をコンソールに表示"""
        print("\n" + "=" * 60)
        print(f"  SEO Crawl Report — {analysis['domain']}")
        print(f"  Crawl date: {analysis['crawl_date']}")
        print("=" * 60)
        print(f"\n📊 Overview:")
        print(f"  Total pages crawled: {analysis['total_pages']}")
        print(f"  HTTP 200 OK:        {analysis['status_200']}")
        print(f"  HTTP 4xx:           {analysis['status_4xx']}")
        print(f"  HTTP 5xx:           {analysis['status_5xx']}")
        print(f"  Other status:       {analysis['status_other']}")
        print(f"  Errors:             {analysis['errors']}")

        print(f"\n🏷️  Titles:")
        print(f"  Missing <title>:    {analysis['missing_title']}")
        print(f"  Duplicate titles:   {analysis['duplicate_titles_count']}")
        if analysis['duplicate_titles']:
            for t, c in list(analysis['duplicate_titles'].items())[:5]:
                print(f"    ×{c}: {t[:60]}...")

        print(f"\n📐 Headings:")
        print(f"  Pages without H1:   {analysis['no_h1']}")
        print(f"  Pages with >1 H1:   {analysis['multiple_h1']}")

        print(f"\n🔗 Canonical & Index:")
        print(f"  With canonical:     {analysis['has_canonical']}")
        print(f"  Without canonical:  {analysis['no_canonical']}")
        print(f"  Noindex pages:      {analysis['noindex_count']}")

        print(f"\n📝 Meta:")
        print(f"  Missing meta desc:  {analysis['no_meta_description']}")

        print(f"\n⚡ Performance:")
        print(f"  Avg load time:      {analysis['avg_load_time_ms']} ms")
        print()


# ---------------------------------------------------------------------------
# CLI エントリポイント
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="X-0065: カスタム技術SEOクローラー — 内部リンク巡回と技術監査"
    )
    parser.add_argument("url", help="クロール開始URL（例: https://example.com）")
    parser.add_argument("--max-pages", type=int, default=TechSEOCrawler.MAX_PAGES_DEFAULT,
                        help=f"最大クロールページ数（デフォルト: {TechSEOCrawler.MAX_PAGES_DEFAULT}）")
    parser.add_argument("--output-dir", default="./seo-reports",
                        help="レポート出力ディレクトリ（デフォルト: ./seo-reports）")
    parser.add_argument("--delay", type=float, default=TechSEOCrawler.REQUEST_DELAY,
                        help=f"リクエスト間隔（秒、デフォルト: {TechSEOCrawler.REQUEST_DELAY}）")
    parser.add_argument("--timeout", type=int, default=TechSEOCrawler.DEFAULT_TIMEOUT,
                        help=f"タイムアウト秒数（デフォルト: {TechSEOCrawler.DEFAULT_TIMEOUT}）")

    args = parser.parse_args()

    # URL検証（STEP1）
    url = TechSEOCrawler._normalize_url(args.url)
    parsed = urlparse(url)
    if not parsed.netloc:
        print(f"❌ 無効なURL: {args.url}")
        sys.exit(1)
    print(f"✅ URL検証OK: {url}")

    # 出力ディレクトリ作成
    os.makedirs(args.output_dir, exist_ok=True)

    # ク���ーラー実行
    crawler = TechSEOCrawler(url, max_pages=args.max_pages,
                             timeout=args.timeout, delay=args.delay)
    print(f"\n🔍 クロール開始: {url} (max {args.max_pages} pages)")
    results = crawler.run()

    # 分析
    analysis = crawler.analyze(results)
    crawler.print_report(analysis)

    # CSVエクスポート（STEP5）
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    detail_csv = os.path.join(args.output_dir, f"seo_crawl_detail_{timestamp}.csv")
    summary_csv = os.path.join(args.output_dir, f"seo_crawl_summary_{timestamp}.csv")
    crawler.export_csv(results, detail_csv)
    crawler.export_analysis_csv(analysis, summary_csv)

    print(f"\n✅ 完了。出力ファイル:")
    print(f"   📄 詳細: {detail_csv}")
    print(f"   📄 サマリ: {summary_csv}")
    print(f"   📊 全{len(results)}ページを監査")


if __name__ == "__main__":
    main()