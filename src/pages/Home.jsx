import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import site from '../data/site.json'
import houseBanners from '../data/banners.json'
import kindShortcuts from '../data/kinds.json'
import brandTiles from '../data/brand-tiles.json'
import { brands } from '../data/brands.json'
import { useModels, usePosts } from '../lib/data'
import { formatDate, PRICE_RANGES, productKind, readableTitle } from '../lib/format'
import { absoluteUrl, DEFAULT_DESCRIPTION, SITE_URL } from '../lib/seo'
import { waLink } from '../lib/wa'
import ProductCard, { CardSkeleton, RAIL_SIZES } from '../components/ProductCard'
import Rail, { RailSkeleton } from '../components/Rail'
import SectionHeader from '../components/SectionHeader'
import ErrorState from '../components/ErrorState'
import Img from '../components/Img'
import Seo from '../components/Seo'

// Sections only pad their top, so the gap between any two of them is the same.
// Every section is a white band; the 8px canvas gap between bands does the separating.
const SECTION = 'band mt-2 py-4 sm:py-6'
const ratingScore = site.rating.score.toLocaleString('id-ID')
const ratingCount = site.rating.count.toLocaleString('id-ID')

const jsonLd = [
  {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': `${SITE_URL}/#organization`,
    name: site.name,
    url: `${SITE_URL}/`,
    // site.logo is white-on-transparent (invisible on Google's white UI); the app icon is on brand blue
    logo: absoluteUrl('/img/site/icon-512.png'),
    description: DEFAULT_DESCRIPTION,
    foundingDate: String(site.since),
    sameAs: site.socials.map((s) => s.url),
    contactPoint: {
      '@type': 'ContactPoint',
      telephone: `+${site.whatsapp}`,
      contactType: 'customer service',
      areaServed: 'ID',
      availableLanguage: 'id',
    },
  },
  {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: site.name,
    url: `${SITE_URL}/`,
    inLanguage: 'id-ID',
    publisher: { '@id': `${SITE_URL}/#organization` },
    potentialAction: {
      '@type': 'SearchAction',
      target: `${SITE_URL}/katalog?q={search_term_string}`,
      'query-input': 'required name=search_term_string',
    },
  },
]

// Keeps the order of `list` but lets price-less ("Hubungi kami") models take at most one slot in
// three, so every screenful of cards still shows prices.
function preferPriced(list, size) {
  const rank = new Map(list.map((m, i) => [m, i]))
  const priced = list.filter((m) => m.minPrice)
  const unpriced = list.filter((m) => !m.minPrice)
  const out = []
  let unpricedCount = 0
  while (out.length < size && (priced.length || unpriced.length)) {
    const allowed = unpricedCount < Math.ceil((out.length + 1) / 3)
    const takeUnpriced = !priced.length || (allowed && unpriced.length && rank.get(unpriced[0]) < rank.get(priced[0]))
    if (takeUnpriced) unpricedCount++
    out.push(takeUnpriced ? unpriced.shift() : priced.shift())
  }
  return out
}

const DEVICES = new Set(['phone', 'tablet'])
const newestFirst = (a, b) => (b.date ?? '').localeCompare(a.date ?? '')

// Newest models, handsets and tablets first: a new case or watch is not what "Produk Terbaru"
// promises, so accessories only fill in when there are not enough phones.
function pickLatest(models, size = 12) {
  const byDate = [...models].sort(newestFirst)
  const isDevice = (m) => DEVICES.has(productKind(m.name))
  return preferPriced([...byDate.filter(isDevice), ...byDate.filter((m) => !isDevice(m))], size)
}

