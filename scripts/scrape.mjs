// Snapshot data + images from completeselular.co.id into this project.
//   node scripts/scrape.mjs [--per-brand 12] [--posts 24] [--refresh]
// HTML/JSON responses are cached in .cache/ so re-runs are cheap; --refresh ignores the cache.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import * as cheerio from 'cheerio'
import sharp from 'sharp'
import { groupModels, parseVariant } from '../src/lib/variants.js'

const ORIGIN = 'https://completeselular.co.id'
const ROOT = path.resolve(import.meta.dirname, '..')
const CACHE = path.join(ROOT, '.cache')
const PUBLIC = path.join(ROOT, 'public')
const SRC_DATA = path.join(ROOT, 'src', 'data')
const PUB_DATA = path.join(PUBLIC, 'data')

const args = process.argv.slice(2)
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? Number(args[i + 1]) : def
}
const PER_BRAND = arg('per-brand', 12)
const POST_LIMIT = arg('posts', 24)
const REFRESH = args.includes('--refresh')

// ---------- helpers ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex')

async function pool(items, size, fn) {
  const out = new Array(items.length)
  let i = 0
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (i < items.length) {
        const idx = i++
        out[idx] = await fn(items[idx], idx)
      }
    }),
  )
  return out
}

async function fetchText(url, { retries = 3 } = {}) {
  const file = path.join(CACHE, 'http', md5(url))
  if (!REFRESH) {
    try {
      return await fs.readFile(file, 'utf8')
    } catch {}
  }
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'CompleteSelular-Redesign-Snapshot/1.0' } })
      if (!res.ok) throw new Error(`${res.status} ${url}`)
      const text = await res.text()
      // The host can answer with a reCAPTCHA wall (HTTP 200); never cache that as the page
      if (text.includes('<title>Bot Verification</title>')) throw new Error(`bot verification page for ${url}`)
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, text)
      await sleep(150)
      return text
    } catch (err) {
      if (attempt >= retries) throw err
      await sleep(1000 * attempt)
    }
  }
}

const fetchJson = async (url) => JSON.parse(await fetchText(url))

const decode = (s = '') => cheerio.load(`<p>${s}</p>`)('p').text().trim()
const clean = (s = '') => s.replace(/\s+/g, ' ').trim()
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// Cut on a word boundary so cards never end mid-word
const truncate = (s, max) => {
  if (s.length <= max) return s
  const cut = s.slice(0, max + 1)
  return cut.slice(0, cut.lastIndexOf(' ')).replace(/[\s,.;:–—-]+$/, '') + '…'
}
// Admins type prices like "5.599.000"; the APS plugin reads that as 5.599 and shows "Rp6".
// The original string survives in <meta itemprop="price">, so parse dots as thousand separators.
// Anything under Rp50.000 is leftover demo data (e.g. "229.99") and is treated as no price.
const MIN_PRICE = 50_000
const parsePrice = (s = '') => {
  s = String(s).replace(/[^\d.,]/g, '')
  const n = /^\d{1,3}([.,]\d{3})+$/.test(s) ? Number(s.replace(/[.,]/g, '')) : Math.round(Number(s.replace(',', '.')))
  return Number.isFinite(n) && n >= MIN_PRICE ? n : null
}
const abs = (u) => (u ? new URL(u, ORIGIN).href : u)
// WordPress thumbnails look like foo-128x128.webp; the original is foo.webp
const fullSize = (u) => u?.replace(/-\d+x\d+(?=\.\w+$)/, '')

// Every file this run writes under public/, so outputs left behind by earlier runs can be pruned.
const written = new Set()

// Skipping identical writes keeps Vite's watcher quiet and leaves untouched files alone.
async function writeIfChanged(file, data) {
  written.add(path.resolve(file))
  try {
    if ((await fs.readFile(file)).equals(data)) return
  } catch {}
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, data)
}

const writeJson = (file, data) => writeIfChanged(file, Buffer.from(JSON.stringify(data)))

// ---------- images ----------

// Download an original once (kept in .cache/img) and read its real pixel size.
const rawJobs = new Map()
function rawImage(url) {
  if (!url) return Promise.resolve(null)
  url = abs(url)
  if (!rawJobs.has(url)) rawJobs.set(url, loadRaw(url))
  return rawJobs.get(url)
}

async function loadRaw(url) {
  const base = path
    .basename(new URL(url).pathname)
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^a-z0-9-_]+/gi, '-')
    .toLowerCase()
    .slice(0, 60)
  const hash = md5(url).slice(0, 6)
  const file = path.join(CACHE, 'img', `${hash}-${base}`)
  let buf
  try {
    buf = await fs.readFile(file)
  } catch {
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`${res.status}`)
      buf = Buffer.from(await res.arrayBuffer())
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, buf)
    } catch (err) {
      console.warn(`  ! image failed ${url}: ${err.message}`)
      return null
    }
  }
  try {
    const { width, height } = await sharp(buf, { animated: false }).metadata()
    return { url, buf, name: `${base}-${hash}`, width, height, digest: md5(buf) }
  } catch (err) {
    console.warn(`  ! unreadable image ${url}: ${err.message}`)
    return null
  }
}

// Write one WebP per requested width, named after the width it really came out at: a 128px upload
// asked for at 400 and 900 becomes a single "-128" file, never a "-400" that is secretly 128px.
// Returns { src, w, h, srcset? } (or a map keyed by the requested widths when several are asked for).
async function render(raw, folder, widths, { srcset = false } = {}) {
  const multi = widths.length > 1
  const actual = (want) => Math.min(want, raw.width || want)
  const variants = new Map()
  for (const want of widths) {
    const w = actual(want)
    if (variants.has(w)) continue
    const rel = `/img/${folder}/${raw.name}${multi ? `-${w}` : ''}.webp`
    const { data, info } = await sharp(raw.buf, { animated: false })
      .resize({ width: w, withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true })
    await writeIfChanged(path.join(PUBLIC, rel), data)
    variants.set(w, { src: rel, w: info.width, h: info.height })
  }
  const set = srcset && variants.size > 1 ? [...variants.values()].map((v) => `${v.src} ${v.w}w`).join(', ') : null
  const pick = (want) => ({ ...variants.get(actual(want)), ...(set && { srcset: set }) })
  return multi ? Object.fromEntries(widths.map((w) => [w, pick(w)])) : pick(widths[0])
}

const renderJobs = new Map()
function renderOnce(raw, folder, widths, opts = {}) {
  const id = `${folder}|${raw.url}|${raw.digest}|${widths.join(',')}|${opts.srcset ? 1 : 0}`
  if (!renderJobs.has(id)) {
    renderJobs.set(
      id,
      render(raw, folder, widths, opts).catch((err) => {
        console.warn(`  ! convert failed ${raw.url}: ${err.message}`)
        return null
      }),
    )
  }
  return renderJobs.get(id)
}

const image = async (url, folder, widths = [800], opts) => {
  const raw = await rawImage(url)
  return raw ? renderOnce(raw, folder, widths, opts) : null
}

const load = async (pathname) => cheerio.load(await fetchText(ORIGIN + pathname))

// ---------- site-wide assets ----------

// The theme names payment logos after squashed slugs ("travelokaspayl"); these are the brand names.
const PAYMENT_NAMES = {
  kredivo: 'Kredivo',
  akulaku: 'Akulaku',
  spaylater: 'SPayLater',
  homecredit: 'Home Credit',
  blibliinstore: 'Blibli InStore',
  baf: 'BAF',
  travelokaspayl: 'Traveloka PayLater',
  samsungfplus: 'Samsung Finance+',
}

