//!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { addItem } from './kim-inbox.mjs';

async function testOneScreenSummary() {
  console.log('Testing oneScreenSummary implementation...');
  
  const home = '/tmp/test-one-screen-summary';
  if (fs.existsSync(home)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
  
  // Create test directory structure
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude/kim-inbox'), { recursive: true });
  
  // Set up fleet-pc-map for kim-PC seat
  fs.writeFileSync(path.join(home, '.claude/fleet-pc-map.json'), JSON.stringify({
    'kim-PC': { account: 'kim@orgiast.jp' }
  }));
  
  // Create a judgment waiting item (ask)
  const judgmentItem = await addItem(home, {
    kind: 'ask',
    text: '資料確認をお願いします',
    source: 'test-source',
    createdAt: new Date().toISOString()
  });
  
  // Create a completed item (info)
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  
  const completedItem = await addItem(home, {
    kind: 'info',
    text: 'OpenRouter の設定を更新しました',
    source: 'auto-progress-done',
    createdAt: yesterday.toISOString()
  });
  
  // Create a stale item with error
  const staleItem = await addItem(home, {
    kind: 'info',
    text: '配送が失敗しました',
    source: 'test-source',
    createdAt: yesterday.toISOString(),
    forwardError: 'hub不達'
  });
  
  // Import and test the oneScreenSummary function
  const { oneScreenSummary } = await import('./lib/one-screen-summary.mjs');
  const allItems = [judgmentItem, completedItem, staleItem];
  const summary = await oneScreenSummary(allItems, { home });
  
  console.log('Generated Summary:');
  console.log(summary);
  console.log('\n--- Verification ---');
  
  // Check required sections
  const checks = [
    { text: '【進捗まとめ】', description: 'Progress summary header' },
    { text: '■ 判断待ち（上位 5 件）', description: 'Judgment waiting section header' },
    { text: '■ 完了（昨日〜今日、最大 5 件）', description: 'Completed section header' },
    { text: '■ 止まっている（最大 3 件）', description: 'Stale section header' },
    { text: '■ 件数', description: 'Count summary section header' }
  ];
  
  const results = [];
  for (const check of checks) {
    const hasSection = summary.includes(check.text);
    results.push({
      ...check,
      passed: hasSection,
      found: hasSection ? '✓' : '✗'
    });
  }
  
  // Check specific content
  const contentChecks = [
    { text: '資料確認をお願いします', description: 'Judgment waiting item text' },
    { text: 'OpenRouter の設定を更新しました', description: 'Completed item text' },
    { text: '配送が失敗しました', description: 'Stale item text' },
    { text: 'hub不達', description: 'Stale item error' }
  ];
  
  for (const check of contentChecks) {
    const hasContent = summary.includes(check.text);
    results.push({
      ...check,
      passed: hasContent,
      found: hasContent ? '✓' : '✗'
    });
  }
  
  // Check length constraint
  const summaryLength = summary.length;
  const lengthCheck = {
    text: summaryLength <= 6000 ? '✓ Summary length ≤ 6KB' : `✗ Summary length ${summaryLength} > 6KB`,
    description: '6KB length constraint',
    passed: summaryLength <= 6000,
    found: summaryLength <= 6000 ? '✓' : '✗'
  };
  results.push(lengthCheck);
  
  // Print results
  console.log('\nVerification Results:');
  let allPassed = true;
  for (const result of results) {
    console.log(`${result.found} ${result.description}: ${result.text}`);
    if (!result.passed) allPassed = false;
  }
  
  console.log('\nOverall:', allPassed ? '✓ All checks passed' : '✗ Some checks failed');
  
  // Cleanup
  fs.rmSync(home, { recursive: true, force: true });
  
  return { success: allPassed, results };
}

if (require.main === module) {
  testOneScreenSummary().then(result => {
    console.log('\nTest final result:', result);
    process.exit(result.success ? 0 : 1);
  });
}