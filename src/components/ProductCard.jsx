import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Check, GitCompareArrows } from 'lucide-react'
import { formatPrice } from '../lib/format'
import { prefetchProduct } from '../lib/data'
import { compare, useCompare } from '../lib/compare'
import { groupModels } from '../lib/variants'
import Img from './Img'

const NEW_DAYS = 14

// "sidebar" is for grids that share the row with a filter column (Catalog).
const COLUMNS = {
  default: 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5',
  sidebar: 'grid-cols-2 sm:grid-cols-3 xl:grid-cols-4',
}
// Rendered photo width (card minus its padding) for each layout, so srcset picks the right file.
const SIZES = {
  default: '(min-width: 1280px) 180px, (min-width: 1024px) 20vw, (min-width: 640px) 28vw, 40vw',
  sidebar: '(min-width: 1280px) 170px, (min-width: 1024px) 18vw, (min-width: 640px) 28vw, 40vw',
}
// Photo width inside a <Rail> item (w-[44%] sm:w-[30%] lg:w-[22%] xl:w-[18.5%] of the page container)
export const RAIL_SIZES = '(min-width: 1200px) 175px, (min-width: 1024px) 18vw, (min-width: 640px) 25vw, 36vw'

// A plain listing (no .variants) is shown as a one-variant model under its own full name.
const asModel = (p) => (p.variants ? p : { ...groupModels([p]).models[0], name: p.name })

// Everything the card shows, derived once per model
function cardInfo(m) {
  const { variants } = m
  const many = variants.length > 1
  const labels = variants.map((v) => v.variantLabel).filter(Boolean)
  const range = many && labels.length > 1 ? [labels[0], labels.at(-1)] : labels.slice(0, 1)
  // "Mulai" whenever one price does not speak for every variant (different or missing prices)
  const from = many && !!m.minPrice && variants.some((v) => v.price !== m.minPrice)
  const main = variants.find((v) => v.slug === m.slug) ?? variants[0]
  return {
    many,
    range,
    from,
    // Compare works per variant, so the toggle names the exact listing it adds
    compareName: many && main.variantLabel ? `${m.name} ${main.variantLabel}` : m.name,
    mainLabel: many ? main.variantLabel : null,
  }
}

