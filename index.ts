import fs from "node:fs/promises";
import path from "node:path";
import puppeteer, { Browser, Page } from "puppeteer";

const OUT_DIR = "./medium_recommended";
await fs.mkdir(OUT_DIR, { recursive: true });

interface ParsedArgs {
  tags: string[];
  scrolls: number;
  minClaps: number;
  limit: number;
  include: string[];
  exclude: string[];
  headless: boolean;
}

interface Article {
  url: string | null;
  title: string | null;
  createdAt: string;
  claps: number | null;
  comments: number | null;
  tag: string;
}

interface RawArticle {
  url: string | null;
  title: string | null;
  datetime: string | null;
  timeLabel: string | null;
  claps: number | null;
  comments: number | null;
}

interface Metrics {
  claps: number | null;
  comments: number | null;
}

interface MergeResult {
  merged: Article[];
  newCount: number;
  updatedCount: number;
}

interface ScrapeOptions {
  scrolls: number;
  minClaps: number;
  limit: number;
  include: string[];
  exclude: string[];
  headless: boolean;
  browser: Browser;
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error("Usage: node index.js <tag1,tag2,tag3> [--scrolls N] [--minClaps N] [--limit N] [--include kw1,kw2] [--exclude kw1,kw2] [--headless true|false]");
    process.exit(1);
  }
  const tags = args[0].split(",").map(t => t.trim()).filter(Boolean);
  let scrolls = 6, minClaps = 0, limit = 30, include: string[] = [], exclude: string[] = [], headless = true;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--scrolls")   scrolls   = Number(args[++i] ?? "6")  || 6;
    else if (a === "--minClaps") minClaps = Number(args[++i] ?? "0")  || 0;
    else if (a === "--limit")    limit    = Number(args[++i] ?? "30") || 30;
    else if (a === "--include")  include  = (args[++i] || "").split(",").map(s => s.trim()).filter(Boolean);
    else if (a === "--exclude")  exclude  = (args[++i] || "").split(",").map(s => s.trim()).filter(Boolean);
    else if (a === "--headless") headless = String(args[++i]).toLowerCase() !== "false";
  }
  return { tags, scrolls, minClaps, limit, include, exclude, headless };
}

function monthStamp(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function includesAny(text: string | null, kws: string[]): boolean {
  if (!kws.length) return true;
  const low = (text || "").toLowerCase();
  return kws.some(k => low.includes(k.toLowerCase()));
}

function excludesAll(text: string | null, kws: string[]): boolean {
  if (!kws.length) return true;
  const low = (text || "").toLowerCase();
  return !kws.some(k => low.includes(k.toLowerCase()));
}

function parseDateLikeToISO(label: string | null): string | null {
  if (!label) return null;
  const s = String(label).trim();
  const now = new Date();
  let m: RegExpMatchArray | null;

  if ((m = s.match(/(\d+)\s*d(?:ay)?s?\s*ago/i))) {
    const d = new Date(now);
    d.setDate(now.getDate() - Number(m[1]));
    return d.toISOString();
  }
  if ((m = s.match(/(\d+)\s*h(?:our)?s?\s*ago/i))) {
    const d = new Date(now);
    d.setHours(now.getHours() - Number(m[1]));
    return d.toISOString();
  }
  if ((m = s.match(/(\d+)\s*m(?:in)?(?:ute)?s?\s*ago/i))) {
    const d = new Date(now);
    d.setMinutes(now.getMinutes() - Number(m[1]));
    return d.toISOString();
  }

  if (/yesterday/i.test(s)) {
    const d = new Date(now);
    d.setDate(now.getDate() - 1);
    return d.toISOString();
  }

  if ((m = s.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})(?:,\s*(\d{4}))?/i))) {
    const monthMap: Record<string, number> = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
    const mm = monthMap[m[1].slice(0,3).toLowerCase()];
    const dd = Number(m[2]);
    const yyyy = m[3] ? Number(m[3]) : now.getFullYear();
    const d = new Date(yyyy, mm, dd);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  return null;
}

