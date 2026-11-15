#!/usr/bin/env python3
"""
seo_crawler.py — Technical SEO Crawler and Analysis Tool

A standalone Python 3.11+ script that crawls a domain via BFS,
extracts SEO elements from HTML pages, runs common SEO checks,
and outputs CSV reports plus a JSON summary.

Usage:
    python seo_crawler.py https://example.com
    python seo_crawler.py https://example.com --max-pages 100 --output-dir ./my_report --verbose
    python seo_crawler.py example.com --timeout 15

Dependencies: Python standard library only (no pip packages required).
"""

from __future__ import annotations

import argparse
import csv
import html.parser
import io
import json
import re
import socket
import ssl
import time
import urllib.parse
from collections import deque
from http.client import HTTPConnection, HTTPSConnection
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple


# ---------------------------------------------------------------------------
# HTML Parser — extract SEO-relevant elements from a page body
# ---------------------------------------------------------------------------

class SEOParser(html.parser.HTMLParser):
    """Extracts title, H1s, meta description, canonical, noindex, and links."""

    def __init__(self, base_url: str, same_domain: str) -> None:
        super().__init__()
        self.base_url = base_url
        self.same_domain = same_domain
        self.title: Optional[str] = None
        self.h1s: List[str] = []
        self.meta_description: Optional[str] = None
        self.canonical_url: Optional[str] = None
        self.is_noindex: bool = False
        self.internal_links: List[str] = []
        self.external_links: List[str] = []
        self._in_title: bool = False
        self._in_h1: bool = False
        self._title_parts: List[str] = []
        self._h1_parts: List[str] = []

    def _resolve(self, href: str) -> Optional[str]:
        """Resolve a potentially relative URL to absolute; None if invalid."""
        resolved = urllib.parse.urljoin(self.base_url, href)
        parsed = urllib.parse.urlparse(resolved)
        # Keep only http/https
        if parsed.scheme not in ("http", "https"):
            return None
        return resolved

    def _is_internal(self, url: str) -> bool:
        """True if the URL belongs to the same domain we are crawling."""
        parsed = urllib.parse.urlparse(url)
        return parsed.netloc.lower() == self.same_domain.lower()

    def handle_starttag(self, tag: str, attrs) -> None:
        attrs_dict = dict(attrs)

        if tag == "title":
            self._in_title = True
            self._title_parts = []
            return

        if tag == "h1":
            self._in_h1 = True
            self._h1_parts = []
            return

        if tag == "meta":
            name = attrs_dict.get("name", "").lower().strip()
            if name == "description":
                content = attrs_dict.get("content", "").strip()
                if content:
                    self.meta_description = content
            if name == "robots":
                content = attrs_dict.get("content", "").lower().strip()
                if "noindex" in content or content == "none":
                    self.is_noindex = True
            return

        if tag == "link":
            rel = attrs_dict.get("rel", "").lower().strip()
            if rel == "canonical":
                href = attrs_dict.get("href", "").strip()
                if href:
                    resolved = self._resolve(href)
                    if resolved:
                        self.canonical_url = resolved
            return

        if tag == "a":
            href = attrs_dict.get("href", "").strip()
            if not href:
                return
            # Skip fragments-only, javascript:, mailto:
            if href.startswith("#") or href.startswith("javascript:") or href.startswith("mailto:"):
                return
            resolved = self._resolve(href)
            if resolved is None:
                return
            if self._is_internal(resolved):
                self.internal_links.append(resolved)
            else:
                self.external_links.append(resolved)
            return

    def handle_endtag(self, tag: str) -> None:
        if tag == "title" and self._in_title:
            self._in_title = False
            text = "".join(self._title_parts).strip()
            if text:
                self.title = text
        if tag == "h1" and self._in_h1:
            self._in_h1 = False
            text = "".join(self._h1_parts).strip()
            if text:
                self.h1s.append(text)

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self._title_parts.append(data)
        elif self._in_h1:
            self._h1_parts.append(data)


# ---------------------------------------------------------------------------
# HTTP Fetcher — request a URL and return (status, final_url, body)
# ---------------------------------------------------------------------------

