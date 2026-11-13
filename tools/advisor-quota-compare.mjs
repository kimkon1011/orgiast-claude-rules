// 重みは仮置き。実際のクォータ換算や価格を表すものではない。
const DEFAULT_WEIGHTS = { input: 1, output: 5, cacheRead: 0.1, cacheCreate: 1.25 };

function* parsedLines(jsonlText) {
  for (const line of jsonlText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      yield { value: JSON.parse(line), bad: false };
    } catch {
      yield { bad: true };
    }
  }
}

export function aggregateUsage(jsonlText) {
  const models = new Map();
  let missingUsage = 0;
  let badLines = 0;
  for (const { value, bad } of parsedLines(jsonlText)) {
    if (bad) {
      badLines++;
      continue;
    }
    const message = value?.message;
    const isAssistant = value?.type === 'assistant' || message?.role === 'assistant';
    if (!isAssistant && message?.usage == null) continue;
    const model = message?.model ?? 'unknown';
    if (!models.has(model)) {
      models.set(model, { model, input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
    }
    const totals = models.get(model);
    const usage = message?.usage;
    if (usage == null) missingUsage++;
    totals.input += usage?.input_tokens ?? 0;
    totals.output += usage?.output_tokens ?? 0;
    totals.cacheRead += usage?.cache_read_input_tokens ?? 0;
    totals.cacheCreate += usage?.cache_creation_input_tokens ?? 0;
  }
  return { byModel: [...models.values()], missingUsage, badLines };
}

export function compareConfigs(baselineAgg, advisorAgg, weights = DEFAULT_WEIGHTS) {
  const consumption = (agg) => agg.byModel.reduce((sum, row) => sum
    + row.input * weights.input + row.output * weights.output
    + row.cacheRead * weights.cacheRead + row.cacheCreate * weights.cacheCreate, 0);
  const baseline = consumption(baselineAgg);
  const advisor = consumption(advisorAgg);
  return { baseline, advisor, reductionRate: baseline === 0 ? null : (baseline - advisor) / baseline };
}

function defaultDetector(line) {
  const content = line?.message?.content;
  if (typeof content === 'string') return content.includes('[ADVISOR]');
  return Array.isArray(content) && content.some((block) =>
    (block?.type === 'tool_use' && block.name === 'advisor')
    || (block?.type === 'text' && typeof block.text === 'string' && block.text.includes('[ADVISOR]')));
}

export function countAdvisorCalls(jsonlText, detector = defaultDetector) {
  let count = 0;
  for (const { value, bad } of parsedLines(jsonlText)) {
    if (!bad && detector(value)) count++;
  }
  return count;
}
