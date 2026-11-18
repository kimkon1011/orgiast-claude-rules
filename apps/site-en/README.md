# Site English Translation Project

## CODEX-TASK-04: resumable orgiast completion

Only orgiast is operated on by the following commands. Run from `apps/site-en/`:

```powershell
node scripts/orgiast-task04.mjs --mode audit --offset 0 --limit 375
node scripts/orgiast-task04.mjs --mode repair --offset 0 --limit 400
# Advance the offset through evidence/orgiast-pending-current.json.
node scripts/orgiast-task04.mjs --mode build --offset 0 --limit 50
# Repeat page ranges through offset 350, then:
node scripts/orgiast-task04.mjs --mode report --offset 0 --limit 375
node scripts/deploy-ftp.mjs --site orgiast --apply --offset 0 --limit 50
# Repeat sorted file ranges through offset 350, then:
node scripts/verify-task04.mjs
```

Translation requests contain at most 10 strings, with an explicit openrouter → mistral → deepseek retry order and implicit fallback disabled. Translation work stops within a 390-second budget and saves successful batches immediately; subsequent runs reuse valid translations. The fixed pending list gives stable string offsets; `orgiast-pending-after.json` records the remaining items after each run. Re-running an offset is safe. Page ranges use the complete 375-page inventory, including topics. Unresolved pages are explicitly listed as failed in `orgiast-excluded.json`, without blocking the rest. `orgiast-progress.json` records each run, counts and deployment progress. Preserve the ignored ownership manifest on this workstation. Do not run concurrent writers against the same translation/build state.

`reviewed-translations-orgiast.json` records individually reviewed exceptions and their reasons. Numbers with ambiguous source punctuation are retained literally; quantity conversions are accepted only when arithmetically equivalent. Original 81 failures and their final outcomes are in `orgiast-unresolved.json`. BUILD-REPORT.md and DEPLOY-REPORT.md contain current task results; older sections describe earlier runs.

## CODEX-TASK-02: static FTP publication (current implementation)

This section supersedes the older WordPress/Polylang proposals in RESEARCH.md and ENV.md. Never modify WordPress, Japanese pages, .htaccess, apps/expo-apply, or remote en/expo-apply. The expo-apply config is read-only input.

Run from the repository root (Node.js with global fetch):

```powershell
npm ci --prefix apps/site-en
node --test apps/site-en/scripts/*.test.mjs
node apps/site-en/scripts/build-static.mjs
node apps/site-en/scripts/deploy-ftp.mjs --site rebooth
node apps/site-en/scripts/deploy-ftp.mjs --site orgiast
node apps/site-en/scripts/deploy-ftp.mjs --site rebooth --apply
node apps/site-en/scripts/deploy-ftp.mjs --site orgiast --apply
node apps/site-en/scripts/verify-public.mjs
```

`build-static` fetches current nested/gzipped sitemaps and full rendered HTML, serially with at least 350 ms between GETs. Each site's phase 1 pages precede the rest. `--site` limits the site; `--phase 1` is a core-only local build (deployment refuses an incomplete site). `--resume` reuses this run's saved full HTML after an interrupted translation; normal runs refetch it. `--index` removes noindex, only for use after kim's review. Default output is always noindex,nofollow. Translation reuses en JSON and exact string cache entries, then explicitly invokes llm-ask in deepseek → openrouter → mistral order, with implicit fallbacks disabled. New translations are saved in template-strings.*.json. No Claude provider is used.

FTP dry-run performs read-only root verification and lists the upload plan; apply requires two exact static-file size **and hash** matches against public HTTPS. It rejects foreign existing files, path traversal, nested en paths and expo-apply. Only hashes in the local `.site-en-manifest.json` authorize updates; preserve this ignored state file and `evidence/build-state.json` on this workstation. Losing ownership state deliberately prevents overwrite. Uploaded files are downloaded again for SHA256 verification, and protected directory names/sizes are compared before and after. No remote delete, mirror, or rename operations are used. Credentials are read with the designated nightly-repo env-kv helper and never printed.

After successful publication, `verify-public` records baseline lastmod state. Manual incremental update:

```powershell
node apps/site-en/scripts/regen.mjs
node apps/site-en/scripts/regen.mjs --apply
```

Without `--apply` this is a read-only lastmod comparison. With it, only new/changed pages are fetched, translated and built; the full sitemap is retained, changed generated files are deployed, and lastmod state advances **only after verified upload**. Removed source pages are not remotely deleted. No cron is registered.

Read FORMS.md for measured form destinations, BUILD-REPORT.md for page counts/residual rates and DEPLOY-REPORT.md for actual root selection, upload results and HTTP checks. The initial published-expo assumption was not true in live measurements: `/en/expo-apply/` returned 404 before this task's upload, and was not repaired or populated.

This project contains scripts and data for translating the rebooth.co.jp and www.orgiast.jp websites to English.

## Directory Structure

- `source/` - Original Japanese content fetched from the websites
- `en/` - Translated English content (output directory)
- `scripts/` - Scripts for fetching, translating, and validating content
- `template-strings.*.json` - Template string translations for UI elements
- `ENV.md` - Environment analysis for both sites
- `MANIFEST.json` - Complete list of all pages to be translated
- `CHECK-REPORT.md` - Validation report for translations

## Workflow

1. **Fetch Content** - Already completed with `fetch-pages.mjs` and `fetch-remaining.mjs`
2. **Translate Content** - Use `scripts/translate.mjs`
3. **Validate Translations** - Use `scripts/check.mjs`

## Scripts

### translate.mjs

Translates Japanese content to English while preserving HTML structure.

Usage:
```bash
node scripts/translate.mjs [--dry-run] [--limit N] [--phase 1|2|3]
```

Options:
- `--dry-run`: Show what would be translated without actually doing it
- `--limit N`: Limit to N pages
- `--phase N`: Only process pages from specific phase (1, 2, or 3)

### check.mjs

Validates translated content for quality assurance.

Usage:
```bash
node scripts/check.mjs [--limit N] [--phase 1|2|3]
```

Validation checks:
1. Japanese character residual rate < 5%
2. Numbers in translation match source content
3. HTML tag counts (a/img) match between source and translation

## Translation Guidelines

- Brand "Re:ブース" → "Re:Booth" (first appearance: "Re:Booth (Re:ブース)")
- Company name "株式会社オージャスト" → "Orgiast Co., Ltd."
- Representative name "金功勇（野村功勇）" → "Koyu Kim (Representative Director & President)"
- Use business English with exhibition industry terminology
- Preserve all HTML structure, classes, and attributes
- Do not add numbers or facts not present in original Japanese content

## Phases

1. **Phase 1**: Core pages (home, about, contact, company info, etc.)
2. **Phase 2**: Main content pages (works, news, events, etc.)
3. **Phase 3**: Remaining pages (topics, additional content)

## LLM Provider Chain

Translations use the following fallback chain:
1. deepseek (primary)
2. openrouter 
3. mistral
4. groq (stopped)

See `C:/Users/USER/.claude/nightly-repo/tools/llm-ask.mjs` for implementation details.
