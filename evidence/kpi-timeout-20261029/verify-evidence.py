from pathlib import Path
import re
logs = Path('/mnt/c/Users/uers/.claude/logs')
evidence = Path(__file__).parent
for name in ['bootstrap-window.txt', 'kpi-output.txt']:
    for row in (evidence / name).read_text().splitlines():
        file, line, content = re.match(r'([^:]+):(\d+): (.*)', row).groups()
        assert (logs / file).read_text(encoding='utf-8-sig').splitlines()[int(line)-1] == content
    print('PASS', name)
for p in logs.glob('nightly-bootstrap-2026-10-28.*.log'):
    assert not any('2026-10-28 07:' in l and '07:00:00' <= l[11:19] <= '07:40:00' for l in p.read_text(encoding='utf-8-sig').splitlines())
print('PASS fallback window empty')
print('pass=3 fail=0')
