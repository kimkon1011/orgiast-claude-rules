import fs from 'fs';

const lines = fs.readFileSync('C:\\Users\\kimko\\.claude\\projects\\C--Users-kimko--claude-quota-sweep-repo\\8e505853-54c1-4ee7-8315-246085a9d57d.jsonl', 'utf-8').split('\n');

const out = [];
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (!line.trim()) continue;
  let d;
  try { d = JSON.parse(line); } catch { continue; }
  const typ = d.type;
  if (typ === 'user' || typ === 'assistant') {
    const msg = d.message || {};
    const content = msg.content;
    let text = '';
    if (Array.isArray(content)) {
      text = content.filter(c => c && c.type === 'text').map(c => c.text || '').join(' | ');
    } else if (typeof content === 'string') {
      text = content;
    }
    out.push(`=== ${i} ${typ} ===\n${text.slice(0, 2500)}`);
  }
}

fs.writeFileSync('C:\\Users\\kimko\\.claude\\quota-sweep-repo\\_transcript_dump.txt', out.join('\n\n'), 'utf-8');
console.log('written', out.length, 'messages');