def fetch_url(
    url: str,
    timeout: int = 10,
    max_redirects: int = 5,
    verbose: bool = False,
) -> Tuple[int, str, str]:
    """
    Fetch a URL over HTTP(S), following redirects up to max_redirects.

    Returns (status_code, final_url, response_body).
    On unrecoverable error, returns (0, url, "") and prints a warning to stderr.
    """
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return 0, url, ""

    is_https = parsed.scheme == "https"
    host = parsed.netloc
    path = parsed.path or "/"
    if parsed.query:
        path += "?" + parsed.query

    redirect_count = 0
    current_host = host
    current_path = path
    current_url = url
    current_is_https = is_https

    while redirect_count <= max_redirects:
        try:
            if current_is_https:
                context = ssl._create_unverified_context()
                conn = HTTPSConnection(current_host, timeout=timeout, context=context)
            else:
                conn = HTTPConnection(current_host, timeout=timeout)

            conn.request("GET", current_path, headers={
                "User-Agent": "Mozilla/5.0 (compatible; SEOCrawler/1.0; +https://github.com)",
                "Accept": "text/html,application/xhtml+xml",
            })
            response = conn.getresponse()
            body = response.read().decode("utf-8", errors="replace")
            status = response.status
            conn.close()

            # Follow redirects
            if status in (301, 302, 303, 307, 308):
                location = response.getheader("Location", "")
                if not location:
                    return status, current_url, body
                # Resolve relative redirect
                redirect_url = urllib.parse.urljoin(current_url, location)
                redirect_parsed = urllib.parse.urlparse(redirect_url)
                if redirect_parsed.scheme not in ("http", "https"):
                    return status, current_url, body
                redirect_count += 1
                current_url = redirect_url
                current_is_https = redirect_parsed.scheme == "https"
                current_host = redirect_parsed.netloc
                current_path = redirect_parsed.path or "/"
                if redirect_parsed.query:
                    current_path += "?" + redirect_parsed.query
                continue

            return status, current_url, body

        except socket.timeout:
            print(f"  [!] Timeout fetching: {current_url}", file=__import__("sys").stderr)
            return 0, current_url, ""
        except socket.gaierror:
            print(f"  [!] DNS resolution failed: {current_host}", file=__import__("sys").stderr)
            return 0, current_url, ""
        except Exception as exc:
            if verbose:
                print(f"  [!] Error fetching {current_url}: {exc}", file=__import__("sys").stderr)
            return 0, current_url, ""

    # Too many redirects
    print(f"  [!] Too many redirects for: {url}", file=__import__("sys").stderr)
    return 0, current_url, ""


# ---------------------------------------------------------------------------
# URL set helpers
# ---------------------------------------------------------------------------

# File extensions to skip (non-HTML resources)
_SKIP_EXTENSIONS: Set[str] = {
    ".pdf", ".jpg", ".jpeg", ".png", ".gif", ".svg", ".webp",
    ".mp4", ".mp3", ".zip", ".doc", ".docx", ".xls", ".xlsx",
    ".css", ".js", ".json", ".xml", ".woff", ".woff2", ".ttf",
    ".ico", ".avi", ".mov", ".mkv", ".webm", ".m4a", ".aac",
    ".mpg", ".mpeg", ".ppt", ".pptx",
}

# Regex to detect common non-HTML file extensions in URL path
_RE_SKIP_PATH = re.compile(
    r"\.(pdf|jpe?g|png|gif|svg|webp|mp4|mp3|zip|docx?|xlsx?|css|js|json|xml|woff2?|ttf|ico|avi|mov|mkv|webm|m4a|aac|mpe?g|pptx?)([?#]|$)",
    re.IGNORECASE,
)


def should_skip(url: str) -> bool:
    """
    Return True if the URL points to a non-HTML resource that should
    not be crawled (images, documents, archives, stylesheets, etc.).
    """
    parsed = urllib.parse.urlparse(url)
    path = parsed.path
    # Check extension via regex (handles query strings and fragments)
    if _RE_SKIP_PATH.search(path):
        return True
    # Also check bare extensions at the very end
    lower = path.lower()
    for ext in _SKIP_EXTENSIONS:
        if lower.endswith(ext):
            return True
    return False


def normalize_url(url: str) -> str:
    """
    Normalize a URL: lowercase scheme/host, remove fragment,
    strip trailing slash for non-root paths.
    """
    parsed = urllib.parse.urlparse(url)
    scheme = parsed.scheme.lower()
    netloc = parsed.netloc.lower()
    path = parsed.path.rstrip("/") or "/"
    # Rebuild without fragment
    normalized = urllib.parse.urlunparse((scheme, netloc, path, parsed.query, "", ""))
    return normalized


