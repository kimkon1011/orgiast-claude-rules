# Static Prefix Placement — Benchmark Report

Date: 2026-11-08
Tool: tools/static-prefix-placement.mjs

## Structure

| Metric | Value |
|---|---|
| Total sections | 9 (5 static / 4 dynamic) |
| Static prefix | 586 chars (64.4%) |
| Static tokens | 147 |
| Dynamic tokens | 85 |
| Cacheable | true |
| Content preserved | true |

## Cache Efficiency (projections)

| Requests | TTFT first | TTFT subsequent | Reduction | Cost savings |
|---|---|---|---|
| 1 | 3200ms | N/A | 0% | 0% |
| 2 | 1388ms | 250ms | 82% | 28.5% |
| 3 | 1388ms | 250ms | 82% | 38% |
| 5 | 1388ms | 250ms | 82% | 45.6% |
| 10 | 1388ms | 250ms | 82% | 51.3% |

## Scenario Comparison

| Scenario | Static % | Cache hit | TTFT reduction | Cost savings |
|---|---|---|---|
| worst (dynamic first) | 71.2% | 67.7% | 77.4% | 40.6% |
| mixed (interleaved) | 70.2% | 66.7% | 78.3% | 40% |
| optimized (static first) | 64.4% | 63.4% | 82% | 38% |
