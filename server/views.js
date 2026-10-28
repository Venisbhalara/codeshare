const Catalog = require('../shared/catalog');

function escapeHtml(str) {
  if (str === null || typeof str === 'undefined') return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderHead({ title, includeCodeMirror = false, theme = 'eclipse' }) {
  const safeTheme = theme === 'monokai' ? 'eclipse' : String(theme || 'eclipse');
  const themeSlug = safeTheme.split(' ')[0];
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <script>
    try {
      document.querySelector('meta[name="color-scheme"]').content = localStorage.getItem("color-scheme") ?? "light dark";
    } catch (_) {}
  </script>
  <title>${escapeHtml(title)}</title>
  <link rel="icon" type="image/svg+xml" href="/shared/logo.svg?v=v3.40.17" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:ital,wght@0,400;0,500;0,600;1,400&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
  ${
    includeCodeMirror
      ? `<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.53.2/codemirror.min.css" />
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.53.2/theme/${escapeHtml(themeSlug)}.min.css" />`
      : ''
  }
  <link rel="stylesheet" href="/-/css/styles.css?v=v3.40.17" />
</head>`;
}

function renderBrandLogo() {
  return `<span class="brand-mark" aria-hidden="true">
    <svg class="brand-logo-svg" width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path class="brand-bracket brand-bracket-left" d="M7.8 7.5L3.5 12L7.8 16.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
      <path class="brand-bracket brand-bracket-right" d="M16.2 7.5L20.5 12L16.2 16.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
      <path class="brand-flow-wave" d="M9.8 16.8C10.5 11.8 13.5 12.2 14.2 7.2" stroke="var(--brand-wave-color, #F4A27E)" stroke-width="2.2" stroke-linecap="round" />
      <circle class="brand-flow-node" cx="9.8" cy="16.8" r="1.35" fill="var(--brand-wave-color, #F4A27E)" />
      <circle class="brand-flow-node" cx="14.2" cy="7.2" r="1.35" fill="var(--brand-node-top, #FFE3CC)" />
    </svg>
  </span><span class="brand-name">Codee<span class="brand-name-accent">Flow</span></span>`;
}

function renderNavbar({ me, codeshare = null }) {
  const isAnon = !me || me.anonymous;
  const creatorCompanyImage =
    codeshare &&
    codeshare.createdBy &&
    codeshare.createdBy.user &&
    codeshare.createdBy.user.isPro &&
    codeshare.createdBy.user.companyImage
      ? codeshare.createdBy.user.companyImage
      : null;

  const isViewOnly =
    codeshare &&
    codeshare.canEdit &&
    Array.isArray(codeshare.canEdit.userIds);

  return `<header class="topbar ${codeshare ? 'topbar-workspace' : 'topbar-floating'}">
    <div class="topbar-left">
      <a href="/" class="brand-link" aria-label="CodeeFlow Home">
        ${
          creatorCompanyImage
            ? `<img src="${escapeHtml(creatorCompanyImage)}" alt="Brand Logo" style="height:26px;border-radius:6px;" />`
            : renderBrandLogo()
        }
      </a>
      ${
        codeshare
          ? `<span class="topbar-divider" aria-hidden="true">/</span>
             <div class="room-title-pill">
               <span class="dot"></span>
               <span id="navbar-room-title">${escapeHtml(codeshare.title || codeshare.shortId)}</span>
             </div>
             <span id="readonly-badge" class="brand-badge" ${isViewOnly ? '' : 'hidden'}>View-Only</span>`
          : ''
      }
    </div>
    <div class="topbar-right">
      ${codeshare ? `<div id="presence-strip" class="presence-strip"></div>` : ''}
      <button type="button" id="theme-toggle-button" data-theme-toggle class="btn btn-glass btn-icon-responsive theme-switch-btn" title="Toggle Dark / Light Theme">
        <span class="theme-switch-option if-light">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
          <span class="btn-label" aria-hidden="true">Dark</span>
          <span class="visually-hidden">Switch to dark theme</span>
        </span>
        <span class="theme-switch-option if-dark">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
          <span class="btn-label" aria-hidden="true">Light</span>
          <span class="visually-hidden">Switch to light theme</span>
        </span>
      </button>
      ${
        codeshare
          ? `<button type="button" id="codeshare-copy-button" class="btn btn-glass btn-icon-responsive" title="Copy Code (Ctrl+Shift+C)" aria-label="Copy Code">
               <svg class="copy-icon-default" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
               <svg class="copy-icon-success" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
               <span class="btn-label" id="codeshare-copy-label">Copy</span>
             </button>
             <button type="button" id="codeshare-download-button" class="btn btn-glass btn-icon-responsive" title="Download File" aria-label="Download File">
               <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
               <span class="btn-label">Download</span>
             </button>
             <button type="button" id="codeshare-settings-button" class="btn btn-glass btn-icon-responsive" aria-label="Editor Settings" title="Toggle Settings">
               <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>
               <span class="btn-label">Settings</span>
             </button>
             <button type="button" id="codeshare-share-button" class="btn btn-primary btn-pill">
               <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
               <span>Share</span>
             </button>`
          : isAnon
          ? `<a href="/login" class="btn btn-ghost btn-pill">Log In</a>
             <a href="/register" class="btn btn-primary btn-pill">Sign Up</a>`
          : `<a href="/codes" class="btn btn-ghost btn-pill">Saved Codes</a>
             <a href="/settings" class="btn btn-ghost btn-pill">${escapeHtml(me.name || me.email)}</a>
             <a href="/logout" class="btn btn-glass btn-pill">Log Out</a>`
      }
    </div>
  </header>`;
}

function renderGlobalDialogs({ me, codeshare = null }) {
  const isViewOnly =
    codeshare &&
    codeshare.canEdit &&
    Array.isArray(codeshare.canEdit.userIds);

  return `
  <!-- Share Modal (<dialog closedby="any">) -->
  <dialog id="share-dialog" closedby="any" data-lenis-prevent aria-labelledby="share-dialog-title">
    <div class="dialog-header">
      <div>
        <h2 id="share-dialog-title" class="dialog-title">Share this CodeeFlow</h2>
        <p class="dialog-subtitle">Anyone with this link will see code as it is typed in real time.</p>
      </div>
      <button type="button" data-close-dialog class="btn btn-ghost" aria-label="Close">✕</button>
    </div>
    <div class="field">
      <label for="share-url-input">Collaborative Room URL</label>
      <div class="share-url-row">
        <input id="share-url-input" type="text" class="text-input mono" value="${
          codeshare ? `/${escapeHtml(codeshare.slug || codeshare.shortId)}` : ''
        }" />
        <button type="button" id="copy-share-url-btn" class="btn btn-primary btn-pill">Copy Link</button>
      </div>
    </div>
    <label class="checkbox-row" for="view-only-checkbox">
      <input type="checkbox" id="view-only-checkbox" ${isViewOnly ? 'checked' : ''} />
      <div>
        <div style="font-weight:500;font-size:13px;">Enable View-Only Mode <span class="brand-badge" style="margin-left:6px;">Pro</span></div>
        <div style="font-size:11.5px;color:var(--text-secondary);">Prevent guests from editing code while allowing them to watch live.</div>
      </div>
    </label>
  </dialog>

  <!-- CodeeFlow Pro Checkout Modal (<dialog closedby="any">) -->
  <dialog id="pro-dialog" closedby="any" data-lenis-prevent aria-labelledby="pro-dialog-title">
    <div class="dialog-header">
      <div>
        <h2 id="pro-dialog-title" class="dialog-title">Upgrade to <em>CodeeFlow Pro</em></h2>
        <p class="dialog-subtitle">Unlock View-Only permissions, unlimited saved rooms, custom defaults, and zero ads.</p>
      </div>
      <button type="button" data-close-dialog class="btn btn-ghost" aria-label="Close">✕</button>
    </div>
    <div class="minimal-card" style="padding:18px;margin-bottom:18px;background:var(--bg-subtle);">
      <div style="display:flex;justify-content:space-between;align-items:baseline;">
        <span class="serif-display" style="font-size:24px;">CodeeFlow Pro</span>
        <span class="serif-display" style="font-size:30px;">$49 <span style="font-family:var(--font-sans);font-size:12px;color:var(--text-secondary);">/ month</span></span>
      </div>
      <ul class="plan-features" style="margin:12px 0 0;">
        <li>✓ Unlimited Saved CodeeFlows (Free limit is 20)</li>
        <li>✓ View-Only Mode access control for interviews & lectures</li>
        <li>✓ Zero advertisements for you and everyone in your rooms</li>
        <li>✓ Custom Default Language, Tab Size & Company Navbar Logo</li>
      </ul>
    </div>
    <form id="pro-checkout-form">
      <div class="field" style="margin-bottom:14px;">
        <label for="card-mock-input">Card Details (Stripe Elements Ready)</label>
        <input id="card-mock-input" type="text" class="text-input mono" value="•••• •••• •••• 4242   12/28   CVC 424" readonly />
      </div>
      <button type="submit" class="btn btn-primary" style="width:100%;height:38px;">Upgrade to Pro — $49/mth</button>
    </form>
  </dialog>

  <!-- In-Room Auth / Claim Modal (<dialog closedby="any">) -->
  <dialog id="auth-dialog" closedby="any" data-lenis-prevent aria-labelledby="auth-dialog-title">
    <div class="dialog-header">
      <div>
        <h2 id="auth-dialog-title" class="dialog-title">Save this CodeeFlow</h2>
        <p class="dialog-subtitle">Create a free account to keep this CodeeFlow permanently (anonymous rooms expire in 24 hours).</p>
      </div>
      <button type="button" data-close-dialog class="btn btn-ghost" aria-label="Close">✕</button>
    </div>
    <form data-graphql-register-form style="display:flex;flex-direction:column;gap:12px;">
      <div class="form-error-banner" style="color:var(--accent-danger);font-size:12.5px;"></div>
      <div class="field">
        <label for="modal-reg-name">Full Name</label>
        <input id="modal-reg-name" name="name" type="text" class="text-input" autocomplete="name" enterkeyhint="next" required />
      </div>
      <div class="field">
        <label for="modal-reg-email">Email Address</label>
        <input id="modal-reg-email" name="email" type="email" class="text-input" autocomplete="username" spellcheck="false" enterkeyhint="next" required aria-errormessage="modal-email-err" />
        <div id="modal-email-err" class="error-msg">Please enter a valid email address.</div>
      </div>
      <div class="field">
        <label for="modal-reg-pass">Password</label>
        <input id="modal-reg-pass" name="password" type="password" class="text-input" autocomplete="new-password" enterkeyhint="done" required minlength="6" aria-errormessage="modal-pass-err" />
        <div id="modal-pass-err" class="error-msg">Password must be at least 6 characters.</div>
      </div>
      <button type="submit" class="btn btn-primary" style="width:100%;height:38px;margin-top:4px;">Sign Up & Save CodeeFlow</button>
      <div style="text-align:center;font-size:12px;color:var(--text-secondary);margin-top:4px;">
        Already have an account? <a href="/login" style="color:var(--accent-gold);text-decoration:underline;">Log in</a>
      </div>
    </form>
  </dialog>`;
}

function renderBootstrapScripts({ me, codeshare = null, apiHeaders = {}, includeCodeMirror = false }) {
  const backendUrl = process.env.PUBLIC_BACKEND_URL || '';
  const payload = JSON.stringify({ me, codeshare, apiHeaders, backendUrl }).replace(/</g, '\\u003c');
  return `
  <script>window.__CODESHARE_BOOTSTRAP__ = ${payload};</script>
  <script src="/shared/lenis.min.js?v=v3.40.17"></script>
  <script src="/shared/ot.js?v=v3.40.17"></script>
  <script src="/shared/catalog.js?v=v3.40.17"></script>
  ${
    includeCodeMirror
      ? `<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.53.2/codemirror.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.53.2/addon/display/placeholder.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.53.2/keymap/sublime.min.js"></script>`
      : ''
  }
  <script src="/-/js/app.js?v=v3.40.17"></script>
</body>
</html>`;
}

// ============================================================================
// 1. Collaborative Room View (`/:codeshareId`)
// ============================================================================
function renderRoomPage({ me, codeshare, apiHeaders }) {
  const userTheme = 'eclipse';
  const editable = Boolean(codeshare.canEdit && codeshare.canEdit.me && !codeshare.migratedAt);
  const currentSlug = codeshare.slug || codeshare.shortId;
  const roomFiles =
    Array.isArray(codeshare.files) && codeshare.files.length
      ? codeshare.files
      : [
          {
            id: 'main',
            name: Catalog.defaultFilenameForMode(codeshare.modeName),
            modeName: codeshare.modeName || 'Plain Text'
          }
        ];

  const initialTabsHtml = roomFiles
    .map((file, idx) => {
      const isActive = idx === 0;
      const ext = file.name && file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : 'txt';
      return `<li class="editor-tab-item ${isActive ? 'active' : ''}" data-tab-id="${escapeHtml(file.id)}" role="presentation">
        <button
          type="button"
          class="editor-tab-btn mono"
          role="tab"
          aria-selected="${isActive ? 'true' : 'false'}"
          data-select-tab="${escapeHtml(file.id)}"
          title="Click to switch tab • Double-click to rename (${escapeHtml(file.modeName || 'Plain Text')})"
        >
          <span class="file-ext-dot" data-ext="${escapeHtml(ext)}" aria-hidden="true"></span>
          <span class="editor-tab-name" data-tab-name="${escapeHtml(file.id)}">${escapeHtml(file.name)}</span>
        </button>
        ${
          editable && file.id !== 'main'
            ? `<button type="button" class="editor-tab-close" data-close-tab="${escapeHtml(file.id)}" title="Delete file tab" aria-label="Delete ${escapeHtml(file.name)}">×</button>`
            : ''
        }
      </li>`;
    })
    .join('');

  return `${renderHead({
    title: `${codeshare.title || codeshare.shortId} - CodeeFlow`,
    includeCodeMirror: true,
    theme: userTheme
  })}
<body>
  <div class="workspace-shell">
    <div id="migration-banner" class="migration-banner" ${codeshare.migratedAt ? '' : 'hidden'}>
      <span>This CodeeFlow room has been migrated and locked in read-only mode. A local backup has been saved.</span>
      <a href="/new" class="btn btn-secondary" style="height:26px;">Create New CodeeFlow</a>
    </div>

    ${renderNavbar({ me, codeshare })}

    <main class="editor-stage">
      <section class="editor-canvas" data-lenis-prevent aria-label="Collaborative Code Editor">
        <div class="editor-tabs-header" role="region" aria-label="Room Files">
          <ul id="editor-tabs-list" class="editor-tabs-list" role="tablist" aria-label="Files in this room">
            ${initialTabsHtml}
          </ul>
          <button
            type="button"
            id="add-file-tab-btn"
            class="editor-tab-add-btn"
            title="Add New File Tab"
            aria-label="Add New File Tab"
            ${editable ? '' : 'hidden'}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            <span>New File</span>
          </button>
        </div>
        <div id="editor-container"></div>
        <div id="permalink-banner" class="permalink-banner" hidden aria-live="polite">
          <span class="permalink-badge mono" id="permalink-range-badge">#L1</span>
          <button type="button" id="permalink-copy-url-btn" class="permalink-action-btn" title="Copy shareable link to highlighted lines">
            <svg width="12.5" height="12.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
            <span id="permalink-copy-url-label">Copy Line Link</span>
          </button>
          <button type="button" id="permalink-copy-lines-btn" class="permalink-action-btn" title="Copy code from highlighted lines">
            <svg width="12.5" height="12.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            <span id="permalink-copy-lines-label">Copy Lines</span>
          </button>
          <button type="button" id="permalink-clear-btn" class="permalink-clear-btn" title="Clear line highlight (Esc)" aria-label="Clear line highlight">✕</button>
        </div>
        <div class="editor-status-pill" aria-live="polite">
          <span id="status-mode-label" class="mono">${escapeHtml(roomFiles[0].modeName || codeshare.modeName || 'Plain Text')}</span>
          <span class="status-dot-sep" aria-hidden="true">•</span>
          <span id="status-cursor-label" class="mono">Ln 1, Col 1</span>
          <span class="status-dot-sep" aria-hidden="true">•</span>
          <button type="button" id="status-permalink-btn" class="status-permalink-btn mono" title="Click to create & copy permalink for current line or selection (or click any line number, Shift+Click for range)">
            <svg width="11.5" height="11.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
            <span id="status-permalink-label">#L1</span>
          </button>
        </div>
        <!-- Legacy WebRTC containers preserved for structural parity -->
        <div id="local-video" hidden></div>
        <div id="remote-videos" hidden></div>
      </section>

      <aside id="editor-sidebar" class="editor-sidebar" data-lenis-prevent aria-label="Editor Settings">
        <div class="sidebar-heading">
          <span>Settings</span>
          <button type="button" id="close-sidebar-btn" class="btn btn-ghost btn-pill" style="height:28px;width:28px;padding:0;" aria-label="Close Settings">✕</button>
        </div>

        <div class="field">
          <label for="codeshare-title-input">Room Title & Custom URL</label>
          <input
            id="codeshare-title-input"
            type="text"
            class="text-input"
            value="${escapeHtml(codeshare.title || codeshare.shortId)}"
            ${editable ? '' : 'disabled'}
          />
          <span class="room-url-preview">/<span id="live-slug-preview" contenteditable="${editable ? 'true' : 'false'}" spellcheck="false" title="Edit URL slug">${escapeHtml(currentSlug)}</span></span>
        </div>
      </aside>
    </main>
  </div>

  ${renderGlobalDialogs({ me, codeshare })}
  ${renderBootstrapScripts({ me, codeshare, apiHeaders, includeCodeMirror: true })}`;
}

// ============================================================================
// 2. Landing Page (`/`, `/interview`, `/teach`)
// ============================================================================
function renderLandingPage({ me, apiHeaders, variant = 'default' }) {
  const headlineMap = {
    default: 'Share Code in <em>Real-Time</em> with Developers',
    interview: 'Technical <em>Code Interviews</em> in Real-Time',
    teach: 'Teach & Mentor <em>Live Code</em> with Students'
  };
  const subtitleMap = {
    default:
      'An online code editor for interviews, troubleshooting, teaching & more…',
    interview:
      'Set coding tasks and observe in real-time when interviewing remotely or in person. Nobody likes writing code on a whiteboard.',
    teach:
      'Share your code with students and peers then educate them. Universities and colleges around the world use CodeeFlow every day.'
  };

  return `${renderHead({ title: 'CodeeFlow — Share code in real-time with developers in your browser' })}
<body>
  ${renderNavbar({ me })}
  <main class="page-container">
    <section class="hero-section">
      <h1 class="hero-title">${headlineMap[variant] || headlineMap.default}</h1>
      <p class="hero-subtitle">${subtitleMap[variant] || subtitleMap.default}</p>

      <div class="hero-actions-wrapper">
        <div>
          <a href="/new" rel="nofollow" class="btn btn-hero-primary">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
            <span>Share Code Now</span>
          </a>
        </div>

        <div class="divider-or">or join an existing room</div>

        <form id="join-existing-form" action="/join" method="GET" class="join-room-card">
          <div class="join-room-input-group">
            <span class="join-room-prefix">codeeflow.io /</span>
            <input
              id="join-room-input"
              name="room"
              type="text"
              class="join-room-input"
              required
              placeholder="Enter room ID, custom title, or paste link (e.g. G8WoB4)"
              aria-label="Room ID or URL to join"
            />
          </div>
          <button type="submit" class="btn btn-primary btn-pill join-room-submit">Join Existing →</button>
        </form>
      </div>

      <div class="hero-disclaimer">Free to use • No sign-up required • Instant 6-char or custom named URL</div>
    </section>

    <section class="minimal-card" style="padding:0;overflow:clip;">
      <div class="studio-preview-header">
        <span class="mono" style="font-size:12px;color:var(--text-secondary);">codeeflow.io/G8WoB4 — Live Collaborative Studio</span>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <button type="button" id="home-copy-preview-btn" class="btn btn-glass btn-pill" style="height:30px;padding:0 12px;font-size:12px;">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            <span id="home-copy-preview-label">Copy Snippet</span>
          </button>
          <a href="/G8WoB4#L2-L4" class="btn btn-glass btn-pill" style="height:30px;padding:0 12px;font-size:12px;" title="Open room highlighting lines 2–4">#L2-L4</a>
          <a href="/G8WoB4" class="btn btn-glass btn-pill" style="height:30px;">Open Live Room →</a>
        </div>
      </div>
      <pre id="home-studio-preview-code" class="mono studio-preview-pre"><code><span style="color:var(--text-muted);">// Real-time Operational Transformation over WebSocket (CodeeFlow Live Engine)</span>
<span style="color:var(--accent-gold);font-weight:600;">async function</span> <span style="color:var(--accent-primary);font-weight:600;">collaborate</span>(roomId = <span style="color:var(--accent-emerald);">"G8WoB4"</span>) {
  <span style="color:var(--accent-gold);font-weight:600;">const</span> session = <span style="color:var(--accent-gold);font-weight:600;">await</span> SessionHelper.getOrCreate();
  <span style="color:var(--accent-gold);font-weight:600;">return</span> FirepadOT.connect({ roomId, checkpointInterval: <span style="color:var(--accent-gold);">100</span> });
}</code></pre>
    </section>

    <section class="feature-grid">
      <article class="minimal-card">
        <h3>Code with your team</h3>
        <p>Open a CodeeFlow editor, write or copy code, then share it with friends and colleagues. Pair program and troubleshoot together.</p>
        <div style="margin-top:16px;"><a href="/new" rel="nofollow" class="btn btn-glass btn-pill">Hack Together</a></div>
      </article>
      <article class="minimal-card">
        <h3>Interview developers</h3>
        <p>Set coding tasks and observe in real-time when interviewing remotely or in person. Nobody likes writing code on a whiteboard.</p>
        <div style="margin-top:16px;"><a href="/interview" class="btn btn-glass btn-pill">Start an Interview</a></div>
      </article>
      <article class="minimal-card">
        <h3>Teach people to program</h3>
        <p>Share your code with students and peers then educate them. Universities and colleges around the world use CodeeFlow every day.</p>
        <div style="margin-top:16px;"><a href="/teach" class="btn btn-glass btn-pill">Teach Code</a></div>
      </article>
    </section>
  </main>
  ${renderGlobalDialogs({ me })}
  ${renderBootstrapScripts({ me, apiHeaders })}`;
}

// ============================================================================
// 3. Saved CodeeFlows Dashboard (`/codes`)
// ============================================================================
function renderCodesDashboard({ me, codeshares, limitReached = false, apiHeaders }) {
  const rows = codeshares
    .map((cs) => {
      const viewOnly = Array.isArray(cs.canEdit && cs.canEdit.userIds);
      const roomHref = `/${escapeHtml(cs.slug || cs.shortId)}`;
      return `<tr>
        <th scope="row">
          <a href="${roomHref}" class="mono" style="font-weight:600;color:var(--accent-gold);">${escapeHtml(
        cs.title || cs.shortId
      )}</a>
          <span class="mono" style="font-size:11px;color:var(--text-muted);margin-left:6px;">${roomHref}</span>
          ${viewOnly ? `<span class="brand-badge" style="margin-left:8px;">View-Only</span>` : ''}
        </th>
        <td class="mono" style="font-size:12px;color:var(--text-secondary);">${escapeHtml(cs.modeName)}</td>
        <td class="mono" style="font-size:12px;color:var(--text-secondary);">${escapeHtml(
          new Date(cs.createdAt).toLocaleString()
        )}</td>
        <td class="mono" style="font-size:12px;color:var(--text-secondary);">${escapeHtml(
          new Date(cs.updatedAt || cs.createdAt).toLocaleString()
        )}</td>
        <td class="table-actions-cell">
          <a href="${roomHref}" class="btn btn-secondary btn-pill" style="height:28px;margin-right:6px;">Open</a>
          <button type="button" data-delete-codeshare="${escapeHtml(cs.id)}" class="btn btn-danger btn-pill" style="height:28px;">Delete</button>
        </td>
      </tr>`;
    })
    .join('');

  return `${renderHead({ title: 'Saved CodeeFlows - CodeeFlow' })}
<body>
  ${renderNavbar({ me })}
  <main class="page-container">
    <div class="dashboard-header">
      <div>
        <h1 class="serif-display" style="font-size:clamp(2rem,1.4rem+2.5vw,2.6rem);line-height:1.1;">Saved CodeeFlows</h1>
        <p style="color:var(--text-secondary);margin-top:4px;">
          ${
            me && me.isPro
              ? 'CodeeFlow Pro — Unlimited saved rooms active.'
              : `Free Plan — ${codeshares.length} of 20 saved rooms used.`
          }
        </p>
      </div>
      <a href="/new" rel="nofollow" class="btn btn-primary btn-pill">+ New CodeeFlow</a>
    </div>

    ${
      limitReached
        ? `<div class="minimal-card" style="margin-bottom:24px;border-color:var(--accent-gold);background:var(--accent-gold-bg);display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between;align-items:center;">
            <div>
              <strong style="color:var(--accent-gold);">Saved CodeeFlow Limit Reached (20/20)</strong>
              <p style="font-size:13px;color:var(--text-primary);margin-top:2px;">Delete an old room below or upgrade to CodeeFlow Pro for unlimited saved rooms.</p>
            </div>
            <button type="button" data-open-pro class="btn btn-primary btn-pill">Upgrade to Pro</button>
          </div>`
        : ''
    }

    <div tabindex="0" role="region" aria-label="Saved CodeeFlows directory" class="codes-table-wrap">
      <table class="codes-table codes-table-saved">
        <thead>
          <tr>
            <th>Title / Room</th>
            <th>Syntax</th>
            <th>Created</th>
            <th>Modified</th>
            <th style="text-align:right;">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${
            rows ||
            `<tr class="empty-table-row"><td colspan="5" style="text-align:center;padding:40px;color:var(--text-secondary);">No saved rooms yet. Click "+ New CodeeFlow" to create one.</td></tr>`
          }
        </tbody>
      </table>
    </div>
  </main>
  ${renderGlobalDialogs({ me })}
  ${renderBootstrapScripts({ me, apiHeaders })}`;
}

// ============================================================================
// 4. Plans & Pricing Page (`/plans`)
// ============================================================================
function renderPlansPage({ me, apiHeaders }) {
  const isPro = Boolean(me && me.isPro);
  return `${renderHead({ title: 'Plans & Pricing - CodeeFlow' })}
<body>
  ${renderNavbar({ me })}
  <main class="page-container">
    <section class="hero-section" style="margin-bottom:44px;">
      <h1 class="hero-title" style="font-size:52px;">Simple, Transparent <em>Pricing</em></h1>
      <p class="hero-subtitle">Start sharing code immediately for free, or upgrade to CodeeFlow Pro for access control and unlimited saved rooms.</p>
    </section>

    <div class="plans-grid">
      <div class="minimal-card">
        <div class="mono" style="font-size:11px;text-transform:uppercase;color:var(--text-muted);">Standard</div>
        <h2 class="serif-display" style="font-size:32px;margin-top:4px;">CodeeFlow Free</h2>
        <div class="plan-price">$0 <span>/ month</span></div>
        <ul class="plan-features">
          <li>✓ Up to 20 Saved CodeeFlows</li>
          <li>✓ Unlimited Real-Time Collaborators</li>
          <li>✓ All 115 Syntax Modes & 47 Themes</li>
          <li>✓ Ad-supported footer</li>
        </ul>
        <a href="/new" rel="nofollow" class="btn btn-secondary" style="width:100%;height:40px;">Create Free CodeeFlow</a>
      </div>

      <div class="minimal-card" style="border-color:var(--accent-gold);">
        <div class="mono" style="font-size:11px;text-transform:uppercase;color:var(--accent-gold);">Most Popular</div>
        <h2 class="serif-display" style="font-size:32px;margin-top:4px;">CodeeFlow Pro</h2>
        <div class="plan-price">$49 <span>/ month</span></div>
        <ul class="plan-features">
          <li>✓ <strong>Unlimited</strong> Saved CodeeFlows</li>
          <li>✓ <strong>View-Only Mode</strong> (lock rooms for guests)</li>
          <li>✓ <strong>No Ads</strong> for you and all room visitors</li>
          <li>✓ <strong>Default CodeeFlow Settings</strong> & Custom Logo</li>
        </ul>
        ${
          isPro
            ? `<button type="button" class="btn btn-gold" style="width:100%;height:40px;" disabled>Current Plan (Active)</button>`
            : `<button type="button" data-open-pro class="btn btn-primary" style="width:100%;height:40px;">Upgrade to Pro</button>`
        }
      </div>
    </div>
  </main>
  ${renderGlobalDialogs({ me })}
  ${renderBootstrapScripts({ me, apiHeaders })}`;
}

// ============================================================================
// 5. User Settings Page (`/settings`)
// ============================================================================
function renderSettingsPage({ me, apiHeaders }) {
  const defMode =
    (me.defaultCodeshareSettings && me.defaultCodeshareSettings.modeName) || 'Plain Text';
  const defTab =
    (me.defaultCodeshareSettings && me.defaultCodeshareSettings.tabSize) || '2';

  const modeOptions = Catalog.MODES.map(
    (m) =>
      `<option value="${escapeHtml(m.name)}" ${
        m.name === defMode ? 'selected' : ''
      }>${escapeHtml(m.name)}</option>`
  ).join('');

  const tabOptions = Catalog.TAB_SIZES.map(
    (t) =>
      `<option value="${escapeHtml(t)}" ${
        String(t) === String(defTab) ? 'selected' : ''
      }>${escapeHtml(t)} spaces</option>`
  ).join('');

  return `${renderHead({ title: 'Account Settings - CodeeFlow' })}
<body>
  ${renderNavbar({ me })}
  <main class="page-container" style="max-width:680px;">
    <h1 class="serif-display" style="font-size:40px;margin-bottom:28px;">Account Settings</h1>

    <section class="minimal-card" style="margin-bottom:24px;">
      <h2 class="serif-display" style="font-size:26px;margin-bottom:16px;">Profile & Credentials</h2>
      <form id="user-settings-form" style="display:flex;flex-direction:column;gap:14px;">
        <div class="field">
          <label for="settings-name">Full Name</label>
          <input id="settings-name" name="name" type="text" class="text-input" required value="${escapeHtml(
            me.name || ''
          )}" />
        </div>
        <div class="field">
          <label for="settings-email">Email Address</label>
          <span id="settings-email-hint" class="hint">Format: you@domain.com</span>
          <input id="settings-email" name="email" type="email" class="text-input" required aria-describedby="settings-email-hint" value="${escapeHtml(
            me.email || ''
          )}" />
        </div>
        <div class="field">
          <label for="settings-pass">New Password (leave blank to keep current)</label>
          <input id="settings-pass" name="password" type="password" class="text-input" minlength="6" placeholder="••••••••" />
        </div>
        <div>
          <button type="submit" class="btn btn-primary">Save Profile</button>
        </div>
      </form>
    </section>

    <section class="minimal-card" style="margin-bottom:24px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <h2 class="serif-display" style="font-size:26px;">Default CodeeFlow Settings</h2>
        <span class="brand-badge">Pro Feature</span>
      </div>
      <form id="default-codeshare-settings-form" style="display:flex;flex-direction:column;gap:14px;">
        <div class="field">
          <label for="def-mode-select">Default Syntax Mode for New Rooms</label>
          <select id="def-mode-select" name="modeName" class="brand-select" ${me.isPro ? '' : 'disabled'}>
            <button><selectedcontent></selectedcontent></button>
            ${modeOptions}
          </select>
        </div>
        <div class="field">
          <label for="def-tab-select">Default Tab Size</label>
          <select id="def-tab-select" name="tabSize" class="brand-select" ${me.isPro ? '' : 'disabled'}>
            <button><selectedcontent></selectedcontent></button>
            ${tabOptions}
          </select>
        </div>
        <div class="field">
          <label for="def-logo-input">Custom Company Logo URL (Navbar Branding)</label>
          <input id="def-logo-input" name="companyImage" type="url" class="text-input" placeholder="https://example.com/logo.svg" value="${escapeHtml(
            me.companyImage || ''
          )}" ${me.isPro ? '' : 'disabled'} />
        </div>
        <div>
          ${
            me.isPro
              ? `<button type="submit" class="btn btn-primary">Save Default Settings</button>`
              : `<button type="button" data-open-pro class="btn btn-gold">Upgrade to Pro to Customize Defaults</button>`
          }
        </div>
      </form>
    </section>

    <section class="minimal-card" style="border-color:rgba(248,113,113,0.3);">
      <h2 class="serif-display" style="font-size:24px;color:var(--accent-danger);margin-bottom:8px;">Danger Zone</h2>
      <p style="font-size:13px;color:var(--text-secondary);margin-bottom:16px;">Permanently delete your account and all saved CodeeFlows.</p>
      <button type="button" id="delete-account-btn" class="btn btn-danger">Delete My Account</button>
    </section>
  </main>
  ${renderGlobalDialogs({ me })}
  ${renderBootstrapScripts({ me, apiHeaders })}`;
}

// ============================================================================
// 6. Auth Pages (`/login`, `/register`) & Internal Admin (`/_/admin`)
// ============================================================================
function renderAuthPage({ me, mode = 'login', saveCodeshare = null, apiHeaders }) {
  const isLogin = mode === 'login';
  const redirectUrl = saveCodeshare ? `/${encodeURIComponent(saveCodeshare)}` : '/codes';

  return `${renderHead({ title: `${isLogin ? 'Log In' : 'Sign Up'} - CodeeFlow` })}