// The admin's picks are variant slugs (often several capacities of one phone): one card per model.
// Picks already shown in "Produk Terbaru" (`shown`) only fill in when there are not enough others.
function pickFeatured(modelOf, redirectOf, size, shown) {
  const seen = new Set()
  const list = []
  for (const slug of site.featured) {
    const m = modelOf(slug) ?? modelOf(redirectOf(slug))
    if (m && !seen.has(m.key)) {
      seen.add(m.key)
      list.push(m)
    }
  }
  const fresh = list.filter((m) => !shown.has(m.key))
  return preferPriced(fresh.length >= size ? fresh : [...fresh, ...list.filter((m) => shown.has(m.key))], size)
}

const FEATURED_COUNT = 12

// The retry button unmounts together with the error message. Park focus on the section heading
// first so keyboard and screen-reader users are not dropped back to the top of the page.
function useRetryFocus(retry) {
  const ref = useRef(null)
  const onRetry = () => {
    const heading = ref.current?.querySelector('h2')
    if (heading) {
      heading.tabIndex = -1
      heading.focus({ preventScroll: true })
    }
    retry()
  }
  return [ref, onRetry]
}

export default function Home() {
  const { data: models, error, retry, modelOf, redirectOf } = useModels()
  const [latestRef, retryLatest] = useRetryFocus(retry)
  const latest = useMemo(() => (models ? pickLatest(models) : []), [models])
  // modelOf/redirectOf are new functions every render but only change meaning with the models
  const featured = useMemo(
    () => (models ? pickFeatured(modelOf, redirectOf, FEATURED_COUNT, new Set(latest.map((m) => m.key))) : []),
    [models, latest],
  )

  // Most visits continue to a product page, so fetch its code while the browser is idle.
  useEffect(() => {
    const warm = () => import('./ProductDetail')
    if (!window.requestIdleCallback) {
      const timer = setTimeout(warm, 3000)
      return () => clearTimeout(timer)
    }
    const handle = requestIdleCallback(warm, { timeout: 5000 })
    return () => cancelIdleCallback(handle)
  }, [])

  return (
    <>
      <Seo jsonLd={jsonLd} />
      <h1 className="sr-only">Complete Selular — toko HP, tablet &amp; aksesoris resmi</h1>
      {/* Section order follows Eraspace's home: banners, brand tiles, a recommendation shelf on a
          coloured band, the store's promises, posters, then shelves */}
      <Hero />
      <BrandTiles />

      {!error && (!models || featured.length > 0) && (
        <section className="bg-brand-100 mt-2 py-4 sm:py-6">
          <div className="container-page">
            <SectionHeader title="Khusus Buatmu" to="/katalog" tone="button" />
            {models ? (
              <Rail>
                {[
                  <ShelfPoster key="poster" />,
                  ...featured.map((m) => <ProductCard key={m.key} p={m} showNewBadge={false} sizes={RAIL_SIZES} />),
                ]}
              </Rail>
            ) : (
              <RailSkeleton label="Memuat produk pilihan…">
                <CardSkeleton />
              </RailSkeleton>
            )}
          </div>
        </section>
      )}

      <Benefits />
      <PromoRail />

      <section ref={latestRef} className={`${SECTION} [&_h2:focus]:outline-none`}>
        <div className="container-page">
          <SectionHeader title="Produk Terbaru" to="/katalog" />
          {error && !models ? (
            <ErrorState onRetry={retryLatest} title="Gagal memuat produk" as="h3" />
          ) : models ? (
            <Rail>
              {latest.map((m) => (
                <ProductCard key={m.key} p={m} showNewBadge={false} sizes={RAIL_SIZES} />
              ))}
            </Rail>
          ) : (
            <RailSkeleton label="Memuat produk terbaru…">
              <CardSkeleton />
            </RailSkeleton>
          )}
        </div>
      </section>

      <BrandStrip />
      <HelpStrip models={models} />
      <PaymentStrip />
      <LatestArticles />
    </>
  )
}

