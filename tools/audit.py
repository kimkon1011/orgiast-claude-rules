#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Claude 利用コスト監査 (Python3 標準ライブラリのみ / クロスプラットフォーム版)
audit.ps1 (Windows PowerShell 版) と同一挙動。Mac / Linux / Windows のどれでも
`python3 audit.py` 一発で実行できる。

ローカルの Claude Code 記録 (~/.claude/projects/**/*.jsonl) を解析し、
「開発(cwd)別に どのモデルで 何トークン 推定いくら」+ 設定監査 を算出する。

── データの扱い（透明性・重要）───────────────────────────
● 送信するのは【集計値のみ】:
    cwdフォルダ名 / モデル別トークン数 / 推定$ / 設定値(effort・既定model・hooks数・CLAUDE.md行数) / Fable5使用有無
● 【送信しないもの】: 会話本文・コード・認証情報・顧客/社内データ・.jsonl本文は
    読み出して送信することは一切ない（トークン"数"だけ数える。中身は送らない）。
● 送信先: --webhook で明示した URL のみ。既定は空＝どこにも送らない。
● まず必ず --dry-run で「送信される内容そのもの」を画面確認できる。全行レビュー可(約300行)。
  → 盲目実行しないこと。中身を読み、--dry-run で確認し、送信先が社内正規か確かめてから使う。
─────────────────────────────────────────────────────

  python3 audit.py --dry-run                 # 送信せず画面表示のみ(まずこれで中身確認)
  python3 audit.py --webhook "<社内URL>"      # 集計値を指定先へ送信