export default function ProductCard({ p, priority, showNewBadge = true, sizes = SIZES.default }) {
  const m = useMemo(() => asModel(p), [p])
  const info = useMemo(() => cardInfo(m), [m])
  const selected = useCompare().includes(m.slug)
  const isNew = showNewBadge && Date.now() - new Date(m.date).getTime() < NEW_DAYS * 864e5
  const prefetch = () => prefetchProduct(m.slug)
  const name = m.name
  const { many, range, from } = info

  // One sentence for screen readers instead of every text node in the card read back to back:
  // "Tecno Pova 8 5G, 3 varian, 6/128GB sampai 8/256GB, mulai Rp4.299.000"
  const withBrand = m.brandName && !name.toLowerCase().includes(m.brandName.toLowerCase())
  const label = [
    withBrand ? `${m.brandName} ${name}` : name,
    isNew && 'produk baru',
    many && `${m.variants.length} varian`,
    range.join(' sampai '),
    m.minPrice ? `${from ? 'mulai ' : ''}${formatPrice(m.minPrice)}` : 'harga: hubungi kami',
  ]
    .filter(Boolean)
    .join(', ')

  return (
    // overflow-hidden would clip an outline on the link, so the focus ring lives on the card itself
    <article className="group card has-[a:focus-visible]:outline-brand-500 relative flex h-full flex-col overflow-hidden transition-shadow duration-200 hover:shadow-[var(--shadow-lift)] has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-2">
      <Link
        to={`/product/${m.slug}`}
        onMouseEnter={prefetch}
        onFocus={prefetch}
        onPointerDown={prefetch}
        aria-label={label}
        className="flex flex-1 flex-col after:absolute after:inset-0 focus-visible:outline-none"
      >
        <div className="relative flex aspect-square items-center justify-center bg-white p-3">
          <Img
            img={m.image}
            alt=""
            priority={priority}
            sizes={sizes}
            noUpscale={m.image?.lowRes}
            className="size-full object-contain"
          />
          {isNew && (
            <span className="bg-accent-600 absolute top-2 left-2 rounded px-1.5 py-0.5 text-[11px] font-bold text-white">
              Baru
            </span>
          )}
        </div>
        <div className="flex flex-1 flex-col px-3 pb-3">
          {/* Three lines: long accessory names end with the word that says what they are */}
          <h3 className="text-ink line-clamp-3 text-[13px] leading-[1.35] font-medium">{name}</h3>
          {(many || range.length > 0) && (
            <p className="text-muted mt-1 text-xs">
              {many && <>{m.variants.length} varian · </>}
              {/* Breaks only after the dash when the card is too narrow for the whole range */}
              {range.length > 0 && (
                <span className="whitespace-nowrap">
                  {range[0]}
                  {range[1] && ' –'}
                </span>
              )}
              {range[1] && (
                <>
                  {' '}
                  <span className="whitespace-nowrap">{range[1]}</span>
                </>
              )}
            </p>
          )}
          <p className="mt-auto pt-2">
            {from && <span className="text-muted mr-1 text-xs">Mulai</span>}
            <span className={m.minPrice ? 'text-ink text-[15px] font-extrabold' : 'text-muted text-sm font-bold'}>
              {formatPrice(m.minPrice)}
            </span>
          </p>
        </div>
      </Link>
      <button
        type="button"
        onClick={() => compare.toggle(m.slug, info.compareName)}
        aria-pressed={selected}
        aria-label={`Bandingkan ${info.compareName}`}
        title={
          selected ? 'Hapus dari perbandingan' : info.mainLabel ? `Bandingkan varian ${info.mainLabel}` : 'Bandingkan'
        }
        // 36px circle, 44px hit area via ::before. Hidden until hover only where hover exists,
        // so touch screens of any width always see it.
        className={`absolute top-2 right-2 z-10 grid size-8 place-items-center rounded-full border transition before:absolute before:-inset-1.5 ${
          selected
            ? 'bg-brand-600 border-brand-600 text-white'
            : 'hover:text-brand-700 border-line text-muted bg-white group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:hover)]:opacity-0'
        }`}
      >
        {selected ? <Check className="size-4" /> : <GitCompareArrows className="size-4" />}
      </button>
    </article>
  )
}

// products: models from useModels() (plain listings still work). className is appended to the
// grid, e.g. to hide items that would leave a ragged last row at one breakpoint.
export function ProductGrid({ products, priorityCount = 0, columns = 'default', showNewBadge, className = '' }) {
  return (
    <div className={`grid gap-3 sm:gap-4 ${COLUMNS[columns]} ${className}`}>
      {products.map((p, i) => (
        <ProductCard
          key={p.key ?? p.slug}
          p={p}
          priority={i < priorityCount}
          sizes={SIZES[columns]}
          showNewBadge={showNewBadge}
        />
      ))}
    </div>
  )
}

// Same box model as ProductCard (square photo + text block) so nothing jumps when data arrives.
export function CardSkeleton() {
  return (
    <div className="card flex h-full flex-col overflow-hidden" aria-hidden>
      <div className="skeleton m-3 aspect-square" />
      <div className="px-3 pb-3">
        <div className="skeleton mt-1.5 h-3.5 w-full rounded" />
        <div className="skeleton mt-1.5 h-3.5 w-2/3 rounded" />
        <div className="skeleton mt-2 h-3 w-24 rounded" />
        <div className="skeleton mt-4 h-5 w-24 rounded" />
      </div>
    </div>
  )
}

export function GridSkeleton({ count = 10, columns = 'default', label = 'Memuat produk…', className = '' }) {
  return (
    <div role="status" className={`grid gap-3 sm:gap-4 ${COLUMNS[columns]} ${className}`}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: count }, (_, i) => (
        <CardSkeleton key={i} />
      ))}
    </div>
  )
}
