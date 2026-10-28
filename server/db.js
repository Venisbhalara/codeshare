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
  DEFAULT_THEME
} = require('../shared/catalog');

const DATA_DIR =
  process.env.DATA_DIR ||
  (process.env.VERCEL ? path.join(os.tmpdir(), 'codeshare-data') : path.join(__dirname, '..', 'data'));
const DB_FILE = path.join(DATA_DIR, 'store.json');

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000; // 900,000 ms (9e5)
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const FREE_SAVED_LIMIT = 20;

function randomShortId(len = 6) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) {
    out += BASE62[bytes[i] % 62];
  }
  return out;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, key] = stored.split(':');
  const hashBuffer = crypto.scryptSync(String(password), salt, 64);
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
    this.load();
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
      this.saveSync();
    }, 150);
  }

  saveSync() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      fs.writeFileSync(DB_FILE, JSON.stringify(this.state, null, 2), 'utf8');
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

    // Seed a demo Pro/Admin account so the user can test login or /_/admin right away
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
        passwordHash: hashPassword('Password123!'),
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

  createSession(userId) {
    const sid = randomShortId(32);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    this.state.sessions[sid] = { sid, userId, expiresAt };
    this.scheduleSave();
    return this.state.sessions[sid];
  }

  getSession(sid) {
    if (!sid) return null;
    const sess = this.state.sessions[sid];
    if (!sess) return null;
    if (new Date(sess.expiresAt).getTime() < Date.now()) {
      delete this.state.sessions[sid];
      this.scheduleSave();
      return null;
    }
    return sess;
  }

  updateSessionUser(sid, newUserId) {
    if (this.state.sessions[sid]) {
      this.state.sessions[sid].userId = newUserId;
      this.scheduleSave();
    }
  }

  setSessionActiveCodeshare(sid, codeshareId) {
    if (sid && this.state.sessions[sid]) {
      this.state.sessions[sid].activeCodeshareId = codeshareId || null;
      this.scheduleSave();
    }
  }

  toUrlSlug(title, fallbackId) {
    return toUrlSlug(title, fallbackId);
  }

  deleteSession(sid) {
    if (sid && this.state.sessions[sid]) {
      delete this.state.sessions[sid];
      this.scheduleSave();
    }
  }

  registerUser({ currentAnonUser, name, email, password, settings }) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail || !normalizedEmail.includes('@')) {
      const err = new Error('Please enter a valid email address.');
      err.code = 'INVALID_EMAIL';
      err.status = 400;
      throw err;
    }
    if (!password || String(password).length < 6) {
      const err = new Error('Password must be at least 6 characters.');
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
    const mergedSettings = {
      theme:
        (settings && settings.theme) ||
        (currentAnonUser && currentAnonUser.settings && currentAnonUser.settings.theme) ||
        DEFAULT_THEME,
      keymap:
        (settings && settings.keymap) ||
        (currentAnonUser && currentAnonUser.settings && currentAnonUser.settings.keymap) ||
        DEFAULT_KEYMAP
    };

    const newUser = {
      id: newId,
      anonymous: false,
      name: String(name || normalizedEmail.split('@')[0]).trim(),
      email: normalizedEmail,
      passwordHash: hashPassword(password),
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
      Object.values(this.state.codeshares).forEach((cs) => {
        if (cs.createdByUserId === currentAnonUser.id) {
          cs.createdByUserId = newId;
          cs.saved = true;
          if (Array.isArray(cs.canEditUserIds)) {
            cs.canEditUserIds = cs.canEditUserIds.map((id) =>
              id === currentAnonUser.id ? newId : id
            );
          }
        }
        if (cs.modifiedByUserId === currentAnonUser.id) {
          cs.modifiedByUserId = newId;
        }
      });
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
      user.name = updates.name.trim();
    }
    if (typeof updates.email === 'string' && updates.email.trim()) {
      const normalized = updates.email.trim().toLowerCase();
      const conflict = this.getUserByEmail(normalized);
      if (conflict && conflict.id !== user.id) {
        const err = new Error('Email is already taken.');
        err.status = 409;
        throw err;
      }
      user.email = normalized;
    }
    if (typeof updates.password === 'string' && updates.password.length >= 6) {
      user.passwordHash = hashPassword(updates.password);
    }
    if (updates.settings) {
      user.settings = Object.assign({}, user.settings, updates.settings);
    }
    if (updates.defaultCodeshareSettings) {
      user.defaultCodeshareSettings = Object.assign(
        {},
        user.defaultCodeshareSettings,
        updates.defaultCodeshareSettings
      );
    }
    if (typeof updates.companyImage !== 'undefined') {
      user.companyImage = updates.companyImage || null;
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
      if (cs.createdByUserId === rawUserId) {
        this.deleteCodeshare(cs.id);
      }
    });
    // Delete user's subscription plans
    Object.keys(this.state.subscriptionPlans).forEach((planId) => {
      if (this.state.subscriptionPlans[planId].userId === rawUserId) {
        delete this.state.subscriptionPlans[planId];
      }
    });
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
  pruneExpiredCodeshares() {
    const now = Date.now();
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

  getCodeshareByShortId(shortIdOrSlug) {
    if (!shortIdOrSlug) return null;
    this.pruneExpiredCodeshares();
    if (this.state.codeshares[shortIdOrSlug]) {
      return this.state.codeshares[shortIdOrSlug];
    }
    const lower = String(shortIdOrSlug).toLowerCase();
    return (
      Object.values(this.state.codeshares).find(
        (cs) =>
          (cs.slug && cs.slug.toLowerCase() === lower) ||
          (cs.title && toUrlSlug(cs.title, cs.id).toLowerCase() === lower)
      ) || null
    );
  }

  getOrCreateCodeshareByShortId(shortId, creatorUser) {
    let cs = this.getCodeshareByShortId(shortId);
    if (!cs && /^[a-zA-Z0-9_-]{1,64}$/.test(shortId)) {
      const now = new Date().toISOString();
      const isAnon = !creatorUser || creatorUser.anonymous;
      const isPro = creatorUser && this.isProSubscriber(creatorUser.id);
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
        saved: !isAnon,
        codeCheckpoint: null,
        migratedAt: null,
        createdAt: now,
        updatedAt: now
      };
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

  updateCodeshare(shortId, rawUserId, input) {
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

    // Claiming/saving an anonymous codeshare on login/register
    if (input.save === true) {
      const creator = this.getUserByRawId(cs.createdByUserId);
      if (!creator || creator.anonymous) {
        cs.createdByUserId = rawUserId;
      }
      cs.saved = true;
    }

    if (typeof input.title === 'string') {
      cs.title = input.title.slice(0, 120);
      let candidateSlug = toUrlSlug(cs.title, cs.id);
      const conflict = Object.values(this.state.codeshares).find(
        (other) =>
          other.id !== cs.id &&
          (other.id.toLowerCase() === candidateSlug.toLowerCase() ||
            (other.slug && other.slug.toLowerCase() === candidateSlug.toLowerCase()))
      );
      if (conflict) {
        candidateSlug = `${candidateSlug}-${cs.id}`;
      }
      cs.slug = candidateSlug;
    }
    if (typeof input.modeName === 'string') {
      cs.modeName = input.modeName;
    }
    if (typeof input.tabSize !== 'undefined' && input.tabSize !== null) {
      cs.tabSize = String(input.tabSize);
    }
    if (typeof input.canEdit !== 'undefined') {
      if (input.canEdit && Array.isArray(input.canEdit.userIds)) {
        // Normalize any Relay IDs or raw IDs
        cs.canEditUserIds = input.canEdit.userIds.map((id) => {
          try {
            if (id.startsWith('VXNlcj') || id.startsWith('TWU6')) {
              const decoded = Buffer.from(id, 'base64').toString('utf8');
              return decoded.replace(/^(User|Me):/, '');
            }
          } catch (_) {}
          return id.replace(/^(User|Me):/, '');
        });
      } else {
        cs.canEditUserIds = null;
      }
    }
    if (input.codeCheckpoint && input.codeCheckpoint.codeHistoryId && input.codeCheckpoint.value) {
      cs.codeCheckpoint = {
        codeHistoryId: input.codeCheckpoint.codeHistoryId,
        value: input.codeCheckpoint.value
      };
    }

    cs.modifiedByUserId = rawUserId;
    cs.updatedAt = new Date().toISOString();
    this.scheduleSave();
    return cs;
  }

  deleteCodeshare(shortId) {
    if (!this.state.codeshares[shortId]) return false;
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
    if (!this.state.codeshareUsers[shortId]) {
      this.state.codeshareUsers[shortId] = {};
    }
    const roomUsers = this.state.codeshareUsers[shortId];
    const now = new Date().toISOString();
    let record = roomUsers[rawUserId];
    const assignedColor = color || (record && record.color) || colorForUser(rawUserId);

    if (!record) {
      record = {
        id: `${shortId}:${rawUserId}`,
        codeshareId: shortId,
        createdByUserId: rawUserId,
        color: assignedColor,
        cursor: cursor || { position: -1, selectionEnd: -1 },
        createdAt: now,
        modifiedAt: now
      };
      roomUsers[rawUserId] = record;
    } else {
      if (color) record.color = color;
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
    const token = randomShortId(24);
    if (user) {
      this.state.passwordResets[token] = {
        token,
        userId: user.id,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        used: false
      };
      this.scheduleSave();
    }
    return token;
  }

  usePasswordReset(token, newPassword) {
    const reset = this.state.passwordResets[token];
    if (!reset || reset.used || new Date(reset.expiresAt).getTime() < Date.now()) {
      const err = new Error('Invalid or expired password reset token.');
      err.status = 400;
      throw err;
    }
    const user = this.updateUser(reset.userId, { password: newPassword });
    reset.used = true;
    this.scheduleSave();
    return user;
  }
}

module.exports = new Database();