推定$は Anthropic API 定価換算の「目安」(サブスク実額とは別)。開発間の比較用。
"""

import argparse
import json
import os
import re
import sys
import urllib.request
import urllib.error
from datetime import datetime, timedelta, timezone

# --- 正規表現 (audit.ps1 と同一パターン) ---
RE_TIMESTAMP = re.compile(r'"timestamp":"([^"]+)"')
RE_CWD = re.compile(r'"cwd":"([^"]+)"')
RE_MODEL = re.compile(r'"model":"(claude-[^"]+)"')
RE_INPUT = re.compile(r'"input_tokens":(\d+)')
RE_OUTPUT = re.compile(r'"output_tokens":(\d+)')
RE_CACHE_CREATE = re.compile(r'"cache_creation_input_tokens":(\d+)')
RE_CACHE_READ = re.compile(r'"cache_read_input_tokens":(\d+)')

# pricing USD / 1M tokens : in, out (cache_read=in*0.10, cache_creation=in*1.25)
PRICING = {
    "opus":   {"i": 5.0,  "o": 25.0},
    "sonnet": {"i": 3.0,  "o": 15.0},
    "haiku":  {"i": 1.0,  "o": 5.0},
    "fable":  {"i": 10.0, "o": 50.0},
    "other":  {"i": 3.0,  "o": 15.0},
}


def model_class(m):
    if not m:
        return "other"
    if "opus" in m:
        return "opus"
    if "sonnet" in m:
        return "sonnet"
    if "haiku" in m:
        return "haiku"
    if "fable" in m or "mythos" in m:
        return "fable"
    return "other"


def parse_timestamp(ts):
    """ISO8601 timestamp (Z / +00:00 いずれも可) を aware datetime に変換。"""
    ts = ts.strip()
    try:
        if ts.endswith("Z"):
            ts = ts[:-1] + "+00:00"
        dt = datetime.fromisoformat(ts)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


def env_home_claude():
    home = os.path.expanduser("~")
    return os.path.join(home, ".claude")


def collect(days, quiet):
    """~/.claude/projects 配下の *.jsonl を走査して cwd 別に集計する。"""
    claude_dir = env_home_claude()
    projects_dir = os.path.join(claude_dir, "projects")

    by_cwd = {}
    grand = 0.0
    fable_cost = 0.0
    cutoff = None
    if days > 0:
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)

    env_missing = False
    jsonl_count = 0

    if not os.path.isdir(projects_dir):
        env_missing = True
        return by_cwd, grand, fable_cost, env_missing, jsonl_count

    for entry in sorted(os.listdir(projects_dir)):
        dpath = os.path.join(projects_dir, entry)
        if not os.path.isdir(dpath):
            continue
        last_cwd = entry
        for fname in sorted(os.listdir(dpath)):
            if not fname.endswith(".jsonl"):
                continue
            fpath = os.path.join(dpath, fname)
            jsonl_count += 1
            try:
                with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                    for line in f:
                        if '"usage"' not in line:
                            continue
                        if cutoff is not None:
                            m = RE_TIMESTAMP.search(line)
                            if m:
                                dt = parse_timestamp(m.group(1))
                                if dt is not None and dt < cutoff:
                                    continue
                        m = RE_CWD.search(line)
                        if m:
                            last_cwd = m.group(1).replace("\\\\", "\\")
                        key = last_cwd
                        mm = RE_MODEL.search(line)
                        model = mm.group(1) if mm else ""
                        cls = model_class(model)

                        mi = RE_INPUT.search(line)
                        mo = RE_OUTPUT.search(line)
                        mcc = RE_CACHE_CREATE.search(line)
                        mcr = RE_CACHE_READ.search(line)
                        i = int(mi.group(1)) if mi else 0
                        o = int(mo.group(1)) if mo else 0
                        cc = int(mcc.group(1)) if mcc else 0
                        cr = int(mcr.group(1)) if mcr else 0

                        pr = PRICING[cls]
                        c = (i * pr["i"] + cc * pr["i"] * 1.25 + cr * pr["i"] * 0.10 + o * pr["o"]) / 1e6

                        # PowerShell のハッシュテーブルは既定で大文字小文字を区別しない
                        # (audit.ps1 の $byCwd と同一挙動にするため casefold でグルーピング。
                        #  表示名は最初に見たオリジナルの表記を保持する)
                        dict_key = key.casefold()
                        if dict_key not in by_cwd:
                            by_cwd[dict_key] = {"display": key, "cost": 0.0, "tok": 0, "models": set()}
                        b = by_cwd[dict_key]
                        b["cost"] += c
                        b["tok"] += (i + o + cc + cr)
                        if model:
                            b["models"].add(cls)
                        grand += c
                        if cls == "fable":
                            fable_cost += c
            except (OSError, IOError):
                continue

    return by_cwd, grand, fable_cost, env_missing, jsonl_count


def audit_settings(claude_dir):
    """~/.claude/settings.json と ~/.claude/CLAUDE.md の設定監査。"""
    effort = "未設定"
    def_model = "未設定(=Opus常用)"
    hooks = 0
    sf = os.path.join(claude_dir, "settings.json")
    if os.path.isfile(sf):
        try:
            with open(sf, "r", encoding="utf-8") as f:
                s = json.load(f)
            if s.get("effortLevel"):
                effort = s["effortLevel"]
            if s.get("model"):
                def_model = s["model"]
            if isinstance(s.get("hooks"), dict):
                for v in s["hooks"].values():
                    if isinstance(v, list):
                        hooks += len(v)
                    elif v is not None:
                        hooks += 1
        except Exception:
            pass
    else:
        effort = "(settings.jsonなし)"
        def_model = "-"

    cm_lines = 0
    cm_kb = 0
    cf = os.path.join(claude_dir, "CLAUDE.md")
    if os.path.isfile(cf):
        try:
            with open(cf, "r", encoding="utf-8", errors="ignore") as f:
                cm_lines = sum(1 for _ in f)
            cm_kb = round(os.path.getsize(cf) / 1024)
        except Exception:
            pass

    return effort, def_model, hooks, cm_lines, cm_kb


def user_label(label):
    if label:
        return label
    try:
        import subprocess
        r = subprocess.run(["git", "config", "user.email"], capture_output=True, text=True, timeout=5)
        email = r.stdout.strip()
        if email:
            return email
    except Exception:
        pass
    user = os.environ.get("USER") or os.environ.get("USERNAME") or "unknown"
    host = os.environ.get("COMPUTERNAME") or os.environ.get("HOSTNAME") or ""
    if not host:
        try:
            import socket
            host = socket.gethostname()
        except Exception:
            host = "unknown-host"
    return f"{user}@{host}"


def build_report(args, claude_dir):
    by_cwd, grand, fable_cost, env_missing, jsonl_count = collect(args.days, args.quiet)

    env_note = None
    if env_missing or jsonl_count == 0:
        env_note = (
            "このPCではClaude Code CLIの記録が見つかりません"
            "（claude.aiチャットで実行された可能性）。"
            "Claude Codeを使っていなければ $0 で正常です。"
        )

    rows = []
    for b in by_cwd.values():
        display = b["display"]
        parts = [p for p in re.split(r"[\\/]", display) if p]
        short = "\\".join(parts[-2:]) if parts else display
        rows.append({
            "project": short,
            "cost": b["cost"],
            "models": "+".join(sorted(b["models"])),
        })
    rows.sort(key=lambda r: r["cost"], reverse=True)

    effort, def_model, hooks, cm_lines, cm_kb = audit_settings(claude_dir)

    name = user_label(args.label)

    lines = []
    win = f"直近{args.days}日" if args.days > 0 else "全期間"
    lines.append(f"**💻 Claude利用監査: {name}** ({win})")
    lines.append(f"推定合計(ローカルCLI): **${round(grand, 2)}** ※API定価換算の目安・比較用")
    lines.append(
        f"設定: effort=**{effort}** / 既定model=**{def_model}** / "
        f"CLAUDE.md={cm_lines}行/{cm_kb}KB / hooks={hooks}"
    )
    if fable_cost > 0:
        lines.append(f"⚠️ Fable5使用 推定${round(fable_cost, 2)} (§1.16 全面禁止)")
    if env_note:
        lines.append(f"ℹ️ {env_note}")

    lines.append("__開発別 推定コスト TOP8__")
    n = 0
    for r in rows:
        if n >= 8:
            break
        label = f"開発#{n + 1}" if args.redact else r["project"]
        lines.append(f"- {label}: ${round(r['cost'], 2)} [{r['models']}]")
        n += 1

    flags = []
    if effort == "xhigh":
        flags.append("effort=xhigh→high")
    if "未設定" in def_model:
        flags.append("既定model→sonnet")
    if cm_lines > 200:
        flags.append(f"CLAUDE.md圧縮({cm_lines}行)")
    if fable_cost > 0:
        flags.append("Fable5停止")
    if flags:
        lines.append("__要改善__: " + " / ".join(flags))

    report = "\n".join(lines).rstrip()
    return report, grand, env_note


def _fix_windows_console_encoding():
    """Windows のコンソールが cp932 等の場合、絵文字/日本語 print で落ちるのを防ぐ。"""
    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        if stream is None:
            continue
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def main():
    _fix_windows_console_encoding()
    parser = argparse.ArgumentParser(
        description="Claude 利用コスト監査 (cross-platform Python版)"
    )
    parser.add_argument("--dry-run", action="store_true", help="送信せず画面表示のみ")
    parser.add_argument("--days", type=int, default=30, help="直近N日で集計 (0=全期間, 既定30)")
    parser.add_argument("--webhook", type=str, default="", help="投稿先 Discord webhook URL")
    parser.add_argument("--label", type=str, default="", help="利用者名 (未指定なら git user.email → user@host)")
    parser.add_argument("--redact", action="store_true", help="開発(cwd)名を「開発#N」に伏せて送る")
    parser.add_argument(
        "--interval-hours", type=int, default=0,
        help="前回投稿からこの時間内は何もせず終了 (定期監視フック用スロットル)",
    )
    parser.add_argument("--quiet", action="store_true", help="画面出力を抑制 (フック常駐用)")
    args = parser.parse_args()

    claude_dir = env_home_claude()
    heartbeat = os.path.join(claude_dir, "cost-monitor-last.txt")

    # --- 間隔スロットル (定期監視フック用) ---
    if args.interval_hours > 0 and os.path.isfile(heartbeat):
        try:
            with open(heartbeat, "r", encoding="utf-8") as f:
                last_raw = f.read().strip()
            last = datetime.fromisoformat(last_raw.replace("Z", "+00:00"))
            if last.tzinfo is None:
                last = last.replace(tzinfo=timezone.utc)
            elapsed_hours = (datetime.now(timezone.utc) - last).total_seconds() / 3600.0
            if elapsed_hours < args.interval_hours:
                if not args.quiet:
                    print(f"throttled: 前回から {round(elapsed_hours, 1)}h (間隔 {args.interval_hours}h 未満) — skip")
                return
        except Exception:
            pass

    report, grand, env_note = build_report(args, claude_dir)

    if not args.quiet:
        print(report)

    if not args.dry_run:
        if not args.webhook:
            print("エラー: 投稿先 --webhook '<URL>' が未指定です（--dry-run なら表示のみ）。", file=sys.stderr)
            sys.exit(1)
        payload = json.dumps({"content": report}, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            args.webhook,
            data=payload,
            headers={"Content-Type": "application/json; charset=utf-8"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                resp.read()
        except urllib.error.URLError as e:
            print(f"webhook POST失敗: {e}", file=sys.stderr)
            sys.exit(1)
        with open(heartbeat, "w", encoding="utf-8") as f:
            f.write(datetime.now(timezone.utc).isoformat())
        if not args.quiet:
            print("")
            print("(Discord #claude-code に投稿しました)")


if __name__ == "__main__":
    main()
