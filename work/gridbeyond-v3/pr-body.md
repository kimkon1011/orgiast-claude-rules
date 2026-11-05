## Summary

- strengthen booth prompts with human, width/height, hall-ceiling, and neighbouring-booth scale constraints
- add a configurable OpenRouter `--model` option while retaining the existing default
- cover the new prompt clauses and model selection in tests

## Test

- `node --test tools/booth-perse-gen.test.mjs` (9 passed)

## Generated assets

- Generated three GridBeyond v3 renders with `google/gemini-2.5-flash-image`
- Verified each at height/person ratio 2.1 with `google/gemini-2.5-flash`
