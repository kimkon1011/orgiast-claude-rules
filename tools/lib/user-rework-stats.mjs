import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const USER_REWORK_PATTERN = /(?:じゃないの[？?]?|はずがない|また聞かないといけない|何回も言わせ|勝手に|ちゃんと見て|そちらでやって|自分でやって|前にも言った|何回言ったら|言ったよね|指示に従って|やり直して|話聞いて|読んでない|見てない|何回も|同じこと)/i;

const MACHINE_USER_PREFIXES = [
  '<local-command', '<command-name', '<command-message', '<command-args',
  '<task-notification', '<system-reminder', '<local-command-stdout', '[Image:',
  'Stop hook feedback:',
];

export function isHumanMessage(text) {
  const trimmed = String(text || '').trimStart();
  if (!trimmed) return false;
  return !MACHINE_USER_PREFIXES.some(prefix => trimmed.startsWith(prefix));
}

function countReworkInFile(filePath) {
  let count = 0;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry?.isSidechain === true) continue;
        if (entry?.type === 'user' && entry?.message?.role === 'user') {
          const msgContent = entry.message.content;
          const text = Array.isArray(msgContent)
            ? msgContent.filter(b => b?.type === 'text').map(b => b.text || '').join('\n')
            : typeof msgContent === 'string' ? msgContent : '';
          if (isHumanMessage(text) && USER_REWORK_PATTERN.test(text)) {
            count++;
          }
        }
      } catch {}
    }
  } catch {}
  return count;
}

export function collectUserReworkStats({ home = process.env.ORGIAST_HOME || os.homedir(), days = 7, transcriptPath = '' } = {}) {
  let currentSessionCount = 0;
  if (transcriptPath && fs.existsSync(transcriptPath)) {
    currentSessionCount = countReworkInFile(transcriptPath);
  }

  let sevenDayCount = 0;
  const projectsDir = path.join(home, '.claude', 'projects');
  const cutoff = Date.now() - days * 864e5;

  function walk(dir) {
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const item of items) {
      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) {
        walk(fullPath);
      } else if (item.isFile() && item.name.endsWith('.jsonl')) {
        try {
          if (fs.statSync(fullPath).mtimeMs >= cutoff) {
            sevenDayCount += countReworkInFile(fullPath);
          }
        } catch {}
      }
    }
  }

  walk(projectsDir);

  return {
    currentSessionCount,
    sevenDayCount
  };
}
