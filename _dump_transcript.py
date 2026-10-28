import json

with open(r'C:\Users\kimko\.claude\projects\C--Users-kimko--claude-quota-sweep-repo\8e505853-54c1-4ee7-8315-246085a9d57d.jsonl', encoding='utf-8') as f:
    lines = f.readlines()

out = []
for i, line in enumerate(lines):
    try:
        d = json.loads(line)
    except Exception:
        continue
    typ = d.get('type')
    if typ in ('user', 'assistant'):
        msg = d.get('message', {})
        content = msg.get('content')
        text = ''
        if isinstance(content, list):
            texts = [c.get('text', '') for c in content if isinstance(c, dict) and c.get('type') == 'text']
            text = ' | '.join(texts)
        elif isinstance(content, str):
            text = content
        out.append(f'=== {i} {typ} ===\n{text[:2500]}')

with open(r'C:\Users\kimko\.claude\quota-sweep-repo\_transcript_dump.txt', 'w', encoding='utf-8') as f:
    f.write('\n\n'.join(out))
print('written', len(out), 'messages')
