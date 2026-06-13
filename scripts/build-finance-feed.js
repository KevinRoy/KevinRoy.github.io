const fs = require("fs/promises");
const crypto = require("crypto");
const path = require("path");
const { translateItems } = require("./lib/translate");

const ROOT = path.resolve(__dirname, "..");
const FEEDS_PATH = path.join(ROOT, "data", "finance-feeds.json");
const OUTPUT_PATH = path.join(ROOT, "finance", "index.html");
const ARTICLES_DIR = path.join(ROOT, "finance", "articles");
const MAX_ITEMS = 60;

const entityMap = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(value) {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (_, entity) => {
    if (entity[0] === "#") {
      const code = entity[1].toLowerCase() === "x"
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    }
    return entityMap[entity] || _;
  });
}

function stripCdata(value) {
  return value.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

function stripTags(value) {
  return value.replace(/<[^>]*>/g, "");
}

function stripScripts(value) {
  return value
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "");
}

function cleanText(value = "") {
  return decodeEntities(stripTags(stripCdata(value))).replace(/\s+/g, " ").trim();
}

function escapeHtml(value = "") {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function absolutizeUrl(url, feedUrl) {
  if (!url) return "";
  try {
    return new URL(url, feedUrl).toString();
  } catch {
    return url;
  }
}

function firstTag(block, tagName) {
  const match = block.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match ? cleanText(match[1]) : "";
}

function itemSlug(item) {
  return crypto.createHash("sha1").update(item.link).digest("hex").slice(0, 12);
}

function atomLink(block, feedUrl) {
  const hrefMatch = block.match(/<link[^>]+href=["']([^"']+)["'][^>]*>/i);
  if (hrefMatch) return absolutizeUrl(decodeEntities(hrefMatch[1]), feedUrl);
  return firstTag(block, "link");
}

function parseDate(value) {
  const time = Date.parse(cleanText(value));
  return Number.isNaN(time) ? 0 : time;
}

function paragraphTexts(html) {
  return [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((match) => cleanText(match[1]))
    .filter((text) => text.length > 40 && !/^(subscribe|related|for immediate release)$/i.test(text));
}

function extractOfficialContent(html, link) {
  const cleanHtml = stripScripts(html);
  const url = new URL(link);
  let scoped = cleanHtml;

  if (url.hostname.includes("federalreserve.gov")) {
    const articleMatch = cleanHtml.match(/<div[^>]+id=["']article["'][^>]*>([\s\S]*?)<footer/i) ||
      cleanHtml.match(/<div[^>]+class=["'][^"']*col-xs-12[^"']*["'][^>]*>([\s\S]*?)<\/main>/i);
    scoped = articleMatch ? articleMatch[1] : cleanHtml;
  }

  if (url.hostname.includes("sec.gov")) {
    const articleMatch = cleanHtml.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i) ||
      cleanHtml.match(/<div[^>]+class=["'][^"']*field--name-body[^"']*["'][^>]*>([\s\S]*?)<\/div>/i) ||
      cleanHtml.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
    scoped = articleMatch ? articleMatch[1] : cleanHtml;
  }

  const paragraphs = paragraphTexts(scoped)
    .filter((text) => !/^(last update|media contact|investor contact)/i.test(text))
    .slice(0, 3);
  return paragraphs.join("\n\n").slice(0, 900);
}

async function fetchOfficialContent(item) {
  const url = new URL(item.link);
  const isOfficial = url.hostname.includes("federalreserve.gov") || url.hostname.includes("sec.gov");
  if (!isOfficial) return "";

  const response = await fetch(item.link, {
    headers: {
      "user-agent": "KevinRoy.github.io finance article builder (contact: https://github.com/KevinRoy)",
      "accept": "text/html,application/xhtml+xml,*/*",
    },
  });

  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return extractOfficialContent(await response.text(), item.link);
}

function parseFeed(xml, feed) {
  const itemMatches = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)];
  const entryMatches = [...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)];
  const blocks = itemMatches.length ? itemMatches.map((m) => m[0]) : entryMatches.map((m) => m[0]);
  const isAtom = !itemMatches.length;

  return blocks.map((block) => {
    const title = firstTag(block, "title");
    const link = isAtom ? atomLink(block, feed.url) : absolutizeUrl(firstTag(block, "link"), feed.url);
    const summary = firstTag(block, "description") ||
      firstTag(block, "summary") ||
      firstTag(block, "content:encoded") ||
      firstTag(block, "content");
    const date = parseDate(
      firstTag(block, "pubDate") ||
      firstTag(block, "published") ||
      firstTag(block, "updated") ||
      firstTag(block, "dc:date")
    );

    return {
      title,
      link,
      summary,
      date,
      source: feed.name,
      category: feed.category,
    };
  }).filter((item) => item.title && item.link);
}

async function fetchFeed(feed) {
  const response = await fetch(feed.url, {
    headers: {
      "user-agent": "KevinRoy.github.io finance feed builder (contact: https://github.com/KevinRoy)",
      "accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
    },
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return parseFeed(await response.text(), feed);
}

function formatDate(timestamp) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date).replace(/\//g, "-");
}

function groupItems(items) {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.category)) groups.set(item.category, []);
    groups.get(item.category).push(item);
  }
  return groups;
}

function renderFinanceItems(items) {
  return items.map((item) => `
          <a class="finance-item" href="${escapeHtml(item.localUrl)}">
            <span${item.originalTitle ? ` title="${escapeHtml(item.originalTitle)}"` : ""}>${escapeHtml(item.title)}</span>
            <time>${escapeHtml(formatDate(item.date))}</time>
          </a>`).join("");
}

function renderShell({ title, description, activeNav, activeSection, body }) {
  const navActive = (name) => activeNav === name ? " nav-tab-active" : "";
  const sectionActive = (name) => activeSection === name ? " section-tab-active" : "";

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)} | 有时放纵</title>
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
  <meta name="description" content="${escapeHtml(description)}">
  <link rel="icon" type="image/x-icon" href="/favicon.ico">
  <link rel="stylesheet" href="/css/style.css" type="text/css">
</head>
<body>
  <div id="container">
    <div class="left-col">
      <div class="overlay"></div>
      <div class="intrude-less">
        <header id="header" class="inner">
          <hgroup>
            <h1 class="header-author"><a href="/">Kevin Roy</a></h1>
          </hgroup>
          <div class="switch-area">
            <div class="switch-wrap">
              <section class="switch-part switch-part1">
                <nav class="header-menu">
                  <ul>
                    <li><a class="nav-tab${navActive("it")}" href="/">IT</a></li>
                    <li><a class="nav-tab" href="/ai/">AI</a></li>
                    <li><a class="nav-tab${navActive("finance")}" href="/finance/">金融</a></li>
                    <li><a class="nav-tab${navActive("game")}" href="/game/">游戏</a></li>
                    <li><a class="nav-tab" href="/archives">归档</a></li>
                  </ul>
                </nav>
              </section>
            </div>
          </div>
        </header>
      </div>
    </div>

    <div class="mid-col">
      <div class="body-wrap finance-wrap">
        <div class="section-tabs" aria-label="内容版块">
          <a class="section-tab${sectionActive("it")}" href="/">IT</a>
          <a class="section-tab" href="/ai/">AI</a>
          <a class="section-tab${sectionActive("finance")}" href="/finance/">金融</a>
          <a class="section-tab${sectionActive("game")}" href="/game/">游戏</a>
        </div>
${body}
      </div>

      <footer id="footer">
        <div class="outer">
          <div id="footer-info">
            <div class="footer-left">&copy; 2016 Kevin Roy</div>
          </div>
        </div>
      </footer>
    </div>
  </div>
</body>
</html>
`;
}

function renderPage(items, errors) {
  const generatedAt = formatDate(Date.now());
  const groups = groupItems(items);
  const sections = [...groups.entries()].map(([category, group]) => `
        <section class="finance-section">
          <h2>${escapeHtml(category)}</h2>${renderFinanceItems(group)}
        </section>`).join("\n");

  const errorBlock = errors.length ? `
        <section class="finance-note">
          <h2>暂时不可用的来源</h2>
          <p>${escapeHtml(errors.map((error) => `${error.name}: ${error.message}`).join("；"))}</p>
        </section>` : "";

  return renderShell({
    title: "金融消息",
    description: "金融消息聚合",
    activeNav: "finance",
    activeSection: "finance",
    body: `
        <section class="finance-header">
          <h1>金融消息</h1>
          <p>自动聚合公开 RSS 来源，标题和摘要会在构建时翻译为中文。更新时间：${escapeHtml(generatedAt)}</p>
        </section>
${sections || `
        <section class="finance-section">
          <h2>暂无内容</h2>
          <p>还没有抓取到金融消息，请稍后再试。</p>
        </section>`}
${errorBlock}
`,
  });
}

function renderArticlePage(item) {
  const body = item.content || item.summary || "这个来源只提供标题或摘要信息，暂无可展示的正文内容。";
  const bodyParagraphs = String(body).split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean);
  return renderShell({
    title: item.title,
    description: item.title,
    activeNav: "finance",
    activeSection: "finance",
    body: `
        <article class="feed-detail">
          <p class="feed-detail-back"><a href="/finance/">返回金融消息</a></p>
          <header class="feed-detail-header">
            <h1>${escapeHtml(item.title)}</h1>
            <p>${escapeHtml(formatDate(item.date))} · ${escapeHtml(item.source)}</p>
          </header>
          <div class="feed-detail-body">
            ${bodyParagraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("\n            ")}
          </div>
          <p class="feed-detail-source"><a href="${escapeHtml(item.link)}" target="_blank" rel="noopener">查看原文</a></p>
        </article>
`,
  });
}

async function writeArticlePages(items) {
  await fs.rm(ARTICLES_DIR, { recursive: true, force: true });
  await fs.mkdir(ARTICLES_DIR, { recursive: true });

  await Promise.all(items.map(async (item) => {
    const dir = path.join(ARTICLES_DIR, item.slug);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "index.html"), renderArticlePage(item), "utf8");
  }));
}

async function main() {
  const feeds = JSON.parse(await fs.readFile(FEEDS_PATH, "utf8"));
  const results = await Promise.allSettled(feeds.map(fetchFeed));
  const errors = [];
  const seen = new Set();
  const items = [];

  results.forEach((result, index) => {
    const feed = feeds[index];
    if (result.status === "rejected") {
      errors.push({ name: feed.name, message: result.reason.message });
      return;
    }

    for (const item of result.value) {
      const key = item.link.replace(/#.*$/, "");
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  });

  items.sort((a, b) => b.date - a.date);
  const enriched = await Promise.all(items.slice(0, MAX_ITEMS).map(async (item) => {
    try {
      const content = await fetchOfficialContent(item);
      return content ? { ...item, content } : item;
    } catch (error) {
      console.warn(`Content skipped: ${item.title} (${error.message})`);
      return item;
    }
  }));

  const limited = (await translateItems(enriched, "finance")).map((item) => {
    const slug = itemSlug(item);
    return { ...item, slug, localUrl: `/finance/articles/${slug}/` };
  });

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeArticlePages(limited);
  await fs.writeFile(OUTPUT_PATH, renderPage(limited, errors), "utf8");

  console.log(`Generated ${path.relative(ROOT, OUTPUT_PATH)} with ${limited.length} items.`);
  if (errors.length) {
    console.warn(`Skipped ${errors.length} feeds: ${errors.map((error) => error.name).join(", ")}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
