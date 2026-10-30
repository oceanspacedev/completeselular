// House banners for the home carousel, drawn from the store's own data (products, payment
// partners, branch count, Google rating) so nothing on them is made up. Rendered with sharp from
// SVG + the cached original photos, at the same 2560×871 ratio and widths as the scraped banner.
//
//   node scripts/banners.mjs   → public/img/banners/house-*.webp + src/data/banners.json, plus the
//                                home shortcut cut-outs (img/kinds, img/brand-tiles + their JSON)
//
// Text is sized for phones: the banner is ~343px wide there (0.13×), so nothing is smaller than
// ~70px here. Fonts are the Windows system ones (Segoe UI), which this script is run on.
import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { KINDS, productKind } from '../src/lib/format.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const CACHE = path.join(ROOT, '.cache', 'img')
const OUT = path.join(ROOT, 'public', 'img', 'banners')
const W = 2560
const H = 871
const WIDTHS = [768, 1200, 1600]

const NAVY_800 = '#003470'
const NAVY_700 = '#00428a'
const BRAND_200 = '#bbd7ff'
const FONT = `font-family="Segoe UI" font-weight="800"`

const site = JSON.parse(await fs.readFile(path.join(ROOT, 'src', 'data', 'site.json'), 'utf8'))
const product = async (slug) =>
  JSON.parse(await fs.readFile(path.join(ROOT, 'public', 'data', 'products', `${slug}.json`), 'utf8'))

