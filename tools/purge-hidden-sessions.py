# purge-hidden-sessions.py  (v2: 台帳 + 常駐ウォッチャー)
# VSCode拡張の「セッション削除」は state.vscdb の hiddenSessionIds に ID を push するだけで
# jsonl 実体は残る。しかも push は read-modify-write なので複数ウィンドウで lost update が起き、
# リストが巻き戻ると削除済みセッションが一覧に復活する（2026-07-10 特定）。
# v1 の SessionStart 発火だけでは間隔が空きすぎ、観測前に巻き戻った ID を取りこぼした（2026-07-11）。
# v2 の対策:
#   1. 台帳 (hidden-sessions-ledger.json): 一度でも hiddenSessionIds で観測した ID を永久記録。
#      以後はリストが巻き戻っても台帳ベースで退避できる。
#   2. 常駐ウォッチャー (--watch): 30秒間隔で DB を観測し、削除クリックを巻き戻り前に捕捉。
#      heartbeat ファイル(PID入り)で単一インスタンス保証。hook からは --start-watcher で
#      「1回パス実行 + ウォッチャー不在なら起動」する。
#   3. /session-close 済み台帳 (closed-sessions.json): 明示的に閉じたセッションは 45 秒後に
#      _closed へ退避する。current-session.json は、それ以外の自動退避で稼働中を守る保険にする。
#
# 使い方:
#   python purge-hidden-sessions.py                  1回パスのみ
#   python purge-hidden-sessions.py --start-watcher  1回パス + ウォッチャー起動保証（hook 用）
#   python purge-hidden-sessions.py --watch          常駐ループ（直接叩かず --start-watcher 経由）
#   python purge-hidden-sessions.py --forget <IDprefix>  台帳から ID を削除（復元時用）
#   -v で詳細表示。ログは purge-hidden-sessions.log に常時追記。
# 安全策: 直近10分以内に更新された jsonl は触らない（書き込み中/稼働中セッション）。DB は read-only。
# 復元は _deleted-backup の jsonl を「新uuidクローン」で戻すこと（同一IDのまま戻すと台帳が再退避する。
# どうしても同一IDで戻すなら先に --forget）。

import sys, os, json, time, shutil, sqlite3, subprocess
from datetime import datetime

VERBOSE = "-v" in sys.argv
HOME = os.path.expanduser("~")
PROJECTS = os.path.join(HOME, ".claude", "projects")
BACKUP = os.path.join(PROJECTS, "_deleted-backup")
LOG = os.path.join(HOME, ".claude", "purge-hidden-sessions.log")
LEDGER = os.path.join(HOME, ".claude", "hidden-sessions-ledger.json")
CLOSED = os.path.join(HOME, ".claude", "closed-sessions.json")
CURRENT = os.path.join(HOME, ".claude", "current-session.json")
CURRENT_SESSIONS = os.path.join(HOME, ".claude", "current-sessions")
HEARTBEAT = os.path.join(HOME, ".claude", "hidden-sessions-watcher.heartbeat")
if sys.platform == "win32":
    DB_DIR = os.path.join(os.environ.get("APPDATA", ""), "Code", "User", "globalStorage")
elif sys.platform == "darwin":
    DB_DIR = os.path.join(HOME, "Library", "Application Support", "Code", "User", "globalStorage")
else:
    DB_DIR = os.path.join(HOME, ".config", "Code", "User", "globalStorage")
SKIP_RECENT_SEC = 600
CLOSED_DEST_TAG = "_closed"
CLOSED_SKIP_RECENT_SEC = 45
WATCH_INTERVAL = 30
HEARTBEAT_STALE = 90

# headless `claude -p`（秘書自動化）が作るセッションの先頭ユーザーメッセージ署名。
# 本来は各 launcher の --no-session-persistence で保存されないが、フラグ付け忘れ・
# フラグ追加前に起動された残党を一覧から自動退避する保険（2026-07-13）。
HEADLESS_SIGS = (
    "あなたはオージャスト代表 kim の秘書",
    "kim@orgiast.jp の Google カレンダー MCP",
)
HEADLESS_DEST_TAG = "_headless"