# ---------------------------------------------------------------------------
# Crawler
# ---------------------------------------------------------------------------

PageData = Dict  # type alias for clarity


class SEOCrawler:
    """
    BFS web crawler that discovers internal pages on a single domain
    and runs SEO checks on each.
    """

    def __init__(
        self,
        seed_url: str,
        max_pages: int = 50,
        timeout: int = 10,
        verbose: bool = False,
    ) -> None:
        self.seed_url = seed_url
        self.max_pages = max_pages
        self.timeout = timeout
        self.verbose = verbose

        # Normalised domain for internal-link detection
        parsed_seed = urllib.parse.urlparse(seed_url)
        self.domain: str = parsed_seed.netloc.lower()

        # BFS state
        self.queue: deque = deque()
        self.visited: Set[str] = set()

        # Results
        self.pages: List[PageData] = []

        # Title dedup tracker
        self._title_seen: Dict[str, str] = {}  # title -> first url

        # Broken-link store (populated in verify pass)
        self._broken_links: List[Dict] = []

    # -- Public API -------------------------------------------------------

    def run(self) -> Tuple[List[PageData], List[Dict]]:
        """
        Execute the crawl: BFS discovery + SEO checks + broken-link verification.

        Returns (pages, broken_links).
        """
        start_ts = time.time()

        # Seed the queue
        seed_normalized = normalize_url(self.seed_url)
        self.queue.append(seed_normalized)

        crawled = 0

        while self.queue and crawled < self.max_pages:
            url = self.queue.popleft()
            if url in self.visited:
                continue
            self.visited.add(url)

            crawled += 1
            print(
                f"[{crawled}/{self.max_pages}] Crawling: {url}",
                file=__import__("sys").stderr,
            )

            page = self._crawl_page(url)
            self.pages.append(page)

            # If the page returned OK and is indexable, discover new links
            if page["status"] == 200 and not page["is_noindex"]:
                for link in page["internal_links"]:
                    normalized = normalize_url(link)
                    if normalized not in self.visited:
                        self.queue.append(normalized)

        elapsed = time.time() - start_ts

        # Broken-link verification pass
        self._verify_broken_links()

        # Attach summary stats
        self._elapsed = elapsed
        self._crawled = crawled

        return self.pages, self._broken_links

    # -- Page-level crawl -------------------------------------------------

    def _crawl_page(self, url: str) -> PageData:
        """Fetch a single page, parse it, and run SEO checks."""
        status, final_url, body = fetch_url(url, timeout=self.timeout, verbose=self.verbose)

        page: PageData = {
            "url": url,
            "final_url": final_url,
            "status": status,
            "title": None,
            "title_issues": [],
            "h1s": [],
            "h1_issues": [],
            "description": None,
            "description_issues": [],
            "canonical_url": None,
            "has_canonical": False,
            "is_noindex": False,
            "internal_links": [],
            "external_links": [],
            "links_checked": 0,
        }

        if status != 200 or not body:
            if status == 0:
                page["title_issues"].append("error")
            else:
                page["title_issues"].append("non_200")
            return page

        # Parse HTML
        parser = SEOParser(base_url=final_url, same_domain=self.domain)
        try:
            parser.feed(body)
        except html.parser.HTMLParseError:
            # Some malformed HTML may still parse partially; continue
            pass

        page["title"] = parser.title
        page["h1s"] = parser.h1s
        page["description"] = parser.meta_description
        page["canonical_url"] = parser.canonical_url
        page["has_canonical"] = parser.canonical_url is not None
        page["is_noindex"] = parser.is_noindex
        page["internal_links"] = list(dict.fromkeys(parser.internal_links))  # dedup, preserve order
        page["external_links"] = list(dict.fromkeys(parser.external_links))
        page["links_checked"] = len(parser.internal_links)

        # --- SEO Checks ---

        # 1. Title
        if not parser.title:
            page["title_issues"].append("missing")
        else:
            # Duplicate check (skip if already flagged)
            dup_url = self._title_seen.get(parser.title)
            if dup_url is not None and dup_url != url:
                page["title_issues"].append("duplicate")
            else:
                self._title_seen[parser.title] = url

        # 2. H1
        if len(parser.h1s) == 0:
            page["h1_issues"].append("missing")
        elif len(parser.h1s) > 1:
            page["h1_issues"].append("multiple")

        # 3. Description
        if not parser.meta_description:
            page["description_issues"].append("missing")
        elif len(parser.meta_description) < 50:
            page["description_issues"].append("too_short")

        if self.verbose:
            self._debug_print(url, page, parser)

        return page

    # -- Broken link verification pass ------------------------------------

    def _verify_broken_links(self) -> None:
        """Check all found internal links for 4xx/5xx or fetch errors."""
        # Collect all unique internal links from every page
        all_links: Set[str] = set()
        for page in self.pages:
            for link in page.get("internal_links", []):
                all_links.add(link)

        total = len(all_links)
        checked = 0

        if total == 0:
            return

        print(
            f"- Verifying {total} internal link(s) for broken status...",
            file=__import__("sys").stderr,
        )

        for link in sorted(all_links):
            checked += 1
            if checked % 10 == 0 or checked == total:
                print(
                    f"  [{checked}/{total}] checking...",
                    file=__import__("sys").stderr,
                )
            status, _, _ = fetch_url(link, timeout=self.timeout)
            if status == 0 or (400 <= status < 600):
                # Find which source pages contain this broken link
                sources = [
                    p["url"] for p in self.pages if link in p.get("internal_links", [])
                ]
                error_type = "error" if status == 0 else str(status)
                self._broken_links.append({
                    "source_url": "; ".join(sources) if sources else "unknown",
                    "broken_url": link,
                    "status_code": status,
                    "error_type": error_type,
                })

    # -- Summary / stats --------------------------------------------------

    def summary(self) -> Dict:
        """Produce aggregate statistics from the crawl."""
        total = len(self.pages)
        ok_count = sum(1 for p in self.pages if p["status"] == 200)
        error_count = sum(1 for p in self.pages if p["status"] not in (200, 0))

        missing_title = sum(1 for p in self.pages if "missing" in p.get("title_issues", []))
        duplicate_title = sum(1 for p in self.pages if "duplicate" in p.get("title_issues", []))
        missing_h1 = sum(1 for p in self.pages if "missing" in p.get("h1_issues", []))
        multiple_h1 = sum(1 for p in self.pages if "multiple" in p.get("h1_issues", []))
        missing_desc = sum(1 for p in self.pages if "missing" in p.get("description_issues", []))

        return {
            "seed_url": self.seed_url,
            "total_pages": total,
            "ok_count": ok_count,
            "error_count": error_count,
            "missing_title_count": missing_title,
            "duplicate_title_count": duplicate_title,
            "missing_h1_count": missing_h1,
            "multiple_h1_count": multiple_h1,
            "missing_desc_count": missing_desc,
            "broken_link_count": len(self._broken_links),
            "crawl_time_seconds": round(getattr(self, "_elapsed", 0), 2),
        }

    # -- Debug helpers ----------------------------------------------------

    def _debug_print(self, url: str, page: PageData, parser: SEOParser) -> None:
        """Verbose per-page debug output."""
        print(f"\n-- {url}", file=__import__("sys").stderr)
        print(f"  Status: {page['status']}", file=__import__("sys").stderr)
        print(f"  Title: {page['title']!r}", file=__import__("sys").stderr)
        print(f"  H1s: {page['h1s']!r}", file=__import__("sys").stderr)
        print(f"  Description: {page['description']!r}", file=__import__("sys").stderr)
        print(f"  Canonical: {page['canonical_url']!r}", file=__import__("sys").stderr)
        print(f"  Noindex: {page['is_noindex']}", file=__import__("sys").stderr)
        print(f"  Internal links: {len(parser.internal_links)}", file=__import__("sys").stderr)
        print(f"  External links: {len(parser.external_links)}", file=__import__("sys").stderr)