async function scrapeSite() {
  console.log('• Site assets')
  const $ = await load('/')
  const imgs = $('img')
    .map((_, el) => ({
      src: $(el).attr('data-src') || $(el).attr('src'),
      href: $(el).closest('a').attr('href') || '',
      alt: $(el).attr('alt') || '',
    }))
    .get()
    .filter((x) => x.src && !x.src.startsWith('data:'))
  const find = (re) => imgs.filter((x) => re.test(x.src))

  const favicon = $('link[rel="icon"]').last().attr('href')
  const heroUrls = [...new Set(find(/BANNER|banner|slider/i).map((x) => fullSize(x.src)))]
  const brandLogos = find(/brand_[a-z]+@/i).map((x) => ({
    slug: x.src.match(/brand_([a-z]+)@/i)[1].toLowerCase(),
    url: x.src,
  }))
  const payments = find(/(kredivo|akulaku|spaylater|homecredit|blibliinstore|baf|travelokaspayl|samsungfplus)@/i)
  const socials = [
    ['instagram', 'https://www.instagram.com/officialcompleteselular/'],
    ['facebook', 'https://www.facebook.com/officialcompleteseluler/'],
    ['youtube', 'https://www.youtube.com/channel/UCVIvTp186hbzgDwlRC-3U5g'],
    ['tiktok', 'https://www.tiktok.com/@officialcompleteselular'],
  ]

  // Product slugs the homepage features in "Khusus Buatmu"
  const homeSlugs = [
    ...new Set(
      $('a[href*="/product/"]')
        .map(
          (_, el) =>
            $(el)
              .attr('href')
              .match(/\/product\/([^/]+)/)?.[1],
        )
        .get()
        .filter(Boolean),
    ),
  ]

  const $m = await load('/marketplace/')
  const marketLogos = $m('#content img')
    .map((_, el) => $m(el).attr('data-src') || $m(el).attr('src'))
    .get()
    .filter((s) => s && !s.startsWith('data:'))

  const marketplaces = [
    { name: 'Tokopedia', url: 'https://www.tokopedia.com/complete-selular/product', match: /tokopedia/i },
    { name: 'Shopee', url: 'https://shopee.co.id/complete.selular', match: /shopee/i },
    { name: 'Lazada', url: 'https://www.lazada.co.id/shop/completeselular1629968371', match: /lazada/i },
    { name: 'Blibli', url: 'https://www.blibli.com/merchant/complete-selular/COR-70000', match: /blibli/i },
    { name: 'TikTok Shop', url: 'https://www.tiktok.com/@officialcompleteselular', match: /tiktok/i },
  ]

  const site = {
    name: 'Complete Selular',
    whatsapp: '6281121101168',
    since: 2009,
    branchCount: '60+',
    rating: { score: 4.9, count: 2432, source: 'Google' },
    logo: await image(find(/logo-cs-1/i)[0]?.src, 'site', [480]),
    logoAlt: await image(find(/Logo-Complete-Selular/i)[0]?.src, 'site', [500]),
    // 1200w is what a 1280–1440px desktop needs for the ~680px hero; without it they fetch 1600w
    hero: (await Promise.all(heroUrls.map((u) => image(u, 'banners', [768, 1200, 1600], { srcset: true })))).filter(
      Boolean,
    ),
    brandLogos: Object.fromEntries(
      (await Promise.all(brandLogos.map(async (b) => [b.slug, await image(b.url, 'brands', [240])]))).filter(
        ([, v]) => v,
      ),
    ),
    payments: (
      await Promise.all(
        payments.map(async (p) => {
          const slug = p.src.match(/\/([a-z]+)@/i)[1].toLowerCase()
          return { name: PAYMENT_NAMES[slug] ?? slug, slug, img: await image(p.src, 'partners', [240]) }
        }),
      )
    ).filter((p) => p.img),
    marketplaces: await Promise.all(
      marketplaces.map(async ({ match, ...m }) => ({
        ...m,
        img: await image(
          marketLogos.find((s) => match.test(s)),
          'partners',
          [320],
        ),
      })),
    ),
    socials: socials.map(([name, url]) => ({ name, url })),
  }

  const fav = favicon && (await rawImage(favicon))
  if (fav) {
    await writeIfChanged(
      path.join(PUBLIC, 'img/site/favicon.png'),
      await sharp(fav.buf).resize(64, 64).png().toBuffer(),
    )
  }

  return { site, homeSlugs }
}

// ---------- products ----------

// APS draws its own grey "no image" box for products without a photo; never worth showing.
const PLACEHOLDER = /\/aps-products\/img\/product|woocommerce-placeholder|\/placeholder\.\w+$/i
const LOW_RES = 400
const isLowRes = (raw) => Math.max(raw.width, raw.height) < LOW_RES

// The store's brand tags are sometimes wrong (HONOR phones filed under Oppo, Motorola under ZTE),
// so the brand that leads the product name wins. Sub-brands map to their parent's page.
const BRAND_ALIASES = {
  iphone: 'apple',
  ipad: 'apple',
  galaxy: 'samsung',
  redmi: 'xiaomi',
  poco: 'xiaomi',
  moto: 'motorola',
  nubia: 'zte',
  iqoo: 'vivo',
  rog: 'asus',
  lumia: 'nokia',
}
// Brands the store sells but has no taxonomy term for
const EXTRA_BRANDS = { villaon: 'Villaon' }
// WordPress title-cases every brand; these are written the way the brands write themselves
const BRAND_NAMES = {
  oppo: 'OPPO',
  vivo: 'vivo',
  itel: 'itel',
  tecno: 'TECNO',
  realme: 'realme',
  hotwav: 'HOTWAV',
  honor: 'HONOR',
}

// Earbuds, watches, cases, … inherit the phone spec template ("RAM 512 MB", "Storage N/A")
const ACCESSORY =
  /\b(case|casing|cover|buds|earbuds?|earphones?|headsets?|headphones?|tws|enco|airpods|watch|band|strap|charger|adapter|adaptor|kabel|cable|power ?bank|tempered|speaker)\b/i
const STORAGE_SIZES = new Set([8, 16, 32, 64, 128, 256, 512])
const isEmptyValue = (v) => v.split(/\s*,\s*/).every((x) => /^(-|n\/?a|null|undefined)?(\s*\(.*\))?$/i.test(x))
// "iOS 20, iOS 20": the spec template fills two fields with the same value
const dedupeParts = (v) => [...new Set(v.split(', '))].join(', ')

// RAM/storage pills. The variant in the product name ("8/256", "12GB/1TB", "4GB 128GB") is the
// truth; the feature list is often copied from a sibling variant, so it is only a fallback.
function memoryHighlights(name, features) {
  if (ACCESSORY.test(name)) return []
  const n = name.replace(/\s+/g, ' ')
  let ram = null
  let storage = null

  const pair =
    n.match(/\b(\d{1,2})\s*GB\s*(?:[/+]|\s+(?:ROM\s+)?)\s*(\d{1,4})\s*(GB|TB)\b/i) ||
    n.match(/\b(\d{1,2})\s*[/+]\s*(\d{1,4})\s*(GB|TB)?(?![\d.])/i)
  if (pair) {
    const unit = (pair[3] || 'GB').toUpperCase()
    const size = Number(pair[2])
    const plausible = unit === 'TB' ? size <= 4 : STORAGE_SIZES.has(size) || (pair[3] && size >= 8)
    if (Number(pair[1]) >= 1 && Number(pair[1]) <= 24 && plausible) {
      storage = { n: size, unit }
      // "1GB 512GB" is a typo for 16GB; a real phone never has 1/128 of its storage as RAM
      const storageGb = unit === 'TB' ? size * 1024 : size
      if (storageGb / Number(pair[1]) <= 128) ram = Number(pair[1])
    }
  }
  if (!storage) {
    const s = n.match(/\b(\d{1,4})\s*(GB|TB)\b/i)
    if (s && (s[2].toUpperCase() === 'TB' || Number(s[1]) >= 16))
      storage = { n: Number(s[1]), unit: s[2].toUpperCase() }
  }

  // A single size such as "512 GB (UFS 4.0)"; lists like "128GB / 256GB" don't say which variant this is
  const single = (label) => {
    const v = features.find((f) => label.test(f.label))?.value
    if (!v || /\d\s*\/\s*\d/.test(v)) return null
    const sizes = [...v.matchAll(/(\d+(?:[.,]\d+)?)\s*(MB|GB|TB)\b/gi)]
    if (sizes.length !== 1 || /MB/i.test(sizes[0][2])) return null
    return { n: Number(sizes[0][1].replace(',', '.')), unit: sizes[0][2].toUpperCase() }
  }
  if (!ram) {
    const r = single(/^RAM$/i)
    if (r?.unit === 'GB' && r.n <= 24) ram = r.n
  }
  if (!storage) {
    const s = single(/^Storage$/i)
    if (s && (s.unit === 'TB' || s.n >= 8)) storage = s
  }
  // RAM alone ("2 GB") reads as storage on a card, so show nothing rather than something ambiguous
  if (!storage) return []
  return [ram && `${ram} GB`, `${storage.n} ${storage.unit}`].filter(Boolean)
}

// Admins copy a listing and sometimes update its slug and spec list but not its title:
// "vivo-y31d-pro-8gb-256gb-2" (RAM 8 GB, Storage 256 GB, Rp5.499.000) is titled "vivo Y31d Pro
// 4GB/128GB", which made the real 4/128 listing look like its duplicate and get hidden. When the
// slug and the RAM/Storage rows both name the same other capacity, they outvote the title.
const renamedListings = []
const slugCapacity = (slug) =>
  parseVariant(
    slug
      .replace(/(?<=gb|tb)-\d+$/, '') // WordPress's "-2" for a repeated slug
      .replace(/\b(\d{1,2})-(\d{1,4})-?(gb|tb)\b/g, '$1/$2$3')
      .replace(/-/g, ' '),
  )
function featureGB(features, label) {
  const m = features.find((f) => label.test(f.label))?.value.match(/^(\d+)\s*(GB|TB)\b/i)
  return m ? (/tb/i.test(m[2]) ? Number(m[1]) * 1024 : Number(m[1])) : null
}
function titleCapacity(name, slug, features) {
  const inName = parseVariant(name)
  const inSlug = slugCapacity(slug)
  if (!inName.ram || !inSlug.ram || inName.label === inSlug.label) return name
  if (featureGB(features, /^RAM$/i) !== inSlug.ram || featureGB(features, /^Storage$/i) !== inSlug.storage) return name
  const num = (gb) => (gb >= 1024 && gb % 1024 === 0 ? gb / 1024 : gb)
  const typed = new RegExp(
    `\\b${inName.ram}(\\s*GB)?(\\s*(?:/|ROM|\\s)\\s*)${num(inName.storage)}(\\s*(?:GB|TB))?\\b`,
    'i',
  )
  const fixed = name.replace(
    typed,
    (_, ramUnit = '', sep, unit) =>
      `${inSlug.ram}${ramUnit}${sep}${num(inSlug.storage)}${unit ? unit.replace(/[GT]B/i, inSlug.storage >= 1024 ? 'TB' : 'GB') : ''}`,
  )
  if (parseVariant(fixed).label !== inSlug.label) return name
  console.log(`  ~ ${slug}: title "${name}" → "${fixed}" (slug and spec list say ${inSlug.label})`)
  renamedListings.push({ slug, from: name, to: fixed })
  return fixed
}