async function autoScroll(page: Page, maxScrolls: number = 10, waitForLoad: number = 2500): Promise<void> {
  let previousHeight = await page.evaluate("document.body.scrollHeight");
  for (let i = 0; i < maxScrolls; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(waitForLoad);

    await sleep(500);

    const newHeight = await page.evaluate("document.body.scrollHeight");
    console.log(`Scroll ${i + 1}: height ${previousHeight} -> ${newHeight}`);
    if (newHeight === previousHeight) {
      await sleep(1000);
      const finalHeight = await page.evaluate("document.body.scrollHeight");
      if (finalHeight === previousHeight) break;
      previousHeight = finalHeight;
    } else {
      previousHeight = newHeight;
    }
  }
}

function normalizeArticleUrl(absUrl: string | null): string | null {
  try {
    if (!absUrl) return null;
    const u = new URL(absUrl);
    u.search="";
    u.hash="";
    return u.toString();
  } catch {
    return null;
  }
}

async function extractFromPage(page: Page): Promise<RawArticle[]> {
  return await page.evaluate(() => {
    const toAbs = (href: string): string | null => {
      try {
        return new URL(href, location.origin).toString();
      } catch {
        return null;
      }
    };

    const toNum = (s: string | null): number | null => {
      if (!s) return null;
      const cleaned = String(s).replace(/[^\d.kKmM]/g, '');
      const m = /(\d+(?:\.\d+)?)([kKmM]?)/.exec(cleaned);
      if (!m) return null;
      const n = Number(m[1]);
      const suf = (m[2] || "").toLowerCase();
      if (suf === "k") return Math.round(n * 1_000);
      if (suf === "m") return Math.round(n * 1_000_000);
      return Math.round(n);
    };

    const findMetrics = (articleEl: Element): { claps: number | null; comments: number | null } => {
      let claps: number | null = null;
      let comments: number | null = null;

      const clapElements = Array.from(articleEl.querySelectorAll('[aria-label*="clap"], [title*="clap"], [data-testid*="clap"]'));
      for (const el of clapElements) {
        const label = (el.getAttribute('aria-label') || el.getAttribute('title') || '').toLowerCase();
        if (label.includes('clap')) {
          const match = label.match(/(\d+(?:\.\d+)?[kKmM]?)/);
          if (match) {
            claps = toNum(match[1]);
            break;
          }
        }
      }

      if (claps === null) {
        const svgs = Array.from(articleEl.querySelectorAll('svg'));
        for (const svg of svgs) {
          const parent = svg.closest('div, span, button');
          if (parent) {
            const text = parent.textContent?.trim() || '';
            const numMatch = text.match(/^\d+(?:\.\d+)?[kKmM]?$/);
            if (numMatch) {
              const num = toNum(numMatch[0]);
              if (num !== null && !isNaN(num)) {
                const svgContent = svg.innerHTML.toLowerCase();
                const parentLabel = (parent.getAttribute('aria-label') || '').toLowerCase();

                if (parentLabel.includes('clap') || svgContent.includes('clap')) {
                  claps = toNum(numMatch[0]);
                } else if (parentLabel.includes('comment') || parentLabel.includes('response')) {
                  comments = toNum(numMatch[0]);
                } else if (claps === null) {
                  claps = toNum(numMatch[0]);
                } else if (comments === null) {
                  comments = toNum(numMatch[0]);
                }
              }
            }
          }
        }
      }

      const buttons = Array.from(articleEl.querySelectorAll('button, [role="button"]'));
      for (const btn of buttons) {
        const text = btn.textContent?.trim() || '';
        const label = (btn.getAttribute('aria-label') || '').toLowerCase();

        if ((label.includes('clap') || text.match(/^\d+$/)) && claps === null) {
          const num = toNum(text);
          if (num !== null) claps = num;
        }
        if ((label.includes('comment') || label.includes('response')) && comments === null) {
          const num = toNum(text);
          if (num !== null) comments = num;
        }
      }

      if (claps === null) {
        const textNodes: string[] = [];
        const walker = document.createTreeWalker(
          articleEl,
          NodeFilter.SHOW_TEXT
        );
        let node: Node | null;
        while (node = walker.nextNode()) {
          const text = node.textContent?.trim();
          if (text && /^\d+(?:\.\d+)?[kKmM]?$/.test(text)) {
            textNodes.push(text);
          }
        }
        if (textNodes.length > 0 && claps === null) {
          claps = toNum(textNodes[0]);
        }
        if (textNodes.length > 1 && comments === null) {
          comments = toNum(textNodes[1]);
        }
      }

      return { claps, comments };
    };

    const results: RawArticle[] = [];

    const selectors = [
      'article',
      '[data-testid*="article"]',
      '.streamItem',
      '[class*="story"]',
      '[class*="post"]'
    ];

    const articles = new Set<Element>();
    selectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => articles.add(el));
    });

    articles.forEach(art => {
      let url: string | null = null;
      const links = Array.from(art.querySelectorAll('a[href]'));
      for (const a of links) {
        const href = a.getAttribute("href");
        if (!href) continue;

        const abs = toAbs(href);
        if (!abs) continue;

        if (!/medium\.com/.test(abs)) continue;

        try {
          const urlObj = new URL(abs);
          const p = urlObj.pathname;

          if (
            /^\/p\/[a-zA-Z0-9]+/.test(p) ||
            /^\/@[^/]+\/[^/]+-[a-f0-9]{6,}$/.test(p) ||
            /^\/[^/]+\/[^/]+-[a-f0-9]{6,}$/.test(p) ||
            /^\/@[^/]+\/[^/]+$/.test(p) ||
            /^\/[^/@][^/]*\/[^/]+$/.test(p)
          ) {
            url = abs;
            break;
          }
        } catch {}
      }
      if (!url) return;

      let title: string | null = null;
      const titleSelectors = ['h1', 'h2', 'h3', 'h4', 'h5', '[data-testid*="title"]', '.title'];
      for (const sel of titleSelectors) {
        const titleEl = art.querySelector(sel);
        if (titleEl && titleEl.textContent?.trim()) {
          title = titleEl.textContent.trim();
          break;
        }
      }

      let datetime: string | null = null;
      let timeLabel: string | null = null;
      const timeSelectors = ['time', '[datetime]', '.timestamp', '[data-testid*="time"]'];
      for (const sel of timeSelectors) {
        const timeEl = art.querySelector(sel);
        if (timeEl) {
          datetime = timeEl.getAttribute("datetime");
          timeLabel = timeEl.textContent?.trim() || null;
          if (datetime || timeLabel) break;
        }
      }

      const { claps, comments } = findMetrics(art);

      results.push({ url, title, datetime, timeLabel, claps, comments });
    });

    return results;
  });
}

