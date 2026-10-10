'use strict';

const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

// ---------------------------------------------------------------------------
// Generated artwork
// ---------------------------------------------------------------------------

// First matching rule wins, so more specific words come before general ones.
const ICON_RULES = [
  [/headphone|earbud|airpod|headset/, '🎧'],
  [/speaker|record|vinyl|guitar|piano|ukulele|drum|music|turntable/, '🎸'],
  [/camera|lens|polaroid|gopro/, '📷'],
  [/phone|iphone|pixel|galaxy/, '📱'],
  [/laptop|macbook|computer|keyboard|mouse|monitor|tablet|ipad|kindle/, '💻'],
  [/watch|fitbit|garmin|clock/, '⌚'],
  [/game|playstation|ps5|xbox|switch|nintendo|controller|console/, '🎮'],
  [/lego|puzzle|toy|doll|plush|teddy|figure|blocks/, '🧸'],
  [/book|novel|kindle|comic|journal|notebook|diary/, '📚'],
  [/paint|canvas|sketch|art|pencil|marker|crayon/, '🎨'],
  [/shoe|sneaker|trainer|boot|slipper|sandal/, '👟'],
  [/hat|cap|beanie/, '🧢'],
  [/scarf|glove|mitten|sock/, '🧣'],
  [/dress|skirt/, '👗'],
  [/shirt|tee|hoodie|sweater|jumper|jacket|coat|cardigan|pajama|pyjama/, '👕'],
  [/ring|necklace|bracelet|earring|jewel|pendant|diamond/, '💍'],
  [/bag|backpack|purse|wallet|tote|luggage|suitcase/, '👜'],
  [/perfume|cologne|fragrance|lipstick|makeup|skincare|lotion|serum|beauty/, '💄'],
  [/candle|diffuser/, '🕯️'],
  [/plant|succulent|flower|bouquet|seed|garden/, '🪴'],
  [/coffee|espresso|latte|mug/, '☕'],
  [/tea\b|teapot|matcha/, '🍵'],
  [/wine|champagne|prosecco/, '🍷'],
  [/beer|whisk|gin|vodka|rum|cocktail/, '🥃'],
  [/chocolate|candy|sweets|cookie|biscuit|treat/, '🍫'],
  [/cook|kitchen|pan|knife|blender|mixer|air ?fryer|baking|chef/, '🍳'],
  [/ball|football|soccer|basketball|tennis|golf|bike|bicycle|yoga|gym|dumbbell|sport/, '⚽'],
  [/tent|camping|hiking|outdoor|backpacking/, '🏕️'],
  [/ticket|concert|theatre|theater|show|experience|voucher|gift card|giftcard/, '🎟️'],
  [/spa|massage|bath|robe/, '🛁'],
  [/blanket|pillow|cushion|throw|duvet/, '🛋️'],
  [/lamp|light/, '💡'],
  [/dog|puppy|cat|kitten|pet/, '🐾'],
  [/baby|infant|stroller|pram/, '🍼'],
  [/drone|robot|gadget|smart|tech|charger|tv|television|roku|streaming/, '📺'],
  [/car|vehicle/, '🚗'],
  [/travel|trip|flight|holiday|vacation/, '✈️'],
  [/sunglass|glasses/, '🕶️'],
  [/umbrella/, '☂️'],
];

// Words must start at a word boundary so e.g. "party" doesn't match "art".
const ICON_MATCHERS = ICON_RULES.map(([pattern, icon]) => [new RegExp(`\\b(?:${pattern.source})`), icon]);

