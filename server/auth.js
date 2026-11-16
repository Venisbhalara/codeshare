const crypto = require('crypto');
const db = require('./db');

const COOKIE_SECRET = db.getRuntimeSecret('COOKIE_SECRET');
const JWT_SECRET = db.getRuntimeSecret('JWT_SECRET');
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const ANON_BUCKET_WINDOW_MS = 60 * 1000;
const MAX_ANON_SESSIONS_PER_IP_WINDOW = 30;
const anonIpBuckets = new Map(); // ip -> { count, resetAt, lastSid, lastUserId }

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

function isAllowedOrigin(origin, req = null) {
  if (!origin) return true;
  let parsed;
  try {
    parsed = new URL(String(origin));
  } catch (_) {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }
  const normalizedOrigin = parsed.origin.toLowerCase();
  const reqHost =
    req && req.headers && req.headers.host ? String(req.headers.host).trim().toLowerCase() : '';
  if (reqHost && parsed.host.toLowerCase() === reqHost) {
    return true;
  }
  if (
    process.env.NODE_ENV !== 'production' &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
  ) {
    return true;
  }

  const configured = [
    process.env.ALLOWED_ORIGINS || '',
    process.env.APP_URL || '',
    process.env.PUBLIC_URL || '',
    process.env.RENDER_EXTERNAL_URL || '',
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '',
    process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : ''
  ]
    .join(',')
    .split(',')
    .map((item) => item.trim().replace(/\/+$/, '').toLowerCase())
    .filter(Boolean);

  return configured.includes(normalizedOrigin);
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
function signJwt(rawUserId, sid = null) {
  const cleanId = String(rawUserId).replace(/^anon:/, '');
  const expiresAt = new Date(Date.now() + THIRTY_DAYS_MS).toISOString();
  const header = { typ: 'JWT', alg: 'HS256' };
  const payload = {
    id: cleanId,
    rawUserId: String(rawUserId),
    sidHash: sid ? db.hashSessionId(sid) : undefined,
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
  const sigBuf = Buffer.from(String(s), 'utf8');
  const expectedBuf = Buffer.from(String(expectedSig), 'utf8');
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }
  try {
    const payload = JSON.parse(base64UrlDecode(p));
    if (!payload || typeof payload !== 'object') return null;
    if (payload.expiresAt && new Date(payload.expiresAt).getTime() < Date.now()) {
      return null;
    }
    if (payload.sidHash) {
      const boundSess = db.state && db.state.sessions && db.state.sessions[payload.sidHash];
      if (!boundSess || new Date(boundSess.expiresAt).getTime() < Date.now()) {
        return null;
      }
      if (boundSess.userId !== payload.rawUserId) {
        return null;
      }
    }
    return payload;
  } catch (_) {
    return null;
  }
}

function setSessionCookies(res, sid) {
  const expires = new Date(Date.now() + THIRTY_DAYS_MS);
  const sig = signSessionId(sid);
  const secure = process.env.NODE_ENV === 'production';
  res.cookie('web.sid', sid, {
    path: '/',
    expires,
    httpOnly: true,
    sameSite: 'lax',
    secure
  });
  res.cookie('web.sid.sig', sig, {
    path: '/',
    expires,
    httpOnly: true,
    sameSite: 'lax',
    secure
  });
}

function clearSessionCookies(res) {
  const secure = process.env.NODE_ENV === 'production';
  res.clearCookie('web.sid', { path: '/', httpOnly: true, sameSite: 'lax', secure });
  res.clearCookie('web.sid.sig', { path: '/', httpOnly: true, sameSite: 'lax', secure });
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
      const rawVal = pair.slice(idx + 1).trim();
      try {
        out[k] = decodeURIComponent(rawVal);
      } catch (_) {
        out[k] = rawVal;
      }
    });
  return out;
}

