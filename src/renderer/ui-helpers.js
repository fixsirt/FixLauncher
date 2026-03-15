(function() {
'use strict';

/**
 * Вспомогательные UI-функции рендерера
 * Playtime, toast, skeleton-лоадеры, темы, модальные окна, прогресс
 * @module renderer/ui-helpers
 *
 * Node.js-зависимости убраны: path/fs/paths → window.electronAPI.path,
 * playtime теперь читается через IPC (electronAPI.getPlaytime).
 */

// ─── КОНСТАНТЫ ───────────────────────────────────────────────────────────────
const THEME_TRANSITION_MS     = 250;   // длительность анимации смены темы (мс)
const TOAST_DEFAULT_DURATION  = 2500;  // время показа toast по умолчанию (мс)
const BANNER_AUTODISMISS_MS   = 2000;  // автоскрытие баннера после установки (мс)
const NEWS_SKELETON_COUNT     = 3;     // количество skeleton-карточек новостей
const MODS_SKELETON_COUNT     = 5;     // количество skeleton-карточек модов
const MODRINTH_DESC_MAX_LEN   = 500;   // макс. длина описания мода для перевода
const MODRINTH_API_TIMEOUT_MS = 10000; // таймаут запросов к Modrinth API (мс)

// ─── PLAYTIME ─────────────────────────────────────────────────────────────────
// Playtime читается через IPC (electronAPI.getPlaytime → main.js readPlaytime()),
// чтобы не держать require('fs') в renderer при contextIsolation:true.
async function playtimeGetTotal() {
    try {
        const data = await window.electronAPI.getPlaytime();
        return (data && data.totalSeconds) ? data.totalSeconds : 0;
    } catch(e) { return 0; }
}
function playtimeFormat(s) {
    if (!s || s <= 0) return '—';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return h + 'ч ' + String(m).padStart(2, '0') + 'м';
    if (m > 0) return m + 'м ' + String(sec).padStart(2, '0') + 'с';
    return sec + 'с';
}
async function playtimeUpdateUI() {
    const el = document.getElementById('stat-game-time');
    if (el) {
        const val = playtimeFormat(await playtimeGetTotal());
        if (el.textContent !== val) animateStatValue('stat-game-time', val);
        else el.textContent = val;
    }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', playtimeUpdateUI);
else playtimeUpdateUI();

// Вызывается из renderer.js после того как electronAPI гарантированно доступен
function initElectronListeners() {
    window.electronAPI?.on?.playtimeUpdate(() => playtimeUpdateUI());
    window.electronAPI?.on?.mcClosed(() => {
        resetPlayButton();
        hideProgress();
    });
    // onUpdateAvailable — единственный слушатель (onUpdateStatus в ui-init.js обрабатывает badge)
    window.electronAPI?.on?.updateAvailable((info) => {
        if (info?.version) showUpdateBanner(info);
    });
}

// ─── UPDATE BANNER ────────────────────────────────────────────────────────────
function showUpdateBanner(info) {
    if (document.getElementById('update-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'update-banner';
    banner.style.cssText = [
        'position:fixed','bottom:20px','right:20px','z-index:9999',
        'background:linear-gradient(135deg,rgba(var(--accent-g,59,130,246),0.18) 0%,rgba(var(--accent-g,59,130,246),0.08) 100%)',
        'border:1px solid rgba(var(--accent-g,59,130,246),0.25)',
        'border-radius:14px','padding:16px 20px',
        'box-shadow:0 8px 32px rgba(0,0,0,0.5),0 0 0 1px rgba(255,255,255,0.04),0 0 20px rgba(var(--accent-g,59,130,246),0.08)',
        'color:#fff','font-family:inherit','max-width:320px','min-width:280px',
        'display:flex','flex-direction:column','gap:10px',
        'backdrop-filter:blur(4px)','-webkit-backdrop-filter:blur(4px)',
        'animation:slideInBanner 0.4s cubic-bezier(.21,1.02,.73,1) forwards'
    ].join(';');
    if (!document.getElementById('update-banner-style')) {
        const style = document.createElement('style');
        style.id = 'update-banner-style';
        style.textContent = `
            @keyframes slideInBanner {
                from { opacity:0; transform:translateY(20px); }
                to   { opacity:1; transform:translateY(0); }
            }
            #update-banner-close { background:none;border:none;color:rgba(255,255,255,0.4);
                cursor:pointer;font-size:16px;line-height:1;padding:0;transition:color .2s; }
            #update-banner-close:hover { color:#fff; }
            #update-banner-dl {
                background: linear-gradient(135deg, var(--accent-primary,#3b82f6), var(--accent-secondary,#60a5fa));
                border:none;border-radius:8px;color:#fff;cursor:pointer;
                font-size:13px;font-weight:600;padding:9px 14px;
                transition:opacity .2s,transform .15s;flex:1;
                box-shadow: 0 4px 12px rgba(var(--accent-g,59,130,246),0.35);
            }
            #update-banner-dl:hover:not(:disabled) { opacity:0.9; transform:translateY(-1px); }
            #update-banner-dl:disabled { opacity:0.6; cursor:not-allowed; transform:none; }
        `;
        document.head.appendChild(style);
    }
    const notes = info.notes ? info.notes.slice(0, 120) + (info.notes.length > 120 ? '…' : '') : '';
    const notesHtml = notes ? `<div style="font-size:12px;color:rgba(255,255,255,0.55);line-height:1.5;">${notes}</div>` : '';
    banner.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
            <div style="display:flex;align-items:center;gap:8px;">
                <span style="font-size:18px;">🚀</span>
                <div>
                    <div style="font-weight:700;font-size:14px;">Доступно обновление!</div>
                    <div style="font-size:12px;color:rgba(255,255,255,0.6);margin-top:2px;">FixLauncher v${info.version}</div>
                </div>
            </div>
            <button id="update-banner-close" title="Закрыть">✕</button>
        </div>
        ${notesHtml}
        <div style="display:flex;gap:8px;">
            <button id="update-banner-dl">⬇ Скачать обновление</button>
        </div>
    `;
    document.body.appendChild(banner);
    const closeBannerBtn = document.getElementById('update-banner-close');
    if (closeBannerBtn) closeBannerBtn.onclick = () => banner.remove();
    const dlBannerBtn = document.getElementById('update-banner-dl');
    if (dlBannerBtn) dlBannerBtn.onclick = async () => {
        const btn = document.getElementById('update-banner-dl');
        if (!btn) return;
        btn.disabled = true;
        btn.textContent = '⏳ Загрузка... 0%';

        try {
            // Слушаем прогресс загрузки через electronAPI
            window.electronAPI.on?.updateProgress((percent) => {
                const b = document.getElementById('update-banner-dl');
                if (b) b.textContent = `⏳ Загрузка... ${percent}%`;
            });

            const result = await window.electronAPI.downloadUpdate();

            if (result && result.ok) {
                const b = document.getElementById('update-banner-dl');
                if (b) b.textContent = '✅ Установщик запущен!';
                setTimeout(() => banner.remove(), BANNER_AUTODISMISS_MS);
            } else {
                // Если нет assets — fallback на браузер
                window.electronAPI.openExternal(info.url || 'https://github.com/fixsirt/FixLauncher/releases/latest');
                banner.remove();
            }
        } catch(e) {
            console.error('[UPDATE] download failed:', e);
            window.electronAPI.openExternal(info.url || 'https://github.com/fixsirt/FixLauncher/releases/latest').catch(() => {});
            banner.remove();
        }
    };
}

// ─── UI ANIMATIONS ────────────────────────────────────────────────────────────
function initPlayRipple() {
    const btn = document.getElementById('play-button');
    if (!btn) return;
    btn.addEventListener('pointerdown', (e) => {
        const r = document.createElement('span');
        r.className = 'play-ripple';
        const size = Math.max(btn.offsetWidth, btn.offsetHeight) * 1.5;
        const rect = btn.getBoundingClientRect();
        r.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - rect.left - size/2}px;top:${e.clientY - rect.top - size/2}px`;
        btn.appendChild(r);
        r.addEventListener('animationend', () => r.remove());
    });
}

// ── 2. TOAST уведомления ─────────────────────────────────
function showToast(message, type = 'info', duration = TOAST_DEFAULT_DURATION) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    const icons = { success: '✓', error: '✕', info: 'ℹ' };
    toast.innerHTML = `<span class="toast-icon-bar"></span><span class="toast-icon">${icons[type] || icons.info}</span><span>${message}</span>`;
    container.appendChild(toast);
    const dismiss = () => {
        toast.classList.add('toast-out');
        toast.addEventListener('animationend', () => toast.remove(), { once: true });
    };
    setTimeout(dismiss, duration);
    toast.addEventListener('click', dismiss);
}

// ── 3. SKELETON LOADERS ──────────────────────────────────
function showNewsSkeleton() {
    const list = document.getElementById('news-list');
    const loading = document.getElementById('news-loading');
    if (!list) return;
    if (loading) loading.style.display = 'none';
    list.innerHTML = Array(NEWS_SKELETON_COUNT).fill(0).map(() => `
        <div class="skeleton-news-card">
            <div class="skeleton skeleton-line w60"></div>
            <div class="skeleton skeleton-line w40 h8"></div>
            <div class="skeleton skeleton-line"></div>
            <div class="skeleton skeleton-line w60 h8"></div>
        </div>`).join('');
}
function showModsSkeleton() {
    const inner = document.getElementById('mods-installed-list-inner');
    const loading = document.getElementById('mods-installed-loading');
    if (!inner) return;
    if (loading) loading.style.display = 'none';
    inner.innerHTML = Array(MODS_SKELETON_COUNT).fill(0).map(() =>
        `<div class="skeleton skeleton-mod-card"></div>`).join('');
}
function clearSkeleton(id) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '';
}

// ─── ТЕМА ────────────────────────────────────────────────────────────────────
const THEME_VARS = {
    blue:   { p: '#3b82f6', s: '#60a5fa', t: '#93c5fd', d: '#2563eb', g: '59,130,246',  bg: '#0a1628', bg2: '#0f1b2e' },
    green:  { p: '#10b981', s: '#34d399', t: '#6ee7b7', d: '#059669', g: '16,185,129',  bg: '#0a1f0a', bg2: '#0f2e0f' },
    purple: { p: '#8b5cf6', s: '#a78bfa', t: '#c4b5fd', d: '#7c3aed', g: '139,92,246',  bg: '#120a28', bg2: '#1a0f3e' },
    orange: { p: '#f59e0b', s: '#fbbf24', t: '#fcd34d', d: '#d97706', g: '245,158,11',  bg: '#1a1005', bg2: '#2e1f0a' },
    pink:   { p: '#ec4899', s: '#f472b6', t: '#f9a8d4', d: '#db2777', g: '236,72,153',  bg: '#1f0a14', bg2: '#2e0f1f' },
    cyan:   { p: '#06b6d4', s: '#22d3ee', t: '#67e8f9', d: '#0891b2', g: '6,182,212',   bg: '#050f1a', bg2: '#0a1f2e' },
};

function hexToRgb(hex) {
    const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
    return [r, g, b];
}
function lerpColor(a, b, t) {
    return [Math.round(a[0]+(b[0]-a[0])*t), Math.round(a[1]+(b[1]-a[1])*t), Math.round(a[2]+(b[2]-a[2])*t)];
}
function rgbToHex([r,g,b]) {
    return '#' + [r,g,b].map(x => x.toString(16).padStart(2,'0')).join('');
}
function easeInOut(t) { return t < 0.5 ? 2*t*t : -1+(4-2*t)*t; }

let _themeRaf = null;
let _themeGeneration = 0; // инкрементируется при каждой новой анимации — старые tick сами отменяются

function applyThemeSmooth(theme) {
    const html = document.documentElement;
    const root = document.documentElement.style;
    const from = THEME_VARS[html.getAttribute('data-theme')] || THEME_VARS.blue;
    const to   = THEME_VARS[theme] || THEME_VARS.blue;

    // Отменяем предыдущий RAF и помечаем его как устаревший через generation counter
    if (_themeRaf !== null) {
        cancelAnimationFrame(_themeRaf);
        _themeRaf = null;
    }
    const generation = ++_themeGeneration;

    // Переключаем data-theme сразу для фонового изображения
    html.setAttribute('data-theme', theme);
    localStorage.setItem('launcher-theme', theme);

    const start = performance.now();
    const keys = ['p','s','t','d','bg','bg2'];

    function tick(now) {
        // Если запущена новая анимация — эта устарела, выходим
        if (generation !== _themeGeneration) return;

        const raw = Math.min((now - start) / THEME_TRANSITION_MS, 1);
        const t = easeInOut(raw);

        keys.forEach(k => {
            const c = lerpColor(hexToRgb(from[k]), hexToRgb(to[k]), t);
            const hex = rgbToHex(c);
            if (k === 'p')   root.setProperty('--accent-primary',   hex);
            if (k === 's')   root.setProperty('--accent-secondary',  hex);
            if (k === 't')   root.setProperty('--accent-tertiary',   hex);
            if (k === 'd')   root.setProperty('--accent-dark',       hex);
            if (k === 'bg')  root.setProperty('--bg-primary',        hex);
            if (k === 'bg2') root.setProperty('--bg-secondary',      hex);
        });

        // glow — интерполируем числа rgb отдельно
        const fg = from.g.split(',').map(Number);
        const tg = to.g.split(',').map(Number);
        const gc = lerpColor(fg, tg, t);
        root.setProperty('--accent-glow',   `rgba(${gc[0]},${gc[1]},${gc[2]},0.4)`);
        root.setProperty('--border-glow',   `rgba(${gc[0]},${gc[1]},${gc[2]},0.35)`);
        root.setProperty('--shadow-glow',   `0 0 40px rgba(${gc[0]},${gc[1]},${gc[2]},0.4)`);
        root.setProperty('--accent-g',      `${gc[0]},${gc[1]},${gc[2]}`);

        if (raw < 1) {
            _themeRaf = requestAnimationFrame(tick);
        } else {
            // Убираем inline стили — пусть CSS vars из data-theme возьмут управление
            ['--accent-primary','--accent-secondary','--accent-tertiary','--accent-dark',
             '--accent-glow','--border-glow','--shadow-glow','--bg-primary','--bg-secondary','--accent-g']
                .forEach(p => root.removeProperty(p));
            _themeRaf = null;
        }
    }
    _themeRaf = requestAnimationFrame(tick);
}

// ── 5. COUNT-UP для stat-карточек ────────────────────────
function animateStatValue(elId, value) {
    const el = document.getElementById(elId);
    if (!el) return;
    el.classList.remove('counting');
    void el.offsetWidth; // reflow
    el.textContent = value;
    el.classList.add('counting');
    el.addEventListener('animationend', () => el.classList.remove('counting'), { once: true });
}

// ─── МОДАЛЬНЫЕ ОКНА ───────────────────────────────────────────────────────────
function getLauncherModalEls() {
    const overlay = document.getElementById('launcher-modal-overlay');
    const titleEl = document.getElementById('launcher-modal-title');
    const messageEl = document.getElementById('launcher-modal-message');
    const buttonsEl = document.getElementById('launcher-modal-buttons');
    return { overlay, titleEl, messageEl, buttonsEl };
}

function showLauncherAlert(message, title) {
    const { overlay, titleEl, messageEl, buttonsEl } = getLauncherModalEls();
    if (!overlay || !messageEl) {
        console.error('Модальное окно не найдено! overlay:', overlay, 'messageEl:', messageEl);
        // Fallback: используем alert
        alert((title ? title + ': ' : '') + message);
        return Promise.resolve();
    }
    titleEl.textContent = title != null ? title : 'Сообщение';
    messageEl.textContent = String(message);
    buttonsEl.innerHTML = '';
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'launcher-modal-btn launcher-modal-btn-primary';
    okBtn.textContent = 'OK';
    buttonsEl.appendChild(okBtn);
    overlay.style.display = 'flex';
    overlay.setAttribute('aria-hidden', 'false');
    console.log('Модальное окно открыто');
    return new Promise(resolve => {
        okBtn.addEventListener('click', () => {
            overlay.style.display = 'none';
            overlay.setAttribute('aria-hidden', 'true');
            resolve();
        });
    });
}

function showCrashAlert(summaryMessage, crashReportText, crashFilePath) {
    // Remove any existing crash modal
    const existing = document.getElementById('crash-modal-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'crash-modal-overlay';
    overlay.className = 'crash-modal-overlay';

    const hasCrashReport = !!(crashReportText && crashReportText.trim());

    overlay.innerHTML = `
        <div class="crash-modal-panel">
            <div class="crash-modal-header">
                <div class="crash-modal-icon">💥</div>
                <div>
                    <div class="crash-modal-title">Minecraft вылетел</div>
                    <div class="crash-modal-subtitle">${crashFilePath ? window.electronAPI.path.basename(crashFilePath) : 'Краш-репорт'}</div>
                </div>
            </div>
            <div class="crash-modal-body">
                <div class="crash-summary">${escapeHtmlLocal(summaryMessage)}</div>
                ${hasCrashReport ? `
                <div class="crash-report-section">
                    <div class="crash-report-label">📄 Краш-репорт</div>
                    <div class="crash-report-box" id="crash-report-box-text">${escapeHtmlLocal(crashReportText.substring(0, 6000))}${crashReportText.length > 6000 ? '\n... (обрезано, скопируйте полную версию)' : ''}</div>
                </div>` : ''}
            </div>
            <div class="crash-modal-footer">
                ${crashFilePath ? `
                <button class="crash-btn crash-btn-folder" id="crash-btn-folder">
                    <svg viewBox="0 0 20 20" fill="currentColor" width="13" height="13"><path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/></svg>
                    Открыть папку
                </button>` : ''}
                ${hasCrashReport ? `
                <button class="crash-btn crash-btn-copy" id="crash-btn-copy">
                    <svg viewBox="0 0 20 20" fill="currentColor" width="13" height="13"><path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z"/><path d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z"/></svg>
                    Скопировать краш
                </button>` : ''}
                <button class="crash-btn crash-btn-ok" id="crash-btn-ok">OK</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    function close() { overlay.remove(); }

    document.getElementById('crash-btn-ok').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    const copyBtn = document.getElementById('crash-btn-copy');
    if (copyBtn && hasCrashReport) {
        copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(crashReportText).then(() => {
                copyBtn.textContent = '✓ Скопировано!';
                copyBtn.classList.add('copied');
                setTimeout(() => {
                    copyBtn.innerHTML = `<svg viewBox="0 0 20 20" fill="currentColor" width="13" height="13"><path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z"/><path d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z"/></svg> Скопировать краш`;
                    copyBtn.classList.remove('copied');
                }, 2000);
            }).catch(() => {
                // fallback
                const ta = document.createElement('textarea');
                ta.value = crashReportText;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                ta.remove();
                copyBtn.textContent = '✓ Скопировано!';
                copyBtn.classList.add('copied');
                setTimeout(() => {
                    copyBtn.innerHTML = `<svg viewBox="0 0 20 20" fill="currentColor" width="13" height="13"><path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z"/><path d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z"/></svg> Скопировать краш`;
                    copyBtn.classList.remove('copied');
                }, 2000);
            });
        });
    }

    const folderBtn = document.getElementById('crash-btn-folder');
    if (folderBtn && crashFilePath) {
        folderBtn.addEventListener('click', () => {
            window.electronAPI?.openPath(window.electronAPI.path.dirname(crashFilePath));
        });
    }
}

function escapeHtmlLocal(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function showLauncherConfirm(message, title) {
    const { overlay, titleEl, messageEl, buttonsEl } = getLauncherModalEls();
    if (!overlay || !messageEl) return Promise.resolve(false);
    titleEl.textContent = title != null ? title : 'Подтверждение';
    messageEl.textContent = String(message);
    buttonsEl.innerHTML = '';
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'launcher-modal-btn launcher-modal-btn-primary';
    okBtn.textContent = 'OK';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'launcher-modal-btn launcher-modal-btn-secondary';
    cancelBtn.textContent = 'Отмена';
    buttonsEl.appendChild(okBtn);
    buttonsEl.appendChild(cancelBtn);
    overlay.style.display = 'flex';
    overlay.setAttribute('aria-hidden', 'false');
    return new Promise(resolve => {
        okBtn.addEventListener('click', () => {
            overlay.style.display = 'none';
            overlay.setAttribute('aria-hidden', 'true');
            resolve(true);
        });
        cancelBtn.addEventListener('click', () => {
            overlay.style.display = 'none';
            overlay.setAttribute('aria-hidden', 'true');
            resolve(false);
        });
    });
}

// ─── ПРОГРЕСС ─────────────────────────────────────────────────────────────────
function showProgress() {
    const overlay = document.getElementById('progress-overlay');
    if (overlay) {
        overlay.style.display = 'flex';
    }
}

// Скрытие панели прогресса
function hideProgress() {
    const overlay = document.getElementById('progress-overlay');
    if (overlay) {
        overlay.style.display = 'none';
    }
}

// Обновление прогресса
function updateProgress(percent, text) {
    const progressBar = document.getElementById('progress-bar');
    const progressText = document.getElementById('progress-text');
    
    if (progressBar) {
        progressBar.style.width = percent + '%';
    }
    if (progressText) {
        progressText.textContent = text || 'Загрузка...';
    }
}

// ─── КНОПКА PLAY ─────────────────────────────────────────────────────────────
function resetPlayButton() {
    const playButton = document.getElementById('play-button');
    if (playButton) {
        playButton.disabled = false;
        playButton.innerHTML = playButton.innerHTML.replace(/ЗАПУСК\.\.\.?|ИГРАТЬ/g, '') || 'ИГРАТЬ';
        // Восстанавливаем полную разметку кнопки
        const hasIcon = playButton.querySelector('.play-btn-icon');
        if (!hasIcon) {
            playButton.innerHTML =
                '<span class="play-btn-icon"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span>' +
                'ИГРАТЬ' +
                '<span class="play-btn-shine"></span>';
        } else {
            const textNodes = [...playButton.childNodes].filter(n => n.nodeType === 3);
            textNodes.forEach(n => { if (n.textContent.trim()) n.textContent = 'ИГРАТЬ'; });
        }
        // Перезапускаем анимацию пульсации
        playButton.style.animation = 'none';
        void playButton.offsetWidth;
        playButton.style.animation = '';
    }
}

// Dual export: window.* для renderer/браузера, module.exports для Node.js/main
const _UiHelpers = {
    // playtime
    playtimeGetTotal, playtimeFormat, playtimeUpdateUI,
    // update banner
    showUpdateBanner,
    // toast & skeletons
    showToast, showNewsSkeleton, showModsSkeleton, clearSkeleton, initPlayRipple,
    // theme
    hexToRgb, lerpColor, rgbToHex, easeInOut, applyThemeSmooth, animateStatValue,
    // modals
    getLauncherModalEls, showLauncherAlert, showLauncherConfirm, showCrashAlert,
    // progress
    showProgress, hideProgress, updateProgress,
    // play button
    resetPlayButton,
    // electron IPC listeners
    initElectronListeners
};
if (typeof window !== 'undefined') { window.UiHelpers = _UiHelpers; }
if (typeof module !== 'undefined' && module.exports) { module.exports = _UiHelpers; }
})();
