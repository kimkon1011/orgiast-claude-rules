import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

// Inspect the real transcript, not its mtime (title/hooks can change mtime).
export async function sessionEvidence(home, ids) {
  const root = path.join(home, '.claude', 'projects'), files = new Map();
  if (fs.existsSync(root)) for (const project of fs.readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory() || project.name.startsWith('_')) continue;
    for (const id of ids) {
      const file = path.join(root, project.name, `${id}.jsonl`);
      if (fs.existsSync(file)) {
        const previous = files.get(id);
        if (!previous || fs.statSync(file).mtimeMs > fs.statSync(previous).mtimeMs) files.set(id, file);
      }
    }
  }
  const result = new Map();
  for (const [id, file] of files) {
    let latest = null;
    const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (!['assistant', 'user'].includes(event.type)) continue;
      const content = event.message?.content;
      const text = typeof content === 'string' ? content : (content || []).filter(p => p.type === 'text').map(p => p.text).join('\n');
      if (!text || !Number.isFinite(Date.parse(event.timestamp))) continue;
      latest = { file, at: event.timestamp, role: event.type, error: event.isApiErrorMessage === true, text };
    }
    result.set(id, latest || { file });
  }
  return result;
}

export function resumeEvidence(entry, current) {
  const last = entry.attempts?.at(-1);
  if (!current?.at) return { kind: 'session_unverified', reason: current ? '会話の日時を確認できない' : '会話ファイル欠損。古い再開履歴のみ', stalled: false };
  if (current.role === 'assistant' && !current.error && Date.parse(current.at) > Date.parse(last?.endedAt || last?.startedAt)) {
    return { kind: 'session_history', reason: `再開後に応答あり: ${current.at}; ${current.file}`, stalled: false };
  }
  return { kind: 'session_stalled', reason: `会話=${current.file}; 最終発言=${current.at}`, stalled: true };
}