// Every numeric key of a site.hero entry is one width of the same banner ({ src, w, h }).
function bannerImage(banner) {
  const files = Object.keys(banner ?? {})
    .filter((k) => /^\d+$/.test(k) && banner[k]?.src)
    .map((k) => banner[k])
    .sort((a, b) => a.w - b.w)
  if (!files.length) return null
  return { ...files[0], srcset: files.length > 1 ? files.map((f) => `${f.src} ${f.w}w`).join(', ') : undefined }
}

// The banner spans the page container: the viewport minus its side padding, at most 1152px.
// scripts/prerender.mjs preloads the same files and has to use this exact string.
const HERO_SIZES = '(min-width: 1200px) 1152px, (min-width: 640px) calc(100vw - 3rem), calc(100vw - 2rem)'

// Banner carousel: the store's own promo banner(s) from WordPress first, then the house banners
// made by scripts/banners.mjs (new arrivals, instalments, branches). Swipe or tap a dot to move; it
// also moves on by itself every 3 seconds, and the timer restarts after any touch, drag or dot tap
// so it never jumps under the user's finger.
const HERO_DELAY = 3000
const PROMO_ALT = 'OMG! Oktober makin gede promonya, diskon setiap harinya. Promo dan stok terbatas.'

function heroSlides() {
  const promo = site.hero.map((b, i) => ({ key: `promo-${i}`, b, href: '/promo', alt: b.alt || PROMO_ALT }))
  const house = houseBanners.map((b) => ({ key: b.name, b, href: b.href, alt: b.alt }))
  return [...promo, ...house].map((s) => ({ ...s, img: bannerImage(s.b) })).filter((s) => s.img)
}