<body>
  ${renderNavbar({ me })}
  <main class="page-container" style="max-width:440px;">
    <div class="minimal-card">
      <h1 class="serif-display" style="font-size:34px;margin-bottom:6px;">${
        isLogin ? 'Welcome back' : 'Create your account'
      }</h1>
      <p style="color:var(--text-secondary);font-size:13px;margin-bottom:20px;">
        ${
          isLogin
            ? 'Sign in to access your saved CodeeFlow rooms and preferences.'
            : 'Save your CodeeFlows permanently and access them from anywhere.'
        }
      </p>
      <form ${
        isLogin ? 'data-graphql-login-form' : 'data-graphql-register-form'
      } data-redirect="${escapeHtml(redirectUrl)}" style="display:flex;flex-direction:column;gap:14px;">
        <div class="form-error-banner" style="color:var(--accent-danger);font-size:12.5px;"></div>
        ${
          !isLogin
            ? `<div class="field">
                <label for="auth-name">Full Name</label>
                <input id="auth-name" name="name" type="text" class="text-input" autocomplete="name" enterkeyhint="next" required />
              </div>`
            : ''
        }
        <div class="field">
          <label for="auth-email">Email Address</label>
          <input id="auth-email" name="email" type="email" class="text-input" autocomplete="username" spellcheck="false" enterkeyhint="next" required aria-errormessage="auth-email-err" />
          <div id="auth-email-err" class="error-msg">Please enter a valid email address.</div>
        </div>
        <div class="field">
          <label for="auth-pass">Password</label>
          <input id="auth-pass" name="password" type="password" class="text-input" autocomplete="${
            isLogin ? 'current-password' : 'new-password'
          }" enterkeyhint="done" required minlength="6" aria-errormessage="auth-pass-err" />
          <div id="auth-pass-err" class="error-msg">Password must be at least 6 characters.</div>
        </div>
        <button type="submit" class="btn btn-primary" style="width:100%;height:38px;margin-top:4px;">
          ${isLogin ? 'Log In' : 'Create Account'}
        </button>
      </form>
      <div style="text-align:center;font-size:12.5px;color:var(--text-secondary);margin-top:16px;">
        ${
          isLogin
            ? `Don't have an account? <a href="/register" style="color:var(--accent-gold);text-decoration:underline;">Sign up</a>`
            : `Already have an account? <a href="/login" style="color:var(--accent-gold);text-decoration:underline;">Log in</a>`
        }
      </div>
    </div>
  </main>
  ${renderGlobalDialogs({ me })}
  ${renderBootstrapScripts({ me, apiHeaders })}`;
}

function renderAdminPage({ me, searchedEmail, targetUser, apiHeaders }) {
  const planRows =
    targetUser && targetUser.subscriptionPlans && targetUser.subscriptionPlans.edges
      ? targetUser.subscriptionPlans.edges
          .map(
            (e) => `<tr>
              <th scope="row" class="mono">${escapeHtml(e.node.id)}</th>
              <td class="mono">${escapeHtml(e.node.planId)}</td>
              <td>${e.node.isActive ? '<span style="color:var(--accent-emerald);">Active</span>' : 'Inactive'}</td>
              <td class="table-actions-cell">
                <button type="button" data-admin-toggle-plan="${escapeHtml(e.node.id)}" data-next-active="${!e.node.isActive}" class="btn btn-secondary btn-pill" style="height:26px;">
                  ${e.node.isActive ? 'Deactivate' : 'Activate'}
                </button>
                <button type="button" data-admin-delete-plan="${escapeHtml(e.node.id)}" class="btn btn-danger btn-pill" style="height:26px;">Delete</button>
              </td>
            </tr>`
          )
          .join('')
      : '';

  return `${renderHead({ title: 'Internal Admin - CodeeFlow' })}
