#!/usr/bin/env python3
"""Download and textify public-procurement notices using GET requests only."""

from __future__ import annotations

import argparse
import html
import json
import re
import shutil
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36"
LINK_WORDS = re.compile(r"公告|入札説明書|仕様書|実施要領|募集要項|様式")
ALLOWED_EXTS = {".pdf", ".doc", ".docx", ".xls", ".xlsx"}


class Throttler:
    def __init__(self) -> None:
        self.last_any = 0.0
        self.last_domain: dict[str, float] = {}

    def wait(self, url: str) -> None:
        domain = urllib.parse.urlsplit(url).netloc.lower()
        now = time.monotonic()
        delay = max(0.0, 1.0 - (now - self.last_any), 1.5 - (now - self.last_domain.get(domain, 0.0)))
        if delay:
            time.sleep(delay)
        now = time.monotonic()
        self.last_any = now
        self.last_domain[domain] = now


def parse_list(path: Path) -> list[dict[str, str]]:
    keys = ["no", "date", "format", "org", "title", "url", "keyword"]
    rows = []
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        if line.strip():
            rows.append(dict(zip(keys, line.split("|", 6), strict=True)))
    return rows


def get(url: str, throttle: Throttler) -> tuple[int, bytes, str]:
    throttle.wait(url)
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=45) as res:
            return res.status, res.read(), res.headers.get("Content-Type", "")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(), exc.headers.get("Content-Type", "")


def is_html(url: str, ctype: str, body: bytes) -> bool:
    ext = Path(urllib.parse.urlsplit(url).path).suffix.lower()
    return "html" in ctype.lower() or ext in {".html", ".htm"} or body.lstrip()[:20].lower().startswith(b"<!doctype html")


def ext_for(url: str, ctype: str, body: bytes) -> str:
    ext = Path(urllib.parse.urlsplit(url).path).suffix.lower()
    if is_html(url, ctype, body):
        return ".html"
    if body.startswith(b"%PDF") or "pdf" in ctype.lower():
        return ".pdf"
    if ext in ALLOWED_EXTS:
        return ext
    return ".bin"


def decode_html(body: bytes, ctype: str) -> str:
    charset = re.search(r"charset=([\w-]+)", ctype, re.I)
    for encoding in ([charset.group(1)] if charset else []) + ["utf-8", "cp932", "euc-jp"]:
        try:
            return body.decode(encoding)
        except (UnicodeDecodeError, LookupError):
            pass
    return body.decode("utf-8", errors="replace")


def html_text(source: str) -> str:
    source = re.sub(r"(?is)<(script|style|noscript).*?</\1>", " ", source)
    source = re.sub(r"(?i)<br\s*/?>|</(?:p|div|li|tr|h[1-6])>", "\n", source)
    source = re.sub(r"(?s)<[^>]+>", " ", source)
    source = html.unescape(source).replace("\xa0", " ")
    lines = [re.sub(r"[ \t]+", " ", x).strip() for x in source.splitlines()]
    return "\n".join(x for x in lines if x) + "\n"


def attachment_links(base_url: str, source: str) -> list[str]:
    domain = urllib.parse.urlsplit(base_url).netloc.lower()
    found = []
    for match in re.finditer(r"(?is)<a\b[^>]*href\s*=\s*(['\"])(.*?)\1[^>]*>(.*?)</a>", source):
        href, label = html.unescape(match.group(2)), html_text(match.group(3)).strip()
        url = urllib.parse.urljoin(base_url, href)
        parts = urllib.parse.urlsplit(url)
        if parts.scheme not in {"http", "https"} or parts.netloc.lower() != domain:
            continue
        if Path(parts.path).suffix.lower() not in ALLOWED_EXTS:
            continue
        if not LINK_WORDS.search(label + " " + urllib.parse.unquote(parts.path)):
            continue
        clean = urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, parts.query, ""))
        if clean not in found:
            found.append(clean)
    return found[:6]


