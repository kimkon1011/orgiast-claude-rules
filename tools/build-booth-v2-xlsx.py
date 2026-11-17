from pathlib import Path
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter

SOURCE = Path(r"C:\Users\USER\terminals\gb-r-1300-booth-list.md")
OUTPUT = Path(r"C:\Users\USER\terminals\gb-r-1300-booth-list-v2.xlsx")
DOC = Path(r"C:\Users\USER\terminals\gb-r-1300-booth-email.md")
SECTIONS = ["展示会15件", "出展企業50社", "過去実績と選定理由", "メール下書き"]

def section(text, name):
    marker = f"## {name}"
    start = text.index(marker) + len(marker)
    end = text.find("\n## ", start)
    return text[start:] if end < 0 else text[start:end]

def table_rows(body):
    lines = [line.strip() for line in body.splitlines() if line.strip().startswith("|")]
    rows = [[cell.strip().replace("<br>", "\n") for cell in line.strip("|").split("|")] for line in lines]
    return [rows[0], *rows[2:]]

text = SOURCE.read_text(encoding="utf-8-sig")
wb = Workbook()
wb.remove(wb.active)
for name in SECTIONS[:3]:
    ws = wb.create_sheet(name)
    rows = table_rows(section(text, name))
    for row in rows:
        ws.append(row)
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = ws.dimensions
    for cell in ws[1]:
        cell.font = Font(bold=True)
        cell.fill = PatternFill("solid", fgColor="E7E6E6")
        cell.alignment = Alignment(wrap_text=True, vertical="top")
    for row in ws.iter_rows(min_row=2):
        for cell in row:
            cell.alignment = Alignment(wrap_text=True, vertical="top")
    for idx in range(1, ws.max_column + 1):
        max_len = max(len(str(ws.cell(r, idx).value or "")) for r in range(1, min(ws.max_row, 30) + 1))
        ws.column_dimensions[get_column_letter(idx)].width = min(max(max_len + 2, 12), 42)

email = section(text, "メール下書き").strip()
DOC.write_text(email + "\n", encoding="utf-8")
ws = wb.create_sheet("メール下書き")
for line in email.splitlines():
    ws.append([line])
ws.freeze_panes = "A2"
ws["A1"].font = Font(bold=True)
ws["A1"].fill = PatternFill("solid", fgColor="E7E6E6")
ws.column_dimensions["A"].width = 120
for row in ws.iter_rows():
    row[0].alignment = Alignment(wrap_text=True, vertical="top")

wb.save(OUTPUT)
check = load_workbook(OUTPUT, read_only=True)
print(f"xlsx={OUTPUT}")
for ws in check.worksheets:
    print(f"{ws.title}: rows={ws.max_row} cols={ws.max_column}")
print(f"doc_source={DOC}")
