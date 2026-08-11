import { useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'

/**
 * Real 404 for any unrouted path.
 *
 * The catch-all used to redirect to /app, which answered every dead URL with a
 * success and dropped the visitor into the terminal with no explanation. A
 * crawler reads that as a soft 404 — a page claiming to be found that is not —
 * and it can hold back indexing of the page it lands on.
 *
 * The app is served as a single HTML document for every path, so the HTTP
 * status on this response is still 200; the `noindex` below is what actually
 * keeps a dead URL out of the index, and search engines run it because they
 * render the page before deciding.
 */
export default function NotFound() {
  const { pathname } = useLocation()

  useEffect(() => {
    const previousTitle = document.title
    document.title = 'Page not found | Alphatape'

    const robots = document.createElement('meta')
    robots.name = 'robots'
    robots.content = 'noindex, follow'
    document.head.appendChild(robots)

    return () => {
      document.title = previousTitle
      robots.remove()
    }
  }, [])

  return (
    <main className="phero" style={{ borderBottom: 'none', minHeight: '58vh' }}>
      <div className="wrap">
        <div className="eyebrow">Error 404</div>
        <h1>This page does not exist.</h1>
        <p className="lede">
          Nothing is routed at <code>{pathname}</code>. The link may be out of date, or the
          address may have a typo in it.
        </p>
        <div className="cta">
          <Link to="/app" className="btn btn-gold btn-lg">Launch Terminal →</Link>
          <Link to="/" className="btn btn-ghost btn-lg">Overview</Link>
        </div>
        <nav aria-label="Popular pages" style={{ marginTop: 34 }}>
          <div className="eyebrow" style={{ marginBottom: 12 }}>Or start here</div>
          <ul className="nf-links">
            <li><Link to="/product/research">Research tools</Link></li>
            <li><Link to="/product/options">Options and volatility</Link></li>
            <li><Link to="/product/valuation">Valuation models</Link></li>
            <li><Link to="/product/macro">Macro and rates</Link></li>
            <li><Link to="/product/trading">Trading and portfolio</Link></li>
            <li><Link to="/data-sources">Data sources</Link></li>
          </ul>
        </nav>
      </div>
    </main>
  )
}
