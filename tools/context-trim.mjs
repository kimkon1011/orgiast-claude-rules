import { estimateTokens } from './session-fold.mjs';

const TRIM_MARKER_RE = /\[\[trimmed \d+ chars\]\]/u;

function isToolResult(message) {
  return message?.kind === 'tool_result';
}

export function trimMessage(msg, { maxChars }) {
  if (!isToolResult(msg) || msg.text.length <= maxChars || TRIM_MARKER_RE.test(msg.text)) {
    return { ...msg };
  }

  const sideChars = Math.floor(maxChars / 2);
  const removedChars = msg.text.length - (sideChars * 2);
  return {
    ...msg,
    text: `${msg.text.slice(0, sideChars)}[[trimmed ${removedChars} chars]]${msg.text.slice(msg.text.length - sideChars)}`,
  };
}

export function trimEveryTurn(messages, { keepRecent = 6, maxChars = 400, protectErrors = true } = {}) {
  const trimBefore = Math.max(0, messages.length - keepRecent);
  return messages.map((message, index) => {
    if (index >= trimBefore || !isToolResult(message) || (protectErrors && message.hasError === true)) {
      return { ...message };
    }
    return trimMessage(message, { maxChars });
  });
}

export function totalTokens(messages) {
  return messages.reduce((sum, message) => sum + estimateTokens(message.text), 0);
}

export function trimBulk(messages, { windowTokens, threshold = 0.8, keepRecent = 6, maxChars = 400, protectErrors = true }) {
  if (totalTokens(messages) < windowTokens * threshold) {
    return messages.map(message => ({ ...message }));
  }
  return trimEveryTurn(messages, { keepRecent, maxChars, protectErrors });
}

export function simulate(turnsMessages, mode, opts = {}) {
  if (!['none', 'bulk', 'everyTurn'].includes(mode)) throw new Error(`unknown mode: ${mode}`);

  let messages = [];
  let cumulativeInputTokens = 0;
  let bulkThresholdReached = false;
  const steps = [];

  for (const nextMessage of turnsMessages) {
    messages = [...messages, { ...nextMessage }];
    if (mode === 'everyTurn') {
      messages = trimEveryTurn(messages, opts);
    } else if (mode === 'bulk') {
      bulkThresholdReached ||= totalTokens(messages) >= opts.windowTokens * (opts.threshold ?? 0.8);
      if (bulkThresholdReached) messages = trimEveryTurn(messages, opts);
    }

    const inputTokens = totalTokens(messages);
    cumulativeInputTokens += inputTokens;
    steps.push(inputTokens);
  }

  return { cumulativeInputTokens, steps, finalMessages: messages };
}

export function missingInfoRate(original, trimmed, { recent = 6 } = {}) {
  const recentStart = Math.max(0, original.length - recent);
  const protectedIndexes = original.flatMap((message, index) => (
    isToolResult(message) && (index >= recentStart || message.hasError === true || message.ref !== undefined)
      ? [index]
      : []
  ));

  if (protectedIndexes.length === 0) return 0;
  const missing = protectedIndexes.reduce((count, index) => (
    trimmed[index]?.text === original[index].text ? count : count + 1
  ), 0);
  return missing / protectedIndexes.length;
}