async function scrapeProducts(extraSlugs) {
  console.log('• Brands & categories')
  const brands = (await fetchJson(`${ORIGIN}/wp-json/wp/v2/aps-brands?per_page=100&_fields=id,name,slug,count`)).map(
    (b) => ({ ...b, name: BRAND_NAMES[b.slug] ?? b.name }),
  )
  const cats = await fetchJson(`${ORIGIN}/wp-json/wp/v2/aps-cats?per_page=100&_fields=id,name,slug,count`)

  console.log(`• Product list (${PER_BRAND}/brand)`)
  const embed = '_embed=wp:featuredmedia,wp:term'
  const lists = await pool(brands, 4, (b) =>
    fetchJson(`${ORIGIN}/wp-json/wp/v2/aps-products?aps-brands=${b.id}&per_page=${PER_BRAND}&orderby=date&${embed}`),
  )
  const bySlug = new Map()
  for (const p of lists.flat()) bySlug.set(p.slug, p)
  const missing = extraSlugs.filter((s) => !bySlug.has(s))
  if (missing.length) {
    const extra = await fetchJson(
      `${ORIGIN}/wp-json/wp/v2/aps-products?slug=${missing.join(',')}&per_page=100&${embed}`,
    )
    for (const p of extra) bySlug.set(p.slug, p)
  }

  const raw = [...bySlug.values()]
  console.log(`• Product pages (${raw.length})`)
  let done = 0
  const products = (
    await pool(raw, 4, async (p) => {
      const product = await scrapeProduct(p)
      if (++done % 25 === 0) console.log(`  ${done}/${raw.length}`)
      return product
    })
  ).filter(Boolean)

  const brandNames = new Map([...brands.map((b) => [b.slug, b.name]), ...Object.entries(EXTRA_BRANDS)])
  for (const p of products) {
    const lead = p.name
      .trim()
      .split(/\s+/)[0]
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
    const slug = BRAND_ALIASES[lead] ?? (brandNames.has(lead) ? lead : null)
    if (slug && slug !== p.brand) {
      console.log(`  ~ ${p.slug}: brand ${p.brand} → ${slug}`)
      p.brand = slug
      p.brandName = brandNames.get(slug)
    }
  }

  const index = products
    .sort((a, b) => b.date.localeCompare(a.date))
    .map(({ gallery, specs, features, ...rest }) => rest)

  for (const p of products) await writeJson(path.join(PUB_DATA, 'products', `${p.slug}.json`), p)
  await writeJson(path.join(PUB_DATA, 'products.json'), index)

  const low = products.filter((p) => p.image.lowRes)
  if (low.length) {
    console.log(`\n! ${low.length} products have no photo of ${LOW_RES}px or more — the store should re-upload:`)
    for (const p of low) console.log(`    ${p.slug} (${p.image.w}×${p.image.h})`)
  }

  const counts = Object.groupBy(index, (p) => p.brand)
  const allBrands = [
    ...brands.map((b) => ({ name: b.name, slug: b.slug, total: b.count })),
    ...Object.entries(EXTRA_BRANDS).map(([slug, name]) => ({ name, slug, total: counts[slug]?.length ?? 0 })),
  ]
  return {
    brands: allBrands
      .map((b) => ({ ...b, count: counts[b.slug]?.length ?? 0 }))
      .filter((b) => b.count > 0)
      .sort((a, b) => a.name.localeCompare(b.name, 'id', { sensitivity: 'base' })),
    categories: cats
      .map((c) => ({ name: c.name, slug: c.slug, count: index.filter((p) => p.category === c.slug).length }))
      .filter((c) => c.count > 0),
    index,
  }
}

async function scrapeProduct(p) {
  let $
  try {
    $ = await load(`/product/${p.slug}/`)
  } catch (err) {
    console.warn(`  ! ${p.slug}: ${err.message}`)
    return null
  }
  const root = $('.aps-single-product').first()
  const terms = (p._embedded?.['wp:term'] || []).flat()
  const brand = terms.find((t) => t.taxonomy === 'aps-brands')
  const cat = terms.find((t) => t.taxonomy === 'aps-cats')
  const title = clean(decode(p.title.rendered))
  const accessory = ACCESSORY.test(title)

  const features = root
    .find('.aps-features-list li')
    .map((_, li) => ({
      label: clean($(li).find('strong').first().text()),
      value: dedupeParts(clean($(li).find('.aps-feature-info > span').first().text())),
    }))
    .get()
    .filter((f) => f.label && f.value && !isEmptyValue(f.value) && !f.value.includes('{{'))
    // Earbuds and cases list the phone template's "RAM 512 MB"
    .filter((f) => !(accessory && /^(RAM|Storage)$/i.test(f.label)))
  const name = accessory ? title : titleCapacity(title, p.slug, features)

  // The spec sheet's "Price" row is typed separately from the real price, so it drifts (and sometimes
  // is an unrendered "{{loopData.data.Harga}}"). The product price wins; the spec row is only used
  // when the admin left the product price empty (the live page then shows the price only in the specs).
  let specPrice = null
  const specs = $('.aps-group')
    .map((_, g) => {
      const $g = $(g)
      $g.find('.aps-tooltip-data').remove()
      return {
        group: clean($g.find('.aps-group-title').text()),
        rows: $g
          .find('tr')
          .map((_, tr) => ({
            label: clean($(tr).find('.aps-attr-title').text()),
            value: dedupeParts(clean($(tr).find('.aps-attr-value').text())),
          }))
          .get()
          .filter((r) => {
            if (/^(price|harga)$/i.test(r.label)) {
              specPrice ??= parsePrice(r.value)
              return false
            }
            return r.label && r.value && !isEmptyValue(r.value) && !`${r.label}${r.value}`.includes('{{')
          }),
      }
    })
    .get()
    .filter((g) => g.group && g.rows.length)

  const productPrice = parsePrice(
    root.find('.aps-product-price meta[itemprop="price"]').attr('content') ??
      root.find('.aps-product-price .aps-price-value').first().text(),
  )
  const price = productPrice ?? specPrice
  if (price && specPrice && price !== specPrice) {
    console.warn(`  ! ${p.slug}: spec sheet says Rp${specPrice}, product price is Rp${price}`)
  }

  // Photo candidates: featured image + gallery originals (each with its thumbnail as a fallback)
  const thumbs = root
    .find('.aps-main-image img, .aps-thumb-item img')
    .map((_, el) => $(el).attr('data-src') || $(el).attr('src'))
    .get()
  const candidates = [[p._embedded?.['wp:featuredmedia']?.[0]?.source_url], ...thumbs.map((u) => [fullSize(u), u])]
    .map((alts) => [...new Set(alts.filter((u) => u && !PLACEHOLDER.test(u)).map(abs))])
    .filter((alts) => alts.length)
  const seenUrl = new Set()
  const firstRaw = async (alts) => {
    for (const u of alts) {
      const r = await rawImage(u)
      if (r) return r
    }
    return null
  }
  const seen = new Set()
  const photos = (
    await Promise.all(candidates.filter((alts) => !seenUrl.has(alts[0]) && seenUrl.add(alts[0])).map(firstRaw))
  ).filter((r) => r && !seen.has(r.digest) && seen.add(r.digest))
  if (!photos.length) {
    console.warn(`  ! ${p.slug}: no product photo, skipped`)
    return null
  }
  // Keep the store's chosen lead photo unless it is a thumbnail-sized upload; then the largest
  // gallery photo leads (picking the largest outright would promote unboxing shots and group renders)
  const best =
    photos.find((r) => !isLowRes(r)) ?? photos.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a))
  const ordered = [best, ...photos.filter((r) => r !== best)].slice(0, 6)
  const variants = await Promise.all(ordered.map((r) => renderOnce(r, 'products', [400, 900], { srcset: true })))
  if (!variants[0]) return null
  const flag = (raw, img) => (isLowRes(raw) ? { ...img, lowRes: true } : img)

  return {
    slug: p.slug,
    name,
    date: p.date,
    brand: brand?.slug ?? null,
    brandName: brand ? (BRAND_NAMES[brand.slug] ?? brand.name) : null,
    category: cat?.slug ?? null,
    categoryName: cat?.name ?? null,
    price,
    image: flag(best, variants[0][400]),
    highlights: memoryHighlights(name, features),
    gallery: variants.map((v, i) => v && flag(ordered[i], v[900])).filter(Boolean),
    features,
    specs,
  }
}

// ---------- articles ----------

