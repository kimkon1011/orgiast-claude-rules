//!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { addItem } from './kim-inbox.mjs';
import { oneScreenSummary } from './lib/one-screen-summary.mjs';

async function testSessionStartInjection() {
  console.log('Testing SessionStart injection implementation...');
  
  const home = '/tmp/test-kim-inbox';
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
  
  // Create various test items
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  
  // Create a judgment waiting item (ask)
  const judgmentItem = await addItem(home, {
    kind: 'ask',
    text: '資料確認をお願いします',
    source: 'test-source',
    createdAt: new Date().toISOString()
  });
  
  // Create a completed item (info)
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
  
  // Create SessionStart hook input
  const sessionInput = {
    hook_event_name: 'SessionStart',
    session_id: 'test-session-123'
  };
  
  // Capture the injection output
  const output = [];
  const result = await main(['--context'], {
    home,
    stdout: (text) => {
      if (!text.startsWith('{')) return;
      try {
        const json = JSON.parse(text);
        output.push(json);
      } catch (e) {
        console.error('Failed to parse output:', text);
      }
    },
    readStdin: async () => JSON.stringify(sessionInput)
  });
  
  console.log('Test completed successfully');
  console.log('Output length:', output.length);
  console.log('Result:', result);
  
  // Cleanup
  fs.rmSync(home, { recursive: true, force: true });
  
  return { success: true, output, result };
}

if (require.main === module) {
  testSessionStartInjection().then(result => {
    console.log('Test result:', result);
    process.exit(0);
  });
}