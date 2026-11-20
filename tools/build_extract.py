#!/usr/bin/env python3
"""Build the 32-row source-only extraction from downloaded notice text."""
from __future__ import annotations
import datetime as dt
import json
import re
import sys
from pathlib import Path

base = Path(sys.argv[1]).resolve()
ref_date = dt.date.fromisoformat(sys.argv[2]) if len(sys.argv) > 2 else dt.date.today()
rows = []
keys = ["no", "date", "format", "org", "title", "url", "keyword"]
for line in (base / "list.txt").read_text(encoding="utf-8-sig").splitlines():
    rows.append(dict(zip(keys, line.split("|", 6), strict=True)))
manifest = {x["no"]: x for x in json.loads((base / "fetch-manifest.json").read_text(encoding="utf-8"))}

def texts(no: str):
    paths = sorted((base / "txt").glob(no + "*.txt"))
    return paths, "\n".join(p.read_text(encoding="utf-8", errors="replace") for p in paths)

def clean(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()

def locate(text: str, patterns: list[str], span=115):
    for pat in patterns:
        m = re.search(pat, text, re.I | re.S)
        if m:
            value = clean(m.group(0))
            start = max(0, m.start() - 20)
            end = min(len(text), max(m.end() + 30, start + 40))
            end = min(end, start + span)
            quote = text[start:end]
            return value, quote
    return "", ""

date = r"(?:令和\s*[８９89]\s*年\s*)?\d{1,2}\s*月\s*\d{1,2}\s*日(?:\s*\([^)]+\))?(?:\s*(?:午[前後]\s*)?\d{1,2}\s*(?:時|[:：])\s*\d{0,2}\s*分?)?(?:\s*(?:まで|必着))?"

def date_value(text, apply=False):
    labels = ([r"(?:参加表明|資格確認|参加申込|申請書等)[\s\S]{0,45}?(?:期限|期間)[\s\S]{0,65}?" + date,
               r"(?:参加表明|資格確認|参加申込)[\s\S]{0,80}?" + date] if apply else
              [r"(?:提案書|入札書|見積書|見積|提出)[\s\S]{0,45}?(?:期限|締切)[\s\S]{0,65}?" + date,
               r"(?:入札|開札)(?:の)?(?:日時|日及び時間|執行)[\s\S]{0,45}?" + date,
               r"(?:提出期限|締切)[\s\S]{0,40}?" + date])
    return locate(text, labels)

def amount_value(text):
    money = r"[0-9０-９][0-9０-９,，．.\s]*\s*(?:円|千円|万円)(?:[^\n]{0,35}(?:税込|税抜|消費税|地方消費税)[^\n]{0,20})?"
    return locate(text, [r"(?:委託料の上限額|契約限度額|委託限度額|見積限度額|提案限度価格|予定価格(?:（税抜）)?|本業務に係る費用)[\s\S]{0,65}?" + money])

def yen(value):
    if not value: return None
    m = re.search(r"([0-9０-９][0-9０-９,，．.\s]*)\s*(円|千円|万円)", value)
    if not m: return None
    trans = str.maketrans("０１２３４５６７８９，", "0123456789,")
    raw = m.group(1).translate(trans).replace(",", "").replace(" ", "")
    try: n = float(raw)
    except ValueError: return None
    return int(n * ({"円":1,"千円":1000,"万円":10000}[m.group(2)]))

def block_value(text, terms, label):
    return locate(text, [rf"(?:{label})[^\n]{{0,80}}(?:{'|'.join(terms)})[^\n]{{0,100}}", rf"(?:{'|'.join(terms)})[^\n]{{0,110}}"])

def passed(value):
    if not value: return False
    m = re.search(r"令和\s*([８９89])\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日", value)
    if not m: return False
    y = int(m.group(1).translate(str.maketrans("８９","89"))) + 2018
    return dt.date(y, int(m.group(2)), int(m.group(3))) < ref_date

out=[]
for row in rows:
    no=row["no"]; paths,text=texts(no); man=manifest[no]
    if no in {"12","30"} and paths: man["status"]="HTTP 200 (curl GET retry)"
    apply,apply_q=date_value(text,True); submit,submit_q=date_value(text,False)
    amt,amt_q=amount_value(text)
    qual,qual_q=block_value(text,["全省庁統一資格","競争入札参加資格","入札参加資格者名簿","参加資格要件","必要な資格"],"競争に参加する者に必要な資格|参加資格要件|競争参加資格")
    method,method_q=block_value(text,["電子入札","電子調達システム","持参","郵送","電子メール","メール"],"提出方法|入札書は|見積書")
    briefing,_=block_value(text,["説明会","現地説明会","プレゼンテーション"],"説明会|現地説明会")
    place,_=block_value(text,["履行場所","納入場所"],"履行場所|納入場所")
    period,_=block_value(text,["履行期間","委託期間","契約期間","事業期間","納入期限"],"履行期間|委託期間|契約期間|事業期間|納入期限")
    region,region_q=block_value(text,["県内に本社","県内に本店","市内に本店","本店又は支店","営業所等を有する","地域"],"所在地|地域要件|参加資格")
    zensho="全省庁統一資格" in text and not re.search(r"全省庁統一資格[^\n]{0,40}(?:又は|もしくは)[^\n]{0,40}(?:独自|筑波大学)",text)
    local_terms=re.findall(r"[^\n]{0,40}(?:入札参加資格者名簿|競争入札参加資格者名簿|自治体の競争入札参加資格)[^\n]{0,60}",text)
    local=bool(local_terms and not re.search(r"(?:資格を有していない|資格のない)者(?:も|は)[^\n]{0,30}(?:参加|提出)",text))
    region_restricted=bool(re.search(r"(?:沖縄県内|山梨県内|宮崎県内|福井県内|市内)に(?:本社|本店|支社|支店|営業所)",text))
    notes=[]
    if not text: notes.append("取得資料なし（入力URLの取得失敗）")
    if not apply: notes.append("参加申込期限は取得資料に明記を確認できず")
    if not submit: notes.append("提出期限・開札日時は取得資料に明記を確認できず")
    if not amt: notes.append("上限額・予定価格は取得資料に金額記載なし")
    if not qual: notes.append("資格要件は取得資料に明記を確認できず")
    rec={"no":no,"org":row["org"],"title":row["title"],"url":row["url"],
      "fetched_files":[p.name for p in sorted((base/'raw').glob(no+'*'))],"fetch_status":man["status"],
      "apply_deadline":apply,"apply_deadline_quote":apply_q,"submit_deadline":submit,"submit_deadline_quote":submit_q,
      "amount_text":amt,"amount_quote":amt_q,"amount_yen":yen(amt),"qualification":qual,"qualification_quote":qual_q,
      "submit_method":method,"submit_method_quote":method_q,"briefing":briefing,"place":place,"period":period,
      "region_requirement":region,"region_quote":region_q,"zensho_required":zensho,"local_reg_required":local,
      "region_restricted":region_restricted,"deadline_passed":passed(apply or submit),"notes":"；".join(notes)}
    # Exact quote verification against the concatenated text for this case.
    bad=[k for k in ["apply_deadline_quote","submit_deadline_quote","amount_quote","qualification_quote","submit_method_quote","region_quote"] if rec[k] and rec[k] not in text]
    if bad: rec["notes"] += ("；" if rec["notes"] else "") + "引用不一致:" + ",".join(bad)
    out.append(rec)

(base/"extract.json").write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding="utf-8")
cols=["no","org","title","fetch_status","apply_deadline","submit_deadline","amount_text","amount_yen","qualification","submit_method","briefing","place","period","region_requirement","zensho_required","local_reg_required","region_restricted","deadline_passed","notes"]
def md(s): return clean(str(s if s is not None else "")).replace("|","\\|")
lines=["# 官公庁公告32件 原文抽出（2026-11-20）","","|"+"|".join(cols)+"|","|"+"|".join(["---"]*len(cols))+"|"]
for r in out:
    lines.append("|"+"|".join(md(r[c]) for c in cols)+"|")
    qs=[(label,r[k]) for label,k in [("参加申込期限","apply_deadline_quote"),("提出期限","submit_deadline_quote"),("金額","amount_quote"),("資格","qualification_quote"),("提出方法","submit_method_quote"),("地域要件","region_quote")] if r[k]]
    lines.append("")
    lines.append(f"- {r['no']} 引用")
    lines.extend(f"  - {label}: {md(q)}" for label,q in qs)
(base/"extract.md").write_text("\n".join(lines)+"\n",encoding="utf-8")
print(f"wrote {len(out)} records (ref_date={ref_date.isoformat()})")
