// AI Markdown generation tests — X-0052
// Tests for tools/ai-markdown-gen.mjs
import { describe, it } from 'node:test';
import { ok, strictEqual, deepStrictEqual } from 'node:assert';
import { mkdirSync, writeFileSync, unlinkSync, rmdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const modPath = new URL('./ai-markdown-gen.mjs', import.meta.url).pathname;
let mod;
try {
  mod = await import(modPath);
} catch (e) {
  console.error('Import failed:', e.message);
  process.exit(1);
}

const testDir = 'tmp-test-x0052-mdgen';

await describe('ai-markdown-gen', async () => {

  // Setup: clean test dir
  await it('setup test directory', () => {
    try { rmdirSync(testDir, { recursive: true }); } catch {}
    mkdirSync(testDir, { recursive: true });
    ok(true);
  });

  // Test 1: registerContent and renderMarkdown produces frontmatter
  await it('renderMarkdown includes YAML frontmatter and body', () => {
    mod.clearContent();
    const page = {
      id: 'test1',
      title: 'テストページ',
      description: 'テスト用ページです',
      url: 'https://example.com/test',
      markdownPath: 'test1.md',
      category: 'test',
      body: '## セクション\n\nテスト本文です。',
      tags: ['テスト'],
      lastmod: '2026-11-15',
    };
    const md = mod.renderMarkdown(page);
    ok(md.startsWith('---'), 'Should start with frontmatter');
    ok(md.includes('title: "テストページ"'), 'Should contain title');
    ok(md.includes('## セクション'), 'Should contain body');
    ok(md.includes('https://example.com/test'), 'Should contain source URL');
  });

  // Test 2: writeAllMarkdown creates files
  await it('writeAllMarkdown writes files to disk', () => {
    mod.clearContent();
    mod.registerContent({
      id: 'test-write',
      title: 'Write Test',
      description: 'Testing file write',
      url: 'https://example.com/write',
      markdownPath: 'subdir/write-test.md',
      category: 'test',
      body: 'Written content.',
    });
    const written = mod.writeAllMarkdown(testDir);
    strictEqual(written.length, 1, 'Should write 1 file');
    const fullPath = join(testDir, 'subdir', 'write-test.md');
    ok(written[0].replace(/\\/g, '/').endsWith('subdir/write-test.md'), 'Path should match');
    const content = readFileSync(fullPath, 'utf-8');
    ok(content.includes('Write Test'), 'File should contain title');
  });

  // Test 3: generateLlmsTxt produces structured output
  await it('generateLlmsTxt includes site name and table', () => {
    mod.clearContent();
    mod.registerContent({
      id: 'svc1',
      title: 'Service One',
      description: 'First service',
      url: 'https://example.com/service1',
      markdownPath: 'services/svc1.md',
      category: 'service',
      body: 'Service details.',
    });
    const llms = mod.generateLlmsTxt('Test Site', 'A test site');
    ok(llms.includes('# Test Site'), 'Should include site name');
    ok(llms.includes('A test site'), 'Should include description');
    ok(llms.includes('## Service'), 'Should include category heading');
    ok(llms.includes('Service One'), 'Should include page title');
  });

  // Test 4: generateSitemap produces markdown table
  await it('generateSitemap returns markdown table with all pages', () => {
    mod.clearContent();
    mod.registerContent({
      id: 'p1',
      title: 'Page One',
      description: 'First page',
      url: 'https://ex.com/p1',
      markdownPath: 'p1.md',
      category: 'info',
      body: 'Content.',
    });
    mod.registerContent({
      id: 'p2',
      title: 'Page Two',
      description: 'Second page',
      url: 'https://ex.com/p2',
      markdownPath: 'p2.md',
      category: 'info',
      body: 'Content 2.',
    });
    const sm = mod.generateSitemap(null, 'https://ex.com/md');
    ok(sm.includes('| Page One'), 'Should include first page');
    ok(sm.includes('| Page Two'), 'Should include second page');
    ok(sm.includes('Total pages: 2'), 'Should include count');
  });

  // Test 5: clearContent clears the registry
  await it('clearContent empties the content registry', () => {
    mod.registerContent({
      id: 'extra',
      title: 'Extra',
      description: 'Extra page',
      url: 'https://ex.com/extra',
      markdownPath: 'extra.md',
      category: 'other',
      body: 'Extra.',
    });
    const before = mod.getContent().length;
    mod.clearContent();
    const after = mod.getContent().length;
    ok(before > 0, 'Before should be > 0');
    strictEqual(after, 0, 'After clear should be 0');
  });

  // Test 6: loadRegistry from JSON file
  await it('loadRegistry reads structured JSON and populates registry', () => {
    const registryPath = join(testDir, 'test-registry.json');
    const data = [
      { id: 'a', title: 'A', description: 'Desc A', url: 'https://ex.com/a', markdownPath: 'a.md', category: 'x', body: 'A body.' },
      { id: 'b', title: 'B', description: 'Desc B', url: 'https://ex.com/b', markdownPath: 'b.md', category: 'y', body: 'B body.' },
    ];
    writeFileSync(registryPath, JSON.stringify(data), 'utf-8');
    mod.loadRegistry(registryPath);
    const all = mod.getContent();
    strictEqual(all.length, 2, 'Should load 2 entries');
    strictEqual(all[0].id, 'a');
    strictEqual(all[1].id, 'b');
  });

  // Cleanup
  await it('cleanup test directory', () => {
    try { rmdirSync(testDir, { recursive: true }); } catch {}
    ok(true);
  });
});