function Hero() {
  const slides = useMemo(heroSlides, [])
  const track = useRef(null)
  const [index, setIndex] = useState(0)
  const [tick, setTick] = useState(0) // bumped by user input to restart the timer
  const held = useRef(false) // a finger or mouse button is down on the track

  // On phones the slides are narrower than the track and centred (both neighbours peek in), so
  // positions come from the slides' centres rather than the track width
  const centre = (el, child) => child.offsetLeft - el.offsetLeft + child.offsetWidth / 2 - el.clientWidth / 2
  const go = (i, smooth = true) => {
    const el = track.current
    if (!el?.children[i]) return
    el.scrollTo({ left: centre(el, el.children[i]), behavior: smooth ? 'smooth' : 'auto' })
    // Dots follow at once instead of waiting for the smooth scroll's scroll events
    setIndex(i)
  }

  useEffect(() => {
    if (slides.length < 2) return
    const t = setTimeout(() => (held.current ? setTick((n) => n + 1) : go((index + 1) % slides.length)), HERO_DELAY)
    return () => clearTimeout(t)
  }, [index, tick, slides.length])

  // A rotated phone or resized window changes the slide widths; put the current slide back in place
  useEffect(() => {
    const onResize = () => go(index, false)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [index])

  // The visible slide follows the scroll position, whether a swipe, a dot or the timer moved it
  const onScroll = () => {
    const el = track.current
    let i = 0
    for (let k = 1; k < el.children.length; k++) {
      if (Math.abs(centre(el, el.children[k]) - el.scrollLeft) < Math.abs(centre(el, el.children[i]) - el.scrollLeft))
        i = k
    }
    if (i !== index) setIndex(i)
  }
  const restart = () => setTick((t) => t + 1)
  const release = () => {
    held.current = false
    restart()
  }

  if (!slides.length) return null
  return (
    <section className="band" aria-roledescription="carousel" aria-label="Promo pilihan">
      <div className="container-page py-3 sm:py-5">
        <div className="group/hero relative">
          {/* Mouse users get arrows on hover, like the product rails; touch screens swipe */}
          {slides.length > 1 &&
            [-1, 1].map((dir) => (
              <button
                key={dir}
                type="button"
                onClick={() => {
                  go((index + dir + slides.length) % slides.length)
                  restart()
                }}
                aria-label={dir < 0 ? 'Slide sebelumnya' : 'Slide berikutnya'}
                className={`hover:text-brand-700 absolute top-1/2 z-10 hidden size-11 -translate-y-1/2 place-items-center rounded-full bg-white text-slate-700 opacity-0 shadow-lg ring-1 ring-slate-200 transition-opacity group-focus-within/hero:opacity-100 group-hover/hero:opacity-100 [@media(hover:hover)]:grid ${
                  dir < 0 ? 'left-2' : 'right-2'
                }`}
              >
                {dir < 0 ? <ChevronLeft className="size-5" /> : <ChevronRight className="size-5" />}
              </button>
            ))}
          <div
            ref={track}
            onScroll={onScroll}
            onPointerDown={() => (held.current = true)}
            onPointerUp={release}
            onPointerCancel={release}
            onTouchStart={() => (held.current = true)}
            onTouchEnd={release}
            onWheel={restart}
            // Phones: the banner sits centred with both neighbours peeking in, as on Eraspace; full width from sm
            className="-mx-4 flex snap-x snap-mandatory scrollbar-none gap-2 overflow-x-auto overscroll-x-contain px-[6%] sm:mx-0 sm:gap-0 sm:rounded-lg sm:px-0"
          >
            {slides.map((s, i) => (
              <div
                key={s.key}
                role="group"
                aria-roledescription="slide"
                aria-label={`${i + 1} dari ${slides.length}`}
                className="w-[88%] shrink-0 snap-center sm:w-full"
              >
                <Link
                  to={s.href}
                  tabIndex={i === index ? undefined : -1}
                  className="focus-ring-inset block overflow-hidden rounded-lg"
                >
                  <Img
                    img={s.img}
                    sizes={HERO_SIZES}
                    priority={i === 0}
                    alt={s.alt}
                    className="aspect-[2560/871] w-full object-cover"
                  />
                </Link>
              </div>
            ))}
          </div>
        </div>
        {slides.length > 1 && (
          <div className="-mb-1 flex justify-center">
            {slides.map((s, i) => (
              <button
                key={s.key}
                type="button"
                onClick={() => {
                  go(i)
                  restart()
                }}
                aria-label={`Slide ${i + 1}`}
                aria-current={i === index ? 'true' : undefined}
                // 6px dot inside a 24px hit area; the active one stretches into a bar
                className="group grid h-6 w-4 place-items-center"
              >
                <span
                  className={`block h-1.5 rounded-full transition-all duration-300 ${
                    i === index ? 'bg-brand-600 w-3.5' : 'w-1.5 bg-slate-300 group-hover:bg-slate-400'
                  }`}
                />
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

// Eraspace's 2×2 category tiles, here the four biggest brands: name top left, their newest phone
// cut out and cropped at the bottom right of a grey tile
function BrandTiles() {
  if (brandTiles.length < 4) return null
  return (
    <section className="band" aria-label="Brand favorit">
      <ul className="container-page grid grid-cols-2 gap-2 pb-4 sm:grid-cols-4 sm:pb-6 lg:gap-3">
        {brandTiles.map((b) => (
          <li key={b.slug}>
            <Link
              to={`/brand/${b.slug}`}
              className="group relative block aspect-[16/10] overflow-hidden rounded-xl bg-slate-100 transition-colors hover:bg-slate-200 sm:aspect-[5/3] lg:aspect-[2/1]"
            >
              <span className="text-ink absolute top-3 left-3 text-sm font-extrabold sm:top-4 sm:left-4 sm:text-base">
                {b.name}
              </span>
              <Img
                img={b.img}
                alt=""
                sizes="(min-width: 1024px) 150px, 30vw"
                className="absolute right-0 -bottom-[10%] h-[85%] w-[56%] object-contain object-bottom transition-transform duration-300 group-hover:-translate-y-1 lg:-bottom-[14%] lg:h-[100%] lg:w-[50%]"
              />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

// First card of the "Khusus Buatmu" shelf, the way Eraspace opens its recommendation shelf with
// an illustrated card: a navy card with the shelf's name over a phone cut-out
function ShelfPoster() {
  const phone = kindShortcuts.find((k) => k.id === 'phone')
  return (
    <Link
      to="/katalog"
      className="bg-navy-800 relative flex h-full min-h-56 flex-col overflow-hidden rounded-lg p-3 text-white sm:p-4"
    >
      <span className="text-brand-200 text-xs font-bold">Pilihan admin</span>
      <span className="mt-1 text-lg leading-tight font-extrabold sm:text-xl">Rekomendasi untukmu</span>
      {phone && (
        <Img img={phone.img} alt="" sizes="160px" className="absolute -right-4 -bottom-4 h-3/5 w-auto object-contain" />
      )}
    </Link>
  )
}

// The store's promises as four figures, the same plain number-over-caption style as the stats on
// Tentang Kami: no icons, thin rules between them
function Benefits() {
  const items = [
    ['Resmi', 'bergaransi'],
    [site.payments.length, 'partner cicilan'],
    [site.branchCount, `cabang sejak ${site.since}`],
    [`${ratingScore}/5`, `${ratingCount} ulasan Google`],
  ]
  return (
    <section className="band mt-2 py-4 sm:py-5" aria-label="Keuntungan belanja di Complete Selular">
      <dl className="container-page divide-line grid grid-cols-4 divide-x">
        {items.map(([value, label]) => (
          <div key={label} className="flex flex-col px-2 text-center first:pl-0 last:pr-0">
            <dt className="text-muted order-last mt-0.5 text-xs leading-snug sm:text-sm">{label}</dt>
            <dd className="text-ink text-base font-extrabold tabular-nums sm:text-xl">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

// Brand logos gliding past like a ticker. Moved with requestAnimationFrame + transform (not a CSS
// animation), so it stays smooth and keeps running on PCs with Windows animation effects turned
// off. The list is rendered twice; after one list's width the position wraps back invisibly.
// The logos are pictures only, not links (a moving target is hard to hover or tap), on a plain
// white band with no heading; the brand list is in the main menu and the footer.
const BRAND_SPEED = 35 // px per second

function BrandStrip() {
  const list = brands.filter((b) => site.brandLogos[b.slug]).sort((a, b) => b.total - a.total)
  const track = useRef(null)

  useEffect(() => {
    const el = track.current
    if (!el) return
    let pos = 0
    let last = performance.now()
    let frame
    const tick = (now) => {
      const dt = Math.min(now - last, 64) // a background tab must not jump on return
      last = now
      const loop = el.offsetWidth / 2
      if (loop > 0) {
        pos = (pos + (BRAND_SPEED * dt) / 1000) % loop
        el.style.transform = `translate3d(${-pos}px, 0, 0)`
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [])

  const tile = (b, copy) => (
    <li key={`${b.slug}-${copy}`} className="shrink-0 pr-2.5 sm:pr-4" aria-hidden={copy || undefined}>
      <div className="border-line flex h-14 w-28 items-center justify-center overflow-hidden rounded-xl border bg-white sm:h-16 sm:w-36">
        {/* The logo files carry wide margins; a slight zoom lets the marks fill the card */}
        <Img
          img={site.brandLogos[b.slug]}
          alt={copy ? '' : b.name}
          draggable={false}
          className="size-full scale-[1.2] object-contain select-none"
        />
      </div>
    </li>
  )

  return (
    <section className="band mt-2 py-4 sm:py-6" aria-label="Brand resmi">
      {/* Soft fade at both edges so logos glide in and out instead of being cut off */}
      <div className="overflow-hidden [mask-image:linear-gradient(to_right,transparent,#000_4%,#000_96%,transparent)]">
        <ul
          ref={track}
          aria-label="Brand resmi di Complete Selular"
          className="flex w-max pl-4 will-change-transform sm:pl-6"
        >
          {list.map((b) => tile(b, false))}
          {list.map((b) => tile(b, true))}
        </ul>
      </div>
    </section>
  )
}

// The store's promo posters (portrait) as a rail, like Eraspace's member-special cards
function PromoRail() {
  const items = site.promos?.items ?? []
  if (!items.length) return null
  return (
    <section className={SECTION}>
      <div className="container-page">
        <SectionHeader title="Promo Spesial" to="/promo" />
        <Rail itemClass="w-[38%] sm:w-[24%] lg:w-[16%]">
          {items.map((it, i) => (
            <Link
              key={it.thumb.src}
              to="/promo"
              className="border-line block overflow-hidden rounded-lg border bg-white"
              aria-label={`Lihat ${it.title ?? `promo ${i + 1}`}`}
            >
              <Img
                img={it.thumb}
                alt=""
                sizes="(min-width: 1024px) 180px, (min-width: 640px) 24vw, 38vw"
                className="aspect-[2/3] w-full object-cover"
              />
            </Link>
          ))}
        </Rail>
      </div>
    </section>
  )
}

// What the buyer wants to know first: you can pay in instalments, and with whom
function PaymentStrip() {
  return (
    <section className={SECTION}>
      <div className="container-page grid gap-5 lg:grid-cols-[minmax(0,20rem)_1fr] lg:items-center lg:gap-12">
        <div>
          <h2 className="text-ink text-base font-extrabold sm:text-xl">Cicilan &amp; pembayaran</h2>
          <p className="text-muted mt-1.5 text-sm leading-relaxed">
            Tunai, transfer, atau cicilan lewat {site.payments.length} partner resmi.
          </p>
          <a
            href={waLink('Halo admin Complete Selular, saya mau tanya syarat dan simulasi cicilan.')}
            target="_blank"
            rel="noopener"
            className="text-brand-600 hover:text-brand-700 mt-3 inline-flex items-center text-sm font-bold hover:underline pointer-coarse:min-h-11"
          >
            Tanya syarat cicilan
            <span className="sr-only"> lewat WhatsApp (buka di tab baru)</span>
          </a>
        </div>
        <ul className="grid grid-cols-4 gap-2 sm:gap-3">
          {site.payments.map((p) => (
            <li
              key={p.name}
              className="border-line flex aspect-[5/2] items-center justify-center overflow-hidden rounded-lg border bg-white p-1.5 sm:p-3"
            >
              {/* Fixed box + object-contain: every partner logo gets the same visual weight. The files
                  carry wide margins, so they are scaled up into the box's padding */}
              <Img img={p.img} alt={p.name} className="size-full scale-125 object-contain" />
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

function LatestArticles() {
  const { data, error, retry } = usePosts()
  const [ref, onRetry] = useRetryFocus(retry)
  if (data && !data.length) return null
  // Phones: a compact list (small cover beside the title) instead of three screen-tall cards.
  // From sm: cards; the fourth fills the 2×2 grid on tablets and is dropped again in the 3-column row.
  const slot = (i) => (i === 3 ? 'hidden sm:block lg:hidden' : undefined)
  return (
    <section ref={ref} className={`${SECTION} [&_h2:focus]:outline-none`}>
      <div className="container-page">
        <SectionHeader title="Artikel & Review" to="/artikel-review" />
        {error ? (
          <ErrorState onRetry={onRetry} title="Gagal memuat artikel" as="h3" />
        ) : data ? (
          <ul className="divide-line -my-3 divide-y sm:my-0 sm:grid sm:grid-cols-2 sm:gap-3 sm:divide-y-0 lg:grid-cols-3">
            {data.slice(0, 4).map((a, i) => (
              <li key={a.slug} className={slot(i)}>
                <Link
                  to={`/artikel/${a.slug}`}
                  className="group sm:card flex h-full gap-3 py-3 sm:block sm:overflow-hidden sm:py-0"
                >
                  <Img
                    img={a.cover}
                    alt=""
                    sizes="(min-width: 1024px) 370px, (min-width: 640px) 50vw, 96px"
                    // Covers are mostly posters with text: shown whole on the cards (sm+); the small phone thumbnail
                    // fills its square instead, since a letterboxed 96px poster reads as an empty grey box
                    className="size-24 shrink-0 rounded-lg bg-slate-100 object-cover sm:aspect-[4/3] sm:size-auto sm:w-full sm:rounded-none sm:object-contain"
                  />
                  <div className="min-w-0 sm:p-3">
                    <p className="text-muted text-xs">
                      <time dateTime={a.date}>{formatDate(a.date)}</time>
                    </p>
                    <h3 className="group-hover:text-brand-700 text-ink mt-1 line-clamp-3 text-sm font-bold">
                      {readableTitle(a.title)}
                    </h3>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <div role="status" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <span className="sr-only">Memuat artikel…</span>
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} aria-hidden className={`sm:card flex gap-3 sm:block sm:overflow-hidden ${slot(i) ?? ''}`}>
                <div className="skeleton size-24 shrink-0 rounded-lg sm:aspect-[4/3] sm:size-auto sm:rounded-none" />
                {/* Same line boxes as the real card: 16px date, then 24px title lines */}
                <div className="min-w-0 flex-1 sm:p-3">
                  <div className="skeleton my-0.5 h-3 w-24 rounded" />
                  <div className="skeleton mt-2 h-4 w-full rounded" />
                  <div className="skeleton mt-2 mb-1 h-4 w-full rounded sm:mb-0 xl:mb-1" />
                  <div className="skeleton mt-2 mb-1 hidden h-4 w-1/2 rounded sm:block xl:hidden" />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

// "Bingung pilih HP?" answered like a marketplace shelf: pick a budget tab, the phones in that
// range appear right below (handsets first, newest first), with a link to the filtered catalogue.
const DEFAULT_BUDGET = '2-5'

function budgetShelf(models, range) {
  const isDevice = (m) => DEVICES.has(productKind(m.name))
  const inRange = (models ?? []).filter((m) => m.minPrice && m.minPrice >= range.min && m.minPrice < range.max)
  const byDate = [...inRange].sort(newestFirst)
  return [...byDate.filter(isDevice), ...byDate.filter((m) => !isDevice(m))].slice(0, 12)
}

function HelpStrip({ models }) {
  const [active, setActive] = useState(DEFAULT_BUDGET)
  const range = PRICE_RANGES.find((r) => r.id === active)
  const shelf = useMemo(() => budgetShelf(models, range), [models, range])
  return (
    <section className={`${SECTION} mb-2`}>
      <div className="container-page">
        <SectionHeader title="Cari HP sesuai budget" />
        <div
          role="group"
          aria-label="Pilih budget"
          className="-mx-4 mb-4 flex scrollbar-none gap-2 overflow-x-auto px-4 sm:mx-0 sm:px-0"
        >
          {PRICE_RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              aria-pressed={r.id === active}
              onClick={() => setActive(r.id)}
              className={`chip shrink-0 ${
                r.id === active
                  ? 'border-brand-600 bg-brand-600 text-white'
                  : 'border-line text-ink hover:border-brand-300 bg-white'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
        {!models ? (
          <RailSkeleton label="Memuat produk…">
            <CardSkeleton />
          </RailSkeleton>
        ) : (
          <Rail key={active}>
            {shelf.map((m) => (
              <ProductCard key={m.key} p={m} showNewBadge={false} sizes={RAIL_SIZES} />
            ))}
          </Rail>
        )}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm">
          <Link
            to={`/katalog?harga=${range.id}`}
            className="text-brand-600 hover:text-brand-700 font-bold hover:underline pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
          >
            Lihat semua {range.label.toLowerCase()}
          </Link>
        </div>
      </div>
    </section>
  )
}
