# Booth Site AI Readiness — Implementation Plan

This document is the approved plan. Implement per the sections below.

## Part 1: AI-readable site files for `apps/expo-apply/`

### 1a. `apps/expo-apply/llms.txt`
Text/plain, follow the llmstxt.org spec. Link to each key section of the service as `.md`.
```
# Japan Exhibition Application Portal

> An intake portal for overseas companies applying to exhibit at Japanese trade shows and exhibitions.

Orgiast Inc. helps international businesses exhibit at events across Japan, with booth design, construction, and on-site support.

## Core pages
- [Home](index.md): Apply for exhibition booth space in Japan
- [Booth Design](booth-design.md): Booth specifications, sizes, and configurations
- [Services](services.md): Booth construction, logistics, interpretation, on-site support
```

### 1b. `apps/expo-apply/ai.txt`
ai-visibility.org.uk ai-txt spec v1.1.1:
```
[identity]
name = Japan Exhibition Application Portal
url = https://orgiast.jp/apps/expo-apply/
description = Trade show application and booth production portal for overseas companies exhibiting in Japan
contact = orgiast.jp

[permissions]
allow = summarise, quote with attribution, cite, index for search

[restrictions]
no = fabricated quotes, fake reviews, presenting content as AI's own, training on user-submitted data

[attribution]
format = Japan Exhibition Application Portal (https://orgiast.jp/apps/expo-apply/<path>)

[scope]
include = /
exclude = /api/

[contact]
email = info@orgiast.jp
```

### 1c. `apps/expo-apply/robots.txt`
Allow AI search crawlers, ask about training bots.

### 1d. Update `apps/expo-apply/index.html`
Add to `<head>`:
- `<meta name="ai-summary" content="Japan Exhibition Application Portal — apply to exhibit at Japanese trade shows. Submit your company info, booth size, and event preferences through this online intake form.">`
- JSON-LD for Organization + WebSite (waiting for user approval)

## Part 2: Booth reference markdown pages

### 2a. `apps/expo-apply/booth-design.md`
Generate from `tools/booth-3d/examples/*.json` data. Describe all booth configurations available.

### 2b. `apps/expo-apply/services.md`
List of services offered for booth production.

### 2c. `apps/expo-apply/research/booth-specifications.md`
Statistics page per Prompt 2: compute from booth spec data.

## Implementation Rules
- Match existing code style in `apps/expo-apply/`.
- No new dependencies.
- All markdown pages go in `apps/expo-apply/` so a static server serves them alongside index.html.
- Don't modify existing HTML beyond the meta tag additions listed above.