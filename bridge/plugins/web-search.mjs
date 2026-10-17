/**
 * web-search.mjs — 给 API 成员加「联网搜索」
 *
 * 国内网络现实（实测）：DuckDuckGo / SearXNG / Wikipedia 都连不上，
 * Bing / 百度 / 搜狗 / 360 可以。所以默认 auto：Bing → 百度 → DuckDuckGo 依次回退。
 *
 * 可配：
 *   SEARCH_BACKEND=auto|bing|baidu|duckduckgo|searx
 *   SEARCH_URL=...        自建 SearXNG（SEARCH_BACKEND=searx 时用）
 *   SEARCH_TIMEOUT_MS=20000
 */

export const title = '联网搜索';

const BACKEND = (process.env.SEARCH_BACKEND || 'auto').toLowerCase();
const SEARX_URL = (process.env.SEARCH_URL || '').replace(/\/+$/, '');
const TIMEOUT = Number(process.env.SEARCH_TIMEOUT_MS || 20000);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function decodeEntities(text) {
  return String(text)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, ' ');
}
function strip(html) {
  return decodeEntities(String(html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Bing：结果在 <li class="b_algo"> 里，标题是 <h2><a href=…> */
export function parseBing(html) {
  const out = [];
  for (const block of String(html).split(/class="b_algo"/i).slice(1)) {
    const link = block.match(/<h2[^>]*>[\s\S]{0,80}?<a[^>]+href="([^"]+)"/i) || block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    const title = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const snippet = block.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
      || block.match(/<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i)
      || block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    if (!link) continue;
    const url = decodeEntities(link[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    out.push({ title: strip(title ? title[1] : ''), url, snippet: strip(snippet ? snippet[1] : '') });
    if (out.length >= 8) break;
  }
  return out;
}

/** 百度：结果在 <div class="result c-container"> 里 */
export function parseBaidu(html) {
  const out = [];
  for (const block of String(html).split(/class="result[^"]*c-container/i).slice(1)) {
    const link = block.match(/<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"/i);
    const title = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    const snippet = block.match(/class="[^"]*content-right[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (!link) continue;
    out.push({ title: strip(title ? title[1] : ''), url: decodeEntities(link[1]), snippet: strip(snippet ? snippet[1] : '') });
    if (out.length >= 8) break;
  }
  return out;
}

export function parseDuckDuckGo(html) {
  const out = [];
  for (const block of String(html).split(/class="result__body"/i).slice(1)) {
    const link = block.match(/href="([^"]+)"[^>]*class="result__a"/i) || block.match(/class="result__a"[^>]*href="([^"]+)"/i);
    const title = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
    const snippet = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    out.push({ title: strip(title ? title[1] : ''), url: decodeEntities(link[1]), snippet: strip(snippet ? snippet[1] : '') });
    if (out.length >= 8) break;
  }
  return out;
}

export function parseSearx(payload) {
  return (payload && payload.results ? payload.results : []).slice(0, 8).map((r) => ({
    title: r.title || '', url: r.url || '', snippet: r.content || '',
  }));
}

/** 360 搜索（so.com）：结果在 <li class="res-list"> 里，<h3 class="g-title"><a href=…> */
export function parseSo360(html) {
  const out = [];
  for (const block of String(html).split(/class="res-list"/i).slice(1)) {
    const head = block.slice(0, 1200);
    const link = head.match(/<h3[^>]*>[\s\S]{0,300}?<a[^>]+href="(https?:\/\/[^"]+)"/i);
    const title = head.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i) || block.match(/class="res-desc"[^>]*>([\s\S]*?)<\/div>/i);
    if (!link) continue;
    out.push({ title: strip(title ? title[1] : ''), url: decodeEntities(link[1]), snippet: strip(snippet ? snippet[1] : '') });
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * Bing 对中文多词经常给出"有结果但完全不相关"的答案（实测：搜「初音未来 角色设定」只回「初」），
 * 所以要看一眼相关性，不相关就换引擎。
 */
function looksRelevant(query, results) {
  const tokens = String(query).split(/\s+/).filter((t) => t.length >= 2);
  if (!tokens.length) return true;
  const head = results.slice(0, 3).map((r) => r.title + ' ' + r.snippet).join(' ');
  return tokens.some((t) => head.includes(t));
}

async function get(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT),
    redirect: 'follow',
    headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return await res.text();
}

const ENGINES = {
  bing: async (q) => parseBing(await get('https://www.bing.com/search?q=' + encodeURIComponent(q) + '&setlang=zh-cn')),
  baidu: async (q) => parseBaidu(await get('https://www.baidu.com/s?wd=' + encodeURIComponent(q))),
  so360: async (q) => parseSo360(await get('https://www.so.com/s?q=' + encodeURIComponent(q))),
  duckduckgo: async (q) => parseDuckDuckGo(await get('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q))),
  searx: async (q) => {
    if (!SEARX_URL) throw new Error('没有配置 SEARCH_URL');
    return parseSearx(JSON.parse(await get(SEARX_URL + '/search?format=json&q=' + encodeURIComponent(q))));
  },
};

const ORDER = BACKEND === 'auto' ? ['bing', 'so360', 'baidu', 'duckduckgo'] : [BACKEND];

async function search(query) {
  const tried = [];
  for (const name of ORDER) {
    const engine = ENGINES[name];
    if (!engine) continue;
    try {
      const results = await engine(query);
      if (results.length && looksRelevant(query, results)) return { results, engine: name, tried };
      tried.push(name + ': ' + (results.length ? '结果不相关' : '0 条'));
    } catch (error) {
      tried.push(name + ': ' + String((error && error.message) || error));
    }
  }
  return { results: [], engine: null, tried };
}

export const tools = [{
  name: 'web_search',
  description: '联网搜索（Bing 优先、百度兜底），返回标题、链接和摘要。查资料、补设定、了解话题时用它。',
  kind: 'fetch',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: '搜索词' } },
    required: ['query'],
  },
  async run(args, ctx) {
    const query = String(args.query || '').trim();
    if (!query) return '[错误] 要给 query。';
    const { results, engine, tried } = await search(query);
    if (!results.length) {
      return '[搜索失败] 「' + query + '」没拿到结果。\n尝试过：' + (tried.join(' | ') || '(无可用引擎)')
        + '\n可以改用 fetch_url 直接抓已知网址。';
    }
    ctx.log('搜索「' + query + '」用 ' + engine + ' 拿到 ' + results.length + ' 条');
    return results.map((r, i) => (i + 1) + '. ' + r.title + '\n   ' + r.url + '\n   ' + r.snippet).join('\n\n');
  },
}];
