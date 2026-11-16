# Codex Implementation: Booth Spec Generator with Prompt Cache (X-0044)

## Context
Directory: `apps/booth-spec-generator/`
Schema: `tools/booth-3d/booth-spec.schema.json`
Past projects: `data/booth-projects.json`
Cache prefix: `apps/booth-spec-generator/cache-prefix.md`
Design: `apps/booth-spec-generator/SPEC.md`

## Files to Create

### 1. apps/booth-spec-generator/spec-cache.mjs
A cache management module for booth spec JSON.

```javascript
// Exports:
// - compress(spec) → compressed spec (reduce floating precision, remove nulls, deduplicate)
// - decompress(compressed) → original spec (lossless)
// - gc(cacheDir, maxAgeDays=30, maxGenerations=5) → {deleted, kept, savedBytes}
// - list(cacheDir) → [{case_id, title, createdAt, size, compressedSize}]
// - save(cacheDir, spec) → path written
// - load(cacheDir, case_id) → spec or null
```

**Compression algorithm:**
- Round all numeric values to 2 decimal places (for mm values, integers are fine)
- Remove fields with null/undefined/empty array values
- Deduplicate items with same asset_id and pos_mm
- Store `pos_mm` as relative to booth center when beneficial (save more than 10 chars)
- Track original and compressed size for stats

**GC algorithm:**
- Group specs by case_id prefix (before `-v1`, `-v2` etc.)
- Keep max 5 most recent generations per group
- Delete specs older than maxAgeDays
- Return summary of what was deleted

**Cache directory structure:**
```
~/.claude/booth-spec-cache/
  index.json  // { specs: [{case_id, title, file, createdAt, size, compressedSize}] }
  specs/
    C0056-v1.json
    C0056-v2.json
    ...
```

### 2. apps/booth-spec-generator/generate-spec.mjs
CLI tool that generates booth spec proposals.

```javascript
// Usage:
// node apps/booth-spec-generator/generate-spec.mjs \
//   --client "Client Name" \
//   --event "Event Name" \
//   --budget 300 \
//   --size "3x6" \
//   --requirements "商談重視・実機デモあり" \
//   [--batch] \
//   [--dry-run] \
//   [--output ./outputs/spec-{case_id}.json]

// Behavior:
// 1. Read cache-prefix.md as system context prefix
// 2. Accept variable inputs from CLI args
// 3. In --dry-run mode: just output the assembled prompt + spec skeleton
// 4. In normal mode: generate a spec JSON conforming to booth-spec.schema.json
// 5. Save to cache via spec-cache.mjs
// 6. Save to --output if specified
// 7. Print summary to stdout

// --batch mode:
// Accept comma-separated budgets: --budget "200,300,500"
// Generate 3 variants in one prompt call
// Output comparison table

// Spec generation logic (mock/rule-based, no LLM dependency):
// - Use cache-prefix.md knowledge to determine reasonable defaults
// - Generate booth dimensions from size parameter
// - Place items based on standard configurations for that size
// - Calculate estimated budget breakdown
// - Return JSON conforming to booth-spec.schema.json

// For the prototype, use a template-based approach:
// - Map size → standard booth config (w_mm, d_mm, height_limit_mm, open_sides, walls)
// - Map budget → items list (select appropriate assets from known list)
// - Map requirements → additional items (monitor for "デモ", extra seats for "商談")
```

### 3. apps/booth-spec-generator/spec-cache.test.mjs
Node test file (using `node:test` and `node:assert`).

```javascript
// Tests:
// 1. compress/decompress roundtrip (lossless)
//    - Take sample-3x3-rebooth.json
//    - compress → decompress → assert deep equal
// 2. compress reduces size
//    - Assert compressed.length < original.length
// 3. GC with maxGenerations
//    - Create test specs with versions v1-v7
//    - Run gc(maxGenerations=3)
//    - Assert only v5, v6, v7 remain
// 4. GC with maxAgeDays
//    - Create test specs with old dates
//    - Run gc(maxAgeDays=1)
//    - Assert old specs deleted
// 5. save/load roundtrip
//    - Save a spec, load it back, assert deep equal
// 6. list returns correct entries
// 7. --dry-run mode outputs prompt skeleton
```

### 4. apps/booth-spec-generator/README.md
Documentation in Japanese.

## Quality Requirements
- All code comments in Japanese
- Use `node:test` and `node:assert` for tests
- No external dependencies
- UTF-8 without BOM, LF line endings
- Schema validation using simple JSON.parse + field checks (no ajv dependency)
- Handle edge cases: empty specs, null values, missing files

## File encoding
UTF-8 without BOM. LF line endings.