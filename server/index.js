const http = require('http');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { WebSocketServer } = require('ws');

const db = require('./db');
const { encodeRelayId } = require('../shared/ot');
const {
  getOrCreateSession,
  setSessionCookies,
  browserCompatibilityGate
} = require('./auth');
const {
  executeGraphQLOperation,
  attachWebSocketHandler,
  pubsub,
  formatMeNode,
  formatUserNode,
  formatCodeshareNode
} = require('./graphql');
const {
  renderRoomPage,
  renderLandingPage,
  renderCodesDashboard,
  renderPlansPage,
  renderSettingsPage,
  renderAuthPage,
  renderAdminPage
} = require('./views');

const app = express();
const PORT = process.env.PORT || 3000;

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, x-codeshare-auth-mutation'
    );
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});
app.use(cookieParser());
app.use(express.json({ limit: '512kb' }));

// Health check endpoint for Render
app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'ok', version: 'v3.40.0' });
});

// Static assets under /-/ and /shared/
app.use('/-/css', express.static(path.join(__dirname, '..', 'public', 'css')));
app.use('/-/js', express.static(path.join(__dirname, '..', 'public', 'js')));
app.use('/shared', express.static(path.join(__dirname, '..', 'shared')));
app.get('/shared/lenis.min.js', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'node_modules', 'lenis', 'dist', 'lenis.min.js'));
});

// Browser compatibility gate middleware
app.use(browserCompatibilityGate);

// 1. Sponsor JSON Proxy (`/-/sp.json?k=CESIKK7N&t=f`)
app.get('/-/sp.json', (req, res) => {
  res.json({
    ads: [
      {
        statlink: '/plans',
        description:
          'CodeeFlow Pro — Unlock View-Only rooms, unlimited saved CodeeFlows & zero ads.',
        smallImage: '',
        pixel: ''
      }
    ]
  });
});

// 2. GraphQL HTTP Endpoint (`POST /-/api/graphql` & `POST /api/graphql`)
app.post(['/-/api/graphql', '/api/graphql'], async (req, res) => {
  const { session, user } = getOrCreateSession(req, res);
  const { operationName, query, variables } = req.body || {};
  const result = await executeGraphQLOperation({
    operationName,
    query,
    variables,
    context: { user, session, res }
  });
  res.json(result);
});

// 3. Landing Pages (`/`, `/interview`, `/teach`)
app.get(['/', '/interview', '/teach'], (req, res) => {
  const { user, session, apiHeaders } = getOrCreateSession(req, res);
  if (session) db.setSessionActiveCodeshare(session.sid, null);
  const variant =
    req.path === '/interview'
      ? 'interview'
      : req.path === '/teach'
      ? 'teach'
      : 'default';
  res.send(
    renderLandingPage({
      me: formatMeNode(user),
      apiHeaders,
      variant
    })
  );
});

// 4. Instant Room Creation (`GET /new` -> HTTP 302 Redirect to `/:codeshareId`)
app.get('/new', (req, res) => {
  const { user, session } = getOrCreateSession(req, res);
  try {
    const cs = db.createCodeshare(user);
    if (session) db.setSessionActiveCodeshare(session.sid, cs.id);
    res.redirect(302, `/${cs.slug || cs.id}`);
  } catch (err) {
    if (
      err.status === 403 ||
      [
        'NON_PRO_CODESHARE_LIMIT_REACHED',
        'RENEW_PRO_CODESHARE_LIMIT_REACHED',
        'ANON_CODESHARE_LIMIT_REACHED'
      ].includes(err.code)
    ) {
      res.redirect(302, '/codes?limitReached=1');
      return;
    }
    res.status(500).send('Failed to create codeshare');
  }
});

// 4b. Join Existing Codeshare Route (`GET /join?room=...`)
app.get('/join', (req, res) => {
  const { session } = getOrCreateSession(req, res);
  if (session) db.setSessionActiveCodeshare(session.sid, null);
  const rawInput = String((req.query && req.query.room) || '').trim();
  if (!rawInput) {
    res.redirect(302, '/');
    return;
  }
  let targetSlug = rawInput;
  let lineHash = '';
  const hashMatch = /#(L\d+(?:-L?\d+)?)$/i.exec(rawInput);
  if (hashMatch) {
    lineHash = '#' + hashMatch[1].toUpperCase();
    targetSlug = rawInput.slice(0, hashMatch.index);
  }
  try {
    if (/^https?:\/\//i.test(targetSlug)) {
      const parsedUrl = new URL(targetSlug);
      targetSlug = parsedUrl.pathname.replace(/^\/+|\/+$/g, '');
    } else if (targetSlug.includes('/')) {
      const parts = targetSlug.split('/').filter(Boolean);
      targetSlug = parts[parts.length - 1];
    }
  } catch (_) {}

  targetSlug = targetSlug
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 64);

  if (!targetSlug) {
    res.redirect(302, '/');
    return;
  }
  res.redirect(302, `/${encodeURIComponent(targetSlug)}${lineHash}`);
});

// 5. Saved Codeshares Dashboard (`GET /codes`)
app.get('/codes', (req, res) => {
  const { user, session, apiHeaders } = getOrCreateSession(req, res);
  if (session) db.setSessionActiveCodeshare(session.sid, null);
  if (user.anonymous) {
    res.redirect(302, '/login');
    return;
  }
  const savedList = db
    .getSavedCodesharesForUser(user.id)
    .map((cs) => formatCodeshareNode(cs, user.id));
  res.send(
    renderCodesDashboard({
      me: formatMeNode(user),
      codeshares: savedList,
      limitReached: req.query.limitReached === '1',
      apiHeaders
    })
  );
});

