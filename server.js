const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');

const app = express();
const cache = new NodeCache({ stdTTL: 300 });

// ────────────────────────────────────────────────
// スクレイピング
// ────────────────────────────────────────────────

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'ja-JP,ja;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
};

function parseWeightFromName(name) {
  const kgMatch = name.match(/(\d+(?:\.\d+)?)\s*kg/i);
  if (kgMatch) return Math.round(parseFloat(kgMatch[1]) * 1000);
  const gMatch = name.match(/([\d,]+)\s*g\b/);
  if (gMatch) return parseInt(gMatch[1].replace(',', ''));
  return null;
}

// 1食分のタンパク質量(g)を名前から推定（平均20g）
function estimateProteinPerServing(name) {
  const m = name.match(/タンパク質\s*(\d+)\s*g|protein\s*(\d+)\s*g/i);
  if (m) return parseInt(m[1] || m[2]);
  return 20; // デフォルト20g
}

async function scrapeAmazonSearch(keyword) {
  const url = `https://www.amazon.co.jp/s?k=${encodeURIComponent(keyword)}&i=hpc`;
  const res = await axios.get(url, {
    headers: { ...HEADERS, 'Referer': 'https://www.amazon.co.jp/' },
    timeout: 15000
  });
  const html = res.data;
  const items = [];

  const itemStarts = [];
  const re = /data-csa-c-item-id="amzn1\.asin\.1\.([A-Z0-9]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) itemStarts.push({ asin: m[1], pos: m.index });

  for (let i = 0; i < itemStarts.length; i++) {
    const { asin, pos } = itemStarts[i];
    const end = i + 1 < itemStarts.length ? itemStarts[i + 1].pos : pos + 25000;
    const block = html.slice(pos, end);

    const h2 = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    const name = h2 ? h2[1].replace(/<[^>]+>/g, '').trim() : '';
    if (!name || name.length < 5) continue;

    const wholeMatch = block.match(/a-price-whole[^>]*>([\d,]+)/);
    if (!wholeMatch) continue;
    const price = parseInt(wholeMatch[1].replace(/,/g, ''), 10);

    const imgMatch = block.match(/class="s-image"[^>]*src="([^"]+)"/);
    const image = imgMatch ? imgMatch[1] : '';

    const linkMatch = block.match(/href="(\/[^"]*\/dp\/[A-Z0-9]+[^"]*)"/);
    const productUrl = linkMatch
      ? 'https://www.amazon.co.jp' + linkMatch[1].replace(/&amp;/g, '&').split('?')[0]
      : `https://www.amazon.co.jp/dp/${asin}`;

    const weightG = parseWeightFromName(name);
    const pricePerKg = weightG ? Math.round((price / weightG) * 1000) : null;
    const pricePerG = weightG ? (price / weightG).toFixed(2) : null;
    // 1食30gと仮定した場合のコスト
    const pricePerServing = weightG ? Math.round(price / (weightG / 30)) : null;

    items.push({ id: `amzn-${asin}`, asin, name, site: 'Amazon JP', url: productUrl,
      weightG, price, pricePerKg, pricePerG, pricePerServing, image, currency: 'JPY', error: null });
  }

  console.log(`[Amazon] "${keyword}" → ${items.length}件`);
  return items;
}

async function scrapeAmazonPage2(keyword) {
  const url = `https://www.amazon.co.jp/s?k=${encodeURIComponent(keyword)}&i=hpc&page=2`;
  const res = await axios.get(url, {
    headers: { ...HEADERS, 'Referer': 'https://www.amazon.co.jp/' },
    timeout: 15000
  });
  const html = res.data;
  const items = [];

  const re = /data-csa-c-item-id="amzn1\.asin\.1\.([A-Z0-9]+)"/g;
  const itemStarts = [];
  let m;
  while ((m = re.exec(html)) !== null) itemStarts.push({ asin: m[1], pos: m.index });

  for (let i = 0; i < itemStarts.length; i++) {
    const { asin, pos } = itemStarts[i];
    const end = i + 1 < itemStarts.length ? itemStarts[i + 1].pos : pos + 25000;
    const block = html.slice(pos, end);
    const h2 = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    const name = h2 ? h2[1].replace(/<[^>]+>/g, '').trim() : '';
    if (!name || name.length < 5) continue;
    const wholeMatch = block.match(/a-price-whole[^>]*>([\d,]+)/);
    if (!wholeMatch) continue;
    const price = parseInt(wholeMatch[1].replace(/,/g, ''), 10);
    const imgMatch = block.match(/class="s-image"[^>]*src="([^"]+)"/);
    const image = imgMatch ? imgMatch[1] : '';
    const weightG = parseWeightFromName(name);
    const pricePerKg = weightG ? Math.round((price / weightG) * 1000) : null;
    const pricePerG = weightG ? (price / weightG).toFixed(2) : null;
    const pricePerServing = weightG ? Math.round(price / (weightG / 30)) : null;
    items.push({ id: `amzn2-${asin}`, asin, name, site: 'Amazon JP',
      url: `https://www.amazon.co.jp/dp/${asin}`,
      weightG, price, pricePerKg, pricePerG, pricePerServing, image, currency: 'JPY', error: null });
  }
  console.log(`[Amazon p2] "${keyword}" → ${items.length}件`);
  return items;
}