# ---------------------------------------------------------------------------
# CSV / JSON Output Writers
# ---------------------------------------------------------------------------

def _write_csv_bom(path: Path, fieldnames: List[str], rows: List[Dict]) -> None:
    """Write CSV with UTF-8 BOM for Excel compatibility."""
    with io.TextIOWrapper(
        io.BytesIO(), encoding="utf-8-sig", newline=""
    ) as wrapper:
        # We need to write to a file directly; open the file with utf-8-sig
        import os
        with open(path, "w", encoding="utf-8-sig", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)


def write_reports(
    output_dir: Path,
    pages: List[PageData],
    broken_links: List[Dict],
    summary_data: Dict,
) -> None:
    """Generate all CSV reports and the JSON summary file."""
    output_dir.mkdir(parents=True, exist_ok=True)

    # --- 01_titles.csv ---
    title_rows: List[Dict] = []
    for p in pages:
        issues = "|".join(p.get("title_issues", [])) if p.get("title_issues") else "ok"
        title_text = p.get("title") or ""
        title_rows.append({
            "url": p["url"],
            "title": title_text,
            "title_length": len(title_text) if title_text else 0,
            "issues": issues,
        })
    _write_csv(
        output_dir / "01_titles.csv",
        ["url", "title", "title_length", "issues"],
        title_rows,
    )

    # --- 02_h1s.csv ---
    h1_rows: List[Dict] = []
    for p in pages:
        h1_count = len(p.get("h1s", []))
        h1_text = "; ".join(p["h1s"]) if p["h1s"] else ""
        issues_list = p.get("h1_issues", [])
        if not issues_list:
            if h1_count == 1:
                issues = "ok"
            else:
                issues = "|".join(issues_list) if issues_list else "ok"
        else:
            issues = "|".join(issues_list)
        h1_rows.append({
            "url": p["url"],
            "h1_count": h1_count,
            "h1_text": h1_text,
            "issues": issues,
        })
    _write_csv(
        output_dir / "02_h1s.csv",
        ["url", "h1_count", "h1_text", "issues"],
        h1_rows,
    )

    # --- 03_descriptions.csv ---
    desc_rows: List[Dict] = []
    for p in pages:
        desc = p.get("description") or ""
        issues_list = p.get("description_issues", [])
        issues = "|".join(issues_list) if issues_list else "ok"
        desc_rows.append({
            "url": p["url"],
            "description": desc,
            "description_length": len(desc) if desc else 0,
            "issues": issues,
        })
    _write_csv(
        output_dir / "03_descriptions.csv",
        ["url", "description", "description_length", "issues"],
        desc_rows,
    )

    # --- 04_canonicals.csv ---
    canon_rows: List[Dict] = []
    for p in pages:
        canon_rows.append({
            "url": p["url"],
            "canonical_url": p.get("canonical_url") or "",
            "has_canonical": str(p.get("has_canonical", False)),
            "is_noindex": str(p.get("is_noindex", False)),
        })
    _write_csv(
        output_dir / "04_canonicals.csv",
        ["url", "canonical_url", "has_canonical", "is_noindex"],
        canon_rows,
    )

    # --- 05_broken_links.csv ---
    _write_csv(
        output_dir / "05_broken_links.csv",
        ["source_url", "broken_url", "status_code", "error_type"],
        broken_links,
    )

    # --- 06_summary.json ---
    summary_path = output_dir / "06_summary.json"
    with open(summary_path, "w", encoding="utf-8") as f:
        json.dump(summary_data, f, indent=2, ensure_ascii=False)
    print(f"  [FILE] Summary: {summary_path}", file=__import__("sys").stderr)


