// llms.txt AI discoverability validation test — X-0056
// Validates that the generated llms.txt is properly structured for AI agent consumption.
import { describe, it } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { readFileSync } from 'node:fs';

const llmsPaths = [
  { path: 'ai-visibility/x0053-llms-txt/llms.txt', label: 'x0053 template' },
];

await describe('llms.txt AI discoverability', async () => {

  for (const { path, label } of llmsPaths) {
    // Read once, normalize line endings
    const raw = readFileSync(path, 'utf-8');
    const content = raw.replace(/\r/g, '');
    const lines = content.split('\n');

    await it(`${label}: has valid structure`, () => {

      // Must start with H1 heading
      ok(content.startsWith('# '), `${label}: Should start with H1`);

      // Must have a description blockquote
      ok(content.includes('\n> '), `${label}: Should have description blockquote`);

      // Must have at least 2 sections (##)
      const sections = lines.filter(l => l.startsWith('## '));
      ok(sections.length >= 2, `${label}: Should have at least 2 sections (has ${sections.length})`);

      // Must include key company identifier
      ok(content.includes('オージャスト') || content.includes('Orgiast'), `${label}: Should include company name`);

      // All markdown links must have URLs
      const linkLines = lines.filter(l => l.includes(']('));
      for (const linkLine of linkLines) {
        const matches = linkLine.match(/\]\(([^)]+)\)/g);
        if (matches) {
          for (const m of matches) {
            const url = m.slice(2, -1);
            ok(url.startsWith('https://') || url.startsWith('http://'), `${label}: Link URL should be absolute: ${url}`);
          }
        }
      }
    });

    await it(`${label}: contains booth production info`, () => {
      // Must mention booth/exhibition services
      const hasBooth = content.includes('ブース') || content.includes('booth') || content.includes('展示会');
      ok(hasBooth, `${label}: Should mention booth/exhibition services`);
    });

    await it(`${label}: contains event track record`, () => {
      // Must mention client names as track records
      const hasClients = content.includes('アスタミューゼ') || content.includes('ポルシェ') || content.includes('START');
      ok(hasClients, `${label}: Should include client track record examples`);
    });

    await it(`${label}: has contact information`, () => {
      const hasContact = content.includes('0120') || content.includes('contact') || content.includes('問い合わせ');
      ok(hasContact, `${label}: Should have contact info`);
    });

    await it(`${label}: markdown is parseable (no broken formatting)`, () => {

      // Check heading consistency: ## lines should be followed by content
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i];
        // H1 should only appear at top
        if (line.startsWith('# ') && i > 0) {
          ok(false, `${label}: H1 should only be at top (line ${i + 1})`);
        }
        // No trailing whitespace (markdown lint)
        if (line.length > 0 && line !== line.trimEnd() && !line.startsWith('|')) {
          // Allow table lines to have trailing spaces, flag other lines
          ok(false, `${label}: Line ${i + 1} has trailing whitespace`);
        }
      }

      // File should end with newline
      strictEqual(content.endsWith('\n'), true, `${label}: Should end with newline`);
    });
  }
});