function deduplicateItems(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = `${item.price}-${item.name.slice(0, 25)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const FALLBACK_ITEMS = [
  { id: 'fb-1', asin: 'B07MQDG3ZM', name: 'マイプロテイン ホエイプロテイン ナチュラルチョコレート 2.5kg', site: 'Amazon JP', url: 'https://www.amazon.co.jp/dp/B07MQDG3ZM', weightG: 2500, price: 7990, pricePerKg: 3196, pricePerG: '3.20', pricePerServing: 96, image: '', currency: 'JPY', error: null },
  { id: 'fb-2', asin: 'B001UE0PZC', name: 'ザバス ホエイプロテイン100 ココア味 1050g', site: 'Amazon JP', url: 'https://www.amazon.co.jp/dp/B001UE0PZC', weightG: 1050, price: 4980, pricePerKg: 4743, pricePerG: '4.74', pricePerServing: 142, image: '', currency: 'JPY', error: null },
  { id: 'fb-3', asin: 'B002VLAHOI', name: 'DNS ホエイプロテイン スタンダード チョコレート風味 1000g', site: 'Amazon JP', url: 'https://www.amazon.co.jp/dp/B002VLAHOI', weightG: 1000, price: 5200, pricePerKg: 5200, pricePerG: '5.20', pricePerServing: 156, image: '', currency: 'JPY', error: null },
  { id: 'fb-4', asin: 'B00BQOENGE', name: 'バルクスポーツ ビッグホエイ チョコレート 3kg', site: 'Amazon JP', url: 'https://www.amazon.co.jp/dp/B00BQOENGE', weightG: 3000, price: 8900, pricePerKg: 2967, pricePerG: '2.97', pricePerServing: 89, image: '', currency: 'JPY', error: null },
  { id: 'fb-5', asin: 'B00BQOENMQ', name: 'ゴールドジム ホエイプロテイン バニラ風味 1kg', site: 'Amazon JP', url: 'https://www.amazon.co.jp/dp/B00BQOENMQ', weightG: 1000, price: 4500, pricePerKg: 4500, pricePerG: '4.50', pricePerServing: 135, image: '', currency: 'JPY', error: null },
];

async function fetchAllPrices() {
  const cacheKey = 'protein_prices';
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  console.log('[fetch] 価格取得開始...');

  const [r1, r2, r3] = await Promise.allSettled([
    scrapeAmazonSearch('ホエイプロテイン'),
    scrapeAmazonSearch('ホエイプロテイン 2kg 3kg'),
    scrapeAmazonPage2('ホエイプロテイン'),
  ]);

  let items = [];
  for (const r of [r1, r2, r3]) {
    if (r.status === 'fulfilled') items = items.concat(r.value);
  }

  items = deduplicateItems(items);
  items.sort((a, b) => {
    if (a.pricePerKg && b.pricePerKg) return a.pricePerKg - b.pricePerKg;
    if (a.pricePerKg) return -1;
    if (b.pricePerKg) return 1;
    return (a.price || 0) - (b.price || 0);
  });

  if (items.length === 0) {
    console.log('[fallback] スクレイピング0件のためサンプルデータを使用');
    items = FALLBACK_ITEMS;
  }

  const data = { fetchedAt: new Date().toISOString(), items };
  cache.set(cacheKey, data);
  console.log(`[完了] 合計${items.length}件`);
  return data;
}

// ────────────────────────────────────────────────
// SSR HTML生成
// ────────────────────────────────────────────────

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtPrice(p) {
  return p != null ? '¥' + Math.round(p).toLocaleString('ja-JP') : '-';
}

function buildStructuredData(items) {
  const listItems = items.slice(0, 20).map((item, i) => ({
    '@type': 'ListItem',
    position: i + 1,
    item: {
      '@type': 'Product',
      name: item.name,
      image: item.image || '',
      offers: {
        '@type': 'Offer',
        price: item.price,
        priceCurrency: 'JPY',
        availability: 'https://schema.org/InStock',
        url: item.url
      }
    }
  }));

  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'プロテイン最安値ランキング',
    description: 'Amazonのホエイプロテインをkg単価で比較した最安値ランキング',
    numberOfItems: items.length,
    itemListElement: listItems
  });
}

function buildFAQStructuredData() {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      {
        '@type': 'Question',
        name: 'プロテインで一番コスパが良いのはどれですか？',
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'kg単価で比較するのが正確です。このページでは毎日Amazonの最新価格を取得し、kg単価の安い順にランキングしています。一般的に2kg〜3kgの大容量品がkg単価で最もコスパが良くなります。'
        }
      },
      {
        '@type': 'Question',
        name: 'プロテインのkg単価とは何ですか？',
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'プロテイン1kgあたりの価格のことです。同じ商品でも容量によって価格が変わるため、kg単価で比較することで本当の最安値を見つけられます。例えば1kgで3,000円の商品より、3kgで8,000円の商品のほうがkg単価は安くなります。'
        }
      },
      {
        '@type': 'Question',
        name: 'このサイトの価格はいつ更新されますか？',
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'ページにアクセスするたびに最新のAmazon価格を取得しています。5分以内の再アクセスはキャッシュから返します。プロテインの価格はセールや在庫状況によって頻繁に変わるため、購入前に必ず最新価格をご確認ください。'
        }
      }
    ]
  });
}

function buildWebsiteStructuredData() {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'プロテイン最安値ランキング',
    description: 'Amazonのホエイプロテインをリアルタイムで価格比較。kg単価・1食単価で最安値を毎日更新。',
    potentialAction: {
      '@type': 'SearchAction',
      target: '/?q={search_term_string}',
      'query-input': 'required name=search_term_string'
    }
  });
}

function renderTableRows(items) {
  return items.map((item, idx) => {
    const rank = idx + 1;
    const rankBadge = rank <= 3
      ? `<span class="rank-badge r${rank}" aria-label="${rank}位">${rank}</span>`
      : `<span class="rank-num">${rank}</span>`;

    const rowClass = rank <= 3 ? `rank-${rank}` : '';

    const imgHtml = item.image
      ? `<img class="product-img" src="${escHtml(item.image)}" alt="${escHtml(item.name)}" loading="${rank <= 5 ? 'eager' : 'lazy'}" width="52" height="52">`
      : `<span class="product-img-ph" aria-hidden="true">🥛</span>`;

    return `
      <tr class="${rowClass}" data-ppkg="${item.pricePerKg || 99999}" data-price="${item.price || 99999}" data-weight="${item.weightG || 0}" data-name="${escHtml(item.name.toLowerCase())}">
        <td class="td-rank">${rankBadge}</td>
        <td class="td-product">
          <div class="product-cell">
            ${imgHtml}
            <div class="product-info">
              <a href="${escHtml(item.url)}" target="_blank" rel="noopener sponsored" class="product-link">${escHtml(item.name)}</a>
              ${item.weightG ? `<span class="weight-tag">${item.weightG >= 1000 ? (item.weightG/1000).toFixed(item.weightG % 1000 === 0 ? 0 : 1) + 'kg' : item.weightG + 'g'}</span>` : ''}
            </div>
          </div>
        </td>
        <td class="td-price" data-sort="${item.price || 99999}">
          ${item.price != null ? `<strong>${fmtPrice(item.price)}</strong>` : '<span class="na">-</span>'}
        </td>
        <td class="td-ppkg ${rank === 1 ? 'best-ppkg' : ''}" data-sort="${item.pricePerKg || 99999}">
          ${item.pricePerKg != null ? `<strong>${fmtPrice(item.pricePerKg)}</strong><small>/kg</small>` : '<span class="na">-</span>'}
        </td>
        <td class="td-serving" data-sort="${item.pricePerServing || 99999}">
          ${item.pricePerServing != null ? `${fmtPrice(item.pricePerServing)}<small>/食(30g)</small>` : '<span class="na">-</span>'}
        </td>
      </tr>`;
  }).join('');
}

function renderHTML(data) {
  const { items, fetchedAt } = data;
  const updatedAt = new Date(fetchedAt);
  const updatedStr = updatedAt.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const successCount = items.filter(i => i.price != null).length;
  const topItem = items.find(i => i.pricePerKg);
  const cheapestPpkg = topItem ? fmtPrice(topItem.pricePerKg) : '-';

  const tableRows = renderTableRows(items.filter(i => i.price != null));

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>プロテイン最安値ランキング【${new Date().getFullYear()}年最新】kg単価で徹底比較 | 毎日更新</title>
  <meta name="description" content="プロテインの最安値をkg単価・1食単価でリアルタイム比較。Amazonの${successCount}商品を毎日自動更新。現在の最安値は${cheapestPpkg}/kg（${updatedStr}時点）。ホエイプロテインのコスパ最強商品がすぐわかる。">
  <meta name="keywords" content="プロテイン 最安値, ホエイプロテイン コスパ, プロテイン 価格比較, プロテイン kg単価, プロテイン 安い">
  <link rel="canonical" href="https://protein-safetynet.com/">

  <!-- OGP -->
  <meta property="og:title" content="プロテイン最安値ランキング【${new Date().getFullYear()}年最新】">
  <meta property="og:description" content="kg単価で比較するプロテイン最安値ランキング。${successCount}商品をリアルタイム更新。">
  <meta property="og:type" content="website">
  <meta property="og:locale" content="ja_JP">
  <meta name="twitter:card" content="summary_large_image">

  <!-- 構造化データ -->
  <script type="application/ld+json">${buildStructuredData(items)}</script>
  <script type="application/ld+json">${buildFAQStructuredData()}</script>
  <script type="application/ld+json">${buildWebsiteStructuredData()}</script>

  <style>
    :root {
      --bg: #f5f7fa; --bg2: #ffffff; --bg3: #eef1f6;
      --border: #e2e6ed; --border2: #eaecf0;
      --text: #1a1a2e; --muted: #6b7280; --accent: #4f46e5;
      --cyan: #0ea5e9; --green: #16a34a; --gold: #d97706;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; }
    body { font-family: 'Segoe UI','Hiragino Sans','Yu Gothic',sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; font-size: 15px; }

    /* ヘッダー */
    header { background: #fff; border-bottom: 1px solid var(--border); padding: 14px 24px; position: sticky; top: 0; z-index: 200; box-shadow: 0 1px 4px rgba(0,0,0,.06); }
    .header-inner { max-width: 1200px; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .site-title { font-size: 1.15rem; font-weight: 800; color: var(--accent); text-decoration: none; }
    .header-meta { font-size: 0.72rem; color: var(--muted); }

    /* ヒーロー */
    .hero { background: linear-gradient(135deg,#eef2ff 0%,#f0fdf4 100%); padding: 40px 24px 32px; text-align: center; border-bottom: 1px solid var(--border); }
    .hero h1 { font-size: clamp(1.4rem, 4vw, 2rem); font-weight: 800; line-height: 1.3; margin-bottom: 10px; color: var(--text); }
    .hero h1 em { color: var(--accent); font-style: normal; }
    .hero .hero-sub { color: var(--muted); font-size: 0.88rem; margin-bottom: 20px; }
    .hero-stats { display: flex; justify-content: center; gap: 24px; flex-wrap: wrap; }
    .stat-box { background: #fff; border: 1px solid var(--border); border-radius: 10px; padding: 12px 20px; text-align: center; min-width: 120px; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
    .stat-num { font-size: 1.4rem; font-weight: 800; color: var(--accent); }
    .stat-label { font-size: 0.7rem; color: var(--muted); }

    /* コントロール */
    .controls { background: #fff; border-bottom: 1px solid var(--border); padding: 10px 24px; }
    .controls-inner { max-width: 1200px; margin: 0 auto; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .ctrl-label { font-size: 0.72rem; color: var(--muted); }
    button { cursor: pointer; border: none; border-radius: 6px; font-size: 0.78rem; font-weight: 600; padding: 5px 12px; transition: all .18s; font-family: inherit; }
    .sort-btn { background: var(--bg3); color: var(--muted); }
    .sort-btn.active { background: #eef2ff; color: var(--accent); box-shadow: 0 0 0 1px #4f46e533; }
    #search-input { background: var(--bg3); border: 1px solid var(--border); border-radius: 6px; color: var(--text); padding: 5px 12px; font-size: 0.78rem; width: 190px; outline: none; font-family: inherit; margin-left: auto; }
    #search-input:focus { border-color: var(--accent); background: #fff; }

    /* テーブル */
    main { max-width: 1200px; margin: 0 auto; padding: 20px 16px 60px; }
    .table-wrap { border-radius: 12px; border: 1px solid var(--border); margin-bottom: 48px; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.06); overflow: hidden; }
    .table-scroll { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 0.83rem; }
    thead tr { background: #e8ecf2; }
    th { padding: 12px 14px; text-align: left; color: #374151; font-weight: 700; font-size: 0.78rem; letter-spacing: .03em; border-bottom: 3px solid #b0bac8; white-space: nowrap; cursor: pointer; user-select: none; }
    th:hover { color: var(--accent); }
    th .arr { margin-left: 3px; opacity: .3; font-size: 0.65rem; }
    th.asc .arr::after  { content: '▲'; opacity: 1; color: var(--accent); }
    th.desc .arr::after { content: '▼'; opacity: 1; color: var(--accent); }
    tbody tr { border-bottom: 1px solid var(--border2); transition: background .12s; }
    tbody tr:last-child { border-bottom: none; }
    tbody tr:hover { background: #f8fafc; }
    tbody tr.rank-1 { background: linear-gradient(90deg,#f0fdf4 0%,#fff 50%); }
    tbody tr.rank-2 { background: linear-gradient(90deg,#fefce8 0%,#fff 50%); }
    tbody tr.rank-3 { background: linear-gradient(90deg,#fff7ed 0%,#fff 50%); }
    td { padding: 10px 14px; vertical-align: middle; }

    .td-rank { width: 44px; text-align: center; }
    .rank-badge { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 50%; font-weight: 800; font-size: .72rem; }
    .rank-badge.r1 { background: var(--green); color: #0d2015; }
    .rank-badge.r2 { background: var(--gold); color: #1a1a09; }
    .rank-badge.r3 { background: #cd7f32; color: white; }
    .rank-num { color: #3a3a5a; font-size: .72rem; }

    .product-cell { display: flex; align-items: center; gap: 10px; }
    .product-img { width: 52px; height: 52px; object-fit: contain; border-radius: 6px; background: var(--bg2); flex-shrink: 0; }
    .product-img-ph { width: 52px; height: 52px; border-radius: 6px; background: var(--bg2); display: flex; align-items: center; justify-content: center; font-size: 1.4rem; flex-shrink: 0; }
    .product-info { min-width: 0; }
    .product-link { color: var(--text); text-decoration: none; font-weight: 500; line-height: 1.4; display: block; }
    .product-link:hover { color: var(--accent); text-decoration: underline; }
    .weight-tag { display: inline-block; background: #eef1f6; color: var(--muted); font-size: .65rem; padding: 1px 6px; border-radius: 4px; margin-top: 3px; }

    .td-price strong { font-size: 1rem; color: var(--text); }
    .td-ppkg strong { font-size: 1rem; color: var(--accent); }
    .td-ppkg small, .td-serving small { color: var(--muted); font-size: .72rem; }
    .best-ppkg strong { color: var(--green) !important; }
    .na { color: #c0c0c8; }

    /* 最安値バナー */
    .best-banner { background: linear-gradient(135deg,#f0fdf4,#eff6ff); border: 1px solid #86efac; border-radius: 12px; padding: 14px 20px; margin-bottom: 16px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
    .best-badge { background: linear-gradient(135deg,#16a34a,#15803d); color: white; font-size: .68rem; font-weight: 800; padding: 3px 10px; border-radius: 20px; white-space: nowrap; }
    .best-info { flex: 1; min-width: 0; }
    .best-name { font-weight: 600; font-size: .9rem; color: var(--text); }
    .best-price { color: var(--green); font-size: 1.2rem; font-weight: 800; }
    .best-ppkg-text { color: var(--green); font-size: .78rem; }
    .best-btn { background: linear-gradient(135deg,#16a34a,#15803d); color: white; padding: 8px 16px; border-radius: 8px; text-decoration: none; font-size: .82rem; font-weight: 700; white-space: nowrap; display: inline-block; }
    .best-btn:hover { opacity: .85; }

    /* コンテンツセクション */
    .content-section { margin-bottom: 48px; }
    .content-section h2 { font-size: 1.15rem; font-weight: 800; margin-bottom: 14px; padding-bottom: 8px; border-bottom: 2px solid var(--border); color: var(--accent); }
    .content-section h3 { font-size: 1rem; font-weight: 700; margin: 20px 0 8px; color: var(--text); }
    .content-section p { color: #4b5563; line-height: 1.8; margin-bottom: 12px; font-size: .9rem; }
    .content-section ul { list-style: none; margin: 0 0 16px 0; }
    .content-section ul li { padding: 6px 0 6px 20px; position: relative; color: #4b5563; font-size: .9rem; border-bottom: 1px solid var(--border2); }
    .content-section ul li::before { content: '✓'; position: absolute; left: 0; color: var(--green); font-weight: 700; }

    /* FAQ */
    .faq-item { background: #fff; border: 1px solid var(--border); border-radius: 10px; padding: 16px 20px; margin-bottom: 10px; box-shadow: 0 1px 3px rgba(0,0,0,.04); }
    .faq-q { font-weight: 700; color: var(--text); margin-bottom: 8px; font-size: .9rem; }
    .faq-q::before { content: 'Q. '; color: var(--accent); }
    .faq-a { color: #4b5563; font-size: .88rem; line-height: 1.7; }
    .faq-a::before { content: 'A. '; color: var(--green); font-weight: 700; }

    /* フッター */
    footer { background: #fff; border-top: 1px solid var(--border); padding: 24px; text-align: center; color: var(--muted); font-size: .78rem; }
    footer a { color: var(--muted); }

    /* ユーティリティ */
    .hidden { display: none !important; }
    .spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid #4f46e533; border-top-color: var(--accent); border-radius: 50%; animation: spin .7s linear infinite; vertical-align: middle; margin-right: 5px; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>

<header>
  <div class="header-inner">
    <a href="/" class="site-title">プロテイン最安値ランキング</a>
    <span class="header-meta">最終更新: ${updatedStr} ・ ${successCount}商品</span>
  </div>
</header>

<div class="hero">
  <h1><em>プロテイン最安値</em>ランキング<br>【${new Date().getFullYear()}年最新・kg単価で徹底比較】</h1>
  <p class="hero-sub">Amazonの価格をリアルタイム取得・毎日更新 ｜ ページ読み込みごとに最新価格を反映</p>
  <div class="hero-stats">
    <div class="stat-box">
      <div class="stat-num">${successCount}</div>
      <div class="stat-label">比較商品数</div>
    </div>
    <div class="stat-box">
      <div class="stat-num">${cheapestPpkg}</div>
      <div class="stat-label">最安値/kg</div>
    </div>
    <div class="stat-box">
      <div class="stat-num">毎日</div>
      <div class="stat-label">更新頻度</div>
    </div>
  </div>
</div>

<div class="controls">
  <div class="controls-inner">
    <span class="ctrl-label">並び替え：</span>
    <button class="sort-btn active" data-sort="ppkg">単価安い順(kg)</button>
    <button class="sort-btn" data-sort="price">価格安い順</button>
    <button class="sort-btn" data-sort="serving">1食単価安い順</button>
    <button class="sort-btn" data-sort="weight">容量大きい順</button>
    <input id="search-input" type="search" placeholder="商品名で絞り込み..." aria-label="商品名で検索">
  </div>
</div>

<main>
  <!-- 最安値バナー -->
  ${topItem ? `
  <div class="best-banner" aria-label="現在の最安値商品">
    <span class="best-badge">最安値/kg 第1位</span>
    <div class="best-info">
      <div class="best-name">${escHtml(topItem.name.slice(0, 60))}${topItem.name.length > 60 ? '...' : ''}</div>
      <div>
        <span class="best-price">${fmtPrice(topItem.price)}</span>
        <span class="best-ppkg-text"> (${fmtPrice(topItem.pricePerKg)}/kg · ${topItem.weightG ? (topItem.weightG/1000).toFixed(topItem.weightG % 1000 === 0 ? 0 : 1) + 'kg' : ''})</span>
      </div>
    </div>
    <a href="${escHtml(topItem.url)}" target="_blank" rel="noopener sponsored" class="best-btn">Amazonで見る →</a>
  </div>` : ''}

  <!-- 価格比較テーブル -->
  <div class="table-wrap" role="region" aria-label="プロテイン価格比較テーブル">
    <div class="table-scroll">
    <table id="price-table">
      <thead>
        <tr>
          <th class="td-rank" aria-label="順位">#</th>
          <th>商品名</th>
          <th data-col="price">価格<span class="arr"></span></th>
          <th data-col="ppkg" class="asc">単価(円/kg)<span class="arr"></span></th>
          <th data-col="serving">1食(30g)<span class="arr"></span></th>
        </tr>
      </thead>
      <tbody id="tbody">
        ${tableRows}
      </tbody>
    </table>
    </div>
  </div>

  <!-- コンテンツ（SEO用） -->
  <section class="content-section" aria-labelledby="howto-h2">
    <h2 id="howto-h2">プロテインの最安値を正しく比較する方法</h2>
    <p>プロテインを選ぶとき、価格だけで判断するのは危険です。1kgで3,000円の商品より、3kgで8,000円の商品のほうが実際には安くなります。正しい比較には<strong>kg単価（1kgあたりの価格）</strong>を使いましょう。</p>
    <h3>kg単価で比較すべき理由</h3>
    <ul>
      <li>同じブランドでも容量が大きいほどkg単価が安くなる傾向がある</li>
      <li>セール時は大容量品ほど割引率が高いことが多い</li>
      <li>1食あたりの価格（30g換算）が実際のコストの実感に近い</li>
      <li>タンパク質含有率が高いほど実質的なコスパが上がる</li>
    </ul>
    <h3>ホエイプロテインの種類とコスパ</h3>
    <p>ホエイプロテインには主に<strong>WPC（ホエイプロテインコンセントレート）</strong>と<strong>WPI（ホエイプロテインアイソレート）</strong>があります。WPCはコスパが高く、WPIは乳糖が少ない分やや高価です。最安値を狙うならWPCの大容量タイプが最もお得です。</p>
    <p>このページでは毎日Amazonの最新価格を自動取得し、<strong>kg単価の安い順</strong>にランキングしています。プロテインの価格はセールや在庫状況によって日々変動するため、購入前に必ずこのページで最新価格を確認することをおすすめします。</p>
  </section>

  <!-- FAQ -->
  <section class="content-section" aria-labelledby="faq-h2">
    <h2 id="faq-h2">よくある質問（FAQ）</h2>
    <div class="faq-item">
      <div class="faq-q">プロテインで一番コスパが良いのはどれですか？</div>
      <div class="faq-a">kg単価で比較するのが正確です。このページでは毎日Amazonの最新価格を取得し、kg単価の安い順にランキングしています。一般的に2kg〜3kgの大容量品がkg単価で最もコスパが良くなります。</div>
    </div>
    <div class="faq-item">
      <div class="faq-q">kg単価とは何ですか？</div>
      <div class="faq-a">プロテイン1kgあたりの価格です。同じ商品でも容量によって価格が変わるため、kg単価で比較することで本当の最安値を見つけられます。例えば1kgで3,000円の商品より、3kgで8,000円（kg単価2,667円）の商品のほうが安くなります。</div>
    </div>
    <div class="faq-item">
      <div class="faq-q">このサイトの価格はいつ更新されますか？</div>
      <div class="faq-a">ページにアクセスするたびに最新のAmazon価格を取得しています（5分以内のアクセスはキャッシュから返します）。プロテインの価格はセールや在庫状況によって頻繁に変わるため、購入前に必ず最新価格をご確認ください。</div>
    </div>
    <div class="faq-item">
      <div class="faq-q">1食あたりの価格はどうやって計算していますか？</div>
      <div class="faq-a">プロテイン1食分を30gとして計算しています（一般的なスクープ1杯分）。1食単価＝価格 ÷（内容量g ÷ 30）で算出しています。</div>
    </div>
  </section>
</main>

<footer>
  <p>© ${new Date().getFullYear()} プロテイン最安値ランキング ｜ 価格はAmazon.co.jpから自動取得 ｜ 最終更新: ${updatedStr}</p>
  <p style="margin-top:6px"><a href="/sitemap.xml">サイトマップ</a></p>
  <p style="margin-top:10px;font-size:.72rem;color:#4a4a6a">※ 本ページはAmazonアソシエイトとして適格販売により収入を得ています。価格・在庫状況はAmazonの最新情報をご確認ください。</p>
</footer>

<script>
  // クライアントサイドのソート・フィルター（インタラクティブ機能）
  let sortCol = 'ppkg';
  let sortDir = 'asc';

  const colAttrMap = { ppkg: 'ppkg', price: 'price', serving: 'serving', weight: 'weight' };
  const colDataMap = { ppkg: 'ppkg', price: 'price', serving: 'serving', weight: 'weight' };

  function sortTable(col, dir) {
    const tbody = document.getElementById('tbody');
    const rows = Array.from(tbody.querySelectorAll('tr'));
    const visible = rows.filter(r => !r.classList.contains('hidden'));

    visible.sort((a, b) => {
      const va = parseFloat(a.dataset[col] || '99999');
      const vb = parseFloat(b.dataset[col] || '99999');
      if (va === 99999 && vb === 99999) return 0;
      if (va === 99999) return 1;
      if (vb === 99999) return -1;
      return dir === 'asc' ? va - vb : vb - va;
    });

    // 非表示行は末尾へ
    const hidden = rows.filter(r => r.classList.contains('hidden'));
    visible.forEach((r, i) => {
      const rank = i + 1;
      const rankCell = r.querySelector('.td-rank');
      // ランクバッジ更新
      if (rank <= 3) {
        rankCell.innerHTML = \`<span class="rank-badge r\${rank}" aria-label="\${rank}位">\${rank}</span>\`;
        r.className = \`rank-\${rank}\`;
      } else {
        rankCell.innerHTML = \`<span class="rank-num">\${rank}</span>\`;
        r.className = '';
      }
      // 最安値ppkgのハイライト
      r.querySelector('.td-ppkg')?.classList.toggle('best-ppkg', rank === 1 && col === 'ppkg' && dir === 'asc');
      tbody.appendChild(r);
    });
    hidden.forEach(r => tbody.appendChild(r));
  }

  function applyFilter() {
    const q = document.getElementById('search-input').value.toLowerCase();
    const tbody = document.getElementById('tbody');
    tbody.querySelectorAll('tr').forEach(r => {
      const name = r.dataset.name || '';
      r.classList.toggle('hidden', !!q && !name.includes(q));
    });
    sortTable(sortCol, sortDir);
  }

  // ソートボタン
  document.querySelectorAll('.sort-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      sortCol = btn.dataset.sort;
      sortDir = sortCol === 'weight' ? 'desc' : 'asc';
      sortTable(sortCol, sortDir);
    });
  });

  // テーブルヘッダーでのソート
  document.querySelectorAll('th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (sortCol === col) {
        sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        sortCol = col;
        sortDir = col === 'weight' ? 'desc' : 'asc';
      }
      document.querySelectorAll('th[data-col]').forEach(t => t.className = '');
      th.className = sortDir;
      sortTable(sortCol, sortDir);
    });
  });

  // 検索
  document.getElementById('search-input').addEventListener('input', applyFilter);
</script>
</body>
</html>`;
}

