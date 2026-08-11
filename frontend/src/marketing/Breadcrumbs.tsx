import { Link } from 'react-router-dom'

// Two halves of the same idea. The visible trail tells a visitor who arrived
// from search where this page sits and gives them one click upward; the
// BreadcrumbList JSON-LD tells a crawler the same thing, which is what makes a
// result render "alphatape.app › Options" instead of the bare URL.
//
// Every intermediate crumb must be a real, crawlable URL — a link to a tier
// that does not exist is worse than a shorter trail, so these stay two deep
// until there is a genuine /product index to point at.

export interface Crumb {
  label: string
  /** Omitted on the final crumb: you do not link the page you are on. */
  to?: string
}

const ORIGIN = 'https://alphatape.app'

export function breadcrumbSchema(trail: Crumb[]): string {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((crumb, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: crumb.label,
      ...(crumb.to ? { item: `${ORIGIN}${crumb.to}` } : {}),
    })),
  })
}

export default function Breadcrumbs({ trail }: { trail: Crumb[] }) {
  if (trail.length < 2) return null
  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb">
        <ol>
          {trail.map((crumb, index) => {
            const last = index === trail.length - 1
            return (
              <li key={crumb.label}>
                {crumb.to && !last
                  ? <Link to={crumb.to}>{crumb.label}</Link>
                  : <span aria-current={last ? 'page' : undefined}>{crumb.label}</span>}
                {!last && <span className="sep" aria-hidden="true">›</span>}
              </li>
            )
          })}
        </ol>
      </nav>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: breadcrumbSchema(trail) }}
      />
    </>
  )
}
