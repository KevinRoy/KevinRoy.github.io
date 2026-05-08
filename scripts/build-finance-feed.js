const fs = require("fs/promises");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const FEEDS_PATH = path.join(ROOT, "data", "finance-feeds.json");
const OUTPUT_PATH = path.join(ROOT, "finance", "index.html");
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

function atomLink(block, feedUrl) {
  const hrefMatch = block.match(/<link[^>]+href=["']([^"']+)["'][^>]*>/i);
  if (hrefMatch) return absolutizeUrl(decodeEntities(hrefMatch[1]), feedUrl);
  return firstTag(block, "link");
}

function parseDate(value) {
  const time = Date.parse(cleanText(value));
  return Number.isNaN(time) ? 0 : time;
}

function parseFeed(xml, feed) {
  const itemMatches = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)];
  const entryMatches = [...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)];
  const blocks = itemMatches.length ? itemMatches.map((m) => m[0]) : entryMatches.map((m) => m[0]);
  const isAtom = !itemMatches.length;

  return blocks.map((block) => {
    const title = firstTag(block, "title");
    const link = isAtom ? atomLink(block, feed.url) : absolutizeUrl(firstTag(block, "link"), feed.url);
    const date = parseDate(
      firstTag(block, "pubDate") ||
      firstTag(block, "published") ||
      firstTag(block, "updated") ||
      firstTag(block, "dc:date")
    );

    return {
      title,
      link,
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
          <a class="finance-item" href="${escapeHtml(item.link)}" target="_blank" rel="noopener">
            <span>${escapeHtml(item.title)}</span>
            <time>${escapeHtml(formatDate(item.date))}</time>
          </a>`).join("");
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

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>金融消息 | 有时放纵</title>
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
  <meta name="description" content="金融消息聚合">
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
                    <li><a class="nav-tab" href="/">IT</a></li>
                    <li><a class="nav-tab nav-tab-active" href="/finance/">金融</a></li>
                    <li><a class="nav-tab" href="/game/">游戏</a></li>
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
          <a class="section-tab" href="/">IT</a>
          <a class="section-tab section-tab-active" href="/finance/">金融</a>
          <a class="section-tab" href="/game/">游戏</a>
        </div>

        <section class="finance-header">
          <h1>金融消息</h1>
          <p>自动聚合公开 RSS 来源，只展示标题、来源、时间和原文链接。更新时间：${escapeHtml(generatedAt)}</p>
        </section>
${sections || `
        <section class="finance-section">
          <h2>暂无内容</h2>
          <p>还没有抓取到金融消息，请稍后再试。</p>
        </section>`}
${errorBlock}
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
  const limited = items.slice(0, MAX_ITEMS);

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
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
