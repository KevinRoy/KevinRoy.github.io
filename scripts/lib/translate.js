const fs = require("fs/promises");
const https = require("https");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const CACHE_PATH = path.join(ROOT, "data", "translation-cache.json");
const GLOSSARY_PATH = path.join(ROOT, "data", "translation-glossary.json");
const TRANSLATE_ENDPOINT = "https://api.mymemory.translated.net/get";
const REQUEST_DELAY_MS = 850;

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

async function translateItems(items, namespace) {
  const cache = await readCache();
  const glossary = await readGlossary();
  const translated = [];
  let changed = false;

  for (const item of items) {
    const title = item.title || "";
    const key = `${namespace}:${title}`;
    const preparedTitle = applyGlossary(title, glossary, namespace, "pre");

    if (!shouldTranslate(title)) {
      translated.push(item);
      continue;
    }

    if (cache[key]) {
      translated.push({
        ...item,
        title: applyGlossary(cache[key], glossary, namespace, "post"),
        originalTitle: title,
      });
      continue;
    }

    try {
      const translatedTitle = applyGlossary(await translateText(preparedTitle), glossary, namespace, "post");
      if (translatedTitle && translatedTitle !== title) {
        cache[key] = translatedTitle;
        changed = true;
        translated.push({ ...item, title: translatedTitle, originalTitle: title });
      } else {
        translated.push(item);
      }
    } catch (error) {
      console.warn(`Translation skipped: ${title} (${error.message})`);
      translated.push(item);
    }
    await delay(REQUEST_DELAY_MS);
  }

  if (changed) await writeCache(cache);
  return translated;
}

module.exports = {
  translateItems,
};
