const fs = require("fs/promises");
const crypto = require("crypto");
const https = require("https");
const path = require("path");
const { translateItems } = require("./lib/translate");

const ROOT = path.resolve(__dirname, "..");
const FEEDS_PATH = path.join(ROOT, "data", "game-feeds.json");
const OUTPUT_PATH = path.join(ROOT, "game", "index.html");
const ARTICLES_DIR = path.join(ROOT, "game", "articles");
const MAX_ITEMS = 80;
const GDELT_ENDPOINT = "https://api.gdeltproject.org/api/v2/doc/doc";
const GDELT_DELAY_MS = 5500;

const entityMap = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(value = "") {
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

function cleanText(value = "") {
  return decodeEntities(String(value).replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function itemSlug(item) {
  return crypto.createHash("sha1").update(item.link).digest("hex").slice(0, 12);
}

function parseDate(value) {
  if (!value) return 0;
  if (typeof value === "number") return value * 1000;
  const text = String(value);
  const gdeltMatch = text.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (gdeltMatch) {
    const [, year, month, day, hour, minute, second] = gdeltMatch;
    return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  }
  const time = Date.parse(text);
  return Number.isNaN(time) ? 0 : time;
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestJson(url, redirects = 2) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      timeout: 45000,
      headers: {
        "user-agent": "KevinRoy.github.io game feed builder (contact: https://github.com/KevinRoy)",
        "accept": "application/json, text/plain, */*",
      },
    }, (response) => {
      const location = response.headers.location;
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && location && redirects > 0) {
        response.resume();
        resolve(requestJson(new URL(location, url), redirects - 1));
        return;
      }

      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`${response.statusCode} ${response.statusMessage}`));
          return;
        }

        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`Invalid JSON: ${error.message}`));
        }
      });
    });

    request.on("timeout", () => {
      request.destroy(new Error("request timeout"));
    });
    request.on("error", reject);
  });
}

async function fetchJson(url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await requestJson(url);
    } catch (error) {
      if (attempt === retries) throw error;
    }

    await delay(2500 * (attempt + 1));
  }
}

async function fetchSteam(feed) {
  const url = new URL("https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/");
  url.searchParams.set("appid", String(feed.appid));
  url.searchParams.set("count", "10");
  const data = await fetchJson(url);
  const items = data.appnews && Array.isArray(data.appnews.newsitems) ? data.appnews.newsitems : [];

  return items.map((item) => ({
    title: `${feed.name}: ${cleanText(item.title)}`,
    link: item.url,
    content: cleanText(item.contents || "").slice(0, 900),
    date: parseDate(item.date),
    source: "Steam",
    category: feed.category,
  })).filter((item) => item.title && item.link);
}

async function fetchGdelt(feed) {
  const url = new URL(GDELT_ENDPOINT);
  url.searchParams.set("query", feed.query);
  url.searchParams.set("mode", "ArtList");
  url.searchParams.set("format", "json");
  url.searchParams.set("maxrecords", "30");
  url.searchParams.set("sort", "HybridRel");
  url.searchParams.set("timespan", "7d");
  const data = await fetchJson(url);
  const articles = Array.isArray(data.articles) ? data.articles : [];

  return articles.map((article) => ({
    title: cleanText(article.title),
    link: article.url,
    summary: "",
    date: parseDate(article.seendate || article.datetime),
    source: cleanText(article.domain || feed.name),
    category: feed.category,
  })).filter((item) => item.title && item.link);
}

function groupItems(items) {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.category)) groups.set(item.category, []);
    groups.get(item.category).push(item);
  }
  return groups;
}

function renderItems(items) {
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
          <h2>${escapeHtml(category)}</h2>${renderItems(group)}
        </section>`).join("\n");

  const errorBlock = errors.length ? `
        <section class="finance-note">
          <h2>暂时不可用的来源</h2>
          <p>${escapeHtml(errors.map((error) => `${error.name}: ${error.message}`).join("；"))}</p>
        </section>` : "";

  return renderShell({
    title: "游戏资讯",
    description: "游戏资讯聚合",
    activeNav: "game",
    activeSection: "game",
    body: `
        <section class="finance-header">
          <h1>游戏资讯</h1>
          <p>自动聚合 Steam 官方游戏更新和 GDELT 游戏新闻，标题和摘要会在构建时翻译为中文。更新时间：${escapeHtml(generatedAt)}</p>
        </section>
${sections || `
        <section class="finance-section">
          <h2>暂无内容</h2>
          <p>还没有抓取到游戏资讯，请稍后再试。</p>
        </section>`}
${errorBlock}
`,
  });
}

function renderArticlePage(item) {
  const body = item.content || item.summary || "这个来源未提供可抓取正文，暂时只能显示标题。";
  const bodyParagraphs = String(body).split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean);
  return renderShell({
    title: item.title,
    description: item.title,
    activeNav: "game",
    activeSection: "game",
    body: `
        <article class="feed-detail">
          <p class="feed-detail-back"><a href="/game/">返回游戏资讯</a></p>
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
  const config = JSON.parse(await fs.readFile(FEEDS_PATH, "utf8"));
  const tasks = [
    ...config.steam.map((feed) => ({ feed, type: "steam", run: () => fetchSteam(feed) })),
    ...config.gdelt.map((feed) => ({ feed, type: "gdelt", run: () => fetchGdelt(feed) })),
  ];
  const errors = [];
  const seen = new Set();
  const items = [];

  for (const task of tasks) {
    try {
      if (task.type === "gdelt") {
        await delay(GDELT_DELAY_MS);
      }
      const result = await task.run();

      for (const item of result) {
        const key = item.link.replace(/#.*$/, "");
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(item);
      }
    } catch (error) {
      errors.push({ name: task.feed.name, message: error.message });
    }
  }

  items.sort((a, b) => b.date - a.date);
  const limited = (await translateItems(items.slice(0, MAX_ITEMS), "game")).map((item) => {
    const slug = itemSlug(item);
    return { ...item, slug, localUrl: `/game/articles/${slug}/` };
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
