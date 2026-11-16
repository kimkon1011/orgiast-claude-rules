export async function oneScreenSummary(items, { home = process.env.ORGIAST_HOME || os.homedir() } = {}) {
  // Separate open and closed items for different sections
  const openItems = items.filter(item => item.status === 'open');
  const closedItems = items.filter(item => item.status === 'merged');
  
  // Sorting by creation time (newest first) for relevant sections
  const sortByCreatedAt = (a, b) => b.createdAt.localeCompare(a.createdAt);
  const sortedOpenItems = [...openItems].sort(sortByCreatedAt);
  
  const summaryLines = [];
  const now = new Date();
  
  // === Section 1: Judgment Waiting (5 newest items) ===
  const judgmentItems = sortedOpenItems.filter(item => item.kind === 'ask' && item.status === 'open');
  const judgmentCount = judgmentItems.length;
  summaryLines.push('📌 kim の返事待ち');
  
  if (judgmentCount === 0) {
    summaryLines.push('0件');
  } else {
    summaryLines.push(`${judgmentCount}件`);
    
    // Top 5 judgment items with details
    const judgmentLimit = Math.min(5, judgmentItems.length);
    for (let i = 0; i < judgmentLimit; i++) {
      const item = judgmentItems[i];
      const text = item.text.replace(/\r?\n/g, ' ').slice(0, 120);
      const createdAt = new Date(item.createdAt);
      const daysAgo = Math.floor((now - createdAt) / (1000 * 60 * 60 * 24));
      summaryLines.push(`${text} (件名: ${item.id}, ${daysAgo}日前)`);
    }
  }
  
  summaryLines.push('');
  
  // === Section 2: Completed (5 newest items) ===
  const completedItems = sortedOpenItems.filter(item => item.kind === 'info' && item.status === 'open');
  const completedCount = completedItems.length;
  summaryLines.push('📲 自動進行の結果');
  
  if (completedCount === 0) {
    summaryLines.push('0件');
  } else {
    summaryLines.push(`${completedCount}件`);
    
    // Top 5 completed items with details
    const completedLimit = Math.min(5, completedItems.length);
    for (let i = 0; i < completedLimit; i++) {
      const item = completedItems[i];
      const text = item.text.replace(/\r?\n/g, ' ').slice(0, 120);
      const createdAt = new Date(item.createdAt);
      const daysAgo = Math.floor((now - createdAt) / (1000 * 60 * 60 * 24));
      summaryLines.push(`${text} (${createdAt.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric' })})`);
    }
  }
  
  summaryLines.push('');
  
  // === Section 3: Stale (5 items with errors/timeouts) ===
  const staleItems = sortedOpenItems.filter(item => {
    // Check if it has error indicators based on the HANDOFF requirements
    return item.status === 'open' && 
           item.forwardError && 
           (item.forwardError.includes('hub不達') || 
            item.forwardError.includes('timeout') || 
            item.forwardError.includes('EBUSY') || 
            item.forwardError.includes('403'));
  });
  
  summaryLines.push('🔴 止まっている');
  
  if (staleItems.length === 0) {
    summaryLines.push('0件');
  } else {
    summaryLines.push(`${staleItems.length}件`);
    
    // Top 5 stale items with details
    const staleLimit = Math.min(5, staleItems.length);
    for (let i = 0; i < staleLimit; i++) {
      const item = staleItems[i];
      const text = item.text.replace(/\r?\n/g, ' ').slice(0, 100);
      const errorInfo = item.forwardError ? `（原因: ${item.forwardError}）` : '';
      summaryLines.push(`${text} ${errorInfo}`);
    }
  }
  
  summaryLines.push('');
  
  // === Section 4: Count Summary ===
  const openCount = openItems.length;
  const askCount = judgmentItems.length;
  const infoCount = completedItems.length;
  const answerCount = openItems.filter(item => item.status === 'answered').length;
  const seenCount = openItems.filter(item => item.status === 'seen').length;
  
  summaryLines.push('📊 件数');
  summaryLines.push(`kim の返事待ち: ${askCount}件 / 自動進行の結果: ${infoCount}件 / 止まっている: ${staleItems.length}件`);
  summaryLines.push(`返答済み: ${answerCount}件 / 既読: ${seenCount}件 / 未表示合計: ${openCount}件`);
  summaryLines.push('(詳細・全件閲覧: node tools/kim-inbox.mjs --list)');
  
  // Ensure the summary stays within 6KB
  let finalSummary = summaryLines.join('\n');
  if (finalSummary.length > 6000) {
    // Trim the middle content to fit within limit
    const lines = summaryLines.slice(); // Create a copy
    const headerLines = ['📌 kim の返事待ち', `${judgmentCount}件`]; // Show counts at top
    const footerLines = ['(詳細・全件閲覧: node tools/kim-inbox.mjs --list)']; // Keep footer
    
    // Keep header, truncate middle content, keep footer
    const truncatedLines = headerLines.concat(['(内容が長すぎるため、切り詰めました)'], footerLines);
    finalSummary = truncatedLines.join('\n');
  }
  
  return finalSummary;
}