/**
 * SessionHelper.getOrCreate(req, res)
 * Every visitor immediately gets a persistent session (web.sid + web.sid.sig)
 * and an anonymous user if not logged in.
 */
function getOrCreateSession(req, res) {
  const cookies = (req && req.cookies) || parseCookiesFromHeader(req && req.headers && req.headers.cookie);
  const sid = cookies['web.sid'];
  const sig = cookies['web.sid.sig'];

  if (sid && sig && verifySessionSignature(sid, sig)) {
    const sess = db.getSession(sid);
    if (sess) {
      const user = db.getUserByRawId(sess.userId);
      if (user) {
        const jwt = signJwt(user.id, sess.sid);
        return {
          session: sess,
          user,
          apiHeaders: {
            authorization: `token ${jwt}`
          }
        };
      }
    }
  }

  // Fallback: check Authorization header JWT (used by SSR / WebSocket connectionParams)
  const authHeader =
    req && req.headers && (req.headers.authorization || req.headers.Authorization);
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
            authorization: `token ${signJwt(user.id, sess.sid)}`
          }
        };
      }
    }
  }

  // Throttle cookieless session floods from a single IP
  const clientIp =
    (req && (req.ip || (req.socket && req.socket.remoteAddress))) || '127.0.0.1';
  const now = Date.now();
  let bucket = anonIpBuckets.get(clientIp);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + ANON_BUCKET_WINDOW_MS, lastSid: null, lastUserId: null };
    anonIpBuckets.set(clientIp, bucket);
  }
  bucket.count += 1;

  if (
    bucket.count > MAX_ANON_SESSIONS_PER_IP_WINDOW &&
    bucket.lastSid &&
    bucket.lastUserId
  ) {
    const existingSess = db.getSession(bucket.lastSid);
    const existingUser = db.getUserByRawId(bucket.lastUserId);
    if (existingSess && existingUser) {
      if (res && typeof res.cookie === 'function') {
        setSessionCookies(res, existingSess.sid);
      }
      return {
        session: existingSess,
        user: existingUser,
        apiHeaders: {
          authorization: `token ${signJwt(existingUser.id, existingSess.sid)}`
        }
      };
    }
  }

  // Create new anonymous user & session
  const anonUser = db.createAnonymousUser();
  const sess = db.createSession(anonUser.id);
  bucket.lastSid = sess.sid;
  bucket.lastUserId = anonUser.id;

  if (res && typeof res.cookie === 'function') {
    setSessionCookies(res, sess.sid);
  }
  const jwt = signJwt(anonUser.id, sess.sid);
  return {
    session: sess,
    user: anonUser,
    apiHeaders: {
      authorization: `token ${jwt}`
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
    <title>CodeeFlow - Unsupported Browser</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" type="image/svg+xml" href="/shared/logo.svg?v=v3.40.14" />
    <link rel="stylesheet" href="/-/css/styles.css?v=v3.40.14" />
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
        CodeeFlow uses cutting edge browser technology and requires an up to date browser.
      </p>
      <p class="gate-subtext">
        Still having trouble?
        <a id="use-anyway-button" href="javascript:void(0)">Ignore and use CodeeFlow anyway.</a>
      </p>
    </main>
    <script>
      (function () {
        var useAnywayButton = document.getElementById('use-anyway-button');
        useAnywayButton.onclick = function () {
          var twoWeeks = 14 * 24 * 60 * 60 * 1000;
          var expires = new Date(Date.now() + twoWeeks).toUTCString();
          var sec = window.location.protocol === 'https:' ? '; Secure' : '';
          document.cookie = 'forceBrowserCompatibility=true; path=/; SameSite=Lax' + sec + '; expires=' + expires;
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
  isAllowedOrigin,
  signSessionId,
  verifySessionSignature,
  signJwt,
  verifyJwt,
  setSessionCookies,
  clearSessionCookies,
  parseCookiesFromHeader,
  getOrCreateSession,
  browserCompatibilityGate
};

