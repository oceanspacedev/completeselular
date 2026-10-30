import Breadcrumbs from './Breadcrumbs'

// Navy band under the site header (same family as the Tentang Kami hero): breadcrumb, heading,
// optional one-line subtitle, and the page's main action on the right on wide screens.
//   crumbs   trail after "Beranda"; defaults to the title. Pages with a marketing-style title should
//            pass the short page name instead, e.g. crumbs={[{ label: 'Promo' }]}
//   actions  button(s) beside the heading from md up, under it on phones
//   children extra controls below the heading (e.g. filter chips), full width
//   compact  a short band on phones (no breadcrumb, smaller heading), for pages where the content
//            should start high on the screen, like the catalogue
export default function PageHeader({ title, subtitle, crumbs, actions, compact, children }) {
  return (
    <header className="bg-navy-800 text-white">
      <div className={`container-page ${compact ? 'py-3 sm:py-7' : 'py-5 sm:py-7'}`}>
        <div className={compact ? 'max-sm:hidden' : undefined}>
          <Breadcrumbs onDark items={crumbs ?? [{ label: title }]} />
        </div>
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between md:gap-8">
          <div className="min-w-0">
            <h1 className={`leading-tight font-extrabold text-balance sm:text-3xl ${compact ? 'text-xl' : 'text-2xl'}`}>
              {title}
            </h1>
            {subtitle && <p className="mt-1.5 max-w-2xl text-sm text-pretty text-white/75 sm:text-base">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
        </div>
        {children && <div className="mt-4">{children}</div>}
      </div>
    </header>
  )
}