// "/img/products/oppo_a7_pro_5g_surfing_blue_01-5a9385-400.webp" → the cached original
// ".cache/img/5a9385-oppo_a7_pro_5g_surfing_blue_01…", falling back to the published file
async function original(src) {
  const hash = src.match(/-([0-9a-f]{6})(?:-\d+)?\.webp$/)?.[1]
  const files = hash ? (await fs.readdir(CACHE)).filter((f) => f.startsWith(`${hash}-`)) : []
  return files.length ? path.join(CACHE, files[0]) : path.join(ROOT, 'public', src)
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const text = (x, y, size, fill, s, extra = '') =>
  `<text x="${x}" y="${y}" ${FONT} font-size="${size}" fill="${fill}" ${extra}>${esc(s)}</text>`
// White pill with navy label, sized to its text (Segoe UI 800 runs ~0.56em per character)
function pill(x, y, label, size = 72) {
  const w = Math.round(label.length * size * 0.56 + size * 1.6)
  const h = Math.round(size * 1.75)
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="#fff"/>
    ${text(x + w / 2, y + h / 2 + size * 0.35, size, NAVY_800, label, 'text-anchor="middle"')}`
}
const svg = (body, bg) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="${bg}"/>${body}</svg>`,
  )

// Product shots sit on white. Flood-filling the white in from the edges cuts the device out
// without touching white parts of the device itself (a white phone keeps its body).
async function cutout(file, size) {
  const { data, info } = await sharp(file)
    .resize(size, size, { fit: 'contain', background: '#fff' })
    .flatten({ background: '#fff' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const { width: w, height: h } = info
  const white = (i) => data[i] > 238 && data[i + 1] > 238 && data[i + 2] > 238
  const seen = new Uint8Array(w * h)
  const stack = []
  for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x)
  for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1)
  while (stack.length) {
    const p = stack.pop()
    if (seen[p] || !white(p * 4)) continue
    seen[p] = 1
    data[p * 4 + 3] = 0
    const x = p % w
    if (x > 0) stack.push(p - 1)
    if (x < w - 1) stack.push(p + 1)
    if (p >= w) stack.push(p - w)
    if (p < w * (h - 1)) stack.push(p + w)
  }
  // Soften the one-pixel rim the fill leaves, so the edge doesn't show a white fringe on navy
  for (let p = 0; p < w * h; p++) {
    if (seen[p]) continue
    const x = p % w
    const edge = (x > 0 && seen[p - 1]) || (x < w - 1 && seen[p + 1]) || seen[p - w] || seen[p + w]
    if (edge && data[p * 4] > 200 && data[p * 4 + 1] > 200 && data[p * 4 + 2] > 200) data[p * 4 + 3] = 90
  }
  return sharp(data, { raw: info }).png().toBuffer()
}

// Headline, one line of detail and the button: the same block, in the same place, on every banner
const copy = (x, [l1, l2], detail, button) => `
    ${text(x, 330, 164, '#fff', l1)}
    ${text(x, 505, 164, '#fff', l2)}
    ${text(x + 4, 615, 76, BRAND_200, detail)}
    ${pill(x, 665, button)}`

// 1. Newest phones and tablet, prices straight from the product data
async function newArrivals() {
  const picks = ['samsung-galaxy-tab-s12-wifi-12gb-512gb', 'oppo-a7-pro-5g-6gb-256gb', 'samsung-galaxy-a27-5g-8-256gb']
  const items = await Promise.all(picks.map(product))
  const cheapest = Math.min(...items.map((p) => p.price).filter(Boolean))
  const from = `Mulai Rp${cheapest.toLocaleString('id-ID')}`
  // A flat lighter-navy disc behind a grouped shot: the tablet at the back, a phone either side
  const body =
    `<circle cx="1900" cy="470" r="390" fill="${NAVY_700}"/>` +
    copy(150, ['HP terbaru', 'sudah tiba'], from, 'Lihat sekarang')
  const [tablet, left, right] = await Promise.all(
    items.map(async (p, i) => cutout(await original(p.image.src), i ? 600 : 720)),
  )
  return {
    name: 'produk-terbaru',
    href: '/katalog',
    alt: `HP terbaru sudah tiba: ${items.map((p) => p.name).join(', ')}. ${from}.`,
    image: await sharp(svg(body, NAVY_800))
      .composite([
        { input: tablet, left: 1540, top: 40 },
        { input: left, left: 1290, top: 250 },
        { input: right, left: 1930, top: 250 },
      ])
      .toBuffer(),
  }
}

// 2. Instalments: the store's own payment partners, together on one white panel
async function instalments() {
  const partners = site.payments.filter((p) => p.img).slice(0, 8)
  const body = copy(150, ['Cicilan', 'mudah'], `${partners.length} partner resmi`, 'Lihat caranya')
  const pw = 1180
  const ph = 480
  const px = W - 150 - pw
  const py = Math.round((H - ph) / 2)
  const cw = pw / 4
  const ch = ph / 2
  const logos = await Promise.all(
    partners.map(async (p, i) => {
      const logo = await sharp(path.join(ROOT, 'public', p.img.src))
        .resize(Math.round(cw * 0.8), Math.round(ch * 0.56), { fit: 'contain', background: '#0000' })
        .toBuffer()
      const m = await sharp(logo).metadata()
      return {
        input: logo,
        left: Math.round(px + (i % 4) * cw + (cw - m.width) / 2),
        top: Math.round(py + Math.floor(i / 4) * ch + (ch - m.height) / 2),
      }
    }),
  )
  const panel = `<rect x="${px}" y="${py}" width="${pw}" height="${ph}" rx="40" fill="#fff"/>`
  return {
    name: 'cicilan',
    href: '/marketplace',
    alt: `Cicilan mudah lewat ${partners.length} partner resmi: ${partners.map((p) => p.name).join(', ')}.`,
    image: await sharp(svg(panel + body, NAVY_800))
      .composite(logos)
      .toBuffer(),
  }
}

// 3. Branches: the store photo, branch count, founding year and Google rating
async function branches() {
  const split = 1180
  // Trimmed a few pixels on the right: the source photo has a light seam along that edge
  const photo = await sharp(path.join(ROOT, 'public', site.about.image.src))
    .resize(split + 16, H, { fit: 'cover' })
    .extract({ left: 0, top: 0, width: split, height: H })
    .toBuffer()
  const x = split + 140
  const rating = `${site.rating.score.toLocaleString('id-ID')} · ${site.rating.count.toLocaleString('id-ID')} ulasan Google`
  const star = (cx, cy, r) => {
    const pts = Array.from({ length: 10 }, (_, i) => {
      const a = (Math.PI / 5) * i - Math.PI / 2
      const rr = i % 2 ? r * 0.45 : r
      return `${(cx + rr * Math.cos(a)).toFixed(1)},${(cy + rr * Math.sin(a)).toFixed(1)}`
    }).join(' ')
    return `<polygon points="${pts}" fill="#fbbf24"/>`
  }
  const body = `
    ${text(x, 330, 164, '#fff', `${site.branchCount} cabang`)}
    ${text(x, 505, 164, '#fff', `sejak ${site.since}`)}
    ${star(x + 34, 590, 36)}
    ${text(x + 92, 615, 76, BRAND_200, rating)}
    ${pill(x, 665, 'Cari cabang')}`
  return {
    name: 'cabang',
    href: '/daftar-toko-cabang',
    alt: `${site.branchCount} cabang Complete Selular sejak ${site.since}, rating ${rating}.`,
    image: await sharp(svg(body, NAVY_800))
      .composite([{ input: photo, left: 0, top: 0 }])
      .toBuffer(),
  }
}

await fs.mkdir(OUT, { recursive: true })
const banners = []
for (const make of [newArrivals, instalments, branches]) {
  const b = await make()
  const entry = { name: b.name, href: b.href, alt: b.alt }
  for (const w of WIDTHS) {
    const file = `house-${b.name}-${w}.webp`
    await sharp(b.image).resize(w).webp({ quality: 82 }).toFile(path.join(OUT, file))
    entry[w] = { src: `/img/banners/${file}`, w, h: Math.round((w * H) / W) }
  }
  banners.push(entry)
  console.log(`✓ ${b.name}`)
}
await fs.writeFile(path.join(ROOT, 'src', 'data', 'banners.json'), JSON.stringify(banners, null, 2) + '\n')
console.log(`${banners.length} banners → src/data/banners.json`)

// Cut-out photos for the home shortcuts: one per product kind (the category row) and one phone per
// top brand (the brand tiles), each the newest listing with a sharp photo
const listings = JSON.parse(await fs.readFile(path.join(ROOT, 'public', 'data', 'products.json'), 'utf8'))
const all = (listings.items ?? listings).filter((p) => p.image?.w >= 400 && !p.image.lowRes)
const newest = (list) => [...list].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))[0]