// 6. Plans & Pricing (`GET /plans`)
app.get('/plans', (req, res) => {
  const { user, apiHeaders } = getOrCreateSession(req, res);
  res.send(
    renderPlansPage({
      me: formatMeNode(user),
      apiHeaders
    })
  );
});

// 7. User Account Settings (`GET /settings`)
app.get('/settings', (req, res) => {
  const { user, apiHeaders } = getOrCreateSession(req, res);
  if (user.anonymous) {
    res.redirect(302, '/login');
    return;
  }
  res.send(
    renderSettingsPage({
      me: formatMeNode(user),
      apiHeaders
    })
  );
});

// 8. Auth Routes (`/login`, `/register`, `/logout`)
app.get('/login', (req, res) => {
  const { user, apiHeaders } = getOrCreateSession(req, res);
  if (!user.anonymous) {
    res.redirect(302, '/codes');
    return;
  }
  res.send(
    renderAuthPage({
      me: formatMeNode(user),
      mode: 'login',
      saveCodeshare: req.query.saveCodeshare || null,
      apiHeaders
    })
  );
});

app.get('/register', (req, res) => {
  const { user, apiHeaders } = getOrCreateSession(req, res);
  if (!user.anonymous) {
    res.redirect(302, '/codes');
    return;
  }
  res.send(
    renderAuthPage({
      me: formatMeNode(user),
      mode: 'register',
      saveCodeshare: req.query.saveCodeshare || null,
      apiHeaders
    })
  );
});

app.get('/logout', (req, res) => {
  const { session } = getOrCreateSession(req, res);
  const freshAnon = db.createAnonymousUser();
  if (session) {
    db.updateSessionUser(session.sid, freshAnon.id);
    setSessionCookies(res, session.sid);
  }
  res.redirect(302, '/');
});

// 9. Internal Admin Dashboard (`GET /_/admin`)
app.get('/_/admin', (req, res) => {
  const { user, apiHeaders } = getOrCreateSession(req, res);
  const searchedEmail = req.query.email || 'demo@codeeflow.io';
  const foundUser = db.getUserByEmail(searchedEmail);
  res.send(
    renderAdminPage({
      me: formatMeNode(user),
      searchedEmail,
      targetUser: foundUser ? formatUserNode(foundUser) : null,
      apiHeaders
    })
  );
});

// 10. Collaborative Room Route (`GET /:codeshareId`)
app.get('/:codeshareId', (req, res) => {
  const rawShortId = String(req.params.codeshareId || '').trim();
  if (rawShortId === 'favicon.ico') {
    res.redirect(302, '/shared/logo.svg');
    return;
  }

  const shortId = /^[a-zA-Z0-9_-]+$/.test(rawShortId)
    ? rawShortId
    : db.toUrlSlug(rawShortId, '');

  // Exact Relay ID length validation from pages/[codeshareId] (<= 127 chars)
  const encodedId = encodeRelayId('Codeshare', shortId);
  if (!shortId || encodedId.length > 127 || !/^[a-zA-Z0-9_-]+$/.test(shortId)) {
    res.status(400).send('Invalid URL');
    return;
  }

  const { user, session, apiHeaders } = getOrCreateSession(req, res);
  let cs = db.getCodeshareByShortId(shortId);

  // Two-way URL <-> Title Sync:
  // 1) If the user is actively inside an editable room (`session.activeCodeshareId`) and changes
  //    the URL in the browser address bar to a new custom slug, rename their active room's title & slug!
  if (!cs && session && session.activeCodeshareId) {
    const activeCs = db.getCodeshareByShortId(session.activeCodeshareId);
    if (
      activeCs &&
      activeCs.id !== 'G8WoB4' &&
      activeCs.createdByUserId === user.id &&
      db.canUserEditCodeshare(activeCs, user.id)
    ) {
      try {
        cs = db.updateCodeshare(activeCs.id, user.id, { title: rawShortId });
        pubsub.publishCodeshareUpdated(cs.id);
      } catch (_) {}
    }
  }

  // 2) If `cs` already exists, but the URL slug entered in the address bar differs from `cs.slug`
  //    (e.g. changing `/custom-title` back to `/originalId` or another slug for this room),
  //    update `cs.title` and `cs.slug` so the room title reflects the URL change!
  if (
    cs &&
    cs.slug &&
    cs.slug.toLowerCase() !== shortId.toLowerCase() &&
    db.canUserEditCodeshare(cs, user.id)
  ) {
    try {
      cs = db.updateCodeshare(cs.id, user.id, { title: rawShortId });
      pubsub.publishCodeshareUpdated(cs.id);
    } catch (_) {}
  }

  if (!cs) {
    cs = db.getOrCreateCodeshareByShortId(shortId, user);
  }
  if (!cs) {
    res.status(404).send('Codeshare not found');
    return;
  }

  if (session) {
    db.setSessionActiveCodeshare(session.sid, cs.id);
  }

  res.send(
    renderRoomPage({
      me: formatMeNode(user),
      codeshare: formatCodeshareNode(cs, user.id),
      apiHeaders
    })
  );
});

const server = http.createServer(app);
const wss = new WebSocketServer({
  noServer: true,
  handleProtocols: (protocols) => {
    if (protocols.has('codeshare-graphql-ws')) return 'codeshare-graphql-ws';
    return Array.from(protocols)[0] || false;
  }
});

attachWebSocketHandler(wss);

server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/-/api/graphql') || req.url.startsWith('/api/graphql')) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[Codeshare v3.40.0] Server running at http://localhost:${PORT}`);
  });
}

module.exports = { app, server };

