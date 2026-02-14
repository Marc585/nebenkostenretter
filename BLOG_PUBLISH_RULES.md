# Blog Publish Rules

This file defines the mandatory checks before a new SEO article is published.

## Goal
- Avoid duplicate topics and keyword cannibalization.
- Keep quality stable.
- Ensure every article pushes conversion traffic to the money page.

## Mandatory checks
1. Unique angle
- New article title and core intent must not duplicate existing blog articles.
- Similarity threshold is enforced by `maxTitleSimilarity` in `blog-publish-rules.json`.

2. Required SEO metadata
- `<title>` exists
- `<meta name="description">` exists
- `<link rel="canonical">` exists

3. Required schema
- `Article` JSON-LD is present
- `BreadcrumbList` JSON-LD is present

4. Conversion link
- Article must contain at least one link to `/nebenkostenabrechnung-pruefen.html`.

5. Internal linking
- Article must contain at least 2 internal links to `/blog/...`.

6. Minimum content depth
- Minimum word count: 250 words of visible text.

7. Publish integration
- New URL must be added in:
  - `public/blog.html`
  - `public/sitemap.xml`

## Validation command
Run this before publishing a new article:

```bash
npm run validate:blog -- public/blog/<slug>.html --require-index
```

Examples:

```bash
npm run validate:blog -- public/blog/nebenkostenabrechnung-nachzahlung-zu-hoch.html --require-index
npm run validate:blog -- public/blog/belegeinsicht-nebenkosten-anfordern-muster.html --require-index
```
