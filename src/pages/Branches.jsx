import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ExternalLink, LocateFixed, Search, X } from 'lucide-react'
import branches from '../data/branches.json'
import { waLink } from '../lib/wa'
import { distanceKm, formatDistance, useMyLocation } from '../lib/location'
import { WhatsAppIcon } from '../components/icons'
import PageHeader from '../components/PageHeader'
import EmptyState from '../components/EmptyState'
import Seo from '../components/Seo'

// Lowercase letters and digits only, so "hp mart", "HPMART" and "Hp-Mart" all find each other
const compact = (s) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '')

// Most addresses leave the province out, so "jawa barat" would otherwise miss most West Java stores
const JABAR = ['Jawa Barat', 'Jabar']
const JATENG = ['Jawa Tengah', 'Jateng']
const PROVINCE = {
  Cirebon: JABAR,
  Indramayu: JABAR,
  Majalengka: JABAR,
  Cilacap: JATENG,
  Pemalang: JATENG,
  Tegal: JATENG,
}

// The street and district only: RT/RW, the city, regency, province and postcode repeat the city heading
const DROP_PART = /^(rt|rw)\b|^(kab(upaten)?\.?|kota)\s|^jawa (barat|tengah)\b|^\d{5}$/i
const shortAddress = ({ address, city }) =>
  address
    .split(/,\s*/)
    .filter((part) => part.trim() !== city && !DROP_PART.test(part.trim()))
    .join(', ')

// Each address part (between commas) is compacted on its own and kept apart, so a phrase never
// matches across parts: "cirebon ciledug" must not treat "…, Cirebon, Ciledug, …" as a phrase hit
const indexed = branches.map((b) => ({
  ...b,
  short: shortAddress(b),
  // ?cabang= value: "Complete Selular Jatiwangi 2" -> "complete-selular-jatiwangi-2"
  slug: b.name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, ''),
  hay: [b.name, b.city, ...b.address.split(/[,()]/), ...(PROVINCE[b.city] ?? [])]
    .map(compact)
    .filter(Boolean)
    .join(' '),
}))

// Chip order is fixed (most branches first) so chips don't jump around while searching
const CITIES = (() => {
  const counts = {}
  for (const b of branches) counts[b.city] = (counts[b.city] ?? 0) + 1
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b))
})()

function search(q) {
  const words = q.split(/\s+/).map(compact).filter(Boolean)
  if (!words.length) return indexed
  const phrase = indexed.filter((b) => b.hay.includes(words.join('')))
  // When the whole phrase exists somewhere ("jawa barat"), stores that only have the words in
  // separate places ("Kec. Tegal Barat, … Jawa Tengah") are noise, not results
  if (phrase.length || words.length === 1) return phrase
  return indexed.filter((b) => words.every((w) => b.hay.includes(w)))
}

function withParams(params, changes) {
  const next = new URLSearchParams(params)
  for (const [key, value] of Object.entries(changes)) {
    if (value) next.set(key, value)
    else next.delete(key)
  }
  return next
}

const WA_GENERAL =
  'Halo admin Complete Selular, saya mau tanya alamat cabang Complete Selular terdekat dari lokasi saya.'

const waStock = (b) => waLink(`Halo admin Complete Selular, saya mau tanya stok di cabang ${b.name}.`)
const mapSrc = (b) => `https://www.google.com/maps?q=${encodeURIComponent(`${b.name}, ${b.address}`)}&output=embed`

// lg and up: list + sticky map side by side. Below that each row opens its own map inline.
const DESKTOP = '(min-width: 64rem)'
function useMediaQuery(query) {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(query)
      m.addEventListener('change', cb)
      return () => m.removeEventListener('change', cb)
    },
    () => window.matchMedia(query).matches,
    () => false,
  )
}

