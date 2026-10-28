/**
 * Codeshare — Complete Client Application Bundle (v3.40.0)
 * Implements:
 * - Split HTTP/WebSocket GraphQL Client (`codeshare-graphql-ws` + `x-codeshare-auth-mutation`)
 * - WebSocket Reconnection & Rate-Limit State Machine (1000, 1008/1009 30s, 4008 90s)
 * - Firepad OT Client State Machine (Synchronized / AwaitingConfirm / AwaitingWithBuffer)
 * - Custom GraphQL FirebaseAdapter with Doubly-Linked Out-of-Order Buffer & 100-Op Checkpointing
 * - CodeMirror 5.53.2 Dynamic Mode/Theme/Keymap Loader + 3s Deferred Addons + Read-Only Cursor Trick
 * - Real-Time Multi-User Cursors, Selections & Presence (500ms Throttled Upserts)
 * - Modern Web Guidance compliance: <dialog closedby="any"> fallback, closeTopLayer(), :user-invalid syncAria, color-scheme toggle
 */
(function () {
  'use strict';

  const OT = window.CodeshareOT;
  const Catalog = window.CodeshareCatalog;
  const BOOTSTRAP = window.__CODESHARE_BOOTSTRAP__ || {};
  const CDN_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.53.2';

  // =========================================================================
  // 1. Modern Web Guidance Utilities (Dialog, Top-Layer Exit, Validation, Theme)
  // =========================================================================
  let supportsDisplayTransition;
  function canTransitionDisplay() {
    if (supportsDisplayTransition !== undefined) return supportsDisplayTransition;
    if (!window.CSS?.supports?.('transition-behavior', 'allow-discrete') || !document.body) {
      return false;
    }
    const probe = document.createElement('div');
    probe.style.cssText = 'transition: display 1s allow-discrete !important; display: block;';
    document.body.appendChild(probe);
    getComputedStyle(probe).display;
    probe.style.display = 'none';
    supportsDisplayTransition = getComputedStyle(probe).display === 'block';
    probe.remove();
    return supportsDisplayTransition;
  }

  function supportsTopLayerExit() {
    return window.CSS?.supports?.('overlay', 'auto') && canTransitionDisplay();
  }

  async function closeTopLayer(element) {
    if (!element || !element.open) return;
    if (!supportsTopLayerExit()) {
      element.setAttribute('data-closing', '');
      const animations = element.getAnimations ? element.getAnimations({ subtree: true }) : [];
      if (animations.length > 0) {
        await Promise.race([
          Promise.allSettled(animations.map((a) => a.finished)),
          new Promise((r) => setTimeout(r, 2000))
        ]);
      }
      if (!element.hasAttribute('data-closing')) return;
      element.removeAttribute('data-closing');
    }
    element.close();
  }

  function initModernDialogs() {
    document.querySelectorAll('dialog').forEach((dialog) => {
      // Fallback for browsers without native <dialog closedby="any"> support
      if (!('closedBy' in HTMLDialogElement.prototype)) {
        dialog.addEventListener('click', (event) => {
          if (event.target !== dialog) return;
          const rect = dialog.getBoundingClientRect();
          const isDialogContent =
            rect.top <= event.clientY &&
            event.clientY <= rect.top + rect.height &&
            rect.left <= event.clientX &&
            event.clientX <= rect.left + rect.width;
          if (isDialogContent) return;
          closeTopLayer(dialog);
        });
      }

      dialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        closeTopLayer(dialog);
      });

      dialog.querySelectorAll('[data-close-dialog]').forEach((btn) => {
        btn.addEventListener('click', () => closeTopLayer(dialog));
      });
    });
  }

  // Sync aria-invalid with CSS :user-invalid state (modern-web-guidance: validate-input-after-interaction)
  const syncAria = (el) => {
    if (!el || typeof el.matches !== 'function') return;
    try {
      el.setAttribute('aria-invalid', el.matches(':user-invalid') ? 'true' : 'false');
    } catch (_) {}
  };
  document.addEventListener('blur', (e) => syncAria(e.target), true);
  document.addEventListener('input', (e) => {
    if (e.target && e.target.hasAttribute && e.target.hasAttribute('aria-invalid')) {
      syncAria(e.target);
    }
  });

  // Two-state / Tri-state Color Scheme Toggle (modern-web-guidance: dark-mode-toggle)
  function initColorSchemeControls() {
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (!meta) return;

    window.addEventListener('storage', (e) => {
      if (e.key === 'color-scheme') {
        meta.content = e.newValue ?? 'light dark';
      }
    });

    document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const systemScheme = window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light';
        let stored = null;
        try {
          stored = localStorage.getItem('color-scheme');
        } catch (_) {}
        const currentRendered =
          stored === 'dark' || stored === 'light'
            ? stored
            : meta.content === 'dark' || meta.content === 'light'
            ? meta.content
            : systemScheme;
        const target = currentRendered === 'dark' ? 'light' : 'dark';

        if (target === systemScheme) {
          try {
            localStorage.removeItem('color-scheme');
          } catch (_) {}
          meta.content = 'light dark';
        } else {
          try {
            localStorage.setItem('color-scheme', target);
          } catch (_) {}
          meta.content = target;
        }
      });
    });

    document.querySelectorAll('[data-scheme-choice]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const choice = btn.getAttribute('data-scheme-choice');
        const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        const systemScheme = systemDark ? 'dark' : 'light';

        if (choice === 'system' || choice === systemScheme) {
          try {
            localStorage.removeItem('color-scheme');
          } catch (_) {}
          meta.content = 'light dark';
        } else {
          try {
            localStorage.setItem('color-scheme', choice);
          } catch (_) {}
          meta.content = choice;
        }
      });
    });
  }

  // Zero-Lag Lenis Smooth Scroll + scrollend Deferral (modern-web-guidance: defer-work-until-scroll-ends)
  let lenisInstance = null;
  function initLenisSmoothScroll() {
    if (typeof window.Lenis !== 'function') return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return;
    }
    // Inside the 100vh split-pane editor room, scrolling is handled natively inside CodeMirror & sidebar
    if (document.querySelector('.workspace-shell')) return;

    lenisInstance = new window.Lenis({
      autoRaf: true,
      lerp: 0.11,
      smoothWheel: true,
      syncTouch: false,
      wheelMultiplier: 1,
      prevent: (node) =>
        Boolean(
          node &&
            node.closest &&
            node.closest('.CodeMirror, .editor-sidebar, dialog, [data-lenis-prevent]')
        )
    });

    // Defer any post-scroll state/layout updates until scrollend fires
    const onScrollRest = () => {
      document.documentElement.removeAttribute('data-scrolling');
    };

    window.addEventListener(
      'scroll',
      () => {
        if (!document.documentElement.hasAttribute('data-scrolling')) {
          document.documentElement.setAttribute('data-scrolling', '');
        }
      },
      { passive: true }
    );

    if ('onscrollend' in window) {
      window.addEventListener('scrollend', onScrollRest, { passive: true });
    } else {
      let scrollEndTimer = null;
      window.addEventListener(
        'scroll',
        () => {
          clearTimeout(scrollEndTimer);
          scrollEndTimer = setTimeout(() => {
            window.dispatchEvent(new CustomEvent('scrollend'));
            onScrollRest();
          }, 100);
        },
        { passive: true }
      );
    }
  }

  // =========================================================================
  // 2. Toast Manager
  // =========================================================================
  function showToast(message, options = {}) {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      document.body.appendChild(container);
    }
    if (options.id) {
      const existing = document.getElementById(options.id);
      if (existing) {
        existing.querySelector('.toast-text').textContent = message;
        return existing;
      }
    }
    const toast = document.createElement('div');
    toast.className = 'toast-banner';
    if (options.id) toast.id = options.id;
    toast.innerHTML = `<span class="toast-text"></span>`;
    toast.querySelector('.toast-text').textContent = message;
    if (options.onClick) {
      toast.addEventListener('click', () => {
        options.onClick();
        toast.remove();
      });
    } else {
      toast.addEventListener('click', () => toast.remove());
    }
    container.appendChild(toast);
    if (options.duration) {
      setTimeout(() => {
        if (toast.parentNode) toast.remove();
      }, options.duration);
    }
    return toast;
  }

  function removeToast(id) {
    const el = document.getElementById(id);
    if (el) el.remove();
  }

  async function copyTextToClipboard(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (_) {}
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = String(text ?? '');
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      return true;
    } catch (_) {
      return false;
    }
  }

  // =========================================================================
  // 3. Split HTTP + WebSocket GraphQL Client (Module 51726 & 32216)
  // =========================================================================
  const AUTH_MUTATION_REGEX =
    /mutation\s+[^\s]+\s*\(\s*\$input\s*:\s*(DeleteMe|Login|Logout|Register|RegisterAnonymous|UsePasswordReset)Input!\s*\)/;

  class GraphQLTransportClient {
    constructor() {
      this.ws = null;
      this.nextOpId = 1;
      this.pendingOps = new Map();       // id -> { resolve, reject }
      this.activeSubs = new Map();       // id -> { operationName, query, variables, onNext }
      this.eventListeners = new Map();   // event -> Set<fn>
      this.retries = 0;
      this.wasDisconnected = false;
      this.reconnectBlockedUntil = 0;
      this.countdownTimer = null;
      this.connectWebSocket();
    }

    on(event, fn) {
      if (!this.eventListeners.has(event)) {
        this.eventListeners.set(event, new Set());
      }
      this.eventListeners.get(event).add(fn);
      return () => this.eventListeners.get(event).delete(fn);
    }

    emit(event, payload) {
      const listeners = this.eventListeners.get(event);
      if (listeners) {
        listeners.forEach((fn) => {
          try {
            fn(payload);
          } catch (err) {
            console.error('[WS Listener Error]', err);
          }
        });
      }
    }

    connectWebSocket() {
      if (Date.now() < this.reconnectBlockedUntil) return;
      const backendOrigin = String(
        BOOTSTRAP.backendUrl || window.CODESHARE_BACKEND_URL || ''
      ).replace(/\/+$/, '');
      let wsUrl;
      if (backendOrigin) {
        const wsOrigin = backendOrigin.replace(/^http/i, 'ws');
        wsUrl = `${wsOrigin}/-/api/graphql`;
      } else {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        wsUrl = `${proto}//${window.location.host}/-/api/graphql`;
      }

      try {
        this.ws = new WebSocket(wsUrl, 'codeshare-graphql-ws');
      } catch (err) {
        this.scheduleReconnect();
        return;
      }

      this.ws.onopen = () => {
        this.ws.send(
          JSON.stringify({
            type: 'connection_init',
            payload: BOOTSTRAP.apiHeaders || {}
          })
        );
      };

      this.ws.onmessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch (_) {
          return;
        }

        if (msg.type === 'connection_ack') {
          this.retries = 0;
          removeToast('ws-status-toast');
          // Resubscribe all active subscriptions
          for (const [subId, sub] of this.activeSubs.entries()) {
            this.ws.send(
              JSON.stringify({
                type: 'start',
                id: subId,
                payload: {
                  operationName: sub.operationName,
                  query: sub.query,
                  variables: sub.variables
                }
              })
            );
          }
          if (this.wasDisconnected) {
            this.wasDisconnected = false;
            this.emit('reconnected');
          } else {
            this.emit('connected');
          }
          return;
        }

        if (msg.type === 'data') {
          const id = String(msg.id);
          if (this.pendingOps.has(id)) {
            const pending = this.pendingOps.get(id);
            pending.result = msg.payload;
          }
          if (this.activeSubs.has(id)) {
            const sub = this.activeSubs.get(id);
            if (msg.payload && msg.payload.data) {
              sub.onNext(msg.payload.data);
            }
          }
          return;
        }

        if (msg.type === 'complete') {
          const id = String(msg.id);
          if (this.pendingOps.has(id)) {
            const pending = this.pendingOps.get(id);
            this.pendingOps.delete(id);
            if (pending.result && pending.result.errors && pending.result.errors.length) {
              const errObj = pending.result.errors[0];
              const err = new Error(errObj.message || 'GraphQL Error');
              err.code = errObj.code;
              err.status = errObj.status;
              pending.reject(err);
            } else {
              pending.resolve(pending.result ? pending.result.data : null);
            }
          }
          return;
        }
      };

      this.ws.onclose = (event) => {
        this.wasDisconnected = true;
        this.handleCloseCode(event.code);
      };
    }

    handleCloseCode(code) {
      // Exact WebSocket close code handling from Module 32216 (743-ad529d3aec5624646fd5.js)
      if (code === 1000 || code === 1001 || code === 4001) {
        showToast('Disconnected. Click here to refresh.', {
          id: 'ws-status-toast',
          onClick: () => window.location.reload()
        });
        return;
      }

      if (code === 1008 || code === 1009) {
        // 30-second rate limit due to payload size
        this.startRateLimitCountdown(
          30,
          'Rate limited due to too large data. Click here to refresh.'
        );
        return;
      }

      if (code === 4008) {
        // 90-second rate limit
        this.startRateLimitCountdown(90, 'Rate limited. Click here to refresh.');
        return;
      }

      showToast('Disconnected. Reconnecting...', {
        id: 'ws-status-toast',
        onClick: () => this.forceReconnect()
      });
      this.scheduleReconnect();
    }

    startRateLimitCountdown(seconds, finalMessage) {
      this.reconnectBlockedUntil = Date.now() + seconds * 1000;
      let remaining = seconds;
      if (this.countdownTimer) clearInterval(this.countdownTimer);
      const updateMsg = () => {
        if (remaining > 0) {
          showToast(`Rate limited. Please wait ${remaining}s before refreshing.`, {
            id: 'ws-status-toast'
          });
          remaining--;
        } else {
          clearInterval(this.countdownTimer);
          showToast(finalMessage, {
            id: 'ws-status-toast',
            onClick: () => window.location.reload()
          });
        }
      };
      updateMsg();
      this.countdownTimer = setInterval(updateMsg, 1000);
    }

    scheduleReconnect() {
      const delay = Math.min(
        30000,
        1000 * Math.pow(2, this.retries) + Math.floor(Math.random() * 2900 + 100)
      );
      this.retries++;
      setTimeout(() => this.connectWebSocket(), delay);
    }

    forceReconnect() {
      if (this.ws) {
        try {
          this.ws.onclose = null;
          this.ws.close();
        } catch (_) {}
      }
      this.wasDisconnected = true;
      this.connectWebSocket();
    }

    async request({ operationName, query, variables = {} }) {
      const isAuthMutation =
        AUTH_MUTATION_REGEX.test(query) ||
        ['LoginFormMutation', 'RegisterFormMutation', 'LogoutPage_logout_Mutation', 'DeleteAccountButton_deleteMe_Mutation'].includes(operationName);

      // Route auth mutations over HTTP POST with x-codeshare-auth-mutation: true
      // or fallback to HTTP POST if WebSocket is not currently open
      if (isAuthMutation || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
        const headers = {
          'Content-Type': 'application/json'
        };
        if (BOOTSTRAP.apiHeaders && BOOTSTRAP.apiHeaders.authorization) {
          headers['Authorization'] = BOOTSTRAP.apiHeaders.authorization;
        }
        if (isAuthMutation) {
          headers['x-codeshare-auth-mutation'] = 'true';
        }
        const backendOrigin = String(
          BOOTSTRAP.backendUrl || window.CODESHARE_BACKEND_URL || ''
        ).replace(/\/+$/, '');
        const graphqlUrl = backendOrigin ? `${backendOrigin}/-/api/graphql` : '/-/api/graphql';
        const resp = await fetch(graphqlUrl, {
          method: 'POST',
          headers,
          credentials: 'same-origin',
          body: JSON.stringify({ operationName, query, variables })
        });
        const json = await resp.json();
        if (isAuthMutation) {
          // Immediately reconnect WebSocket so it upgrades with the new session cookie
          this.forceReconnect();
        }
        if (json.errors && json.errors.length) {
          const errObj = json.errors[0];
          const err = new Error(errObj.message || 'GraphQL Error');
          err.code = errObj.code;
          err.status = errObj.status;
          throw err;
        }
        return json.data;
      }

      // Multiplex over persistent WebSocket
      const id = String(this.nextOpId++);
      return new Promise((resolve, reject) => {
        this.pendingOps.set(id, { resolve, reject, result: null });
        this.ws.send(
          JSON.stringify({
            type: 'start',
            id,
            payload: { operationName, query, variables }
          })
        );
      });
    }

    subscribe({ operationName, query, variables = {}, onNext }) {
      const id = String(this.nextOpId++);
      this.activeSubs.set(id, { operationName, query, variables, onNext });
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({
            type: 'start',
            id,
            payload: { operationName, query, variables }
          })
        );
      }
      return () => {
        this.activeSubs.delete(id);
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'stop', id }));
        }
      };
    }
  }

  const gqlClient = new GraphQLTransportClient();

  // =========================================================================
  // 4. Trailing Throttle Helper (500ms RxJS auditTime equivalent)
  // =========================================================================
  function createTrailingThrottle(fn, waitMs = 500) {
    let timer = null;
    let latestArgs = null;
    return function (...args) {
      latestArgs = args;
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          const toRun = latestArgs;
          latestArgs = null;
          fn(...toRun);
        }, waitMs);
      }
    };
  }

  // =========================================================================
  // 5. Collaborative Room Controller (`/[codeshareId]`)
  // =========================================================================
  function initCodeshareRoom() {
    const editorContainer = document.getElementById('editor-container');
    if (!editorContainer || !BOOTSTRAP.codeshare) return;

    let me = BOOTSTRAP.me;
    let codeshare = BOOTSTRAP.codeshare;
    const clientId = 'client-' + Math.random().toString(36).slice(2, 10);
    const initialPathSlug = decodeURIComponent(
      window.location.pathname.replace(/^\/+|\/+$/g, '')
    ).trim();

    function toUrlSlug(title, fallbackId) {
      if (!title || typeof title !== 'string') return fallbackId;
      const slug = title
        .trim()
        .replace(/[^a-zA-Z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
      return slug || fallbackId;
    }

    function syncBrowserUrlToSlug() {
      const targetId = codeshare.shortId;
      if (!targetId) return;
      codeshare.slug = targetId;
      const roomPath = '/' + encodeURIComponent(targetId);
      const slugPreview = document.getElementById('live-slug-preview');
      if (slugPreview && document.activeElement !== slugPreview) {
        slugPreview.textContent = targetId;
      }
      const shareInput = document.getElementById('share-url-input');
      if (shareInput && document.activeElement !== shareInput) {
        shareInput.value = window.location.origin + roomPath + window.location.hash;
      }
    }

    // Always use the default studio theme ('eclipse') and keymap ('sublime')
    if (me && me.settings) {
      me.settings.theme = 'eclipse';
      me.settings.keymap = 'sublime';
    }
    try {
      localStorage.removeItem('user:theme');
      localStorage.removeItem('user:keymap');
    } catch (_) {}

    // Dynamic CSS & Script Loader for CodeMirror Modes, Themes, Keymaps & Addons
    const loadedStyles = new Set();
    const loadedScripts = new Set();

    function ensureStylesheet(url) {
      if (loadedStyles.has(url) || document.querySelector(`link[href="${url}"]`)) {
        loadedStyles.add(url);
        return;
      }
      loadedStyles.add(url);
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = url;
      document.head.appendChild(link);
    }

    function ensureScript(url) {
      if (loadedScripts.has(url) || document.querySelector(`script[src="${url}"]`)) {
        loadedScripts.add(url);
        return Promise.resolve();
      }
      loadedScripts.add(url);
      return new Promise((resolve) => {
        const script = document.createElement('script');
        script.src = url;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => resolve();
        document.head.appendChild(script);
      });
    }

    // Apply initial theme & keymap assets
    function applyTheme(themeName) {
      const themeSlug = themeName.split(' ')[0];
      ensureStylesheet(`${CDN_BASE}/theme/${themeSlug}.min.css`);
      if (cm) cm.setOption('theme', themeName);
    }

    async function applyKeymap(keymapName) {
      await ensureScript(`${CDN_BASE}/keymap/${keymapName}.min.js`);
      if (cm) cm.setOption('keyMap', keymapName);
    }

    async function applyLanguageMode(modeName) {
      const entry = Catalog.MODES_BY_NAME[modeName] || Catalog.MODES_BY_NAME['Plain Text'];
      if (entry.mode && entry.mode !== 'null') {
        if (entry.mode === 'htmlmixed') {
          await Promise.all([
            ensureScript(`${CDN_BASE}/mode/xml/xml.min.js`),
            ensureScript(`${CDN_BASE}/mode/javascript/javascript.min.js`),
            ensureScript(`${CDN_BASE}/mode/css/css.min.js`)
          ]);
        } else if (entry.mode === 'jsx') {
          await Promise.all([
            ensureScript(`${CDN_BASE}/mode/xml/xml.min.js`),
            ensureScript(`${CDN_BASE}/mode/javascript/javascript.min.js`)
          ]);
        }
        await ensureScript(`${CDN_BASE}/mode/${entry.mode}/${entry.mode}.min.js`);
      }
      if (cm) {
        cm.setOption('mode', entry.mime);
      }
      const footerLang = document.getElementById('status-mode-label');
      if (footerLang) footerLang.textContent = entry.name;
    }

    // Initialize CodeMirror 5.53.2 Instance
    const isEditable = () => Boolean(codeshare.canEdit && codeshare.canEdit.me && !codeshare.migratedAt);

    const cm = window.CodeMirror(editorContainer, {
      value: '',
      lineNumbers: true,
      mode: (Catalog.MODES_BY_NAME[codeshare.modeName] || Catalog.MODES_BY_NAME['Plain Text']).mime,
      theme: (me && me.settings && me.settings.theme) || 'eclipse',
      keyMap: (me && me.settings && me.settings.keymap) || 'sublime',
      tabSize: Number(codeshare.tabSize || 2),
      indentUnit: Number(codeshare.tabSize || 2),
      indentWithTabs: false,
      readOnly: !isEditable(),
      cursorBlinkRate: isEditable() ? 530 : -1,
      cursorHeight: isEditable() ? 1 : 0,
      placeholder: ''
    });

    applyTheme((me && me.settings && me.settings.theme) || 'eclipse');
    applyKeymap((me && me.settings && me.settings.keymap) || 'sublime');
    applyLanguageMode(codeshare.modeName || 'Plain Text');
    syncBrowserUrlToSlug(
      initialPathSlug || codeshare.slug || toUrlSlug(codeshare.title, codeshare.shortId)
    );

    // Read-Only 3-Second Cursor Reveal Trick (`la = 3e3` in pages_[codeshareId])
    let readOnlyCursorTimeout = null;
    editorContainer.addEventListener('mousedown', () => {
      if (!isEditable()) {
        cm.setOption('cursorHeight', 1);
        if (readOnlyCursorTimeout) clearTimeout(readOnlyCursorTimeout);
        readOnlyCursorTimeout = setTimeout(() => {
          if (!isEditable()) cm.setOption('cursorHeight', 0);
        }, 3000);
      }
    });

    // 3-Second Deferred Addon Loading (`pa = 3e3` in pages_[codeshareId])
    setTimeout(async () => {
      await Promise.all([
        ensureStylesheet(`${CDN_BASE}/addon/dialog/dialog.min.css`),
        ensureScript(`${CDN_BASE}/addon/dialog/dialog.min.js`),
        ensureScript(`${CDN_BASE}/addon/comment/comment.min.js`),
        ensureScript(`${CDN_BASE}/addon/comment/continuecomment.min.js`),
        ensureScript(`${CDN_BASE}/addon/edit/closebrackets.min.js`),
        ensureScript(`${CDN_BASE}/addon/edit/closetag.min.js`),
        ensureScript(`${CDN_BASE}/addon/edit/matchbrackets.min.js`),
        ensureScript(`${CDN_BASE}/addon/edit/trailingspace.min.js`),
        ensureScript(`${CDN_BASE}/addon/mode/overlay.min.js`),
        ensureScript(`${CDN_BASE}/addon/search/searchcursor.min.js`),
        ensureScript(`${CDN_BASE}/addon/search/search.min.js`),
        ensureScript(`${CDN_BASE}/addon/search/match-highlighter.min.js`)
      ]);
      cm.setOption('autoCloseBrackets', true);
      cm.setOption('autoCloseTags', true);
      cm.setOption('matchBrackets', true);
      cm.setOption('highlightSelectionMatches', true);
      cm.setOption('continueComments', { continueLineComment: false });
    }, 3000);

    // =======================================================================
    // 6. Firepad OT Adapter + Out-of-Order Doubly-Linked Buffer (`Fn` + `Bn`)
    // =======================================================================
    const receivedHistory = new OT.OrderedHistoryBuffer();
    const sentTextOps = new Map(); // index -> TextOperation
    let inFlightOp = null;         // TextOperation currently awaiting ACK
    let inFlightIndex = null;
    let bufferedOp = null;         // TextOperation composed while awaiting ACK
    let suppressEditorChanges = false;
    let checkpointFailed = false;

    // =======================================================================
    // 6a. Multi-Tab / Multi-File Rooms (`CodeMirror.Doc` per file tab)
    // =======================================================================
    const mainDoc = cm.getDoc();
    let activeTabId = 'main';
    const tabDocs = new Map([['main', mainDoc]]);
    let roomFiles =
      Array.isArray(codeshare.files) && codeshare.files.length > 0
        ? codeshare.files.map((f) => Object.assign({}, f))
        : [
            {
              id: 'main',
              name:
                typeof Catalog.defaultFilenameForMode === 'function'
                  ? Catalog.defaultFilenameForMode(codeshare.modeName)
                  : 'index.js',
              modeName: codeshare.modeName || 'Plain Text',
              content: ''
            }
          ];

    function escapeTabText(str) {
      return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function getActiveFile() {
      return roomFiles.find((f) => f.id === activeTabId) || roomFiles[0];
    }

    function getOrCreateDocForFile(file) {
      if (!file || file.id === 'main') return mainDoc;
      if (tabDocs.has(file.id)) return tabDocs.get(file.id);
      const modeEntry =
        Catalog.MODES_BY_NAME[file.modeName] || Catalog.MODES_BY_NAME['Plain Text'];
      const doc = new window.CodeMirror.Doc(file.content || '', modeEntry.mime);
      tabDocs.set(file.id, doc);
      return doc;
    }

    // Pre-initialize CodeMirror.Doc instances for any secondary files
    roomFiles.forEach((f) => {
      if (f.id !== 'main') getOrCreateDocForFile(f);
    });

    function sendFileAction(fileAction) {
      return gqlClient
        .request({
          operationName: 'updateCodeshareFileActionMutation',
          query: `mutation updateCodeshareFileActionMutation($input: UpdateCodeshareInput!) {
            updateCodeshare(input: $input) {
              codeshare {
                id slug title modeName tabSize canEdit { me userIds }
                files { id name modeName content updatedAt lastClientId }
              }
            }
          }`,
          variables: {
            input: {
              id: codeshare.id,
              fileAction: Object.assign({ clientId }, fileAction)
            }
          }
        })
        .catch(() => {});
    }

    const throttledSendSecondaryFileUpdate = createTrailingThrottle((tabId, content) => {
      sendFileAction({
        type: 'update',
        id: tabId,
        content
      });
    }, 280);

    function renderFileTabs() {
      const listEl = document.getElementById('editor-tabs-list');
      const addBtn = document.getElementById('add-file-tab-btn');
      const editable = isEditable();
      if (addBtn) {
        addBtn.hidden = !editable;
      }
      if (!listEl) return;

      listEl.innerHTML = roomFiles
        .map((file) => {
          const isActive = file.id === activeTabId;
          const isMain = file.id === 'main';
          const ext = file.name.includes('.')
            ? file.name.split('.').pop().toLowerCase()
            : 'txt';
          return `<li class="editor-tab-item ${isActive ? 'active' : ''}" role="tab" aria-selected="${
            isActive ? 'true' : 'false'
          }" data-tab-id="${escapeTabText(file.id)}" data-tab-name="${escapeTabText(
            file.name
          )}" data-tab-mode="${escapeTabText(file.modeName || 'Plain Text')}">
            <button type="button" class="editor-tab-btn" data-select-tab="${escapeTabText(
              file.id
            )}" title="${escapeTabText(file.name)} (${escapeTabText(
            file.modeName || 'Plain Text'
          )}) — Double-click to rename">
              <span class="file-ext-dot" data-ext="${escapeTabText(ext)}"></span>
              <span class="editor-tab-name">${escapeTabText(file.name)}</span>
            </button>
            ${
              !isMain && editable
                ? `<button type="button" class="editor-tab-close" data-close-tab="${escapeTabText(
                    file.id
                  )}" title="Delete ${escapeTabText(file.name)}" aria-label="Delete ${escapeTabText(
                    file.name
                  )}">&times;</button>`
                : ''
            }
          </li>`;
        })
        .join('');
    }

    function switchToFileTab(tabId, { focusEditor = true } = {}) {
      const targetFile = roomFiles.find((f) => f.id === tabId) || roomFiles[0];
      if (!targetFile) return;
      activeTabId = targetFile.id;
      const targetDoc = getOrCreateDocForFile(targetFile);

      suppressEditorChanges = true;
      if (cm.getDoc() !== targetDoc) {
        cm.swapDoc(targetDoc);
      }
      suppressEditorChanges = false;

      const fileMode = targetFile.modeName || codeshare.modeName || 'Plain Text';
      const modeSelectEl = document.getElementById('codeshare-mode-select');
      if (modeSelectEl && modeSelectEl.value !== fileMode) {
        modeSelectEl.value = fileMode;
      }
      applyLanguageMode(fileMode);
      renderFileTabs();
      updatePlaceholderVisibility();
      updateStatusMetrics();
      if (activePermalinkRange) {
        renderPermalinkHighlight({ scrollIntoView: false });
      }
      if (focusEditor) {
        cm.focus();
      }
    }

    function startInlineTabRename(tabId, { isNewTab = false } = {}) {
      if (!isEditable()) return;
      const file = roomFiles.find((f) => f.id === tabId);
      if (!file) return;
      const listEl = document.getElementById('editor-tabs-list');
      if (!listEl) return;
      const tabItem = listEl.querySelector(`[data-tab-id="${CSS.escape(tabId)}"]`);
      if (!tabItem) return;
      const nameSpan = tabItem.querySelector('.editor-tab-name');
      if (!nameSpan) return;

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'editor-tab-rename-input';
      input.value = file.name;
      input.setAttribute('aria-label', 'File name');
      nameSpan.replaceWith(input);
      input.focus();

      const dotIdx = file.name.lastIndexOf('.');
      if (dotIdx > 0) {
        input.setSelectionRange(0, dotIdx);
      } else {
        input.select();
      }

      let finished = false;
      function commitRename(save) {
        if (finished) return;
        finished = true;
        const rawVal = input.value.trim();
        if (save && rawVal) {
          let sanitized = rawVal.replace(/[/\\:*?"<>|]/g, '-').slice(0, 64);
          if (!sanitized.includes('.')) {
            sanitized = `${sanitized}.txt`;
          }
          const inferredMode =
            typeof Catalog.inferModeNameFromFilename === 'function'
              ? Catalog.inferModeNameFromFilename(sanitized, 'Plain Text')
              : 'Plain Text';
          file.name = sanitized;
          file.modeName = inferredMode;
          if (file.id === 'main') {
            codeshare.modeName = inferredMode;
          }
          if (activeTabId === file.id) {
            const modeSelectEl = document.getElementById('codeshare-mode-select');
            if (modeSelectEl) modeSelectEl.value = inferredMode;
            applyLanguageMode(inferredMode);
          }
          sendFileAction({
            type: 'rename',
            id: file.id,
            name: file.name,
            modeName: file.modeName
          });
          if (isNewTab) {
            showToast(`Created ${file.name} (${file.modeName})`, { duration: 2200 });
          } else {
            showToast(`Renamed to ${file.name} (${file.modeName})`, { duration: 2200 });
          }
        }
        renderFileTabs();
        cm.focus();
      }

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commitRename(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          commitRename(false);
        }
      });
      input.addEventListener('blur', () => commitRename(true));
    }

    function createNewFileTab() {
      if (!isEditable()) return;
      const existingNames = new Set(roomFiles.map((f) => f.name.toLowerCase()));
      let fileNum = roomFiles.length + 1;
      let defaultName = `file-${fileNum}.txt`;
      while (existingNames.has(defaultName.toLowerCase())) {
        fileNum++;
        defaultName = `file-${fileNum}.txt`;
      }
      const modeName = 'Plain Text';
      const newTabId = `file-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const newFile = {
        id: newTabId,
        name: defaultName,
        modeName,
        content: ''
      };
      roomFiles.push(newFile);
      getOrCreateDocForFile(newFile);
      sendFileAction({
        type: 'create',
        id: newFile.id,
        name: newFile.name,
        modeName: newFile.modeName,
        content: newFile.content
      });
      switchToFileTab(newFile.id, { focusEditor: true });
      showToast(`Created ${newFile.name} (Plain Text)`, { duration: 2200 });
    }

    function deleteFileTab(tabId) {
      if (!isEditable() || tabId === 'main') return;
      const idx = roomFiles.findIndex((f) => f.id === tabId);
      if (idx === -1) return;
      const removed = roomFiles[idx];
      roomFiles.splice(idx, 1);
      tabDocs.delete(tabId);
      sendFileAction({
        type: 'delete',
        id: tabId
      });
      showToast(`Closed ${removed.name}`, { duration: 2000 });
      if (activeTabId === tabId) {
        const nextFile = roomFiles[Math.max(0, idx - 1)] || roomFiles[0];
        switchToFileTab(nextFile ? nextFile.id : 'main');
      } else {
        renderFileTabs();
      }
    }

    const tabsListEl = document.getElementById('editor-tabs-list');
    if (tabsListEl) {
      tabsListEl.addEventListener('click', (e) => {
        const closeBtn = e.target.closest('[data-close-tab]');
        if (closeBtn) {
          e.stopPropagation();
          deleteFileTab(closeBtn.getAttribute('data-close-tab'));
          return;
        }
        const selectBtn = e.target.closest('[data-select-tab]');
        if (selectBtn) {
          const tabId = selectBtn.getAttribute('data-select-tab');
          if (tabId && tabId !== activeTabId) {
            switchToFileTab(tabId);
          }
        }
      });

      tabsListEl.addEventListener('dblclick', (e) => {
        const selectBtn = e.target.closest('[data-select-tab]');
        if (selectBtn) {
          e.preventDefault();
          startInlineTabRename(selectBtn.getAttribute('data-select-tab'));
        }
      });
    }

    const addFileTabBtn = document.getElementById('add-file-tab-btn');
    if (addFileTabBtn) {
      addFileTabBtn.addEventListener('click', createNewFileTab);
    }

    renderFileTabs();

    // =======================================================================
    // 6b. Smart Line-Range Permalinks (#L10 or #L10-L22)
    // =======================================================================
    let activePermalinkRange = null; // { startLine: number, endLine: number } (1-based)
    let permalinkAnchorLine = null;  // 1-based anchor for Shift+Click range selection
    let highlightedLineHandles = []; // CodeMirror LineHandle[]

    function parsePermalinkHash(hashStr) {
      const raw = String(hashStr || '').trim();
      const match = /^#?L(\d+)(?:-L?(\d+))?$/i.exec(raw);
      if (!match) return null;
      const a = Math.max(1, parseInt(match[1], 10));
      const b = match[2] ? Math.max(1, parseInt(match[2], 10)) : a;
      return {
        startLine: Math.min(a, b),
        endLine: Math.max(a, b)
      };
    }

    function formatPermalinkHash(startLine, endLine) {
      const s = Math.max(1, Math.min(startLine, endLine));
      const e = Math.max(1, Math.max(startLine, endLine));
      return s === e ? `#L${s}` : `#L${s}-L${e}`;
    }

    function clearPermalinkDecorations() {
      cm.operation(() => {
        for (const handle of highlightedLineHandles) {
          cm.removeLineClass(handle, 'wrap', 'cm-permalink-line');
          cm.removeLineClass(handle, 'wrap', 'cm-permalink-line-start');
          cm.removeLineClass(handle, 'wrap', 'cm-permalink-line-end');
          cm.removeLineClass(handle, 'background', 'cm-permalink-line-bg');
          cm.removeLineClass(handle, 'gutter', 'cm-permalink-gutter');
        }
        highlightedLineHandles = [];
      });
    }

    function renderPermalinkHighlight({ scrollIntoView = false } = {}) {
      clearPermalinkDecorations();
      const bannerEl = document.getElementById('permalink-banner');
      const badgeEl = document.getElementById('permalink-range-badge');

      if (!activePermalinkRange) {
        if (bannerEl) bannerEl.hidden = true;
        return;
      }

      const lineCount = Math.max(1, cm.lineCount());
      const startLine = Math.min(lineCount, Math.max(1, activePermalinkRange.startLine));
      const endLine = Math.min(lineCount, Math.max(startLine, activePermalinkRange.endLine));
      const hashLabel = formatPermalinkHash(
        activePermalinkRange.startLine,
        activePermalinkRange.endLine
      );

      cm.operation(() => {
        for (let lineNum = startLine; lineNum <= endLine; lineNum++) {
          const lineIdx = lineNum - 1;
          const handle = cm.getLineHandle(lineIdx);
          if (!handle) continue;
          cm.addLineClass(handle, 'wrap', 'cm-permalink-line');
          cm.addLineClass(handle, 'background', 'cm-permalink-line-bg');
          cm.addLineClass(handle, 'gutter', 'cm-permalink-gutter');
          if (lineNum === startLine) {
            cm.addLineClass(handle, 'wrap', 'cm-permalink-line-start');
          }
          if (lineNum === endLine) {
            cm.addLineClass(handle, 'wrap', 'cm-permalink-line-end');
          }
          highlightedLineHandles.push(handle);
        }
      });

      if (badgeEl) badgeEl.textContent = hashLabel;
      if (bannerEl) bannerEl.hidden = false;

      if (scrollIntoView && cm.getValue().length > 0) {
        try {
          cm.scrollIntoView(
            {
              from: { line: startLine - 1, ch: 0 },
              to: { line: endLine - 1, ch: 0 }
            },
            120
          );
        } catch (_) {}
      }
    }

    function setPermalinkRange(
      startLine,
      endLine,
      { updateUrl = true, scrollIntoView = false } = {}
    ) {
      const s = Math.max(1, Math.min(startLine, endLine));
      const e = Math.max(1, Math.max(startLine, endLine));
      activePermalinkRange = { startLine: s, endLine: e };
      const hash = formatPermalinkHash(s, e);
      if (updateUrl && window.history && window.history.replaceState) {
        const nextUrl = window.location.pathname + window.location.search + hash;
        window.history.replaceState(null, '', nextUrl);
        const shareInput = document.getElementById('share-url-input');
        if (shareInput && document.activeElement !== shareInput) {
          shareInput.value = window.location.origin + nextUrl;
        }
      }
      renderPermalinkHighlight({ scrollIntoView });
    }

    function clearPermalink(updateUrl = true) {
      activePermalinkRange = null;
      permalinkAnchorLine = null;
      clearPermalinkDecorations();
      const bannerEl = document.getElementById('permalink-banner');
      if (bannerEl) bannerEl.hidden = true;
      if (updateUrl && window.location.hash && window.history && window.history.replaceState) {
        const cleanUrl = window.location.pathname + window.location.search;
        window.history.replaceState(null, '', cleanUrl);
        const shareInput = document.getElementById('share-url-input');
        if (shareInput && document.activeElement !== shareInput) {
          shareInput.value = window.location.origin + cleanUrl;
        }
      }
    }

    function getCurrentSelectionLineRange() {
      const doc = cm.getDoc();
      const sel = doc.listSelections && doc.listSelections()[0];
      if (!sel) {
        const pos = cm.getCursor();
        return { startLine: pos.line + 1, endLine: pos.line + 1 };
      }
      const fromLine = Math.min(sel.anchor.line, sel.head.line) + 1;
      let toLine = Math.max(sel.anchor.line, sel.head.line) + 1;
      const maxPos =
        sel.anchor.line > sel.head.line ||
        (sel.anchor.line === sel.head.line && sel.anchor.ch > sel.head.ch)
          ? sel.anchor
          : sel.head;
      if (toLine > fromLine && maxPos.ch === 0) {
        toLine -= 1;
      }
      return { startLine: fromLine, endLine: toLine };
    }

    function applyTextOperationToCodeMirror(op) {
      suppressEditorChanges = true;
      cm.operation(() => {
        const doc = mainDoc;
        let index = 0;
        for (let i = 0; i < op.ops.length; i++) {
          const comp = op.ops[i];
          if (OT.TextOperation.isRetain(comp)) {
            index += comp;
          } else if (OT.TextOperation.isInsert(comp)) {
            const pos = doc.posFromIndex(index);
            doc.replaceRange(comp, pos, pos, '+remote');
            index += comp.length;
          } else if (OT.TextOperation.isDelete(comp)) {
            const from = doc.posFromIndex(index);
            const to = doc.posFromIndex(index - comp);
            doc.replaceRange('', from, to, '+remote');
          }
        }
      });
      suppressEditorChanges = false;
      updateStatusMetrics();
      if (activePermalinkRange) {
        renderPermalinkHighlight({ scrollIntoView: false });
      }
    }

    function reconstructInitialDocument() {
      let composed = new OT.TextOperation();
      if (codeshare.codeCheckpoint && codeshare.codeCheckpoint.value) {
        receivedHistory.set(-1, codeshare.codeCheckpoint);
        composed = composed.compose(OT.TextOperation.fromJSON(codeshare.codeCheckpoint.value));
      }
      const edges = (codeshare.codeHistory && codeshare.codeHistory.edges) || [];
      for (const edge of edges) {
        const idx = OT.decodeHistoryId(edge.node.historyId);
        receivedHistory.set(idx, edge);
      }
      for (const [idx, edge] of receivedHistory.entries()) {
        if (idx !== -1) {
          composed = composed.compose(OT.TextOperation.fromJSON(edge.node.value));
        }
      }
      if (!composed.isNoop()) {
        applyTextOperationToCodeMirror(composed);
      }
      updatePlaceholderVisibility();
      updateRevisionBadge();

      const initialHashRange = parsePermalinkHash(window.location.hash);
      if (initialHashRange) {
        permalinkAnchorLine = initialHashRange.startLine;
        setPermalinkRange(initialHashRange.startLine, initialHashRange.endLine, {
          updateUrl: false,
          scrollIntoView: true
        });
      }
    }

    function updatePlaceholderVisibility() {
      const isEmpty =
        activeTabId === 'main'
          ? receivedHistory.size === 0 && cm.getValue().length === 0
          : cm.getValue().length === 0;
      cm.setOption(
        'placeholder',
        isEmpty
          ? 'Write or paste code here then share. Anyone you share with will see code as it is typed!'
          : ''
      );
    }

    function updateRevisionBadge() {
      const [lastHId, lastIdx] = receivedHistory.lastHistoryId();
      const revEl = document.getElementById('status-revision-label');
      if (revEl) {
        revEl.textContent = lastIdx >= 0 ? `Rev ${lastHId} (#${lastIdx + 1})` : 'Rev A0 (Empty)';
      }
    }

    function updateStatusMetrics() {
      const pos = cm.getCursor();
      const cursorEl = document.getElementById('status-cursor-label');
      if (cursorEl) {
        cursorEl.textContent = `Ln ${pos.line + 1}, Col ${pos.ch + 1}`;
      }
      const statusPermalinkLabel = document.getElementById('status-permalink-label');
      if (statusPermalinkLabel) {
        const { startLine, endLine } = getCurrentSelectionLineRange();
        statusPermalinkLabel.textContent = formatPermalinkHash(startLine, endLine);
      }
    }

    // Automatic Client-Driven Compaction Checkpoint Every 100 Revisions
    async function saveCompactionCheckpoint(codeHistoryNodeId, attempt = 0) {
      try {
        let composed = new OT.TextOperation();
        for (const [idx, edge] of receivedHistory.entries()) {
          const val = idx === -1 ? edge.value : edge.node.value;
          composed = composed.compose(OT.TextOperation.fromJSON(val));
        }
        await gqlClient.request({
          operationName: 'CodeshareFirepad_updateCodeshare_Mutation',
          query: `mutation CodeshareFirepad_updateCodeshare_Mutation($input: UpdateCodeshareInput!) {
            updateCodeshare(input: $input) { codeshare { id codeCheckpoint { codeHistoryId value } } }
          }`,
          variables: {
            input: {
              id: codeshare.id,
              codeCheckpoint: {
                codeHistoryId: codeHistoryNodeId,
                value: JSON.stringify(composed.toJSON())
              }
            }
          }
        });
        checkpointFailed = false;
      } catch (err) {
        checkpointFailed = true;
        if (attempt < 4) {
          setTimeout(
            () => saveCompactionCheckpoint(codeHistoryNodeId, attempt + 1),
            1000 * Math.pow(2, attempt)
          );
        }
      }
    }

    async function sendInFlightOperation() {
      if (!inFlightOp) return;
      const [historyId, index] = receivedHistory.nextHistoryId();
      inFlightIndex = index;
      sentTextOps.set(index, inFlightOp);

      try {
        await gqlClient.request({
          operationName: 'CodeshareFirepad_createCodeHistory_Mutation',
          query: `mutation CodeshareFirepad_createCodeHistory_Mutation($input: CreateCodeHistoryInput!) {
            createCodeHistory(input: $input) {
              newCodeHistoryEdge { node { id historyId value createdAt createdBy { me userId clientId } } cursor }
            }
          }`,
          variables: {
            input: {
              codeshareId: codeshare.id,
              historyId,
              value: JSON.stringify(inFlightOp.toJSON()),
              clientId
            }
          }
        });
      } catch (err) {
        if (err.code === 'MIGRATED' || err.status === 410) {
          handleRoomMigrated();
        }
        // Note: on HISTORY_ID_COLLISION (409), the winning remote operation arrives via
        // `onCodeHistoryCreationsSubscription`, which transforms `inFlightOp` and retries!
      }
    }

    function handleIncomingCodeHistoryEdge(edge) {
      const index = OT.decodeHistoryId(edge.node.historyId);
      if (receivedHistory.has(index) || receivedHistory.isOutOfOrder(index)) {
        return;
      }
      receivedHistory.set(index, edge);
      if (receivedHistory.isOutOfOrder(index)) {
        return; // Wait until predecessor arrives
      }

      // Process this edge and any contiguous edges drained from outOfOrder
      let currIdx = index;
      while (receivedHistory.has(currIdx)) {
        const currentEdge = receivedHistory.get(currIdx);
        const incomingOp = OT.TextOperation.fromJSON(currentEdge.node.value);
        const isOurOwnAck =
          sentTextOps.has(currIdx) &&
          (currentEdge.node.createdBy.clientId === clientId ||
            (currentEdge.node.createdBy.me && sentTextOps.get(currIdx).equals(incomingOp)));

        if (isOurOwnAck) {
          sentTextOps.delete(currIdx);
          // Every 100th revision (or if a previous checkpoint failed), save a compaction checkpoint
          if ((currIdx !== 0 && currIdx % 100 === 0) || checkpointFailed) {
            saveCompactionCheckpoint(currentEdge.node.id);
          }
          if (bufferedOp) {
            inFlightOp = bufferedOp;
            bufferedOp = null;
            sendInFlightOperation();
          } else {
            inFlightOp = null;
            inFlightIndex = null;
          }
        } else {
          // Remote operation (or another user won our inFlightIndex slot -> collision!)
          const hadCollision = sentTextOps.has(currIdx);
          if (hadCollision) {
            sentTextOps.delete(currIdx);
          }

          let opToApply = incomingOp;
          if (inFlightOp) {
            const [transformedInFlight, transformedIncoming] = OT.TextOperation.transform(
              inFlightOp,
              opToApply
            );
            inFlightOp = transformedInFlight;
            opToApply = transformedIncoming;
          }
          if (bufferedOp) {
            const [transformedBuffered, transformedIncoming2] = OT.TextOperation.transform(
              bufferedOp,
              opToApply
            );
            bufferedOp = transformedBuffered;
            opToApply = transformedIncoming2;
          }

          applyTextOperationToCodeMirror(opToApply);

          if (hadCollision && inFlightOp) {
            sendInFlightOperation();
          }
        }
        currIdx++;
      }

      updatePlaceholderVisibility();
      updateRevisionBadge();
    }

    // Convert CodeMirror change into TextOperation (for main tab) or fileAction update (for secondary tabs)
    cm.on('change', (instance, changeObj) => {
      if (suppressEditorChanges || changeObj.origin === '+remote') return;
      if (!isEditable()) return;

      const doc = instance.getDoc();
      if (doc !== mainDoc) {
        const activeFile = getActiveFile();
        if (activeFile && activeFile.id !== 'main') {
          activeFile.content = doc.getValue();
          throttledSendSecondaryFileUpdate(activeFile.id, activeFile.content);
        }
        updatePlaceholderVisibility();
        updateStatusMetrics();
        if (activePermalinkRange) {
          renderPermalinkHighlight({ scrollIntoView: false });
        }
        return;
      }

      // Build TextOperation from CodeMirror changeObj on mainDoc
      const startIndex = doc.indexFromPos(changeObj.from);
      const removedText = (changeObj.removed || ['']).join('\n');
      const insertedText = (changeObj.text || ['']).join('\n');
      const currentLength = doc.getValue().length;
      const baseLength = currentLength - insertedText.length + removedText.length;
      const restLength = baseLength - startIndex - removedText.length;

      const op = new OT.TextOperation();
      if (startIndex > 0) op.retain(startIndex);
      if (removedText.length > 0) op.delete(removedText.length);
      if (insertedText.length > 0) op.insert(insertedText);
      if (restLength > 0) op.retain(restLength);

      if (op.isNoop()) return;

      if (!inFlightOp) {
        inFlightOp = op;
        sendInFlightOperation();
      } else if (!bufferedOp) {
        bufferedOp = op;
      } else {
        bufferedOp = bufferedOp.compose(op);
      }

      updatePlaceholderVisibility();
      updateStatusMetrics();
      if (activePermalinkRange) {
        renderPermalinkHighlight({ scrollIntoView: false });
      }
    });

    // =======================================================================
    // 7. Real-Time Collaborator Cursors & Presence (`CodeshareUser`)
    // =======================================================================
    const remoteCursorWidgets = new Map(); // nodeId -> { bookmark, selectionMarker }
    const activeRoomUsers = new Map();     // nodeId -> node

    function renderRemoteCursors() {
      // Clear any previous markers (Guest caret flags disabled completely)
      for (const markers of remoteCursorWidgets.values()) {
        if (markers.bookmark) markers.bookmark.clear();
        if (markers.selectionMarker) markers.selectionMarker.clear();
      }
      remoteCursorWidgets.clear();
    }

    // Populate initial room users
    if (codeshare.users && codeshare.users.edges) {
      codeshare.users.edges.forEach((edge) => {
        activeRoomUsers.set(edge.node.id, edge.node);
      });
      renderRemoteCursors();
    }

    const throttledSendCursor = createTrailingThrottle((cursorPayload) => {
      gqlClient
        .request({
          operationName: 'CodeshareFirepad_upsertMeIntoCodeshareUsers_Mutation',
          query: `mutation CodeshareFirepad_upsertMeIntoCodeshareUsers_Mutation($input: UpsertMeIntoCodeshareUsersInput!) {
            upsertMeIntoCodeshareUsers(input: $input) {
              codeshareUserEdge { node { id color cursor { position selectionEnd } modifiedAt createdBy { me userId } } }
            }
          }`,
          variables: {
            input: {
              codeshareId: codeshare.id,
              cursor: cursorPayload
            }
          }
        })
        .then((data) => {
          if (
            data &&
            data.upsertMeIntoCodeshareUsers &&
            data.upsertMeIntoCodeshareUsers.codeshareUserEdge
          ) {
            const node = data.upsertMeIntoCodeshareUsers.codeshareUserEdge.node;
            activeRoomUsers.set(node.id, node);
            renderRemoteCursors();
          }
        })
        .catch(() => {});
    }, 500);

    cm.on('cursorActivity', () => {
      updateStatusMetrics();
      const doc = cm.getDoc();
      const sel = doc.listSelections()[0];
      if (!sel) return;
      const anchorIdx = doc.indexFromPos(sel.anchor);
      const headIdx = doc.indexFromPos(sel.head);
      throttledSendCursor({
        position: headIdx,
        selectionEnd: anchorIdx
      });
    });

    // Announce initial presence immediately
    throttledSendCursor({ position: 0, selectionEnd: 0 });

    // =======================================================================
    // 8. Real-Time GraphQL Subscriptions (OT History, Cursors, Room & User Settings)
    // =======================================================================
    reconstructInitialDocument();

    gqlClient.subscribe({
      operationName: 'CodeshareFirepad_onCodeHistoryCreations_Subscription',
      query: `subscription CodeshareFirepad_onCodeHistoryCreations_Subscription($input: CodeHistoryCreationsInput!) {
        codeHistoryCreations(input: $input) { newCodeHistoryEdge { node { id historyId value createdAt createdBy { me userId clientId } } cursor } }
      }`,
      variables: { input: { codeshareId: codeshare.id } },
      onNext: (data) => {
        if (data.codeHistoryCreations && data.codeHistoryCreations.newCodeHistoryEdge) {
          handleIncomingCodeHistoryEdge(data.codeHistoryCreations.newCodeHistoryEdge);
        }
      }
    });

    gqlClient.subscribe({
      operationName: 'CodeshareFirepad_onCodeshareUserUpsertions_Subscription',
      query: `subscription CodeshareFirepad_onCodeshareUserUpsertions_Subscription($input: CodeshareUserUpsertionsInput!) {
        codeshareUserUpsertions(input: $input) { codeshareUserEdge { node { id color cursor { position selectionEnd } modifiedAt createdBy { me userId } } } }
      }`,
      variables: { input: { codeshareId: codeshare.id } },
      onNext: (data) => {
        if (data.codeshareUserUpsertions && data.codeshareUserUpsertions.codeshareUserEdge) {
          const node = data.codeshareUserUpsertions.codeshareUserEdge.node;
          activeRoomUsers.set(node.id, node);
          renderRemoteCursors();
        }
      }
    });

    gqlClient.subscribe({
      operationName: 'CodeshareFirepad_onCodeshareUserDeletions_Subscription',
      query: `subscription CodeshareFirepad_onCodeshareUserDeletions_Subscription($input: CodeshareUserDeletionsInput!) {
        codeshareUserDeletions(input: $input) { deletedCodeshareUserId }
      }`,
      variables: { input: { codeshareId: codeshare.id } },
      onNext: (data) => {
        if (data.codeshareUserDeletions && data.codeshareUserDeletions.deletedCodeshareUserId) {
          activeRoomUsers.delete(data.codeshareUserDeletions.deletedCodeshareUserId);
          renderRemoteCursors();
        }
      }
    });

    gqlClient.subscribe({
      operationName: 'CodeshareIdCodeshareSubscription',
      query: `subscription CodeshareIdCodeshareSubscription($input: CodeshareUpdatesInput!) {
        codeshareUpdates(input: $input) {
          codeshare {
            id slug title modeName tabSize migratedAt canEdit { me userIds }
            files { id name modeName content updatedAt lastClientId }
          }
        }
      }`,
      variables: { input: { codeshareId: codeshare.id } },
      onNext: (data) => {
        if (data.codeshareUpdates && data.codeshareUpdates.codeshare) {
          applyRemoteCodeshareMetadata(data.codeshareUpdates.codeshare);
        }
      }
    });

    gqlClient.subscribe({
      operationName: 'CodeshareIdMeSubscription',
      query: `subscription CodeshareIdMeSubscription($input: MeUpdatesInput!) {
        meUpdates(input: $input) { me { id settings { theme keymap } } }
      }`,
      variables: { input: {} },
      onNext: (data) => {
        if (data.meUpdates && data.meUpdates.me) {
          me = Object.assign(me, data.meUpdates.me);
          if (me.settings) {
            applyTheme(me.settings.theme);
            applyKeymap(me.settings.keymap);
          }
        }
      }
    });

    // Catch-Up Refetch on WebSocket Reconnect (`CodeshareIdCodeshareReconnectQuery` + `refetchableCodeHistoryEdgesRefetchQuery`)
    gqlClient.on('reconnected', async () => {
      try {
        const [, lastIdx] = receivedHistory.lastHistoryId();
        const afterCursor = lastIdx >= 0 ? OT.encodeRelayConnId(lastIdx) : null;
        const data = await gqlClient.request({
          operationName: 'CodeshareIdCodeshareReconnectQuery',
          query: `query CodeshareIdCodeshareReconnectQuery($codeshareId: String!, $codeHistoryAfter: String, $codeHistoryFirst: Int!) {
            codeshare(id: $codeshareId) {
              id slug title modeName tabSize migratedAt canEdit { me userIds }
              files { id name modeName content updatedAt lastClientId }
              codeHistory(after: $codeHistoryAfter, first: $codeHistoryFirst) { edges { node { id historyId value createdAt createdBy { me userId clientId } } cursor } }
            }
          }`,
          variables: {
            codeshareId: codeshare.id,
            codeHistoryAfter: afterCursor,
            codeHistoryFirst: 1000
          }
        });
        if (data && data.codeshare) {
          applyRemoteCodeshareMetadata(data.codeshare);
          const missedEdges = (data.codeshare.codeHistory && data.codeshare.codeHistory.edges) || [];
          missedEdges.forEach((edge) => handleIncomingCodeHistoryEdge(edge));
        }
      } catch (_) {}
    });

    function applyRemoteCodeshareMetadata(updated) {
      codeshare = Object.assign(codeshare, updated);
      if (codeshare.migratedAt) {
        handleRoomMigrated();
      }
      const titleInput = document.getElementById('codeshare-title-input');
      if (titleInput && document.activeElement !== titleInput) {
        titleInput.value = codeshare.title || codeshare.shortId;
      }
      const navTitle = document.getElementById('navbar-room-title');
      if (navTitle) navTitle.textContent = codeshare.title || codeshare.shortId;
      document.title = `${codeshare.title || codeshare.shortId} - CodeeFlow`;
      syncBrowserUrlToSlug(codeshare.slug || toUrlSlug(codeshare.title, codeshare.shortId));

      // Sync Multi-Tab / Multi-File Rooms
      if (Array.isArray(updated.files) && updated.files.length > 0) {
        const incomingIds = new Set(updated.files.map((f) => f.id));
        for (const key of Array.from(tabDocs.keys())) {
          if (key !== 'main' && !incomingIds.has(key)) {
            tabDocs.delete(key);
          }
        }
        roomFiles = updated.files.map((rf) => {
          const clone = Object.assign({}, rf);
          if (clone.id !== 'main') {
            const doc = getOrCreateDocForFile(clone);
            if (
              clone.lastClientId !== clientId &&
              typeof clone.content === 'string' &&
              doc.getValue() !== clone.content
            ) {
              const prevCursor = doc.getCursor();
              suppressEditorChanges = true;
              doc.setValue(clone.content);
              try {
                doc.setCursor(prevCursor);
              } catch (_) {}
              suppressEditorChanges = false;
            }
          }
          return clone;
        });
        if (!incomingIds.has(activeTabId)) {
          switchToFileTab('main', { focusEditor: false });
        } else {
          renderFileTabs();
        }
      }

      const activeFile = getActiveFile();
      const targetMode = (activeFile && activeFile.modeName) || codeshare.modeName || 'Plain Text';
      const modeSelect = document.getElementById('codeshare-mode-select');
      if (modeSelect && modeSelect.value !== targetMode) {
        modeSelect.value = targetMode;
      }
      applyLanguageMode(targetMode);

      const tabSelect = document.getElementById('codeshare-tabsize-select');
      if (tabSelect && String(tabSelect.value) !== String(codeshare.tabSize)) {
        tabSelect.value = String(codeshare.tabSize);
      }
      cm.setOption('tabSize', Number(codeshare.tabSize || 2));
      cm.setOption('indentUnit', Number(codeshare.tabSize || 2));

      // Update View-Only state
      const editable = isEditable();
      cm.setOption('readOnly', !editable);
      cm.setOption('cursorBlinkRate', editable ? 530 : -1);
      cm.setOption('cursorHeight', editable ? 1 : 0);
      if (titleInput) titleInput.disabled = !editable;
      if (modeSelect) modeSelect.disabled = !editable;
      if (tabSelect) tabSelect.disabled = !editable;
      renderFileTabs();

      const viewOnlyCheck = document.getElementById('view-only-checkbox');
      if (viewOnlyCheck) {
        viewOnlyCheck.checked = Array.isArray(codeshare.canEdit && codeshare.canEdit.userIds);
      }
      const readOnlyBadge = document.getElementById('readonly-badge');
      if (readOnlyBadge) {
        readOnlyBadge.hidden = !Array.isArray(codeshare.canEdit && codeshare.canEdit.userIds);
      }
    }

    function handleRoomMigrated() {
      cm.setOption('readOnly', true);
      try {
        localStorage.setItem(`codeshare-migration-backup:${codeshare.id}`, cm.getValue());
      } catch (_) {}
      const banner = document.getElementById('migration-banner');
      if (banner) banner.hidden = false;
    }

    // =======================================================================
    // 9. Sidebar Settings Controls, Share Modal, View-Only & Download
    // =======================================================================
    const throttledUpdateCodeshare = createTrailingThrottle((patch) => {
      gqlClient
        .request({
          operationName: 'updateCodeshareMutation',
          query: `mutation updateCodeshareMutation($input: UpdateCodeshareInput!) {
            updateCodeshare(input: $input) {
              codeshare {
                id slug title modeName tabSize canEdit { me userIds }
                files { id name modeName content updatedAt lastClientId }
              }
            }
          }`,
          variables: {
            input: Object.assign({ id: codeshare.id }, patch)
          }
        })
        .then((res) => {
          if (res && res.updateCodeshare && res.updateCodeshare.codeshare) {
            const updatedCs = res.updateCodeshare.codeshare;
            if (updatedCs.slug) {
              syncBrowserUrlToSlug(updatedCs.slug);
            }
          }
        })
        .catch(() => {});
    }, 500);

    const throttledUpdateMe = createTrailingThrottle((patch) => {
      gqlClient
        .request({
          operationName: 'useTheme_updateMe_Mutation',
          query: `mutation useTheme_updateMe_Mutation($input: UpdateMeInput!) {
            updateMe(input: $input) { me { id settings { theme keymap } } }
          }`,
          variables: { input: patch }
        })
        .catch(() => {});
    }, 500);

    const titleInput = document.getElementById('codeshare-title-input');
    const slugPreviewEl = document.getElementById('live-slug-preview');

    function extractSlugFromUrlInput(rawVal) {
      let cleaned = String(rawVal || '').trim();
      try {
        if (/^https?:\/\//i.test(cleaned)) {
          const parsed = new URL(cleaned);
          cleaned = decodeURIComponent(parsed.pathname.replace(/^\/+|\/+$/g, ''));
        } else if (cleaned.includes('/')) {
          const parts = cleaned.split('/').filter(Boolean);
          cleaned = parts.length ? decodeURIComponent(parts[parts.length - 1]) : '';
        }
      } catch (_) {}
      return cleaned;
    }

    function navigateToUrlSlug(rawUrlOrSlug) {
      const extracted = extractSlugFromUrlInput(rawUrlOrSlug);
      const nextSlug = toUrlSlug(extracted, '');
      if (nextSlug && nextSlug !== codeshare.shortId) {
        window.location.href = '/' + encodeURIComponent(nextSlug);
      } else if (slugPreviewEl) {
        slugPreviewEl.textContent = codeshare.shortId;
      }
    }

    if (titleInput) {
      titleInput.addEventListener('input', (e) => {
        const val = e.target.value;
        codeshare.title = val;
        const navTitle = document.getElementById('navbar-room-title');
        if (navTitle) navTitle.textContent = val || codeshare.shortId;
        document.title = `${val || codeshare.shortId} - CodeeFlow`;
        throttledUpdateCodeshare({ title: val });
      });
    }

    if (slugPreviewEl) {
      slugPreviewEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          slugPreviewEl.blur();
          navigateToUrlSlug(slugPreviewEl.textContent);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          slugPreviewEl.textContent = codeshare.shortId;
          slugPreviewEl.blur();
        }
      });
      slugPreviewEl.addEventListener('blur', () => {
        navigateToUrlSlug(slugPreviewEl.textContent);
      });
    }

    const modeSelect = document.getElementById('codeshare-mode-select');
    if (modeSelect) {
      modeSelect.addEventListener('change', (e) => {
        const modeName = e.target.value;
        const activeFile = getActiveFile();
        if (activeFile) {
          activeFile.modeName = modeName;
          const modeEntry = Catalog.MODES_BY_NAME[modeName];
          if (modeEntry && modeEntry.ext && modeEntry.ext.length > 0 && activeFile.name) {
            const dotIdx = activeFile.name.lastIndexOf('.');
            const baseStem = dotIdx > 0 ? activeFile.name.slice(0, dotIdx) : activeFile.name;
            activeFile.name = `${baseStem}.${modeEntry.ext[0]}`;
          }
          renderFileTabs();
          sendFileAction({
            type: 'rename',
            id: activeFile.id,
            name: activeFile.name,
            modeName
          });
        }
        if (activeTabId === 'main') {
          codeshare.modeName = modeName;
          throttledUpdateCodeshare({ modeName });
        }
        applyLanguageMode(modeName);
      });
    }

    const tabSelect = document.getElementById('codeshare-tabsize-select');
    if (tabSelect) {
      tabSelect.addEventListener('change', (e) => {
        const tabSize = String(e.target.value);
        codeshare.tabSize = tabSize;
        cm.setOption('tabSize', Number(tabSize));
        cm.setOption('indentUnit', Number(tabSize));
        throttledUpdateCodeshare({ tabSize });
      });
    }

    const themeSelect = document.getElementById('codeshare-theme-select');
    if (themeSelect) {
      if (me && me.settings && me.settings.theme) {
        themeSelect.value = me.settings.theme;
      }
      themeSelect.addEventListener('change', (e) => {
        const theme = e.target.value;
        applyTheme(theme);
        if (me && me.anonymous) {
          try {
            localStorage.setItem('user:id', me.id);
            localStorage.setItem('user:theme', theme);
            localStorage.setItem('user:keymap', (me.settings && me.settings.keymap) || 'sublime');
          } catch (_) {}
        } else {
          throttledUpdateMe({ settings: { theme } });
        }
      });
    }

    const keymapSelect = document.getElementById('codeshare-keymap-select');
    if (keymapSelect) {
      if (me && me.settings && me.settings.keymap) {
        keymapSelect.value = me.settings.keymap;
      }
      keymapSelect.addEventListener('change', (e) => {
        const keymap = e.target.value;
        applyKeymap(keymap);
        if (me && me.anonymous) {
          try {
            localStorage.setItem('user:id', me.id);
            localStorage.setItem('user:theme', (me.settings && me.settings.theme) || 'eclipse');
            localStorage.setItem('user:keymap', keymap);
          } catch (_) {}
        } else {
          throttledUpdateMe({ settings: { keymap } });
        }
      });
    }

    // Sidebar Toggle Button (`#codeshare-settings-button` & `#close-sidebar-btn`)
    const settingsBtn = document.getElementById('codeshare-settings-button');
    const closeSidebarBtn = document.getElementById('close-sidebar-btn');
    const sidebarEl = document.getElementById('editor-sidebar');
    const editorCanvasEl = document.querySelector('.editor-canvas');
    if (sidebarEl && window.innerWidth <= 768) {
      sidebarEl.hidden = true;
      cm.refresh();
    }
    if (settingsBtn && sidebarEl) {
      settingsBtn.addEventListener('click', () => {
        sidebarEl.hidden = !sidebarEl.hidden;
        cm.refresh();
      });
    }
    if (closeSidebarBtn && sidebarEl) {
      closeSidebarBtn.addEventListener('click', () => {
        sidebarEl.hidden = true;
        cm.refresh();
      });
    }
    if (editorCanvasEl && sidebarEl) {
      editorCanvasEl.addEventListener('click', () => {
        if (window.innerWidth <= 768 && !sidebarEl.hidden) {
          sidebarEl.hidden = true;
          cm.refresh();
        }
      });
    }

    // One-Click Copy Code Button (`#codeshare-copy-button` & Ctrl+Shift+C)
    const copyCodeBtn = document.getElementById('codeshare-copy-button');
    const copyCodeLabel = document.getElementById('codeshare-copy-label');
    let copyResetTimer = null;

    async function triggerCopyCode() {
      const hasSelection = cm.somethingSelected();
      const textToCopy = hasSelection ? cm.getSelection() : cm.getValue();
      const ok = await copyTextToClipboard(textToCopy);
      if (!ok) return;

      if (copyCodeBtn) {
        copyCodeBtn.setAttribute('data-copied', 'true');
        if (copyCodeLabel) copyCodeLabel.textContent = 'Copied!';
        if (copyResetTimer) clearTimeout(copyResetTimer);
        copyResetTimer = setTimeout(() => {
          copyCodeBtn.removeAttribute('data-copied');
          if (copyCodeLabel) copyCodeLabel.textContent = 'Copy';
        }, 2000);
      }

      if (hasSelection) {
        showToast('Copied selected code to clipboard!', { duration: 2400 });
      } else {
        const lineCount = textToCopy ? textToCopy.split('\n').length : 0;
        showToast(
          lineCount > 0
            ? `Copied all code to clipboard (${lineCount} ${lineCount === 1 ? 'line' : 'lines'})`
            : 'Copied to clipboard!',
          { duration: 2400 }
        );
      }
    }

    if (copyCodeBtn) {
      copyCodeBtn.addEventListener('click', triggerCopyCode);
    }

    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        triggerCopyCode();
      } else if (
        e.key === 'Escape' &&
        activePermalinkRange &&
        !document.querySelector('dialog[open]')
      ) {
        clearPermalink(true);
      }
    });

    // Gutter Line-Number Click & Shift+Click Range Permalink Selection
    cm.on('gutterClick', (_instance, lineZeroBased, _gutter, clickEvent) => {
      const clickedLine = lineZeroBased + 1;
      if (clickEvent && clickEvent.shiftKey && permalinkAnchorLine !== null) {
        setPermalinkRange(permalinkAnchorLine, clickedLine, {
          updateUrl: true,
          scrollIntoView: false
        });
      } else if (
        activePermalinkRange &&
        activePermalinkRange.startLine === clickedLine &&
        activePermalinkRange.endLine === clickedLine
      ) {
        clearPermalink(true);
      } else {
        permalinkAnchorLine = clickedLine;
        setPermalinkRange(clickedLine, clickedLine, {
          updateUrl: true,
          scrollIntoView: false
        });
      }
    });

    // Status Pill Permalink Trigger (`#status-permalink-btn`)
    const statusPermalinkBtn = document.getElementById('status-permalink-btn');
    if (statusPermalinkBtn) {
      statusPermalinkBtn.addEventListener('click', async () => {
        const { startLine, endLine } = getCurrentSelectionLineRange();
        permalinkAnchorLine = startLine;
        setPermalinkRange(startLine, endLine, {
          updateUrl: true,
          scrollIntoView: false
        });
        const hashLabel = formatPermalinkHash(startLine, endLine);
        await copyTextToClipboard(window.location.href);
        showToast(`Copied line permalink ${hashLabel} to clipboard!`, { duration: 2600 });
      });
    }

    // Floating Permalink Banner Actions (`#permalink-copy-url-btn`, `#permalink-copy-lines-btn`, `#permalink-clear-btn`)
    const permalinkCopyUrlBtn = document.getElementById('permalink-copy-url-btn');
    const permalinkCopyUrlLabel = document.getElementById('permalink-copy-url-label');
    const permalinkCopyLinesBtn = document.getElementById('permalink-copy-lines-btn');
    const permalinkCopyLinesLabel = document.getElementById('permalink-copy-lines-label');
    const permalinkClearBtn = document.getElementById('permalink-clear-btn');

    if (permalinkCopyUrlBtn) {
      permalinkCopyUrlBtn.addEventListener('click', async () => {
        const ok = await copyTextToClipboard(window.location.href);
        if (!ok) return;
        if (permalinkCopyUrlLabel) {
          permalinkCopyUrlLabel.textContent = 'Copied Link!';
          setTimeout(() => {
            permalinkCopyUrlLabel.textContent = 'Copy Line Link';
          }, 2000);
        }
        const badge = activePermalinkRange
          ? formatPermalinkHash(activePermalinkRange.startLine, activePermalinkRange.endLine)
          : '';
        showToast(`Copied ${badge} link to clipboard!`, { duration: 2400 });
      });
    }

    if (permalinkCopyLinesBtn) {
      permalinkCopyLinesBtn.addEventListener('click', async () => {
        if (!activePermalinkRange) return;
        const maxLines = Math.max(1, cm.lineCount());
        const sIdx = Math.min(maxLines, Math.max(1, activePermalinkRange.startLine)) - 1;
        const eIdx = Math.min(maxLines, Math.max(1, activePermalinkRange.endLine)) - 1;
        const endLineText = cm.getLine(eIdx) || '';
        const rangeText = cm.getRange(
          { line: sIdx, ch: 0 },
          { line: eIdx, ch: endLineText.length }
        );
        const ok = await copyTextToClipboard(rangeText);
        if (!ok) return;
        if (permalinkCopyLinesLabel) {
          permalinkCopyLinesLabel.textContent = 'Copied Lines!';
          setTimeout(() => {
            permalinkCopyLinesLabel.textContent = 'Copy Lines';
          }, 2000);
        }
        const badge = formatPermalinkHash(
          activePermalinkRange.startLine,
          activePermalinkRange.endLine
        );
        showToast(`Copied code from ${badge} to clipboard!`, { duration: 2400 });
      });
    }

    if (permalinkClearBtn) {
      permalinkClearBtn.addEventListener('click', () => clearPermalink(true));
    }

    window.addEventListener('hashchange', () => {
      const parsed = parsePermalinkHash(window.location.hash);
      if (parsed) {
        permalinkAnchorLine = parsed.startLine;
        setPermalinkRange(parsed.startLine, parsed.endLine, {
          updateUrl: false,
          scrollIntoView: true
        });
      } else {
        clearPermalink(false);
      }
    });

    // Download Button (`#codeshare-download-button`)
    const downloadBtn = document.getElementById('codeshare-download-button');
    if (downloadBtn) {
      downloadBtn.addEventListener('click', () => {
        const activeFile = getActiveFile();
        const activeMode = (activeFile && activeFile.modeName) || codeshare.modeName || 'Plain Text';
        const modeEntry =
          Catalog.MODES_BY_NAME[activeMode] || Catalog.MODES_BY_NAME['Plain Text'];
        const ext = (modeEntry.ext && modeEntry.ext[0]) || 'txt';
        let downloadName = activeFile && activeFile.name ? activeFile.name.trim() : '';
        if (!downloadName) {
          const baseName = (codeshare.title || codeshare.shortId || 'codeeflow')
            .replace(/[^a-zA-Z0-9_-]/g, '_');
          downloadName = `${baseName}.${ext}`;
        } else if (!downloadName.includes('.')) {
          downloadName = `${downloadName}.${ext}`;
        }
        const blob = new Blob([cm.getValue()], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = downloadName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      });
    }

    // =======================================================================
    // 9b. Instant QR Code Share & Aesthetic Code Screenshot Export Studio
    // =======================================================================
    // ISO/IEC 18004 Reed-Solomon GF(256) QR Code Generator (Versions 1-8, Level L, Byte Mode)
    const QR_GF_EXP = new Uint8Array(512);
    const QR_GF_LOG = new Uint8Array(256);
    (() => {
      let x = 1;
      for (let i = 0; i < 255; i++) {
        QR_GF_EXP[i] = x;
        QR_GF_LOG[x] = i;
        x <<= 1;
        if (x & 0x100) x ^= 0x11d;
      }
      for (let i = 255; i < 512; i++) {
        QR_GF_EXP[i] = QR_GF_EXP[i - 255];
      }
    })();

    function qrGfMul(a, b) {
      return a === 0 || b === 0 ? 0 : QR_GF_EXP[QR_GF_LOG[a] + QR_GF_LOG[b]];
    }

    function qrRsEncode(dataBytes, ecLen) {
      let gen = [1];
      for (let i = 0; i < ecLen; i++) {
        const next = new Array(gen.length + 1).fill(0);
        const factor = QR_GF_EXP[i];
        for (let j = 0; j < gen.length; j++) {
          next[j] ^= gen[j];
          next[j + 1] ^= qrGfMul(gen[j], factor);
        }
        gen = next;
      }
      const rem = new Uint8Array(ecLen);
      for (let i = 0; i < dataBytes.length; i++) {
        const factor = dataBytes[i] ^ rem[0];
        for (let j = 0; j < ecLen - 1; j++) {
          rem[j] = rem[j + 1] ^ qrGfMul(gen[j + 1], factor);
        }
        rem[ecLen - 1] = qrGfMul(gen[ecLen], factor);
      }
      return rem;
    }

    // Version specs for Level L: [totalDataCodewords, ecCodewordsPerBlock, numBlocks, alignmentCoords]
    const QR_VERSION_L_SPECS = [
      null,
      [19, 7, 1, []],
      [34, 10, 1, [6, 18]],
      [55, 15, 1, [6, 22]],
      [80, 20, 1, [6, 26]],
      [108, 26, 1, [6, 30]],
      [136, 18, 2, [6, 34]],
      [156, 20, 2, [6, 22, 38]],
      [194, 24, 2, [6, 24, 42]]
    ];

    function generateQrMatrix(text) {
      const utf8 = new TextEncoder().encode(String(text || 'https://codeeflow.io').slice(0, 185));
      let version = 1;
      while (
        version < 8 &&
        utf8.length + 2 > QR_VERSION_L_SPECS[version][0]
      ) {
        version++;
      }
      const [totalDataCw, ecCwPerBlock, numBlocks, alignCoords] = QR_VERSION_L_SPECS[version];
      const size = version * 4 + 17;

      // Build bit stream: Mode 0100 (Byte), 8-bit length, payload, terminator, pad bytes
      const bits = [];
      const pushBits = (val, len) => {
        for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
      };
      pushBits(0b0100, 4);
      pushBits(utf8.length, 8);
      for (let i = 0; i < utf8.length; i++) pushBits(utf8[i], 8);
      const maxBits = totalDataCw * 8;
      for (let i = 0; i < 4 && bits.length < maxBits; i++) bits.push(0);
      while (bits.length % 8 !== 0) bits.push(0);

      const dataCw = new Uint8Array(totalDataCw);
      for (let i = 0; i < bits.length / 8; i++) {
        let byte = 0;
        for (let b = 0; b < 8; b++) byte = (byte << 1) | bits[i * 8 + b];
        dataCw[i] = byte;
      }
      const padBytes = [0xec, 0x11];
      for (let i = bits.length / 8, p = 0; i < totalDataCw; i++, p ^= 1) {
        dataCw[i] = padBytes[p];
      }

      // Split into blocks and compute Reed-Solomon EC codewords
      const dataBlocks = [];
      const ecBlocks = [];
      const cwPerBlock = Math.floor(totalDataCw / numBlocks);
      for (let b = 0; b < numBlocks; b++) {
        const blockData = dataCw.slice(b * cwPerBlock, (b + 1) * cwPerBlock);
        dataBlocks.push(blockData);
        ecBlocks.push(qrRsEncode(blockData, ecCwPerBlock));
      }

      const finalCodewords = [];
      for (let i = 0; i < cwPerBlock; i++) {
        for (let b = 0; b < numBlocks; b++) finalCodewords.push(dataBlocks[b][i]);
      }
      for (let i = 0; i < ecCwPerBlock; i++) {
        for (let b = 0; b < numBlocks; b++) finalCodewords.push(ecBlocks[b][i]);
      }

      const modules = Array.from({ length: size }, () => new Uint8Array(size));
      const reserved = Array.from({ length: size }, () => new Uint8Array(size));

      const setFunctionModule = (r, c, dark) => {
        if (r < 0 || r >= size || c < 0 || c >= size) return;
        modules[r][c] = dark ? 1 : 0;
        reserved[r][c] = 1;
      };

      const placeFinder = (topR, leftC) => {
        for (let dr = -1; dr <= 7; dr++) {
          for (let dc = -1; dc <= 7; dc++) {
            const isBorder = dr === -1 || dr === 7 || dc === -1 || dc === 7;
            const isOuter = dr === 0 || dr === 6 || dc === 0 || dc === 6;
            const isInner = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
            setFunctionModule(topR + dr, leftC + dc, !isBorder && (isOuter || isInner));
          }
        }
      };

      placeFinder(0, 0);
      placeFinder(0, size - 7);
      placeFinder(size - 7, 0);

      // Timing patterns
      for (let i = 8; i < size - 8; i++) {
        setFunctionModule(6, i, i % 2 === 0);
        setFunctionModule(i, 6, i % 2 === 0);
      }

      // Alignment patterns
      for (let i = 0; i < alignCoords.length; i++) {
        for (let j = 0; j < alignCoords.length; j++) {
          const ar = alignCoords[i];
          const ac = alignCoords[j];
          if (
            (ar <= 8 && ac <= 8) ||
            (ar <= 8 && ac >= size - 8) ||
            (ar >= size - 8 && ac <= 8)
          ) {
            continue;
          }
          for (let dr = -2; dr <= 2; dr++) {
            for (let dc = -2; dc <= 2; dc++) {
              const dist = Math.max(Math.abs(dr), Math.abs(dc));
              setFunctionModule(ar + dr, ac + dc, dist !== 1);
            }
          }
        }
      }

      // Reserve format info & dark module
      for (let i = 0; i < 9; i++) {
        if (i !== 6) {
          reserved[8][i] = 1;
          reserved[i][8] = 1;
        }
      }
      for (let i = 0; i < 8; i++) {
        reserved[8][size - 1 - i] = 1;
        reserved[size - 1 - i][8] = 1;
      }
      setFunctionModule(size - 8, 8, true);

      // Version 7+ 6x3 version info blocks
      if (version >= 7) {
        let rem = version;
        for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
        const verBits = (version << 12) | rem;
        for (let i = 0; i < 18; i++) {
          const bit = (verBits >>> i) & 1;
          const a = size - 11 + (i % 3);
          const b = Math.floor(i / 3);
          setFunctionModule(b, a, bit === 1);
          setFunctionModule(a, b, bit === 1);
        }
      }

      // Place data bits in upward/downward 2-column zig-zag
      let bitIdx = 0;
      const totalBits = finalCodewords.length * 8;
      let upward = true;
      for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let vert = 0; vert < size; vert++) {
          const r = upward ? size - 1 - vert : vert;
          for (let j = 0; j < 2; j++) {
            const c = right - j;
            if (!reserved[r][c]) {
              let dark = false;
              if (bitIdx < totalBits) {
                const cw = finalCodewords[bitIdx >>> 3];
                dark = ((cw >>> (7 - (bitIdx & 7))) & 1) === 1;
                bitIdx++;
              }
              // Apply mask 0: (r + c) % 2 === 0
              if ((r + c) % 2 === 0) dark = !dark;
              modules[r][c] = dark ? 1 : 0;
            }
          }
        }
        upward = !upward;
      }

      // Write format info for Level L (01) and Mask 0 (000) -> 0x77c4
      const formatBits = 0x77c4;
      const formatCoords1 = [
        [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
        [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]
      ];
      for (let i = 0; i < 15; i++) {
        const bit = (formatBits >>> i) & 1;
        const [r1, c1] = formatCoords1[i];
        modules[r1][c1] = bit;
        if (i < 8) {
          modules[8][size - 1 - i] = bit;
        } else {
          modules[size - 15 + i][8] = bit;
        }
      }

      return { modules, size };
    }

    function roundRectPath(ctx, x, y, w, h, r) {
      const radius = Math.min(r, w / 2, h / 2);
      ctx.beginPath();
      ctx.moveTo(x + radius, y);
      ctx.arcTo(x + w, y, x + w, y + h, radius);
      ctx.arcTo(x + w, y + h, x, y + h, radius);
      ctx.arcTo(x, y + h, x, y, radius);
      ctx.arcTo(x, y, x + w, y, radius);
      ctx.closePath();
    }

    function drawQrMatrixToContext(ctx, text, x, y, boxSize, { fg = '#153226', bg = '#FFFDF9', showLogo = true } = {}) {
      const { modules, size } = generateQrMatrix(text);
      const quiet = 2;
      const totalModules = size + quiet * 2;
      const cell = boxSize / totalModules;

      ctx.save();
      roundRectPath(ctx, x, y, boxSize, boxSize, Math.max(6, boxSize * 0.06));
      ctx.fillStyle = bg;
      ctx.fill();

      ctx.fillStyle = fg;
      const centerMin = Math.floor(size / 2) - 2;
      const centerMax = Math.ceil(size / 2) + 1;

      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          if (!modules[r][c]) continue;
          if (showLogo && r >= centerMin && r <= centerMax && c >= centerMin && c <= centerMax) {
            continue;
          }
          const rx = x + (c + quiet) * cell;
          const ry = y + (r + quiet) * cell;
          ctx.fillRect(rx, ry, Math.ceil(cell), Math.ceil(cell));
        }
      }

      if (showLogo) {
        const badgeSize = cell * 4.4;
        const bx = x + (boxSize - badgeSize) / 2;
        const by = y + (boxSize - badgeSize) / 2;
        roundRectPath(ctx, bx - 2, by - 2, badgeSize + 4, badgeSize + 4, badgeSize * 0.28);
        ctx.fillStyle = bg;
        ctx.fill();

        roundRectPath(ctx, bx, by, badgeSize, badgeSize, badgeSize * 0.24);
        ctx.fillStyle = '#1B4332';
        ctx.fill();

        ctx.fillStyle = '#FFFDF9';
        ctx.font = `700 ${Math.max(8, Math.round(badgeSize * 0.42))}px "JetBrains Mono", monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('</>', bx + badgeSize / 2, by + badgeSize / 2 + 0.5);
      }
      ctx.restore();
    }

    function renderShareModalQr() {
      const qrCanvas = document.getElementById('share-qr-canvas');
      if (!qrCanvas) return;
      const shareInput = document.getElementById('share-url-input');
      const urlText = (shareInput && shareInput.value) || window.location.href;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const displaySize = 168;
      qrCanvas.width = displaySize * dpr;
      qrCanvas.height = displaySize * dpr;
      const ctx = qrCanvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, displaySize, displaySize);
      drawQrMatrixToContext(ctx, urlText, 0, 0, displaySize, {
        fg: '#14281F',
        bg: '#FFFDF9',
        showLogo: true
      });
    }

    function buildExportableQrCardCanvas() {
      const shareInput = document.getElementById('share-url-input');
      const urlText = (shareInput && shareInput.value) || window.location.href;
      const out = document.createElement('canvas');
      out.width = 640;
      out.height = 740;
      const ctx = out.getContext('2d');

      const grad = ctx.createLinearGradient(0, 0, 640, 740);
      grad.addColorStop(0, '#1B4332');
      grad.addColorStop(1, '#0F291E');
      roundRectPath(ctx, 0, 0, 640, 740, 32);
      ctx.fillStyle = grad;
      ctx.fill();

      roundRectPath(ctx, 48, 48, 544, 544, 24);
      ctx.fillStyle = '#FFFDF9';
      ctx.fill();
      drawQrMatrixToContext(ctx, urlText, 68, 68, 504, {
        fg: '#14281F',
        bg: '#FFFDF9',
        showLogo: true
      });

      ctx.fillStyle = '#FFFDF9';
      ctx.font = '600 22px "Plus Jakarta Sans", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`CodeeFlow Live Room • ${codeshare.title || codeshare.shortId}`, 320, 642);

      ctx.fillStyle = 'rgba(255, 253, 249, 0.78)';
      ctx.font = '500 15px "JetBrains Mono", monospace';
      ctx.fillText(urlText.slice(0, 56), 320, 678);
      return out;
    }

    async function copyCanvasToClipboard(canvasEl) {
      if (!navigator.clipboard || typeof window.ClipboardItem === 'undefined') {
        return false;
      }
      return new Promise((resolve) => {
        canvasEl.toBlob(async (blob) => {
          if (!blob) {
            resolve(false);
            return;
          }
          try {
            await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })]);
            resolve(true);
          } catch (_) {
            resolve(false);
          }
        }, 'image/png');
      });
    }

    function downloadCanvasAsPng(canvasEl, filename) {
      const dataUrl = canvasEl.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }

    // Share Modal & Copy URL + Instant QR Code Actions
    const shareBtn = document.getElementById('codeshare-share-button');
    const shareDialog = document.getElementById('share-dialog');
    const shareUrlInput = document.getElementById('share-url-input');
    const copyShareUrlBtn = document.getElementById('copy-share-url-btn');
    const downloadQrBtn = document.getElementById('download-qr-btn');
    const copyQrBtn = document.getElementById('copy-qr-btn');
    const copyQrLabel = document.getElementById('copy-qr-label');

    if (shareBtn && shareDialog) {
      shareBtn.addEventListener('click', () => {
        if (shareUrlInput) shareUrlInput.value = window.location.href;
        renderShareModalQr();
        shareDialog.showModal();
        if (shareUrlInput) shareUrlInput.select();
      });
    }

    if (downloadQrBtn) {
      downloadQrBtn.addEventListener('click', () => {
        const cardCanvas = buildExportableQrCardCanvas();
        downloadCanvasAsPng(cardCanvas, `codeeflow-qr-${codeshare.shortId}.png`);
        showToast('Downloaded room QR code PNG!', { duration: 2400 });
      });
    }

    if (copyQrBtn) {
      copyQrBtn.addEventListener('click', async () => {
        const cardCanvas = buildExportableQrCardCanvas();
        const ok = await copyCanvasToClipboard(cardCanvas);
        if (ok) {
          if (copyQrLabel) {
            copyQrLabel.textContent = 'Copied QR!';
            setTimeout(() => {
              copyQrLabel.textContent = 'Copy QR';
            }, 2000);
          }
          showToast('Copied QR code image to clipboard!', { duration: 2400 });
        } else {
          downloadCanvasAsPng(cardCanvas, `codeeflow-qr-${codeshare.shortId}.png`);
          showToast('Saved QR code PNG!', { duration: 2400 });
        }
      });
    }

    if (shareUrlInput) {
      shareUrlInput.addEventListener('input', () => {
        renderShareModalQr();
      });
      shareUrlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          navigateToUrlSlug(shareUrlInput.value);
        }
      });
    }

    if (copyShareUrlBtn && shareUrlInput) {
      copyShareUrlBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(shareUrlInput.value);
          copyShareUrlBtn.textContent = 'Copied!';
          setTimeout(() => {
            copyShareUrlBtn.textContent = 'Copy Link';
          }, 2000);
        } catch (_) {
          shareUrlInput.select();
          document.execCommand('copy');
        }
      });
    }

    // View-Only Checkbox (Pro-Gated when turning ON)
    const viewOnlyCheckbox = document.getElementById('view-only-checkbox');
    const proDialog = document.getElementById('pro-dialog');
    if (viewOnlyCheckbox) {
      viewOnlyCheckbox.addEventListener('change', (e) => {
        const wantsViewOnly = e.target.checked;
        const viewerIsPro = Boolean(me && me.isPro);
        if (wantsViewOnly && !viewerIsPro) {
          e.target.checked = false;
          if (shareDialog && shareDialog.open) closeTopLayer(shareDialog);
          if (proDialog) proDialog.showModal();
          return;
        }
        const newUserIds = wantsViewOnly ? [codeshare.createdBy.userId] : null;
        throttledUpdateCodeshare({
          canEdit: { userIds: newUserIds }
        });
      });
    }

    // Save Codeshare Button (for Anonymous / Unsaved Codeshares)
    const saveCodeshareBtn = document.getElementById('save-codeshare-btn');
    const authDialog = document.getElementById('auth-dialog');
    if (saveCodeshareBtn) {
      saveCodeshareBtn.addEventListener('click', async () => {
        if (me && !me.anonymous) {
          await gqlClient.request({
            operationName: 'updateCodeshareMutation',
            query: `mutation updateCodeshareMutation($input: UpdateCodeshareInput!) {
              updateCodeshare(input: $input) { codeshare { id saved } }
            }`,
            variables: { input: { id: codeshare.id, save: true } }
          });
          showToast('CodeeFlow saved to your account.', { duration: 3500 });
          const expEl = document.getElementById('expire-time');
          if (expEl) expEl.remove();
        } else if (authDialog) {
          authDialog.showModal();
        }
      });
    }

    // Timed Conversion NagModal (10m = 600,000ms for creator, 15m = 900,000ms for collaborator)
    const creatorIsPro =
      codeshare.createdBy &&
      codeshare.createdBy.user &&
      codeshare.createdBy.user.isPro;
    if (me && me.anonymous && !creatorIsPro && authDialog) {
      const nagDelay = codeshare.createdBy && codeshare.createdBy.me ? 600000 : 900000;
      setTimeout(() => {
        if (me && me.anonymous && !authDialog.open) {
          authDialog.showModal();
        }
      }, nagDelay);
    }

    // 4-Stage Ad/Sponsor Waterfall (`SponsorAllInOne`)
    const sponsorRoot = document.getElementById('sponsor-bar');
    if (sponsorRoot && !(me && me.isPro) && !creatorIsPro) {
      fetch('/-/sp.json?k=CESIKK7N&t=f')
        .then((r) => r.json())
        .then((data) => {
          const ad = data && data.ads && data.ads[0];
          if (ad && ad.statlink) {
            sponsorRoot.innerHTML = `<span class="sponsor-tag">Sponsor</span>
              <a href="${ad.statlink}" target="_blank" rel="noopener noreferrer">${ad.description}</a>
              <button type="button" class="btn btn-ghost" style="height:22px;padding:0 8px;font-size:11px;" id="hide-ads-btn">Hide Ads</button>`;
            const hideBtn = document.getElementById('hide-ads-btn');
            if (hideBtn && proDialog) {
              hideBtn.addEventListener('click', () => proDialog.showModal());
            }
          }
        })
        .catch(() => {
          // Stage 3 SimpleSadFace fallback
          sponsorRoot.innerHTML = `<span>Please don't block our ads :( — Ad sponsors keep CodeeFlow free.</span>
            <button type="button" class="btn btn-ghost" style="height:22px;padding:0 8px;font-size:11px;" id="hide-ads-btn">Hide Ads</button>`;
        });
    }
  }

  // =========================================================================
  // 10. Auth Modals, Pro Checkout, Saved Codeshares (/codes), Settings & Admin
  // =========================================================================
  function initGlobalForms() {
    // Home Page Studio Preview One-Click Copy Snippet Button (`#home-copy-preview-btn`)
    const homeCopyBtn = document.getElementById('home-copy-preview-btn');
    const homeCopyLabel = document.getElementById('home-copy-preview-label');
    const homePreviewPre = document.getElementById('home-studio-preview-code');
    if (homeCopyBtn && homePreviewPre) {
      homeCopyBtn.addEventListener('click', async () => {
        const text = homePreviewPre.textContent || '';
        const ok = await copyTextToClipboard(text);
        if (!ok) return;
        if (homeCopyLabel) {
          homeCopyLabel.textContent = '✓ Copied!';
          setTimeout(() => {
            homeCopyLabel.textContent = 'Copy Snippet';
          }, 2000);
        }
        showToast('Copied studio snippet to clipboard!', { duration: 2400 });
      });
    }

    // Home Page "Join Existing" Room Form (`#join-existing-form`)
    const joinForm = document.getElementById('join-existing-form');
    if (joinForm) {
      joinForm.addEventListener('submit', (e) => {
        const inputEl = document.getElementById('join-room-input');
        if (!inputEl) return;
        let raw = (inputEl.value || '').trim();
        if (!raw) return;
        e.preventDefault();
        let lineHash = '';
        const hashMatch = /#(L\d+(?:-L?\d+)?)$/i.exec(raw);
        if (hashMatch) {
          lineHash = '#' + hashMatch[1].toUpperCase();
          raw = raw.slice(0, hashMatch.index);
        }
        try {
          if (/^https?:\/\//i.test(raw)) {
            const parsed = new URL(raw);
            raw = parsed.pathname;
          }
        } catch (_) {}
        raw = raw.replace(/^\/+|\/+$/g, '');
        if (raw.includes('/')) {
          const parts = raw.split('/').filter(Boolean);
          raw = parts[parts.length - 1] || '';
        }
        const slug = raw
          .trim()
          .replace(/[^a-zA-Z0-9_-]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 64);
        if (slug) {
          window.location.href = '/' + encodeURIComponent(slug) + lineHash;
        }
      });
    }

    // Open Pro Modal triggers
    const proDialog = document.getElementById('pro-dialog');
    document.querySelectorAll('[data-open-pro]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (proDialog) proDialog.showModal();
      });
    });

    // Open Auth Modal triggers
    const authDialog = document.getElementById('auth-dialog');
    document.querySelectorAll('[data-open-auth]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (authDialog) authDialog.showModal();
      });
    });

    // Auth Modal / Page Login & Register Forms
    document.querySelectorAll('[data-graphql-login-form]').forEach((form) => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = form.querySelector('[name="email"]').value;
        const password = form.querySelector('[name="password"]').value;
        const errBox = form.querySelector('.form-error-banner');
        if (errBox) errBox.textContent = '';

        try {
          await gqlClient.request({
            operationName: 'LoginFormMutation',
            query: `mutation LoginFormMutation($input: LoginInput!) { login(input: $input) { me { id email name } } }`,
            variables: { input: { email, password } }
          });

          // If inside an anonymous-created room, claim/save it automatically!
          if (
            BOOTSTRAP.codeshare &&
            BOOTSTRAP.codeshare.createdBy &&
            BOOTSTRAP.codeshare.createdBy.user &&
            BOOTSTRAP.codeshare.createdBy.user.anonymous
          ) {
            await gqlClient.request({
              operationName: 'updateCodeshareMutation',
              query: `mutation updateCodeshareMutation($input: UpdateCodeshareInput!) { updateCodeshare(input: $input) { codeshare { id } } }`,
              variables: { input: { id: BOOTSTRAP.codeshare.id, save: true } }
            });
          }

          const redirectTarget = form.getAttribute('data-redirect') || window.location.pathname;
          window.location.href = redirectTarget;
        } catch (err) {
          if (errBox) errBox.textContent = err.message || 'Login failed.';
        }
      });
    });

    document.querySelectorAll('[data-graphql-register-form]').forEach((form) => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = form.querySelector('[name="name"]').value;
        const email = form.querySelector('[name="email"]').value;
        const password = form.querySelector('[name="password"]').value;
        const errBox = form.querySelector('.form-error-banner');
        if (errBox) errBox.textContent = '';

        let savedSettings = {};
        try {
          const theme = localStorage.getItem('user:theme');
          const keymap = localStorage.getItem('user:keymap');
          if (theme) savedSettings.theme = theme;
          if (keymap) savedSettings.keymap = keymap;
        } catch (_) {}

        try {
          await gqlClient.request({
            operationName: 'RegisterFormMutation',
            query: `mutation RegisterFormMutation($input: RegisterInput!) { register(input: $input) { me { id email name } } }`,
            variables: {
              input: {
                name,
                email,
                password,
                settings: savedSettings
              }
            }
          });

          if (
            BOOTSTRAP.codeshare &&
            BOOTSTRAP.codeshare.createdBy &&
            BOOTSTRAP.codeshare.createdBy.user &&
            BOOTSTRAP.codeshare.createdBy.user.anonymous
          ) {
            await gqlClient.request({
              operationName: 'updateCodeshareMutation',
              query: `mutation updateCodeshareMutation($input: UpdateCodeshareInput!) { updateCodeshare(input: $input) { codeshare { id } } }`,
              variables: { input: { id: BOOTSTRAP.codeshare.id, save: true } }
            });
          }

          const redirectTarget = form.getAttribute('data-redirect') || window.location.pathname;
          window.location.href = redirectTarget;
        } catch (err) {
          if (errBox) errBox.textContent = err.message || 'Registration failed.';
        }
      });
    });

    // Pro Upgrade Checkout Form (`subscribeToCodeshareProMutation`)
    const proCheckoutForm = document.getElementById('pro-checkout-form');
    if (proCheckoutForm) {
      proCheckoutForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = proCheckoutForm.querySelector('button[type="submit"]');
        if (btn) {
          btn.disabled = true;
          btn.textContent = 'Activating Pro...';
        }
        try {
          await gqlClient.request({
            operationName: 'CodeshareProForm_subscribeToCodesharePro_Mutation',
            query: `mutation CodeshareProForm_subscribeToCodesharePro_Mutation($input: SubscribeToCodeshareProInput!) {
              subscribeToCodesharePro(input: $input) { me { id isPro } }
            }`,
            variables: {
              input: { stripePaymentMethodId: 'pm_card_visa_4242' }
            }
          });
          showToast('Welcome to CodeeFlow Pro!', { duration: 3000 });
          setTimeout(() => window.location.reload(), 600);
        } catch (err) {
          if (btn) {
            btn.disabled = false;
            btn.textContent = 'Upgrade to Pro — $49/mth';
          }
          showToast(err.message || 'Checkout failed.', { duration: 4000 });
        }
      });
    }

    // Saved CodeeFlows Deletion on `/codes` (`CodeshareDeleteButton_deleteCodeshare_Mutation`)
    document.querySelectorAll('[data-delete-codeshare]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const codeshareId = btn.getAttribute('data-delete-codeshare');
        const row = btn.closest('tr');
        if (row) row.style.opacity = '0.4';
        try {
          await gqlClient.request({
            operationName: 'CodeshareDeleteButton_deleteCodeshare_Mutation',
            query: `mutation CodeshareDeleteButton_deleteCodeshare_Mutation($input: DeleteCodeshareInput!) {
              deleteCodeshare(input: $input) { deletedCodeshareId }
            }`,
            variables: { input: { id: codeshareId } }
          });
          if (row) row.remove();
          showToast('CodeeFlow deleted.', { duration: 2500 });
        } catch (err) {
          if (row) row.style.opacity = '1';
          showToast(err.message || 'Could not delete CodeeFlow.', { duration: 3500 });
        }
      });
    });

    // User Settings Form on `/settings` (`UserSettingsForm_updateMe_Mutation`)
    const userSettingsForm = document.getElementById('user-settings-form');
    if (userSettingsForm) {
      userSettingsForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = userSettingsForm.querySelector('[name="name"]').value;
        const email = userSettingsForm.querySelector('[name="email"]').value;
        const password = userSettingsForm.querySelector('[name="password"]').value;
        const input = { name, email };
        if (password) input.password = password;
        try {
          await gqlClient.request({
            operationName: 'UserSettingsForm_updateMe_Mutation',
            query: `mutation UserSettingsForm_updateMe_Mutation($input: UpdateMeInput!) { updateMe(input: $input) { me { id name email } } }`,
            variables: { input }
          });
          showToast('Account settings updated.', { duration: 3000 });
        } catch (err) {
          showToast(err.message || 'Update failed.', { duration: 3500 });
        }
      });
    }

    // Default CodeeFlow Settings Form on `/settings` (`DefaultCodeshareSettingsForm_updateMe_Mutation`)
    const defaultSettingsForm = document.getElementById('default-codeshare-settings-form');
    if (defaultSettingsForm) {
      defaultSettingsForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const modeName = defaultSettingsForm.querySelector('[name="modeName"]').value;
        const tabSize = defaultSettingsForm.querySelector('[name="tabSize"]').value;
        const companyImage = defaultSettingsForm.querySelector('[name="companyImage"]').value;
        try {
          await gqlClient.request({
            operationName: 'DefaultCodeshareSettingsForm_updateMe_Mutation',
            query: `mutation DefaultCodeshareSettingsForm_updateMe_Mutation($input: UpdateMeInput!) {
              updateMe(input: $input) { me { id defaultCodeshareSettings { modeName tabSize } companyImage } }
            }`,
            variables: {
              input: {
                defaultCodeshareSettings: { modeName, tabSize },
                companyImage: companyImage || null
              }
            }
          });
          showToast('Default CodeeFlow settings saved.', { duration: 3000 });
        } catch (err) {
          showToast(err.message || 'Could not save default settings.', { duration: 3500 });
        }
      });
    }

    // Delete Account Button on `/settings` (`DeleteAccountButton_deleteMe_Mutation`)
    const deleteAccountBtn = document.getElementById('delete-account-btn');
    if (deleteAccountBtn) {
      deleteAccountBtn.addEventListener('click', async () => {
        if (!window.confirm('Are you sure you want to permanently delete your account and all saved CodeeFlows?')) {
          return;
        }
        await gqlClient.request({
          operationName: 'DeleteAccountButton_deleteMe_Mutation',
          query: `mutation DeleteAccountButton_deleteMe_Mutation($input: DeleteMeInput!) { deleteMe(input: $input) { deletedMeId } }`,
          variables: { input: {} }
        });
        window.location.href = '/';
      });
    }

    // Admin Dashboard Actions (`/_/admin`)
    document.querySelectorAll('[data-admin-grant-pro]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const userId = btn.getAttribute('data-admin-grant-pro');
        await gqlClient.request({
          operationName: 'CreateSubscriptionPlanFormMutation',
          query: `mutation CreateSubscriptionPlanFormMutation($input: CreateSubscriptionPlanInput!) {
            createSubscriptionPlan(input: $input) { subscriptionPlanEdge { node { id isActive } } }
          }`,
          variables: { input: { userId, planId: 'pro' } }
        });
        window.location.reload();
      });
    });

    document.querySelectorAll('[data-admin-toggle-plan]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const planId = btn.getAttribute('data-admin-toggle-plan');
        const nextActive = btn.getAttribute('data-next-active') === 'true';
        await gqlClient.request({
          operationName: 'updateSubscriptionPlanMutation',
          query: `mutation updateSubscriptionPlanMutation($input: UpdateSubscriptionPlanInput!) {
            updateSubscriptionPlan(input: $input) { subscriptionPlan { id isActive } }
          }`,
          variables: { input: { id: planId, isActive: nextActive } }
        });
        window.location.reload();
      });
    });

    document.querySelectorAll('[data-admin-delete-plan]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const planId = btn.getAttribute('data-admin-delete-plan');
        await gqlClient.request({
          operationName: 'admin_deleteSubscriptionPlan_Mutation',
          query: `mutation admin_deleteSubscriptionPlan_Mutation($input: DeleteSubscriptionPlanInput!) {
            deleteSubscriptionPlan(input: $input) { deletedSubscriptionPlanId }
          }`,
          variables: { input: { id: planId } }
        });
        window.location.reload();
      });
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    initModernDialogs();
    initColorSchemeControls();
    initLenisSmoothScroll();
    initCodeshareRoom();
    initGlobalForms();
  });
})();

