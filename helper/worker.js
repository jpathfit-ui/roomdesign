// Room Designer link helper. Runs as a Cloudflare Worker.
// GET /?url=<product page>  ->  { ok, name, store, image (data URL), measures: [{label, inches}] }
// Reads one product page when asked. It does not crawl or store anything.

const MAX_HTML = 3000000;
const MAX_IMG = 2500000;
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

export default {
  async fetch(request, env) {
    const allowed = (env.ALLOW_ORIGIN || 'https://jpathfit-ui.github.io').split(',').map(s => s.trim());
    const origin = request.headers.get('Origin');
    const cors = {
      'Access-Control-Allow-Origin': origin && allowed.includes(origin) ? origin : allowed[0],
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
      'Cache-Control': 'no-store',
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return json({ ok: false, reason: 'method' }, 405);
    if (origin && !allowed.includes(origin)) return json({ ok: false, reason: 'origin' }, 403);

    const qs = new URL(request.url).searchParams;
    if (qs.get('img')) return proxyImage(qs.get('img'), qs.get('ref'), cors);

    const target = safeUrl(qs.get('url'));
    if (!target) return json({ ok: false, reason: 'badurl' }, 400);

    const viaSearch = async (reason) => {
      const r = await searchFallback(target, env);
      if (r && r.fail) return json({ ok: false, reason, search: r.fail });
      if (r) return json({ ok: true, viaSearch: true, name: r.name, images: [], store: target.hostname.replace(/^www\./, ''), image: null, measures: r.measures });
      return json({ ok: false, reason });
    };

    let resp;
    try {
      resp = await timed(target.href, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-CA,en;q=0.9' },
      }, 9000);
    } catch (e) {
      return viaSearch('unreachable');
    }
    if (resp.status === 404 || resp.status === 410) return json({ ok: false, reason: 'notfound' });
    if (!resp.ok) return viaSearch('blocked');

    const buf = await resp.arrayBuffer();
    const html = new TextDecoder('utf-8').decode(buf.byteLength > MAX_HTML ? buf.slice(0, MAX_HTML) : buf);
    const finalUrl = resp.url || target.href;
    if (/robot check|access denied|captcha|are you a human|unusual traffic/i.test((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '')) {
      return viaSearch('blocked');
    }

    const info = parsePage(html, finalUrl);
    if (!info.name && !info.imageUrl && !info.measures.length) return viaSearch('empty');

    let measures = info.measures, viaSrch = false;
    if (!measures.length) {
      // The page loaded but has no sizes in it. Ask a search engine, which has usually read the spec table.
      const r = await searchFallback(target, env, info.name);
      if (r && r.measures && r.measures.length) { measures = r.measures; viaSrch = true; }
    }

    let image = null;
    if (info.imageUrl) image = await fetchImage(info.imageUrl, finalUrl);
    return json({
      ok: true,
      viaSearch: viaSrch,
      name: info.name,
      images: info.images,
      store: new URL(finalUrl).hostname.replace(/^www\./, ''),
      image,
      measures,
    });
  },
};

function safeUrl(raw) {
  if (!raw) return null;
  let u;
  try { u = new URL(raw); } catch (e) { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.port && u.port !== '80' && u.port !== '443') return null;
  const h = u.hostname.toLowerCase();
  if (!h.includes('.') || h.includes(':') || /^\d+(\.\d+){3}$/.test(h)) return null;
  if (/(^|\.)(localhost|local|internal|lan)$/.test(h)) return null;
  return u;
}

async function timed(url, opts, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

// Returns one image's bytes so the app can inspect it (the browser blocks this when loading the store directly).
async function proxyImage(raw, ref, cors) {
  const fail = (status) => new Response('', { status, headers: cors });
  const u = safeUrl(raw);
  if (!u) return fail(400);
  try {
    const r = await timed(u.href, {
      headers: { 'User-Agent': UA, 'Referer': (safeUrl(ref) || u).origin + '/', 'Accept': 'image/*' },
    }, 8000);
    const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!r.ok || !type.startsWith('image/') || type.includes('svg')) return fail(404);
    const b = await r.arrayBuffer();
    if (b.byteLength > MAX_IMG * 2) return fail(413);
    return new Response(b, { status: 200, headers: { ...cors, 'Content-Type': type } });
  } catch (e) { return fail(502); }
}

async function fetchImage(url, base) {
  try {
    const u = safeUrl(new URL(url, base).href);
    if (!u) return null;
    const r = await timed(u.href, { headers: { 'User-Agent': UA, 'Referer': new URL(base).origin + '/', 'Accept': 'image/*' } }, 8000);
    const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!r.ok || !type.startsWith('image/') || type.includes('svg')) return null;
    const b = await r.arrayBuffer();
    if (b.byteLength > MAX_IMG || b.byteLength < 200) return null;
    return 'data:' + type + ';base64,' + toBase64(new Uint8Array(b));
  } catch (e) { return null; }
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/* ---------- Reading the page ---------- */

function parsePage(html, baseUrl) {
  const found = [];
  const seen = new Set();
  const add = (label, inches) => {
    label = normLabel(label);
    if (!label || !(inches >= 0.5 && inches <= 400) || seen.has(label)) return;
    seen.add(label);
    found.push({ label, inches: Math.round(inches * 10) / 10 });
  };

  let name = '', imageUrl = '';
  const nodes = jsonLd(html);
  const product = nodes.find(isProduct);
  if (product) {
    name = text(product.name);
    imageUrl = firstImage(product.image);
    for (const k of ['width', 'depth', 'height', 'length']) {
      const inches = quantity(product[k]);
      if (inches) add(k, inches);
    }
    const props = [].concat(product.additionalProperty || []);
    for (const p of props) {
      if (!p || typeof p !== 'object') continue;
      const inches = measureOf(String(p.value != null ? p.value : '') + ' ' + (p.unitText || p.unitCode || ''));
      if (inches) add(String(p.name || ''), inches);
    }
  }
  if (!name) name = meta(html, 'og:title') || ((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  if (!imageUrl) imageUrl = meta(html, 'og:image') || meta(html, 'twitter:image');
  name = cleanName(decode(name));
  if (imageUrl) { try { imageUrl = new URL(decode(imageUrl), baseUrl).href; } catch (e) { imageUrl = ''; } }

  const plain = decode(html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');

  const labelled = /\b((?:overall |total |max\.? |maximum |seat |arm |base |shade |pot |headboard |shelf |cord |pile )?(?:width|depth|height|length|diameter|thickness))\b\s*[:\-]?\s*(\d{1,4}(?:[.,]\d{1,2})?)\s*(cm|mm|inches|inch|in\b|["″”]|m\b)/gi;
  let m, n = 0;
  while ((m = labelled.exec(plain)) && n++ < 60) add(m[1], toInches(parseFloat(m[2].replace(',', '.')), m[3]));

  const compact = /(\d{1,3}(?:\.\d{1,2})?)\s*(["″”]|in\b|inches|cm)\s*([WDHL])\b/gi;
  n = 0;
  while ((m = compact.exec(plain)) && n++ < 30) {
    add({ W: 'width', D: 'depth', H: 'height', L: 'length' }[m[3].toUpperCase()], toInches(parseFloat(m[1]), m[2]));
  }
  return { name, imageUrl, images: collectImages(html, baseUrl, imageUrl), measures: found };
}

// Every product-looking picture on the page, in page order. The app decides which one is a clean product shot.
function collectImages(html, baseUrl, primary) {
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    if (!raw) return;
    let u;
    try { u = new URL(decode(String(raw).trim()), baseUrl); } catch (e) { return; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return;
    const key = u.origin + u.pathname;
    if (seen.has(key)) return;
    if (!/\.(jpe?g|png|webp)$/i.test(u.pathname) && !/\/images?\//i.test(u.pathname)) return;
    if (/logo|icon|sprite|badge|pixel|avatar|flag|payment|banner|placeholder|swatch/i.test(u.pathname)) return;
    seen.add(key);
    out.push(u.href);
  };
  push(primary);
  const tag = /<(?:img|source)\b[^>]*>/gi;
  let m;
  while ((m = tag.exec(html)) && out.length < 40) {
    const t = m[0];
    for (const attr of ['src', 'data-src', 'data-original']) {
      const v = (t.match(new RegExp('\\b' + attr + '=["\']([^"\']+)["\']', 'i')) || [])[1];
      if (v) push(v);
    }
    const ss = (t.match(/\bsrcset=["']([^"']+)["']/i) || [])[1];
    if (ss) push(ss.split(',').pop().trim().split(/\s+/)[0]);
  }
  return out.slice(0, 10);
}

function jsonLd(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try { collect(JSON.parse(m[1].trim()), out); } catch (e) { /* skip bad block */ }
  }
  return out;
}
function collect(node, out) {
  if (Array.isArray(node)) { node.forEach(x => collect(x, out)); return; }
  if (!node || typeof node !== 'object') return;
  out.push(node);
  if (node['@graph']) collect(node['@graph'], out);
}
function isProduct(n) {
  return [].concat(n['@type'] || []).some(t => /^(Product|ProductGroup|IndividualProduct)$/i.test(String(t)));
}
function text(v) { return typeof v === 'string' ? v : (v && v.name) || ''; }
function firstImage(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return firstImage(v[0]);
  return v.url || v.contentUrl || '';
}
function quantity(v) {
  if (v == null) return 0;
  if (typeof v === 'object') return measureOf(String(v.value != null ? v.value : '') + ' ' + (v.unitText || v.unitCode || ''));
  return measureOf(String(v));
}
const UNIT_CODES = { CMT: 'cm', MMT: 'mm', INH: 'in', MTR: 'm' };
function measureOf(s) {
  const m = String(s).match(/(\d+(?:[.,]\d+)?)\s*(cm|mm|inches|inch|in\b|["″”]|m\b|CMT|MMT|INH|MTR)/i);
  if (!m) return 0;
  return toInches(parseFloat(m[1].replace(',', '.')), UNIT_CODES[m[2].toUpperCase()] || m[2]);
}
function toInches(v, unit) {
  const u = String(unit).toLowerCase();
  if (u === 'cm') return v / 2.54;
  if (u === 'mm') return v / 25.4;
  if (u === 'm') return v * 39.3701;
  return v;
}
function normLabel(s) {
  return String(s || '').toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\b(overall|total|max|maximum)\b/g, ' ').replace(/\s+/g, ' ').trim();
}
function meta(html, prop) {
  const re = new RegExp('<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]*>', 'i');
  const tag = (html.match(re) || [])[0] || '';
  return (tag.match(/content=["']([^"']*)["']/i) || [])[1] || '';
}
function cleanName(s) {
  s = s.replace(/\s+/g, ' ').trim().split(' | ')[0];
  const parts = s.split(' - ');
  if (parts.length > 1 && parts[parts.length - 1].length <= 20) parts.pop();
  return parts.join(' - ').trim().slice(0, 80);
}
function decode(s) {
  return String(s)
    .replace(/&quot;|&#34;|&#x22;/gi, '"')
    .replace(/&#8243;|&Prime;|&#x2033;/gi, '″')
    .replace(/&apos;|&#39;|&#x27;/gi, "'")
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

/* ---------- Search fallback: for stores that block the helper ---------- */
// Builds a search from the product name in the link, reads the result snippets, and pulls sizes out of them.
// Uses Brave Search when a BRAVE_KEY variable is set on the Worker, otherwise DuckDuckGo's plain page.

function queryFromUrl(u, name) {
  const segs = decodeURIComponent(u.pathname).split('/').filter(Boolean);
  let best = '';
  for (const sg of segs) {
    const t = sg.replace(/\.(product\.\d+\.)?html?$/i, '').replace(/\.product\.\d+$/i, '');
    if (/^\d+$/.test(t) || t.length < 4) continue;
    if (t.replace(/[^a-z]/gi, '').length > best.replace(/[^a-z]/gi, '').length) best = t;
  }
  const words = (name || best).replace(/[-_+]+/g, ' ').replace(/\b\d{5,}\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (words.length < 4) return '';
  const brand = u.hostname.replace(/^www\./, '').split('.')[0];
  return (words + ' ' + brand + ' dimensions').slice(0, 140);
}

async function searchFallback(u, env, name) {
  const q = queryFromUrl(u, name);
  if (!q) return { fail: 'noquery' };
  let snippets = [], title = '';
  try {
    if (env.BRAVE_KEY) {
      const r = await timed('https://api.search.brave.com/res/v1/web/search?count=10&q=' + encodeURIComponent(q), {
        headers: { 'Accept': 'application/json', 'X-Subscription-Token': env.BRAVE_KEY },
      }, 8000);
      if (r.ok) {
        const j = await r.json();
        for (const x of (j.web && j.web.results) || []) {
          snippets.push({ host: hostOf(x.url), text: decode(stripTags((x.title || '') + ' . ' + (x.description || '') + ' . ' + [].concat(x.extra_snippets || []).join(' . '))) });
        }
      }
    } else {
      const r = await timed('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), {
        headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'en-CA,en;q=0.9' },
      }, 8000);
      if (r.ok) {
        const h = await r.text();
        const re = /<a[^>]+class="result__a"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
        let m;
        while ((m = re.exec(h)) && snippets.length < 10) {
          snippets.push({ host: hostOf(decodeURIComponent((m[1].match(/uddg=([^&]+)/) || [])[1] || m[1])), text: decode(stripTags(m[2] + ' . ' + m[3])) });
        }
      }
    }
  } catch (e) { return { fail: 'searcherror' }; }
  if (!snippets.length) return { fail: 'nosnippets' };

  // Prefer results from the same store or its maker, then anything else.
  const own = u.hostname.replace(/^www\./, '');
  snippets.sort((a, b) => (b.host === own) - (a.host === own));
  title = cleanName(snippets[0].text.split(' . ')[0] || '');

  for (const sn of snippets) {
    const ms = sizesFromText(sn.text);
    if (ms.length >= 2) return { name: title && !/^\W*$/.test(title) ? title : '', measures: ms };
  }
  return { fail: 'nosizes' };
}

function hostOf(x) { try { return new URL(x).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }
function stripTags(x) { return String(x).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '); }

// "221 cm × 102 cm × 105 cm", "W x L x H 96 in. x 40 in. x 41 in.", plus labelled "Width: 38 in".
function sizesFromText(t) {
  const out = [];
  const n = String.raw`(\d{1,3}(?:[.,]\d{1,2})?)`;
  const u = String.raw`(cm|mm|in\.?|inches|["″”])`;
  const tri = new RegExp(n + '\\s*' + u + '?\\s*[x×X]\\s*' + n + '\\s*' + u + '?\\s*[x×X]\\s*' + n + '\\s*' + u + '?', 'i');
  const m = tri.exec(t);
  if (m) {
    const unit = m[6] || m[4] || m[2];
    if (unit) {
      const v = [parseFloat(m[1].replace(',', '.')), parseFloat(m[3].replace(',', '.')), parseFloat(m[5].replace(',', '.'))].map(x => toInches(x, unit.replace('.', '')));
      // Two flat measurements and one height: the larger flat one is the width.
      const hMatch = /\(\s*([WLDH])\s*[x×]\s*([WLDH])\s*[x×]\s*([WLDH])\s*\)|\b([WLDH])\s*[x×]\s*([WLDH])\s*[x×]\s*([WLDH])\b/i.exec(t);
      const order = hMatch ? [hMatch[1] || hMatch[4], hMatch[2] || hMatch[5], hMatch[3] || hMatch[6]].map(x => x.toUpperCase()) : null;
      let width, depth, height;
      if (order && order.includes('H') && new Set(order).size === 3) {
        const hi = order.indexOf('H');
        height = v[hi];
        const flat = v.filter((_, i) => i !== hi);
        width = Math.max(...flat); depth = Math.min(...flat);
      } else {
        height = v[2];
        width = Math.max(v[0], v[1]); depth = Math.min(v[0], v[1]);
      }
      for (const [l, val] of [['width', width], ['depth', depth], ['height', height]]) {
        if (val >= 0.5 && val <= 400) out.push({ label: l, inches: Math.round(val * 10) / 10 });
      }
    }
  }
  if (out.length < 2) {
    const lab = /\b(width|depth|height|length|diameter)\b\s*[:\-]?\s*(\d{1,3}(?:[.,]\d{1,2})?)\s*(cm|mm|in\.?|inches|["″”])/gi;
    let k, c = 0;
    const seen = new Set(out.map(o => o.label));
    while ((k = lab.exec(t)) && c++ < 12) {
      const l = k[1].toLowerCase();
      if (seen.has(l)) continue;
      seen.add(l);
      out.push({ label: l, inches: Math.round(toInches(parseFloat(k[2].replace(',', '.')), k[3].replace('.', '')) * 10) / 10 });
    }
  }
  return out;
}
