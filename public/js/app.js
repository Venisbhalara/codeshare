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

    function syncBrowserUrlToSlug(slugValue) {
      const targetSlug = slugValue || toUrlSlug(codeshare.title, codeshare.shortId);
      if (!targetSlug) return;
      codeshare.slug = targetSlug;
      const newPath = '/' + encodeURIComponent(targetSlug);
      if (window.location.pathname !== newPath && window.history && window.history.replaceState) {
        window.history.replaceState(null, '', newPath + window.location.search + window.location.hash);
      }
      const slugPreview = document.getElementById('live-slug-preview');
      if (slugPreview && document.activeElement !== slugPreview) {
        slugPreview.textContent = targetSlug;
      }
      const shareInput = document.getElementById('share-url-input');
      if (shareInput && document.activeElement !== shareInput) {
        shareInput.value = window.location.origin + newPath;
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

    function applyTextOperationToCodeMirror(op) {
      suppressEditorChanges = true;
      cm.operation(() => {
        const doc = cm.getDoc();
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
    }

    function updatePlaceholderVisibility() {
      const isEmpty = receivedHistory.size === 0 && cm.getValue().length === 0;
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

    // Convert CodeMirror change into TextOperation
    cm.on('change', (instance, changeObj) => {
      if (suppressEditorChanges || changeObj.origin === '+remote') return;
      if (!isEditable()) return;

      // Build TextOperation from CodeMirror changeObj
      const doc = instance.getDoc();
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
    });

    // =======================================================================
    // 7. Real-Time Collaborator Cursors & Presence (`CodeshareUser`)
    // =======================================================================
    const remoteCursorWidgets = new Map(); // nodeId -> { bookmark, selectionMarker }
    const activeRoomUsers = new Map();     // nodeId -> node

    function renderRemoteCursors() {
      // Clear previous markers
      for (const markers of remoteCursorWidgets.values()) {
        if (markers.bookmark) markers.bookmark.clear();
        if (markers.selectionMarker) markers.selectionMarker.clear();
      }
      remoteCursorWidgets.clear();

      const doc = cm.getDoc();
      const docLen = doc.getValue().length;

      for (const [nodeId, uNode] of activeRoomUsers.entries()) {
        if (uNode.createdBy && uNode.createdBy.me) continue;
        if (!uNode.cursor || uNode.cursor.position < 0) continue;

        const posIdx = Math.min(docLen, Math.max(0, uNode.cursor.position));
        const endIdx = Math.min(docLen, Math.max(0, uNode.cursor.selectionEnd));
        const color = uNode.color || '#61AFEF';
        const label =
          (uNode.createdBy && uNode.createdBy.name) ||
          `Guest ${String(uNode.id).slice(-4)}`;

        const caretEl = document.createElement('span');
        caretEl.className = 'remote-caret';
        caretEl.style.setProperty('--caret-color', color);
        const flagEl = document.createElement('span');
        flagEl.className = 'remote-caret-flag';
        flagEl.style.setProperty('--caret-color', color);
        flagEl.textContent = label;
        caretEl.appendChild(flagEl);

        const headPos = doc.posFromIndex(posIdx);
        const bookmark = doc.setBookmark(headPos, {
          widget: caretEl,
          insertLeft: true
        });

        let selectionMarker = null;
        if (posIdx !== endIdx) {
          const fromPos = doc.posFromIndex(Math.min(posIdx, endIdx));
          const toPos = doc.posFromIndex(Math.max(posIdx, endIdx));
          selectionMarker = doc.markText(fromPos, toPos, {
            css: `background-color: ${color}33; border-bottom: 1px solid ${color};`
          });
        }

        remoteCursorWidgets.set(nodeId, { bookmark, selectionMarker });
      }

      // Render topbar presence strip
      const strip = document.getElementById('presence-strip');
      if (strip) {
        strip.innerHTML = '';
        for (const uNode of activeRoomUsers.values()) {
          const pill = document.createElement('div');
          pill.className = 'presence-avatar';
          const isMe = uNode.createdBy && uNode.createdBy.me;
          const customName = uNode.createdBy && uNode.createdBy.name;
          const displayName = customName
            ? isMe
              ? `${customName} (you)`
              : customName
            : isMe
            ? 'You'
            : `Guest ${String(uNode.id).slice(-3)}`;
          pill.innerHTML = `<span class="presence-swatch" style="background:${uNode.color}"></span><span>${displayName}</span>`;
          strip.appendChild(pill);
        }
      }
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
        codeshareUpdates(input: $input) { codeshare { id slug title modeName tabSize migratedAt canEdit { me userIds } } }
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
            codeshare(id: $codeshareId) { id slug title modeName tabSize migratedAt canEdit { me userIds } codeHistory(after: $codeHistoryAfter, first: $codeHistoryFirst) { edges { node { id historyId value createdAt createdBy { me userId clientId } } cursor } } }
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
      document.title = `${codeshare.title || codeshare.shortId} - Codeshare`;
      syncBrowserUrlToSlug(codeshare.slug || toUrlSlug(codeshare.title, codeshare.shortId));

      const modeSelect = document.getElementById('codeshare-mode-select');
      if (modeSelect && modeSelect.value !== codeshare.modeName) {
        modeSelect.value = codeshare.modeName;
      }
      applyLanguageMode(codeshare.modeName);

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
            updateCodeshare(input: $input) { codeshare { id slug title modeName tabSize canEdit { me userIds } } }
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

    function applyUrlSlugToTitle(rawUrlOrSlug, shouldPersist = true) {
      if (!isEditable()) return;
      const extracted = extractSlugFromUrlInput(rawUrlOrSlug);
      const nextTitle = extracted || codeshare.shortId;
      const nextSlug = toUrlSlug(nextTitle, codeshare.shortId);
      codeshare.title = nextTitle;
      codeshare.slug = nextSlug;
      if (titleInput && document.activeElement !== titleInput) {
        titleInput.value = nextTitle;
      }
      const navTitle = document.getElementById('navbar-room-title');
      if (navTitle) navTitle.textContent = nextTitle;
      document.title = `${nextTitle} - Codeshare`;
      syncBrowserUrlToSlug(nextSlug);
      if (shouldPersist) {
        throttledUpdateCodeshare({ title: nextTitle });
      }
    }

    // If browser URL path was changed directly in the address bar, sync URL -> Title on load
    const bootstrapSlug = codeshare.slug || toUrlSlug(codeshare.title, codeshare.shortId);
    if (
      initialPathSlug &&
      initialPathSlug.toLowerCase() !== String(bootstrapSlug).toLowerCase() &&
      isEditable()
    ) {
      applyUrlSlugToTitle(initialPathSlug, true);
    }

    window.addEventListener('popstate', () => {
      const pathSlug = decodeURIComponent(
        window.location.pathname.replace(/^\/+|\/+$/g, '')
      ).trim();
      if (pathSlug) {
        applyUrlSlugToTitle(pathSlug, true);
      }
    });

    if (titleInput) {
      titleInput.addEventListener('input', (e) => {
        const val = e.target.value;
        codeshare.title = val;
        const navTitle = document.getElementById('navbar-room-title');
        if (navTitle) navTitle.textContent = val || codeshare.shortId;
        document.title = `${val || codeshare.shortId} - Codeshare`;
        syncBrowserUrlToSlug(toUrlSlug(val, codeshare.shortId));
        throttledUpdateCodeshare({ title: val });
      });
    }

    if (slugPreviewEl) {
      slugPreviewEl.addEventListener('input', () => {
        applyUrlSlugToTitle(slugPreviewEl.textContent, true);
      });
      slugPreviewEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          slugPreviewEl.blur();
        }
      });
    }

    const modeSelect = document.getElementById('codeshare-mode-select');
    if (modeSelect) {
      modeSelect.addEventListener('change', (e) => {
        const modeName = e.target.value;
        codeshare.modeName = modeName;
        applyLanguageMode(modeName);
        throttledUpdateCodeshare({ modeName });
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

    // Download Button (`#codeshare-download-button`)
    const downloadBtn = document.getElementById('codeshare-download-button');
    if (downloadBtn) {
      downloadBtn.addEventListener('click', () => {
        const modeEntry =
          Catalog.MODES_BY_NAME[codeshare.modeName] || Catalog.MODES_BY_NAME['Plain Text'];
        const ext = (modeEntry.ext && modeEntry.ext[0]) || 'txt';
        const baseName = (codeshare.title || codeshare.shortId || 'codeshare')
          .replace(/[^a-zA-Z0-9_-]/g, '_');
        const blob = new Blob([cm.getValue()], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${baseName}.${ext}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      });
    }

    // Share Modal & Copy URL
    const shareBtn = document.getElementById('codeshare-share-button');
    const shareDialog = document.getElementById('share-dialog');
    const shareUrlInput = document.getElementById('share-url-input');
    const copyShareUrlBtn = document.getElementById('copy-share-url-btn');

    if (shareBtn && shareDialog) {
      shareBtn.addEventListener('click', () => {
        if (shareUrlInput) shareUrlInput.value = window.location.href;
        shareDialog.showModal();
        if (shareUrlInput) shareUrlInput.select();
      });
    }

    if (shareUrlInput) {
      shareUrlInput.addEventListener('input', (e) => {
        applyUrlSlugToTitle(e.target.value, true);
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
          showToast('Codeshare saved to your account.', { duration: 3500 });
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
          sponsorRoot.innerHTML = `<span>Please don't block our ads :( — Ad sponsors keep Codeshare free.</span>
            <button type="button" class="btn btn-ghost" style="height:22px;padding:0 8px;font-size:11px;" id="hide-ads-btn">Hide Ads</button>`;
        });
    }
  }

  // =========================================================================
  // 10. Auth Modals, Pro Checkout, Saved Codeshares (/codes), Settings & Admin
  // =========================================================================
  function initGlobalForms() {
    // Home Page "Join Existing" Room Form (`#join-existing-form`)
    const joinForm = document.getElementById('join-existing-form');
    if (joinForm) {
      joinForm.addEventListener('submit', (e) => {
        const inputEl = document.getElementById('join-room-input');
        if (!inputEl) return;
        let raw = (inputEl.value || '').trim();
        if (!raw) return;
        e.preventDefault();
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
          window.location.href = '/' + encodeURIComponent(slug);
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
          showToast('Welcome to Codeshare Pro!', { duration: 3000 });
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

    // Saved Codeshares Deletion on `/codes` (`CodeshareDeleteButton_deleteCodeshare_Mutation`)
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
          showToast('Codeshare deleted.', { duration: 2500 });
        } catch (err) {
          if (row) row.style.opacity = '1';
          showToast(err.message || 'Could not delete codeshare.', { duration: 3500 });
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

    // Default Codeshare Settings Form on `/settings` (`DefaultCodeshareSettingsForm_updateMe_Mutation`)
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
          showToast('Default codeshare settings saved.', { duration: 3000 });
        } catch (err) {
          showToast(err.message || 'Could not save default settings.', { duration: 3500 });
        }
      });
    }

    // Delete Account Button on `/settings` (`DeleteAccountButton_deleteMe_Mutation`)
    const deleteAccountBtn = document.getElementById('delete-account-btn');
    if (deleteAccountBtn) {
      deleteAccountBtn.addEventListener('click', async () => {
        if (!window.confirm('Are you sure you want to permanently delete your account and all saved codeshares?')) {
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

