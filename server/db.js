const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  TextOperation,
  encodeHistoryIndex,
  decodeHistoryId,
  encodeRelayId,
  decodeRelayId,
  encodeRelayConnId
} = require('../shared/ot');
const {
  DEFAULT_KEYMAP,
  DEFAULT_MODE_NAME,
  DEFAULT_TAB_SIZE,
  DEFAULT_THEME,
  THEMES,
  KEYMAPS,
  MODES,
  TAB_SIZES,
  inferModeNameFromFilename,
  defaultFilenameForMode
} = require('../shared/catalog');

const DATA_DIR =
  process.env.DATA_DIR ||
  (process.env.VERCEL ? path.join(os.tmpdir(), 'codeshare-data') : path.join(__dirname, '..', 'data'));
const DB_FILE = path.join(DATA_DIR, 'store.json');
const SECRETS_FILE = path.join(DATA_DIR, 'secrets.json');

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000; // 900,000 ms (9e5)
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const FREE_SAVED_LIMIT = 20;
const MAX_PASSWORD_LENGTH = 128;
const MAX_FILE_CONTENT_BYTES = 256 * 1024;

const VALID_THEMES = new Set(Array.isArray(THEMES) ? THEMES : [DEFAULT_THEME]);
const VALID_KEYMAPS = new Set(Array.isArray(KEYMAPS) ? KEYMAPS : [DEFAULT_KEYMAP]);
const VALID_MODES = new Set(
  Array.isArray(MODES) ? MODES.map((m) => m.name) : [DEFAULT_MODE_NAME]
);
const VALID_TAB_SIZES = new Set(
  Array.isArray(TAB_SIZES) ? TAB_SIZES.map(String) : [String(DEFAULT_TAB_SIZE)]
);

function loadOrCreateRuntimeSecrets() {
  let persisted = {};
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(SECRETS_FILE)) {
      persisted = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8')) || {};
    }
  } catch (_) {
    persisted = {};
  }

  let updated = false;
  const resolveSecret = (key) => {
    const fromEnv = process.env[key];
    if (typeof fromEnv === 'string' && fromEnv.trim().length >= 16) {
      return fromEnv.trim();
    }
    if (typeof persisted[key] === 'string' && persisted[key].length >= 32) {
      return persisted[key];
    }
    persisted[key] = crypto.randomBytes(32).toString('hex');
    updated = true;
    return persisted[key];
  };

  const secrets = {
    COOKIE_SECRET: resolveSecret('COOKIE_SECRET'),
    JWT_SECRET: resolveSecret('JWT_SECRET'),
    FILE_OWNER_SECRET: resolveSecret('FILE_OWNER_SECRET')
  };

  if (updated) {
    try {
      fs.writeFileSync(SECRETS_FILE, JSON.stringify(persisted, null, 2), {
        encoding: 'utf8',
        mode: 0o600
      });
    } catch (_) {}
  }

  return secrets;
}

const RUNTIME_SECRETS = loadOrCreateRuntimeSecrets();
const FILE_OWNER_SECRET = RUNTIME_SECRETS.FILE_OWNER_SECRET;

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw || '')).digest('hex');
}

function sanitizeCompanyImageUrl(rawUrl) {
  if (rawUrl === null || typeof rawUrl === 'undefined' || String(rawUrl).trim() === '') {
    return null;
  }
  const str = String(rawUrl).trim();
  if (str.length > 512) {
    const err = new Error('Company logo URL is too long.');
    err.code = 'INVALID_COMPANY_IMAGE';
    err.status = 400;
    throw err;
  }
  let parsed;
  try {
    parsed = new URL(str);
  } catch (_) {
    const err = new Error('Company logo must be an absolute https:// URL.');
    err.code = 'INVALID_COMPANY_IMAGE';
    err.status = 400;
    throw err;
  }
  const isLocalDev =
    process.env.NODE_ENV !== 'production' &&
    parsed.protocol === 'http:' &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
  if (parsed.protocol !== 'https:' && !isLocalDev) {
    const err = new Error('Company logo must use https://.');
    err.code = 'INVALID_COMPANY_IMAGE';
    err.status = 400;
    throw err;
  }
  return parsed.toString();
}

function randomShortId(len = 6) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) {
    out += BASE62[bytes[i] % 62];
  }
  return out;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const raw = String(password || '');
  if (raw.length > MAX_PASSWORD_LENGTH) {
    const err = new Error(`Password must not exceed ${MAX_PASSWORD_LENGTH} characters.`);
    err.code = 'INVALID_PASSWORD';
    err.status = 400;
    throw err;
  }
  const hash = crypto.scryptSync(raw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const raw = String(password || '');
  if (!raw || raw.length > MAX_PASSWORD_LENGTH) return false;
  const [salt, key] = stored.split(':');
  const hashBuffer = crypto.scryptSync(raw, salt, 64);
  const keyBuffer = Buffer.from(key, 'hex');
  if (hashBuffer.length !== keyBuffer.length) return false;
  return crypto.timingSafeEqual(hashBuffer, keyBuffer);
}

// Deterministic vivid collaborator cursor color from userId
const CURSOR_COLORS = [
  '#E06C75', '#61AFEF', '#98C379', '#E5C07B',
  '#C678DD', '#56B6C2', '#D19A66', '#FF6B9D',
  '#4ECDC4', '#A3BE8C', '#88C0D0', '#B48EAD'
];

function colorForUser(userId) {
  let hash = 0;
  const str = String(userId || '');
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return CURSOR_COLORS[hash % CURSOR_COLORS.length];
}