export default function Branches() {
  const [params, setParams] = useSearchParams()
  const urlQ = params.get('q') ?? ''
  const kota = (params.get('kota') ?? '').toLowerCase()
  const city = CITIES.find((c) => c.toLowerCase() === kota) ?? ''

  // The field keeps its own state so typing stays instant; the URL catches up after a pause.
  // `written` is the last q we put in the URL ourselves, so only Back/Forward or an edited
  // link overwrite what the user is typing.
  const [q, setQ] = useState(urlQ)
  const written = useRef(urlQ)
  useEffect(() => {
    if (urlQ === written.current) return
    written.current = urlQ
    setQ(urlQ)
  }, [urlQ])

  // Typing replaces the history entry; picking a city pushes one, so Back steps through cities
  const update = (changes, { push = false } = {}) => {
    const next = withParams(params, changes)
    if ('q' in changes) written.current = changes.q
    if (next.toString() !== params.toString()) setParams(next, { replace: !push })
  }

  const needle = q.trim()
  useEffect(() => {
    if (needle === urlQ) return
    const t = setTimeout(() => update({ q: needle }), 400)
    return () => clearTimeout(t)
  }, [needle, urlQ, params])

  const found = useMemo(() => search(needle), [needle])
  const location = useMyLocation()
  const here = location.position
  const list = useMemo(() => {
    const inCity = city ? found.filter((b) => b.city === city) : found
    return here ? inCity.map((b) => ({ ...b, km: b.lat != null ? distanceKm(here, b) : null })) : inCity
  }, [found, city, here])
  // Grouped by city in chip order, or one list nearest first once the location is on.
  // `ordered` is the list exactly as it appears on screen.
  const groups = here
    ? [
        {
          id: 'terdekat',
          title: 'Terdekat dari lokasimu',
          items: [...list].sort((a, b) => (a.km ?? Infinity) - (b.km ?? Infinity)),
        },
      ]
    : CITIES.map((c) => ({ id: c, title: c, items: list.filter((b) => b.city === c) })).filter((g) => g.items.length)
  const ordered = groups.flatMap((g) => g.items)

  // ?cabang= holds the chosen branch. On desktop the map always shows one, so the first result
  // stands in when nothing (or a branch the filters now hide) is chosen; on smaller screens it is
  // the one opened row, and no row is open by default.
  const desktop = useMediaQuery(DESKTOP)
  const cabang = params.get('cabang') ?? ''
  const picked = ordered.find((b) => b.slug === cabang)
  const selected = desktop ? (picked ?? ordered[0]) : picked

  // A shared ?cabang= link scrolls its row into view; so does a row opened on a phone, whose map
  // would otherwise unfold below the fold
  const reveal = useRef(cabang)
  useEffect(() => {
    if (!reveal.current || !picked || reveal.current !== picked.slug) return
    reveal.current = ''
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    document.getElementById(`cabang-${picked.slug}`)?.scrollIntoView({
      block: 'nearest',
      behavior: smooth ? 'smooth' : 'auto',
    })
  }, [picked])

  const choose = (b) => update({ cabang: b.slug })
  const toggle = (b) => {
    const open = picked?.slug !== b.slug
    reveal.current = open ? b.slug : ''
    update({ cabang: open ? b.slug : '' })
  }

  const inputRef = useRef(null)
  const allChipRef = useRef(null)
  const barRef = useRef(null)
  const resultsRef = useRef(null)

  // The sticky search band changes height with the breakpoint and chip wrapping; the map panel and
  // the rows' scroll margins sit below it through --band (86px, its one-row desktop height, until measured)
  const [band, setBand] = useState(0)
  useLayoutEffect(() => {
    const el = barRef.current
    const measure = () => setBand(el.offsetHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // When the list changes while the user is scrolled deep into it, bring the result count
  // back up under the sticky bar instead of leaving them in the footer of a shorter list
  const shown = useRef({ city, needle })
  useLayoutEffect(() => {
    if (shown.current.city === city && shown.current.needle === needle) return
    shown.current = { city, needle }
    const bar = barRef.current?.getBoundingClientRect()
    const top = resultsRef.current?.getBoundingClientRect().top
    if (bar && top != null && top < bar.bottom) window.scrollBy(0, top - bar.bottom - 12)
  }, [city, needle])

  // A chosen branch outside the new city is dropped, so the URL never names a branch the map isn't showing
  const selectCity = (c) =>
    update({ kota: c, q: needle, ...(c && picked && picked.city !== c ? { cabang: '' } : {}) }, { push: true })
  const showAllCities = () => {
    selectCity('')
    allChipRef.current?.focus()
  }
  const reset = () => {
    setQ('')
    update({ kota: '', q: '' }, { push: true })
    allChipRef.current?.focus()
  }
  const clearQuery = () => {
    setQ('')
    update({ q: '' })
    inputRef.current?.focus()
  }

  const hiddenByCity = city && !list.length && found.length > 0
  const status = !city && !needle ? `Semua ${list.length} cabang` : describe(list.length, city, needle)

  return (
    <>
      <Seo
        title="Toko Cabang"
        description={`Daftar ${branches.length} toko cabang Complete Selular beserta alamat dan petunjuk arah lewat Google Maps.`}
      />
      <PageHeader title="Toko Cabang" subtitle={`${branches.length} cabang di Jawa Barat & Jawa Tengah`} />

      {/* Phones: scrolls with the page so only the site header stays pinned. From sm it sits right under the
          sticky header (64px, 108px with the nav row from lg). */}
      <div
        ref={barRef}
        className="border-line z-20 mt-2 border-y bg-white sm:sticky sm:top-16 lg:top-[108px] [@media(max-height:30rem)]:static"
      >
        <form
          role="search"
          className="container-page py-2"
          onSubmit={(e) => {
            e.preventDefault()
            update({ q: needle })
            // Closes the on-screen keyboard so the results are visible; with a real keyboard
            // focus stays put so keyboard and screen-reader users keep their place
            if (window.matchMedia?.('(pointer: coarse)').matches) inputRef.current?.blur()
          }}
        >
          {/* Hidden on phones to keep the sticky band short; the icon and placeholder carry it there */}
          <label htmlFor="cari-cabang" className="text-ink sr-only text-[13px] font-bold sm:not-sr-only">
            Cari cabang
          </label>
          <div className="flex flex-col gap-2 sm:mt-1 sm:flex-row sm:items-center sm:gap-3">
            <div className="relative sm:w-72 sm:shrink-0 lg:w-80">
              <Search
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-500"
                aria-hidden
              />
              <input
                ref={inputRef}
                id="cari-cabang"
                type="search"
                enterKeyHint="search"
                autoComplete="off"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Nama toko, jalan, atau kota…"
                className={`ring-brand-300 text-ink focus:border-brand-500 h-10 w-full rounded-lg border border-slate-300 bg-white pl-9 text-sm transition outline-none hover:border-slate-400 focus:ring-2 pointer-coarse:h-11 [&::-webkit-search-cancel-button]:appearance-none ${q ? 'pr-10' : 'pr-3'}`}
              />
              {q && (
                <button
                  type="button"
                  onClick={clearQuery}
                  aria-label="Hapus kata kunci"
                  className="text-muted hover:text-ink absolute top-1/2 right-0.5 grid size-9 -translate-y-1/2 place-items-center rounded-lg hover:bg-slate-100 pointer-coarse:right-0 pointer-coarse:size-11"
                >
                  <X className="size-4" aria-hidden />
                </button>
              )}
            </div>

            <ChipRow label="Filter kota" active={city}>
              {['', ...CITIES].map((c) => {
                const active = city === c
                return (
                  <button
                    key={c || 'all'}
                    ref={c ? undefined : allChipRef}
                    type="button"
                    onClick={() => selectCity(c)}
                    aria-pressed={active}
                    className={`chip shrink-0 scroll-mx-10 ${
                      active
                        ? 'border-brand-600 bg-brand-50 text-brand-700'
                        : 'border-line text-ink hover:border-brand-300 bg-white'
                    }`}
                  >
                    {c || 'Semua'}
                  </button>
                )
              })}
            </ChipRow>
          </div>
        </form>
      </div>

      <div
        ref={resultsRef}
        style={band ? { '--band': `${band}px` } : undefined}
        className="container-page py-3 sm:py-4"
      >
        <LocationBar location={location} />

        {/* Always announced; only shown while a filter or search narrows the list */}
        <p role="status" className={!city && !needle ? 'sr-only' : 'text-muted mb-2 text-[13px] sm:mb-3'}>
          {status}
        </p>

        {list.length ? (
          <>
            <div className="lg:grid lg:grid-cols-[minmax(0,400px)_minmax(0,1fr)] lg:items-start lg:gap-4">
              {/* Opted out of scroll anchoring: when a filter removes the anchored row Chrome jumps to the
                  top of the page, and the effect above already places the new results */}
              {/* Phones: one white band edge to edge, like the home sections; a rounded card from sm */}
              <div className="border-line sm:card -mx-4 border-y bg-white [overflow-anchor:none] sm:mx-0 sm:overflow-hidden sm:border-0">
                {groups.map((g, i) => (
                  <section key={g.id} aria-labelledby={`kota-${g.id}`} className={i ? 'border-line border-t' : ''}>
                    <h2 id={`kota-${g.id}`} className="text-ink px-4 pt-4 pb-1 text-sm font-extrabold">
                      {g.title}
                    </h2>
                    <ul className="divide-line divide-y">
                      {g.items.map((b) => (
                        <BranchRow
                          key={b.slug}
                          b={b}
                          desktop={desktop}
                          active={selected?.slug === b.slug}
                          onSelect={() => (desktop ? choose(b) : toggle(b))}
                        />
                      ))}
                    </ul>
                  </section>
                ))}
              </div>

              {desktop && selected && <MapPanel b={selected} />}
            </div>

            <p className="text-muted mt-3 px-1 text-sm sm:mt-4">
              Cabang terdekat belum ada?{' '}
              <a
                href={waLink(WA_GENERAL)}
                target="_blank"
                rel="noopener"
                className="text-brand-700 font-bold underline underline-offset-2"
              >
                Tanya admin
                <span className="sr-only"> lewat WhatsApp (buka di tab baru)</span>
              </a>
            </p>
          </>
        ) : (
          <EmptyState
            title="Cabang tidak ditemukan"
            actions={
              hiddenByCity ? (
                <>
                  <button type="button" onClick={showAllCities} className="btn-primary">
                    Cari di semua kota ({found.length})
                  </button>
                </>
              ) : (
                <>
                  <button type="button" onClick={reset} className="btn-ghost">
                    Reset pencarian
                  </button>
                  <a
                    href={waLink(
                      needle
                        ? `Halo admin Complete Selular, apakah ada cabang Complete Selular di daerah ${needle}?`
                        : WA_GENERAL,
                    )}
                    target="_blank"
                    rel="noopener"
                    className="btn-wa"
                  >
                    <WhatsAppIcon className="size-4" /> Tanya via WhatsApp
                  </a>
                </>
              )
            }
          >
            {hiddenByCity ? (
              <>
                Tidak ada cabang di {city} yang cocok dengan “{needle}”, tapi ada {found.length} cabang di kota lain.
              </>
            ) : (
              <>
                Belum ada cabang tercantum yang cocok dengan “{needle}”. Cabang di daerahmu mungkin belum masuk daftar
                ini, tanyakan saja lewat WhatsApp.
              </>
            )}
          </EmptyState>
        )}
      </div>
    </>
  )
}

// "Aktifkan lokasi" above the list, as a small card: what it does on the left, one button on the
// right. Once on, the list is one nearest-first list with distances; the position stays on this
// device (lib/location).
const LOCATION_TEXT = {
  idle: ['Cari toko terdekat', 'Aktifkan lokasi untuk mengurutkan cabang dari yang terdekat.', 'Aktifkan'],
  locating: ['Mencari lokasimu…', 'Izinkan akses lokasi bila browser memintanya.', 'Aktifkan'],
  on: ['Urut dari yang terdekat', 'Memakai lokasimu, hanya di perangkat ini.', 'Matikan'],
  denied: ['Izin lokasi ditolak', 'Izinkan lokasi untuk situs ini di pengaturan browser.', 'Coba lagi'],
  unavailable: ['Lokasi belum bisa didapat', 'Pastikan lokasi atau GPS perangkat menyala.', 'Coba lagi'],
}

function LocationBar({ location }) {
  const { status, enable, off } = location
  const [title, note, action] = LOCATION_TEXT[status]
  return (
    <div className="card mb-3 flex items-center gap-3 p-3 sm:p-4" aria-live="polite">
      <LocateFixed className="text-brand-600 size-5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-ink text-sm font-bold">{title}</p>
        <p className="text-muted mt-0.5 text-[13px] leading-snug">{note}</p>
      </div>
      <button
        type="button"
        onClick={status === 'on' ? off : enable}
        disabled={status === 'locating'}
        className={`${status === 'idle' || status === 'locating' ? 'btn-primary' : 'btn-ghost'} min-h-9 shrink-0 px-3.5 py-1.5 text-[13px]`}
      >
        {action}
      </button>
    </div>
  )
}

// Keeps keyboard focus clear of the sticky header (html scroll-padding) and the search band below it
const UNDER_BAND = 'scroll-mt-[var(--band,86px)] [@media(max-height:30rem)]:scroll-mt-0'

// One branch: name and a one-line address on a plain row; rows are split by hairlines.
//   Desktop: clicking the row picks which branch the map panel shows (aria-pressed); directions and
//   WhatsApp live once, in that panel.
//   Phones/tablets: an "Arah" text link on the right; tapping the row opens its map and actions in
//   place (aria-expanded), where the link gives way to the panel's own directions button. The iframe
//   only exists while the row is open.
function BranchRow({ b, desktop, active, onSelect }) {
  const panel = `peta-${b.slug}`
  const text = (
    <>
      <span className={`block text-[15px] leading-snug font-bold ${active ? 'text-brand-700' : 'text-ink'}`}>
        {b.name}
      </span>
      <span className="text-muted mt-0.5 block truncate text-[13px]">
        {b.km != null && <span className="text-brand-700 font-bold">{formatDistance(b.km)} · </span>}
        {b.short}
      </span>
    </>
  )

  if (desktop) {
    return (
      <li id={`cabang-${b.slug}`} className={`${UNDER_BAND} ${active ? 'bg-brand-50' : 'hover:bg-slate-50'}`}>
        <button
          type="button"
          onClick={onSelect}
          aria-pressed={active}
          aria-controls="peta-cabang"
          className={`focus-ring-inset block w-full px-4 py-3.5 text-left ${UNDER_BAND}`}
        >
          {text}
        </button>
      </li>
    )
  }

  return (
    <li id={`cabang-${b.slug}`} className={`${UNDER_BAND} ${active ? 'bg-brand-50' : ''}`}>
      <div className="flex items-center">
        <button
          type="button"
          onClick={onSelect}
          aria-expanded={active}
          aria-controls={panel}
          className={`focus-ring-inset min-w-0 flex-1 py-3.5 pr-2 pl-4 text-left ${UNDER_BAND}`}
        >
          {text}
        </button>
        {b.maps && !active && (
          <a
            href={b.maps}
            target="_blank"
            rel="noopener"
            className="focus-ring-inset text-brand-700 inline-flex min-h-11 shrink-0 items-center self-stretch px-4 text-[13px] font-bold hover:underline"
          >
            Arah
            <span className="sr-only"> ke {b.name} (buka di tab baru)</span>
          </a>
        )}
      </div>

      <div id={panel} hidden={!active}>
        {active && (
          <div className="px-4 pb-4">
            <div className="relative aspect-[16/10] overflow-hidden rounded-lg bg-slate-100">
              <MapFrame b={b} />
            </div>
            <p className="text-muted mt-3 text-[13px] leading-snug break-words">{b.address}</p>
            <BranchActions b={b} className="mt-3 grid grid-cols-2 gap-2" />
          </div>
        )}
      </div>
    </li>
  )
}

// Keyed by branch so a new branch mounts a fresh iframe: changing src on the same iframe would add
// an entry to the page's history and make Back step through old maps
function MapFrame({ b }) {
  return (
    <iframe
      key={b.slug}
      src={mapSrc(b)}
      loading="lazy"
      title={`Peta ${b.name}`}
      referrerPolicy="no-referrer-when-downgrade"
      className="absolute inset-0 size-full border-0"
    />
  )
}

function BranchActions({ b, className }) {
  return (
    <div className={className}>
      {b.maps && (
        <a href={b.maps} target="_blank" rel="noopener" className="btn-primary">
          Petunjuk arah
          <ExternalLink className="size-4" aria-hidden />
          <span className="sr-only"> (buka di tab baru)</span>
        </a>
      )}
      <a href={waStock(b)} target="_blank" rel="noopener" className="btn-wa">
        <WhatsAppIcon className="size-4" />
        <span>
          Tanya stok<span className="max-sm:sr-only"> di cabang ini</span>
        </span>
        <span className="sr-only"> (buka di tab baru)</span>
      </a>
    </div>
  )
}

// Desktop map: sticks below the header (108px at lg) and the search band, filling the rest of the
// viewport. On very short viewports the header and band scroll away, so it does too.
function MapPanel({ b }) {
  return (
    <aside
      id="peta-cabang"
      aria-label="Peta cabang terpilih"
      className="card sticky top-[calc(108px+var(--band,86px)+16px)] flex h-[calc(100dvh-108px-var(--band,86px)-32px)] min-h-[26rem] flex-col overflow-hidden [@media(max-height:30rem)]:static [@media(max-height:30rem)]:h-auto"
    >
      <div className="relative min-h-72 flex-1 bg-slate-100">
        <MapFrame b={b} />
      </div>
      <div className="border-line border-t p-4">
        <h2 className="text-ink text-base font-bold">{b.name}</h2>
        <p className="text-muted mt-1 text-[13px] leading-snug">{b.address}</p>
        <BranchActions b={b} className="mt-3 flex flex-wrap gap-2" />
      </div>
    </aside>
  )
}

function describe(n, city, needle) {
  const where = city ? ` di ${city}` : ''
  const what = needle ? ` yang cocok dengan “${needle}”` : ''
  return n ? `${n} cabang${where}${what}` : `Tidak ada cabang${where}${what}`
}

// Horizontally scrolling chip row. The edges fade out while there is more to scroll, so the
// row reads as scrollable even where the scrollbar is hidden (touch) or chips end on a gap.
function ChipRow({ label, active, children }) {
  const ref = useRef(null)
  const [edges, setEdges] = useState({ start: false, end: false })

  // Chrome only scrolls a fully hidden element into view on focus, so a chip half under an edge
  // fade would keep its focus ring hidden. Sets scrollLeft directly so the window never scrolls.
  const reveal = (chip, center = false) => {
    const row = ref.current
    if (!chip || chip.parentElement !== row || row.scrollWidth <= row.clientWidth) return
    const fade = 40
    const start = chip.offsetLeft
    const end = start + chip.offsetWidth
    if (center) row.scrollLeft = start - (row.clientWidth - chip.offsetWidth) / 2
    else if (start - fade < row.scrollLeft) row.scrollLeft = start - fade
    else if (end + fade > row.scrollLeft + row.clientWidth) row.scrollLeft = end + fade - row.clientWidth
  }

  // A city restored from the URL (shared link, reload, Back) may sit far off to the right;
  // centre it on first render, then just nudge it into view when the city changes
  const mounted = useRef(false)
  useLayoutEffect(() => {
    reveal(ref.current.querySelector('[aria-pressed="true"]'), !mounted.current)
    mounted.current = true
  }, [active])

  useLayoutEffect(() => {
    const el = ref.current
    const measure = () => {
      const start = el.scrollLeft > 1
      const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
      setEdges((e) => (e.start === start && e.end === end ? e : { start, end }))
    }
    measure()
    el.addEventListener('scroll', measure, { passive: true })
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    for (const child of el.children) ro.observe(child)
    return () => {
      el.removeEventListener('scroll', measure)
      ro.disconnect()
    }
  }, [])

  const mask = `linear-gradient(to right, ${edges.start ? 'transparent, #000 2.5rem' : '#000, #000'}, ${
    edges.end ? '#000 calc(100% - 2.5rem), transparent' : '#000'
  })`

  return (
    <div
      ref={ref}
      role="group"
      aria-label={label}
      onFocus={(e) => reveal(e.target)}
      style={{ maskImage: mask, WebkitMaskImage: mask }}
      // py-1 leaves room for the focus outline, which the scroll container would otherwise clip.
      // relative keeps the chips' sr-only text inside the scroller instead of widening the page.
      className="relative -mx-4 -my-1 flex min-w-0 [scrollbar-width:thin] gap-2 overflow-x-auto px-4 py-1 sm:mx-0 sm:flex-1 sm:px-1 lg:flex-wrap lg:overflow-visible pointer-coarse:scrollbar-none"
    >
      {children}
    </div>
  )
}