def _write_csv(path: Path, fieldnames: List[str], rows: List[Dict]) -> None:
    """Write a CSV file with UTF-8 BOM for Excel compatibility."""
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    print(f"  [FILE] Created: {path}", file=__import__("sys").stderr)


# ---------------------------------------------------------------------------
# URL validation / seed preparation
# ---------------------------------------------------------------------------

def prepare_seed_url(raw: str) -> str:
    """
    Validate and normalise the user-supplied URL.
    Auto-prepend https:// if no scheme is present.
    Raises ValueError on unrecoverable problems.
    """
    raw = raw.strip()

    # Auto-prepend scheme
    if "://" not in raw:
        raw = "https://" + raw

    parsed = urllib.parse.urlparse(raw)
    if not parsed.netloc:
        raise ValueError(f"'{raw}' does not contain a valid hostname.")

    # Reject non-http schemes
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"Unsupported scheme '{parsed.scheme}'. Use http or https.")

    # Basic hostname sanity
    host = parsed.netloc.split(":")[0]  # strip port if present
    if not host or "." not in host:
        # localhost and IP addresses are acceptable but warn
        if host not in ("localhost", "127.0.0.1", "0.0.0.1") and not re.match(
            r"^\d{1,3}(\.\d{1,3}){3}$", host
        ):
            raise ValueError(f"'{raw}' does not appear to be a valid domain name.")

    # Check reachability with a quick HEAD (or GET fallback)
    _check_reachability(raw)

    return raw