def find_pdftotext() -> str:
    candidates = [
        shutil.which("pdftotext"),
        r"C:\msys64\usr\bin\pdftotext.exe",
        r"C:\Program Files\Git\mingw64\bin\pdftotext.exe",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return str(candidate)
    raise FileNotFoundError("pdftotext not found")


def textify(path: Path, txt_dir: Path, pdftotext: str) -> str:
    out = txt_dir / (path.stem + ".txt")
    ext = path.suffix.lower()
    try:
        if ext == ".pdf":
            proc = subprocess.run([pdftotext, "-layout", str(path), str(out)], capture_output=True, text=True)
            if proc.returncode:
                return "PDF text conversion failed: " + proc.stderr.strip()[:300]
            content = out.read_text(encoding="utf-8", errors="replace")
            # Some Japanese PDFs omit usable ToUnicode data for Poppler while
            # pypdf can still resolve the embedded CMap. Keep pdftotext as the
            # required first pass, then use this non-OCR fallback when it lost
            # essentially every Japanese glyph.
            if len(re.findall(r"[\u3040-\u30ff\u3400-\u9fff]", content)) < 10:
                try:
                    from pypdf import PdfReader
                    fallback = "\n\f\n".join((page.extract_text() or "") for page in PdfReader(path).pages)
                    if len(re.findall(r"[\u3040-\u30ff\u3400-\u9fff]", fallback)) >= 10:
                        out.write_text(fallback, encoding="utf-8")
                        content = fallback
                        return "textified (pdftotext first pass; pypdf CMap fallback)"
                except Exception:
                    pass
            return "画像PDF・文字なし" if len(re.sub(r"\s", "", content)) < 20 else "textified"
        if ext == ".html":
            source = path.read_text(encoding="utf-8", errors="replace")
            out.write_text(html_text(source), encoding="utf-8")
            return "textified"
        if ext in {".docx", ".xlsx"}:
            import zipfile
            with zipfile.ZipFile(path) as zf:
                names = [n for n in zf.namelist() if (ext == ".docx" and n.startswith("word/") and n.endswith(".xml")) or (ext == ".xlsx" and n.startswith("xl/") and n.endswith(".xml"))]
                chunks = [html_text(zf.read(n).decode("utf-8", errors="replace")) for n in names]
            out.write_text("\n".join(chunks), encoding="utf-8")
            return "textified"
        return "未テキスト化"
    except Exception as exc:  # keep all 32 records even for malformed attachments
        return "未テキスト化: " + str(exc)[:300]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("base", type=Path, nargs="?", help="Output directory (contains or receives list.txt)")
    parser.add_argument("--date", help="YYYY-MM-DD; default base = data/notices/<date>")
    parser.add_argument("--list", type=Path, help="Input list file (pipe-separated). Copied/used instead of base/list.txt")
    parser.add_argument("--root", type=Path, default=Path.cwd(), help="Repo root for --date resolution")
    args = parser.parse_args()
    if args.base:
        base = args.base.resolve()
    elif args.date:
        base = (args.root.resolve() / "data" / "notices" / args.date)
    else:
        raise SystemExit("process_notices.py: provide base path or --date")
    raw_dir, txt_dir = base / "raw", base / "txt"
    raw_dir.mkdir(parents=True, exist_ok=True)
    txt_dir.mkdir(parents=True, exist_ok=True)
    list_path = args.list.resolve() if args.list else (base / "list.txt")
    if args.list:
        base.mkdir(parents=True, exist_ok=True)
        if list_path != (base / "list.txt").resolve():
            (base / "list.txt").write_text(list_path.read_text(encoding="utf-8-sig"), encoding="utf-8")
    rows = parse_list(list_path if args.list else base / "list.txt")
    throttle, pdftotext, manifest = Throttler(), find_pdftotext(), []
    for row in rows:
        rec = {**row, "files": [], "status": ""}
        try:
            status, body, ctype = get(row["url"], throttle)
            rec["status"] = f"HTTP {status}"
            if status != 200:
                manifest.append(rec)
                continue
            ext = ext_for(row["url"], ctype, body)
            path = raw_dir / f'{row["no"]}{ext}'
            if ext == ".html":
                source = decode_html(body, ctype)
                path.write_text(source, encoding="utf-8")
            else:
                path.write_bytes(body)
            rec["files"].append({"path": path.name, "url": row["url"], "text_status": textify(path, txt_dir, pdftotext)})
            if ext == ".html":
                for idx, url in enumerate(attachment_links(row["url"], source), 1):
                    s2, b2, c2 = get(url, throttle)
                    if s2 != 200:
                        rec["files"].append({"path": "", "url": url, "text_status": f"HTTP {s2}"})
                        continue
                    ext2 = ext_for(url, c2, b2)
                    child = raw_dir / f'{row["no"]}-a{idx}{ext2}'
                    child.write_bytes(b2)
                    rec["files"].append({"path": child.name, "url": url, "text_status": textify(child, txt_dir, pdftotext)})
        except Exception as exc:
            rec["status"] = "error: " + str(exc)[:500]
        manifest.append(rec)
        print(row["no"], rec["status"], len(rec["files"]), flush=True)
    (base / "fetch-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