async function scrapeTag(tag: string, options: ScrapeOptions): Promise<Article[]> {
  const { scrolls, minClaps, limit, include, exclude, headless, browser } = options;
  const startUrl = `https://medium.com/tag/${encodeURIComponent(tag)}/recommended`;

  const page = await browser.newPage();

  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  await page.setExtraHTTPHeaders({
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
  });
  await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

  console.log(`\n=== Processing tag: ${tag} ===`);
  console.log(`Loading: ${startUrl}`);

  try {
    await page.goto(startUrl, { waitUntil: "networkidle2", timeout: 120000 });
    await sleep(2000);

    try {
      const acceptButton = await page.$('button:has-text("Accept"), button[data-testid*="accept"], button:has-text("OK")');
      if (acceptButton) {
        await acceptButton.click();
        await sleep(1000);
      }
    } catch (e) {}

    await sleep(1000);
    await autoScroll(page, scrolls, 2500);
    await sleep(3000);

    let items = await extractFromPage(page);
    console.log(`Extracted ${items.length} items for tag "${tag}" before filtering`);

    const normalized = items.map(x => ({
      url: normalizeArticleUrl(x.url),
      title: x.title,
      createdAt: new Date().toISOString(),
      claps: x.claps ?? null,
      comments: x.comments ?? null,
      tag
    }))
    .filter((x): x is Article => x.url !== null)
    .filter(x => includesAny(x.title || "", include))
    .filter(x => excludesAll(x.title || "", exclude))
    .filter(x => (x.claps == null ? true : x.claps >= minClaps))
    .sort((a, b) => (b.claps ?? 0) - (a.claps ?? 0))
    .slice(0, limit);

    await page.close();
    return normalized;

  } catch (error) {
    console.error(`Error processing tag "${tag}":`, (error as Error).message);
    await page.close();
    return [];
  }
}

