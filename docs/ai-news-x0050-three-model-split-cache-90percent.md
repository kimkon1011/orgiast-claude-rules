# X-0050: 3 model split + implicit cache 95% off = 90% cost reduction

**AI News Proposal 2026-11-15**: Split tasks across Claude models by difficulty; place 4,096+ tokens of common rules at prompt top to trigger Anthropic implicit prompt caching (95% off input tokens: $3.00/M -> $0.075/M). Route non-urgent work to Batch API for 50% off. For Orgjast: cache booth design guidelines, use Gemini for bulk variation generation, Grok for competitive exhibition trend research.

Observed: 2026-11-15

---

## 1. Overview

Leverage Anthropic November 2026 model lineup by assigning the right model to the right task at the right effort level.

### 1.1 Target Models

| Model | Role | Input $/1M | Output $/1M | Best for |
|-------|------|-----------|------------|----------|
| **Opus 5.5** | Strongest general | $15.00 | $75.00 | Design, planning, complex impl, quality decisions |
| **Sonnet 5.5** | Lightweight fast | $3.00 | $15.00 | Daily edits, routine code, summarization |
| **Fable 5.2** | Forensics | $15.00 | $75.00 | Large-scale batch impl, complex refactoring |
| **Haiku 5.5** | Ultra-light | $0.25 | $1.25 | Classification, extraction, simple transform |

### 1.2 Three Pillars of Cost Optimization

| # | Measure | Effect | Prerequisite |
|---|---------|--------|-------------|
| 1 | **Model routing** | Use Sonnet where possible -> cost 1/5 of Opus | Task difficulty criteria |
| 2 | **Implicit prompt caching** | Common prefix input cost 95% off | Fixed 4096+ token prefix |
| 3 | **Batch API** | Total cost 50% off | Identify 24h-wait tasks |

**Target: 90-95% reduction in total AI operation cost.**

### 1.3 Thinking Level by Task

| level | Use case | Cost multiplier |
|-------|---------|----------------|
| low | Repeated prompts, template filling | 0.8x |
| medium | Daily edits, summaries, Q&A | 1.0x (baseline) |
| high | Bugfix, debugging, logic verification | 1.5x |
| xhigh | Architecture decisions, complex refactoring | 3x |

---

## 2. Cost Comparison

### 2.1 Base Pricing (2026-11-15)

| Model | Input $/1M | Output $/1M | Cache Read $/1M (95% off) | Batch Input $/1M (50% off) |
|-------|-----------|------------|--------------------------|------------------------|
| Claude Opus 5.5 | $15.00 | $75.00 | $0.75 | $7.50 |
| Claude Sonnet 5.5 | $3.00 | $15.00 | $0.15 | $1.50 |
| Claude Haiku 5.5 | $0.25 | $1.25 | $0.0125 | $0.125 |
| Fable 5.2 | $15.00 | $75.00 | $0.75 | $7.50 |

### 2.2 Per-Task Cost (10K input, 1K output)

| Task | Sonnet (std) | Sonnet (cached) | Sonnet (Batch+cache) | Reduction |
|------|-------------|----------------|---------------------|-----------|
| Daily code edit | $0.045 | $0.0075 | $0.00375 | **91.7%** |
| Booth proposal draft | $0.045 | $0.0075 | $0.00375 | **91.7%** |
| Competitor trend research | $0.045 | $0.0075 | $0.00375 | **91.7%** |

### 2.3 Monthly Estimate (200 tasks)

| Scenario | Cost | Reduction |
|----------|------|-----------|
| Sonnet 5.5 standard | $9.00 | - |
| With cache (50% cached) | $4.50 | 50% |
| Cache + Batch (50% batched) | $2.25 | 75% |
| + Model routing (Haiku subs) | $0.75 | **91.7%** |

**Monthly cost from $9 to $0.75. Annual savings ~$100.**

---

## 3. Implicit Prompt Cache Strategy

### 3.1 Cache Trigger

Anthropic (2026-11) implicitly caches the first 4,096+ tokens when the prompt prefix matches the previous request. Cache read cost is 5% of normal (95% off).

| Item | Value |
|------|-------|
| Trigger | Prefix 4,096+ tokens matching previous request |
| Cache read price | 5% of normal (95% off) |
| Validity | Same session + within ~5 minutes |
| Applies to | Entire common prefix up to first diff |
| Explicit control | Not needed (automatic) |

### 3.2 Fixed Prefix Design

Place common system prompt + rules + skill definitions at the start of every request:

```
[Fixed common prefix - 4,096+ tokens]
  CLAUDE.md common guidelines (1,500 tok)
  Project-specific rule definitions (1,000 tok)
  Skill definitions (1,500 tok)
  Frequently used examples/templates (500+ tok)

[Variable task-specific part]
  Current specific instructions
```

