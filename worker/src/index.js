const NOTUS_AUTHOR_URL = 'https://www.notus.org/samuel-larreal';
const CACHE_TTL_SECONDS = 1800; // 30 min — keeps NOTUS from getting hit on every visitor

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    const cache = caches.default;
    const cacheKey = new Request('https://notus-story-sync.internal/samuel-larreal', request);

    const cached = await cache.match(cacheKey);
    if (cached) return withCors(cached);

    let upstream;
    try {
      upstream = await fetch(NOTUS_AUTHOR_URL, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SamuelLarrealPortfolioSync/1.0)' },
      });
    } catch (err) {
      return jsonResponse({ error: 'upstream_unreachable' }, 502);
    }

    if (!upstream.ok) {
      return jsonResponse({ error: 'upstream_status_' + upstream.status }, 502);
    }

    const stories = [];
    let current = null;

    const rewriter = new HTMLRewriter().on('a.story__url', {
      element(el) {
        const href = el.getAttribute('href');
        if (href && href.startsWith('https://www.notus.org/')) {
          current = { url: href.split('?')[0].split('#')[0], title: '' };
          stories.push(current);
        } else {
          current = null;
        }
      },
      text(chunk) {
        if (current) current.title += chunk.text;
      },
    });

    await rewriter.transform(upstream).text();

    const seen = new Set();
    const deduped = [];
    for (const s of stories) {
      const title = s.title.replace(/\s+/g, ' ').trim();
      if (!title || seen.has(s.url)) continue;
      seen.add(s.url);
      deduped.push({ url: s.url, title, category: categorize(s.url) });
    }

    const response = jsonResponse({ generatedAt: new Date().toISOString(), stories: deduped });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=' + CACHE_TTL_SECONDS,
      ...corsHeaders(),
    },
  });
}

function withCors(response) {
  const res = new Response(response.body, response);
  Object.entries(corsHeaders()).forEach(([k, v]) => res.headers.set(k, v));
  return res;
}

// Best-effort beat guess from the story's URL. Matches the category slugs
// already used in index.html (data-cat attributes / filter chips).
function categorize(url) {
  const u = url.toLowerCase();
  const rules = [
    [/crypto|bitcoin|coinbase|stablecoin|kalshi|prediction-market|polymarket/, 'crypto'],
    [/data-center/, 'data'],
    [/deepfake/, 'deepfake'],
    [/tiktok/, 'tiktok'],
    [/\/california\//, 'ca'],
    [/white-?house/, 'wh'],
    [/\/(congress|senate|house)\//, 'congress'],
    [/stock|invest|lobby|super-pac|\bpac\b|fundrais|campaign-contribution|donat/, 'money'],
    [/artificial-intelligence|\bai\b|chatbot|anthropic|openai|\/technology\//, 'ai'],
  ];
  for (const [re, cat] of rules) {
    if (re.test(u)) return cat;
  }
  return 'news';
}
