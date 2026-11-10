# Prompt: make your whole site readable by AI agents

> Source: https://www.scrolllaunch.com/prompts/ai-readable-site.md
> Retrieved: 2026-11-08
> Original by ScrollLaunch

This prompt makes every public HTML page available as clean markdown for AI crawlers,
plus llms.txt, llms-full.txt, ai.txt, robots.txt updates, and head signals.

## Full prompt text

````markdown
# Task: Make this whole site readable by AI agents (markdown versions of every page + llms.txt + llms-full.txt + ai.txt + head signals)

You're working in my existing web app. Before you write any code, read the codebase and work out:
- the framework and router (e.g. Next.js App Router, Astro, Remix, SvelteKit)
- every public route: static pages, dynamic pages (product/blog/user/category/tag), docs, legal pages
- where the content for each route comes from (DB, CMS, MDX, hardcoded JSX)
- the existing site config (name, URL, description, logo, social links), sitemap, robots.txt and middleware

Then show me a short plan: the route inventory table (route → data source → included in markdown? → included in llms-full?) and the files you'll create. Wait for my OK before you implement.

## Goal

Every public HTML page has a clean markdown version with the same content. AI crawlers and agents can find these versions and fetch them cheaply. Site-level files tell agents who we are, how the site is laid out and how they may use the content.

## 1. A markdown version of every page

### How agents reach it (support all three)
1. **`.md` suffix**: `GET /pricing.md` → markdown of `/pricing`. `GET /index.md` → homepage. `GET /blog/my-post.md` → markdown of `/blog/my-post`.
2. **Content negotiation**: `GET /pricing` with `Accept: text/markdown` → markdown. Parse Accept properly, including q-values. Serve markdown only when text/markdown has a higher q than text/html. `*/*` or a missing Accept header must ALWAYS get HTML, so curl, link previews and normal browsers don't break.
3. **Direct backend URL**: `GET /api/md/<path>` always returns markdown (useful for debugging).

Do this with middleware/edge rewrites to ONE markdown handler. Don't make a separate route file per page.

### Architecture
- One **renderer registry** (e.g. `src/lib/md/registry.ts`) that maps route patterns → renderer functions.
- Shared formatting helpers, HTTP helper, listMarkdownRoutes().
- Return markdown 404 body with status 404 for unknown routes.

### What each markdown page contains
```
# <Page title>

> <one-sentence summary / meta description>

Canonical: https://example.com/<path>
Last updated: YYYY-MM-DD

<main content, in reading order, as real markdown>

## Related
- [Link text](https://example.com/absolute/url)
```

### Response headers
- `Content-Type: text/markdown; charset=utf-8`
- `X-Markdown-Tokens: <approx tokens = chars/4>`
- `X-Robots-Tag: noindex, follow`
- `Content-Location: <canonical HTML URL>`
- `Vary: Accept` (on negotiated responses)
- `Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400`
- CORS: `Access-Control-Allow-Origin: *`
- HEAD returns same headers, no body.

### Head signals
- `<link rel="alternate" type="text/markdown" href="...">` in HTML head
- Global `Link` header advertising llms.txt, llms-full.txt, ai.txt
- `<meta name="ai-summary" content="...">` on every page
- Organization + WebSite JSON-LD on homepage

## 2. /llms.txt (llmstxt.org spec)
- Text/plain, generated from code, list every page as .md link with factual descriptions.

## 3. /llms-full.txt
- Every page concatenated with source comments, under ~500k chars.

## 4. /ai.txt (ai-visibility.org.uk ai-txt v1.1.1)
- Sections: identity, permissions, restrictions, attribution, scope, contact.

## 5. robots.txt
- Allow AI search bots (OAI-SearchBot, ChatGPT-User, Claude-SearchBot, etc.) on public paths.
- Training crawlers: ask user.
- Point to llms.txt and ai.txt.

## 6. Single source of truth
- Site config used everywhere. Adding a page = one step: register a renderer.
- Dev check fails if a public route has no renderer.

## 7. Verification
```sh
curl -sI localhost:3000/pricing.md
curl -s -H 'Accept: text/markdown' localhost:3000/pricing | head -30
curl -sI localhost:3000/pricing
curl -s localhost:3000/llms.txt | head -40
curl -s localhost:3000/ai.txt
curl -s localhost:3000/api/md/_catalog | head
curl -s localhost:3000/robots.txt
curl -s localhost:3000/ | grep -o '<meta name="ai-summary"[^>]*>'
```
````