function pickIcon(name) {
  const lower = name.toLowerCase();
  for (const [pattern, icon] of ICON_MATCHERS) if (pattern.test(lower)) return icon;
  return '🎁';
}

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Deterministic PRNG (mulberry32) so the same item always renders the same art.
function prng(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const escapeXml = (s) =>
  s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

function wrapLabel(text, maxChars, maxLines) {
  const words = text.trim().split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= maxChars) {
      line = next;
    } else {
      if (line) lines.push(line);
      line = word.length > maxChars ? `${word.slice(0, maxChars - 1)}…` : word;
    }
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    const last = lines[maxLines - 1];
    lines[maxLines - 1] = last.length >= maxChars ? `${last.slice(0, maxChars - 1)}…` : `${last}…`;
  }
  return lines;
}

function generateGiftSvg(name) {
  const seed = hashString(name.toLowerCase());
  const rand = prng(seed);
  const hue = seed % 360;
  const hue2 = (hue + 35 + Math.floor(rand() * 50)) % 360;
  const c1 = `hsl(${hue} 72% 62%)`;
  const c2 = `hsl(${hue2} 70% 46%)`;
  const W = 400;
  const H = 300;

  const confetti = [];
  for (let i = 0; i < 18; i++) {
    const x = Math.round(rand() * W);
    const y = Math.round(rand() * (H - 80));
    const size = 3 + Math.round(rand() * 7);
    const opacity = (0.15 + rand() * 0.3).toFixed(2);
    if (rand() < 0.5) {
      confetti.push(`<circle cx="${x}" cy="${y}" r="${size}" fill="#fff" opacity="${opacity}"/>`);
    } else {
      const rot = Math.round(rand() * 180);
      confetti.push(
        `<rect x="${x}" y="${y}" width="${size * 2}" height="${size}" rx="1.5" fill="#fff" opacity="${opacity}" transform="rotate(${rot} ${x} ${y})"/>`,
      );
    }
  }

  const lines = wrapLabel(name, 26, 2);
  const labelY = lines.length === 1 ? 262 : 250;
  const label = lines
    .map((l, i) => `<text x="200" y="${labelY + i * 24}" text-anchor="middle">${escapeXml(l)}</text>`)
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient>
<radialGradient id="glow" cx="0.5" cy="0.38" r="0.45"><stop offset="0" stop-color="#fff" stop-opacity="0.45"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
</defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>
${confetti.join('\n')}
<circle cx="200" cy="112" r="120" fill="url(#glow)"/>
<circle cx="200" cy="112" r="64" fill="#fff" opacity="0.92"/>
<text x="200" y="134" text-anchor="middle" font-size="64" font-family="'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif">${pickIcon(name)}</text>
<rect y="${H - 76}" width="${W}" height="76" fill="#000" opacity="0.18"/>
<g fill="#fff" font-family="system-ui,-apple-system,'Segoe UI',Roboto,sans-serif" font-size="20" font-weight="600">${label}</g>
</svg>`;
}

function generatedImage(name) {
  return { mime: 'image/svg+xml', data: Buffer.from(generateGiftSvg(name)), source: 'generated' };
}

// ---------------------------------------------------------------------------
// Product photo lookup (og:image / twitter:image from the item's URL)
// ---------------------------------------------------------------------------

const blockedRanges = new net.BlockList();
for (const [addr, prefix, type] of [
  ['0.0.0.0', 8, 'ipv4'],
  ['10.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'],
  ['224.0.0.0', 3, 'ipv4'],
  ['::', 128, 'ipv6'],
  ['::1', 128, 'ipv6'],
  ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'],
]) {
  blockedRanges.addSubnet(addr, prefix, type);
}

function isPublicAddress(address, family) {
  return !blockedRanges.check(address, family === 6 || family === 'IPv6' ? 'ipv6' : 'ipv4');
}

// DNS lookup that refuses private/loopback/link-local targets. Because it is
// used as the socket's lookup function, the address we validate is the one we
// actually connect to (no DNS-rebinding gap).
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const allowed = addresses.filter((a) => isPublicAddress(a.address, a.family));
    if (!allowed.length) return callback(new Error(`Refusing to connect to non-public address for ${hostname}`));
    if (options && options.all) return callback(null, allowed);
    callback(null, allowed[0].address, allowed[0].family);
  });
}

const USER_AGENT = 'Mozilla/5.0 (compatible; GiftTrackerBot/1.0; +image preview)';

function request(url, { accept, maxBytes, timeoutMs, redirectsLeft = 4 }) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return reject(new Error('Invalid URL'));
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) return reject(new Error('Unsupported protocol'));
    if (net.isIP(parsed.hostname.replace(/^\[|\]$/g, ''))) {
      const ip = parsed.hostname.replace(/^\[|\]$/g, '');
      if (!isPublicAddress(ip, net.isIP(ip))) return reject(new Error('Refusing non-public address'));
    }

    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(
      parsed,
      {
        lookup: safeLookup,
        timeout: timeoutMs,
        headers: { 'User-Agent': USER_AGENT, Accept: accept, 'Accept-Language': 'en' },
      },
      (res) => {
        const { statusCode, headers } = res;
        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
          const next = new URL(headers.location, parsed).toString();
          return resolve(request(next, { accept, maxBytes, timeoutMs, redirectsLeft: redirectsLeft - 1 }));
        }
        if (statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${statusCode}`));
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy(new Error('Response too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ url: parsed.toString(), headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('Timed out')));
    req.on('error', reject);
  });
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x2F;|&#47;/gi, '/');
}

