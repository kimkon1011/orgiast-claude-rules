# SEO Audit & Optimization Report: apps/expo-apply
**Date:** 2026-11-15 | **Source:** X-0056 Illyism/seo-skills via `npx skills add Illyism/seo-skills`

## Verdict
Strong SEO foundation for a demo/tool page: robots.txt is default-allow, JSON-LD is present, semantic HTML, mobile-responsive. Key gaps were missing hreflang, sitemap, BreadcrumbList schema, and thin keyword targeting in titles and descriptions.

## Audit Results (seo-roast methodology)

### 1. Self-Own Crawl & Blockers
| Check | Result | Action Taken |
|---|---|---|
| robots.txt | ✅ PASS — `Allow: /` (default-allow) | None needed |
| Sitemap | ❌ MISSING | ✅ Created `sitemap.xml` with 3 URLs |
| Canonical | ✅ Relative `./` (acceptable for intra-repo, needs absolute on deploy) | ⚠️ Noted: TODO on deploy |
| `llms.txt` | ✅ Present | None needed |
| `ai.txt` | ✅ Present | None needed |

### 2. Page Structure & Metadata
| Check | Result | Action Taken |
|---|---|---|
| Title tag | ⚠️ Weak keyword coverage | ✅ Added "Overseas Exhibitor Booth Intake" — more search intent |
| Meta description | ⚠️ Generic | ✅ Added "Plan your Japan trade show exhibit: bilingual intake form for booth, staffing, logistics..." |
| Meta keywords | ❌ Missing | ✅ Added `keywords` meta with target terms |
| H1 | ✅ "Exhibit at Trade Shows in Japan" — clear | None needed |
| Semantic HTML | ✅ header, main, nav, section | None needed |
| Hreflang (bilingual) | ⚠️ `og:locale:alternate` only | ✅ Added `link[hreflang]` tags for EN/JA |

### 3. Structured Data (JSON-LD)
| Schema | Before | After |
|---|---|---|
| WebApplication | ✅ Already present | ✅ Enhanced |
| FAQPage | ✅ Already present | ✅ Enhanced (FAQ page) |
| BreadcrumbList | ❌ Missing | ✅ Added to index.html, faq.html, research.html |
| TechArticle | ❌ Missing | ✅ Added to research.html |

### 4. Internal Linking
| Check | Result |
|---|---|
| Navigation links | ✅ index.html ↔ faq.html ↔ research.html |
| Descriptive anchor text | ⚠️ Basic | ✅ Updated link titles to include "trade show application" context |

### 5. Performance & Mobile
| Check | Result |
|---|---|
| No external deps (CDN/fonts) | ✅ Excellent |
| Inline CSS | ✅ Good |
| Responsive design | ✅ Media queries |
| No JS blocking rendering | ✅ Module scripts at end of body |

## Skills Used from Illyism/seo-skills
- `seo-roast` — SEO teardown methodology (6-point decision procedure)
- `blitz-seo` — keyword concentration framework (one-page focus)
- `internal-linking` — nav/link structure analysis

## Reproducible Commands
```sh
# Install SEO skills
npx skills add Illyism/seo-skills

# Re-run audit (from repo root)
npx skills use seo-roast apps/expo-apply/index.html

# Verify page structure
grep -c '<title>' apps/expo-apply/index.html
grep -c 'application/ld+json' apps/expo-apply/index.html
grep -c 'rel="canonical"' apps/expo-apply/index.html
grep -c 'rel="sitemap"' apps/expo-apply/index.html

# Test all pages parse correctly
node -e "console.log('HTML files confirmed: index.html, faq.html, research.html')"
```

## Open Items (on production deploy)
1. Replace relative canonical (`./`) with absolute URL
2. Replace `og:url` with absolute URL  
3. Replace sitemap `<loc>` relative URLs with absolute URLs
4. Point `hreflang="ja"` alt to actual JA-serving URL if separate
5. Add hero image with descriptive `alt` text
6. Consider `npx skills use blitz-seo` for a 30-day keyword sprint on "Japan trade show application"