# 中身が無い「空セッション」の自動退避先（2026-08-18）。
# kim の「Clear を押してもセッションが消えない」の実体はこれ: /clear は
# 「会話をリセットして新しいセッションを始める」コマンドで、履歴の削除ではない。
# 押すたびに /clear の記録だけを持つセッションが 1 件ずつ一覧に増えていた。
# 実発言も応答も無いので情報価値ゼロ → 自動で退避して一覧を汚さない（実体は backup に保全）。
EMPTY_DEST_TAG = "_empty"
EMPTY_MAX_BYTES = 200_000  # 空セッションは数 KB。大きいファイルは読まずに除外（誤退避と I/O 防止）
# 空セッションだけは待ち時間を短くする（2026-08-20 kim「/clear を押しても一覧から消えない・
# 押したか分からず何度も押す」）。実発言・応答が 0 件なので取り違えても失う情報が無く、
# 実体は _deleted-backup に保全されるため 10 分待つ必要がない。稼働中セッション保護には十分な猶予。
EMPTY_SKIP_RECENT_SEC = 90

def log(msg):
    line = f"{datetime.now():%Y-%m-%d %H:%M:%S} {msg}"
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass
    if VERBOSE:
        print(line)

def read_db_hidden(name="state.vscdb"):
    con = sqlite3.connect(f"file:{os.path.join(DB_DIR, name)}?mode=ro", uri=True)
    try:
        row = con.execute(
            "SELECT value FROM ItemTable WHERE key=?", ("Anthropic.claude-code",)
        ).fetchone()
    finally:
        con.close()
    return set(json.loads(row[0]).get("hiddenSessionIds", []))

def load_ledger():
    try:
        return set(json.load(open(LEDGER, encoding="utf-8"))["ids"])
    except Exception:
        return set()

def load_closed():
    try:
        return set(json.load(open(CLOSED, encoding="utf-8"))["ids"])
    except Exception:
        return set()

def drop_closed(sid):
    """退避済みの sid だけを closed-sessions.json から取り除く（read-modify-write の
    lost update を避けるため、必ず直前に読み直してから差し引く。close-session.mjs が
    並行して別 ID を追記していても失わない）。"""
    ids = load_closed()
    if sid not in ids:
        return
    ids.discard(sid)
    tmp = CLOSED + f".tmp{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"ids": sorted(ids)}, f, indent=0)
    os.replace(tmp, CLOSED)

def live_session_ids():
    ids = set()
    paths = []
    if os.path.isdir(CURRENT_SESSIONS):
        try:
            paths = [os.path.join(CURRENT_SESSIONS, name) for name in os.listdir(CURRENT_SESSIONS)
                     if name.endswith(".json")]
        except OSError:
            paths = []
    else:
        paths = [CURRENT]
    for path in paths:
        try:
            current = json.load(open(path, encoding="utf-8"))
            at = datetime.fromisoformat(current["at"].replace("Z", "+00:00")).timestamp()
            if time.time() - at < SKIP_RECENT_SEC:
                ids.add(current["sessionId"])
        except Exception:
            pass
    return ids

def save_ledger(ids):
    tmp = LEDGER + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"ids": sorted(ids)}, f, indent=0)
    os.replace(tmp, LEDGER)

def first_user_text(path, max_lines=60):
    """jsonl の先頭ユーザーメッセージ本文を返す（見つからなければ None）。先頭数十行のみ読む。"""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for i, line in enumerate(f):
                if i >= max_lines:
                    break
                try:
                    o = json.loads(line)
                except ValueError:
                    continue
                if o.get("type") == "user":
                    c = o.get("message", {}).get("content")
                    if isinstance(c, list):
                        c = " ".join(x.get("text", "") for x in c if isinstance(x, dict))
                    if isinstance(c, str) and c.strip():
                        return c.lstrip("﻿").strip()
    except OSError:
        pass
    return None