function findImageUrl(html, baseUrl) {
  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];
  const wanted = ['og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src'];
  const found = {};
  for (const tag of metaTags) {
    const key = (tag.match(/\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i) || [])[1];
    const content = (tag.match(/\bcontent\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (key && content && !found[key.toLowerCase()]) found[key.toLowerCase()] = content;
  }
  let candidate = wanted.map((k) => found[k]).find(Boolean);
  if (!candidate) {
    const link = (html.match(/<link\b[^>]*rel\s*=\s*["']image_src["'][^>]*>/i) || [])[0];
    if (link) candidate = (link.match(/\bhref\s*=\s*["']([^"']+)["']/i) || [])[1];
  }
  if (!candidate) return null;
  try {
    return new URL(decodeEntities(candidate.trim()), baseUrl).toString();
  } catch {
    return null;
  }
}

// SVG is deliberately excluded: a remote SVG served from our origin could run script.
const RASTER_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);

async function fetchProductImage(pageUrl, { timeoutMs = 6000 } = {}) {
  const page = await request(pageUrl, {
    accept: 'text/html,application/xhtml+xml',
    maxBytes: 1.5 * 1024 * 1024,
    timeoutMs,
  });
  const contentType = String(page.headers['content-type'] || '').split(';')[0].trim().toLowerCase();

  // The link might point straight at an image.
  if (RASTER_TYPES.has(contentType)) return { mime: contentType, data: page.body, source: 'product' };
  if (!contentType.includes('html')) throw new Error('Not an HTML page');

  const imageUrl = findImageUrl(page.body.toString('utf8'), page.url);
  if (!imageUrl) throw new Error('No preview image on page');

  const image = await request(imageUrl, { accept: 'image/*', maxBytes: 4 * 1024 * 1024, timeoutMs });
  const mime = String(image.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!RASTER_TYPES.has(mime) || image.body.length < 100) throw new Error('Preview is not a usable image');
  return { mime, data: image.body, source: 'product' };
}

/**
 * Produce the image for a gift: the product photo from its URL when one can be
 * found, otherwise generated artwork based on the item name.
 */
async function buildGiftImage({ name, url }, { fetchRemote = true } = {}) {
  if (url && fetchRemote) {
    try {
      return await fetchProductImage(url);
    } catch {
      // Fall through to generated artwork.
    }
  }
  return generatedImage(name);
}

module.exports = {
  buildGiftImage,
  generatedImage,
  generateGiftSvg,
  findImageUrl,
  fetchProductImage,
  pickIcon,
  isPublicAddress,
};