async function loadExistingData(filePath: string): Promise<Record<string, Article[]>> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

function mergeArticles(existing: Record<string, Article[]>, newArticles: Article[], tag: string): MergeResult {
  const existingArticles = existing[tag] || [];
  const existingUrls = new Map(existingArticles.map(a => [a.url, a]));

  let newCount = 0;
  let updatedCount = 0;

  const merged = [...newArticles];

  newArticles.forEach(newArticle => {
    if (existingUrls.has(newArticle.url)) {
      const existing = existingUrls.get(newArticle.url)!;
      existing.claps = newArticle.claps;
      existing.comments = newArticle.comments;
      updatedCount++;
    } else {
      newCount++;
    }
  });

  existingArticles.forEach(existing => {
    if (!newArticles.some(n => n.url === existing.url)) {
      merged.push(existing);
    }
  });

  merged.sort((a, b) => (b.claps ?? 0) - (a.claps ?? 0));

  return { merged, newCount, updatedCount };
}

async function main(): Promise<void> {
  const { tags, scrolls, minClaps, limit, include, exclude, headless } = parseArgs();

  const browser = await puppeteer.launch({
    headless,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-features=VizDisplayCompositor"
    ],
  });

  const outputFile = path.join(OUT_DIR, `medium-articles-${monthStamp()}.json`);
  const existingData = await loadExistingData(outputFile);

  console.log(`Processing ${tags.length} tags: ${tags.join(", ")}`);
  console.log(`Output file: ${outputFile}`);

  for (const tag of tags) {
    try {
      const articles = await scrapeTag(tag, {
        scrolls, minClaps, limit, include, exclude, headless, browser
      });

      const { merged, newCount, updatedCount } = mergeArticles(existingData, articles, tag);
      existingData[tag] = merged;

      console.log(`Tag "${tag}": ${newCount} new, ${updatedCount} updated, ${merged.length} total articles`);

      await fs.writeFile(outputFile, JSON.stringify(existingData, null, 2), "utf-8");

    } catch (error) {
      console.error(`Failed to process tag "${tag}":`, (error as Error).message);
    }
  }

  await browser.close();

  console.log(`\n=== Summary ===`);
  console.log(`Saved → ${outputFile}`);

  Object.entries(existingData).forEach(([tag, articles]) => {
    console.log(`\n--- ${tag.toUpperCase()} (${articles.length} articles) ---`);

    articles.slice(0, 10).forEach((a, i) => {
      const clapsStr = a.claps !== null ? a.claps.toLocaleString() : "-";
      const commentsStr = a.comments !== null ? a.comments.toLocaleString() : "-";
      const dateStr = a.createdAt ? new Date(a.createdAt).toLocaleDateString() : "-";
      console.log(`${String(i + 1).padStart(2,"0")}. ${a.title || "(no title)"}`);
      console.log(`    👏 ${clapsStr} | 💬 ${commentsStr} | 📅 ${dateStr}`);
      console.log(`    🔗 ${a.url}`);
      console.log("");
    });

    if (articles.length > 10) {
      console.log(`    ... and ${articles.length - 10} more articles`);
    }
  });
}

main().catch(e => { console.error(e); process.exit(1); });