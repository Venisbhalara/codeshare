const crypto = require('crypto');
const db = require('./db');

const COOKIE_SECRET = process.env.COOKIE_SECRET || 'codeshare-v3-hmac-cookie-secret-key-2026';
const JWT_SECRET = process.env.JWT_SECRET || 'codeshare-v3-jwt-hs256-secret-key-2026';
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function base64UrlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return buf
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(str) {
  let b64 = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  return Buffer.from(b64, 'base64').toString('utf8');
}

// Sign web.sid -> "<sid>.<hmac_base64>" matching Codeshare's web.sid.sig format
function signSessionId(sid) {
  const hmac = crypto
    .createHmac('sha256', COOKIE_SECRET)
    .update(String(sid))
    .digest('base64')
    .replace(/=+$/, '');
  return `${sid}.${hmac}`;
}

function verifySessionSignature(sid, sigCookie) {
  if (!sid || !sigCookie) return false;
  const expected = signSessionId(sid);
  const a = Buffer.from(String(sigCookie));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Generate HS256 JWT ("v": 2) matching Codeshare's pageProps.apiHeaders.authorization
function signJwt(rawUserId) {
  const cleanId = String(rawUserId).replace(/^anon:/, '');
  const expiresAt = new Date(Date.now() + THIRTY_DAYS_MS).toISOString();
  const header = { typ: 'JWT', alg: 'HS256' };
  const payload = {
    id: cleanId,
    rawUserId: String(rawUserId),
    expiresAt,
    v: 2
  };
  const unsigned = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(
    JSON.stringify(payload)
  )}`;
  const signature = base64UrlEncode(
    crypto.createHmac('sha256', JWT_SECRET).update(unsigned).digest()
  );
  return `${unsigned}.${signature}`;
}

function verifyJwt(tokenHeader) {
  if (!tokenHeader) return null;
  const rawToken = String(tokenHeader).replace(/^(token|Bearer)\s+/i, '').trim();
  const parts = rawToken.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const expectedSig = base64UrlEncode(
    crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest()
  );
  if (s !== expectedSig) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(p));
    if (payload.expiresAt && new Date(payload.expiresAt).getTime() < Date.now()) {
      return null;
    }
    return payload;
  } catch (_) {
    return null;
  }
}

function setSessionCookies(res, sid) {
  const expires = new Date(Date.now() + THIRTY_DAYS_MS);
  const sig = signSessionId(sid);
  res.cookie('web.sid', sid, {
    path: '/',
    expires,
    httpOnly: true,
    sameSite: 'lax'
  });
  res.cookie('web.sid.sig', sig, {
    path: '/',
    expires,
    httpOnly: true,
    sameSite: 'lax'
  });
}

function parseCookiesFromHeader(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  String(cookieHeader)
    .split(';')
    .forEach((pair) => {
      const idx = pair.indexOf('=');
      if (idx === -1) return;
      const k = pair.slice(0, idx).trim();
      const v = decodeURIComponent(pair.slice(idx + 1).trim());
      out[k] = v;
    });
  return out;
}

/**
 * SessionHelper.getOrCreate(req, res)
 * Every visitor immediately gets a persistent session (web.sid + web.sid.sig)
 * and an anonymous user if not logged in.
 */
function getOrCreateSession(req, res) {
  const cookies = req.cookies || parseCookiesFromHeader(req.headers && req.headers.cookie);
  const sid = cookies['web.sid'];
  const sig = cookies['web.sid.sig'];

  if (sid && sig && verifySessionSignature(sid, sig)) {
    const sess = db.getSession(sid);
    if (sess) {
      const user = db.getUserByRawId(sess.userId);
      if (user) {
        const jwt = signJwt(user.id);
        return {
          session: sess,
          user,
          apiHeaders: {
            authorization: `token ${jwt}`,
            'x-forwarded-for': req.ip || '127.0.0.1'
          }
        };
      }
    }
  }

  // Fallback: check Authorization header JWT (used by SSR / WebSocket connectionParams)
  const authHeader =
    req.headers && (req.headers.authorization || req.headers.Authorization);
  if (authHeader) {
    const payload = verifyJwt(authHeader);
    if (payload) {
      const user =
        db.getUserByRawId(payload.rawUserId) ||
        db.getUserByRawId(`anon:${payload.id}`) ||
        db.getUserByRawId(payload.id);
      if (user) {
        const sess = db.createSession(user.id);
        if (res && typeof res.cookie === 'function') {
          setSessionCookies(res, sess.sid);
        }
        return {
          session: sess,
          user,
          apiHeaders: {
            authorization: `token ${signJwt(user.id)}`,
            'x-forwarded-for': (req && req.ip) || '127.0.0.1'
          }
        };
      }
    }
  }

  // Create new anonymous user & session
  const anonUser = db.createAnonymousUser();
  const sess = db.createSession(anonUser.id);
  if (res && typeof res.cookie === 'function') {
    setSessionCookies(res, sess.sid);
  }
  const jwt = signJwt(anonUser.id);
  return {
    session: sess,
    user: anonUser,
    apiHeaders: {
      authorization: `token ${jwt}`,
      'x-forwarded-for': (req && req.ip) || '127.0.0.1'
    }
  };
}

/**
 * Browser Compatibility Gate Middleware (replicates Codeshare's HTTP 400 gate
 * when a legacy browser UA or ?browserGate=1 is sent without forceBrowserCompatibility=true)
 */
function browserCompatibilityGate(req, res, next) {
  if (req.path.startsWith('/-/') || req.path.startsWith('/shared/')) {
    return next();
  }
  const cookies = req.cookies || parseCookiesFromHeader(req.headers.cookie);
  if (cookies.forceBrowserCompatibility === 'true') {
    return next();
  }
  const ua = String(req.headers['user-agent'] || '');
  const isLegacyIE = /MSIE\s|Trident\//i.test(ua);
  const forceGateTrigger = req.query && req.query.browserGate === '1';

  if (isLegacyIE || forceGateTrigger) {
    res.status(400).send(`<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>CodeFlow - Unsupported Browser</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" type="image/svg+xml" href="/shared/logo.svg?v=v3.40.11" />
    <link rel="stylesheet" href="/-/css/styles.css?v=v3.40.11" />
  </head>
  <body class="gate-body">
    <main class="gate-card">
      <div class="brand-mark" aria-hidden="true">
        <svg class="brand-logo-svg" width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M7.8 7.5L3.5 12L7.8 16.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M16.2 7.5L20.5 12L16.2 16.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M9.8 16.8C10.5 11.8 13.5 12.2 14.2 7.2" stroke="#F4A27E" stroke-width="2.2" stroke-linecap="round" />
          <circle cx="9.8" cy="16.8" r="1.35" fill="#F4A27E" />
          <circle cx="14.2" cy="7.2" r="1.35" fill="#FFE3CC" />
        </svg>
      </div>
      <h1 class="serif-display">Please update your browser.</h1>
      <p class="gate-text">
        In order to give you the best possible experience closely matched to your text editor,
        CodeFlow uses cutting edge browser technology and requires an up to date browser.
      </p>
      <p class="gate-subtext">
        Still having trouble?
        <a id="use-anyway-button" href="javascript:void(0)">Ignore and use CodeFlow anyway.</a>
      </p>
    </main>
    <script>
      (function () {
        var useAnywayButton = document.getElementById('use-anyway-button');
        useAnywayButton.onclick = function () {
          var twoWeeks = 14 * 24 * 60 * 60 * 1000;
          var expires = new Date(Date.now() + twoWeeks).toUTCString();
          document.cookie = 'forceBrowserCompatibility=true; path=/; expires=' + expires;
          var url = new URL(window.location.href);
          url.searchParams.delete('browserGate');
          window.location.href = url.toString();
        };
      })();
    </script>
  </body>
</html>`);
    return;
  }
  next();
}

module.exports = {
  signSessionId,
  verifySessionSignature,
  signJwt,
  verifyJwt,
  setSessionCookies,
  parseCookiesFromHeader,
  getOrCreateSession,
  browserCompatibilityGate
};

