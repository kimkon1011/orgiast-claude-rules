import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const normalizeTemaBody = body => String(body ?? '').replace(/\r\n?/g, '\n').trim().replace(/\n[ \t]*\n(?:[ \t]*\n)*/g, '\n\n');
const hash = body => createHash('sha256').update(normalizeTemaBody(body)).digest('hex');
const fileFor = (body, home) => path.join(home ?? process.env.ORGIAST_HOME ?? os.homedir(), '.claude', 'tema-records', `${hash(body)}.json`);
export function saveTemaRecord(strippedBody, record, { home, channel = 'send' } = {}) {
  const file = fileFor(strippedBody, home);
  const entry = { record, createdAt: new Date().toISOString(), channel, bodyHash: hash(strippedBody) };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
  return entry;
}
export function findTemaRecord(strippedBody, { home } = {}) {
  try {
    const entry = JSON.parse(fs.readFileSync(fileFor(strippedBody, home), 'utf8'));
    return entry.bodyHash === hash(strippedBody) ? entry.record : null;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function temaRecordText(record) {
  if (typeof record === 'string') return record;
  if (record?.raw) return record.raw;
  const values = record?.values ?? record;
  return values ? `[TEMA-CHECK]\n${Object.entries(values).filter(([key]) => key !== 'humanOnly').map(([k,v]) => `${k}: ${v}`).join('\n')}\n[/TEMA-CHECK]` : '';
}