async function writeCutout(p, dir, name, size) {
  await fs.mkdir(path.join(ROOT, 'public', 'img', dir), { recursive: true })
  await sharp(await cutout(await original(p.image.src), size))
    .trim({ threshold: 1 })
    .resize(size, size, { fit: 'contain', background: '#0000' })
    .webp({ quality: 85, alphaQuality: 90 })
    .toFile(path.join(ROOT, 'public', 'img', dir, `${name}.webp`))
  return { src: `/img/${dir}/${name}.webp`, w: size, h: size }
}

const { brands } = JSON.parse(await fs.readFile(path.join(ROOT, 'src', 'data', 'brands.json'), 'utf8'))
const tiles = []
for (const b of [...brands].sort((a, c) => c.total - a.total)) {
  const p = newest(all.filter((x) => x.brand === b.slug && productKind(x.name) === 'phone'))
  if (p) tiles.push({ slug: b.slug, name: b.name, img: await writeCutout(p, 'brand-tiles', b.slug, 320) })
  if (tiles.length === 4) break
}
await fs.writeFile(path.join(ROOT, 'src', 'data', 'brand-tiles.json'), JSON.stringify(tiles, null, 2) + '\n')

// The kind shortcuts sit right above the tiles, so they skip the tiles' brands: the "HP" photo
// should not be the same phone as the OPPO tile next to it
const tileBrands = new Set(tiles.map((t) => t.slug))
const kinds = []
for (const k of KINDS) {
  const ofKind = all.filter((x) => productKind(x.name) === k.id)
  const p = newest(ofKind.filter((x) => !tileBrands.has(x.brand))) ?? newest(ofKind)
  if (p) kinds.push({ id: k.id, label: k.label, img: await writeCutout(p, 'kinds', k.id, 200) })
}
await fs.writeFile(path.join(ROOT, 'src', 'data', 'kinds.json'), JSON.stringify(kinds, null, 2) + '\n')
console.log(`${kinds.length} kind shortcuts, ${tiles.length} brand tiles`)