**Maximization conditions**:
1. **Front-load**: Put immutable content at the prompt front
2. **Variable part at end**: Task-specific instructions after common prefix
3. **Same session, repeated**: Send requests with same prefix consecutively
4. **Within 5 min**: Next request before cache expires

---

## 4. Batch API Usage

Batch API runs non-urgent tasks at 50% off with ~24h latency.

### 4.1 Batch Eligibility

| Eligible (Batch) | Not eligible (Real-time) |
|-----------------|-------------------------|
| Nightly batch jobs | User interaction responses |
| Bulk booth variations | Urgent inquiries |
| Regular competitor reports | Debugging iterations |
| Historical data reprocessing | Code review requests |
| SEO meta generation (all pages) | git commit/push hooks |
| GSC periodic analysis | Emergency fixes |

### 4.2 Cost Example (50 booth variations)

| Item | Real-time | Batch + cache |
|------|----------|--------------|
| Input/task | 10K (common5K+task5K) | 10K (common cached 95% off) |
| Output/task | 2K | 2K |
| Input cost/task | $0.030 | $0.0015 (cache read) |
| Output cost/task | $0.030 | $0.015 (50% off) |
| 50 tasks total | **$3.00** | **$0.825 (72.5% off)** |

---

## 5. Orgjast Application Scenarios

### 5.1 Booth Design Guidelines Cached

**Current**: Each booth proposal includes same guidelines -> recurring input cost.

**After**: Cache 4,096+ token common prefix with Orgjast booth guidelines, exhibition constraints, equipment inventory, past cases, brand palette.

**Effect**: ~95% off common part input cost.

### 5.2 Gemini for Bulk Variation Generation

Flow: Common guidelines (cached) -> Gemini 2.0 Flash ($0.10/1M) for 3-5 variations -> Opus 5.5 vetting (cached).

**Cost (30 proposals/month)**:

| Scenario | Total | Reduction |
|----------|-------|-----------|
| All Claude | $90 | - |
| Claude cache only | $12 | 86.7% |
| Gemini + Opus (cached) | $1.65 | **98.2%** |

### 5.3 Grok for Competitive Exhibition Research

Flow: Grok-4 ($2.00/1M) collects exhibition data -> Sonnet 5.5 (cached) formats into proposals.

**Cost (8 events/month)**:

| Scenario | Total | Reduction |
|----------|-------|-----------|
| All Claude | $8.00 | - |
| Grok + cached Sonnet | $0.90 | **88.8%** |

---

## 6. settings.json Configuration

```json
{
  "maxThinkingEffort": "high",
  "models": {
    "claude-opus-5-5": {
      "effortLevel": "medium",
      "maxEffortLevel": "xhigh"
    },
    "claude-sonnet-5-5": {
      "effortLevel": "low",
      "maxEffortLevel": "medium"
    },
    "claude-haiku-5-5": {
      "effortLevel": "low"
    }
  }
}
```

**Effect**: Eliminate unnecessary high-effort thinking. 30-50% reduction in thinking cost.

---

## 7. Roadmap

| Phase | Period | Content | Effect |
|-------|--------|---------|--------|
| P0 | Week 1 | Measure actual cache hit rate | Verify cache & cost reduction |
| P1 | Week 2 | Apply common prefix to CLAUDE.md | 50% input cost reduction |
| P2 | Week 3 | Trial Batch API + model routing | Half-price non-urgent |
| P3 | Week 4 | Gemini/Grok division trial | 90%+ for specific tasks |
| P4 | Month 2 | Full rollout decision | Monthly reporting baseline |

---

## 8. Constraints and Risks

| Constraint/Risk | Impact | Mitigation |
|-----------------|--------|------------|
| 5-min cache TTL | Cache lost if conversation pauses | Batch submission, keep intervals <5min |
| Model switch = cache invalid | Different model loses cache | Fix model per session |
| Quality gap Gemini/Grok vs Claude | Inconsistent output | Opus/human vetting gate |
| Batch 24h latency | Blurred urgency line | Define Batch-eligible list |

---

## 9. Conclusion

**Three-model split (Claude + Gemini + Grok) + implicit caching + Batch API can reduce Orgjast AI operation costs by 90%+.**

1. **Immediate**: Common guideline caching -> days to deploy, 50% reduction
2. **Maximum impact**: Booth variations via Gemini -> **98% reduction**
3. **Sustainability**: Batch API for non-urgent tasks -> halve baseline
4. **Side benefit**: Model-strength-based quality optimization

**First step**: Freeze first 4,096+ tokens of prompts into fixed prefix. Verify cache activation via API response on second identical request. Formalize in CLAUDE.md.

---

**References**:
- Anthropic API: Prompt Caching (docs.anthropic.com)
- Anthropic: Batch API (docs.anthropic.com)
- Anthropic Pricing (anthropic.com/pricing)
- OpenRouter: Gemini/Grok Pricing (openrouter.ai/models)
- Related: X-0035, X-0038, X-0039, X-0045, X-0046