function toUrlSlug(title, fallbackId) {
  const cleaned = String(title || '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
  return cleaned || fallbackId;
}

class Database {
  constructor() {
    this.state = {
      users: {},             // rawUserId (e.g. "anon:uuid" or "uuid") -> User record
      sessions: {},          // sid (32-char) -> { sid, userId, expiresAt }
      codeshares: {},        // shortId (e.g. "G8WoB4") -> Codeshare record
      codeHistories: {},     // shortId -> Array of CodeHistory records ordered by index
      codeshareUsers: {},    // shortId -> { [userId]: CodeshareUser record }
      subscriptionPlans: {}, // planRecordId -> { id, userId, planId, isActive, createdAt }
      passwordResets: {}     // token -> { token, userId, expiresAt, used }
    };
    this._saveTimer = null;
    this._saveInFlight = false;
    this._lastPruneAt = 0;
    this.load();
  }

  getRuntimeSecret(key) {
    return RUNTIME_SECRETS[key] || null;
  }

  hashSessionId(sid) {
    return hashToken(sid);
  }

  load() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      if (fs.existsSync(DB_FILE)) {
        const raw = fs.readFileSync(DB_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        this.state = Object.assign(this.state, parsed);
      }
    } catch (err) {
      console.error('[DB] Failed to load store.json, starting fresh:', err.message);
    }
    this.seedDefaults();
  }

  scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.saveAsync();
    }, 150);
  }

  async saveAsync() {
    if (this._saveInFlight) {
      this.scheduleSave();
      return;
    }
    this._saveInFlight = true;
    try {
      if (!fs.existsSync(DATA_DIR)) {
        await fs.promises.mkdir(DATA_DIR, { recursive: true });
      }
      const tmpFile = `${DB_FILE}.tmp.${process.pid}.${Date.now()}`;
      const serialized = JSON.stringify(this.state, null, 2);
      await fs.promises.writeFile(tmpFile, serialized, 'utf8');
      await fs.promises.rename(tmpFile, DB_FILE);
    } catch (err) {
      console.error('[DB] Failed to write store.json asynchronously:', err.message);
    } finally {
      this._saveInFlight = false;
    }
  }

  saveSync() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      const tmpFile = `${DB_FILE}.tmp.${process.pid}`;
      fs.writeFileSync(tmpFile, JSON.stringify(this.state, null, 2), 'utf8');
      fs.renameSync(tmpFile, DB_FILE);
    } catch (err) {
      console.error('[DB] Failed to write store.json:', err.message);
    }
  }

  seedDefaults() {
    // Ensure existing users using legacy 'monokai' default switch to the new non-black DEFAULT_THEME
    Object.values(this.state.users).forEach((u) => {
      if (u && u.settings && u.settings.theme === 'monokai') {
        u.settings.theme = DEFAULT_THEME;
      }
    });
    Object.values(this.state.codeshares).forEach((cs) => {
      if (cs && !cs.slug) {
        cs.slug = toUrlSlug(cs.title, cs.id);
      }
    });

    // Migrate any legacy plaintext session keys in store.json to SHA-256 hashes at rest
    if (this.state.sessions && typeof this.state.sessions === 'object') {
      const migratedSessions = {};
      for (const [key, sess] of Object.entries(this.state.sessions)) {
        if (!sess || !sess.userId || !sess.expiresAt) continue;
        const isSha256Hex = /^[0-9a-f]{64}$/.test(key);
        const sidHash = isSha256Hex ? key : hashToken(sess.sid || key);
        migratedSessions[sidHash] = {
          sidHash,
          userId: sess.userId,
          expiresAt: sess.expiresAt,
          activeCodeshareId: sess.activeCodeshareId || null,
          previousAnonUserId: sess.previousAnonUserId || null
        };
      }
      this.state.sessions = migratedSessions;
    }

    // Seed a demo account
    const demoEmail = 'demo@codeshare.io';
    const existingDemo = Object.values(this.state.users).find(
      (u) => !u.anonymous && u.email && u.email.toLowerCase() === demoEmail
    );
    let demoUser = existingDemo;
    if (!demoUser) {
      const uid = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
      demoUser = {
        id: uid,
        anonymous: false,
        name: 'Alex Mercer',
        email: demoEmail,
        passwordHash:
          process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_LOGIN !== 'true'
            ? null
            : hashPassword(process.env.DEMO_USER_PASSWORD || 'Password123!'),
        settings: {
          theme: DEFAULT_THEME,
          keymap: DEFAULT_KEYMAP
        },
        defaultCodeshareSettings: {
          modeName: 'JavaScript',
          tabSize: '2'
        },
        companyImage: null,
        migratedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      this.state.users[uid] = demoUser;
    } else if (
      process.env.NODE_ENV === 'production' &&
      process.env.ALLOW_DEMO_LOGIN !== 'true'
    ) {
      demoUser.passwordHash = null;
    }

    // Seed a sample collaborative room "G8WoB4" if not present
    if (!this.state.codeshares['G8WoB4']) {
      const now = new Date().toISOString();
      const initialCode = [
        '// Welcome to CodeeFlow — Real-Time Collaborative Code Editor',
        '// Share this URL with anyone to pair program, interview, or debug live.',
        '',
        'async function streamFibonacci(limit = 10) {',
        '  let [prev, curr] = [0n, 1n];',
        '  const sequence = [];',
        '',
        '  for (let step = 0; step < limit; step++) {',
        '    sequence.push(prev.toString());',
        '    [prev, curr] = [curr, prev + curr];',
        '  }',
        '',
        '  return sequence;',
        '}',
        '',
        'streamFibonacci(12).then((values) => {',
        '  console.log("Fibonacci Series:", values.join(" -> "));',
        '});',
        ''
      ].join('\n');

      const op = new TextOperation().insert(initialCode);
      const historyNodeId = crypto.randomUUID();
      const historyRecord = {
        id: historyNodeId,
        codeshareId: 'G8WoB4',
        historyId: encodeHistoryIndex(0), // "A0"
        index: 0,
        value: JSON.stringify(op.toJSON()),
        createdByUserId: demoUser.id,
        clientId: 'seed-client',
        createdAt: now
      };

      this.state.codeHistories['G8WoB4'] = [historyRecord];
      this.state.codeshareUsers['G8WoB4'] = {};
      this.state.codeshares['G8WoB4'] = {
        id: 'G8WoB4',
        title: 'G8WoB4',
        modeName: 'JavaScript',
        tabSize: '2',
        createdByUserId: demoUser.id,
        modifiedByUserId: demoUser.id,
        canEditUserIds: null, // null = everyone can edit; [userId] = View-Only
        saved: true,
        codeCheckpoint: null,
        migratedAt: null,
        files: [
          {
            id: 'main',
            name: 'collaborate.js',
            modeName: 'JavaScript',
            content: '',
            updatedAt: now
          },
          {
            id: 'file-styles',
            name: 'styles.css',
            modeName: 'CSS',
            content: [
              '/* CodeeFlow Studio Variables */',
              ':root {',
              '  --studio-bg: #F6F3EC;',
              '  --studio-accent: #1B4332;',
              '  --studio-gold: #B85D3B;',
              '}',
              ''
            ].join('\n'),
            updatedAt: now
          },
          {
            id: 'file-notes',
            name: 'notes.md',
            modeName: 'Markdown',
            content: [
              '# Multi-File Collaborative Room',
              '',
              '- Switch between file tabs at the top of the editor',
              '- Double-click any tab name to rename it (syntax highlights auto-detect!)',
              '- Click **+ New File** to add more files to this room',
              ''
            ].join('\n'),
            updatedAt: now
          }
        ],
        createdAt: now,
        updatedAt: now
      };
      this.saveSync();
    } else if (
      this.state.codeHistories['G8WoB4'] &&
      this.state.codeHistories['G8WoB4'].length === 1 &&
      typeof this.state.codeHistories['G8WoB4'][0].value === 'string' &&
      (this.state.codeHistories['G8WoB4'][0].value.includes('Welcome to Codeshare') ||
        this.state.codeHistories['G8WoB4'][0].value.includes('Welcome to CodeFlow'))
    ) {
      this.state.codeHistories['G8WoB4'][0].value =
        this.state.codeHistories['G8WoB4'][0].value
          .replace('Welcome to Codeshare', 'Welcome to CodeeFlow')
          .replace('Welcome to CodeFlow', 'Welcome to CodeeFlow');
      this.saveSync();
    }

    Object.values(this.state.codeshares).forEach((cs) => {
      if (cs) {
        cs.slug = cs.id;
        if (cs.id === 'G8WoB4') {
          cs.title = 'G8WoB4';
        }
        this.ensureCodeshareFiles(cs);
      }
    });
    this.saveSync();
  }

  computeFileOwnerSignature(shortId, fileId, rawUserId) {
    return crypto
      .createHmac('sha256', FILE_OWNER_SECRET)
      .update(`${String(shortId || '')}:${String(fileId || '')}:${String(rawUserId || '')}`)
      .digest('hex')
      .slice(0, 24);
  }

  canUserRenameFile(codeshare, file, rawUserId, providedOwnerToken) {
    if (!codeshare || !file || !rawUserId) return false;
    if (!this.canUserEditCodeshare(codeshare, rawUserId)) return false;
    const creatorId = file.createdByUserId || codeshare.createdByUserId;
    if (!creatorId || creatorId !== rawUserId) return false;

    const expectedSig = this.computeFileOwnerSignature(codeshare.id, file.id, creatorId);
    const storedSig =
      file.ownerSignature || this.computeFileOwnerSignature(codeshare.id, file.id, creatorId);
    try {
      const expectedBuf = Buffer.from(expectedSig, 'utf8');
      const storedBuf = Buffer.from(storedSig, 'utf8');
      if (
        expectedBuf.length !== storedBuf.length ||
        !crypto.timingSafeEqual(expectedBuf, storedBuf)
      ) {
        return false;
      }
      if (typeof providedOwnerToken === 'string' && providedOwnerToken.length > 0) {
        const tokenBuf = Buffer.from(providedOwnerToken, 'utf8');
        if (
          tokenBuf.length !== expectedBuf.length ||
          !crypto.timingSafeEqual(tokenBuf, expectedBuf)
        ) {
          return false;
        }
      }
    } catch (_) {
      return false;
    }
    return true;
  }

  ensureCodeshareFiles(cs) {
    if (!cs) return [];
    const now = cs.updatedAt || cs.createdAt || new Date().toISOString();
    const defaultCreatorId = cs.createdByUserId || 'anon:system';
    if (cs.id === 'G8WoB4' && (!Array.isArray(cs.files) || cs.files.length < 2)) {
      cs.files = [
        {
          id: 'main',
          name: 'collaborate.js',
          modeName: cs.modeName || 'JavaScript',
          content: '',
          createdByUserId: defaultCreatorId,
          renameRev: 0,
          updatedAt: now
        },
        {
          id: 'file-styles',
          name: 'styles.css',
          modeName: 'CSS',
          content: [
            '/* CodeeFlow Studio Variables */',
            ':root {',
            '  --studio-bg: #F6F3EC;',
            '  --studio-accent: #1B4332;',
            '  --studio-gold: #B85D3B;',
            '}',
            ''
          ].join('\n'),
          createdByUserId: defaultCreatorId,
          renameRev: 0,
          updatedAt: now
        },
        {
          id: 'file-notes',
          name: 'notes.md',
          modeName: 'Markdown',
          content: [
            '# Multi-File Collaborative Room',
            '',
            '- Switch between file tabs at the top of the editor',
            '- Double-click any tab name to rename it (syntax highlights auto-detect!)',
            '- Click **+ New File** to add more files to this room',
            ''
          ].join('\n'),
          createdByUserId: defaultCreatorId,
          renameRev: 0,
          updatedAt: now
        }
      ];
    } else if (!Array.isArray(cs.files) || cs.files.length === 0) {
      const defMode = cs.modeName || DEFAULT_MODE_NAME;
      cs.files = [
        {
          id: 'main',
          name: defaultFilenameForMode(defMode),
          modeName: defMode,
          content: '',
          createdByUserId: defaultCreatorId,
          renameRev: 0,
          updatedAt: now
        }
      ];
    } else if (!cs.files.some((f) => f && f.id === 'main')) {
      const defMode = cs.modeName || DEFAULT_MODE_NAME;
      cs.files.unshift({
        id: 'main',
        name: defaultFilenameForMode(defMode),
        modeName: defMode,
        content: '',
        createdByUserId: defaultCreatorId,
        renameRev: 0,
        updatedAt: now
      });
    }

    cs.files.forEach((f) => {
      if (!f) return;
      if (!f.createdByUserId) {
        f.createdByUserId = defaultCreatorId;
      }
      if (typeof f.renameRev !== 'number' || isNaN(f.renameRev)) {
        f.renameRev = 0;
      }
      f.ownerSignature = this.computeFileOwnerSignature(cs.id, f.id, f.createdByUserId);
    });
    return cs.files;
  }

  // =========================================================================
  // Users & Sessions
  // =========================================================================
  createAnonymousUser() {
    const uuid = crypto.randomUUID();
    const rawId = `anon:${uuid}`;
    const now = new Date().toISOString();
    const user = {
      id: rawId,
      anonymous: true,
      name: null,
      email: null,
      passwordHash: null,
      settings: {
        theme: DEFAULT_THEME,
        keymap: DEFAULT_KEYMAP
      },
      defaultCodeshareSettings: {
        modeName: DEFAULT_MODE_NAME,
        tabSize: DEFAULT_TAB_SIZE
      },
      companyImage: null,
      migratedAt: null,
      createdAt: now,
      updatedAt: now
    };
    this.state.users[rawId] = user;
    this.scheduleSave();
    return user;
  }

  getUserByRawId(rawId) {
    if (!rawId) return null;
    return this.state.users[rawId] || null;
  }

  getUserByEmail(email) {
    if (!email) return null;
    const normalized = String(email).trim().toLowerCase();
    const lookupEmail =
      normalized === 'demo@codeeflow.io' || normalized === 'demo@codeflow.io'
        ? 'demo@codeshare.io'
        : normalized;
    return (
      Object.values(this.state.users).find(
        (u) =>
          !u.anonymous &&
          u.email &&
          (u.email.toLowerCase() === normalized || u.email.toLowerCase() === lookupEmail)
      ) || null
    );
  }

  isAdminUser(userOrRawId) {
    const user =
      typeof userOrRawId === 'string' ? this.getUserByRawId(userOrRawId) : userOrRawId;
    if (!user || user.anonymous) return false;
    if (user.isAdmin === true || user.role === 'admin') return true;
    const adminEmailsRaw = String(process.env.ADMIN_EMAILS || '').trim();
    if (adminEmailsRaw && user.email) {
      const allowed = adminEmailsRaw
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean);
      if (allowed.includes(user.email.toLowerCase())) {
        return true;
      }
    }
    return false;
  }

  transferAnonymousCodeshares(anonUserId, targetUserId) {
    if (!anonUserId || !targetUserId || anonUserId === targetUserId) return;
    const isPro = this.isProSubscriber(targetUserId) || this.isAdminUser(targetUserId);
    let savedCount = this.getSavedCodesharesForUser(targetUserId).length;
    Object.values(this.state.codeshares).forEach((cs) => {
      if (!cs) return;
      if (cs.createdByUserId === anonUserId) {
        cs.createdByUserId = targetUserId;
        if (isPro || savedCount < FREE_SAVED_LIMIT) {
          cs.saved = true;
          savedCount++;
        }
        if (Array.isArray(cs.canEditUserIds)) {
          cs.canEditUserIds = cs.canEditUserIds.map((id) =>
            id === anonUserId ? targetUserId : id
          );
        }
      }
      if (cs.modifiedByUserId === anonUserId) {
        cs.modifiedByUserId = targetUserId;
      }
      if (Array.isArray(cs.files)) {
        cs.files.forEach((f) => {
          if (f && f.createdByUserId === anonUserId) {
            f.createdByUserId = targetUserId;
            f.ownerSignature = this.computeFileOwnerSignature(cs.id, f.id, targetUserId);
          }
        });
      }
    });
  }

  createSession(userId) {
    const sid = randomShortId(32);
    const sidHash = hashToken(sid);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    this.state.sessions[sidHash] = {
      sidHash,
      userId,
      expiresAt,
      activeCodeshareId: null,
      previousAnonUserId: null
    };
    this.scheduleSave();
    return Object.assign({ sid }, this.state.sessions[sidHash]);
  }

  getSession(sid) {
    if (!sid) return null;
    const sidHash = hashToken(sid);
    const sess = this.state.sessions[sidHash] || this.state.sessions[sid];
    if (!sess) return null;
    if (new Date(sess.expiresAt).getTime() < Date.now()) {
      delete this.state.sessions[sidHash];
      delete this.state.sessions[sid];
      this.scheduleSave();
      return null;
    }
    return Object.assign({ sid }, sess);
  }

  updateSessionUser(sid, newUserId) {
    if (!sid) return;
    const sidHash = hashToken(sid);
    const sess = this.state.sessions[sidHash] || this.state.sessions[sid];
    if (sess) {
      const oldUserId = sess.userId;
      if (oldUserId && this.isUserAnon(oldUserId) && oldUserId !== newUserId) {
        sess.previousAnonUserId = oldUserId;
        this.transferAnonymousCodeshares(oldUserId, newUserId);
      }
      sess.userId = newUserId;
      this.scheduleSave();
    }
  }

  invalidateUserSessions(rawUserId, keepSid = null) {
    if (!rawUserId) return;
    const keepHash = keepSid ? hashToken(keepSid) : null;
    let changed = false;
    for (const [key, sess] of Object.entries(this.state.sessions)) {
      if (sess && sess.userId === rawUserId && key !== keepHash && key !== keepSid) {
        delete this.state.sessions[key];
        changed = true;
      }
    }
    if (changed) this.scheduleSave();
  }

  setSessionActiveCodeshare(sid, codeshareId) {
    if (!sid) return;
    const sidHash = hashToken(sid);
    const sess = this.state.sessions[sidHash] || this.state.sessions[sid];
    if (sess) {
      sess.activeCodeshareId = codeshareId || null;
      this.scheduleSave();
    }
  }

  toUrlSlug(title, fallbackId) {
    return toUrlSlug(title, fallbackId);
  }

  deleteSession(sid) {
    if (!sid) return;
    const sidHash = hashToken(sid);
    let changed = false;
    if (this.state.sessions[sidHash]) {
      delete this.state.sessions[sidHash];
      changed = true;
    }
    if (this.state.sessions[sid]) {
      delete this.state.sessions[sid];
      changed = true;
    }
    if (changed) {
      this.scheduleSave();
    }
  }

  sanitizeUserSettings(rawSettings, fallbackSettings = {}) {
    const baseTheme = VALID_THEMES.has(fallbackSettings.theme)
      ? fallbackSettings.theme
      : DEFAULT_THEME;
    const baseKeymap = VALID_KEYMAPS.has(fallbackSettings.keymap)
      ? fallbackSettings.keymap
      : DEFAULT_KEYMAP;
    if (!rawSettings || typeof rawSettings !== 'object') {
      return { theme: baseTheme, keymap: baseKeymap };
    }
    const candidateTheme =
      typeof rawSettings.theme === 'string' ? rawSettings.theme.trim() : baseTheme;
    const candidateKeymap =
      typeof rawSettings.keymap === 'string' ? rawSettings.keymap.trim() : baseKeymap;
    return {
      theme: VALID_THEMES.has(candidateTheme) ? candidateTheme : baseTheme,
      keymap: VALID_KEYMAPS.has(candidateKeymap) ? candidateKeymap : baseKeymap
    };
  }

  sanitizeDefaultCodeshareSettings(rawDefaults, fallbackDefaults = {}) {
    const baseMode = VALID_MODES.has(fallbackDefaults.modeName)
      ? fallbackDefaults.modeName
      : DEFAULT_MODE_NAME;
    const baseTab = VALID_TAB_SIZES.has(String(fallbackDefaults.tabSize))
      ? String(fallbackDefaults.tabSize)
      : String(DEFAULT_TAB_SIZE);
    if (!rawDefaults || typeof rawDefaults !== 'object') {
      return { modeName: baseMode, tabSize: baseTab };
    }
    const candidateMode =
      typeof rawDefaults.modeName === 'string' ? rawDefaults.modeName.trim() : baseMode;
    const candidateTab =
      typeof rawDefaults.tabSize !== 'undefined' && rawDefaults.tabSize !== null
        ? String(rawDefaults.tabSize).trim()
        : baseTab;
    return {
      modeName: VALID_MODES.has(candidateMode) ? candidateMode : baseMode,
      tabSize: VALID_TAB_SIZES.has(candidateTab) ? candidateTab : baseTab
    };
  }

  registerUser({ currentAnonUser, name, email, password, settings }) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (
      !normalizedEmail ||
      normalizedEmail.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)
    ) {
      const err = new Error('Please enter a valid email address.');
      err.code = 'INVALID_EMAIL';
      err.status = 400;
      throw err;
    }
    const rawPass = String(password || '');
    if (rawPass.length < 6 || rawPass.length > MAX_PASSWORD_LENGTH) {
      const err = new Error(
        `Password must be between 6 and ${MAX_PASSWORD_LENGTH} characters.`
      );
      err.code = 'INVALID_PASSWORD';
      err.status = 400;
      throw err;
    }
    if (this.getUserByEmail(normalizedEmail)) {
      const err = new Error('An account with that email already exists.');
      err.code = 'EMAIL_ALREADY_EXISTS';
      err.status = 409;
      throw err;
    }

    const newId = crypto.randomUUID();
    const now = new Date().toISOString();
    const mergedSettings = this.sanitizeUserSettings(
      settings,
      (currentAnonUser && currentAnonUser.settings) || {
        theme: DEFAULT_THEME,
        keymap: DEFAULT_KEYMAP
      }
    );

    const newUser = {
      id: newId,
      anonymous: false,
      name: String(name || normalizedEmail.split('@')[0])
        .trim()
        .slice(0, 120),
      email: normalizedEmail,
      passwordHash: hashPassword(rawPass),
      settings: mergedSettings,
      defaultCodeshareSettings: {
        modeName: DEFAULT_MODE_NAME,
        tabSize: DEFAULT_TAB_SIZE
      },
      companyImage: null,
      migratedAt: null,
      createdAt: now,
      updatedAt: now
    };

    this.state.users[newId] = newUser;

    // Transfer any codeshares created by the anonymous user to the newly registered user
    if (currentAnonUser && currentAnonUser.anonymous) {
      this.transferAnonymousCodeshares(currentAnonUser.id, newId);
    }

    this.scheduleSave();
    return newUser;
  }

  loginUser({ email, password }) {
    const user = this.getUserByEmail(email);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      const err = new Error('Invalid email or password.');
      err.code = 'INVALID_CREDENTIALS';
      err.status = 401;
      throw err;
    }
    return user;
  }

  updateUser(rawUserId, updates) {
    const user = this.getUserByRawId(rawUserId);
    if (!user) {
      throw new Error('User not found');
    }
    if (typeof updates.name === 'string' && updates.name.trim()) {
      user.name = updates.name.trim().slice(0, 120);
    }
    if (typeof updates.email === 'string' && updates.email.trim()) {
      const normalized = updates.email.trim().toLowerCase();
      if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
        const err = new Error('Please enter a valid email address.');
        err.code = 'INVALID_EMAIL';
        err.status = 400;
        throw err;
      }
      const conflict = this.getUserByEmail(normalized);
      if (conflict && conflict.id !== user.id) {
        const err = new Error('Email is already taken.');
        err.status = 409;
        throw err;
      }
      user.email = normalized;
    }
    if (typeof updates.password === 'string' && updates.password.length > 0) {
      if (updates.password.length < 6 || updates.password.length > MAX_PASSWORD_LENGTH) {
        const err = new Error(
          `Password must be between 6 and ${MAX_PASSWORD_LENGTH} characters.`
        );
        err.code = 'INVALID_PASSWORD';
        err.status = 400;
        throw err;
      }
      user.passwordHash = hashPassword(updates.password);
    }
    if (updates.settings) {
      user.settings = this.sanitizeUserSettings(updates.settings, user.settings);
    }
    const isProOrAdmin = this.isProSubscriber(rawUserId) || this.isAdminUser(user);
    if (updates.defaultCodeshareSettings) {
      if (!isProOrAdmin) {
        const err = new Error(
          'Custom default CodeeFlow settings require an active Pro subscription.'
        );
        err.code = 'PRO_REQUIRED';
        err.status = 403;
        throw err;
      }
      user.defaultCodeshareSettings = this.sanitizeDefaultCodeshareSettings(
        updates.defaultCodeshareSettings,
        user.defaultCodeshareSettings
      );
    }
    if (typeof updates.companyImage !== 'undefined') {
      if (!isProOrAdmin && updates.companyImage) {
        const err = new Error('Custom company branding requires an active Pro subscription.');
        err.code = 'PRO_REQUIRED';
        err.status = 403;
        throw err;
      }
      user.companyImage = sanitizeCompanyImageUrl(updates.companyImage);
    }
    user.updatedAt = new Date().toISOString();
    this.scheduleSave();
    return user;
  }

  deleteUser(rawUserId) {
    const user = this.getUserByRawId(rawUserId);
    if (!user) return false;
    // Delete user's codeshares
    Object.values(this.state.codeshares).forEach((cs) => {
      if (cs.createdByUserId === rawUserId && cs.id !== 'G8WoB4') {
        this.deleteCodeshare(cs.id, rawUserId);
      }
    });
    // Delete user's subscription plans
    Object.keys(this.state.subscriptionPlans).forEach((planId) => {
      if (this.state.subscriptionPlans[planId].userId === rawUserId) {
        delete this.state.subscriptionPlans[planId];
      }
    });
    this.invalidateUserSessions(rawUserId);
    delete this.state.users[rawUserId];
    this.scheduleSave();
    return true;
  }

  // =========================================================================
  // Subscription Plans (Codeshare Pro)
  // =========================================================================
  getUserSubscriptionPlans(rawUserId) {
    return Object.values(this.state.subscriptionPlans).filter(
      (p) => p.userId === rawUserId
    );
  }

  isProSubscriber(rawUserId) {
    const plans = this.getUserSubscriptionPlans(rawUserId);
    return plans.some((p) => p.isActive && p.planId === 'pro');
  }

  hadPreviousProSubscription(rawUserId) {
    const plans = this.getUserSubscriptionPlans(rawUserId);
    return plans.length > 0 && !plans.some((p) => p.isActive);
  }

  createSubscriptionPlan({ userId, planId = 'pro', isActive = true, stripePaymentMethodId = null }) {
    const id = crypto.randomUUID();
    const plan = {
      id,
      userId,
      planId,
      isActive: Boolean(isActive),
      stripePaymentMethodId,
      createdAt: new Date().toISOString()
    };
    this.state.subscriptionPlans[id] = plan;
    this.scheduleSave();
    return plan;
  }

  updateSubscriptionPlan(rawPlanId, { isActive, planId }) {
    const plan = this.state.subscriptionPlans[rawPlanId];
    if (!plan) throw new Error('Subscription plan not found');
    if (typeof isActive === 'boolean') plan.isActive = isActive;
    if (typeof planId === 'string') plan.planId = planId;
    this.scheduleSave();
    return plan;
  }

  deleteSubscriptionPlan(rawPlanId) {
    if (this.state.subscriptionPlans[rawPlanId]) {
      delete this.state.subscriptionPlans[rawPlanId];
      this.scheduleSave();
      return true;
    }
    return false;
  }

  // =========================================================================
  // Codeshares & 24h Expiration Garbage Collection
  // =========================================================================
  pruneExpiredCodeshares(force = false) {
    const now = Date.now();
    if (!force && now - this._lastPruneAt < 30000) {
      return;
    }
    this._lastPruneAt = now;
    let changed = false;

    for (const [shortId, cs] of Object.entries(this.state.codeshares)) {
      if (shortId === 'G8WoB4') continue; // keep demo room alive
      const creator = this.getUserByRawId(cs.createdByUserId);
      const isAnonUnsaved = (!creator || creator.anonymous) && !cs.saved;
      if (isAnonUnsaved) {
        const age = now - new Date(cs.createdAt).getTime();
        if (age > TWENTY_FOUR_HOURS_MS) {
          delete this.state.codeshares[shortId];
          delete this.state.codeHistories[shortId];
          delete this.state.codeshareUsers[shortId];
          changed = true;
        }
      }
    }

    // Prune expired sessions
    const activeUserIds = new Set();
    for (const [sidKey, sess] of Object.entries(this.state.sessions)) {
      if (!sess || !sess.expiresAt || new Date(sess.expiresAt).getTime() < now) {
        delete this.state.sessions[sidKey];
        changed = true;
      } else if (sess.userId) {
        activeUserIds.add(sess.userId);
      }
    }

    // Track anonymous users that still own active codeshares
    for (const cs of Object.values(this.state.codeshares)) {
      if (cs && cs.createdByUserId) {
        activeUserIds.add(cs.createdByUserId);
      }
    }

    // Prune orphaned anonymous users older than 24 hours
    for (const [uid, u] of Object.entries(this.state.users)) {
      if (u && u.anonymous && !activeUserIds.has(uid)) {
        const age = now - new Date(u.createdAt || 0).getTime();
        if (age > TWENTY_FOUR_HOURS_MS) {
          delete this.state.users[uid];
          changed = true;
        }
      }
    }

    // Prune expired or used password reset tokens
    for (const [tokenKey, reset] of Object.entries(this.state.passwordResets)) {
      if (!reset || reset.used || new Date(reset.expiresAt).getTime() < now) {
        delete this.state.passwordResets[tokenKey];
        changed = true;
      }
    }

    if (changed) this.scheduleSave();
  }

  getSavedCodesharesForUser(rawUserId) {
    this.pruneExpiredCodeshares();
    return Object.values(this.state.codeshares)
      .filter((cs) => cs.createdByUserId === rawUserId && (!this.isUserAnon(rawUserId) || cs.saved))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  isUserAnon(rawUserId) {
    const u = this.getUserByRawId(rawUserId);
    return !u || Boolean(u.anonymous);
  }

  createCodeshare(creatorUser) {
    this.pruneExpiredCodeshares();
    const isAnon = !creatorUser || creatorUser.anonymous;
    const isPro = creatorUser && this.isProSubscriber(creatorUser.id);

    // Enforce 20 saved codeshares limit for non-Pro authenticated users
    if (!isAnon && !isPro) {
      const existing = this.getSavedCodesharesForUser(creatorUser.id);
      if (existing.length >= FREE_SAVED_LIMIT) {
        const hadPro = this.hadPreviousProSubscription(creatorUser.id);
        const err = new Error(
          hadPro
            ? 'Renew Codeshare Pro to create more codeshares.'
            : 'Free plan limit of 20 saved codeshares reached.'
        );
        err.code = hadPro
          ? 'RENEW_PRO_CODESHARE_LIMIT_REACHED'
          : 'NON_PRO_CODESHARE_LIMIT_REACHED';
        err.status = 403;
        throw err;
      }
    }

    let shortId = randomShortId(6);
    while (this.state.codeshares[shortId]) {
      shortId = randomShortId(6);
    }

    const now = new Date().toISOString();
    const defaultSettings =
      isPro && creatorUser.defaultCodeshareSettings
        ? creatorUser.defaultCodeshareSettings
        : { modeName: DEFAULT_MODE_NAME, tabSize: DEFAULT_TAB_SIZE };

    const codeshare = {
      id: shortId,
      slug: shortId,
      title: shortId,
      modeName: defaultSettings.modeName || DEFAULT_MODE_NAME,
      tabSize: String(defaultSettings.tabSize || DEFAULT_TAB_SIZE),
      createdByUserId: creatorUser ? creatorUser.id : 'anon:system',
      modifiedByUserId: creatorUser ? creatorUser.id : 'anon:system',
      canEditUserIds: null,
      saved: !isAnon,
      codeCheckpoint: null,
      migratedAt: null,
      createdAt: now,
      updatedAt: now
    };

    this.state.codeshares[shortId] = codeshare;
    this.state.codeHistories[shortId] = [];
    this.state.codeshareUsers[shortId] = {};
    this.scheduleSave();
    return codeshare;
  }

  getCodeshareByShortId(shortId) {
    if (!shortId) return null;
    this.pruneExpiredCodeshares();
    return this.state.codeshares[shortId] || null;
  }

  getOrCreateCodeshareByShortId(shortId, creatorUser) {
    let cs = this.getCodeshareByShortId(shortId);
    if (!cs && /^[a-zA-Z0-9_-]{1,64}$/.test(shortId)) {
      const now = new Date().toISOString();
      const isAnon = !creatorUser || creatorUser.anonymous;
      const isPro = creatorUser && this.isProSubscriber(creatorUser.id);
      const canSaveUnderQuota =
        !isAnon &&
        (isPro || this.getSavedCodesharesForUser(creatorUser.id).length < FREE_SAVED_LIMIT);
      const defaultSettings =
        isPro && creatorUser.defaultCodeshareSettings
          ? creatorUser.defaultCodeshareSettings
          : { modeName: DEFAULT_MODE_NAME, tabSize: DEFAULT_TAB_SIZE };

      cs = {
        id: shortId,
        slug: shortId,
        title: shortId,
        modeName: defaultSettings.modeName || DEFAULT_MODE_NAME,
        tabSize: String(defaultSettings.tabSize || DEFAULT_TAB_SIZE),
        createdByUserId: creatorUser ? creatorUser.id : 'anon:system',
        modifiedByUserId: creatorUser ? creatorUser.id : 'anon:system',
        canEditUserIds: null,
        saved: canSaveUnderQuota,
        codeCheckpoint: null,
        migratedAt: null,
        createdAt: now,
        updatedAt: now
      };
      this.ensureCodeshareFiles(cs);
      this.state.codeshares[shortId] = cs;
      this.state.codeHistories[shortId] = [];
      this.state.codeshareUsers[shortId] = {};
      this.scheduleSave();
    }
    return cs;
  }

  canUserEditCodeshare(codeshare, rawUserId) {
    if (!codeshare) return false;
    if (codeshare.migratedAt) return false;
    if (!Array.isArray(codeshare.canEditUserIds)) return true;
    return codeshare.canEditUserIds.includes(rawUserId);
  }

  updateCodeshare(shortId, rawUserId, input, options = {}) {
    const cs = this.getCodeshareByShortId(shortId);
    if (!cs) {
      const err = new Error('Codeshare not found');
      err.status = 404;
      throw err;
    }
    if (cs.migratedAt) {
      const err = new Error('This codeshare has moved');
      err.code = 'MIGRATED';
      err.status = 410;
      throw err;
    }

    // Only the room creator (or admin) can modify canEdit permissions
    if (typeof input.canEdit !== 'undefined') {
      if (cs.createdByUserId !== rawUserId && !this.isAdminUser(rawUserId)) {
        const err = new Error('Only the room creator can modify edit permissions.');
        err.code = 'FORBIDDEN';
        err.status = 403;
        throw err;
      }
      if (input.canEdit && Array.isArray(input.canEdit.userIds)) {
        if (!this.isProSubscriber(rawUserId) && !this.isAdminUser(rawUserId)) {
          const err = new Error(
            'View-only room permissions require an active CodeeFlow Pro subscription.'
          );
          err.code = 'PRO_REQUIRED';
          err.status = 403;
          throw err;
        }
        const normalizedIds = input.canEdit.userIds
          .filter((id) => typeof id === 'string')
          .map((id) => {
            try {
              if (id.startsWith('VXNlcj') || id.startsWith('TWU6')) {
                const decoded = Buffer.from(id, 'base64').toString('utf8');
                return decoded.replace(/^(User|Me):/, '');
              }
            } catch (_) {}
            return id.replace(/^(User|Me):/, '');
          });
        if (cs.createdByUserId && !normalizedIds.includes(cs.createdByUserId)) {
          normalizedIds.push(cs.createdByUserId);
        }
        cs.canEditUserIds = Array.from(new Set(normalizedIds));
      } else {
        cs.canEditUserIds = null;
      }
    }

    // Enforce top-level edit permission check for all room modifications
    if (!this.canUserEditCodeshare(cs, rawUserId)) {
      const err = new Error('You do not have permission to edit this codeshare.');
      err.code = 'FORBIDDEN';
      err.status = 403;
      throw err;
    }

    // Claiming/saving an anonymous codeshare on login/register:
    // Only permitted if the caller already owns the room OR their current session was the anonymous creator
    if (input.save === true) {
      const oldCreatorId = cs.createdByUserId;
      const previousAnonId =
        options && options.session ? options.session.previousAnonUserId : null;
      const isAuthorizedClaim =
        oldCreatorId === rawUserId ||
        (previousAnonId && oldCreatorId === previousAnonId);
      if (!isAuthorizedClaim) {
        const err = new Error('Only the room creator can claim or save this codeshare.');
        err.code = 'FORBIDDEN';
        err.status = 403;
        throw err;
      }
      const isAnon = this.isUserAnon(rawUserId);
      const isPro = this.isProSubscriber(rawUserId) || this.isAdminUser(rawUserId);
      if (
        !isAnon &&
        !isPro &&
        !cs.saved &&
        this.getSavedCodesharesForUser(rawUserId).length >= FREE_SAVED_LIMIT
      ) {
        const err = new Error('Free plan limit of 20 saved codeshares reached.');
        err.code = 'NON_PRO_CODESHARE_LIMIT_REACHED';
        err.status = 403;
        throw err;
      }
      cs.createdByUserId = rawUserId;
      if (Array.isArray(cs.files)) {
        cs.files.forEach((f) => {
          if (f && (!f.createdByUserId || f.createdByUserId === oldCreatorId)) {
            f.createdByUserId = rawUserId;
            f.ownerSignature = this.computeFileOwnerSignature(cs.id, f.id, rawUserId);
          }
        });
      }
      cs.saved = true;
    }

    if (typeof input.title === 'string') {
      cs.title = input.title.slice(0, 120);
      cs.slug = cs.id;
    }
    if (typeof input.modeName === 'string' && VALID_MODES.has(input.modeName)) {
      cs.modeName = input.modeName;
      this.ensureCodeshareFiles(cs);
      const mainFile = cs.files.find((f) => f.id === 'main');
      if (mainFile) {
        mainFile.modeName = input.modeName;
      }
    }
    if (
      typeof input.tabSize !== 'undefined' &&
      input.tabSize !== null &&
      VALID_TAB_SIZES.has(String(input.tabSize))
    ) {
      cs.tabSize = String(input.tabSize);
    }
    if (input.fileAction && typeof input.fileAction === 'object') {
      this.ensureCodeshareFiles(cs);
      const action = input.fileAction;
      const nowIso = new Date().toISOString();
      const sanitizeFilename = (rawName, fallback) => {
        const cleaned = String(rawName || '')
          .trim()
          .replace(/[\\/:*?"<>|\r\n\t]+/g, '-')
          .slice(0, 48);
        return cleaned || fallback;
      };

      if (action.type === 'create') {
        if (cs.files.length < 24) {
          const newId =
            action.id && /^[a-zA-Z0-9_-]{2,32}$/.test(action.id)
              ? action.id
              : `file-${randomShortId(6)}`;
          if (!cs.files.some((f) => f.id === newId)) {
            let name = sanitizeFilename(action.name, `file-${cs.files.length + 1}.txt`);
            if (!name.includes('.')) {
              name = `${name}.txt`;
            }
            const modeName = inferModeNameFromFilename(
              name,
              action.modeName || DEFAULT_MODE_NAME
            );
            const content = String(action.content || '').slice(0, MAX_FILE_CONTENT_BYTES);
            cs.files.push({
              id: newId,
              name,
              modeName,
              content,
              createdByUserId: rawUserId,
              renameRev: 0,
              ownerSignature: this.computeFileOwnerSignature(cs.id, newId, rawUserId),
              updatedAt: nowIso,
              lastClientId: action.clientId || null
            });
          }
        }
      } else if (action.type === 'rename' && action.id) {
        const target = cs.files.find((f) => f.id === action.id);
        if (!target) {
          const err = new Error('File not found.');
          err.code = 'FILE_NOT_FOUND';
          err.status = 404;
          throw err;
        }
        // Strict creator-only rename check enforced via ownership & HMAC signature algorithm
        if (!this.canUserRenameFile(cs, target, rawUserId, action.ownerToken)) {
          const err = new Error('Only the user who created this file can rename it.');
          err.code = 'FILE_RENAME_FORBIDDEN';
          err.status = 403;
          throw err;
        }
        const currentRev = Number(target.renameRev) || 0;
        const incomingRev =
          typeof action.renameRev === 'number' && !isNaN(action.renameRev)
            ? action.renameRev
            : currentRev + 1;
        if (incomingRev >= currentRev) {
          let nextName = sanitizeFilename(action.name, target.name);
          if (!nextName.includes('.')) {
            nextName = `${nextName}.txt`;
          }
          const lowerTaken = new Set(
            cs.files
              .filter((f) => f.id !== target.id)
              .map((f) => String(f.name || '').toLowerCase())
          );
          if (lowerTaken.has(nextName.toLowerCase())) {
            const dot = nextName.lastIndexOf('.');
            const stem = dot > 0 ? nextName.slice(0, dot) : nextName;
            const ext = dot > 0 ? nextName.slice(dot) : '.txt';
            let suffix = 2;
            while (lowerTaken.has(`${stem}-${suffix}${ext}`.toLowerCase())) {
              suffix++;
            }
            nextName = `${stem}-${suffix}${ext}`;
          }
          target.name = nextName;
          target.modeName =
            typeof action.modeName === 'string' && action.modeName.trim()
              ? inferModeNameFromFilename(target.name, action.modeName.trim())
              : inferModeNameFromFilename(target.name, target.modeName);
          target.renameRev = Math.max(currentRev + 1, incomingRev);
          target.updatedAt = nowIso;
          target.lastClientId = action.clientId || null;
          if (target.id === 'main') {
            cs.modeName = target.modeName;
          }
        }
      } else if (action.type === 'update' && action.id) {
        const target = cs.files.find((f) => f.id === action.id);
        if (target && target.id !== 'main') {
          target.content = String(action.content ?? '').slice(0, MAX_FILE_CONTENT_BYTES);
          if (action.name && this.canUserRenameFile(cs, target, rawUserId, action.ownerToken)) {
            target.name = sanitizeFilename(action.name, target.name);
            target.modeName = inferModeNameFromFilename(target.name, target.modeName);
            target.renameRev = (Number(target.renameRev) || 0) + 1;
          }
          target.updatedAt = nowIso;
          target.lastClientId = action.clientId || null;
        }
      } else if (action.type === 'delete' && action.id) {
        const target = cs.files.find((f) => f.id === action.id);
        if (!target) {
          const err = new Error('File not found.');
          err.code = 'FILE_NOT_FOUND';
          err.status = 404;
          throw err;
        }
        if (
          !this.canUserRenameFile(cs, target, rawUserId, action.ownerToken) &&
          cs.createdByUserId !== rawUserId
        ) {
          const err = new Error('Only the file creator or room owner can delete this file.');
          err.code = 'FILE_DELETE_FORBIDDEN';
          err.status = 403;
          throw err;
        }
        if (action.id !== 'main' && cs.files.length > 1) {
          cs.files = cs.files.filter((f) => f.id !== action.id);
        }
      }
    }

    if (input.codeCheckpoint && input.codeCheckpoint.codeHistoryId && input.codeCheckpoint.value) {
      let rawHistoryNodeId = String(input.codeCheckpoint.codeHistoryId);
      try {
        rawHistoryNodeId = decodeRelayId('CodeHistory', rawHistoryNodeId);
      } catch (_) {}
      const list = this.getCodeHistories(shortId);
      const foundIdx = list.findIndex((item) => item.id === rawHistoryNodeId);
      if (foundIdx !== -1) {
        let composed = new TextOperation();
        for (let i = 0; i <= foundIdx; i++) {
          composed = composed.compose(TextOperation.fromJSON(list[i].value));
        }
        cs.codeCheckpoint = {
          codeHistoryId: encodeRelayId('CodeHistory', list[foundIdx].id),
          value: JSON.stringify(composed.toJSON())
        };
      }
    }

    cs.modifiedByUserId = rawUserId;
    cs.updatedAt = new Date().toISOString();
    this.scheduleSave();
    return cs;
  }

  deleteCodeshare(shortId, requesterRawUserId = null) {
    const cs = this.state.codeshares[shortId];
    if (!cs) return false;
    if (shortId === 'G8WoB4' && !this.isAdminUser(requesterRawUserId)) {
      const err = new Error('The default demo room cannot be deleted.');
      err.code = 'FORBIDDEN';
      err.status = 403;
      throw err;
    }
    if (
      !requesterRawUserId ||
      (cs.createdByUserId !== requesterRawUserId && !this.isAdminUser(requesterRawUserId))
    ) {
      const err = new Error('Only the room creator can delete this codeshare.');
      err.code = 'FORBIDDEN';
      err.status = 403;
      throw err;
    }
    delete this.state.codeshares[shortId];
    delete this.state.codeHistories[shortId];
    delete this.state.codeshareUsers[shortId];
    this.scheduleSave();
    return true;
  }

  // =========================================================================
  // Operational Transformation History & Checkpointing
  // =========================================================================
  getCodeHistories(shortId) {
    if (!this.state.codeHistories[shortId]) {
      this.state.codeHistories[shortId] = [];
    }
    return this.state.codeHistories[shortId];
  }

  createCodeHistory({ shortId, rawUserId, clientId, historyId, value }) {
    const cs = this.getCodeshareByShortId(shortId);
    if (!cs) {
      const err = new Error('Codeshare not found');
      err.status = 404;
      throw err;
    }
    if (cs.migratedAt) {
      const err = new Error('This codeshare has moved');
      err.code = 'MIGRATED';
      err.status = 410;
      throw err;
    }
    if (!this.canUserEditCodeshare(cs, rawUserId)) {
      const err = new Error('You do not have permission to edit this codeshare.');
      err.code = 'FORBIDDEN';
      err.status = 403;
      throw err;
    }

    const index = decodeHistoryId(historyId);
    const list = this.getCodeHistories(shortId);
    const expectedIndex = list.length;

    // Strict OT revision slot check: if index !== expectedIndex, another operation
    // already won this slot (collision) or the client is behind/ahead.
    if (index !== expectedIndex) {
      const err = new Error(
        `Revision collision at historyId ${historyId} (index ${index}, expected ${expectedIndex})`
      );
      err.code = 'HISTORY_ID_COLLISION';
      err.status = 409;
      throw err;
    }

    // Validate the TextOperation JSON syntax
    const parsedOp = TextOperation.fromJSON(value);
    const now = new Date().toISOString();
    const record = {
      id: crypto.randomUUID(),
      codeshareId: shortId,
      historyId,
      index,
      value: JSON.stringify(parsedOp.toJSON()),
      createdByUserId: rawUserId,
      clientId: clientId || null,
      createdAt: now
    };

    list.push(record);
    cs.modifiedByUserId = rawUserId;
    cs.updatedAt = now;

    // Server-side safety compaction backup every 100 operations if client hasn't checkpointed yet
    if (index > 0 && index % 100 === 0) {
      try {
        const composed = this.reconstructDocumentOperation(shortId);
        cs.codeCheckpoint = {
          codeHistoryId: encodeRelayId('CodeHistory', record.id),
          value: JSON.stringify(composed.toJSON())
        };
      } catch (_) {}
    }

    this.scheduleSave();
    return record;
  }

  reconstructDocumentOperation(shortId) {
    const cs = this.getCodeshareByShortId(shortId);
    const list = this.getCodeHistories(shortId);
    let doc = new TextOperation();
    let startIndex = 0;

    if (cs && cs.codeCheckpoint && cs.codeCheckpoint.codeHistoryId && cs.codeCheckpoint.value) {
      let rawHistoryNodeId = cs.codeCheckpoint.codeHistoryId;
      try {
        rawHistoryNodeId = decodeRelayId('CodeHistory', rawHistoryNodeId);
      } catch (_) {}
      const foundIdx = list.findIndex((item) => item.id === rawHistoryNodeId);
      if (foundIdx !== -1) {
        doc = doc.compose(TextOperation.fromJSON(cs.codeCheckpoint.value));
        startIndex = foundIdx + 1;
      }
    }

    for (let i = startIndex; i < list.length; i++) {
      doc = doc.compose(TextOperation.fromJSON(list[i].value));
    }
    return doc;
  }

  reconstructDocumentText(shortId) {
    try {
      const op = this.reconstructDocumentOperation(shortId);
      return op.apply('');
    } catch (_) {
      return '';
    }
  }

  // =========================================================================
  // Real-Time Cursors & Presence (CodeshareUser)
  // =========================================================================
  getActiveCodeshareUsers(shortId) {
    const roomUsers = this.state.codeshareUsers[shortId] || {};
    const now = Date.now();
    const active = [];
    for (const [uid, record] of Object.entries(roomUsers)) {
      if (now - new Date(record.modifiedAt).getTime() < FIFTEEN_MINUTES_MS) {
        active.push(record);
      } else {
        delete roomUsers[uid];
      }
    }
    return active;
  }

  upsertCodeshareUser({ shortId, rawUserId, cursor, color }) {
    const cs = this.getCodeshareByShortId(shortId);
    if (!cs) return null;
    if (!this.state.codeshareUsers[shortId]) {
      this.state.codeshareUsers[shortId] = {};
    }
    const roomUsers = this.state.codeshareUsers[shortId];
    const now = new Date().toISOString();
    let record = roomUsers[rawUserId];
    const safeColor =
      typeof color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(color.trim())
        ? color.trim()
        : null;
    const assignedColor = safeColor || (record && record.color) || colorForUser(rawUserId);

    if (!record) {
      record = {
        id: `${shortId}:${rawUserId}`,
        codeshareId: shortId,
        createdByUserId: rawUserId,
        color: assignedColor,
        cursor: cursor
          ? {
              position: typeof cursor.position === 'number' ? cursor.position : -1,
              selectionEnd: typeof cursor.selectionEnd === 'number' ? cursor.selectionEnd : -1
            }
          : { position: -1, selectionEnd: -1 },
        createdAt: now,
        modifiedAt: now
      };
      roomUsers[rawUserId] = record;
    } else {
      if (safeColor) record.color = safeColor;
      if (cursor) {
        record.cursor = {
          position: typeof cursor.position === 'number' ? cursor.position : -1,
          selectionEnd: typeof cursor.selectionEnd === 'number' ? cursor.selectionEnd : -1
        };
      }
      record.modifiedAt = now;
    }
    return record;
  }

  removeCodeshareUser(shortId, rawUserId) {
    if (!this.state.codeshareUsers[shortId]) return null;
    const record = this.state.codeshareUsers[shortId][rawUserId];
    if (!record) return null;
    delete this.state.codeshareUsers[shortId][rawUserId];
    return record;
  }

  // =========================================================================
  // Password Resets
  // =========================================================================
  createPasswordReset(email) {
    const user = this.getUserByEmail(email);
    const token = crypto.randomBytes(24).toString('hex');
    const tokenHash = hashToken(token);
    if (user) {
      this.state.passwordResets[tokenHash] = {
        tokenHash,
        userId: user.id,
        expiresAt: new Date(Date.now() + FIFTEEN_MINUTES_MS).toISOString(),
        used: false
      };
      this.scheduleSave();
    }
    return { token, userExists: Boolean(user) };
  }

  usePasswordReset(token, newPassword) {
    const rawToken = String(token || '').trim();
    const tokenHash = hashToken(rawToken);
    const reset = this.state.passwordResets[tokenHash];
    if (!reset || reset.used || new Date(reset.expiresAt).getTime() < Date.now()) {
      const err = new Error('Invalid or expired password reset token.');
      err.status = 400;
      throw err;
    }
    const user = this.updateUser(reset.userId, { password: newPassword });
    reset.used = true;
    this.invalidateUserSessions(reset.userId);
    this.scheduleSave();
    return user;
  }
}

module.exports = new Database();