// SPA routes that old WordPress links can point at directly
const ROUTES = new Set([
  'katalog',
  'semua-brand',
  'promo',
  'daftar-toko-cabang',
  'tentang-kami',
  'artikel-review',
  'video-review',
  'marketplace',
])
const TRACKING_PARAM = /^(utm_\w+|igshid|fbclid|gclid|si)$/i
const BLOCKS = 'p, div, ul, ol, li, figure, h1, h2, h3, h4, h5, h6, table, blockquote'
const KEEP_ATTRS = {
  a: ['href', 'target', 'rel'],
  img: ['src', 'alt', 'width', 'height', 'loading', 'decoding'],
  ol: ['start'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan'],
}
const words = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
// Elementor repeats the post title as an <h1>, sometimes with small typos ("Kegunaannya")
const sameTitle = (a, b) => {
  const [x, y] = [words(a), new Set(words(b))]
  return x.filter((w) => y.has(w)).length / Math.max(x.length, y.size) >= 0.7
}
const textOf = ($el) => clean($el.text())

// Most post images are spec cards and info posters whose content (price, RAM/storage, specs)
// exists only as pixels, so screen-reader users would miss the actual recommendation. These
// descriptions were transcribed from the images. Keyed by the local file name (upload name +
// URL hash, so generic uploads like "2.webp" stay apart); the model name is left out because the
// section heading right next to the image already says it.
const specCard = ([screen, chip, rear, front, battery], prices) =>
  `Kartu spesifikasi: layar ${screen}, ${chip}, kamera belakang ${rear}` +
  `${front ? `, kamera depan ${front}` : ''}, baterai ${battery}. Harga ${prices}.`
const SMART_7 = specCard(
  ['6,6 inci IPS LCD 60 Hz', 'MediaTek Helio A22', '13 MP + 0,3 MP', '5 MP', '5.000 mAh'],
  '3/64 GB Rp1.199.000, 4/64 GB Rp1.299.000',
)
const ZERO_20 = specCard(
  ['6,7 inci AMOLED 90 Hz', 'MediaTek Helio G99', '108 MP + 13 MP', '60 MP', '4.500 mAh'],
  '8/256 GB Rp3.599.000',
)
const ZERO_5G_2023 = specCard(
  ['6,78 inci IPS LCD 120 Hz', 'MediaTek Dimensity 920 5G', '50 MP + 2 MP + 2 MP', '16 MP', '5.000 mAh'],
  '8/256 GB Rp3.699.000',
)
const POCO_X5 = specCard(
  ['6,67 inci AMOLED', 'Snapdragon 695 5G', '48 MP + 8 MP + 2 MP', '13 MP', '5.000 mAh'],
  '6/128 GB Rp3.499.000, 8/256 GB Rp3.999.000',
)
const POCO_M5 = specCard(
  ['6,58 inci IPS LCD 90 Hz', 'MediaTek Helio G99', '50 MP + 2 MP + 2 MP', '5 MP', '5.000 mAh'],
  '4/64 GB Rp2.199.000, 4/128 GB Rp2.399.000',
)
const POST_IMAGE_LABELS = {
  // rekomendasi-handphone-gaming-5g-yang-super-ngebut (press photos, no text)
  '2-b42059': 'Poco X5 5G warna kuning, tampak belakang dengan tiga kamera di panel hitam.',
  '3-904b22': 'Samsung Galaxy M54 5G dalam tiga warna, dengan tulisan kamera 108 MP di layarnya.',
  '4-59a571': 'Bagian belakang Infinix GT 10 Pro warna hitam dengan aksen oranye bergaya gaming.',
  '5-272000': 'Redmi Note 12 Pro 5G warna hitam, putih, dan biru, tampak belakang dan depan.',
  // rekomendasi-hp-infinix-2-jutaan-terbaik-2023
  'september-6-putih-1-4af6e1': specCard(
    ['6,78 inci IPS LCD 90 Hz', 'MediaTek Helio G88', '50 MP + 0,08 MP', '8 MP', '5.000 mAh'],
    '8/128 GB Rp1.899.000 (sebelumnya Rp2.099.000), 8/256 GB Rp2.499.000',
  ),
  'september-6-putih-2-b7d36e': specCard(
    ['6,58 inci IPS LCD 120 Hz', 'MediaTek Dimensity 810', '50 MP + QVGA', '8 MP', '5.000 mAh'],
    '4/128 GB Rp2.599.000',
  ),
  'september-6-putih-3-285daa': specCard(
    ['6,78 inci IPS LCD 120 Hz', 'MediaTek Helio G99', '64 MP + 2 MP', '16 MP', '5.000 mAh'],
    '8/256 GB Rp2.199.000 (sebelumnya Rp2.699.000)',
  ),
  // rekomendasi-ai-gratis-yang-wajib-di-coba
  'agustus-8-biru-3-62739e':
    'Kartu info: AI yang memudahkan siapa saja membuat video dan animasi, lebih cepat daripada memakai software edit video profesional.',
  'agustus-8-biru-2-e0cb4f':
    'Kartu info: AI populer untuk membuat konten pemasaran seperti konten web, caption, naskah video, dan blog, serta membantu menulis, mengoptimalkan, dan menempatkan konten.',
  'agustus-8-biru-1-837ad3':
    'Kartu info: AI untuk posting otomatis ke media sosial, mengunggah konten ke banyak platform sekaligus dengan satu klik untuk menaikkan traffic.',
  // rekomendasi-hp-murah-spek-dewa
  'juli-23-putih-1-61204f': specCard(
    ['6,7 inci IPS LCD', 'MediaTek Helio G85', '50 MP + 0,8 MP', '5 MP', '5.000 mAh'],
    '3/32 GB Rp1.299.000, 4/64 GB Rp1.399.000, 4/128 GB Rp1.599.000',
  ),
  'juli-23-putih-3-1ca416': specCard(
    ['6,82 inci LCD IPS 90 Hz', 'MediaTek Helio G85', '64 MP + 16 MP', '8 MP', '7.000 mAh'],
    '4/64 GB Rp1.799.000, 4/128 GB Rp1.999.000, 6/128 GB Rp2.199.000',
  ),
  'juli-23-putih-2-b938b4': POCO_M5,
  'juli-23-putih-4-0b2d86': specCard(
    ['6,78 inci IPS LCD 90 Hz', 'MediaTek Helio G88', '50 MP + 0,08 MP', '8 MP', '5.000 mAh'],
    '8/128 GB Rp2.099.000, 8/256 GB Rp2.499.000',
  ),
  // rekomendasi-hp-infinix-1-jutaan-terbaik
  'slide-2-daftar-hp-infinix-turun-harga-mei-2023-1-5dd4ae': specCard(
    ['6,6 inci', 'Unisoc SC9863A', '8 MP + 0,8 MP', null, '5.000 mAh'],
    '2/32 GB Rp1.299.000 (sebelumnya Rp1.349.000)',
  ),
  'slide-2-rekomendasi-hp-infinix-1-jutaan-7c9938': SMART_7,
  'slide-3-rekomendasi-hp-infinix-1-jutaan-e27bf7': specCard(
    ['6,8 inci IPS LCD 60 Hz', 'MediaTek Helio G25', '8 MP + 0,3 MP', '5 MP', '5.000 mAh'],
    '3/64 GB Rp1.422.000',
  ),
  'slide-4-rekomendasi-hp-infinix-1-jutaan-88c2b6': specCard(
    ['6,6 inci IPS LCD', 'MediaTek Helio G25', '13 MP + QVGA', '8 MP', '5.000 mAh'],
    '4/64 GB Rp1.499.000, 4/128 GB Rp1.649.000',
  ),
  // rekomendasi-hp-infinix-3-jutaan-terbaik-2023
  'slide-2-rekomendasi-infinix-3-jutaan-a5d3e1': ZERO_20,
  'slide-3-rekomendasi-infinix-3-jutaan-1af68b': specCard(
    ['6,78 inci', 'MediaTek Dimensity 900 5G', '48 MP + 13 MP + 2 MP', '16 MP', '5.000 mAh'],
    '8/128 GB Rp3.599.000',
  ),
  'slide-4-rekomendasi-infinix-3-jutaan-2b06dd': ZERO_5G_2023,
  'slide-5-rekomendasi-infinix-3-jutaan-91f97f': specCard(
    ['6,7 inci', 'MediaTek Helio G96', '108 MP + 2 MP', '16 MP', '4.500 mAh'],
    '8/256 GB Rp3.812.000 (sebelumnya Rp4.099.000)',
  ),
  // rekomendasi-hp-2-jutaan-dengan-kamera-50mp
  'slide-2-rekomendasi-hp-2-jutaan-kamera-50-mp-c88bd8': specCard(
    ['6,58 inci LCD 90 Hz', 'MediaTek Dimensity 700', '50 MP + 2 MP', '5 MP', '5.000 mAh'],
    '4/128 GB Rp2.399.000, 6/128 GB Rp2.599.000',
  ),
  'slide-3-rekomendasi-hp-2-jutaan-kamera-50-mp-2373e6': POCO_M5,
  'slide-4-rekomendasi-hp-2-jutaan-kamera-50-mp-711465': specCard(
    ['6,55 inci IPS LCD 60 Hz', 'MediaTek Helio G85', '50 MP + 2 MP', '8 MP', '5.000 mAh'],
    '4/64 GB Rp2.299.000, 4/128 GB Rp2.399.000, 6/128 GB Rp2.999.000',
  ),
  'slide-5-rekomendasi-hp-2-jutaan-kamera-50-mp-c2cf09': specCard(
    ['6,6 inci PLS LCD', 'MediaTek Helio G80', '50 MP + 5 MP + 2 MP', '13 MP', '5.000 mAh'],
    '6/128 GB Rp2.699.000',
  ),
  // 3-hp-flagship-samsung-terbaik-2023
  'slide-2-daftar-hp-flagship-samsung-fa3375': specCard(
    ['6,8 inci AMOLED 120 Hz', 'Snapdragon 8 Gen 2', '200 MP + 10 MP + 10 MP', '12 MP', '5.000 mAh'],
    '8/256 GB Rp19.999.000, 8 GB/1 TB Rp25.999.000',
  ),
  'slide-3-daftar-hp-flagship-samsung-e90c36': specCard(
    ['7,6 inci Super AMOLED 120 Hz', 'Snapdragon 8+ Gen 1', '50 MP + 10 MP + 12 MP', '4 MP + 10 MP', '4.400 mAh'],
    '8/256 GB Rp24.999.000',
  ),
  'slide-4-daftar-hp-flagship-samsung-ca65a4': specCard(
    ['6,7 inci AMOLED 120 Hz', 'Snapdragon 8+ Gen 1', '12 MP + 12 MP', '10 MP', '3.700 mAh'],
    '8/256 GB Rp14.999.000',
  ),
  // tips-menyimpan-hp-yang-benar
  'slide-2-cara-menyimpan-hp-yang-benar-6a47c5':
    'Ilustrasi: HP dengan layar menghadap atas ditandai salah, HP dengan layar menghadap bawah ditandai benar.',
  'slide-3-cara-menyimpan-hp-yang-benar-12713b':
    'Ilustrasi: HP di saku belakang celana jeans ketat ditandai salah, HP di kantong tas ransel ditandai benar.',
  'slide-4-cara-menyimpan-hp-yang-benar-88a66a':
    'Ilustrasi: HP di dekat laptop ditandai salah, HP di atas meja yang jauh dari perangkat lain ditandai benar.',
  'slide-5-cara-menyimpan-hp-yang-benar-270218':
    'Ilustrasi: HP dicampur jam tangan dan barang lain di dalam tas ditandai salah, HP di kantong tas tersendiri ditandai benar.',
  // daftar-hp-infinix-terbaru-2023
  'slide-2-daftar-hp-infinix-terbaru-2023-66e3a4': SMART_7,
  'slide-3-daftar-hp-infinix-terbaru-2023-93a291': specCard(
    ['6,7 inci AMOLED', 'MediaTek Helio G99', '50 MP + 2 MP + QVGA', '16 MP', '5.000 mAh'],
    '8/128 GB Rp2.799.000, 8/256 GB Rp2.999.000',
  ),
  'slide-4-daftar-hp-infinix-terbaru-2023-758715': ZERO_20,
  'slide-5-daftar-hp-infinix-terbaru-2023-294eef': ZERO_5G_2023,
  // rekomendasi-hp-keluaran-terbaru-april-2023
  'slide-2-rekomendasi-hp-keluaran-2023-0916f0': specCard(
    ['6,7 inci IPS LCD', 'MediaTek Helio G85', '50 MP + 0,8 MP', '5 MP', '5.000 mAh'],
    '3/32 GB Rp1.399.000, 4/64 GB Rp1.599.000, 4/128 GB Rp1.799.000',
  ),
  'slide-3-rekomendasi-hp-keluaran-2023-68a99e': specCard(
    ['6,6 inci LCD 90 Hz', 'MediaTek Dimensity 700', '50 MP + 2 MP + 2 MP', '13 MP', '5.000 mAh'],
    '6/128 GB Rp2.999.000',
  ),
  'slide-4-rekomendasi-hp-keluaran-2023-08970d': POCO_X5,
  'slide-5-rekomendasi-hp-keluaran-2023-57939f': specCard(
    ['6,62 inci AMOLED 120 Hz', 'MediaTek Helio G99', '64 MP + 2 MP + 2 MP', '32 MP', '4.600 mAh'],
    '8/256 GB Rp4.299.000, 12/256 GB Rp4.899.000',
  ),
  // daftar-hp-dengan-refresh-rate-120hz-termurah
  'slide-2-daftar-hp-refresh-rate-120hz-50293b': ZERO_5G_2023,
  'slide-3-daftar-hp-refresh-rate-120hz-57d3d3': specCard(
    ['6,6 inci LCD 120 Hz', 'Snapdragon 695 5G', '50 MP + 5 MP + 2 MP', '8 MP', '5.000 mAh'],
    '6/128 GB Rp3.999.000',
  ),
  'slide-4-daftar-hp-refresh-rate-120hz-b884ea': POCO_X5,
  // rekomendasi-hp-oppo-2-jutaan-terbaru
  'slide-2-rekomendasi-hp-oppo-2-jutaan-2984c2': specCard(
    ['6,52 inci', 'MediaTek Helio G35', '13 MP + 2 MP + 2 MP', null, '5.000 mAh'],
    '3/32 GB Rp1.799.000, 4/64 GB Rp2.499.000',
  ),
  'slide-3-rekomendasi-hp-oppo-2-jutaan-3ae9eb': specCard(
    ['6,56 inci', 'MediaTek Helio G35', '13 MP + 2 MP', '8 MP', '5.000 mAh'],
    '4/64 GB Rp2.399.000, 4/128 GB Rp2.699.000',
  ),
  'slide-4-rekomendasi-hp-oppo-2-jutaan-b0cb7b': specCard(
    ['6,51 inci', 'MediaTek Helio G35', '50 MP + 2 MP + 2 MP', '16 MP', '5.000 mAh'],
    '4/64 GB Rp2.699.000',
  ),
  'slide-5-rekomendasi-hp-oppo-2-jutaan-d000f8': specCard(
    ['6,51 inci', 'MediaTek Helio P35', '13 MP + 2 MP + 2 MP', null, '5.000 mAh'],
    '6/128 GB Rp2.799.000',
  ),
}
// Post images that still need a POST_IMAGE_LABELS entry, reported at the end of the articles step
const unlabelledPostImages = []

// Loose comparison for "this alt only repeats the heading/title": case, numbering and punctuation
// are ignored, and an alt that contains the heading ("Rekomendasi … - 1. Poco X5 5G") counts too.
const squash = (s = '') => words(s.replace(/^\d+\.\s*/, '')).join(' ')
const repeats = (alt, text) => {
  const [a, t] = [squash(alt), squash(text)]
  return !!a && !!t && (a === t || a.includes(t) || t.includes(a))
}

// Turn WordPress/Elementor markup into plain semantic HTML that .prose-cs can style.
async function cleanPost($, { slug, title, coverUrl, postSlugs, productLink }) {
  $('script, style, noscript, iframe[src*="facebook"]').remove()

  // Images: bring them local, and drop a leading copy of the cover (the page already shows it on top)
  const cover = await rawImage(coverUrl)
  const imgs = $('img').toArray()
  for (const [i, el] of imgs.entries()) {
    const src = $(el).attr('data-src') || $(el).attr('src')
    const raw = src && !src.startsWith('data:') ? ((await rawImage(fullSize(src))) ?? (await rawImage(src))) : null
    const img = raw && !(i === 0 && raw.digest === cover?.digest) && (await renderOnce(raw, 'posts', [900]))
    if (!img) {
      $(el).remove()
      continue
    }
    $(el).attr({ src: img.src, width: String(img.w), height: String(img.h), loading: 'lazy', decoding: 'async' })
  }

  // Layout wrappers and styling spans mean nothing once restyled; inline tags wrapping whole
  // blocks (a <strong> around an <ol>) are invalid HTML
  for (const el of $('div, section, span, font').toArray()) $(el).replaceWith($(el).contents())
  for (const el of $('strong, b, em, i').toArray().reverse()) {
    if ($(el).find(BLOCKS).length) $(el).replaceWith($(el).contents())
  }
  for (const el of $('*').toArray()) {
    const keep = KEEP_ATTRS[el.name] ?? []
    for (const name of Object.keys(el.attribs)) if (!keep.includes(name)) $(el).removeAttr(name)
  }

  // Bylines ("Penulis : … | Editor : …") belong to the old CMS, not the article
  $('p')
    .filter((_, p) => /^Penulis\b.*\bEditor\b/i.test(textOf($(p))) || /^Penulis dan editor\s*:/i.test(textOf($(p))))
    .remove()
  // The page renders the real <h1>; Elementor's copy of the title goes, any other h1 becomes a section
  const h1 = $('h1').first()
  if (h1.length && sameTitle(textOf(h1), title)) h1.remove()
  $('h1').each((_, el) => (el.name = 'h2'))
  $('h4, h5, h6')
    .filter((_, h) => /^Baca Juga\b/i.test(textOf($(h))))
    .each((_, el) => (el.name = 'p'))

  // Section titles: authors fake them with one-item lists (<ol start="4"><li><strong>…), numbered
  // paragraphs or short lines between &nbsp; spacers. Numbered ones are renumbered (source: 1,2,3,4,6,4).
  const root = $.root()[0]
  const attached = (el) => {
    while (el.parent) el = el.parent
    return el === root
  }
  // trim() already strips U+00A0, so a "&nbsp;" paragraph has text but nothing left once trimmed
  const isSpacer = (el) => el?.name === 'p' && $(el).text() !== '' && !$(el).text().trim()
  const isEmpty = (el) => !$(el).text().trim() && !$(el).find('img, iframe').length
  const shortTitle = ($el) => {
    if ($el.find(`img, a, br, ${BLOCKS}`).length) return null
    const t = textOf($el)
    return t && t.length <= 90 && !/[.,;:]$/.test(t) ? t : null
  }
  const without = ($el, sel) => {
    const $c = $el.clone()
    $c.find('figcaption').remove()
    $c.children(sel).first().remove()
    return textOf($c)
  }
  let num = 0
  const section = (text, numbered) =>
    $('<h2></h2>').text(numbered ? `${++num}. ${text.replace(/^\d+\.\s*/, '')}` : text)[0]
  for (const el of $('ul, ol, p').toArray()) {
    if (!attached(el)) continue
    const $el = $(el)
    if (el.name === 'p') {
      if ($el.closest('li').length) continue
      const t = shortTitle($el)
      if (!t) continue
      if (num > 0 && /^\d{1,2}\.\s+\S/.test(t) && t.length <= 60) $el.replaceWith(section(t, true))
      else if (t.length <= 70 && isSpacer($el.prev()[0])) $el.replaceWith(section(t, false))
      continue
    }
    $el
      .children('p')
      .filter((_, p) => isEmpty(p))
      .remove()
    const items = $el.children('li')
    if (!items.length) {
      $el.remove()
      continue
    }
    if (items.length === 1) {
      const $li = items.first()
      const bold = $li.children('strong, b').length === 1 && !without($li, 'strong, b')
      const t = (bold || el.name === 'ol') && shortTitle($li)
      if (t) $el.replaceWith(section(t, el.name === 'ol'))
      continue
    }
    // "<li><strong>Poco M5</strong><figure>…</figure></li>" lists are really name + photo sections
    const asSections = items
      .toArray()
      .every((li) => $(li).children('strong, b').length && $(li).find('img').length && !without($(li), 'strong, b'))
    if (asSections) {
      $el.replaceWith(
        items
          .toArray()
          .flatMap((li) => [
            section(textOf($(li).children('strong, b').first()), false),
            ...$(li).children('figure, img, p').toArray(),
          ]),
      )
    }
  }

  // Spacer and empty paragraphs, empty lists/figures
  $('p')
    .filter((_, p) => isEmpty(p))
    .remove()
  $('li')
    .filter((_, li) => isEmpty(li))
    .remove()
  $('ul, ol')
    .filter((_, l) => !$(l).children('li').length)
    .remove()
  $('figure')
    .filter((_, f) => !$(f).find('img').length)
    .remove()

  // Elementor closes and reopens a list around items it styled on their own, so one 5-step list
  // arrives as four <ul>s and the gaps between bullets alternate. Lists that touch become one.
  const nextElement = (el) => {
    let n = el.nextSibling
    while (n && n.type === 'text' && !n.data.trim()) n = n.nextSibling
    return n?.type === 'tag' ? n : null
  }
  for (const el of $('ul, ol').toArray()) {
    if (!attached(el)) continue
    for (let next = nextElement(el); next?.name === el.name; next = nextElement(el)) {
      // A numbered list only continues if the next one picks up the count (or never set one)
      const expected = Number($(el).attr('start') || 1) + $(el).children('li').length
      if (el.name === 'ol' && $(next).attr('start') && Number($(next).attr('start')) !== expected) break
      $(el).append($(next).children('li'))
      $(next).remove()
    }
  }

  // Line breaks and &nbsp; typed at the edges of a paragraph only add an empty line, and a stray
  // &nbsp; between blocks renders as a line of its own
  for (const p of $('p').toArray()) {
    for (const end of ['firstChild', 'lastChild']) {
      let n = p[end]
      while (n && ((n.type === 'tag' && n.name === 'br') || (n.type === 'text' && !n.data.trim()))) {
        $(n).remove()
        n = p[end]
      }
      if (n?.type === 'text') n.data = end === 'firstChild' ? n.data.replace(/^\s+/, '') : n.data.replace(/\s+$/, '')
    }
  }
  for (const n of root.children) if (n.type === 'text' && !n.data.trim()) n.data = '\n'

  // Section titles typed as a bare question ("Apa Itu Saluran di WhatsApp?") followed by the
  // answer. Closing questions to the reader are longer or end the post, so they stay paragraphs.
  for (const el of $('p').toArray()) {
    const $el = $(el)
    if ($el.closest('li, figure, blockquote, td, th').length) continue
    const t = shortTitle($el)
    if (!t || t.length > 80 || !t.endsWith('?')) continue
    const next = nextElement(el)
    const answer = next && /^(p|ul|ol)$/.test(next.name) ? textOf($(next)) : ''
    if (answer.length < 40 || answer.endsWith('?') || /^Jangan (lupa|lewatkan)\b/i.test(answer)) continue
    // "Lalu, bagaimana cara …?" reads as a heading without its lead-in
    const q = t.replace(/^(?:lalu|nah|jadi|terus|kemudian)\b\s*,?\s*/i, '')
    $el.replaceWith($('<h2></h2>').text(q.charAt(0).toUpperCase() + q.slice(1)))
  }

  // Lone images get a figure so .prose-cs spaces them like the rest
  $('img')
    .filter((_, img) => !$(img).parent().is('figure, p, a, li'))
    .wrap('<figure></figure>')

  // Links: old-domain URLs become SPA routes, missing products become a catalogue search,
  // tracking params go, and external links open in a new tab
  for (const a of $('a[href]').toArray()) {
    const $a = $(a)
    let url
    try {
      url = new URL($a.attr('href'), ORIGIN)
    } catch {
      $a.replaceWith($a.contents())
      continue
    }
    for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAM.test(key)) url.searchParams.delete(key)
    if (!/^https?:$/.test(url.protocol)) continue
    if (url.hostname.replace(/^www\./, '') !== new URL(ORIGIN).hostname) {
      $a.attr({ href: url.href, target: '_blank', rel: 'noopener' })
      continue
    }
    const segs = url.pathname.split('/').filter(Boolean)
    let to = null
    if (segs[0] === 'product' && segs[1]) to = productLink(segs[1], textOf($a))
    else if (segs[0] === 'brand' && segs[1]) to = `/brand/${segs[1]}`
    else if (segs.length === 1 && postSlugs.has(segs[0])) to = `/artikel/${segs[0]}`
    else if (segs.length === 1 && ROUTES.has(segs[0])) to = `/${segs[0]}`
    if (to) {
      $a.attr('href', to).removeAttr('target').removeAttr('rel')
    } else {
      // Home page, uploads and posts outside this snapshot: keep the words, drop the link
      const block = $a.closest('p')
      if (/^Baca Juga\b/i.test(textOf(block))) block.remove()
      else $a.replaceWith($a.contents())
    }
  }

  // Alt text: the transcription in POST_IMAGE_LABELS, else the figure caption or the upload's own
  // alt. One that only repeats the heading beside it (images sit before or after theirs) or the
  // title is dropped, since a screen reader would read the name twice; the image is then
  // decorative and the post is listed for a transcription.
  const flow = $('h2, h3, img').toArray()
  for (const [i, el] of flow.entries()) {
    if (el.name !== 'img') continue
    const $img = $(el)
    const near = [flow.slice(0, i).findLast((n) => n.name !== 'img'), flow.slice(i + 1).find((n) => n.name !== 'img')]
      .filter(Boolean)
      .map((h) => textOf($(h)))
    const $cap = $img.closest('figure').find('figcaption')
    const caption = textOf($cap)
    if (caption && near.some((h) => repeats(caption, h))) $cap.remove()
    const key = path.basename($img.attr('src') ?? '', '.webp')
    const own = [caption, clean($img.attr('alt') || '')].find(
      (t) => t && ![...near, title].some((h) => repeats(t, h)) && !/\.(jpe?g|png|webp)$|^(img|dsc|whatsapp)\b/i.test(t),
    )
    const alt = POST_IMAGE_LABELS[key] ?? own ?? ''
    if (!POST_IMAGE_LABELS[key]) unlabelledPostImages.push(`${slug}: ${key}${own ? ` (alt "${own}")` : ''}`)
    $img.attr('alt', alt)
  }

  // Typos such as "bersiap untuk untuk merilis"
  const fixText = (node) => {
    for (const c of node.children ?? []) {
      if (c.type === 'text') c.data = c.data.replace(/\b([A-Za-z]{3,})\s+\1\b/g, '$1')
      else fixText(c)
    }
  }
  fixText(root)
}

