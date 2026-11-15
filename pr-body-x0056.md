# SEO Audit & Optimization: expo-apply Exhibition Booth Page

## Summary
Installed `Illyism/seo-skills` (30 SEO skills) via `npx skills add` and applied `seo-roast` methodology to audit and optimize the exhibition booth intake page (`apps/expo-apply/`).

## Changes

### SEO Foundation (3 HTML files)
- **index.html** — Optimized title/meta description for overseas exhibitor search intent; added `hreflang` alternates (en/ja); added `rel=sitemap`; added `keywords` meta; added BreadcrumbList JSON-LD; consistent og/twitter tags
- **faq.html** — Optimized title/description; added keywords meta; added full FAQPage + BreadcrumbList JSON-LD; added `rel=parent`
- **research.html** — Optimized title/description; added keywords meta; added TechArticle + BreadcrumbList JSON-LD; added `rel=parent`

### New Files
- **sitemap.xml** — 3-URL sitemap for search engine crawl prioritization
- **seo-audit-x0056.md** — Full SEO audit report with before/after comparison per `seo-roast` 6-point procedure

### Test Verification
- All 13 existing tests pass (expo-apply.test.mjs)
- JSON-LD parsed and valid on all 3 pages
- No external dependencies changed

## Verification
```sh
node --test apps/expo-apply/test/expo-apply.test.mjs
# 13/13 pass

# Verify JSON-LD
grep -c 'application/ld+json' apps/expo-apply/index.html apps/expo-apply/faq.html apps/expo-apply/research.html
# 3 pages with JSON-LD

# Verify canonical
grep -c 'rel="canonical"' apps/expo-apply/index.html apps/expo-apply/faq.html apps/expo-apply/research.html
# 3 pages with canonical
```

## Open Items (on deploy)
- Replace relative canonical `./` with absolute URL
- Replace sitemap `<loc>` with absolute URLs
- Point `hreflang="ja"` to actual Japanese-serving URL if deployed separately

🤖 Generated with [Claude Code](https://claude.com/claude-code)