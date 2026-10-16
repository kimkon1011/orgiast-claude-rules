// Conservative whole-command recognition; compound commands, substitutions and
// redirections never inherit a read-only exemption from one harmless segment.
export function isReadonlyCommand(value) {
  const text = String(value || '').trim();
  if (/[;&|<>`\r\n]|\$\(/.test(text) || /\s--(?:\s|$)/.test(text)) return false;
  return /^(?:clasp\s+(?:deployments|status|versions)|(?:vercel|vc\.js)\s+(?:ls|list|inspect|deployments\s+(?:ls|list))|gh\s+(?:pr|issue)\s+(?:view|list|status|diff|checks)|git\s+(?:status|log|diff|show|rev-parse)|rg\s+--files)(?:\s+[^;&|<>`\r\n]*)?$/i.test(text)
    || /^git\s+push\b(?=[^\r\n]*\s--dry-run(?:\s|$))[^;&|<>`\r\n]*$/i.test(text);
}
