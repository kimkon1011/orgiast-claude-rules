import fs from 'node:fs';

const p = 'C:/Users/user/.claude/projects/d--Claude-CLAUDE-md--/473b4c79-130e-4925-abf4-09c7f311a3dc.jsonl';
const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
const out = [];
for (let i = 0; i < lines.length; i++) {
  let o;
  try { o = JSON.parse(lines[i]); } catch { continue; }
  const t = o.type;
  if (t === 'user' || t === 'assistant') {
    const msg = o.message || {};
    const content = msg.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      for (const c of content) {
        if (c.type === 'text') text += c.text + '\n';
        else if (c.type === 'tool_use') text += `[tool_use ${c.name}] ` + JSON.stringify(c.input).slice(0, 400) + '\n';
        else if (c.type === 'tool_result') {
          let r = c.content;
          if (Array.isArray(r)) r = r.map(x => x.text || '').join(' ');
          text += '[tool_result] ' + String(r).slice(0, 300) + '\n';
        }
      }
    }
    out.push(`===== ${i} ${t} =====\n${text.slice(0, 2500)}`);
  }
}
fs.writeFileSync('C:/Users/user/.claude/nightly-repo/.tmp-session-digest.txt', out.join('\n'), 'utf8');
console.log('lines', lines.length, 'events', out.length);