def is_empty_session(path):
    """実ユーザー発言と assistant 応答がどちらも 0 件の空セッションか。

    /clear やスラッシュコマンドの記録 (<local-command-caveat> / <command-name> 等) は
    「発言」に数えない。1 件でも実発言か応答が見つかった時点で False を返す（早期打ち切り）。
    """
    try:
        if os.path.getsize(path) > EMPTY_MAX_BYTES:
            return False
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    o = json.loads(line)
                except ValueError:
                    continue
                t = o.get("type")
                if t not in ("user", "assistant"):
                    continue
                c = o.get("message", {}).get("content") if isinstance(o.get("message"), dict) else None
                if isinstance(c, list):
                    c = " ".join(x.get("text", "") for x in c if isinstance(x, dict))
                if not isinstance(c, str) or not c.strip():
                    continue
                if t == "assistant":
                    return False
                if not any(m in c for m in ("<local-command-caveat>", "<command-name>", "<command-message>")):
                    return False  # 実ユーザー発言がある = 空ではない
    except OSError:
        return False
    return True

def backup_dir_ids():
    ids = set()
    if not os.path.isdir(BACKUP):
        return ids
    for proj in os.listdir(BACKUP):
        pd = os.path.join(BACKUP, proj)
        if os.path.isdir(pd):
            for name in os.listdir(pd):
                sid = name.split(".jsonl")[0].split(".dup")[0]
                if len(sid) == 36:
                    ids.add(sid)
    return ids

def run_pass(state):
    """DB観測→台帳マージ→台帳ベースで退避。state は watch ループで重複ログを抑止する dict。"""
    try:
        observed = read_db_hidden()
        if state.get("db_err"):
            state["db_err"] = None
    except Exception as e:
        if str(e) != state.get("db_err"):
            log(f"SKIP: state.vscdb 読めず ({e})")
            state["db_err"] = str(e)
        observed = set()

    ledger = load_ledger() | observed | backup_dir_ids()
    if ledger != load_ledger():
        save_ledger(ledger)
    closed = load_closed()
    if not ledger and not closed:
        return 0

    now = time.time()
    moved = 0
    live_sids = live_session_ids()

    def archive(proj, sid, dest_root, tag):
        dest_dir = os.path.join(dest_root, proj)
        os.makedirs(dest_dir, exist_ok=True)
        did = False
        for name in (sid + ".jsonl", sid):  # 本体 + subagents フォルダ
            s = os.path.join(PROJECTS, proj, name)
            if not os.path.exists(s):
                continue
            d = os.path.join(dest_dir, name)
            n = 1
            while os.path.exists(d):
                d = os.path.join(dest_dir, f"{name}.dup{n}")
                n += 1
            try:
                shutil.move(s, d)
                log(f"MOVED[{tag}]: {proj}/{name}")
                did = True
            except OSError as e:
                log(f"FAIL: {proj}/{name} ({e})")
        return did

    for proj in os.listdir(PROJECTS):
        pd = os.path.join(PROJECTS, proj)
        if not os.path.isdir(pd) or proj.startswith("_"):
            continue
        # (0) /session-close 済み（ユーザーが明示的に閉じたセッション）
        for sid in set(closed):
            src = os.path.join(pd, sid + ".jsonl")
            if not os.path.exists(src) or now - os.path.getmtime(src) < CLOSED_SKIP_RECENT_SEC:
                continue
            if archive(proj, sid, os.path.join(BACKUP, CLOSED_DEST_TAG), "closed"):
                moved += 1
                closed.discard(sid)
                drop_closed(sid)
        # (1) 台帳/hidden ベースの退避（ユーザーが削除したセッション）
        for sid in ledger:
            if sid in closed or sid in live_sids:
                continue
            src = os.path.join(pd, sid + ".jsonl")
            if not os.path.exists(src):
                state["skips"].discard((proj, sid))
                continue
            skip_recent_sec = EMPTY_SKIP_RECENT_SEC if is_empty_session(src) else SKIP_RECENT_SEC
            if now - os.path.getmtime(src) < skip_recent_sec:
                if (proj, sid) not in state["skips"]:
                    log(f"SKIP(直近更新): {proj}/{sid}")
                    state["skips"].add((proj, sid))
                continue
            state["skips"].discard((proj, sid))
            if archive(proj, sid, BACKUP, "hidden"):
                moved += 1
        # (2) headless 署名ベースの退避（--no-session-persistence 付け忘れ/フラグ前の残党）
        hdest = os.path.join(BACKUP, HEADLESS_DEST_TAG)
        for f in os.listdir(pd):
            if not f.endswith(".jsonl"):
                continue
            sid = f[:-6]
            if sid in ledger or sid in closed:
                continue  # (1) で処理済み
            if sid in live_sids:
                continue
            src = os.path.join(pd, f)
            age = now - os.path.getmtime(src)
            if age < EMPTY_SKIP_RECENT_SEC:
                continue  # 書き込み直後（＝稼働中の可能性）は一切触らない
            if age < SKIP_RECENT_SEC:
                # (3-fast) 空セッション（/clear のスタブ等）だけは 90 秒で退避し一覧を汚さない。
                if is_empty_session(src):
                    if archive(proj, sid, os.path.join(BACKUP, EMPTY_DEST_TAG), "empty"):
                        moved += 1
                continue  # 実行中の headless セッションは触らない
            fu = first_user_text(src)
            if fu and any(fu.startswith(s) for s in HEADLESS_SIGS):
                if archive(proj, sid, hdest, "headless"):
                    moved += 1
                continue
            # (3) 空セッション（/clear の記録だけ 等）を退避。一覧を汚すだけで中身が無い。
            if is_empty_session(src):
                if archive(proj, sid, os.path.join(BACKUP, EMPTY_DEST_TAG), "empty"):
                    moved += 1
    if moved:
        log(f"done: {moved} sessions -> _deleted-backup")
    return moved