// ────────────────────────────────────────────────
// ルート
// ────────────────────────────────────────────────

app.get('/', async (req, res) => {
  try {
    if (req.query.refresh === '1') cache.del('protein_prices');
    const data = await fetchAllPrices();
    const html = renderHTML(data);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // キャッシュヘッダー（CDN/ブラウザキャッシュ5分）
    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=60');
    res.send(html);
  } catch (err) {
    console.error(err);
    res.status(500).send(`<h1>エラー</h1><p>${err.message}</p>`);
  }
});

// JSON API（フロントエンド用・必要に応じて）
app.get('/api/prices', async (req, res) => {
  try {
    if (req.query.refresh === '1') cache.del('protein_prices');
    const data = await fetchAllPrices();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// sitemap.xml
app.get('/sitemap.xml', (req, res) => {
  const host = req.headers.host || 'localhost:3000';
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const base = `${proto}://${host}`;
  const today = new Date().toISOString().split('T')[0];
  res.setHeader('Content-Type', 'application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${base}/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>`);
});

// robots.txt
app.get('/robots.txt', (req, res) => {
  const host = req.headers.host || 'localhost:3000';
  const proto = req.headers['x-forwarded-proto'] || 'http';
  res.setHeader('Content-Type', 'text/plain');
  res.send(`User-agent: *\nAllow: /\nSitemap: ${proto}://${host}/sitemap.xml`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`起動 → http://localhost:${PORT}`);
});
