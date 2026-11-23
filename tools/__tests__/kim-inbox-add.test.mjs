import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addItem } from '../kim-inbox.mjs';
import { looksLikeApprovalRequest } from '../lib/kim-inbox-kind.mjs';

describe('kim-inbox add', () => {
  let tempDir;
  
  beforeEach(() => {
    // テスト用の一時ディレクトリを作成
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kim-inbox-test-'));
    
    // 一時ディレクトリを ORGIAST_HOME として使用
    process.env.ORGIAST_HOME = tempDir;
  });
  
  afterEach(() => {
    // 一時ディレクトリを削除
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    
    // 環境変数を元に戻す
    delete process.env.ORGIAST_HOME;
  });
  
  it('should promote kind from info to ask when text looks like approval request', async () => {
    const text = '承認をお願いします';
    const options = { kind: 'info', text };
    
    const item = await addItem(tempDir, options);
    
    // 追加された項目の情報を取得
    const itemFile = path.join(tempDir, '.claude', 'kim-inbox', `${item.id}.json`);
    const itemData = JSON.parse(fs.readFileSync(itemFile, 'utf8'));
    
    // kind が ask に昇格していることを確認
    assert.strictEqual(itemData.kind, 'ask');
    
    // kindPromotedFrom が info になっていることを確認
    assert.strictEqual(itemData.kindPromotedFrom, 'info');
  });
  
  it('should not promote kind when text does not look like approval request', async () => {
    const text = '通常の情報';
    const options = { kind: 'info', text };
    
    const item = await addItem(tempDir, options);
    
    // 追加された項目の情報を取得
    const itemFile = path.join(tempDir, '.claude', 'kim-inbox', `${item.id}.json`);
    const itemData = JSON.parse(fs.readFileSync(itemFile, 'utf8'));
    
    // kind が info のままであることを確認
    assert.strictEqual(itemData.kind, 'info');
    
    // kindPromotedFrom が存在しないことを確認
    assert.strictEqual(itemData.kindPromotedFrom, undefined);
  });
  
  it('should not promote kind when original kind is not info', async () => {
    const text = '承認をお願いします';
    const options = { kind: 'ask', text };
    
    const item = await addItem(tempDir, options);
    
    // 追加された項目の情報を取得
    const itemFile = path.join(tempDir, '.claude', 'kim-inbox', `${item.id}.json`);
    const itemData = JSON.parse(fs.readFileSync(itemFile, 'utf8'));
    
    // kind が ask のままであることを確認
    assert.strictEqual(itemData.kind, 'ask');
    
    // kindPromotedFrom が存在しないことを確認
    assert.strictEqual(itemData.kindPromotedFrom, undefined);
  });
});