function excerptOf($, title) {
  const text = clean(
    $('p')
      .filter((_, p) => !$(p).closest('figure, li').length)
      .map((_, p) => $(p).text())
      .get()
      .join(' '),
  )
    .replace(new RegExp(`^${escapeRe(title)}\\s*`, 'i'), '')
    .replace(/^Complete ?selular\s*[–—-]\s*/i, '')
    .replace(/^Artikel ini berjudul [^.]+\.\s*/i, '')
  return truncate(text, 160)
}

async function scrapePosts(products) {
  console.log(`• Articles (${POST_LIMIT})`)
  const posts = await fetchJson(`${ORIGIN}/wp-json/wp/v2/posts?per_page=${POST_LIMIT}&_embed=wp:featuredmedia,wp:term`)
  const postSlugs = new Set(posts.map((p) => p.slug))
  // Old posts link products that are no longer listed: search the catalogue when it has a match,
  // else open the brand page, so a click never ends on "0 produk"
  const productLink = (slug, text) => {
    if (products.some((p) => p.slug === slug)) return `/product/${slug}`
    const q = words(text)
    if (products.some((p) => q.every((w) => words(p.name).includes(w)))) return `/katalog?q=${encodeURIComponent(text)}`
    const lead = BRAND_ALIASES[q[0]] ?? q[0]
    return products.some((p) => p.brand === lead) ? `/brand/${lead}` : `/katalog?q=${encodeURIComponent(text)}`
  }
  const index = []
  for (const p of posts) {
    const title = clean(decode(p.title.rendered))
    const coverUrl = p._embedded?.['wp:featuredmedia']?.[0]?.source_url
    const $ = cheerio.load(p.content.rendered, null, false)
    await cleanPost($, { slug: p.slug, title, coverUrl, postSlugs, productLink })
    const cover = await image(coverUrl, 'posts', [480, 1200], { srcset: true })
    const entry = {
      slug: p.slug,
      title,
      date: p.date,
      excerpt:
        excerptOf($, title) || truncate(clean(decode(p.excerpt.rendered)).replace(/\s*\[(…|&hellip;)\]\s*$/, ''), 160),
      category: (p._embedded?.['wp:term'] || []).flat().find((t) => t.taxonomy === 'category')?.name ?? null,
      cover: cover?.[480] ?? null,
    }
    index.push(entry)
    await writeJson(path.join(PUB_DATA, 'posts', `${p.slug}.json`), {
      ...entry,
      coverLarge: cover?.[1200] ?? null,
      html: $.html()
        .replace(/[ \t]*\n[\s]*/g, '\n')
        .trim(),
    })
  }
  await writeJson(path.join(PUB_DATA, 'posts.json'), index)
  if (unlabelledPostImages.length) {
    console.log(
      `\n! ${unlabelledPostImages.length} post images have no description in POST_IMAGE_LABELS — ` +
        'transcribe the ones that carry text (prices, specs):',
    )
    for (const line of unlabelledPostImages) console.log(`    ${line}`)
  }
}