<body>
  ${renderNavbar({ me })}
  <main class="page-container" style="max-width:760px;">
    <h1 class="serif-display" style="font-size:clamp(1.8rem,1.4rem+2vw,2.4rem);margin-bottom:6px;">Internal Subscription Admin (<code>/_/admin</code>)</h1>
    <p style="color:var(--text-secondary);margin-bottom:24px;">Search users by email (e.g. <code>demo@codeeflow.io</code>) and manage their CodeeFlow Pro subscription plans.</p>

    <form method="GET" action="/_/admin" class="share-url-row" style="margin-bottom:24px;">
      <input name="email" type="email" class="text-input" placeholder="demo@codeeflow.io" value="${escapeHtml(
        searchedEmail || 'demo@codeeflow.io'
      )}" required />
      <button type="submit" class="btn btn-primary btn-pill">Lookup User</button>
    </form>

    ${
      targetUser
        ? `<div class="minimal-card">
            <div class="dashboard-header" style="margin-bottom:16px;">
              <div>
                <h2 class="serif-display" style="font-size:26px;">${escapeHtml(targetUser.name || targetUser.email)}</h2>
                <div class="mono" style="font-size:12px;color:var(--text-secondary);word-break:break-all;">${escapeHtml(targetUser.email)} • ${escapeHtml(targetUser.id)}</div>
              </div>
              <button type="button" data-admin-grant-pro="${escapeHtml(targetUser.id)}" class="btn btn-gold btn-pill">+ Grant Pro Plan</button>
            </div>
            <div tabindex="0" role="region" aria-label="User subscription plans" class="codes-table-wrap">
              <table class="codes-table codes-table-admin">
                <thead>
                  <tr><th>Plan ID</th><th>Tier</th><th>Status</th><th style="text-align:right;">Actions</th></tr>
                </thead>
                <tbody>
                  ${planRows || `<tr class="empty-table-row"><td colspan="4" style="text-align:center;color:var(--text-secondary);">No subscription plans on this user.</td></tr>`}
                </tbody>
              </table>
            </div>
          </div>`
        : searchedEmail
        ? `<div class="minimal-card">No user found with email <code>${escapeHtml(searchedEmail)}</code>.</div>`
        : ''
    }
  </main>
  ${renderGlobalDialogs({ me })}
  ${renderBootstrapScripts({ me, apiHeaders })}`;
}

module.exports = {
  renderRoomPage,
  renderLandingPage,
  renderCodesDashboard,
  renderPlansPage,
  renderSettingsPage,
  renderAuthPage,
  renderAdminPage
};

