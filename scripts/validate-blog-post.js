#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const RULES_PATH = path.join(ROOT, "blog-publish-rules.json");

function readFile(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function exists(filePath) {
  return fs.existsSync(filePath);
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function getFirstMatch(content, regex, label) {
  const m = content.match(regex);
  return m ? m[1].trim() : "";
}

function tokenize(text) {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9äöüß ]/gi, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2)
  );
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function extractLinks(html) {
  const links = [];
  const re = /href=["']([^"']+)["']/gi;
  let m = null;
  while ((m = re.exec(html)) !== null) {
    links.push(m[1]);
  }
  return links;
}

function extractArticleMeta(html) {
  const title = getFirstMatch(html, /<title>([^<]+)<\/title>/i);
  const h1 = getFirstMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const description = getFirstMatch(
    html,
    /<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i
  );
  const canonical = getFirstMatch(
    html,
    /<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']/i
  );

  return { title, h1, description, canonical };
}

function fail(errors) {
  console.error("Validation failed:");
  for (const err of errors) {
    console.error(`- ${err}`);
  }
  process.exit(1);
}

function main() {
  if (!exists(RULES_PATH)) {
    console.error("Missing blog-publish-rules.json");
    process.exit(1);
  }

  const rules = JSON.parse(readFile(RULES_PATH));
  const args = process.argv.slice(2);
  const requireIndex = args.includes("--require-index");
  const targetArg = args.find((a) => !a.startsWith("--"));

  if (!targetArg) {
    console.error(
      "Usage: node scripts/validate-blog-post.js public/blog/<slug>.html [--require-index]"
    );
    process.exit(1);
  }

  const targetFile = path.join(ROOT, targetArg);
  if (!exists(targetFile)) {
    console.error(`File not found: ${targetArg}`);
    process.exit(1);
  }

  const html = readFile(targetFile);
  const meta = extractArticleMeta(html);
  const links = extractLinks(html);
  const visibleText = stripTags(html);
  const words = visibleText.split(/\s+/).filter(Boolean).length;

  const errors = [];

  if (!meta.title) errors.push("Missing <title>.");
  if (!meta.description) errors.push("Missing meta description.");
  if (!meta.canonical) errors.push("Missing canonical link.");
  if (!meta.h1) errors.push("Missing H1.");

  for (const type of rules.requiredSchemaTypes || []) {
    if (!new RegExp(`"@type"\\s*:\\s*"${type}"`, "i").test(html)) {
      errors.push(`Missing JSON-LD schema type: ${type}.`);
    }
  }

  if (!links.includes(rules.moneyPagePath)) {
    errors.push(`Missing required money page link: ${rules.moneyPagePath}`);
  }

  const internalBlogLinks = links.filter((l) => l.startsWith("/blog/")).length;
  if (internalBlogLinks < rules.minInternalBlogLinks) {
    errors.push(
      `Not enough internal blog links. Found ${internalBlogLinks}, required ${rules.minInternalBlogLinks}.`
    );
  }

  if (words < rules.minWordCount) {
    errors.push(`Word count too low. Found ${words}, required ${rules.minWordCount}.`);
  }

  const blogDir = path.join(ROOT, rules.blogDir);
  const basename = path.basename(targetFile);
  const targetTokens = tokenize(`${meta.title} ${meta.h1} ${meta.description}`);

  let maxSimilarity = 0;
  let maxFile = "";
  for (const file of fs.readdirSync(blogDir)) {
    if (!file.endsWith(".html") || file === basename) continue;
    const currentPath = path.join(blogDir, file);
    const currentHtml = readFile(currentPath);
    const currentMeta = extractArticleMeta(currentHtml);
    const currentTokens = tokenize(
      `${currentMeta.title} ${currentMeta.h1} ${currentMeta.description}`
    );
    const similarity = jaccard(targetTokens, currentTokens);
    if (similarity > maxSimilarity) {
      maxSimilarity = similarity;
      maxFile = file;
    }
  }

  if (maxSimilarity >= rules.maxTitleSimilarity) {
    errors.push(
      `Potential duplicate topic. Similarity ${maxSimilarity.toFixed(
        2
      )} with ${maxFile} (threshold ${rules.maxTitleSimilarity}).`
    );
  }

  if (requireIndex) {
    const blogIndexPath = path.join(ROOT, rules.blogIndexFile);
    const sitemapPath = path.join(ROOT, rules.sitemapFile);
    const slug = `/blog/${basename}`;

    if (!exists(blogIndexPath) || !exists(sitemapPath)) {
      errors.push("Missing blog index or sitemap file.");
    } else {
      const blogIndex = readFile(blogIndexPath);
      const sitemap = readFile(sitemapPath);
      if (!blogIndex.includes(slug)) {
        errors.push(`Blog index missing URL: ${slug}`);
      }
      const absoluteUrl = `https://nebenkostenretter.de${slug}`;
      if (!sitemap.includes(absoluteUrl)) {
        errors.push(`Sitemap missing URL: ${absoluteUrl}`);
      }
    }
  }

  if (errors.length > 0) {
    fail(errors);
  }

  console.log("Validation passed.");
  console.log(`- file: ${targetArg}`);
  console.log(`- wordCount: ${words}`);
  console.log(`- internalBlogLinks: ${internalBlogLinks}`);
  console.log(`- maxSimilarity: ${maxSimilarity.toFixed(2)}${maxFile ? ` (${maxFile})` : ""}`);
}

main();