// ---------- branches ----------

const titleWord = (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
// Store names are typed in caps; keep the brands' own spelling (OPPO, HP Mart, Mi Shop, CS)
const NAME_WORDS = { oppo: 'OPPO', cs: 'CS', hp: 'HP', hpmart: 'HP Mart', ii: 'II', iii: 'III' }
const branchName = (s) =>
  clean(s.replace(/([a-z])(\d+)$/i, '$1 $2'))
    .split(' ')
    .map((w) => NAME_WORDS[w.toLowerCase()] ?? titleWord(w))
    .join(' ')

const CITIES = 'Cirebon|Cilacap|Kuningan|Indramayu|Majalengka|Brebes|Tegal|Pemalang|Purwokerto|Banyumas'
// Abbreviations that always take a dot, and acronyms that stay uppercase
const ADDRESS_ABBR = { jl: 'Jl.', no: 'No.', kec: 'Kec.', gg: 'Gg.' }
const ADDRESS_UPPER = new Set(['rt', 'rw', 'kh', 'ra', 'sman', 'smpn', 'sdn', 'hp'])
const LOWER_WORDS = new Set(['dan', 'di', 'ke', 'dari', 'yang'])

// The branch widget prints empty form fields as "0", mixes in Google's English ("West Java") and some
// entries are typed in caps with a land-certificate number. Make them read like a normal address.
function cleanAddress(s) {
  const caps = (s.match(/[A-Z]/g)?.length ?? 0) > 0.8 * (s.match(/[a-z]/gi)?.length ?? 1)
  let a = s
    .replace(/\(\s*(?:SHM|SHGB|HGB|AJB)\b[^)]*\)/gi, '')
    .replace(/\(\s*0\s*\)/g, '')
    .replace(/,\s*0\s*(?=,|$)/g, '')
    .replace(/\bWest Java\b/gi, 'Jawa Barat')
    .replace(/\bCentral Java\b/gi, 'Jawa Tengah')
    .replace(/\bEast Java\b/gi, 'Jawa Timur')
    .replace(/\bCentral ([A-Z]\w+)/g, '$1 Tengah')
  if (caps) a = a.toLowerCase()
  a = a
    .replace(/[A-Za-z]+\.?/g, (w) => {
      const bare = w.replace(/\.$/, '').toLowerCase()
      if (ADDRESS_ABBR[bare]) return ADDRESS_ABBR[bare]
      if (ADDRESS_UPPER.has(bare)) return w.toUpperCase()
      if (LOWER_WORDS.has(w)) return w
      return /^[a-z]/.test(w) ? w.charAt(0).toUpperCase() + w.slice(1) : w
    })
    .replace(/\bJl\.\s*/g, 'Jl. ')
    .replace(/\bNo\.\s*(?=\d)/g, 'No. ')
    .replace(/\bRT\.?\s*(\d+)\s*,\s*RT\.?\s*(\d+)/g, 'RT. $1/RW. $2')
    .replace(/\s+,/g, ',')
    .replace(/,(\s*,)+/g, ',')
  if (caps) {
    // Typed without punctuation: "… No. 166 Petarukan Pemalang Jawa Tengah"
    a = a
      .replace(/(No\. \d+\w*)\s+(?=[A-Z])/g, '$1, ')
      .replace(/([\w.])\s+(?=(?:Desa|Kecamatan|Kota|Kabupaten|Jawa (?:Barat|Tengah|Timur))\b|Kec\.|Kab\.)/g, '$1, ')
      .replace(new RegExp(`(?<!\\b(?:Kec\\.|Kota|Kabupaten|Kab\\.|Desa))\\s+(${CITIES})(?=,|\\s+\\d|$)`, 'g'), ', $1')
  }
  return (
    a
      .split(/\s*,\s*/)
      .filter((seg, i, all) => seg && seg.toLowerCase() !== all[i - 1]?.toLowerCase())
      .join(', ')
      // "Jl. Tuparev, No. 109" → "Jl. Tuparev No. 109"; landmarks and postcodes attach to what precedes them
      .replace(/,\s*(No\. )/g, ' $1')
      .replace(/,\s*(\()/g, ' $1')
      .replace(/,\s*(\d{5})\b/g, ' $1')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

async function scrapeBranches() {
  console.log('• Branches')
  const $ = await load('/daftar-toko-cabang/')
  // Each branch is one item of an Essential Addons "feature list" widget
  const branches = []
  $('#content .eael-feature-list-item').each((_, item) => {
    const $item = $(item)
    const name = clean($item.find('h2').first().text())
    const address = clean($item.find('p').first().text())
    const maps = $item.find('a[href*="goo"]').first().attr('href') ?? null
    if (name && address) branches.push({ name: branchName(name), address: cleanAddress(address), maps })
  })
  const cityOf = (addr) => {
    const m = addr.match(/\b(?:Kota|Kabupaten|Kab\.)\s+([a-z]+)/i) || addr.match(new RegExp(`\\b(${CITIES})\\b`, 'i'))
    return m ? titleWord(m[1]) : 'Lainnya'
  }
  return branches.map((b) => {
    const city = cityOf(b.address)
    const province = PROVINCE_OF[city] ?? null
    return { ...b, address: withProvince(b.address, province), city, province }
  })
}

// Half the addresses stop at the village ("…, Cirebon, Kedawung, Sutawinangun 45153"), which
// reads incomplete next to the ones Google wrote out in full.
const PROVINCE_OF = Object.fromEntries([
  ...['Cirebon', 'Kuningan', 'Indramayu', 'Majalengka'].map((c) => [c, 'Jawa Barat']),
  ...['Cilacap', 'Brebes', 'Tegal', 'Pemalang', 'Purwokerto', 'Banyumas'].map((c) => [c, 'Jawa Tengah']),
])
function withProvince(address, province) {
  if (!province || /\bJawa (?:Barat|Tengah|Timur)\b/i.test(address)) return address
  // The postcode goes last, as in "Kabupaten Cirebon, Jawa Barat 45159"
  const m = address.match(/^(.*?)[\s,]+(\d{5})$/)
  return m ? `${m[1]}, ${province} ${m[2]}` : `${address}, ${province}`
}

// ---------- about, promos, videos ----------

async function scrapeAbout() {
  console.log('• About')
  const $ = await load('/tentang-kami/')
  const text = clean($('#content').text())
  const img = $('#content img')
    .map((_, el) => $(el).attr('data-src') || $(el).attr('src'))
    .get()
    .find((s) => /tentangkami/i.test(s))
  const after = (marker) => text.split(marker)[1] ?? ''
  const vision = after('visi :').match(/“([^”]+)”/)?.[1] ?? null
  // Missions are "1. …<br>2. …" inside the paragraph that starts with "Dengan misi"
  const missionHtml =
    $('#content p')
      .filter((_, p) => /misi\s*:/i.test($(p).text()))
      .first()
      .html() ?? ''
  const missions = missionHtml
    .split(/<br\s*\/?>/i)
    .map((line) => clean(cheerio.load(line).text()))
    .filter((line) => /^\d+\./.test(line))
    .map((line) => line.replace(/^\d+\.\s*/, '').replace(/\s+,/g, ','))
  const intro =
    text
      .match(/Sejak didirikan[^.]+\.[^.]+\./)?.[0]
      // Title Case mid-sentence ("layanan Telekomunikasi & Aksesoris Handphone")
      .replace(/(?<=\S )(Telekomunikasi|Aksesoris|Handphone)\b/g, (w) => w.toLowerCase()) ?? null
  const values =
    text
      .match(/Tagline\s+(.+?)\s+Kami percaya/)?.[1]
      .split(/,\s*/)
      .map((v) => v.trim()) ?? []
  return {
    // Written for this site: the source repeats its vision statement here word for word
    tagline: 'Toko smartphone dan aksesoris original sejak 2009, kini dengan lebih dari 60 cabang.',
    intro,
    vision,
    missions,
    values: values.length ? values : ['Bersahabat', 'Orisinil', 'Terkini'],
    image: await image(fullSize(img), 'site', [900]),
  }
}

// The posters carry their offer only as pixels and the source page gives them no alt text, so these
// labels were transcribed from the posters (keyed by upload file name). [title, alt]
const PROMO_LABELS = {
  3: [
    'Juragan Juli Banyak Promoan',
    'Poster Juragan Juli Banyak Promoan: dapatkan free gift berupa kaos, tas, dan mug untuk pembelian smartphone.',
  ],
  'cs_ketupat_promo-1': [
    'Promo Ketupat: Kejar Untung Berlipat',
    'Poster Promo Ketupat periode April: cicilan DP 0%, bunga 0%, dan cashback hingga Rp750 ribu untuk OPPO A38, vivo Y100, realme 12, Samsung A15, Redmi 13C, Infinix Note 40, dan iPhone 11.',
  ],
  'cs-2-baret-scaled': [
    'Ramadhan Super Sale',
    'Poster Ramadhan Super Sale: bulan penuh berkah, diskon melimpah, plus free gift berupa kaos, tas, dan mug.',
  ],
  'promo-november': [
    'Novroblem: Aksesori Cicilan Rp50 Ribu',
    'Poster promo Novroblem November: cukup belanja Rp500.000 bisa dicicil Rp50.000 per bulan untuk aksesori seperti TWS, smartwatch, speaker, dan powerbank.',
  ],
  'promo-november-cs': [
    'Novroblem: Belanja November Tanpa Problem',
    'Poster promo Novroblem November: kredit syarat mudah, gratis screen protector dan proteksi 24 bulan untuk iPhone 15, serta cashback hingga jutaan rupiah untuk OPPO A58, vivo Y17s, realme C51, Redmi 12, Samsung A05s, Infinix Note 30, dan ZTE Blade V50 Design.',
  ],
  'whatsapp-image-2023-06-15-at-15.33.05': [
    'Powerbank Oraimo',
    'Poster Solusi Tepat Buat Kamu: powerbank Oraimo untuk kamu yang sering kehabisan baterai, tersedia di Complete Selular.',
  ],
  'whatsapp-image-2023-06-15-at-15.33.00': [
    'Hydro Gel Pelindung Layar',
    'Poster Hydro Gel: pelindung layar yang bisa disesuaikan dengan tipe HP apa pun, pasang sekarang di Complete Selular.',
  ],
  'whatsapp-image-2023-06-15-at-15.33.02': [
    'Smartwatch',
    'Poster Solusi Tepat Buat Kamu: smartwatch impian kamu, tersedia di Complete Selular.',
  ],
  'whatsapp-image-2023-06-15-at-15.33.03': [
    'Speaker Bluetooth',
    'Poster Solusi Tepat Buat Kamu: speaker Bluetooth untuk kamu yang butuh suara gahar, tersedia di Complete Selular.',
  ],
}

async function scrapePromos() {
  console.log('• Promos')
  const $ = await load('/promo/')
  const posters = $('#content img')
    .map((_, el) => ({
      url: fullSize($(el).attr('data-src') || $(el).attr('src')),
      alt: clean($(el).attr('alt') || ''),
    }))
    .get()
    .filter((p) => p.url && /uploads/.test(p.url) && !/logo/i.test(p.url))
    .filter((p, i, all) => all.findIndex((q) => q.url === p.url) === i)
  const howTo = $('#content a')
    .filter((_, a) => /klik/i.test($(a).text()))
    .attr('href')
  const items = await Promise.all(
    posters.map(async ({ url, alt }) => {
      const img = await image(url, 'promos', [480, 1200])
      if (!img) return null
      const key = path
        .basename(new URL(url).pathname)
        .replace(/\.[a-z0-9]+$/i, '')
        .toLowerCase()
      const [title, label] = PROMO_LABELS[key] ?? [alt || null, alt ? `Poster ${alt}` : 'Poster promo Complete Selular']
      return { thumb: img[480], full: img[1200], title, alt: label }
    }),
  )
  return { howTo: howTo ?? null, items: items.filter(Boolean) }
}

// Shorts are 9:16, but hqdefault letterboxes every frame into 4:3 with black bars. The
// original-aspect frame (oardefault) is sharp and uncropped; fall back to trimming hqdefault's bars.
async function videoThumb(id) {
  let raw = await rawImage(`https://i.ytimg.com/vi/${id}/oardefault.jpg`)
  if (!raw) {
    const hq = await rawImage(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`)
    if (!hq) return null
    try {
      const { data, info } = await sharp(hq.buf)
        .trim({ background: '#000000', threshold: 40 })
        .toBuffer({ resolveWithObject: true })
      raw = { ...hq, buf: data, width: info.width, height: info.height, digest: md5(data) }
    } catch {
      raw = hq
    }
  }
  const portrait = raw.height > raw.width
  const img = await renderOnce(raw, 'videos', portrait ? [360, 720] : [480, 960], { srcset: true })
  return img && { thumb: portrait ? img[720] : img[960], orientation: portrait ? 'portrait' : 'landscape' }
}

async function scrapeVideos() {
  console.log('• Videos')
  const $ = await load('/video-review/')
  const seen = new Set()
  const vids = $('.ayg-thumbnail[data-id]')
    .map((_, el) => ({ id: $(el).attr('data-id'), title: clean($(el).attr('data-title') || '') }))
    .get()
    .filter((v) => v.id && !seen.has(v.id) && seen.add(v.id))
    .slice(0, 36)
  return pool(vids, 4, async (v) => ({ ...v, ...(await videoThumb(v.id)) }))
}

// ---------- variant report ----------

// The site shows one card per phone with its RAM/storage listings as variants (src/lib/variants.js).
// Names the admin typed two ways ("MOTOROLA G57 POWER" vs "Motorola Moto G57 Power 5G") still
// become two cards, so models whose names match once these words are ignored are listed for review.
const LOOSE_NOISE = new Set(['5g', '4g', 'lte', 'ram', 'rom', 'gb', 'tb', 'hp', 'new', 'baru', 'resmi', 'garansi'])
const SUB_BRANDS = { motorola: ['moto'], samsung: ['galaxy'] }
function looseKey(model) {
  const brandWords = new Set([
    model.brand,
    ...(model.brandName ?? '').toLowerCase().split(/\s+/),
    ...(SUB_BRANDS[model.brand] ?? []),
  ])
  const tokens = model.name
    .toLowerCase()
    .replace(/\+/g, ' plus ')
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !LOOSE_NOISE.has(t) && !brandWords.has(t))
  return `${model.brand}|${tokens.join(' ')}`
}

async function variantReport(index) {
  const { models, duplicates } = groupModels(index)
  const nameOf = new Map(index.map((p) => [p.slug, p.name]))
  const summary = (m) => ({
    name: m.name,
    key: m.key,
    variants: m.variants.map((v) => ({ slug: v.slug, label: v.variantLabel, price: v.price ?? null })),
  })
  const byLoose = Object.groupBy(models, looseKey)
  const report = {
    generated: new Date().toISOString(),
    listings: index.length,
    models: models.length,
    multiVariant: models.filter((m) => m.variants.length > 1).map(summary),
    duplicates: duplicates.map((d) => ({ ...d, name: nameOf.get(d.slug) })),
    // Titles whose RAM/storage was corrected from the slug and spec list (titleCapacity)
    renamed: renamedListings,
    possibleDuplicates: Object.values(byLoose)
      .filter((group) => group.length > 1)
      .map((group) => group.map(summary)),
    // A capacity-less listing inside a multi-variant model shows up as a chip with no label
    unlabelled: models.filter((m) => m.variants.length > 1 && m.variants.some((v) => !v.variantLabel)).map(summary),
  }
  await fs.mkdir(CACHE, { recursive: true })
  await fs.writeFile(path.join(CACHE, 'variant-report.json'), JSON.stringify(report, null, 2))

  console.log('\n• Varian')
  console.log(
    `  ${report.models} models from ${report.listings} listings, ${report.multiVariant.length} with more than one variant`,
  )
  if (report.duplicates.length) {
    console.log(`  ${report.duplicates.length} duplicate listings hidden (same model and capacity) → kept listing:`)
    for (const d of report.duplicates) console.log(`    ${d.slug} → ${d.keep}`)
  }
  if (report.renamed.length) {
    const n = report.renamed.length
    console.log(`  ${n} ${n === 1 ? 'title names' : 'titles name'} the wrong RAM/storage (fix in WordPress):`)
    for (const r of report.renamed) console.log(`    ${r.slug}: "${r.from}" → "${r.to}"`)
  }
  if (report.possibleDuplicates.length) {
    console.log(
      `  ${report.possibleDuplicates.length} POSSIBLE duplicates for the admin to review (same phone typed twice?):`,
    )
    for (const group of report.possibleDuplicates) {
      console.log(
        `    ${group.map((m) => `"${m.name}" [${m.variants.map((v) => v.label ?? '?').join(', ')}]`).join('  ↔  ')}`,
      )
    }
  }
  if (report.unlabelled.length) {
    console.log(`  ${report.unlabelled.length} models mix listings with and without RAM/storage in the name:`)
    for (const m of report.unlabelled) console.log(`    ${m.name}: ${m.variants.map((v) => v.slug).join(', ')}`)
  }
  console.log(`  Full report: ${path.relative(ROOT, path.join(CACHE, 'variant-report.json'))}`)
}

// Derived files that no longer belong to the snapshot (renamed variants, dropped products)
async function prune(dir) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let removed = 0
  for (const e of entries) {
    const file = path.resolve(dir, e.name)
    if (e.isFile() && !written.has(file)) {
      await fs.rm(file)
      removed++
    }
  }
  return removed
}

// ---------- run ----------

const t0 = Date.now()
const { site, homeSlugs } = await scrapeSite()
const { brands, categories, index } = await scrapeProducts(homeSlugs)
site.featured = homeSlugs.filter((s) => index.some((p) => p.slug === s))
await scrapePosts(index)
const branches = await scrapeBranches()
const about = await scrapeAbout()
const promos = await scrapePromos()
const videos = (await scrapeVideos()).filter((v) => v.thumb)

await writeJson(path.join(SRC_DATA, 'site.json'), { ...site, about, promos })
await writeJson(path.join(SRC_DATA, 'brands.json'), { brands, categories })
await writeJson(path.join(SRC_DATA, 'branches.json'), branches)
await writeJson(path.join(PUB_DATA, 'videos.json'), videos)

let pruned = 0
for (const dir of ['products', 'posts', 'partners', 'videos', 'promos', 'brands', 'banners']) {
  pruned += await prune(path.join(PUBLIC, 'img', dir))
}
pruned += await prune(path.join(PUB_DATA, 'products'))
pruned += await prune(path.join(PUB_DATA, 'posts'))

await variantReport(index)

console.log(
  `\n✓ ${index.length} products, ${brands.length} brands, ${branches.length} branches, ${videos.length} videos ` +
    `(${pruned} stale files removed) — ${((Date.now() - t0) / 1000).toFixed(0)}s`,
)
