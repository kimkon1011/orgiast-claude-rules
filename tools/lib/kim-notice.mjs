// Keep automatic notices short and make both the automatic and human next steps explicit.
const line = value => String(value ?? '').replace(/\s+/g, ' ').trim();
export function formatKimNotice({ what, next, kim, detail } = {}) {
  const lines = [line(what), `次に自動でやること: ${line(next) || 'なし（これで終わりです）'}`, `kim がすること: ${line(kim) || 'なし'}`];
  if (line(detail)) lines.push(`\`${line(detail).replace(/`/g, '')}\``);
  return lines.join('\n');
}
