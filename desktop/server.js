'use strict'
// Serves the built frontend over http://127.0.0.1:<port> and forwards /api to
// the hosted backend.
//
// Why a local HTTP server rather than loadFile(): the app uses BrowserRouter
// and registers a service worker at /sw.js, and neither works from a file://
// origin. Serving over http keeps the router, the service worker AND all 67
// relative /api paths working with no change to the frontend at all.
const http = require('node:http')
const https = require('node:https')
const fs = require('node:fs')
const path = require('node:path')
const { URL } = require('node:url')

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.woff': 'font/woff', '.ttf': 'font/ttf', '.map': 'application/json',
}

function proxy(req, res, upstream) {
  const target = new URL(req.url, upstream)
  const headers = { ...req.headers, host: target.host }
  delete headers['accept-encoding'] // let the client negotiate with us, not upstream
  const client = target.protocol === 'https:' ? https : http
  const out = client.request(
    { protocol: target.protocol, hostname: target.hostname, port: target.port,
      path: target.pathname + target.search, method: req.method, headers },
    up => {
      res.writeHead(up.statusCode || 502, up.headers)
      up.pipe(res)
    },
  )
  out.on('error', err => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ detail: `upstream unreachable: ${err.code || err.message}` }))
  })
  req.pipe(out)
}

function serveFile(res, file) {
  fs.createReadStream(file)
    .on('open', () => res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      // Hashed assets are immutable; the shell must not be, or a new build
      // never reaches a window that has already run once.
      'cache-control': file.includes(`${path.sep}assets${path.sep}`)
        ? 'public, max-age=31536000, immutable' : 'no-cache',
    }))
    .on('error', () => { res.writeHead(500); res.end('read error') })
    .pipe(res)
}

/** @returns {Promise<{port:number, close:() => void}>} */
function start({ root, upstream }) {
  const index = path.join(root, 'index.html')
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/')) return proxy(req, res, upstream)

    const clean = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    const target = path.normalize(path.join(root, clean))
    // Never serve outside the bundled dist, whatever the path claims.
    if (!target.startsWith(root)) { res.writeHead(403); return res.end('forbidden') }

    fs.stat(target, (err, st) => {
      if (!err && st.isFile()) return serveFile(res, target)
      // Unknown path with no extension is a client route: hand back the shell.
      if (path.extname(clean)) { res.writeHead(404); return res.end('not found') }
      serveFile(res, index)
    })
  })
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, close: () => server.close() })
    })
  })
}

module.exports = { start }
