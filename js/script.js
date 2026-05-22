// Global safety net — prevents unhandled promise crashes
window.addEventListener('unhandledrejection', e => {
    console.warn('PostPrint caught unhandled rejection:', e.reason);
    e.preventDefault();
});

document.addEventListener('DOMContentLoaded', async () => {

    // ════════════════════════════════════════════════════════════════════
    //  CONFIG — fill these in after reading supabase_setup.md
    // ════════════════════════════════════════════════════════════════════
    const SUPABASE_URL  = 'https://cmsymypjgzjhllobozts.supabase.co';
    const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNtc3lteXBqZ3pqaGxsb2JvenRzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk0MzU4NzgsImV4cCI6MjA5NTAxMTg3OH0.5ezb1BQQOOA0iKzgz84CUfjcK8Z9q4h5icMvzWQytss';
    const UPI_ID        = 'himanshu.lawliet@okicici';
    const CREATOR_EMAIL = 'himanshu.cosmos9@gmail.com';
    const PRICE_INR     = 1000;
    const FREE_LIMIT    = 12;

    // ════════════════════════════════════════════════════════════════════
    //  SUPABASE CLIENT
    //  Falls back to localStorage-only if credentials aren't set yet
    // ════════════════════════════════════════════════════════════════════
    const SB_OK = SUPABASE_URL !== 'YOUR_SUPABASE_URL' && SUPABASE_ANON !== 'YOUR_SUPABASE_ANON_KEY';
    let sb = null;
    if (SB_OK && window.supabase) {
        sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
    }

    // ── Auth state ────────────────────────────────────────────────────
    let currentUser = null;
    let userProfile = null;  // { id, email, uses, paid_until }

    // ── Profile helpers ───────────────────────────────────────────────
    const loadProfile = async () => {
        if (!sb || !currentUser) return null;
        try {
            const { data, error } = await sb.from('profiles').select('*').eq('id', currentUser.id).single();
            if (error) return null;
            return data || null;
        } catch(e) { return null; }
    };

    const ensureProfile = async () => {
        if (!sb || !currentUser) return null;
        try {
            let prof = await loadProfile();
            if (!prof) {
                const anonUses = getLocalUses();
                const { data } = await sb.from('profiles')
                    .insert({ id: currentUser.id, email: currentUser.email, uses: anonUses })
                    .select().single();
                prof = data || null;
            }
            return prof;
        } catch(e) { console.warn('ensureProfile failed:', e); return null; }
    };

    const refreshProfile = async () => {
        userProfile = await loadProfile();
        return userProfile;
    };

    // ── Subscription checks ───────────────────────────────────────────
    const isSubscribed = async () => {
        try {
            if (!sb || !currentUser) {
                const until = parseInt(localStorage.getItem('pp_paid_until') || '0', 10);
                return Date.now() < until;
            }
            if (!userProfile) userProfile = await loadProfile();
            return !!(userProfile?.paid_until && new Date(userProfile.paid_until) > new Date());
        } catch(e) { return false; }
    };

    const markPaidInDB = async () => {
        const paidUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        localStorage.setItem('pp_paid_until', Date.now() + 30 * 24 * 60 * 60 * 1000); // always set local fallback
        if (sb && currentUser) {
            try {
                const { data } = await sb.from('profiles')
                    .update({ paid_until: paidUntil })
                    .eq('id', currentUser.id).select().single();
                if (data) userProfile = data;
            } catch(e) { console.warn('markPaidInDB DB write failed, local fallback active:', e); }
        }
    };

    // ── Usage tracking ────────────────────────────────────────────────
    const getLocalUses = () => parseInt(localStorage.getItem('pp_uses') || '0', 10);
    const addLocalUse  = () => localStorage.setItem('pp_uses', getLocalUses() + 1);

    const incrementUses = async () => {
        if (sb && currentUser) {
            const uses = (userProfile?.uses || 0) + 1;
            const { data } = await sb.from('profiles')
                .update({ uses }).eq('id', currentUser.id).select().single();
            userProfile = data;
        } else {
            addLocalUse();
        }
    };

    // ── Gate status ───────────────────────────────────────────────────
    const getGateStatus = async () => {
        try {
            // Always check localStorage first (works offline too)
            const localPaid = parseInt(localStorage.getItem('pp_paid_until') || '0', 10);
            if (Date.now() < localPaid) return 'ok'; // locally marked as paid

            if (!SB_OK || !currentUser) {
                // Anonymous / no Supabase
                return getLocalUses() < FREE_LIMIT ? 'ok' : 'needs-auth';
            }

            // Signed-in user with Supabase
            let subscribed = false;
            try { subscribed = await isSubscribed(); } catch(e) {}
            if (subscribed) return 'ok';

            // Get uses count — never let a Supabase error block the download
            let uses = 0;
            try {
                if (!userProfile) userProfile = await loadProfile();
                uses = userProfile?.uses ?? 0;
            } catch(e) { uses = getLocalUses(); } // fallback to local count

            return uses < FREE_LIMIT ? 'ok' : 'needs-payment';
        } catch(e) {
            console.warn('getGateStatus error, defaulting ok:', e);
            return 'ok'; // fail open — never block a download due to a code error
        }
    };

    // ── Gated download ────────────────────────────────────────────────
    const gatedDownload = async (fn) => {
        let status = 'ok';
        try { status = await getGateStatus(); } catch(e) {}
        if (status === 'ok') {
            await executeDownload(fn);
        } else if (status === 'needs-auth') {
            window._pendingDownload = fn;
            try { showAuthModal(); } catch(e) { fn(); } // if modal fails, just download
        } else {
            window._pendingDownload = fn;
            try { showPaywall(); } catch(e) { fn(); }
        }
    };

    const executeDownload = async (fn) => {
        window._onDownloadSuccess = async () => {
            window._onDownloadSuccess = null; // single-use
            try { await incrementUses(); } catch(e) {}
            try { updateUseBadge(); } catch(e) {}
        };
        try {
            fn();
        } catch(e) {
            window._onDownloadSuccess = null;
            console.warn('printFn threw:', e);
        }
    };

    // ════════════════════════════════════════════════════════════════════
    //  SUPABASE AUTH SETUP
    // ════════════════════════════════════════════════════════════════════
    if (sb) {
        // Check existing session on page load
        const { data: { session } } = await sb.auth.getSession();
        if (session?.user) {
            currentUser = session.user;
            userProfile = await ensureProfile();
        }

        // Listen for auth state changes (magic link redirect fires this)
        sb.auth.onAuthStateChange(async (event, session) => {
            try {
                if (event === 'SIGNED_IN' && session?.user) {
                    currentUser = session.user;
                    try { userProfile = await ensureProfile(); } catch(e) {}
                    try { updateNavUser(); } catch(e) {}
                    try { await updateUseBadge(); } catch(e) {}
                    try { hideAuthModal(); } catch(e) {}
                    if (window._pendingDownload) {
                        let st = 'ok';
                        try { st = await getGateStatus(); } catch(e) {}
                        if (st === 'ok') {
                            const fn = window._pendingDownload;
                            window._pendingDownload = null;
                            try { await executeDownload(fn); } catch(e) { fn(); }
                        } else if (st === 'needs-payment') {
                            try { showPaywall(); } catch(e) {}
                        }
                    }
                } else if (event === 'SIGNED_OUT') {
                    currentUser = null; userProfile = null;
                    try { updateNavUser(); } catch(e) {}
                    try { updateUseBadge(); } catch(e) {}
                }
            } catch(e) { console.warn('onAuthStateChange error (non-fatal):', e); }
        });
    }

    // ════════════════════════════════════════════════════════════════════
    //  NAV USER UI
    // ════════════════════════════════════════════════════════════════════
    const updateNavUser = () => {
        const wrap = document.getElementById('nav-user-wrap');
        if (!wrap) return;

        if (currentUser) {
            const initial  = (currentUser.email || 'U').charAt(0).toUpperCase();
            const subActive = userProfile?.paid_until && new Date(userProfile.paid_until) > new Date();
            wrap.innerHTML = `
                <div class="nav-avatar${subActive ? ' nav-avatar--paid' : ''}"
                     title="${currentUser.email}">${initial}</div>
                <button class="nav-signout" id="nav-signout-btn">Sign out</button>`;
            document.getElementById('nav-signout-btn')?.addEventListener('click', signOut);
        } else {
            wrap.innerHTML = `<button class="nav-signin" id="nav-signin-btn">Sign in</button>`;
            document.getElementById('nav-signin-btn')?.addEventListener('click', showAuthModal);
        }
    };

    const signOut = async () => {
        if (sb) await sb.auth.signOut();
        else { currentUser = null; updateNavUser(); updateUseBadge(); }
    };

    // ════════════════════════════════════════════════════════════════════
    //  USE-COUNTER BADGE
    // ════════════════════════════════════════════════════════════════════
    const updateUseBadge = async () => {
        try {
            const el = document.getElementById('use-counter');
            if (!el) return;
            if (currentUser && SB_OK) {
                const subscribed = await isSubscribed().catch(() => false);
                if (subscribed) {
                    const until = userProfile?.paid_until ? new Date(userProfile.paid_until) : null;
                    const d = until ? until.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '30 days';
                    el.textContent = `✓ Subscribed until ${d}`;
                    el.className = 'use-counter paid';
                    return;
                }
                const uses = userProfile?.uses || 0;
                const left = Math.max(0, FREE_LIMIT - uses);
                el.textContent = left === 0 ? '⚠ Subscribe to continue' : `${left} free downloads left`;
                el.className = `use-counter${left <= 3 && left > 0 ? ' warn' : ''}${left === 0 ? ' danger' : ''}`;
            } else {
                const left = Math.max(0, FREE_LIMIT - getLocalUses());
                el.textContent = left === 0 ? '⚠ Sign in to continue' : `${left} free downloads left`;
                el.className = `use-counter${left <= 3 && left > 0 ? ' warn' : ''}${left === 0 ? ' danger' : ''}`;
            }
        } catch(e) { /* badge is non-critical */ }
    };

    // ════════════════════════════════════════════════════════════════════
    //  AUTH MODAL
    // ════════════════════════════════════════════════════════════════════
    const showAuthModal = () => {
        resetAuthForm();
        document.getElementById('auth-overlay')?.classList.add('open');
        document.body.style.overflow = 'hidden';
        setTimeout(() => document.getElementById('auth-email')?.focus(), 150);
    };
    const hideAuthModal = () => {
        document.getElementById('auth-overlay')?.classList.remove('open');
        document.body.style.overflow = '';
    };
    const resetAuthForm = () => {
        document.getElementById('auth-step-1')?.classList.remove('hidden');
        document.getElementById('auth-step-2')?.classList.add('hidden');
        const em = document.getElementById('auth-email');
        if (em) em.value = '';
        const err = document.getElementById('auth-error');
        if (err) err.textContent = '';
        const btn = document.getElementById('auth-send-btn');
        if (btn) { btn.textContent = 'Send magic link →'; btn.disabled = false; }
    };

    document.getElementById('auth-close')?.addEventListener('click', hideAuthModal);
    document.getElementById('auth-overlay')?.addEventListener('click', e => {
        if (e.target.id === 'auth-overlay') hideAuthModal();
    });

    // Send magic link
    document.getElementById('auth-send-btn')?.addEventListener('click', async () => {
        const email  = document.getElementById('auth-email')?.value.trim();
        const errEl  = document.getElementById('auth-error');
        const btn    = document.getElementById('auth-send-btn');

        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            errEl.textContent = 'Please enter a valid email address.';
            return;
        }

        if (!SB_OK || !sb) {
            errEl.textContent = 'Auth not configured yet. Using free mode.';
            return;
        }

        errEl.textContent = '';
        btn.textContent = 'Sending…';
        btn.disabled = true;

        const { error } = await sb.auth.signInWithOtp({
            email,
            options: {
                emailRedirectTo: window.location.origin,
                redirectTo: window.location.origin,
                shouldCreateUser: true,
            },
        });

        if (error) {
            errEl.textContent = error.message;
            btn.textContent = 'Send magic link →';
            btn.disabled = false;
            return;
        }

        // Show step 2
        document.getElementById('auth-step-1').classList.add('hidden');
        document.getElementById('auth-step-2').classList.remove('hidden');
        document.getElementById('auth-sent-email').textContent = email;
    });

    // "Use different email" — go back
    // Enter key fires send immediately
    document.getElementById('auth-email')?.addEventListener('keydown', e => {
        if (e.key === 'Enter') document.getElementById('auth-send-btn')?.click();
    });

    document.getElementById('auth-resend')?.addEventListener('click', resetAuthForm);

    // ════════════════════════════════════════════════════════════════════
    //  PAYWALL MODAL
    // ════════════════════════════════════════════════════════════════════
    const showPaywall = () => {
        const overlay = document.getElementById('paywall-overlay');
        if (!overlay) return;

        // Populate dynamic fields
        const uses = currentUser ? (userProfile?.uses || 0) : getLocalUses();
        const usesEl = document.getElementById('pw-uses');
        if (usesEl) usesEl.textContent = uses;

        const emailEl = document.getElementById('pw-user-email');
        const emailRow = document.getElementById('pw-user-email-row');
        if (emailEl && currentUser?.email) {
            emailEl.textContent = currentUser.email;
            if (emailRow) emailRow.style.display = 'block';
        }
        const confirmEl = document.getElementById('pw-confirm-email');
        if (confirmEl) confirmEl.textContent = currentUser?.email || 'your email';

        overlay.classList.add('open');
        document.body.style.overflow = 'hidden';
    };
    const hidePaywall = () => {
        document.getElementById('paywall-overlay')?.classList.remove('open');
        document.body.style.overflow = '';
    };

    document.getElementById('pw-close')?.addEventListener('click', hidePaywall);
    document.getElementById('paywall-overlay')?.addEventListener('click', e => {
        if (e.target.id === 'paywall-overlay') hidePaywall();
    });

    // Copy UPI
    document.getElementById('pw-copy-upi')?.addEventListener('click', () => {
        navigator.clipboard.writeText(UPI_ID).then(() => {
            const btn = document.getElementById('pw-copy-upi');
            const orig = btn.innerHTML;
            btn.innerHTML = '✓ Copied!';
            setTimeout(() => { btn.innerHTML = orig; }, 1600);
        });
    });

    // "I've Paid" — honor system, mark paid in DB
    document.getElementById('pw-paid-btn')?.addEventListener('click', async () => {
        const btn = document.getElementById('pw-paid-btn');
        btn.innerHTML = '<span class="pw-spinner"></span> Confirming…';
        btn.disabled = true;

        await markPaidInDB();
        await updateUseBadge();
        updateNavUser();
        hidePaywall();

        // Show thank-you toast
        showToast('🎉 Subscribed! Enjoy unlimited downloads for 30 days.');

        // Resume pending download
        if (window._pendingDownload) {
            const fn = window._pendingDownload;
            window._pendingDownload = null;
            await executeDownload(fn);
        }

        btn.innerHTML = '✓ I\'ve Paid — Unlock for 30 Days';
        btn.disabled = false;
    });

    // ── Toast helper ──────────────────────────────────────────────────
    const showToast = (msg) => {
        let t = document.getElementById('pp-toast');
        if (!t) {
            t = document.createElement('div');
            t.id = 'pp-toast';
            t.className = 'pp-toast';
            document.body.appendChild(t);
        }
        t.textContent = msg;
        t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 3500);
    };

    // ════════════════════════════════════════════════════════════════════
    //  LAYOUT MODES
    // ════════════════════════════════════════════════════════════════════
    const paperContainer = document.getElementById('paper-container');
    const zoomLevelEl   = document.getElementById('zoom-level');

    let layoutMode = 'fill';

    const LAYOUT_HINTS = {
        exact: 'Natural tweet size on A4',
        fill:  'Expands to fill one A4 page',
        multi: 'Flows to multiple pages',
    };

    document.querySelectorAll('.layout-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            layoutMode = btn.dataset.mode;
            document.querySelectorAll('.layout-btn').forEach(b => b.classList.toggle('active', b === btn));
            const hint = document.getElementById('layout-hint');
            if (hint) hint.textContent = LAYOUT_HINTS[layoutMode] || '';
            if (paperContainer.children.length && window._lastRenderArgs) {
                renderPages(window._lastRenderArgs);
            }
        });
    });

    // ── Zoom ──────────────────────────────────────────────────────────
    const A4_PX_WIDTH = 794;
    const calcInitialZoom = () => {
        const scroll = document.querySelector('.paper-scroll');
        if (!scroll) return 65;
        const avail = scroll.clientWidth - 48;
        return Math.min(Math.max(Math.floor((avail / A4_PX_WIDTH) * 100), 22), 100);
    };
    let zoomLevel = calcInitialZoom();

    const updateZoom = () => {
        zoomLevelEl.textContent = `${zoomLevel}%`;
        paperContainer.style.transform = `scale(${zoomLevel / 100})`;
    };
    updateZoom();
    document.getElementById('zoom-in')?.addEventListener('click',  () => { if (zoomLevel < 150) { zoomLevel += 10; updateZoom(); } });
    document.getElementById('zoom-out')?.addEventListener('click', () => { if (zoomLevel > 20)  { zoomLevel -= 10; updateZoom(); } });
    window.addEventListener('resize', () => { zoomLevel = calcInitialZoom(); updateZoom(); });

    // ── Shared constants ──────────────────────────────────────────────
    const X_ICON = `<svg viewBox="0 0 24 24" width="20" height="20" fill="#000"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`;
    const A4_H = 1123, PAD_PX = 76, USABLE = A4_H - PAD_PX * 2;

    const fmtDate = () => new Date().toLocaleDateString('en-US', {
        hour: 'numeric', minute: 'numeric', month: 'short', day: 'numeric', year: 'numeric'
    });

    // ── HTML builders ─────────────────────────────────────────────────
    const buildHeader = (name, handle, avatarHTML) => `
        <div class="post-header">
            <div class="avatar">${avatarHTML}</div>
            <div class="author-info"><h3>${name}</h3><p>${handle}</p></div>
            <div class="brand-icon">${X_ICON}</div>
        </div>`;

    const buildFooter = (dateStr, showBrand = true) => `
        <div class="post-footer"><span>${dateStr}</span><span>·</span><span>PostPrint</span></div>
        ${showBrand ? `<div class="brand-footer">
            <div class="brand-footer-quote">&ldquo;i hope you use this to surround yourself with misfits, rebels and the absolute delusional people, let these thoughts sink in you like a sponge &mdash; making you one with the thoughts, leading improvement in your life.&rdquo;</div>
            <div class="brand-footer-author"><span class="brand-name">Himanshu Sharma</span><span class="brand-handle">@himanshucosmos</span></div>
        </div>` : ''}`;

    const createMeasurer = (extra = '') => {
        const el = document.createElement('div');
        el.style.cssText = `position:absolute;top:-9999px;left:-9999px;visibility:hidden;pointer-events:none;
            width:614px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
            line-height:1.65;padding:28px;border:1px solid #e4e6ea;border-radius:16px;${extra}`;
        document.body.appendChild(el);
        return el;
    };

    // MODE: Exact - always exactly 1 full A4 page, fills the whole sheet
    // Short tweet = huge poster font. Long tweet = shrunk to fit. Always 1 page.
    const renderExact = ({ name, handle, avatarHTML, text, dateStr, showBrand }) => {
        paperContainer.innerHTML = '';
        const paras   = text.split('\n').filter(p => p.trim());
        const hdrHTML = buildHeader(name, handle, avatarHTML);
        const ftrHTML = buildFooter(dateStr, showBrand);
        const BODY_BUDGET = A4_H - 88 - 80 - 90;
        const m = createMeasurer('font-size:22px;width:580px;');
        let lo = 9, hi = 88, best = 9;
        while (lo <= hi) {
            const mid = Math.floor((lo + hi) / 2);
            m.style.cssText = `position:absolute;top:-9999px;left:-9999px;visibility:hidden;width:580px;font-size:${mid}px;line-height:1.5;font-family:-apple-system,sans-serif;`;
            m.innerHTML = paras.map(p => `<p style="margin-bottom:${Math.round(mid * 0.35)}px">${p}</p>`).join('');
            if (m.offsetHeight <= BODY_BUDGET) { best = mid; lo = mid + 1; } else hi = mid - 1;
        }
        document.body.removeChild(m);
        const page = document.createElement('div');
        page.className = 'a4-page';
        page.style.cssText = 'height:297mm;min-height:297mm;max-height:297mm;overflow:hidden;';
        const card = document.createElement('div');
        card.className = 'post-card';
        card.style.cssText = 'margin:44px 40px;height:calc(297mm - 88px);display:flex;flex-direction:column;justify-content:space-between;box-sizing:border-box;';
        card.innerHTML = `${hdrHTML}
            <div class="post-body" style="flex:1;display:flex;flex-direction:column;justify-content:center;overflow:hidden;padding:10px 0">
                ${paras.map(p => `<p style="font-size:${best}px;line-height:1.5;margin-bottom:${Math.round(best * 0.35)}px">${p}</p>`).join('')}
            </div>
            ${ftrHTML}`;
        page.appendChild(card);
        paperContainer.appendChild(page);
        return 1;
    };

    // MODE: Fill - pleasant editorial, largest comfortable font, 1 page
    const renderFill = ({ name, handle, avatarHTML, text, dateStr, showBrand }) => {
        paperContainer.innerHTML = '';
        const paras   = text.split('\n').filter(p => p.trim());
        const hdrHTML = buildHeader(name, handle, avatarHTML);
        const ftrHTML = buildFooter(dateStr, showBrand);
        const TARGET  = USABLE - 140;
        const m = createMeasurer('font-size:32px;');
        let best = 14;
        for (let size = 32; size >= 14; size--) {
            m.style.fontSize = size + 'px';
            m.innerHTML = `${hdrHTML}<div class="post-body">${paras.map(p => `<p style="line-height:1.65">${p}</p>`).join('')}</div>${ftrHTML}`;
            if (m.offsetHeight <= TARGET) { best = size; break; }
        }
        document.body.removeChild(m);
        const page = document.createElement('div');
        page.className = 'a4-page';
        const card = document.createElement('div');
        card.className = 'post-card';
        card.innerHTML = `${hdrHTML}
            <div class="post-body">
                ${paras.map(p => `<p style="font-size:${best}px;line-height:1.65">${p}</p>`).join('')}
            </div>
            ${ftrHTML}`;
        page.appendChild(card);
        paperContainer.appendChild(page);
        return 1;
    };

    // MODE: Multi - smart article. Tries 1 page first (18->11px shrink).
    // Only splits to multiple pages when truly needed. Adds page numbers.
    const renderMulti = ({ name, handle, avatarHTML, text, dateStr, showBrand }) => {
        paperContainer.innerHTML = '';
        const paras   = text.split('\n').filter(p => p.trim());
        const hdrHTML = buildHeader(name, handle, avatarHTML);
        const ftrHTML = buildFooter(dateStr, showBrand);
        const m = createMeasurer('font-size:18px;');
        let singleFont = null;
        for (let size = 18; size >= 11; size--) {
            m.style.fontSize = size + 'px';
            m.innerHTML = `${hdrHTML}<div class="post-body">${paras.map(p => `<p>${p}</p>`).join('')}</div>${ftrHTML}`;
            if (m.offsetHeight <= USABLE - 140) { singleFont = size; break; }
        }
        if (singleFont) {
            document.body.removeChild(m);
            const page = document.createElement('div');
            page.className = 'a4-page';
            const card = document.createElement('div');
            card.className = 'post-card';
            card.innerHTML = `${hdrHTML}
                <div class="post-body">
                    ${paras.map(p => `<p style="font-size:${singleFont}px;line-height:1.65">${p}</p>`).join('')}
                </div>
                ${ftrHTML}`;
            page.appendChild(card);
            paperContainer.appendChild(page);
            return 1;
        }
        const FONT = 16;
        m.style.fontSize = FONT + 'px';
        const measurePg = (arr) => {
            m.innerHTML = `${hdrHTML}<div class="post-body">${arr.map(p => `<p style="font-size:${FONT}px">${p}</p>`).join('')}</div>${ftrHTML}`;
            return m.offsetHeight;
        };
        const pages = [];
        let rest = [...paras];
        while (rest.length > 0) {
            let lo = 1, hi = rest.length, bst = 1;
            while (lo <= hi) {
                const mid = Math.floor((lo + hi) / 2);
                if (measurePg(rest.slice(0, mid)) <= USABLE - 80) { bst = mid; lo = mid + 1; } else hi = mid - 1;
            }
            pages.push(rest.slice(0, bst));
            rest = rest.slice(bst);
        }
        document.body.removeChild(m);
        const total = pages.length;
        pages.forEach((pg, idx) => {
            if (idx > 0) {
                const div = document.createElement('div');
                div.className = 'page-divider';
                div.textContent = `Page ${idx + 1} of ${total}`;
                paperContainer.appendChild(div);
            }
            const page = document.createElement('div');
            page.className = 'a4-page';
            const card = document.createElement('div');
            card.className = 'post-card';
            const hdr = idx > 0
                ? `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid #f0f0f6;">
                    <div style="display:flex;align-items:center;gap:8px;opacity:.45;">
                        <div style="width:24px;height:24px;border-radius:50%;background:#e0e0f0;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;overflow:hidden;flex-shrink:0">${avatarHTML}</div>
                        <div><div style="font-size:12px;font-weight:700;color:#0f1419">${name}</div><div style="font-size:10px;color:#536471">${handle} &middot; continued</div></div>
                    </div>
                    <div style="font-size:11px;font-weight:600;color:#c0c0cc;font-family:'Space Grotesk',sans-serif;">${idx + 1}&thinsp;/&thinsp;${total}</div>
                   </div>`
                : hdrHTML;
            const ftr = idx < total - 1
                ? `<div style="font-size:12px;color:#9ca3af;padding-top:12px;border-top:1px solid #eff3f4;display:flex;justify-content:space-between;"><span>Continued on next page →</span><span>${idx + 1} / ${total}</span></div>`
                : ftrHTML;
            card.innerHTML = `${hdr}
                <div class="post-body">
                    ${pg.map(p => `<p style="font-size:${FONT}px;line-height:1.65">${p}</p>`).join('')}
                </div>
                ${ftr}`;
            page.appendChild(card);
            paperContainer.appendChild(page);
        });
        return total;
    };

        // ── Master dispatcher ─────────────────────────────────────────────
    const renderPages = (args) => {
        window._lastRenderArgs = args;
        const count = layoutMode === 'exact' ? renderExact(args)
                    : layoutMode === 'fill'  ? renderFill(args)
                    :                          renderMulti(args);
        const pab = document.getElementById('pab-pages');
        if (pab) pab.textContent = count === 1 ? '1 page' : `${count} pages`;
        updateMiniPreview(args);
        document.getElementById('tool').scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    // ── Hero mini-preview ─────────────────────────────────────────────
    const updateMiniPreview = ({ name, handle, avatarHTML, text }) => {
        const mini = document.getElementById('preview-mini');
        if (!mini) return;
        const shortText = text.split('\n').filter(p => p.trim()).slice(0, 3).join('\n');
        mini.innerHTML = `
            <div class="mini-post">
                <div class="mini-header">
                    <div class="mini-avatar">${avatarHTML}</div>
                    <div class="mini-info"><strong>${name}</strong><span>${handle}</span></div>
                    ${X_ICON}
                </div>
                <p class="mini-text">${shortText}</p>
                <div class="mini-footer">${fmtDate()} · PostPrint</div>
            </div>`;
    };

    // ── Avatar preview in manual form ─────────────────────────────────
    let avatarPreviewEl = document.getElementById('m-avatar-preview');
    if (!avatarPreviewEl) {
        avatarPreviewEl = document.createElement('img');
        avatarPreviewEl.id = 'm-avatar-preview';
        avatarPreviewEl.alt = '';
        avatarPreviewEl.style.cssText = 'width:40px;height:40px;border-radius:50%;object-fit:cover;display:none;margin-top:6px;border:2px solid rgba(139,92,246,.4);box-shadow:0 0 0 3px rgba(139,92,246,.15);';
        document.getElementById('m-handle')?.closest('.form-field')?.appendChild(avatarPreviewEl);
    }

    // ── Fetch logic ───────────────────────────────────────────────────
    const doFetch = async (url, btnTextEl, errorEl) => {
        const hasDigits = /\d{10,}/.test(url);
        const hasDomain = url.includes('x.com') || url.includes('twitter.com');
        if (!url || (!hasDigits && !hasDomain)) {
            errorEl.textContent = 'Please paste a valid X/Twitter URL or Tweet ID.';
            return;
        }
        errorEl.textContent = '';
        btnTextEl.textContent = 'Fetching…';
        btnTextEl.parentElement.disabled = true;
        try {
            const ctrl  = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 10000);
            const res   = await fetch(`/api/fetch?url=${encodeURIComponent(url)}`, { signal: ctrl.signal });
            clearTimeout(timer);
            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            const avatarHTML = data.image ? `<img src="${data.image}" alt="">` : data.name.charAt(0).toUpperCase();
            renderPages({ name: data.name, handle: data.handle, avatarHTML, text: data.text, dateStr: fmtDate(), showBrand: false });
        } catch (err) {
            if (err.name === 'AbortError') {
                errorEl.textContent = 'Took too long — paste the tweet text manually below.';
            } else if (!navigator.onLine) {
                errorEl.textContent = 'No internet connection. Use the manual form.';
            } else {
                errorEl.textContent = 'Could not fetch. Try the manual form.';
            }
        } finally {
            btnTextEl.textContent = btnTextEl.parentElement.id === 'hero-fetch-btn' ? 'Generate PDF' : 'Fetch';
            btnTextEl.parentElement.disabled = false;
        }
    };

    // Hero
    document.getElementById('hero-fetch-btn')?.addEventListener('click', () => {
        const url = document.getElementById('hero-url').value.trim();
        document.getElementById('tool-url').value = url;
        doFetch(url, document.getElementById('hero-btn-text'), document.getElementById('hero-error'));
    });
    document.getElementById('hero-url')?.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('hero-fetch-btn').click(); });
    document.getElementById('hero-url')?.addEventListener('paste', e => {
        setTimeout(() => {
            const url = document.getElementById('hero-url').value.trim();
            if (url.includes('x.com') || url.includes('twitter.com')) {
                document.getElementById('tool-url').value = url;
                doFetch(url, document.getElementById('hero-btn-text'), document.getElementById('hero-error'));
            }
        }, 0);
    });

    // Nav scroll
    document.getElementById('nav-try-btn')?.addEventListener('click', () => document.getElementById('tool').scrollIntoView({ behavior: 'smooth' }));

    // Tool
    document.getElementById('tool-fetch-btn')?.addEventListener('click', () => {
        const url = document.getElementById('tool-url').value.trim();
        doFetch(url, document.getElementById('tool-btn-text'), document.getElementById('tool-error'));
    });
    document.getElementById('tool-url')?.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('tool-fetch-btn').click(); });
    document.getElementById('tool-url')?.addEventListener('paste', e => {
        setTimeout(() => {
            const url = document.getElementById('tool-url').value.trim();
            if (url.includes('x.com') || url.includes('twitter.com')) doFetch(url, document.getElementById('tool-btn-text'), document.getElementById('tool-error'));
        }, 0);
    });

    // ── Manual form: avatar ───────────────────────────────────────────
    let autoAvatarURL = null, avatarDebounce = null;
    const handleInput = document.getElementById('m-handle');
    const avatarInput = document.getElementById('m-img');

    const fetchAvatar = (raw) => {
        if (!raw || avatarInput?.files.length) return;
        const url = `https://unavatar.io/twitter/${encodeURIComponent(raw)}?fallback=false`;
        const img = new Image();
        img.onload  = () => { autoAvatarURL = url; avatarPreviewEl.src = url; avatarPreviewEl.style.display = 'block'; };
        img.onerror = () => { autoAvatarURL = null; avatarPreviewEl.style.display = 'none'; };
        img.src = url;
    };

    handleInput?.addEventListener('input', () => {
        clearTimeout(avatarDebounce);
        const raw = handleInput.value.trim().replace(/^@/, '');
        if (!raw) { autoAvatarURL = null; avatarPreviewEl.style.display = 'none'; return; }
        if (raw.length === 1) fetchAvatar(raw);
        else avatarDebounce = setTimeout(() => fetchAvatar(raw), 400);
    });
    avatarInput?.addEventListener('change', () => { autoAvatarURL = null; avatarPreviewEl.style.display = 'none'; });

    // Manual update button
    document.getElementById('manual-update-btn')?.addEventListener('click', () => {
        const name   = document.getElementById('m-name').value   || 'Author Name';
        const handle = document.getElementById('m-handle').value || '@handle';
        const text   = document.getElementById('m-text').value   || 'Enter tweet text above.';
        const file   = document.getElementById('m-img').files[0];
        const h      = handle.startsWith('@') ? handle : `@${handle}`;
        if (file) {
            const reader = new FileReader();
            reader.onload = e => renderPages({ name, handle: h, avatarHTML: `<img src="${e.target.result}" alt="">`, text, dateStr: fmtDate(), showBrand: false });
            reader.readAsDataURL(file);
        } else if (autoAvatarURL) {
            renderPages({ name, handle: h, avatarHTML: `<img src="${autoAvatarURL}" alt="">`, text, dateStr: fmtDate(), showBrand: false });
        } else {
            renderPages({ name, handle: h, avatarHTML: name.charAt(0).toUpperCase(), text, dateStr: fmtDate(), showBrand: false });
        }
    });

    // Collapsible manual form (mobile)
    const manualToggle = document.getElementById('manual-toggle');
    const manualForm   = document.getElementById('manual-form-body');
    manualToggle?.addEventListener('click', () => {
        const open = manualForm.classList.toggle('open');
        manualToggle.setAttribute('aria-expanded', open);
        manualToggle.querySelector('.toggle-arrow').textContent = open ? '▲' : '▼';
    });

    // ── Downloads (gated) ─────────────────────────────────────────────
    // Bulletproof PDF print:
    // 1. Temporarily removes CSS transforms so content prints at true A4 size
    // 2. Falls back gracefully if paper-container is empty
    // 3. Restores transforms after the print dialog closes
    const printFn = () => {
        const pc = document.getElementById('paper-container');
        if (!pc || !pc.children.length) {
            try { showToast('\u26a0\ufe0f Fetch a tweet first, then download.'); } catch(e) {}
            return;
        }
        // Strip scale transform — browser needs to see real 210mm width
        const prev = { transform: pc.style.transform, width: pc.style.width };
        pc.style.transform = 'none';
        pc.style.width = '210mm';
        // Small settle delay then print
        setTimeout(() => {
            try {
                window.print();
                if (window._onDownloadSuccess) window._onDownloadSuccess();
            } catch(e) {
                window._onDownloadSuccess = null;
                alert('Print failed. Use Ctrl+P / Cmd+P to print manually.');
            }
            // Restore after print dialog closes
            setTimeout(() => {
                pc.style.transform = prev.transform;
                pc.style.width     = prev.width;
            }, 1000);
        }, 100);
    };
    document.getElementById('download-btn')?.addEventListener('click', () => {
        if (!paperContainer.children.length) { document.getElementById('tool').scrollIntoView({ behavior: 'smooth' }); return; }
        gatedDownload(printFn);
    });
    document.getElementById('tool-download-btn')?.addEventListener('click', () => gatedDownload(printFn));
    document.getElementById('mobile-download-btn')?.addEventListener('click', () => gatedDownload(printFn));

    // ════════════════════════════════════════════════════════════════════
    //  INIT
    // ════════════════════════════════════════════════════════════════════
    updateNavUser();
    await updateUseBadge();

    renderPages({
        name: 'jack', handle: '@jack', avatarHTML: 'J',
        text: 'just setting up my twttr',
        dateStr: 'Mar 21, 2006, 8:50 PM'
    });
});
