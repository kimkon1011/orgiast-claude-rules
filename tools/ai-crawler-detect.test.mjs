// AI crawler detection tests — X-0052
// Tests for tools/ai-crawler-detect.mjs
import { describe, it } from 'node:test';
import { ok, strictEqual, deepStrictEqual } from 'node:assert';

const modPath = new URL('./ai-crawler-detect.mjs', import.meta.url).pathname;
let detectCrawler, classifyLog, CRAWLER_PATTERNS, logRequest, generateNginxMap;

try {
  const mod = await import(modPath);
  detectCrawler = mod.detectCrawler;
  classifyLog = mod.classifyLog;
  CRAWLER_PATTERNS = mod.CRAWLER_PATTERNS;
  logRequest = mod.logRequest;
  generateNginxMap = mod.generateNginxMap;
} catch (e) {
  console.error('Import failed:', e.message);
  process.exit(1);
}

await describe('ai-crawler-detect', async () => {

  // Test 1: Training crawler detection
  await it('detects GPTBot as AI training crawler', () => {
    const r = detectCrawler('Mozilla/5.0 (compatible; GPTBot 1.2;)');
    strictEqual(r.isAi, true, 'isAi should be true');
    strictEqual(r.name, 'GPTBot');
    strictEqual(r.category, 'training');
  });

  // Test 2: Inference crawler detection
  await it('detects PerplexityBot as AI inference crawler', () => {
    const r = detectCrawler('Mozilla/5.0 (compatible; PerplexityBot/2.0;)');
    strictEqual(r.isAi, true, 'isAi should be true');
    strictEqual(r.name, 'PerplexityBot');
    strictEqual(r.category, 'inference');
  });

  // Test 3: Non-AI browser returns false
  await it('returns false for regular browser UA', () => {
    const r = detectCrawler('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36');
    strictEqual(r.isAi, false, 'isAi should be false for browser');
    strictEqual(r.name, '');
  });

  // Test 4: Scraping crawler detection
  await it('detects DataForSeoBot as AI scraping crawler', () => {
    const r = detectCrawler('Mozilla/5.0 (compatible; DataForSEO/3.1;)');
    strictEqual(r.isAi, true, 'isAi should be true');
    strictEqual(r.name, 'DataForSeoBot');
    strictEqual(r.category, 'scraping');
  });

  // Test 5: classifyLog extracts fields from combined log format
  await it('parses combined log line with AI crawler UA', () => {
    const logLine = '203.0.113.1 - - [15/Nov/2026:12:00:00 +0900] "GET /llms.txt HTTP/1.1" 200 567 "-" "Mozilla/5.0 (compatible; Claude-Web/1.0)"';
    const r = classifyLog(logLine);
    ok(r !== null, 'classifyLog should return result for valid log line');
    strictEqual(r.detection.isAi, true, 'should detect AI crawler');
    strictEqual(r.detection.name, 'Claude-Web');
    strictEqual(r.remoteAddr, '203.0.113.1');
    strictEqual(r.method, 'GET');
    strictEqual(r.path, '/llms.txt');
    strictEqual(r.status, '200');
  });

  // Test 6: classifyLog with non-AI UA
  await it('parses log but returns isAi=false for non-AI UA', () => {
    const logLine = '10.0.0.1 - - [15/Nov/2026:08:00:00 +0900] "GET /index.html HTTP/1.1" 304 0 "-" "Mozilla/5.0 (Windows NT 10.0) Chrome/120"';
    const r = classifyLog(logLine);
    ok(r !== null, 'classifyLog should return result');
    strictEqual(r.detection.isAi, false);
    strictEqual(r.remoteAddr, '10.0.0.1');
    strictEqual(r.method, 'GET');
    strictEqual(r.path, '/index.html');
  });
});