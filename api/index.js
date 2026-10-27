const http = require('http');
const https = require('https');
const { app } = require('../server/index');

/**
 * Vercel Serverless Entrypoint (`api/index.js`)
 * - If `RENDER_BACKEND_URL` or `PUBLIC_BACKEND_URL` is configured, proxies dynamic HTML/API
 *   requests to the Render backend while keeping the user on the Vercel frontend domain
 *   and pointing real-time WebSockets (`wss://`) directly to Render.
 * - Otherwise falls back to the Express `app` directly.
 */
module.exports = (req, res) => {
  const backendOrigin = String(
    process.env.RENDER_BACKEND_URL || process.env.PUBLIC_BACKEND_URL || ''
  )
    .trim()
    .replace(/\/+$/, '');

  // Serve static frontend assets directly via Express static middleware on Vercel
  if (
    !backendOrigin ||
    req.url.startsWith('/-/css/') ||
    req.url.startsWith('/-/js/') ||
    req.url.startsWith('/shared/')
  ) {
    return app(req, res);
  }

  let parsedBackend;
  try {
    parsedBackend = new URL(backendOrigin);
  } catch (_) {
    return app(req, res);
  }

  const client = parsedBackend.protocol === 'https:' ? https : http;
  const forwardHeaders = Object.assign({}, req.headers, {
    host: parsedBackend.host,
    'x-forwarded-host': req.headers.host || '',
    'x-forwarded-proto': 'https'
  });
  delete forwardHeaders['accept-encoding']; // Receive uncompressed HTML so we can inject backendUrl if needed

  const proxyReq = client.request(
    {
      protocol: parsedBackend.protocol,
      hostname: parsedBackend.hostname,
      port: parsedBackend.port || (parsedBackend.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: req.url,
      headers: forwardHeaders
    },
    (proxyRes) => {
      const statusCode = proxyRes.statusCode || 200;
      const headers = Object.assign({}, proxyRes.headers);

      // Keep redirects (e.g. /new -> /:slug) on the Vercel frontend domain
      if (headers.location && headers.location.startsWith(backendOrigin)) {
        headers.location = headers.location.slice(backendOrigin.length) || '/';
      }

      const contentType = String(headers['content-type'] || '');
      if (contentType.includes('text/html')) {
        const chunks = [];
        proxyRes.on('data', (chunk) => chunks.push(chunk));
        proxyRes.on('end', () => {
          let html = Buffer.concat(chunks).toString('utf8');
          const injectScript = `<script>window.CODESHARE_BACKEND_URL = ${JSON.stringify(
            backendOrigin
          )};</script>`;
          if (html.includes('<script>window.__CODESHARE_BOOTSTRAP__')) {
            html = html.replace(
              '<script>window.__CODESHARE_BOOTSTRAP__',
              `${injectScript}\n  <script>window.__CODESHARE_BOOTSTRAP__`
            );
          }
          delete headers['content-length'];
          res.writeHead(statusCode, headers);
          res.end(html);
        });
        return;
      }

      res.writeHead(statusCode, headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', () => {
    // Fallback to local Express handler if Render backend is waking up
    app(req, res);
  });

  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
    const bodyStr = JSON.stringify(req.body);
    proxyReq.setHeader('Content-Type', 'application/json');
    proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyStr));
    proxyReq.write(bodyStr);
    proxyReq.end();
  } else {
    req.pipe(proxyReq);
  }
};
