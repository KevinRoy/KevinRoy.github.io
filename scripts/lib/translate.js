const fs = require("fs/promises");
const https = require("https");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const CACHE_PATH = path.join(ROOT, "data", "translation-cache.json");
const GLOSSARY_PATH = path.join(ROOT, "data", "translation-glossary.json");
const TRANSLATE_ENDPOINT = "https://api.mymemory.translated.net/get";
const REQUEST_DELAY_MS = 850;
const MAX_CHUNK_LENGTH = 450;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasChinese(value) {
  return /[\u3400-\u9fff]/.test(value);
}

function shouldTranslate(value) {
  return /[a-zA-Z]/.test(value) && !hasChinese(value);
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      timeout: 20000,
      headers: {
        "user-agent": "KevinRoy.github.io feed translator (contact: https://github.com/KevinRoy)",
        "accept": "application/json, text/plain, */*",
      },
    }, (response) => {
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

async function readCache() {
  try {
    return JSON.parse(await fs.readFile(CACHE_PATH, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function readGlossary() {
  try {
    return JSON.parse(await fs.readFile(GLOSSARY_PATH, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeCache(cache) {
  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await fs.writeFile(CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

function glossaryEntries(glossary, namespace, phase) {
  return [
    ...Object.entries(glossary.common && glossary.common[phase] || {}),
    ...Object.entries(glossary[namespace] && glossary[namespace][phase] || {}),
  ].sort((a, b) => b[0].length - a[0].length);
}

function replaceAll(value, from, to) {
  return value.split(from).join(to);
}

function applyGlossary(value, glossary, namespace, phase) {
  return glossaryEntries(glossary, namespace, phase)
    .reduce((result, [from, to]) => replaceAll(result, from, to), value);
}

function parseTranslation(data) {
  const translated = data &&
    data.responseStatus === 200 &&
    data.responseData &&
    data.responseData.translatedText;

  return typeof translated === "string" ? translated.trim() : "";
}

async function translateText(text) {
  const url = new URL(TRANSLATE_ENDPOINT);
  url.searchParams.set("q", text);
  url.searchParams.set("langpair", "en|zh-CN");

  const data = await requestJson(url);
  return parseTranslation(data);
}

function cacheKey(namespace, field, value) {
  return field === "title" ? `${namespace}:${value}` : `${namespace}:${field}:${value}`;
}

function splitForTranslation(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_CHUNK_LENGTH) return normalized ? [normalized] : [];

  const parts = normalized.match(/[^.!?。！？；;]+[.!?。！？；;]?/g) || [normalized];
  const chunks = [];
  let current = "";

  for (const part of parts) {
    const next = current ? `${current} ${part.trim()}` : part.trim();
    if (next.length <= MAX_CHUNK_LENGTH) {
      current = next;
      continue;
    }

    if (current) chunks.push(current);
    current = part.trim();

    while (current.length > MAX_CHUNK_LENGTH) {
      chunks.push(current.slice(0, MAX_CHUNK_LENGTH));
      current = current.slice(MAX_CHUNK_LENGTH);
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

async function translateValue(value, namespace, field, context) {
  const text = String(value || "").trim();
  if (!shouldTranslate(text)) return { value: text, originalValue: "" };
  const allowFallback = field === "title";

  const key = cacheKey(namespace, field, text);
  if (context.cache[key]) {
    const cached = applyGlossary(context.cache[key], context.glossary, namespace, "post");
    if (!allowFallback && !hasChinese(cached)) {
      return { value: "", originalValue: text };
    }
    return {
      value: cached,
      originalValue: text,
    };
  }

  const chunks = splitForTranslation(text);
  const translatedChunks = [];

  for (const chunk of chunks) {
    const chunkKey = cacheKey(namespace, field, chunk);
    if (context.cache[chunkKey]) {
      translatedChunks.push(applyGlossary(context.cache[chunkKey], context.glossary, namespace, "post"));
      continue;
    }

    try {
      const preparedText = applyGlossary(chunk, context.glossary, namespace, "pre");
      const translated = applyGlossary(await translateText(preparedText), context.glossary, namespace, "post");
      if (translated && translated !== chunk) {
        context.cache[chunkKey] = translated;
        context.changed = true;
        translatedChunks.push(translated);
      } else {
        translatedChunks.push(chunk);
      }
    } catch (error) {
      console.warn(`Translation skipped: ${chunk.slice(0, 80)} (${error.message})`);
      if (allowFallback) translatedChunks.push(chunk);
    }

    await delay(REQUEST_DELAY_MS);
  }

  const translatedText = translatedChunks.join(" ").trim();
  if (translatedText && translatedText !== text) {
    context.cache[key] = translatedText;
    context.changed = true;
    return { value: translatedText, originalValue: text };
  }

  return allowFallback
    ? { value: text, originalValue: "" }
    : { value: "", originalValue: text };
}

async function translateItems(items, namespace) {
  const cache = await readCache();
  const glossary = await readGlossary();
  const translated = [];
  const context = { cache, glossary, changed: false };

  for (const item of items) {
    const title = item.title || "";
    const summary = item.summary || "";
    const content = item.content || "";
    const titleResult = await translateValue(title, namespace, "title", context);
    const summaryResult = await translateValue(summary, namespace, "summary", context);
    const contentResult = await translateValue(content, namespace, "content", context);

    translated.push({
      ...item,
      title: titleResult.value,
      originalTitle: titleResult.originalValue,
      summary: summaryResult.value,
      originalSummary: summaryResult.originalValue,
      content: contentResult.value,
      originalContent: contentResult.originalValue,
    });
  }

  if (context.changed) await writeCache(cache);
  return translated;
}

module.exports = {
  translateValue,
  translateItems,
};