def _check_reachability(url: str) -> None:
    """
    Quick connectivity check — perform a HEAD request to verify the
    server is reachable before starting the full crawl.
    """
    parsed = urllib.parse.urlparse(url)
    is_https = parsed.scheme == "https"
    host = parsed.netloc
    path = parsed.path or "/"
    if parsed.query:
        path += "?" + parsed.query

    try:
        if is_https:
            context = ssl._create_unverified_context()
            conn = HTTPSConnection(host, timeout=10, context=context)
        else:
            conn = HTTPConnection(host, timeout=10)
        conn.request("HEAD", path, headers={
            "User-Agent": "SEOCrawler/1.0 (connectivity-check)",
        })
        response = conn.getresponse()
        # Read response body to allow connection reuse / close cleanly
        _ = response.read()
        conn.close()
    except Exception as exc:
        print(
            f"  [!] Reachability check warning: {exc}",
            file=__import__("sys").stderr,
        )
        print(
            "    Continuing anyway -- the seed URL may be slow or temporarily unreachable.",
            file=__import__("sys").stderr,
        )


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    """Parse and return command-line arguments."""
    parser = argparse.ArgumentParser(
        description="Technical SEO Crawler - crawl a domain, extract SEO elements, "
        "run checks, and output CSV reports plus a JSON summary.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  %(prog)s https://example.com\n"
            "  %(prog)s https://example.com --max-pages 100 --output-dir ./seo_report\n"
            "  %(prog)s example.com --timeout 15 --verbose\n"
        ),
    )
    parser.add_argument(
        "url",
        type=str,
        help="Target URL to crawl (scheme optional; https:// is prepended if missing).",
    )
    parser.add_argument(
        "--max-pages",
        type=int,
        default=50,
        help="Maximum number of pages to crawl (default: 50).",
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default="./seo_report",
        help="Directory to write CSV and JSON reports (default: ./seo_report).",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=10,
        help="Timeout in seconds for each HTTP request (default: 10).",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        default=False,
        help="Enable detailed HTML debug output per page (default: disabled).",
    )
    return parser.parse_args()


def main() -> None:
    """CLI entry point."""
    args = parse_args()

    # Validate and prepare seed URL
    try:
        seed_url = prepare_seed_url(args.url)
    except ValueError as e:
        print(f"Error: {e}", file=__import__("sys").stderr)
        __import__("sys").exit(1)

    output_dir = Path(args.output_dir)

    print(f"[START] Starting crawl of {seed_url}", file=__import__("sys").stderr)
    print(f"   Max pages: {args.max_pages}", file=__import__("sys").stderr)
    print(f"   Timeout: {args.timeout}s", file=__import__("sys").stderr)
    print(f"   Output dir: {output_dir.resolve()}", file=__import__("sys").stderr)
    print(file=__import__("sys").stderr)

    # Run crawl
    crawler = SEOCrawler(
        seed_url=seed_url,
        max_pages=args.max_pages,
        timeout=args.timeout,
        verbose=args.verbose,
    )
    pages, broken_links = crawler.run()

    # Generate reports
    write_reports(output_dir, pages, broken_links, crawler.summary())

    # Final summary line to stdout (as specified in requirements)
    stats = crawler.summary()
    print(
        f"[OK] Crawled {stats['total_pages']} pages, "
        f"{stats['missing_title_count'] + stats['duplicate_title_count'] + stats['missing_h1_count'] + stats['multiple_h1_count'] + stats['missing_desc_count'] + stats['broken_link_count']} issues found "
        f"(T: {stats['missing_title_count']} missing, "
        f"H: {stats['missing_h1_count']} missing, "
        f"D: {stats['missing_desc_count']} missing, "
        f"B: {stats['broken_link_count']} broken)"
    )


if __name__ == "__main__":
    main()