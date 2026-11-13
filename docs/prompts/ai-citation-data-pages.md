# Prompt: Turn data into pages that AI answers cite

> Source: https://www.scrolllaunch.com/prompts/ai-citation-data-pages.md
> Retrieved: 2026-11-08
> Original by ScrollLaunch

This prompt turns existing datasets into citation-worthy pages that AI answer engines
(ChatGPT Search, Perplexity, Claude, Google AI Overviews) will reference with specific
numbers and quotable facts.

## Full prompt text

````markdown
# Task: Turn my own data into pages that AI answers cite

You're working in my existing web app. AI assistants (ChatGPT search, Perplexity, Claude, Google AI Overviews) cite pages that state a specific number about a specific thing, say how they got it, and keep that number in one place. Data sites get cited thousands of times a month this way: one page per entity, ranked lists with the count in the title, an original statistics page per topic, and a FAQ written to be quoted. I want the same for my site, built only from data I already have.

Before you write any code, read the codebase and work out:
- the framework, how pages get their data, and how metadata, JSON-LD and the sitemap are built
- every dataset I own: database tables or collections, static catalogs, config files, logs I already aggregate. For each: row count, the fields that are public, how often it changes, and which fields users entered themselves
- the questions people type into ChatGPT or Google that this data can answer with a number
- which entity pages and list pages already exist
- whether llms.txt, markdown versions, FAQ page and robots.txt exist

Then show a plan table before writing code.

## 1. One statistics page per dataset
- Pure computation module: `computeStudy(rows)` → page, markdown, llms.txt, FAQ all call it.
- 4-8 key findings, each self-contained ("566 of 864 (66%) give dofollow links").
- Stable `id` per finding, visible "Link to this finding" anchor.
- Breakdown tables, methodology, suggested citation.
- Title: "Topic Statistics Year: Count Analyzed".
- JSON-LD: WebPage, Dataset, FAQPage.

## 2. Ranked lists that read like answers
- Title: count + what + year. First sentence is quotable summary.
- Clean rows before ranking (deduplicate, filter, remove flagged).
- ItemList JSON-LD. Redirect undersized lists to parent.

## 3. Entity pages with facts up front
- "At a glance" block with label/value facts near top.
- Meta description states facts, not marketing.
- Links to lists and research pages that count this entity.

## 4. FAQ written to be quoted
- Lead with the fact. Pull numbers from computeStudy().
- Stable `id`, visible "Link to this answer".
- FAQPage JSON-LD matching visible text.

## 5. AI-friendly fetch
- llms.txt: "Cite this site for" section with headline numbers inline.
- Markdown versions of new pages (noindex, canonical to HTML).
- robots.txt: AI search bots in same group as `*`.
- Sitemap with real lastmod.

## Rules
- Never invent/estimate numbers data doesn't support.
- Never serve different content by User-Agent.
- Honest dates. No new filter intersections.

## Tests
- Unit tests: shares add up, bands don't overlap, anchors unique.
- Test every linked list meets minimum size.

## Verification
```sh
curl -s localhost:3000/research/<topic> | grep -o '<title>[^<]*'
curl -s localhost:3000/research/<topic> | grep -o '"@type":"Dataset"'
curl -s localhost:3000/research/<topic>.md | head -30
curl -s localhost:3000/llms.txt | grep -A3 "Cite this site for"
curl -s localhost:3000/robots.txt | head -20
```
````