def heartbeat_pid():
    try:
        if time.time() - os.path.getmtime(HEARTBEAT) < HEARTBEAT_STALE:
            return int(open(HEARTBEAT).read().strip())
    except (OSError, ValueError):
        pass
    return None

def watch():
    mypid = os.getpid()
    state = {"skips": set(), "db_err": None}
    log(f"watcher start (pid={mypid})")
    while True:
        other = heartbeat_pid()
        if other is not None and other != mypid:
            log(f"watcher exit: 別インスタンス稼働中 (pid={other})")
            return
        with open(HEARTBEAT, "w") as f:
            f.write(str(mypid))
        run_pass(state)
        time.sleep(WATCH_INTERVAL)

def spawn_watcher():
    exe = sys.executable
    if os.name == "nt":
        pyw = os.path.join(os.path.dirname(exe), "pythonw.exe")
        if os.path.exists(pyw):
            exe = pyw
        base = 0x08000000 | 0x00000200  # CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
        for flags in (base | 0x01000000, base):  # まず BREAKAWAY_FROM_JOB を試す（hook の job 巻き添え死回避）
            try:
                subprocess.Popen(
                    [exe, os.path.abspath(__file__), "--watch"],
                    creationflags=flags, close_fds=True,
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                )
                return True
            except OSError:
                continue
        return False
    try:
        subprocess.Popen(
            [exe, os.path.abspath(__file__), "--watch"],
            start_new_session=True, close_fds=True,
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        return True
    except OSError:
        return False

def main():
    if "--forget" in sys.argv:
        prefix = sys.argv[sys.argv.index("--forget") + 1]
        ledger = load_ledger()
        hit = {i for i in ledger if i.startswith(prefix)}
        save_ledger(ledger - hit)
        print(f"forgot {len(hit)}: {sorted(hit)}")
        return
    if "--watch" in sys.argv:
        if heartbeat_pid() is not None:
            return
        watch()
        return
    run_pass({"skips": set(), "db_err": None})
    if "--start-watcher" in sys.argv and heartbeat_pid() is None:
        ok = spawn_watcher()
        log(f"watcher spawn {'OK' if ok else 'FAIL'}")

if __name__ == "__main__":
    main()
