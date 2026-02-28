const path = require('path');
const os = require('os');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const https = require('https');
const http = require('http');
const AdmZip = require('adm-zip');
const { addUserJVMArgs } = require('./src/jvm-args');
const { initServersPanel } = require('./src/servers');
const { getPlaytimePath } = require('./src/paths');
const { formatDiagnosticsReport } = require('./src/renderer-support');
const { getProfilePreset, detectModConflicts, analyzeCrashText } = require('./src/power-tools');

// ─── PLAYTIME DISPLAY (запись — в main.js) ──────────────────────────────────
function _playtimeFilePath() {
    try {
        return getPlaytimePath(os.platform(), os.homedir(), process.env.APPDATA);
    } catch(e) { return null; }
}
function playtimeGetTotal() {
    try {
        const fp = _playtimeFilePath();
        if (!fp || !fs.existsSync(fp)) return 0;
        const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
        return data.totalSeconds || 0;
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
function playtimeUpdateUI() {
    const el = document.getElementById('stat-game-time');
    if (el) {
        const val = playtimeFormat(playtimeGetTotal());
        if (el.textContent !== val) animateStatValue('stat-game-time', val);
        else el.textContent = val;
    }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', playtimeUpdateUI);
else playtimeUpdateUI();
// Обновляем при получении сигнала от main.js (после возврата из игры)
try {
    const { ipcRenderer: _ptIpc } = require('electron');
    _ptIpc.on('playtime-update', () => playtimeUpdateUI());
    _ptIpc.on('mc-closed', () => {
        resetPlayButton();
        hideProgress();
    });
    _ptIpc.on('update-available', (event, info) => {
        showUpdateBanner(info);
    });
} catch(e) {}

// --- Баннер обновления лаунчера ---
function showUpdateBanner(info) {
    if (document.getElementById('update-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'update-banner';
    banner.style.cssText = [
        'position:fixed','bottom:20px','right:20px','z-index:9999',
        'background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%)',
        'border:1px solid rgba(255,255,255,0.15)',
        'border-radius:12px','padding:16px 20px',
        'box-shadow:0 8px 32px rgba(0,0,0,0.5)',
        'color:#fff','font-family:inherit','max-width:320px',
        'display:flex','flex-direction:column','gap:10px',
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
            #update-banner-close { background:none;border:none;color:rgba(255,255,255,0.5);
                cursor:pointer;font-size:16px;line-height:1;padding:0;transition:color .2s; }
            #update-banner-close:hover { color:#fff; }
            #update-banner-dl { background:var(--accent-color,#5b8cf5);
                border:none;border-radius:8px;color:#fff;cursor:pointer;
                font-size:13px;font-weight:600;padding:8px 14px;
                transition:opacity .2s;flex:1; }
            #update-banner-dl:hover { opacity:0.85; }
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
    document.getElementById('update-banner-close').onclick = () => banner.remove();
    document.getElementById('update-banner-dl').onclick = async () => {
        const btn = document.getElementById('update-banner-dl');
        if (!btn) return;
        btn.disabled = true;
        btn.textContent = '⏳ Загрузка... 0%';

        try {
            const { ipcRenderer } = require('electron');

            // Слушаем прогресс загрузки
            const onProgress = (event, percent) => {
                const b = document.getElementById('update-banner-dl');
                if (b) b.textContent = `⏳ Загрузка... ${percent}%`;
            };
            ipcRenderer.on('update-progress', onProgress);

            const result = await ipcRenderer.invoke('download-update');

            ipcRenderer.removeListener('update-progress', onProgress);

            if (result && result.ok) {
                const b = document.getElementById('update-banner-dl');
                if (b) b.textContent = '✅ Установщик запущен!';
                setTimeout(() => banner.remove(), 2000);
            } else {
                // Если нет assets — fallback на браузер
                ipcRenderer.invoke('open-external', info.url || 'https://github.com/fixsirt/FixLauncher/releases/latest');
                banner.remove();
            }
        } catch(e) {
            console.error('[UPDATE] download failed:', e);
            try {
                const { ipcRenderer } = require('electron');
                ipcRenderer.invoke('open-external', info.url || 'https://github.com/fixsirt/FixLauncher/releases/latest');
            } catch(_) {}
            banner.remove();
        }
    };
}
// ------------------------------------------
// ─────────────────────────────────────────────────────────────────────────────


// ══════════════════════════════════════════════════════════
// ANIMATIONS v2
// ══════════════════════════════════════════════════════════

// ── 1. RIPPLE на кнопке Play ──────────────────────────────
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
function showToast(message, type = 'info', duration = 3000) {
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
    list.innerHTML = Array(3).fill(0).map(() => `
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
    inner.innerHTML = Array(5).fill(0).map(() =>
        `<div class="skeleton skeleton-mod-card"></div>`).join('');
}
function clearSkeleton(id) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '';
}

// ── 4. ПЛАВНАЯ СМЕНА ТЕМЫ (JS interpolation CSS vars) ────
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
function applyThemeSmooth(theme) {
    const html = document.documentElement;
    const root = document.documentElement.style;
    const from = THEME_VARS[html.getAttribute('data-theme')] || THEME_VARS.blue;
    const to   = THEME_VARS[theme] || THEME_VARS.blue;
    if (_themeRaf) cancelAnimationFrame(_themeRaf);

    // Переключаем data-theme сразу для фонового изображения
    html.setAttribute('data-theme', theme);
    localStorage.setItem('launcher-theme', theme);

    // Интерполируем CSS переменные
    const DURATION = 380; // мс
    const start = performance.now();
    const keys = ['p','s','t','d','bg','bg2'];

    function tick(now) {
        const raw = Math.min((now - start) / DURATION, 1);
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

        if (raw < 1) {
            _themeRaf = requestAnimationFrame(tick);
        } else {
            // Убираем inline стили — пусть CSS vars из data-theme возьмут управление
            root.removeProperty('--accent-primary');
            root.removeProperty('--accent-secondary');
            root.removeProperty('--accent-tertiary');
            root.removeProperty('--accent-dark');
            root.removeProperty('--accent-glow');
            root.removeProperty('--border-glow');
            root.removeProperty('--shadow-glow');
            root.removeProperty('--bg-primary');
            root.removeProperty('--bg-secondary');
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

// ══════════════════════════════════════════════════════════

// ─── Всплывающие окна в стиле лаунчера (замена alert/confirm) ───
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

// Переключение вкладок с анимацией
let tabSwitchTimeout = null;
let isTabSwitching = false;

// Показывает панель с правильным display (flex для серверов, block для остальных)
function showPanel(panel) {
    if (!panel) return;
    panel.style.display = panel.id === 'servers-panel' ? 'flex' : 'block';
}

function initTabs() {
    const tabs = document.querySelectorAll('.tab');
    tabs.forEach((tab, index) => {
        tab.addEventListener('click', () => {
            // Если уже происходит переключение, отменяем предыдущее
            if (tabSwitchTimeout) {
                clearTimeout(tabSwitchTimeout);
                tabSwitchTimeout = null;
            }
            
            // Если переключение уже в процессе, игнорируем новый клик
            if (isTabSwitching) {
                return;
            }
            
            isTabSwitching = true;

            // Убираем активный класс со всех вкладок
            tabs.forEach(t => t.classList.remove('active'));
            // Добавляем активный класс к выбранной вкладке
            tab.classList.add('active');

            // Получаем все панели
            const mainPanel = document.getElementById('main-panel');
            const newsPanel = document.getElementById('news-panel');
            const serversPanel = document.getElementById('servers-panel');
            const settingsPanel = document.getElementById('settings-panel');
            const modsPanel = document.getElementById('mods-panel');
            const aboutPanel = document.getElementById('about-panel');
            const allPanels = [mainPanel, newsPanel, serversPanel, settingsPanel, modsPanel, aboutPanel];

            // Определяем целевую панель
            let targetPanel = null;
            if (index === 0) {
                targetPanel = mainPanel;
            } else if (index === 1) {
                targetPanel = newsPanel;
            } else if (index === 2) {
                targetPanel = serversPanel;
            } else if (index === 3) {
                targetPanel = settingsPanel;
            } else if (index === 4) {
                targetPanel = modsPanel;
            } else if (index === 5) {
                targetPanel = aboutPanel;
            }

            // Немедленно скрываем все панели, кроме целевой (если она уже видна)
            allPanels.forEach(panel => {
                if (panel && panel !== targetPanel) {
                    // Если панель активна, запускаем анимацию скрытия
                    if (panel.classList.contains('active')) {
                        panel.classList.remove('active');
                        panel.classList.add('fade-out');
                    } else {
                        // Если панель не активна, сразу скрываем
                        panel.style.display = 'none';
                        panel.classList.remove('active');
                        panel.classList.remove('fade-out');
                    }
                }
            });

            // Показываем целевую панель
            if (targetPanel) {
                // Если панель уже видна и активна, ничего не делаем
                if (targetPanel.classList.contains('active') && targetPanel.style.display !== 'none') {
                    isTabSwitching = false;
                    return;
                }

                // Сначала скрываем все панели с анимацией (если нужно)
                const activePanels = allPanels.filter(p => p && p.classList.contains('active') && p !== targetPanel);
                
                if (activePanels.length > 0) {
                    // Есть активные панели, которые нужно скрыть
                    activePanels.forEach(panel => {
                        panel.classList.remove('active');
                        panel.classList.add('fade-out');
                    });

                    // Ждем завершения анимации скрытия, затем показываем новую панель
                    tabSwitchTimeout = setTimeout(() => {
                        // Скрываем все панели
                        allPanels.forEach(panel => {
                            if (panel && panel !== targetPanel) {
                                panel.style.display = 'none';
                                panel.classList.remove('active');
                                panel.classList.remove('fade-out');
                            }
                        });

                        // Показываем целевую панель
                        showPanel(targetPanel);
                        targetPanel.classList.remove('fade-out');
                        requestAnimationFrame(() => {
                            requestAnimationFrame(() => {
                                targetPanel.classList.add('active');
                                
                                // Настройки обновляем всегда; новости и моды загружены при старте
                                if (index === 3) {
                                    loadSettings();
                                } else if (index === 4) {
                                    refreshInstalledModsList(); // только список, без полной перезагрузки
                                } else if (index === 2) {
                                    initServersPanel();
                                }
                                
                                isTabSwitching = false;
                            });
                        });
                    }, 200);
                } else {
                    // Нет активных панелей, показываем сразу
                    allPanels.forEach(panel => {
                        if (panel && panel !== targetPanel) {
                            panel.style.display = 'none';
                            panel.classList.remove('active');
                            panel.classList.remove('fade-out');
                        }
                    });

                    showPanel(targetPanel);
                    targetPanel.classList.remove('fade-out');
                    requestAnimationFrame(() => {
                        requestAnimationFrame(() => {
                            targetPanel.classList.add('active');
                            
                            if (index === 1) {
                                loadNews();
                            } else if (index === 2) {
                                initServersPanel();
                            } else if (index === 3) {
                                loadSettings();
                            } else if (index === 4) {
                                loadModsPanel();
                            }
                            
                            isTabSwitching = false;
                        });
                    });
                }
            } else {
                isTabSwitching = false;
            }
        });
    });
}

// Загрузка настроек
function loadSettings() {
    // Автоматическое определение пути к FixLauncher
    const osType = os.platform();
    let minecraftPath = '';
    
    if (osType === 'win32') {
        const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        minecraftPath = path.join(appData, '.fixlauncher');
    } else if (osType === 'darwin') {
        minecraftPath = path.join(os.homedir(), 'Library', 'Application Support', 'fixlauncher');
    } else {
        minecraftPath = path.join(os.homedir(), '.fixlauncher');
    }
    
    const savedMinecraftPath = localStorage.getItem('minecraft-path');
    if (savedMinecraftPath) {
        document.getElementById('minecraft-path').value = savedMinecraftPath;
    } else {
        document.getElementById('minecraft-path').value = minecraftPath;
    }

    // Автоматическое определение Java
    findJavaPath().then(javaPath => {
        const savedJavaPath = localStorage.getItem('java-path');
        if (savedJavaPath) {
            document.getElementById('java-path').value = savedJavaPath;
        } else if (javaPath) {
            document.getElementById('java-path').value = javaPath;
        } else {
            document.getElementById('java-path').value = 'Java не найдена';
        }
    });

    // Загрузка сохранённого значения RAM
    const savedRAM = localStorage.getItem('minecraft-ram') || '4';
    const ramSlider = document.getElementById('ram-slider');
    const ramValue = document.getElementById('ram-value');
    if (ramSlider && ramValue) {
        ramSlider.value = savedRAM;
        ramValue.textContent = savedRAM;
    }

    // Загрузка сохранённых аргументов запуска
    const savedArgs = localStorage.getItem('minecraft-args') || '';
    const minecraftArgsInput = document.getElementById('minecraft-args');
    if (minecraftArgsInput) {
        minecraftArgsInput.value = savedArgs;
    }
}

// Загрузка новостей из Telegram-канала
// Простой рендер Markdown → HTML
function renderMd(md) {
    if (!md) return '';
    let html = md
        .replace(/^### (.+)$/gm, '<h3>$1</h3>')
        .replace(/^## (.+)$/gm, '<h2>$1</h2>')
        .replace(/^# (.+)$/gm, '<h1>$1</h1>')
        .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,0.1);padding:1px 5px;border-radius:4px;font-size:0.9em;">$1</code>')
        .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
        .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
        .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" style="color:#60a5fa;text-decoration:underline;">$1</a>');
    // Оборачиваем подряд идущие <li> в <ul>
    html = html.replace(/(<li>[\s\S]*?<\/li>\n?)+/g, m => '<ul style="margin:6px 0 6px 16px;padding:0;">' + m + '</ul>');
    // Параграфы
    html = html.split(/\n{2,}/).map(p => {
        if (/^<[hul]/.test(p.trim())) return p;
        return '<p>' + p.replace(/\n/g, '<br>') + '</p>';
    }).join('');
    return html;
}

async function loadNews() {
    const listEl = document.getElementById('news-list');
    const loadingEl = document.getElementById('news-loading');
    const errorEl = document.getElementById('news-error');
    if (!listEl || !loadingEl || !errorEl) return;

    showNewsSkeleton();
    errorEl.style.display = 'none';

    try {
        const { ipcRenderer } = require('electron');
        const result = await ipcRenderer.invoke('get-news');
        loadingEl.style.display = 'none';

        if (!result.ok || !result.items || result.items.length === 0) {
            listEl.innerHTML = '';
            errorEl.textContent = result.error || 'Новостей пока нет.';
            errorEl.style.display = 'block';
            return;
        }

        listEl.innerHTML = '';
        result.items.forEach((item) => {
            const card = document.createElement('article');
            card.className = 'news-card';
            card.innerHTML = `
                <h2 class="news-card-title">${escapeHtmlText(item.title)}</h2>
                ${item.date ? `<time class="news-card-date">${escapeHtmlText(item.date)}</time>` : ''}
                <div class="news-card-content">${renderMd(item.body)}</div>
            `;
            listEl.appendChild(card);
        });
    } catch (err) {
        listEl.innerHTML = '';
        errorEl.textContent = 'Ошибка: ' + (err.message || 'неизвестная ошибка');
        errorEl.style.display = 'block';
    }
}

function escapeHtmlText(s) {
    if (!s) return '';
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
}

// Клик по ссылкам в новостях — открытие во внешнем браузере (делегирование)
function initNewsLinks() {
    const listEl = document.getElementById('news-list');
    if (!listEl) return;
    listEl.addEventListener('click', (e) => {
        const a = e.target.closest('a');
        if (a && a.href && a.getAttribute('href').startsWith('http')) {
            e.preventDefault();
            const { shell } = require('electron');
            shell.openExternal(a.href);
        }
    });
}

// Скроллбар новостей: показывать при прокрутке/наведении
function initNewsScrollbar() {
    const container = document.getElementById('news-container');
    if (!container) return;
    let scrollTimeout = null;
    container.addEventListener('scroll', () => {
        container.classList.add('scrolling');
        if (scrollTimeout) clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(() => {
            container.classList.remove('scrolling');
            scrollTimeout = null;
        }, 800);
    });
}

// Поиск Java
function findJavaPath() {
    return new Promise((resolve) => {
        const osType = os.platform();
        const javaExe = osType === 'win32' ? 'java.exe' : 'java';
        
        // Сначала проверяем JAVA_HOME
        const javaHome = process.env.JAVA_HOME;
        if (javaHome) {
            const javaPath = path.join(javaHome, 'bin', javaExe);
            if (fs.existsSync(javaPath)) {
                resolve(javaPath);
                return;
            }
        }
        
        // Пытаемся найти через команду which/where
        const command = osType === 'win32' ? 'where java' : 'which java';
        exec(command, (error, stdout) => {
            if (!error && stdout) {
                const javaPath = stdout.trim().split('\n')[0];
                if (fs.existsSync(javaPath)) {
                    resolve(javaPath);
                    return;
                }
            }
            
            // Проверяем стандартные пути
            const commonPaths = [];
            if (osType === 'win32') {
                const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
                const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
                commonPaths.push(
                    path.join(programFiles, 'Java'),
                    path.join(programFilesX86, 'Java'),
                    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Eclipse Adoptium'),
                    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft')
                );
            } else if (osType === 'darwin') {
                commonPaths.push(
                    '/Library/Java/JavaVirtualMachines',
                    '/System/Library/Java/JavaVirtualMachines',
                    path.join(os.homedir(), 'Library', 'Java', 'JavaVirtualMachines')
                );
            } else {
                commonPaths.push(
                    '/usr/lib/jvm',
                    '/usr/local/java',
                    path.join(os.homedir(), '.sdkman', 'candidates', 'java')
                );
            }
            
            // Ищем java.exe/java в стандартных путях
            for (const basePath of commonPaths) {
                if (fs.existsSync(basePath)) {
                    try {
                        const dirs = fs.readdirSync(basePath);
                        for (const dir of dirs) {
                            const javaPath = path.join(basePath, dir, 'bin', javaExe);
                            if (fs.existsSync(javaPath)) {
                                resolve(javaPath);
                                return;
                            }
                        }
                    } catch (e) {
                        // Игнорируем ошибки чтения
                    }
                }
            }
            
            resolve(null);
        });
    });
}

// Кнопка обзора папки Minecraft
function initBrowseButton() {
    const browseBtn = document.getElementById('browse-minecraft');
    if (browseBtn) {
        browseBtn.addEventListener('click', async () => {
            try {
                const { ipcRenderer } = require('electron');
                const result = await ipcRenderer.invoke('open-folder-dialog');
                
                if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
                    document.getElementById('minecraft-path').value = result.filePaths[0];
                }
            } catch (error) {
                console.error('Error opening dialog:', error);
                // Fallback: попробуем через remote если IPC не работает
                try {
                    const { remote } = require('electron');
                    const { dialog } = remote;
                    const result = await dialog.showOpenDialog({
                        properties: ['openDirectory'],
                        title: 'Выберите папку игры'
                    });
                    
                    if (!result.canceled && result.filePaths.length > 0) {
                        document.getElementById('minecraft-path').value = result.filePaths[0];
                    }
                } catch (fallbackError) {
                    console.error('Fallback error:', fallbackError);
                    showLauncherAlert('Не удалось открыть диалог выбора папки. Проверьте настройки Electron.');
                }
            }
        });
    }
    
    // Кнопка обзора Java
    const browseJavaBtn = document.getElementById('browse-java');
    if (browseJavaBtn) {
        browseJavaBtn.addEventListener('click', async () => {
            try {
                const { ipcRenderer } = require('electron');
                const osType = os.platform();
                const filters = osType === 'win32' 
                    ? [{ name: 'Java Executable', extensions: ['exe'] }]
                    : [];
                
                const result = await ipcRenderer.invoke('open-file-dialog', {
                    filters: filters,
                    title: 'Выберите Java (java.exe или java)'
                });
                
                if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
                    const javaPath = result.filePaths[0];
                    // Проверяем, что это действительно Java
                    if (javaPath.includes('java') || javaPath.endsWith('.exe')) {
                        document.getElementById('java-path').value = javaPath;
                    } else {
                        showLauncherAlert('Пожалуйста, выберите файл Java (java.exe на Windows или java на Linux/Mac)');
                    }
                }
            } catch (error) {
                console.error('Error opening dialog:', error);
                // Fallback: попробуем через remote если IPC не работает
                try {
                    const { remote } = require('electron');
                    const { dialog } = remote;
                    const osType = os.platform();
                    const filters = osType === 'win32' 
                        ? [{ name: 'Java Executable', extensions: ['exe'] }]
                        : [];
                    
                    const result = await dialog.showOpenDialog({
                        filters: filters.length > 0 ? filters : undefined,
                        title: 'Выберите Java (java.exe или java)',
                        properties: ['openFile']
                    });
                    
                    if (!result.canceled && result.filePaths.length > 0) {
                        const javaPath = result.filePaths[0];
                        if (javaPath.includes('java') || javaPath.endsWith('.exe')) {
                            document.getElementById('java-path').value = javaPath;
                        } else {
                            showLauncherAlert('Пожалуйста, выберите файл Java (java.exe на Windows или java на Linux/Mac)');
                        }
                    }
                } catch (fallbackError) {
                    console.error('Fallback error:', fallbackError);
                    showLauncherAlert('Не удалось открыть диалог выбора файла. Проверьте настройки Electron.');
                }
            }
        });
    }
}

// Слайдер RAM
function initRamSlider() {
    const ramSlider = document.getElementById('ram-slider');
    const ramValue = document.getElementById('ram-value');
    
    if (ramSlider && ramValue) {
        ramSlider.addEventListener('input', (e) => {
            ramValue.textContent = e.target.value;
        });
    }
}

// Сохранение настроек
function initSaveButton() {
    const saveBtn = document.getElementById('save-settings');
    console.log('initSaveButton: saveBtn =', saveBtn);
    if (saveBtn) {
        console.log('initSaveButton: добавляю обработчик');
        saveBtn.addEventListener('click', async () => {
            console.log('Кнопка Сохранить нажата!');
            const ram = document.getElementById('ram-slider').value;
            const minecraftPath = document.getElementById('minecraft-path').value;
            const javaPath = document.getElementById('java-path').value;
            const minecraftArgsEl = document.getElementById('minecraft-args');
            const minecraftArgs = minecraftArgsEl ? minecraftArgsEl.value : '';

            localStorage.setItem('minecraft-ram', ram);
            localStorage.setItem('minecraft-path', minecraftPath);
            localStorage.setItem('java-path', javaPath);
            localStorage.setItem('minecraft-args', minecraftArgs || '');

            console.log('Настройки сохранены:', { ram, minecraftPath, javaPath, minecraftArgs });
            await showLauncherAlert('Настройки сохранены!', 'Готово');
            document.dispatchEvent(new Event('settings-saved'));
        });
    } else {
        console.warn('Кнопка сохранения настроек не найдена!');
    }
}

// Инициализация ссылок для открытия в браузере
function initLinks() {
    // Обработка кнопок ссылок
    const linkButtons = document.querySelectorAll('.link-btn');
    linkButtons.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const url = link.getAttribute('href');
            if (url) {
                try {
                    const { shell } = require('electron');
                    shell.openExternal(url);
                } catch (error) {
                    console.error('Error opening link:', error);
                }
            }
        });
    });
    
    // Обработка ссылок разработчиков (fixsirt, rodya61 и т.д.) — открытие во внешнем браузере
    const devLinks = document.querySelectorAll('.dev-link');
    devLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const url = link.getAttribute('href');
            if (url) {
                try {
                    const { shell } = require('electron');
                    shell.openExternal(url);
                } catch (error) {
                    console.error('Error opening dev link:', error);
                }
            }
        });
    });

    const creatorLinks = document.querySelectorAll('.creator-name');
    creatorLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const url = link.getAttribute('href');
            if (url) {
                try {
                    const { shell } = require('electron');
                    shell.openExternal(url);
                } catch (error) {
                    console.error('Error opening link:', error);
                }
            }
        });
    });
}

// Получение пути к папке FixLauncher
function getVanillaSunsPath() {
    let minecraftPath = localStorage.getItem('minecraft-path');
    
    if (!minecraftPath) {
        const osType = os.platform();
        if (osType === 'win32') {
            const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
            minecraftPath = path.join(appData, '.fixlauncher');
        } else if (osType === 'darwin') {
            minecraftPath = path.join(os.homedir(), 'Library', 'Application Support', 'fixlauncher');
        } else {
            minecraftPath = path.join(os.homedir(), '.fixlauncher');
        }
    }
    
    return minecraftPath;
}

// Сохранение только логина в файл
function saveCredentials(username) {
    try {
        const vanillaSunsPath = getVanillaSunsPath();
        const credentialsPath = path.join(vanillaSunsPath, 'credentials.json');
        
        // Создаём папку если её нет
        if (!fs.existsSync(vanillaSunsPath)) {
            fs.mkdirSync(vanillaSunsPath, { recursive: true });
        }
        
        // Сохраняем данные
        const credentials = {
            username: username || ''
        };
        
        fs.writeFileSync(credentialsPath, JSON.stringify(credentials, null, 2), 'utf8');
        console.log('Credentials saved successfully');
    } catch (error) {
        console.error('Error saving credentials:', error);
    }
}

// Загрузка логина из файла
function loadCredentials() {
    try {
        const vanillaSunsPath = getVanillaSunsPath();
        const credentialsPath = path.join(vanillaSunsPath, 'credentials.json');
        
        if (fs.existsSync(credentialsPath)) {
            const data = fs.readFileSync(credentialsPath, 'utf8');
            const credentials = JSON.parse(data);
            if (Object.prototype.hasOwnProperty.call(credentials, 'password')) {
                delete credentials.password;
                fs.writeFileSync(credentialsPath, JSON.stringify({ username: credentials.username || '' }, null, 2), 'utf8');
            }
            return {
                username: credentials.username || ''
            };
        }
    } catch (error) {
        console.error('Error loading credentials:', error);
    }
    
    return { username: '' };
}

// Загрузка и сохранение имени игрока
function initPlayerName() {
    const playerNameInput = document.getElementById('player-name');
    
    const credentials = loadCredentials();
    if (playerNameInput && credentials.username) {
        playerNameInput.value = credentials.username;
    }
    
    const saveData = () => {
        const username = playerNameInput ? playerNameInput.value : '';
        saveCredentials(username);
    };
    
    if (playerNameInput) {
        playerNameInput.addEventListener('input', saveData);
        playerNameInput.addEventListener('blur', saveData);
    }
}

// Показ панели прогресса
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

// Запуск Minecraft
function launchMinecraft() {
    showProgress();
    updateProgress(0, 'Инициализация...');
    
    const playerName = document.getElementById('player-name').value || 'Player';
    const selectedVersion = getSelectedVersion();
    const versionType = selectedVersion.id; // evacuation | release:1.20.1 | fabric:1.20.1 | ...
    const isCustomBuild = versionType === 'evacuation';
    const withMods = isCustomBuild || (selectedVersion.type === 'fabric' || selectedVersion.type === 'forge' || selectedVersion.type === 'neoforge' || selectedVersion.type === 'quilt');
    const versionString = isCustomBuild ? (withMods ? '1.21.4-fabric' : '1.21.4') : (withMods ? selectedVersion.mcVersion + '-fabric' : selectedVersion.mcVersion);
    
    updateProgress(5, 'Загрузка настроек из лаунчера...');
    
    // Получаем настройки из localStorage (сохранённые в настройках)
    let baseMinecraftPath = localStorage.getItem('minecraft-path');
    let javaPath = localStorage.getItem('java-path');
    let ram = localStorage.getItem('minecraft-ram');
    
    // Если настройки не сохранены, используем значения из полей ввода
    if (!baseMinecraftPath) {
        const pathInput = document.getElementById('minecraft-path');
        if (pathInput && pathInput.value) {
            baseMinecraftPath = pathInput.value;
        } else {
            // Используем путь по умолчанию
            baseMinecraftPath = os.platform() === 'win32' 
                ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '.fixlauncher')
                : path.join(os.homedir(), '.fixlauncher');
        }
    }
    
    // Определяем папку Minecraft: кастомная сборка — minecraft-survival, остальные — minecraft-<тип>-<версия>
    let minecraftFolderName;
    if (versionType === 'evacuation') {
        minecraftFolderName = 'minecraft-survival';
    } else {
        minecraftFolderName = 'minecraft-' + String(versionType).replace(/:/g, '-').replace(/[^a-zA-Z0-9.-]/g, '-');
    }
    
    // Создаём путь к папке Minecraft для конкретной сборки
    const minecraftPath = path.join(baseMinecraftPath, minecraftFolderName);
    
    if (!javaPath) {
        const javaInput = document.getElementById('java-path');
        if (javaInput && javaInput.value && !javaInput.value.includes('не найдена')) {
            javaPath = javaInput.value;
        } else {
            javaPath = 'java'; // Используем системную Java
        }
    }
    
    if (!ram) {
        const ramSlider = document.getElementById('ram-slider');
        if (ramSlider && ramSlider.value) {
            ram = ramSlider.value;
        } else {
            ram = '4';
        }
    }
    
    // Проверяем, что настройки валидны
    if (!baseMinecraftPath) {
        hideProgress();
        resetPlayButton();
        showLauncherAlert('Ошибка: не указан путь к папке игры. Пожалуйста, укажите путь в настройках.');
        return;
    }
    
    // Создаём папку Minecraft для сборки если её нет
    if (!fs.existsSync(minecraftPath)) {
        fs.mkdirSync(minecraftPath, { recursive: true });
        console.log(`Created Minecraft directory for ${versionType}: ${minecraftPath}`);
    }
    
    if (!javaPath || javaPath === 'Java не найдена') {
        hideProgress();
        resetPlayButton();
        showLauncherAlert('Ошибка: не найдена Java. Пожалуйста, укажите путь к Java в настройках.');
        return;
    }
    
    console.log('Launch settings:', {
        baseMinecraftPath: baseMinecraftPath,
        minecraftPath: minecraftPath,
        minecraftFolder: minecraftFolderName,
        javaPath: javaPath,
        ram: ram + 'GB',
        playerName: playerName,
        versionType: versionType,
        withMods: withMods
    });
    
    updateProgress(10, 'Проверка настроек...');
    
    console.log(`Using separate Minecraft folder for ${versionType}: ${minecraftPath}`);
    
    // Проверяем и устанавливаем Java если нужно
    // Java устанавливается в базовую папку, но версии Minecraft - в отдельные папки для каждой сборки
    ensureJava(baseMinecraftPath, javaPath).then((finalJavaPath) => {
        console.log('Using Java:', finalJavaPath);
        const verifiedJavaPath = finalJavaPath;
        
        // Сохраняем путь к Java если он изменился
        localStorage.setItem('java-path', verifiedJavaPath);
        
        updateProgress(15, 'Проверка версии Minecraft...');
        
        // Проверяем и загружаем версию Minecraft (для кастомных — 1.21.4-fabric, для остальных — выбранная)
        return checkAndDownloadVersion(minecraftPath, versionString, withMods).then(() => {
            return { javaPath: verifiedJavaPath };
        });
    }).then(({ javaPath: verifiedJavaPath }) => {
        // Кастомные сборки FixLauncher: своя логика (модпак + запуск) — не меняем
        if (isCustomBuild && withMods) {
            updateProgress(60, 'Установка Сборки для выживания...');
            installModpack(minecraftPath, versionType).then(() => {
                updateProgress(85, 'Запуск Minecraft Fabric 1.21.4...');
                runMinecraft(minecraftPath, verifiedJavaPath, playerName, ram, withMods, versionType, versionString);
                updateProgress(100, 'Minecraft запущен!');
                // Закрытие лаунчера — внутри runMinecraft через mc-launched IPC
            }).catch((error) => {
                console.error('Error installing modpack:', error);
                hideProgress();
                resetPlayButton();
                // Формируем более информативное сообщение об ошибке
                let errorMessage = 'Ошибка при установке сборки модов.\n\n';
                
                if (error.message) {
                    errorMessage += `Детали: ${error.message}\n\n`;
                }
                
                if (error.message && error.message.includes('GitHub')) {
                    errorMessage += 'Возможные причины:\n';
                    errorMessage += '• Проблемы с интернет-соединением\n';
                    errorMessage += '• GitHub недоступен\n';
                    errorMessage += '• Репозиторий сборки не найден\n\n';
                } else if (error.message && error.message.includes('целостности')) {
                    errorMessage += 'Возможные причины:\n';
                    errorMessage += '• Не удалось проверить файлы сборки\n';
                    errorMessage += '• Проблемы с доступом к файлам\n\n';
                } else {
                    errorMessage += 'Возможные причины:\n';
                    errorMessage += '• Повреждённые файлы сборки\n';
                    errorMessage += '• Недостаточно места на диске\n';
                    errorMessage += '• Проблемы с правами доступа\n\n';
                }
                
                errorMessage += 'Попробуйте:\n';
                errorMessage += '1. Проверить интернет-соединение\n';
                errorMessage += '2. Запустить лаунчер от имени администратора\n';
                errorMessage += '3. Удалить папку сборки и попробовать снова\n';
                errorMessage += '4. Проверить логи в консоли (F12)';
                
                showLauncherAlert(errorMessage);
            });
        } else {
            updateProgress(80, `Запуск Minecraft ${versionString}...`);
            runMinecraft(minecraftPath, verifiedJavaPath, playerName, ram, withMods, versionType, versionString);
            updateProgress(100, 'Minecraft запущен!');
            // Закрытие лаунчера — внутри runMinecraft через mc-launched IPC
        }
    }).catch((error) => {
        console.error('Error:', error);
        hideProgress();
        resetPlayButton();
        showLauncherAlert('Ошибка: ' + error.message);
    });
}

// Загрузка файла по URL
function downloadFile(url, dest, onProgress) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        const protocol = url.startsWith('https') ? https : http;
        
        protocol.get(url, (response) => {
            if (response.statusCode === 301 || response.statusCode === 302) {
                // Редирект
                return downloadFile(response.headers.location, dest, onProgress).then(resolve).catch(reject);
            }
            
            if (response.statusCode !== 200) {
                reject(new Error(`Failed to download: ${response.statusCode}`));
                return;
            }
            
            const totalSize = parseInt(response.headers['content-length'], 10);
            let downloadedSize = 0;
            
            response.on('data', (chunk) => {
                downloadedSize += chunk.length;
                if (onProgress && totalSize) {
                    onProgress(downloadedSize, totalSize);
                }
            });
            
            response.pipe(file);
            
            file.on('finish', () => {
                file.close();
                resolve();
            });
            
            file.on('error', (err) => {
                try {
                    if (fs.existsSync(dest)) {
                        fs.unlinkSync(dest);
                    }
                } catch (e) {
                    // Игнорируем ошибки удаления
                }
                reject(err);
            });
        }).on('error', (err) => {
            reject(err);
        });
    });
}

// Получение JSON по URL
function fetchJSON(url) {
    return new Promise((resolve, reject) => {
        try {
            const protocol = url.startsWith('https') ? https : http;
            const request = protocol.get(url, {
                headers: {
                    'User-Agent': 'Vanilla-Suns-Launcher/1.0'
                }
            }, (response) => {
                if (response.statusCode === 301 || response.statusCode === 302) {
                    // Редирект
                    return fetchJSON(response.headers.location).then(resolve).catch(reject);
                }
                
                if (response.statusCode === 403) {
                    reject(new Error(`HTTP 403 - Доступ запрещён. Возможно, репозиторий приватный или превышен лимит запросов к GitHub API.`));
                    return;
                }
                
                if (response.statusCode !== 200) {
                    reject(new Error(`HTTP ${response.statusCode}`));
                    return;
                }
                
                let data = '';
                response.on('data', (chunk) => {
                    data += chunk;
                });
                response.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(new Error('Failed to parse JSON: ' + e.message));
                    }
                });
            });
            
            request.on('error', (err) => {
                reject(new Error('Network error: ' + err.message));
            });
            
            request.setTimeout(30000, () => {
                request.destroy();
                reject(new Error('Request timeout'));
            });
        } catch (error) {
            reject(error);
        }
    });
}

// ─── Version selector: список версий Minecraft (официальные + загрузчики) + кастомные сборки FixLauncher ───
const VERSION_STORAGE_KEY = 'launcher-selected-version';
const DEFAULT_VERSION_ID = 'evacuation';

/** Кастомная сборка FixLauncher — Выживание */
const CUSTOM_BUILDS = [
    { id: 'evacuation', type: 'custom', label: 'VanillaSuns — Выживание', mcVersion: '1.21.4', description: 'Fabric 1.21.4 (кастомная сборка проекта)', icon: '🟢' }
];

/** Типы версий для группировки в списке */
const VERSION_TYPE_LABELS = {
    custom: 'Сборки FixLauncher',
    release: 'Release',
    snapshot: 'Snapshot',
    old_alpha: 'Old Alpha',
    old_beta: 'Old Beta',
    vanilla: 'Vanilla',
    fabric: 'Fabric',
    forge: 'Forge',
    neoforge: 'NeoForge',
    quilt: 'Quilt',
    legacy_forge: 'Legacy Forge'
};

/** Путь к папке Minecraft для версии (id: evacuation | release:1.21.4 | fabric:1.21.4 | ...) */
function getMinecraftProfilePath(versionId) {
    const base = getVanillaSunsPath();
    const folder = versionId === 'evacuation' ? 'minecraft-survival' : 'minecraft-' + String(versionId).replace(/:/g, '-').replace(/[^a-zA-Z0-9.-]/g, '-');
    return path.join(base, folder);
}

/** Имя папки версии в versions/ (для проверки установки). Для evacuation проверяем 1.21.4 и 1.21.4-fabric. */
function getVersionDirNamesForCheck(version) {
    if (!version) return [];
    if (version.id === 'evacuation') return ['1.21.4', '1.21.4-fabric'];
    const mc = version.mcVersion || '';
    if (version.type === 'fabric') return [mc ? mc + '-fabric' : '1.21.4-fabric'];
    return [mc || version.id.split(':')[1] || ''].filter(Boolean);
}

/** Проверка, установлена ли версия (есть versions/<dir>/ с .jar и .json). */
function isVersionInstalled(version) {
    try {
        const profilePath = getMinecraftProfilePath(version.id);
        const dirs = getVersionDirNamesForCheck(version);
        for (const dir of dirs) {
            const base = path.join(profilePath, 'versions', dir);
            if (fs.existsSync(path.join(base, dir + '.json')) && fs.existsSync(path.join(base, dir + '.jar'))) return true;
        }
    } catch (_) {}
    return false;
}

/** Загрузка манифеста Mojang и списка версий Fabric (динамически, без хардкода версий) */
let cachedVersionList = null;

function fetchVersionList() {
    if (cachedVersionList) return Promise.resolve(cachedVersionList);
    const list = [...CUSTOM_BUILDS];
    return Promise.all([
        fetchJSON('https://launchermeta.mojang.com/mc/game/version_manifest.json').catch(() => null),
        fetchJSON('https://meta.fabricmc.net/v2/versions/game').catch(() => null)
    ]).then(([mojangManifest, fabricGameVersions]) => {
        if (mojangManifest && mojangManifest.versions && Array.isArray(mojangManifest.versions)) {
            const byType = { release: [], snapshot: [], old_alpha: [], old_beta: [] };
            for (const v of mojangManifest.versions) {
                const t = (v.type || 'release').toLowerCase().replace(/\s/g, '_');
                if (byType[t]) byType[t].push(v);
            }
            const releaseLimit = 30;
            (byType.release || []).slice(0, releaseLimit).forEach(v => list.push({ id: `release:${v.id}`, type: 'release', label: v.id, mcVersion: v.id, description: 'Release', icon: '🟢' }));
            (byType.snapshot || []).slice(0, 20).forEach(v => list.push({ id: `snapshot:${v.id}`, type: 'snapshot', label: v.id, mcVersion: v.id, description: 'Snapshot', icon: '🟡' }));
            (byType.old_alpha || []).slice(0, 15).forEach(v => list.push({ id: `old_alpha:${v.id}`, type: 'old_alpha', label: v.id, mcVersion: v.id, description: 'Old Alpha', icon: '⬜' }));
            (byType.old_beta || []).slice(0, 15).forEach(v => list.push({ id: `old_beta:${v.id}`, type: 'old_beta', label: v.id, mcVersion: v.id, description: 'Old Beta', icon: '🟫' }));
        }
        if (fabricGameVersions && Array.isArray(fabricGameVersions)) {
            fabricGameVersions.slice(0, 25).forEach(v => {
                const id = (v && v.version) ? v.version : (typeof v === 'string' ? v : null);
                if (id && !list.some(x => x.id === `fabric:${id}`)) {
                    list.push({ id: `fabric:${id}`, type: 'fabric', label: `Fabric ${id}`, mcVersion: id, description: 'Fabric', icon: '🧵' });
                }
            });
        }
        cachedVersionList = list;
        return list;
    });
}

/** Возвращает выбранную версию из localStorage (для запуска игры) */
function getSelectedVersion() {
    const raw = localStorage.getItem(VERSION_STORAGE_KEY) || DEFAULT_VERSION_ID;
    if (raw === 'evacuation') {
        return CUSTOM_BUILDS[0];
    }
    const [type, mcVersion] = raw.includes(':') ? raw.split(':') : ['release', raw];
    const label = type === 'fabric' ? `Fabric ${mcVersion}` : mcVersion;
    return { id: raw, type, label, mcVersion, description: VERSION_TYPE_LABELS[type] || type, icon: '📦' };
}

/** Проверка, что у выбранной версии есть модлоадер (Fabric/Forge/NeoForge и т.д.) */
function versionHasModLoader(version) {
    if (!version || !version.type) return false;
    const t = version.type.toLowerCase();
    return t === 'evacuation' || t === 'custom' || t === 'fabric' || t === 'forge' || t === 'neoforge' || t === 'quilt' || t === 'legacy_forge';
}

/** Сохраняет выбранную версию и обновляет UI (главная + панель модов) */
function setSelectedVersion(versionId) {
    localStorage.setItem(VERSION_STORAGE_KEY, versionId);
    const hiddenInput = document.getElementById('version-hidden-input');
    if (hiddenInput) hiddenInput.value = versionId;
    const v = versionId === 'evacuation' ? CUSTOM_BUILDS[0] : getSelectedVersion();
    const labelText = v ? `${v.icon || '📦'} ${v.label}` : versionId;
    const labelEl = document.getElementById('version-selector-label');
    if (labelEl) labelEl.textContent = labelText;
    const modsVersionEl = document.getElementById('mods-version-value');
    if (modsVersionEl) modsVersionEl.textContent = labelText;
    // Обновляем карточку версии на главной
    const statVersionEl = document.getElementById('stat-version');
    if (statVersionEl) {
        const displayVer = v ? (v.mcVersion || v.label) : versionId;
        animateStatValue('stat-version', displayVer);
    }
    // Сообщаем index.html пересчитать моды
    document.dispatchEvent(new Event('version-changed'));
}

/** Отрисовка списка версий в dropdown: 1) Сборки FixLauncher, 2) Установленные версии, 3) остальные по группам */
function renderVersionList(versions) {
    const listEl = document.getElementById('version-list');
    if (!listEl) return;
    listEl.innerHTML = '';
    const currentId = localStorage.getItem(VERSION_STORAGE_KEY) || DEFAULT_VERSION_ID;

    function appendVersionItem(v) {
        const item = document.createElement('div');
        item.className = 'version-item' + (v.id === currentId ? ' is-selected' : '');
        item.setAttribute('role', 'option');
        item.setAttribute('data-version-id', v.id);
        item.innerHTML = `<span class="version-item-icon">${v.icon || '📦'}</span><div class="version-item-body"><div class="version-item-title">${v.label}</div><div class="version-item-meta">${v.description || v.mcVersion || ''}</div></div>`;
        item.addEventListener('click', () => {
            setSelectedVersion(v.id);
            listEl.querySelectorAll('.version-item').forEach(el => el.classList.remove('is-selected'));
            item.classList.add('is-selected');
            closeVersionDropdown();
        });
        listEl.appendChild(item);
    }

    function appendGroup(label, list) {
        if (!list || list.length === 0) return;
        const groupEl = document.createElement('div');
        groupEl.className = 'version-group-label';
        groupEl.textContent = label;
        listEl.appendChild(groupEl);
        list.forEach(appendVersionItem);
    }

    const groups = {};
    versions.forEach(v => {
        const g = v.type || 'release';
        if (!groups[g]) groups[g] = [];
        groups[g].push(v);
    });

    // 1) Сборки FixLauncher (только custom)
    appendGroup('Сборки FixLauncher', groups.custom || []);

    // 2) Установленные версии (все установленные, кроме custom — они уже выше)
    const installed = versions.filter(v => v.type !== 'custom' && isVersionInstalled(v));
    appendGroup('Установленные версии', installed);

    // 3) Остальные группы — только не установленные версии (без дубликатов)
    const order = ['release', 'snapshot', 'old_alpha', 'old_beta', 'vanilla', 'fabric', 'forge', 'neoforge', 'quilt', 'legacy_forge'];
    const installedIds = new Set(installed.map(v => v.id));
    order.forEach(type => {
        const list = (groups[type] || []).filter(v => !installedIds.has(v.id));
        appendGroup(VERSION_TYPE_LABELS[type] || type, list);
    });
}

function openVersionDropdown() {
    const dropdown = document.getElementById('version-selector-dropdown');
    const btn = document.getElementById('version-selector-btn');
    if (dropdown && btn) {
        dropdown.classList.add('is-open');
        btn.setAttribute('aria-expanded', 'true');
        dropdown.setAttribute('aria-hidden', 'false');
        fetchVersionList().then(renderVersionList);
    }
}

function closeVersionDropdown() {
    const dropdown = document.getElementById('version-selector-dropdown');
    const btn = document.getElementById('version-selector-btn');
    if (dropdown && btn) {
        dropdown.classList.remove('is-open');
        btn.setAttribute('aria-expanded', 'false');
        dropdown.setAttribute('aria-hidden', 'true');
    }
}

function initVersionSelector() {
    const btn = document.getElementById('version-selector-btn');
    const dropdown = document.getElementById('version-selector-dropdown');
    if (!btn || !dropdown) return;
    setSelectedVersion(localStorage.getItem(VERSION_STORAGE_KEY) || DEFAULT_VERSION_ID);
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        const isOpen = dropdown.classList.contains('is-open');
        if (isOpen) closeVersionDropdown();
        else openVersionDropdown();
    });
    document.addEventListener('click', (e) => {
        if (dropdown.classList.contains('is-open') && !dropdown.contains(e.target) && !btn.contains(e.target)) {
            closeVersionDropdown();
        }
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// MOD MANAGER — управление модами (установленные, включение/отключение, Modrinth)
// ═══════════════════════════════════════════════════════════════════════════════

const MODRINTH_API = 'https://api.modrinth.com/v2';
const MODRINTH_USER_AGENT = 'FixLauncher/2.0 (https://t.me/vanillasunsteam)';

/** Путь к папке mods для выбранной версии (та же логика, что и при запуске) */
function getModsPathForVersion(versionId) {
    const basePath = localStorage.getItem('minecraft-path') ||
        (os.platform() === 'win32'
            ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '.fixlauncher')
            : path.join(os.homedir(), '.fixlauncher'));
    let folderName;
    if (versionId === 'evacuation') {
        folderName = 'minecraft-survival';
    } else {
        folderName = 'minecraft-' + String(versionId).replace(/:/g, '-').replace(/[^a-zA-Z0-9.-]/g, '-');
    }
    return path.join(basePath, folderName, 'mods');
}

/** Путь к папке данных версии (для resourcepacks и shaderpacks) */
function getDataPathForVersion(versionId) {
    const basePath = localStorage.getItem('minecraft-path') ||
        (os.platform() === 'win32'
            ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '.fixlauncher')
            : path.join(os.homedir(), '.fixlauncher'));
    let folderName;
    if (versionId === 'evacuation') {
        folderName = 'minecraft-survival';
    } else {
        folderName = 'minecraft-' + String(versionId).replace(/:/g, '-').replace(/[^a-zA-Z0-9.-]/g, '-');
    }
    return path.join(basePath, folderName);
}

/** Путь к папке resourcepacks для выбранной версии */
function getResourcePacksPathForVersion(versionId) {
    const basePath = localStorage.getItem('minecraft-path') ||
        (os.platform() === 'win32'
            ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '.fixlauncher')
            : path.join(os.homedir(), '.fixlauncher'));
    let folderName;
    if (versionId === 'evacuation') {
        folderName = 'minecraft-survival';
    } else {
        folderName = 'minecraft-' + String(versionId).replace(/:/g, '-').replace(/[^a-zA-Z0-9.-]/g, '-');
    }
    return path.join(basePath, folderName, 'resourcepacks');
}

/** Путь к папке shaderpacks для выбранной версии */
function getShadersPathForVersion(versionId) {
    const basePath = localStorage.getItem('minecraft-path') ||
        (os.platform() === 'win32'
            ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '.fixlauncher')
            : path.join(os.homedir(), '.fixlauncher'));
    let folderName;
    if (versionId === 'evacuation') {
        folderName = 'minecraft-survival';
    } else {
        folderName = 'minecraft-' + String(versionId).replace(/:/g, '-').replace(/[^a-zA-Z0-9.-]/g, '-');
    }
    return path.join(basePath, folderName, 'shaderpacks');
}

/** Извлечь метаданные мода из .jar (fabric.mod.json или mods.toml) */
function parseModMetadata(jarPath) {
    const result = { name: null, version: null, loader: null, description: null, id: null, fileName: path.basename(jarPath) };
    try {
        const zip = new AdmZip(jarPath);
        const entries = zip.getEntries();

        // Fabric: fabric.mod.json в корне или в подпапках
        for (const entry of entries) {
            if (entry.entryName === 'fabric.mod.json' || entry.entryName.endsWith('/fabric.mod.json')) {
                const text = entry.getData().toString('utf8');
                try {
                    const json = JSON.parse(text);
                    result.name = json.name || json.id || result.fileName.replace(/\.(jar|disabled)$/i, '');
                    result.version = json.version || '—';
                    result.loader = 'Fabric';
                    result.id = json.id || null;
                    result.description = (json.description && (typeof json.description === 'string' ? json.description : json.description[0])) || '';
                    return result;
                } catch (_) {}
                break;
            }
        }

        // Forge / NeoForge: META-INF/mods.toml
        for (const entry of entries) {
            if (entry.entryName.toLowerCase() === 'meta-inf/mods.toml') {
                const text = entry.getData().toString('utf8');
                result.loader = text.toLowerCase().includes('neoforge') ? 'NeoForge' : 'Forge';
                const displayNameMatch = text.match(/displayName\s*=\s*"([^"]+)"/);
                const versionMatch = text.match(/version\s*=\s*"([^"]+)"/);
                result.name = displayNameMatch ? displayNameMatch[1] : result.fileName.replace(/\.(jar|disabled)$/i, '');
                result.version = versionMatch ? versionMatch[1] : '—';
                const descMatch = text.match(/description\s*=\s*"([^"]+)"/);
                result.description = descMatch ? descMatch[1] : '';
                return result;
            }
        }

        // Fallback: имя файла без расширения
        result.name = result.fileName.replace(/\.(jar|disabled)$/i, '');
        result.version = '—';
        result.loader = '—';
    } catch (e) {
        console.warn('parseModMetadata failed for', jarPath, e);
    }
    return result;
}

/** Список установленных модов (включённые и отключённые) */
function listInstalledMods(modsPath) {
    const list = [];
    if (!fs.existsSync(modsPath)) return list;
    const files = fs.readdirSync(modsPath);
    for (const file of files) {
        const fullPath = path.join(modsPath, file);
        if (!fs.statSync(fullPath).isFile()) continue;
        let enabled = true;
        let targetPath = fullPath;
        if (file.endsWith('.jar.disabled')) {
            enabled = false;
        } else if (!file.endsWith('.jar')) continue;
        const meta = parseModMetadata(targetPath);
        meta.enabled = enabled;
        meta.filePath = fullPath;
        meta.fileName = file;
        list.push(meta);
    }
    return list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

/** Включить мод: переименовать .jar.disabled → .jar */
function setModEnabled(filePath) {
    if (!filePath.endsWith('.jar.disabled')) return;
    const newPath = filePath.slice(0, -('.disabled').length);
    try {
        fs.renameSync(filePath, newPath);
    } catch (err) {
        if (err.code === 'EBUSY') {
            throw new Error('Файл заблокирован. Закройте Minecraft перед изменением мода.');
        }
        throw err;
    }
}

/** Отключить мод: переименовать .jar → .jar.disabled */
function setModDisabled(filePath) {
    if (!filePath.endsWith('.jar')) return;
    try {
        fs.renameSync(filePath, filePath + '.disabled');
    } catch (err) {
        if (err.code === 'EBUSY') {
            throw new Error('Файл заблокирован. Закройте Minecraft перед изменением мода.');
        }
        throw err;
    }
}

/** Включить мод: переименовать .jar.disabled → .jar */
function enableMod(filePath) {
    if (!filePath.endsWith('.jar.disabled')) return;
    try {
        fs.renameSync(filePath, filePath.slice(0, -10)); // убрать .disabled
    } catch (err) {
        if (err.code === 'EBUSY') {
            throw new Error('Файл заблокирован. Закройте Minecraft перед изменением мода.');
        }
        throw err;
    }
}

/** Запрос к Modrinth API */
function modrinthFetch(endpoint, options = {}) {
    const url = endpoint.startsWith('http') ? endpoint : MODRINTH_API + endpoint;
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https') ? https : http;
        let settled = false;
        const done = (fn, val) => { if (!settled) { settled = true; fn(val); } };

        // Таймаут 10 секунд — если Modrinth не отвечает, не висим бесконечно
        const timer = setTimeout(() => {
            req.destroy();
            done(reject, new Error('Превышено время ожидания (10с). Проверьте интернет-соединение.'));
        }, 10000);

        const req = lib.get(url, {
            headers: { 'User-Agent': MODRINTH_USER_AGENT, ...options.headers },
            timeout: 10000
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                clearTimeout(timer);
                try {
                    if (res.statusCode === 429) {
                        done(reject, new Error('Слишком много запросов к Modrinth, подождите немного'));
                        return;
                    }
                    if (res.statusCode !== 200) {
                        done(reject, new Error(`Modrinth вернул ошибку: HTTP ${res.statusCode}`));
                        return;
                    }
                    done(resolve, JSON.parse(data));
                } catch (e) {
                    done(reject, e);
                }
            });
            res.on('error', (e) => { clearTimeout(timer); done(reject, e); });
        });
        req.on('error', (e) => { clearTimeout(timer); done(reject, e); });
        req.on('timeout', () => { req.destroy(); });
    });
}

/** Поиск проектов на Modrinth */
function searchModrinth(query, gameVersion, loader, limit = 20, projectType = 'mod') {
    const facets = [[`project_type:${projectType}`]];
    if (gameVersion) facets.push([`versions:${gameVersion}`]);
    if (loader) facets.push([`categories:${loader.toLowerCase()}`]);
    const q = new URLSearchParams({
        query: query || '',
        limit: String(limit),
        facets: JSON.stringify(facets)
    });
    return modrinthFetch(`/search?${q.toString()}`);
}

/** Версии проекта с фильтром по игре и загрузчику */
function getModrinthProjectVersions(projectIdOrSlug, gameVersions, loaders) {
    const params = new URLSearchParams();
    if (gameVersions && gameVersions.length) params.set('game_versions', JSON.stringify(gameVersions));
    if (loaders && loaders.length) params.set('loaders', JSON.stringify(loaders));
    const q = params.toString();
    return modrinthFetch(`/project/${encodeURIComponent(projectIdOrSlug)}/version${q ? '?' + q : ''}`);
}


/** Информация о проекте Modrinth (название, slug и т.д.) */
function getModrinthProject(projectIdOrSlug) {
    return modrinthFetch(`/project/${encodeURIComponent(projectIdOrSlug)}`);
}

/** Установить один мод по project_id в указанную пап������у (без проверки з������������������висимостей). Возвращает Promise. */
function installOneModFromModrinth(projectIdOrSlug, gameVersions, loaders, modsPath, _installedSet) {
    const installedSet = _installedSet || new Set();
    const key = String(projectIdOrSlug).toLowerCase();
    if (installedSet.has(key)) return Promise.resolve({ skipped: true });
    installedSet.add(key);

    return getModrinthProjectVersions(projectIdOrSlug, gameVersions, loaders).then(versions => {
        if (!versions || versions.length === 0) return Promise.reject(new Error('Нет подходящей версии для ' + projectIdOrSlug));
        const v = versions[0];
        const primaryFile = (v.files || []).find(f => f.primary) || (v.files || [])[0];
        if (!primaryFile || !primaryFile.url) return Promise.reject(new Error('Нет файла для загрузки: ' + projectIdOrSlug));
        if (!fs.existsSync(modsPath)) fs.mkdirSync(modsPath, { recursive: true });
        const fileName = primaryFile.filename || path.basename(primaryFile.url) || `mod-${v.id}.jar`;
        const destPath = path.join(modsPath, fileName);

        // Install transitive required dependencies first
        const transitiveDeps = (v.dependencies || []).filter(d => d.dependency_type === 'required' && d.project_id);
        const uniqueTransitive = [...new Set(transitiveDeps.map(d => d.project_id))].filter(pid => !installedSet.has(String(pid).toLowerCase()));

        let chain = Promise.resolve();
        uniqueTransitive.forEach(pid => {
            chain = chain.then(() => installOneModFromModrinth(pid, gameVersions, loaders, modsPath, installedSet)).catch(err => {
                console.warn('Transitive dependency install failed:', pid, err);
            });
        });

        return chain.then(() => downloadModFile(primaryFile.url, destPath, null));
    });
}

/**
 * Рекурсивно собирает список всех зависимостей (включая транзитивные) для мода.
 * Возвращает массив {project_id, title}.
 */
function collectAllDepsInfo(projectIdOrSlug, gameVersions, loaders, _visited) {
    const visited = _visited || new Set();
    const key = String(projectIdOrSlug).toLowerCase();
    if (visited.has(key)) return Promise.resolve([]);
    visited.add(key);

    return getModrinthProjectVersions(projectIdOrSlug, gameVersions, loaders).then(versions => {
        if (!versions || versions.length === 0) return [];
        const v = versions[0];
        const directDeps = (v.dependencies || []).filter(d => d.dependency_type === 'required' && d.project_id);
        const uniquePids = [...new Set(directDeps.map(d => d.project_id))].filter(pid => !visited.has(String(pid).toLowerCase()));
        if (uniquePids.length === 0) return [];
        return Promise.all(uniquePids.map(pid =>
            getModrinthProject(pid).then(proj => ({ project_id: pid, title: (proj && proj.title) || pid })).catch(() => ({ project_id: pid, title: pid }))
        )).then(infos => {
            return Promise.all(infos.map(info =>
                collectAllDepsInfo(info.project_id, gameVersions, loaders, visited).then(sub => [info, ...sub])
            )).then(results => results.flat());
        });
    }).catch(() => []);
}

/** Скачать файл по URL в указанный путь */
function downloadModFile(url, destPath, onProgress) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https') ? https : http;
        const req = lib.get(url, { headers: { 'User-Agent': MODRINTH_USER_AGENT } }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                downloadModFile(res.headers.location, destPath, onProgress).then(resolve).catch(reject);
                return;
            }
            const total = parseInt(res.headers['content-length'], 10) || 0;
            const chunks = [];
            let received = 0;
            res.on('data', chunk => {
                chunks.push(chunk);
                received += chunk.length;
                if (onProgress && total) onProgress(received, total);
            });
            res.on('end', () => {
                try {
                    fs.writeFileSync(destPath, Buffer.concat(chunks));
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
    });
}

/** Создаёт inline progress bar рядом с кнопкой и возвращает объект для управления */
function createInlineProgress(containerEl) {
    const wrap = document.createElement('div');
    wrap.className = 'mod-dl-progress-wrap';
    const bar = document.createElement('div');
    bar.className = 'mod-dl-progress-bar';
    const txt = document.createElement('div');
    txt.className = 'mod-dl-progress-text';
    wrap.appendChild(bar);
    wrap.appendChild(txt);
    if (containerEl) containerEl.appendChild(wrap);
    return {
        update(received, total) {
            const pct = total ? Math.round(received / total * 100) : 0;
            bar.style.width = pct + '%';
            const mb = (received / 1048576).toFixed(1);
            const totMb = total ? (total / 1048576).toFixed(1) : '?';
            txt.textContent = `${mb} / ${totMb} MB`;
        },
        remove() { wrap.remove(); }
    };
}

let modsPanelLoaded = false;
let cachedInstalledMods = [];

function renderInstalledModsList(mods, searchQuery) {
    const listEl = document.getElementById('mods-installed-list');
    const innerEl = document.getElementById('mods-installed-list-inner');
    const loadingEl = document.getElementById('mods-installed-loading');
    const errorEl = document.getElementById('mods-installed-error');
    if (!listEl || !innerEl) return;
    if (loadingEl) loadingEl.style.display = 'none';
    if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }

    const q = (searchQuery || '').toLowerCase().trim();
    let filtered = q ? mods.filter(m => (m.name && m.name.toLowerCase().includes(q)) || (m.fileName && m.fileName.toLowerCase().includes(q))) : mods;
    // Mods with updates go first

    innerEl.innerHTML = '';
    if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'mods-empty';
        empty.textContent = q ? 'По запросу ничего не найдено.' : 'В этой версии пока нет установленных модов. Добавьте их через вкладку «Скачать моды».';
        innerEl.appendChild(empty);
        return;
    }

    filtered.forEach(mod => {
        const card = document.createElement('div');
        card.className = 'mod-card mod-card-installed';
        const loaderLabel = mod.loader || '—';
        const status = mod.enabled ? '🟢 Включён' : '🔴 Отключён';
        card.innerHTML = `
            <div class="mod-card-main">
                <div class="mod-card-info">
                    <span class="mod-card-name">${escapeHtml(mod.name || mod.fileName)}</span>
                    <span class="mod-card-meta">${escapeHtml(mod.version)} · ${escapeHtml(loaderLabel)}</span>
                    <span class="mod-card-status ${mod.enabled ? 'mod-status-on' : 'mod-status-off'}">${status}</span>
                </div>
                <div class="mod-card-actions">
                    <label class="mod-toggle-wrap">
                        <input type="checkbox" class="mod-toggle" ${mod.enabled ? 'checked' : ''} data-path="${escapeHtml(mod.filePath)}">
                        <span class="mod-toggle-slider"></span>
                    </label>
                    <button type="button" class="mod-btn-detail" data-path="${escapeHtml(mod.filePath)}" title="Подробнее">ℹ</button>
                    <button type="button" class="mod-btn-delete" data-path="${escapeHtml(mod.filePath)}" title="Удалить мод">🗑</button>
                </div>
            </div>
        `;
        innerEl.appendChild(card);
    });

    innerEl.querySelectorAll('.mod-toggle').forEach(cb => {
        cb.addEventListener('change', function () {
            const filePath = this.getAttribute('data-path');
            if (!filePath) return;
            try {
                if (this.checked) {
                    setModEnabled(filePath);
                } else {
                    setModDisabled(filePath);
                }
                refreshInstalledModsList();
            } catch (e) {
                console.error(e);
                showLauncherAlert('Ошибка: ' + (e.message || 'не удалось изменить состояние мода'));
            }
        });
    });

    innerEl.querySelectorAll('.mod-btn-detail').forEach(btn => {
        btn.addEventListener('click', function () {
            const filePath = this.getAttribute('data-path');
            const mod = mods.find(m => m.filePath === filePath);
            if (mod) showModDetail(mod);
        });
    });

    // Delete mod buttons
    innerEl.querySelectorAll('.mod-btn-delete').forEach(btn => {
        btn.addEventListener('click', function () {
            const filePath = this.getAttribute('data-path');
            if (!filePath) return;
            showLauncherConfirm('Удалить этот мод? Файл будет удалён безвозвратно.', 'Удаление мода').then(ok => {
                if (!ok) return;
                try {
                    fs.unlinkSync(filePath);
                    refreshInstalledModsList();
                } catch (e) {
                    showLauncherAlert('Ошибка удаления: ' + (e.message || e));
                }
            });
        });
    });

}


function refreshInstalledModsList() {
    const versionId = localStorage.getItem(VERSION_STORAGE_KEY) || DEFAULT_VERSION_ID;
    const modsPath = getModsPathForVersion(versionId);
    cachedInstalledMods = listInstalledMods(modsPath);
    const searchInput = document.getElementById('mods-search');
    renderInstalledModsList(cachedInstalledMods, searchInput ? searchInput.value : '');

}

function refreshInstalledTexturesList() {
    loadTexturesList();
}

function refreshInstalledShadersList() {
    loadShadersList();
}

const translationCache = new Map();
const MYMEMORY_API = 'https://api.mymemory.translated.net/get';

function isMostlyCyrillic(text) {
    if (!text || typeof text !== 'string') return false;
    const letters = text.replace(/\s/g, '').replace(/[0-9\W]/g, '');
    if (letters.length < 3) return false;
    const cyrillic = (letters.match(/[\u0400-\u04FF]/g) || []).length;
    return cyrillic / letters.length >= 0.3;
}

function translateToRussian(text) {
    if (!text || typeof text !== 'string') return Promise.resolve(text);
    const key = text.slice(0, 400);
    if (translationCache.has(key)) return Promise.resolve(translationCache.get(key));
    const url = MYMEMORY_API + '?q=' + encodeURIComponent(text.slice(0, 500)) + '&langpair=en|ru';
    return new Promise((resolve) => {
        https.get(url, { timeout: 8000 }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    const translated = (json.responseData && json.responseData.translatedText) || text;
                    translationCache.set(key, translated);
                    resolve(translated);
                } catch (_) {
                    resolve(text);
                }
            });
        }).on('error', () => resolve(text));
    });
}

function showModDetail(mod) {
    const overlay = document.getElementById('mods-detail-overlay');
    const titleEl = document.getElementById('mods-detail-title');
    const bodyEl = document.getElementById('mods-detail-body');
    if (!overlay || !titleEl || !bodyEl) return;
    titleEl.textContent = mod.name || mod.fileName;
    const descHtml = mod.description
        ? `<p><strong>Описание:</strong> <span id="mod-detail-desc">${escapeHtml(mod.description)}</span></p>`
        : '';
    bodyEl.innerHTML = `
        <p><strong>Версия:</strong> ${escapeHtml(mod.version || '—')}</p>
        <p><strong>Загрузчик:</strong> ${escapeHtml(mod.loader || '—')}</p>
        <p><strong>Файл:</strong> ${escapeHtml(mod.fileName)}</p>
        <p><strong>Статус:</strong> ${mod.enabled ? '🟢 Включён' : '🔴 Отключён'}</p>
        ${descHtml}
    `;
    overlay.style.display = 'flex';
    if (mod.description && !isMostlyCyrillic(mod.description)) {
        const descEl = document.getElementById('mod-detail-desc');
        if (descEl) {
            descEl.textContent = 'Перевод…';
            translateToRussian(mod.description).then(tr => {
                if (descEl) descEl.textContent = tr;
            });
        }
    }
}

function escapeHtml(str) {
    if (str == null) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
}

function loadModsPanel() {
    const version = getSelectedVersion();
    const versionValueEl = document.getElementById('mods-version-value');
    if (versionValueEl) versionValueEl.textContent = `${version.icon || '📦'} ${version.label}`;

    const noLoaderWarning = document.getElementById('mods-warning-noloader');
    if (noLoaderWarning) {
        noLoaderWarning.style.display = versionHasModLoader(version) ? 'none' : 'block';
    }

    const modsPath = getModsPathForVersion(version.id);
    if (!fs.existsSync(path.dirname(modsPath))) {
        const innerEl = document.getElementById('mods-installed-list-inner');
        const loadingEl = document.getElementById('mods-installed-loading');
        const errorEl = document.getElementById('mods-installed-error');
        if (loadingEl) loadingEl.style.display = 'none';
        if (innerEl) innerEl.innerHTML = '';
        if (errorEl) {
            errorEl.textContent = 'Папка для этой версии ещё не создана. Запустите игру один раз.';
            errorEl.style.display = 'block';
        }
    } else {
        showModsSkeleton();
        refreshInstalledModsList();
    }

    // Загрузка текстур
    loadTexturesList();

    // Загрузка шейдеров
    loadShadersList();

    if (!modsPanelLoaded) {
        initModsPanel();
        modsPanelLoaded = true;
    }
}

function loadTexturesList() {
    const version = getSelectedVersion();
    const resourcePacksPath = getResourcePacksPathForVersion(version.id);
    const innerEl = document.getElementById('textures-installed-list-inner');
    const loadingEl = document.getElementById('textures-installed-loading');
    const errorEl = document.getElementById('textures-installed-error');

    if (!fs.existsSync(path.dirname(resourcePacksPath))) {
        if (loadingEl) loadingEl.style.display = 'none';
        if (innerEl) innerEl.innerHTML = '';
        if (errorEl) {
            errorEl.textContent = 'Папка resourcepacks ещё не создана. Запустите игру один раз.';
            errorEl.style.display = 'block';
        }
        return;
    }

    try {
        const files = fs.readdirSync(resourcePacksPath).filter(f => f.endsWith('.zip') || f.endsWith('.jar') || fs.statSync(path.join(resourcePacksPath, f)).isDirectory());
        if (loadingEl) loadingEl.style.display = 'none';
        if (innerEl) {
            innerEl.innerHTML = '';
            if (files.length === 0) {
                innerEl.innerHTML = '<div class="mods-empty">Текстур не найдено. Поместите файлы текстур в папку resourcepacks.</div>';
            } else {
                files.forEach(fileName => {
                    const filePath = path.join(resourcePacksPath, fileName);
                    const card = document.createElement('div');
                    card.className = 'mod-card';
                    card.innerHTML = `
                        <div class="mod-card-main">
                            <div class="mod-card-info">
                                <span class="mod-card-name">${escapeHtml(fileName)}</span>
                                <span class="mod-card-meta">Текстурный пак</span>
                            </div>
                            <div class="mod-card-actions">
                                <div class="mod-card-status">🟢 Установлено</div>
                                <button type="button" class="mod-btn-delete" data-path="${escapeHtml(filePath)}" data-type="texture" title="Удалить">🗑</button>
                            </div>
                        </div>
                    `;
                    card.querySelector('.mod-btn-delete').addEventListener('click', function() {
                        showLauncherConfirm('Удалить этот текстурный пак?', 'Удаление').then(ok => {
                            if (!ok) return;
                            try { fs.unlinkSync(filePath); } catch(e) {}
                            loadTexturesList();
                        });
                    });
                    innerEl.appendChild(card);
                });
            }
        }
        if (errorEl) errorEl.style.display = 'none';
    } catch (err) {
        if (loadingEl) loadingEl.style.display = 'none';
        if (errorEl) {
            errorEl.textContent = 'Ошибка: ' + (err.message || 'неизвестная ошибка');
            errorEl.style.display = 'block';
        }
    }
}

function loadShadersList() {
    const version = getSelectedVersion();
    const shaderPacksPath = getShadersPathForVersion(version.id);
    const innerEl = document.getElementById('shaders-installed-list-inner');
    const loadingEl = document.getElementById('shaders-installed-loading');
    const errorEl = document.getElementById('shaders-installed-error');

    if (!fs.existsSync(path.dirname(shaderPacksPath))) {
        if (loadingEl) loadingEl.style.display = 'none';
        if (innerEl) innerEl.innerHTML = '';
        if (errorEl) {
            errorEl.textContent = 'Папка shaderpacks ещё не создана. Запустите игру один раз.';
            errorEl.style.display = 'block';
        }
        return;
    }

    try {
        const files = fs.readdirSync(shaderPacksPath).filter(f => f.endsWith('.zip') || f.endsWith('.jar') || fs.statSync(path.join(shaderPacksPath, f)).isDirectory());
        if (loadingEl) loadingEl.style.display = 'none';
        if (innerEl) {
            innerEl.innerHTML = '';
            if (files.length === 0) {
                innerEl.innerHTML = '<div class="mods-empty">Шейдеров не найдено. Поместите файлы шейдеров в папку shaderpacks.</div>';
            } else {
                files.forEach(fileName => {
                    const filePath = path.join(shaderPacksPath, fileName);
                    const card = document.createElement('div');
                    card.className = 'mod-card';
                    card.innerHTML = `
                        <div class="mod-card-main">
                            <div class="mod-card-info">
                                <span class="mod-card-name">${escapeHtml(fileName)}</span>
                                <span class="mod-card-meta">Шейдерный пак</span>
                            </div>
                            <div class="mod-card-actions">
                                <div class="mod-card-status">🟢 Установлено</div>
                                <button type="button" class="mod-btn-delete" data-path="${escapeHtml(filePath)}" title="Удалить">🗑</button>
                            </div>
                        </div>
                    `;
                    card.querySelector('.mod-btn-delete').addEventListener('click', function() {
                        showLauncherConfirm('Удалить этот шейдерный пак?', 'Удаление').then(ok => {
                            if (!ok) return;
                            try {
                                const stat = fs.statSync(filePath);
                                if (stat.isDirectory()) {
                                    fs.rmSync(filePath, { recursive: true, force: true });
                                } else {
                                    fs.unlinkSync(filePath);
                                }
                            } catch(e) {}
                            loadShadersList();
                        });
                    });
                    innerEl.appendChild(card);
                });
            }
        }
        if (errorEl) errorEl.style.display = 'none';
    } catch (err) {
        if (loadingEl) loadingEl.style.display = 'none';
        if (errorEl) {
            errorEl.textContent = 'Ошибка: ' + (err.message || 'неизвестная ошибка');
            errorEl.style.display = 'block';
        }
    }
}

function initModsPanel() {
    document.querySelectorAll('.mods-subtab').forEach(tab => {
        tab.addEventListener('click', function () {
            const t = this.getAttribute('data-modstab');
            document.querySelectorAll('.mods-subtab').forEach(x => x.classList.remove('active'));
            this.classList.add('active');

            // Скрываем все секции
            document.getElementById('mods-section-mods').style.display = 'none';
            document.getElementById('mods-section-textures').style.display = 'none';
            document.getElementById('mods-section-shaders').style.display = 'none';

            // Показываем нужную с анимацией
            let targetSection = null;
            if (t === 'mods') {
                targetSection = document.getElementById('mods-section-mods');
            } else if (t === 'textures') {
                targetSection = document.getElementById('mods-section-textures');
            } else if (t === 'shaders') {
                targetSection = document.getElementById('mods-section-shaders');
            }
            if (targetSection) {
                targetSection.style.display = 'block';
                // Re-trigger animation
                targetSection.style.animation = 'none';
                void targetSection.offsetWidth;
                targetSection.style.animation = '';
            }
        });
    });

    const searchInput = document.getElementById('mods-search');
    if (searchInput) {
        searchInput.addEventListener('input', () => renderInstalledModsList(cachedInstalledMods, searchInput.value));
    }

    const texturesSearchInput = document.getElementById('textures-search');
    if (texturesSearchInput) {
        texturesSearchInput.addEventListener('input', () => {
            const query = texturesSearchInput.value.toLowerCase();
            const cards = document.querySelectorAll('#textures-installed-list-inner .mod-card');
            cards.forEach(card => {
                const name = card.querySelector('.mod-card-name').textContent.toLowerCase();
                card.style.display = name.includes(query) ? '' : 'none';
            });
        });
    }

    const shadersSearchInput = document.getElementById('shaders-search');
    if (shadersSearchInput) {
        shadersSearchInput.addEventListener('input', () => {
            const query = shadersSearchInput.value.toLowerCase();
            const cards = document.querySelectorAll('#shaders-installed-list-inner .mod-card');
            cards.forEach(card => {
                const name = card.querySelector('.mod-card-name').textContent.toLowerCase();
                card.style.display = name.includes(query) ? '' : 'none';
            });
        });
    }

    // Поиск текстур на Modrinth
    const texturesModrinthSearchBtn = document.getElementById('textures-modrinth-search-btn');
    const texturesModrinthSearchInput = document.getElementById('textures-modrinth-search');
    const texturesGridEl = document.getElementById('textures-download-grid');
    const texturesPlaceholderEl = document.getElementById('textures-download-placeholder');
    const texturesLoadingEl = document.getElementById('textures-download-loading');
    const texturesErrorEl = document.getElementById('textures-download-error');

    function doTexturesModrinthSearch() {
        const query = (texturesModrinthSearchInput && texturesModrinthSearchInput.value) ? texturesModrinthSearchInput.value.trim() : '';
        if (!query) return;
        const version = getSelectedVersion();
        const gameVersion = version.mcVersion || '1.21.4';
        if (texturesPlaceholderEl) texturesPlaceholderEl.style.display = 'none';
        if (texturesErrorEl) texturesErrorEl.style.display = 'none';
        if (texturesLoadingEl) texturesLoadingEl.style.display = 'block';
        if (texturesGridEl) texturesGridEl.innerHTML = '';

        searchModrinth(query, gameVersion, null, 24, 'resourcepack')
            .then(data => {
                if (texturesLoadingEl) texturesLoadingEl.style.display = 'none';
                const hits = data.hits || [];
                if (!texturesGridEl) return;
                texturesGridEl.innerHTML = '';
                hits.forEach(project => {
                    const card = document.createElement('div');
                    card.className = 'mod-card mod-card-download';
                    const desc = (project.description || '').slice(0, 120) + ((project.description || '').length > 120 ? '…' : '');
                    const icon = project.icon_url ? `<img src="${escapeHtml(project.icon_url)}" alt="" class="mod-download-icon">` : '<span class="mod-download-icon mod-download-icon-placeholder">📦</span>';
                    card.innerHTML = `
                        <div class="mod-download-icon-wrap">${icon}</div>
                        <div class="mod-download-info">
                            <span class="mod-download-name">${escapeHtml(project.title || project.project_id)}</span>
                            <div class="mod-download-desc-wrap">
                                <span class="mod-download-desc" data-original-desc="${escapeHtml((project.description || '').slice(0, 500))}">${escapeHtml(desc)}</span>
                                ${project.description && !isMostlyCyrillic(project.description) ? '<button type="button" class="mod-btn-translate" title="Перевести на русский">Ru</button>' : ''}
                            </div>
                            <span class="mod-download-meta">${(project.versions || []).slice(0, 3).join(', ')} · ${project.downloads || 0} загрузок</span>
                            <button type="button" class="mod-btn-install" data-project-id="${escapeHtml(project.project_id)}" data-slug="${escapeHtml(project.slug || '')}">Установить</button>
                        </div>
                    `;
                    texturesGridEl.appendChild(card);
                });
                texturesGridEl.querySelectorAll('.mod-btn-translate').forEach(btn => {
                    btn.addEventListener('click', function () {
                        const wrap = this.closest('.mod-download-desc-wrap');
                        const descEl = wrap && wrap.querySelector('.mod-download-desc');
                        const original = descEl && descEl.getAttribute('data-original-desc');
                        if (!original) return;
                        this.disabled = true;
                        this.textContent = '…';
                        translateToRussian(original).then(tr => {
                            if (descEl) descEl.textContent = tr.slice(0, 120) + (tr.length > 120 ? '…' : '');
                            this.remove();
                        }).catch(() => { this.disabled = false; this.textContent = 'Ru'; });
                    });
                });
                texturesGridEl.querySelectorAll('.mod-btn-install').forEach(btn => {
                    btn.addEventListener('click', function () {
                        const projectId = this.getAttribute('data-project-id');
                        const slug = this.getAttribute('data-slug');
                        installModFromModrinth(projectId || slug, this, 'resourcepack');
                    });
                });
            })
            .catch(err => {
                if (texturesLoadingEl) texturesLoadingEl.style.display = 'none';
                if (texturesErrorEl) {
                    texturesErrorEl.textContent = '❌ ' + (err.message || 'Не удалось подключиться к Modrinth. Проверьте интернет.');
                    texturesErrorEl.style.display = 'block';
                }
            });
    }

    if (texturesModrinthSearchBtn) texturesModrinthSearchBtn.addEventListener('click', doTexturesModrinthSearch);
    if (texturesModrinthSearchInput) texturesModrinthSearchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doTexturesModrinthSearch(); });

    // Поиск шейдеров на Modrinth
    const shadersModrinthSearchBtn = document.getElementById('shaders-modrinth-search-btn');
    const shadersModrinthSearchInput = document.getElementById('shaders-modrinth-search');
    const shadersGridEl = document.getElementById('shaders-download-grid');
    const shadersPlaceholderEl = document.getElementById('shaders-download-placeholder');
    const shadersLoadingEl = document.getElementById('shaders-download-loading');
    const shadersErrorEl = document.getElementById('shaders-download-error');

    function doShadersModrinthSearch() {
        const query = (shadersModrinthSearchInput && shadersModrinthSearchInput.value) ? shadersModrinthSearchInput.value.trim() : '';
        if (!query) return;
        const version = getSelectedVersion();
        const gameVersion = version.mcVersion || '1.21.4';
        if (shadersPlaceholderEl) shadersPlaceholderEl.style.display = 'none';
        if (shadersErrorEl) shadersErrorEl.style.display = 'none';
        if (shadersLoadingEl) shadersLoadingEl.style.display = 'block';
        if (shadersGridEl) shadersGridEl.innerHTML = '';

        searchModrinth(query, gameVersion, null, 24, 'shader')
            .then(data => {
                if (shadersLoadingEl) shadersLoadingEl.style.display = 'none';
                const hits = data.hits || [];
                if (!shadersGridEl) return;
                shadersGridEl.innerHTML = '';
                hits.forEach(project => {
                    const card = document.createElement('div');
                    card.className = 'mod-card mod-card-download';
                    const desc = (project.description || '').slice(0, 120) + ((project.description || '').length > 120 ? '…' : '');
                    const icon = project.icon_url ? `<img src="${escapeHtml(project.icon_url)}" alt="" class="mod-download-icon">` : '<span class="mod-download-icon mod-download-icon-placeholder">📦</span>';
                    card.innerHTML = `
                        <div class="mod-download-icon-wrap">${icon}</div>
                        <div class="mod-download-info">
                            <span class="mod-download-name">${escapeHtml(project.title || project.project_id)}</span>
                            <div class="mod-download-desc-wrap">
                                <span class="mod-download-desc" data-original-desc="${escapeHtml((project.description || '').slice(0, 500))}">${escapeHtml(desc)}</span>
                                ${project.description && !isMostlyCyrillic(project.description) ? '<button type="button" class="mod-btn-translate" title="Перевести на русский">Ru</button>' : ''}
                            </div>
                            <span class="mod-download-meta">${(project.versions || []).slice(0, 3).join(', ')} · ${project.downloads || 0} загрузок</span>
                            <button type="button" class="mod-btn-install" data-project-id="${escapeHtml(project.project_id)}" data-slug="${escapeHtml(project.slug || '')}">Установить</button>
                        </div>
                    `;
                    shadersGridEl.appendChild(card);
                });
                shadersGridEl.querySelectorAll('.mod-btn-translate').forEach(btn => {
                    btn.addEventListener('click', function () {
                        const wrap = this.closest('.mod-download-desc-wrap');
                        const descEl = wrap && wrap.querySelector('.mod-download-desc');
                        const original = descEl && descEl.getAttribute('data-original-desc');
                        if (!original) return;
                        this.disabled = true;
                        this.textContent = '…';
                        translateToRussian(original).then(tr => {
                            if (descEl) descEl.textContent = tr.slice(0, 120) + (tr.length > 120 ? '…' : '');
                            this.remove();
                        }).catch(() => { this.disabled = false; this.textContent = 'Ru'; });
                    });
                });
                shadersGridEl.querySelectorAll('.mod-btn-install').forEach(btn => {
                    btn.addEventListener('click', function () {
                        const projectId = this.getAttribute('data-project-id');
                        const slug = this.getAttribute('data-slug');
                        installModFromModrinth(projectId || slug, this, 'shader');
                    });
                });
            })
            .catch(err => {
                if (shadersLoadingEl) shadersLoadingEl.style.display = 'none';
                if (shadersErrorEl) {
                    shadersErrorEl.textContent = '❌ ' + (err.message || 'Не удалось подключиться к Modrinth. Проверьте интернет.');
                    shadersErrorEl.style.display = 'block';
                }
            });
    }

    if (shadersModrinthSearchBtn) shadersModrinthSearchBtn.addEventListener('click', doShadersModrinthSearch);
    if (shadersModrinthSearchInput) shadersModrinthSearchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doShadersModrinthSearch(); });

    document.getElementById('mods-detail-close')?.addEventListener('click', () => {
        document.getElementById('mods-detail-overlay').style.display = 'none';
    });
    document.getElementById('mods-detail-overlay')?.addEventListener('click', function (e) {
        if (e.target === this) this.style.display = 'none';
    });

    // Переключение между табами "Установленные" и "Поиск" для модов, текстур и шейдеров
    function setupModsTabs(prefix) {
        const tabs = document.querySelectorAll(`[data-modstab-view^="${prefix}-"]`);
        let viewInstalled, viewSearch;
        
        if (prefix === 'mods') {
            // Для модов используем упрощённые ID
            viewInstalled = document.getElementById('mods-view-installed');
            viewSearch = document.getElementById('mods-view-search');
        } else {
            // Для текстур и шейдеров используем полные ID
            viewInstalled = document.getElementById(`mods-view-${prefix}-installed`);
            viewSearch = document.getElementById(`mods-view-${prefix}-search`);
        }

        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const targetView = tab.getAttribute('data-modstab-view');

                // Убираем активный класс со всех табов этой секции
                tabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');

                // Переключаем виды
                if (targetView === `${prefix}-installed`) {
                    if (viewInstalled) viewInstalled.style.display = 'flex';
                    if (viewSearch) viewSearch.style.display = 'none';
                } else if (targetView === `${prefix}-search`) {
                    if (viewInstalled) viewInstalled.style.display = 'none';
                    if (viewSearch) viewSearch.style.display = 'flex';
                }
            });
        });
    }

    setupModsTabs('mods');
    setupModsTabs('textures');
    setupModsTabs('shaders');

    // Поиск модов на Modrinth
    const modrinthSearchBtn = document.getElementById('mods-modrinth-search-btn');
    const modrinthSearchInput = document.getElementById('mods-modrinth-search');
    const gridEl = document.getElementById('mods-download-grid');
    const placeholderEl = document.getElementById('mods-download-placeholder');
    const loadingEl = document.getElementById('mods-download-loading');
    const errorEl = document.getElementById('mods-download-error');

    function getLoaderForModrinth(version) {
        const t = (version && version.type || '').toLowerCase();
        if (t === 'neoforge') return 'neoforge';
        if (t === 'forge' || t === 'legacy_forge') return 'forge';
        return 'fabric';
    }

    function doModrinthSearch() {
        const query = (modrinthSearchInput && modrinthSearchInput.value) ? modrinthSearchInput.value.trim() : '';
        if (!query) return;
        const version = getSelectedVersion();
        const gameVersion = version.mcVersion || '1.21.4';
        const loader = getLoaderForModrinth(version);
        if (placeholderEl) placeholderEl.style.display = 'none';
        if (errorEl) errorEl.style.display = 'none';
        if (loadingEl) loadingEl.style.display = 'block';
        if (gridEl) gridEl.innerHTML = '';

        searchModrinth(query, gameVersion, loader, 24)
            .then(data => {
                if (loadingEl) loadingEl.style.display = 'none';
                const hits = data.hits || [];
                if (!gridEl) return;
                gridEl.innerHTML = '';
                hits.forEach(project => {
                    const card = document.createElement('div');
                    card.className = 'mod-card mod-card-download';
                    const desc = (project.description || '').slice(0, 120) + ((project.description || '').length > 120 ? '…' : '');
                    const icon = project.icon_url ? `<img src="${escapeHtml(project.icon_url)}" alt="" class="mod-download-icon">` : '<span class="mod-download-icon mod-download-icon-placeholder">📦</span>';
                    card.innerHTML = `
                        <div class="mod-download-icon-wrap">${icon}</div>
                        <div class="mod-download-info">
                            <span class="mod-download-name">${escapeHtml(project.title || project.project_id)}</span>
                            <div class="mod-download-desc-wrap">
                                <span class="mod-download-desc" data-original-desc="${escapeHtml((project.description || '').slice(0, 500))}">${escapeHtml(desc)}</span>
                                ${project.description && !isMostlyCyrillic(project.description) ? '<button type="button" class="mod-btn-translate" title="Перевести на русский">Ru</button>' : ''}
                            </div>
                            <span class="mod-download-meta">${(project.versions || []).slice(0, 3).join(', ')} · ${project.downloads || 0} загрузок</span>
                            <button type="button" class="mod-btn-install" data-project-id="${escapeHtml(project.project_id)}" data-slug="${escapeHtml(project.slug || '')}">Установить</button>
                        </div>
                    `;
                    gridEl.appendChild(card);
                });
                gridEl.querySelectorAll('.mod-btn-translate').forEach(btn => {
                    btn.addEventListener('click', function () {
                        const wrap = this.closest('.mod-download-desc-wrap');
                        const descEl = wrap && wrap.querySelector('.mod-download-desc');
                        const original = descEl && descEl.getAttribute('data-original-desc');
                        if (!original) return;
                        this.disabled = true;
                        this.textContent = '…';
                        translateToRussian(original).then(tr => {
                            if (descEl) descEl.textContent = tr.slice(0, 120) + (tr.length > 120 ? '…' : '');
                            this.remove();
                        }).catch(() => { this.disabled = false; this.textContent = 'Ru'; });
                    });
                });
                gridEl.querySelectorAll('.mod-btn-install').forEach(btn => {
                    btn.addEventListener('click', function () {
                        const projectId = this.getAttribute('data-project-id');
                        const slug = this.getAttribute('data-slug');
                        installModFromModrinth(projectId || slug, this);
                    });
                });
            })
            .catch(err => {
                if (loadingEl) loadingEl.style.display = 'none';
                if (errorEl) {
                    errorEl.textContent = '❌ ' + (err.message || 'Не удалось подключиться к Modrinth. Проверьте интернет.');
                    errorEl.style.display = 'block';
                }
            });
    }

    if (modrinthSearchBtn) {
        modrinthSearchBtn.addEventListener('click', doModrinthSearch);
    } else {
        console.error('mods-modrinth-search-btn not found');
    }
    if (modrinthSearchInput) {
        modrinthSearchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doModrinthSearch(); });
    }

    function installModFromModrinth (projectIdOrSlug, buttonEl, projectType = 'mod') {
        const version = getSelectedVersion();
        const gameVersions = [version.mcVersion || '1.21.4'];
        // Shaders and resourcepacks don't filter by loader — pass empty array
        const loaders = [];
        if (projectType === 'mod') {
            if (version.type === 'evacuation' || version.type === 'custom' || version.type === 'fabric') loaders.push('fabric');
            else if (version.type === 'neoforge') loaders.push('neoforge');
            else if (version.type === 'forge' || version.type === 'legacy_forge') loaders.push('forge');
            else loaders.push('fabric');
        }

        // Определяем путь установки в зависимости от типа проекта
        let installPath;
        if (projectType === 'resourcepack') {
            installPath = getResourcePacksPathForVersion(version.id);
        } else if (projectType === 'shader') {
            installPath = getShadersPathForVersion(version.id);
        } else {
            installPath = getModsPathForVersion(version.id);
        }

        if (buttonEl) {
            buttonEl.disabled = true;
            buttonEl.textContent = 'Загрузка...';
        }
        // Inline progress bar
        let inlineProgress = null;
        if (buttonEl && buttonEl.parentElement) {
            inlineProgress = createInlineProgress(buttonEl.parentElement);
        }
        function done() {
            if (inlineProgress) { inlineProgress.remove(); inlineProgress = null; }
            if (buttonEl) { buttonEl.disabled = false; buttonEl.textContent = 'Установить'; }
            if (projectType === 'mod') {
                refreshInstalledModsList();
            } else if (projectType === 'resourcepack') {
                refreshInstalledTexturesList();
            } else if (projectType === 'shader') {
                refreshInstalledShadersList();
                // Iris мог установиться как зависимость — обновляем и список модов
                refreshInstalledModsList();
            }
        }
        function fail(err) {
            if (inlineProgress) { inlineProgress.remove(); inlineProgress = null; }
            if (buttonEl) { buttonEl.disabled = false; buttonEl.textContent = 'Установить'; }
            showLauncherAlert('Ошибка установки: ' + (err.message || 'неизвестная ошибка'));
        }
        function onDlProgress(received, total) {
            if (inlineProgress) inlineProgress.update(received, total);
        }

        getModrinthProjectVersions(projectIdOrSlug, gameVersions, loaders)
            .then(versions => {
                if (!versions || versions.length === 0) {
                    done();
                    showLauncherAlert('Нет версии проекта для выбранной версии игры. Попробуйте другую версию Minecraft.');
                    return;
                }
                const v = versions[0];
                const primaryFile = (v.files || []).find(f => f.primary) || (v.files || [])[0];
                if (!primaryFile || !primaryFile.url) {
                    done();
                    showLauncherAlert('Не удалось получить ссылку на файл.');
                    return;
                }

                // Для ресурспаков — без зависимостей
                if (projectType === 'resourcepack') {
                    if (!fs.existsSync(installPath)) fs.mkdirSync(installPath, { recursive: true });
                    const fileName = primaryFile.filename || path.basename(primaryFile.url) || `file-${v.id}`;
                    const destPath = path.join(installPath, fileName);
                    return downloadModFile(primaryFile.url, destPath, onDlProgress).then(() => {
                        done();
                        showLauncherAlert('Текстуры установлены.');
                    }).catch(fail);
                }

                // Для шейдеров — всегда проверяем наличие Iris/OptiFine
                if (projectType === 'shader') {
                    const hasFabric = version.type === 'fabric' || version.type === 'evacuation' || version.type === 'custom';
                    const hasForge = version.type === 'forge' || version.type === 'neoforge' || version.type === 'legacy_forge';
                    const hasLoader = hasFabric || hasForge;

                    // Always warn: shaders require Iris (Fabric) or OptiFine (Forge/Vanilla)
                    const doInstall = () => {
                        if (!fs.existsSync(installPath)) fs.mkdirSync(installPath, { recursive: true });
                        const fn = primaryFile.filename || path.basename(primaryFile.url) || `shader-${v.id}`;
                        return downloadModFile(primaryFile.url, path.join(installPath, fn), onDlProgress)
                            .then(() => { done(); showLauncherAlert('Шейдеры установлены!'); })
                            .catch(fail);
                    };

                    if (!hasLoader) {
                        // Pure vanilla — ask to switch version
                        return showLauncherConfirm(
                            'Шейдеры требуют мод-загрузчик:\n\n• Iris Shaders (Fabric) — для современных шейдеров\n• OptiFine (Forge) — для классических шейдеров\n\nВаша версия без загрузчика. Переключиться на версию с Fabric?',
                            '⚠️ Требуется мод-загрузчик'
                        ).then(yes => {
                            if (yes) {
                                // Switch to evacuation (Fabric) version
                                setSelectedVersion('evacuation');
                                showLauncherAlert('Версия переключена на VanillaSuns — Выживание (Fabric). Теперь установите Iris Shaders из поиска модов, затем шейдерпак.');
                            } else {
                                return doInstall();
                            }
                        });
                    }

                    if (hasFabric) {
                        // Has Fabric — check if Iris is installed
                        const versionId = localStorage.getItem(VERSION_STORAGE_KEY) || DEFAULT_VERSION_ID;
                        const modsPath = getModsPathForVersion(versionId);
                        let irisInstalled = false;
                        try {
                            irisInstalled = fs.existsSync(modsPath) &&
                                fs.readdirSync(modsPath).some(f => f.toLowerCase().includes('iris'));
                        } catch(e) {}

                        if (!irisInstalled) {
                            const gameVersions2 = [version.mcVersion || '1.21.4'];
                            return collectAllDepsInfo('iris', gameVersions2, ['fabric'], null).then(transitiveDeps => {
                                let msg = 'Для работы шейдеров нужен Iris Shaders.';
                                if (transitiveDeps.length > 0) {
                                    const depNames = transitiveDeps.map(d => d.title).join(', ');
                                    msg += '\n\nТакже будут автоматически установлены зависимости Iris: ' + depNames + '.';
                                }
                                msg += '\n\nУстановить Iris вместе с шейдерпаком?';
                                return showLauncherConfirm(msg, '🔵 Зависимость: Iris Shaders').then(installIris => {
                                    if (installIris) {
                                        return installOneModFromModrinth('iris', gameVersions2, ['fabric'], modsPath)
                                            .then(() => doInstall())
                                            .catch(() => doInstall());
                                    } else {
                                        return doInstall();
                                    }
                                });
                            }).catch(() => {
                                return showLauncherConfirm(
                                    'Для работы шейдеров нужен Iris Shaders.\n\nУстановить Iris автоматически вместе с шейдерпаком?',
                                    '🔵 Зависимость: Iris Shaders'
                                ).then(installIris => {
                                    if (installIris) {
                                        return installOneModFromModrinth('iris', gameVersions2, ['fabric'], modsPath)
                                            .then(() => doInstall())
                                            .catch(() => doInstall());
                                    } else {
                                        return doInstall();
                                    }
                                });
                            });
                        }
                    }

                    return doInstall();
                }

                // Для модов проверяем зависимости (включая транзитивные)
                const requiredDeps = (v.dependencies || []).filter(d => d.dependency_type === 'required' && d.project_id);
                const uniqueProjectIds = [...new Set(requiredDeps.map(d => d.project_id))];

                if (uniqueProjectIds.length === 0) {
                    if (!fs.existsSync(installPath)) fs.mkdirSync(installPath, { recursive: true });
                    const fileName = primaryFile.filename || path.basename(primaryFile.url) || `mod-${v.id}.jar`;
                    const destPath = path.join(installPath, fileName);
                    return downloadModFile(primaryFile.url, destPath, onDlProgress).then(() => {
                        done();
                        showToast('Мод установлен!', 'success');
                    }).catch(fail);
                }

                // Collect all transitive deps info for display
                Promise.all(uniqueProjectIds.map(pid =>
                    collectAllDepsInfo(pid, gameVersions, loaders, null).then(sub =>
                        getModrinthProject(pid).then(proj => [{ project_id: pid, title: (proj && proj.title) || pid }, ...sub]).catch(() => [{ project_id: pid, title: pid }, ...sub])
                    ).catch(() => [{ project_id: pid, title: pid }])
                )).then(groups => {
                    const allDeps = groups.flat();
                    // Deduplicate
                    const seen = new Set();
                    const deduped = allDeps.filter(d => { if (seen.has(d.project_id)) return false; seen.add(d.project_id); return true; });
                    const names = deduped.map(d => d.title).join(', ');
                    const hasTransitive = deduped.length > uniqueProjectIds.length;
                    let confirmMsg = 'У этого мода есть обязательные зависимости: ' + names + '.';
                    if (hasTransitive) {
                        confirmMsg += '\n\nВключены транзитивные зависимости (зависимости зависимостей).';
                    }
                    confirmMsg += '\n\nУстановить их вместе с модом?';
                    return showLauncherConfirm(confirmMsg, 'Зависимости мода').then(installDeps => {
                        let chain = Promise.resolve();
                        if (installDeps) {
                            uniqueProjectIds.forEach(pid => {
                                chain = chain.then(() => installOneModFromModrinth(pid, gameVersions, loaders, installPath)).catch(err => {
                                    console.warn('Dependency install failed:', pid, err);
                                });
                            });
                        }
                        return chain.then(() => {
                            if (!fs.existsSync(installPath)) fs.mkdirSync(installPath, { recursive: true });
                            const fileName = primaryFile.filename || path.basename(primaryFile.url) || `mod-${v.id}.jar`;
                            const destPath = path.join(installPath, fileName);
                            return downloadModFile(primaryFile.url, destPath, onDlProgress);
                        }).then(() => {
                            done();
                            showToast(installDeps ? 'Мод и зависимости установлены!' : 'Мод установлен!', 'success');
                        }).catch(fail);
                    });
                }).catch(fail);
            })
            .catch(fail);
    }

    window.installModFromModrinth = installModFromModrinth;
}

// Проверка и загрузка версии Minecraft
function checkAndDownloadVersion(minecraftPath, version, withMods) {
    return new Promise((resolve, reject) => {
        const versionsPath = path.join(minecraftPath, 'versions', version);
        const versionJsonPath = path.join(versionsPath, version + '.json');
        const clientJarPath = path.join(versionsPath, version + '.jar');
        
        // Проверяем, установлена ли версия
        if (fs.existsSync(clientJarPath) && fs.existsSync(versionJsonPath)) {
            console.log('Version already installed:', version);
            updateProgress(30, 'Версия уже установлена, проверка ресурсов...');
            
            // Загружаем version.json для проверки assets
            try {
                const versionData = JSON.parse(fs.readFileSync(versionJsonPath, 'utf8'));
                
                // Проверяем наличие индекса ресурсов
                const assetIndex = versionData.assetIndex?.id || versionData.assetIndex;
                const assetsIndexPath = path.join(minecraftPath, 'assets', 'indexes', (assetIndex || '1.21') + '.json');
                
                if (!fs.existsSync(assetsIndexPath) && versionData.assetIndex) {
                    console.log('Asset index missing, downloading assets...');
                    updateProgress(40, 'Загрузка ресурсов (assets)...');
                    downloadAssets(minecraftPath, versionData).then(() => {
                        // Проверяем наличие нативных библиотек
                        const nativesPath = path.join(minecraftPath, 'natives');
                        const lwjglDll = path.join(nativesPath, 'lwjgl.dll');
                        if (!fs.existsSync(lwjglDll)) {
                            console.log('Native libraries missing, extracting...');
                            updateProgress(50, 'Извлечение нативных библиотек...');
                            extractNatives(minecraftPath, version).then(() => {
                                resolve();
                            }).catch((error) => {
                                console.warn('Failed to extract natives:', error);
                                resolve(); // Продолжаем даже при ошибке
                            });
                        } else {
                            resolve();
                        }
                    }).catch((error) => {
                        console.warn('Failed to download assets:', error);
                        resolve(); // Продолжаем даже при ошибке
                    });
                } else {
                    // Проверяем наличие нативных библиотек
                    const nativesPath = path.join(minecraftPath, 'natives');
                    const lwjglDll = path.join(nativesPath, 'lwjgl.dll');
                    if (!fs.existsSync(lwjglDll)) {
                        console.log('Native libraries missing, extracting...');
                        updateProgress(50, 'Извлечение нативных библиотек...');
                        extractNatives(minecraftPath, version).then(() => {
                            resolve();
                        }).catch((error) => {
                            console.warn('Failed to extract natives:', error);
                            resolve(); // Продолжаем даже при ошибке
                        });
                    } else {
                        resolve();
                    }
                }
            } catch (error) {
                console.warn('Failed to read version.json:', error);
                resolve(); // Продолжаем даже при ошибке
            }
            return;
        }
        
        updateProgress(15, 'Получение информации о версии...');
        
        if (withMods) {
            // Для Fabric версии
            installFabricVersion(minecraftPath, version).then(resolve).catch(reject);
        } else {
            // Для обычной версии
            installVanillaVersion(minecraftPath, version).then(resolve).catch(reject);
        }
    });
}

// Установка обычной версии Minecraft
function installVanillaVersion(minecraftPath, version) {
    return new Promise((resolve, reject) => {
        updateProgress(20, 'Загрузка манифеста версий...');
        
        fetchJSON('https://launchermeta.mojang.com/mc/game/version_manifest.json')
            .then(manifest => {
                const versionInfo = manifest.versions.find(v => v.id === version);
                if (!versionInfo) {
                    reject(new Error(`Version ${version} not found`));
                    return;
                }
                
                updateProgress(25, 'Загрузка информации о версии...');
                return fetchJSON(versionInfo.url);
            })
            .then(versionData => {
                const versionsPath = path.join(minecraftPath, 'versions', version);
                if (!fs.existsSync(versionsPath)) {
                    fs.mkdirSync(versionsPath, { recursive: true });
                }
                
                // Сохраняем version.json
                const versionJsonPath = path.join(versionsPath, version + '.json');
                fs.writeFileSync(versionJsonPath, JSON.stringify(versionData, null, 2));
                
                updateProgress(30, 'Загрузка клиентского jar...');
                const clientJarPath = path.join(versionsPath, version + '.jar');
                
                return downloadFile(versionData.downloads.client.url, clientJarPath, (downloaded, total) => {
                    const percent = Math.floor((downloaded / total) * 20) + 30;
                    updateProgress(percent, `Загрузка клиента: ${Math.floor(downloaded / 1024 / 1024)}MB / ${Math.floor(total / 1024 / 1024)}MB`);
                }).then(() => versionData); // Возвращаем versionData для следующего шага
            })
            .then((versionData) => {
                updateProgress(50, 'Загрузка библиотек...');
                return downloadLibraries(minecraftPath, version).then(() => versionData);
            })
            .then((versionData) => {
                updateProgress(60, 'Загрузка ресурсов (assets)...');
                console.log('Downloading assets with versionData:', JSON.stringify(versionData.assetIndex, null, 2));
                return downloadAssets(minecraftPath, versionData).then(() => versionData);
            })
            .then((versionData) => {
                updateProgress(70, 'Извлечение нативных библиотек...');
                return extractNatives(minecraftPath, version).then(() => versionData);
            })
            .then(() => {
                updateProgress(100, 'Версия установлена!');
                resolve();
            })
            .catch(reject);
    });
}

// Получение последней версии Fabric Loader для указанной версии Minecraft
function getLatestFabricLoaderVersion(mcVersion) {
    return new Promise((resolve, reject) => {
        const apiUrl = `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}`;
        console.log('Fetching latest Fabric Loader version from:', apiUrl);
        
        fetchJSON(apiUrl)
            .then(versions => {
                console.log('Fabric API response:', JSON.stringify(versions, null, 2));
                
                if (!versions || versions.length === 0) {
                    console.warn('No Fabric Loader versions found in response');
                    reject(new Error('No Fabric Loader versions found'));
                    return;
                }
                
                // Первая версия в списке обычно самая новая стабильная
                const latestVersion = versions[0];
                console.log('Latest version object:', latestVersion);
                
                // Пробуем разные возможные поля для версии
                // API Fabric возвращает объекты вида: { loader: { version: "0.16.0", ... }, ... }
                let loaderVersion = null;
                
                if (latestVersion.loader && latestVersion.loader.version) {
                    loaderVersion = latestVersion.loader.version;
                } else if (latestVersion.version) {
                    loaderVersion = latestVersion.version;
                } else if (typeof latestVersion === 'string') {
                    // Если версия - это просто строка
                    loaderVersion = latestVersion;
                }
                
                if (!loaderVersion) {
                    console.warn('Could not extract version from response structure:', latestVersion);
                    console.warn('Using fallback version 0.16.0');
                    resolve('0.16.0');
                    return;
                }
                
                console.log('Latest Fabric Loader version:', loaderVersion);
                resolve(loaderVersion);
            })
            .catch(error => {
                console.warn('Failed to fetch Fabric Loader version, using fallback:', error);
                // Fallback на известную рабочую версию
                resolve('0.16.0');
            });
    });
}

// Установка Fabric версии (version — строка вида "1.21.4-fabric" или "1.20.1-fabric")
function installFabricVersion(minecraftPath, version) {
    const mcVersion = version.replace(/-fabric$/, '') || '1.21.4';
    return new Promise((resolve, reject) => {
        updateProgress(20, 'Установка Fabric Loader...');
        
        installVanillaVersion(minecraftPath, mcVersion).then(() => {
            updateProgress(38, 'Получение последней версии Fabric Loader...');
            
            getLatestFabricLoaderVersion(mcVersion).then((fabricLoaderVersion) => {
                updateProgress(40, 'Загрузка Fabric Installer...');
                
                const fabricInstallerUrl = `https://maven.fabricmc.net/net/fabricmc/fabric-installer/1.0.0/fabric-installer-1.0.0.jar`;
                const tempInstallerPath = path.join(minecraftPath, 'fabric-installer.jar');
                
                downloadFile(fabricInstallerUrl, tempInstallerPath).then(() => {
                    updateProgress(45, 'Установка Fabric...');
                    
                    const launcherProfilesPath = path.join(minecraftPath, 'launcher_profiles.json');
                    if (!fs.existsSync(launcherProfilesPath)) {
                        const launcherProfiles = {
                            "profiles": {},
                            "selectedProfile": null,
                            "clientToken": "",
                            "authenticationDatabase": {},
                            "selectedUser": null,
                            "launcherVersion": { "name": "fixlauncher", "format": 21 }
                        };
                        fs.writeFileSync(launcherProfilesPath, JSON.stringify(launcherProfiles, null, 2));
                    }
                    
                    const javaPath = localStorage.getItem('java-path') || 'java';
                    if (javaPath !== 'java' && !fs.existsSync(javaPath)) {
                        reject(new Error('Java не найдена. Проверьте путь в настройках.'));
                        return;
                    }
                    
                    const installerArgs = [
                        '-jar', tempInstallerPath,
                        'client',
                        '-mcversion', mcVersion,
                        '-loader', fabricLoaderVersion,
                        '-dir', minecraftPath
                    ];
                
                console.log('Running Fabric installer:', javaPath, installerArgs.join(' '));
                
                const installerProcess = spawn(javaPath, installerArgs, {
                    cwd: minecraftPath,
                    stdio: ['ignore', 'pipe', 'pipe'],
                    env: {
                        ...process.env
                    }
                });
                
                let stdout = '';
                let stderr = '';
                
                installerProcess.stdout.on('data', (data) => {
                    const text = data.toString();
                    stdout += text;
                    console.log('Fabric installer stdout:', text);
                });
                
                installerProcess.stderr.on('data', (data) => {
                    const text = data.toString();
                    stderr += text;
                    console.error('Fabric installer stderr:', text);
                });
                
                installerProcess.on('error', (error) => {
                    console.error('Fabric installer spawn error:', error);
                    // Удаляем временный установщик
                    try {
                        if (fs.existsSync(tempInstallerPath)) {
                            fs.unlinkSync(tempInstallerPath);
                        }
                    } catch (e) {}
                    reject(new Error(`Не удалось запустить Fabric installer: ${error.message}`));
                });
                
                installerProcess.on('close', (code) => {
                    console.log('Fabric installer exited with code:', code);
                    console.log('Fabric installer stdout:', stdout);
                    console.log('Fabric installer stderr:', stderr);
                    
                    // Удаляем временный установщик
                    try {
                        if (fs.existsSync(tempInstallerPath)) {
                            fs.unlinkSync(tempInstallerPath);
                        }
                    } catch (e) {
                        console.warn('Failed to delete installer:', e);
                    }
                    
                    if (code === 0) {
                        const fabricVersionPath = path.join(minecraftPath, 'versions', version);
                        if (fs.existsSync(fabricVersionPath)) {
                            updateProgress(50, 'Fabric установлен!');
                            resolve();
                        } else {
                            console.log('Fabric version folder not found, creating manually...');
                            localStorage.setItem('fabric-loader-version', fabricLoaderVersion);
                            createFabricVersionManually(minecraftPath, fabricLoaderVersion, mcVersion, version).then(resolve).catch(reject);
                        }
                    } else {
                        const fabricVersionPath = path.join(minecraftPath, 'versions', version);
                        if (fs.existsSync(fabricVersionPath)) {
                            updateProgress(50, 'Fabric установлен!');
                            resolve();
                        } else {
                            reject(new Error(`Fabric installer завершился с кодом ${code}.\nВывод: ${stdout}\nОшибки: ${stderr}`));
                        }
                    }
                });
                }).catch((error) => {
                    console.error('Error downloading Fabric installer:', error);
                    reject(error);
                });
            }).catch((error) => {
                console.error('Error getting Fabric Loader version:', error);
                reject(error);
            });
        }).catch(reject);
    });
}

// Создание Fabric версии вручную на основе базовой версии (mcVersion — например "1.21.4", versionId — "1.21.4-fabric")
function createFabricVersionManually(minecraftPath, fabricLoaderVersion = '0.16.0', mcVersion = '1.21.4', versionId = '1.21.4-fabric') {
    return new Promise((resolve, reject) => {
        try {
            const baseVersionPath = path.join(minecraftPath, 'versions', mcVersion);
            const fabricVersionPath = path.join(minecraftPath, 'versions', versionId);
            
            if (!fs.existsSync(baseVersionPath)) {
                reject(new Error(`Базовая версия ${mcVersion} не найдена`));
                return;
            }
            
            if (!fs.existsSync(fabricVersionPath)) {
                fs.mkdirSync(fabricVersionPath, { recursive: true });
            }
            
            const baseJsonPath = path.join(baseVersionPath, mcVersion + '.json');
            const fabricJsonPath = path.join(fabricVersionPath, versionId + '.json');
            
            if (fs.existsSync(baseJsonPath)) {
                const baseJson = JSON.parse(fs.readFileSync(baseJsonPath, 'utf8'));
                baseJson.id = versionId;
                baseJson.mainClass = 'net.fabricmc.loader.impl.launch.knot.KnotClient';
                
                // Добавляем Fabric Loader в библиотеки
                if (!baseJson.libraries) {
                    baseJson.libraries = [];
                }
                
                // Добавляем Fabric Loader библиотеки с указанной версией
                baseJson.libraries.push({
                    name: `net.fabricmc:fabric-loader:${fabricLoaderVersion}`,
                    downloads: {
                        artifact: {
                            path: `net/fabricmc/fabric-loader/${fabricLoaderVersion}/fabric-loader-${fabricLoaderVersion}.jar`,
                            url: `https://maven.fabricmc.net/net/fabricmc/fabric-loader/${fabricLoaderVersion}/fabric-loader-${fabricLoaderVersion}.jar`,
                            sha1: '',
                            size: 0
                        }
                    }
                });
                
                fs.writeFileSync(fabricJsonPath, JSON.stringify(baseJson, null, 2));
                
                const baseJarPath = path.join(baseVersionPath, mcVersion + '.jar');
                const fabricJarPath = path.join(fabricVersionPath, versionId + '.jar');
                if (fs.existsSync(baseJarPath)) {
                    fs.copyFileSync(baseJarPath, fabricJarPath);
                }
                
                // Загружаем Fabric Loader с указанной версией
                updateProgress(48, 'Загрузка Fabric Loader...');
                const fabricLoaderUrl = `https://maven.fabricmc.net/net/fabricmc/fabric-loader/${fabricLoaderVersion}/fabric-loader-${fabricLoaderVersion}.jar`;
                const libsPath = path.join(minecraftPath, 'libraries', 'net', 'fabricmc', 'fabric-loader', fabricLoaderVersion);
                if (!fs.existsSync(libsPath)) {
                    fs.mkdirSync(libsPath, { recursive: true });
                }
                const fabricLoaderPath = path.join(libsPath, `fabric-loader-${fabricLoaderVersion}.jar`);
                
                return downloadFile(fabricLoaderUrl, fabricLoaderPath).then(() => {
                    updateProgress(50, 'Fabric версия создана!');
                    resolve();
                }).catch(reject);
            } else {
                reject(new Error('Не найден файл версии 1.21.4.json'));
            }
        } catch (error) {
            reject(error);
        }
    });
}

// Загрузка библиотек
function downloadLibraries(minecraftPath, version) {
    return new Promise((resolve, reject) => {
        const versionJsonPath = path.join(minecraftPath, 'versions', version, version + '.json');
        if (!fs.existsSync(versionJsonPath)) {
            resolve(); // Библиотеки уже загружены или версия не установлена
            return;
        }
        
        const versionData = JSON.parse(fs.readFileSync(versionJsonPath, 'utf8'));
        const libraries = versionData.libraries || [];
        const librariesPath = path.join(minecraftPath, 'libraries');
        
        if (!fs.existsSync(librariesPath)) {
            fs.mkdirSync(librariesPath, { recursive: true });
        }
        
        let downloaded = 0;
        const total = libraries.length;
        
        if (total === 0) {
            resolve();
            return;
        }
        
        const downloadNext = (index) => {
            if (index >= total) {
                resolve();
                return;
            }
            
            const lib = libraries[index];
            const libPath = lib.downloads?.artifact?.path || lib.name.replace(/:/g, '/').replace(/\./g, '/');
            const libUrl = lib.downloads?.artifact?.url;
            
            const promises = [];
            
            // Загружаем основную библиотеку
            if (libUrl) {
                const destPath = path.join(librariesPath, libPath);
                const destDir = path.dirname(destPath);
                
                if (!fs.existsSync(destDir)) {
                    fs.mkdirSync(destDir, { recursive: true });
                }
                
                if (fs.existsSync(destPath)) {
                    // Файл уже есть
                } else {
                    promises.push(
                        downloadFile(libUrl, destPath).catch((error) => {
                            console.warn('Failed to download library:', libPath, error);
                        })
                    );
                }
            }
            
            // Загружаем нативные библиотеки если есть
            if (lib.downloads && lib.downloads.classifiers) {
                const osName = os.platform();
                const arch = os.arch();
                let nativeClassifier = '';
                
                if (osName === 'win32') {
                    nativeClassifier = arch === 'x64' ? 'natives-windows' : 'natives-windows-x86';
                } else if (osName === 'darwin') {
                    nativeClassifier = arch === 'arm64' ? 'natives-macos-arm64' : 'natives-macos';
                } else {
                    nativeClassifier = 'natives-linux';
                }
                
                const nativeInfo = lib.downloads.classifiers[nativeClassifier];
                if (nativeInfo && nativeInfo.url && nativeInfo.path) {
                    const nativePath = path.join(librariesPath, nativeInfo.path);
                    const nativeDir = path.dirname(nativePath);
                    
                    if (!fs.existsSync(nativeDir)) {
                        fs.mkdirSync(nativeDir, { recursive: true });
                    }
                    
                    if (!fs.existsSync(nativePath)) {
                        promises.push(
                            downloadFile(nativeInfo.url, nativePath).catch((error) => {
                                console.warn('Failed to download native library:', nativeInfo.path, error);
                            })
                        );
                    }
                }
            }
            
            // Ждём загрузки всех файлов для этой библиотеки
            Promise.all(promises).then(() => {
                downloaded++;
                updateProgress(50 + (downloaded / total) * 20, `Библиотеки: ${downloaded}/${total}`);
                downloadNext(index + 1);
            });
        };
        
        downloadNext(0);
    });
}

// Загрузка ресурсов (assets) - включая языковые файлы
function downloadAssets(minecraftPath, versionData) {
    return new Promise((resolve, reject) => {
        if (!versionData || !versionData.assetIndex) {
            console.warn('No assetIndex in version data, skipping assets download');
            resolve();
            return;
        }
        
        const assetIndex = versionData.assetIndex.id || versionData.assetIndex;
        let assetIndexUrl = versionData.assetIndex.url;
        
        // Если URL нет, формируем его на основе ID
        if (!assetIndexUrl) {
            // Пробуем стандартный формат Mojang
            if (versionData.assetIndex.sha1) {
                assetIndexUrl = `https://piston-meta.mojang.com/v1/packages/${versionData.assetIndex.sha1}/${assetIndex}.json`;
            } else {
                // Альтернативный формат URL (используем ID как fallback)
                assetIndexUrl = `https://piston-meta.mojang.com/v1/packages/${assetIndex}/${assetIndex}.json`;
            }
        }
        
        const assetsPath = path.join(minecraftPath, 'assets');
        const indexesPath = path.join(assetsPath, 'indexes');
        const objectsPath = path.join(assetsPath, 'objects');
        
        // Создаём папки если нужно
        if (!fs.existsSync(indexesPath)) {
            fs.mkdirSync(indexesPath, { recursive: true });
        }
        if (!fs.existsSync(objectsPath)) {
            fs.mkdirSync(objectsPath, { recursive: true });
        }
        
        const assetIndexPath = path.join(indexesPath, assetIndex + '.json');
        
        // Проверяем, не загружен ли уже индекс
        if (fs.existsSync(assetIndexPath)) {
            console.log('Asset index already exists, loading from file:', assetIndexPath);
            try {
                const assetIndexData = JSON.parse(fs.readFileSync(assetIndexPath, 'utf8'));
                const objects = assetIndexData.objects || {};
                const objectKeys = Object.keys(objects);
                const totalObjects = objectKeys.length;
                let downloaded = 0;
                
                // Проверяем, сколько объектов уже загружено
                objectKeys.forEach(key => {
                    const objectInfo = objects[key];
                    const hash = objectInfo.hash;
                    const hashPrefix = hash.substring(0, 2);
                    const objectPath = path.join(objectsPath, hashPrefix, hash);
                    if (fs.existsSync(objectPath)) {
                        downloaded++;
                    }
                });
                
                if (downloaded === totalObjects) {
                    console.log('All assets already downloaded');
                    resolve();
                    return;
                }
                
                // Загружаем недостающие объекты
                updateProgress(62, `Загрузка ресурсов: ${downloaded}/${totalObjects}...`);
                downloadAssetObjects(objects, objectsPath, totalObjects, downloaded, resolve);
            } catch (e) {
                console.warn('Error reading existing asset index, re-downloading:', e);
                // Продолжаем загрузку индекса
            }
        }
        
        // Загружаем индекс ресурсов
        updateProgress(60, 'Загрузка индекса ресурсов...');
        fetchJSON(assetIndexUrl)
            .then(assetIndexData => {
                // Сохраняем индекс
                fs.writeFileSync(assetIndexPath, JSON.stringify(assetIndexData, null, 2));
                console.log('Asset index downloaded:', assetIndex);
                
                // Загружаем все объекты ресурсов
                const objects = assetIndexData.objects || {};
                const objectKeys = Object.keys(objects);
                const totalObjects = objectKeys.length;
                
                if (totalObjects === 0) {
                    console.warn('No objects in asset index');
                    resolve();
                    return;
                }
                
                updateProgress(62, `Загрузка ресурсов: 0/${totalObjects}...`);
                downloadAssetObjects(objects, objectsPath, totalObjects, 0, resolve);
            })
            .catch((error) => {
                console.warn('Failed to download asset index:', error);
                // Продолжаем даже при ошибке
                resolve();
            });
    });
}

// Вспомогательная функция для загрузки объектов ресурсов
function downloadAssetObjects(objects, objectsPath, totalObjects, startDownloaded, onComplete) {
    const objectKeys = Object.keys(objects);
    let downloaded = startDownloaded;
    
    // Загружаем объекты по очереди (чтобы не перегружать)
    const downloadNext = (index) => {
        if (index >= objectKeys.length) {
            updateProgress(69, 'Ресурсы загружены!');
            onComplete();
            return;
        }
        
        const objectKey = objectKeys[index];
        const objectInfo = objects[objectKey];
        const hash = objectInfo.hash;
        const hashPrefix = hash.substring(0, 2);
        const objectPath = path.join(objectsPath, hashPrefix, hash);
        const objectDir = path.dirname(objectPath);
        
        // Создаём папку если нужно
        if (!fs.existsSync(objectDir)) {
            fs.mkdirSync(objectDir, { recursive: true });
        }
        
        // Загружаем только если файла нет
        if (fs.existsSync(objectPath)) {
            downloaded++;
            if (downloaded % 100 === 0 || index === objectKeys.length - 1) {
                const percent = 62 + Math.floor((downloaded / totalObjects) * 7);
                updateProgress(percent, `Загрузка ресурсов: ${downloaded}/${totalObjects}...`);
            }
            downloadNext(index + 1);
        } else {
            const objectUrl = `https://resources.download.minecraft.net/${hashPrefix}/${hash}`;
            
            downloadFile(objectUrl, objectPath)
                .then(() => {
                    downloaded++;
                    if (downloaded % 100 === 0 || index === objectKeys.length - 1) {
                        const percent = 62 + Math.floor((downloaded / totalObjects) * 7);
                        updateProgress(percent, `Загрузка ресурсов: ${downloaded}/${totalObjects}...`);
                    }
                    // Небольшая задержка между загрузками
                    setTimeout(() => downloadNext(index + 1), 10);
                })
                .catch((error) => {
                    console.warn(`Failed to download asset ${objectKey}:`, error);
                    // Продолжаем даже при ошибке
                    downloadNext(index + 1);
                });
        }
    };
    
    downloadNext(0);
}

// Извлечение нативных библиотек
function extractNatives(minecraftPath, version) {
    return new Promise((resolve, reject) => {
        const versionJsonPath = path.join(minecraftPath, 'versions', version, version + '.json');
        if (!fs.existsSync(versionJsonPath)) {
            resolve(); // Пропускаем если нет version.json
            return;
        }
        
        try {
            const versionData = JSON.parse(fs.readFileSync(versionJsonPath, 'utf8'));
            const libraries = versionData.libraries || [];
            const librariesPath = path.join(minecraftPath, 'libraries');
            const nativesPath = path.join(minecraftPath, 'natives');
            
            console.log(`Total libraries in version.json: ${libraries.length}`);
            const lwjglLibraries = libraries.filter(lib => (lib.name || '').toLowerCase().includes('lwjgl'));
            console.log(`LWJGL libraries found: ${lwjglLibraries.length}`);
            if (lwjglLibraries.length > 0) {
                console.log('Sample LWJGL library structure:', JSON.stringify(lwjglLibraries[0], null, 2));
            }
            
            // Удаляем папку natives полностью и создаём заново, чтобы избежать конфликтов
            if (fs.existsSync(nativesPath)) {
                try {
                    // Удаляем все файлы в папке
                    const files = fs.readdirSync(nativesPath);
                    files.forEach(file => {
                        const filePath = path.join(nativesPath, file);
                        try {
                            const stat = fs.statSync(filePath);
                            if (stat.isDirectory()) {
                                fs.rmSync(filePath, { recursive: true, force: true });
                            } else {
                                fs.unlinkSync(filePath);
                            }
                        } catch (e) {
                            console.warn(`Could not delete ${file}:`, e);
                        }
                    });
                    console.log('Cleared natives folder before extraction');
                } catch (e) {
                    console.warn('Could not clear natives folder:', e);
                    // Пробуем удалить папку полностью
                    try {
                        fs.rmSync(nativesPath, { recursive: true, force: true });
                        console.log('Removed natives folder completely');
                    } catch (e2) {
                        console.warn('Could not remove natives folder:', e2);
                    }
                }
            }
            
            // Создаём папку заново
            if (!fs.existsSync(nativesPath)) {
                fs.mkdirSync(nativesPath, { recursive: true });
            }
            
            const osName = os.platform();
            const arch = os.arch();
            
            // Определяем ключ для нативных библиотек
            let nativeClassifier = '';
            if (osName === 'win32') {
                nativeClassifier = arch === 'x64' ? 'natives-windows' : 'natives-windows-x86';
            } else if (osName === 'darwin') {
                nativeClassifier = arch === 'arm64' ? 'natives-macos-arm64' : 'natives-macos';
            } else {
                nativeClassifier = 'natives-linux';
            }
            
            let extracted = 0;
            const nativeLibs = [];
            
            // Собираем все библиотеки с нативными файлами
            libraries.forEach(lib => {
                if (lib.downloads && lib.downloads.classifiers) {
                    // Пробуем разные варианты classifier
                    const classifiers = lib.downloads.classifiers;
                    const possibleClassifiers = [
                        nativeClassifier,
                        'natives-windows',
                        'natives-windows-x86',
                        'natives-windows-64',
                        'natives-windows-x86_64'
                    ];
                    
                    for (const classifier of possibleClassifiers) {
                        const nativeInfo = classifiers[classifier];
                        if (nativeInfo && nativeInfo.path) {
                            nativeLibs.push({
                                path: nativeInfo.path,
                                url: nativeInfo.url,
                                sha1: nativeInfo.sha1,
                                classifier: classifier
                            });
                            break; // Нашли, переходим к следующей библиотеке
                        }
                    }
                }
            });
            
            // Если не нашли через classifiers, пробуем найти LWJGL библиотеки напрямую
            if (nativeLibs.length === 0) {
                console.log('No native libraries found via classifiers, searching for LWJGL libraries...');
                
                // Ищем библиотеки LWJGL
                libraries.forEach(lib => {
                    const libName = lib.name || '';
                    if (libName.includes('lwjgl') && lib.downloads && lib.downloads.artifact) {
                        // Проверяем, есть ли classifier для этой библиотеки
                        if (lib.downloads.classifiers) {
                            // Пробуем все доступные classifiers
                            Object.keys(lib.downloads.classifiers).forEach(classifier => {
                                if (classifier.includes('windows') || classifier.includes('native')) {
                                    const nativeInfo = lib.downloads.classifiers[classifier];
                                    if (nativeInfo && nativeInfo.path) {
                                        nativeLibs.push({
                                            path: nativeInfo.path,
                                            url: nativeInfo.url,
                                            sha1: nativeInfo.sha1,
                                            classifier: classifier
                                        });
                                        console.log(`Found native library via classifier: ${classifier} - ${libName}`);
                                    }
                                }
                            });
                        }
                    }
                });
            }
            
            if (nativeLibs.length === 0) {
                console.log('No native libraries found via classifiers, trying alternative approach...');
                
                // Альтернативный подход: ищем библиотеки LWJGL с нативными файлами для нужной платформы
                const lwjglLibs = [];
                // Определяем правильный classifier для текущей платформы
                // Важно: проверяем архитектуру правильно для Windows x64
                let targetClassifier = '';
                if (osName === 'win32') {
                    // Проверяем архитектуру - x64, x86_64, amd64 все означают 64-битную
                    if (arch === 'x64' || arch === 'x86_64' || arch === 'amd64') {
                        targetClassifier = 'natives-windows'; // 64-bit Windows
                    } else {
                        targetClassifier = 'natives-windows-x86'; // 32-bit Windows
                    }
                } else if (osName === 'darwin') {
                    if (arch === 'arm64') {
                        targetClassifier = 'natives-macos-arm64';
                    } else {
                        targetClassifier = 'natives-macos';
                    }
                } else {
                    targetClassifier = 'natives-linux';
                }
                
                console.log(`Platform: ${osName}, Arch: ${arch}, Looking for LWJGL libraries with classifier: ${targetClassifier}`);
                
                libraries.forEach(lib => {
                    const libName = lib.name || '';
                    
                    if (libName.toLowerCase().includes('lwjgl')) {
                        // В новых версиях Minecraft библиотеки с нативными файлами могут быть указаны как отдельные библиотеки
                        // с именем вида "org.lwjgl:lwjgl:3.3.3:natives-windows"
                        if (libName.includes(':')) {
                            const parts = libName.split(':');
                            if (parts.length >= 4 && parts[3] && parts[3].includes('natives')) {
                                // Это библиотека с нативными файлами
                                const classifier = parts[3];
                                console.log(`Found LWJGL library with classifier in name: ${libName}, classifier: ${classifier}`);
                                
                                if (classifier === targetClassifier) {
                                    if (lib.downloads && lib.downloads.artifact) {
                                        lwjglLibs.push({
                                            name: libName,
                                            path: lib.downloads.artifact.path,
                                            url: lib.downloads.artifact.url,
                                            classifier: classifier
                                        });
                                        console.log(`Added LWJGL native library (separate entry): ${libName} - ${lib.downloads.artifact.path}`);
                                    }
                                } else {
                                    console.log(`  Classifier mismatch: ${classifier} != ${targetClassifier}`);
                                }
                            }
                        }
                        
                        // Также проверяем через classifiers (старый формат)
                        if (lib.downloads && lib.downloads.classifiers) {
                            const availableClassifiers = Object.keys(lib.downloads.classifiers);
                            console.log(`Library ${libName} has classifiers:`, availableClassifiers);
                            
                            if (lib.downloads.classifiers[targetClassifier]) {
                                const nativeInfo = lib.downloads.classifiers[targetClassifier];
                                if (nativeInfo && nativeInfo.path && nativeInfo.url) {
                                    lwjglLibs.push({
                                        name: libName,
                                        path: nativeInfo.path,
                                        url: nativeInfo.url,
                                        classifier: targetClassifier
                                    });
                                    console.log(`Added LWJGL native library (via classifier): ${libName} (${targetClassifier}) - ${nativeInfo.path}`);
                                }
                            }
                        }
                    }
                });
                
                if (lwjglLibs.length > 0) {
                    console.log(`Found ${lwjglLibs.length} LWJGL libraries, will extract natives from them`);
                    
                    // Извлекаем нативные библиотеки из всех LWJGL JAR файлов
                    let extractedCount = 0;
                    const extractFromLwjglLibs = (index) => {
                        if (index >= lwjglLibs.length) {
                            // Проверяем результат
                            const lwjglDll = path.join(nativesPath, 'lwjgl.dll');
                            if (fs.existsSync(lwjglDll)) {
                                console.log('Successfully extracted native libraries from LWJGL JARs');
                                
                                // Проверяем, что извлечены только правильные файлы для Windows x64
                                try {
                                    const files = fs.readdirSync(nativesPath);
                                    const dllFiles = files.filter(f => f.endsWith('.dll'));
                                    console.log(`Extracted DLL files (${dllFiles.length}):`, dllFiles.join(', '));
                                    
                                    // Удаляем файлы из других платформ, если они есть
                                    const wrongFiles = files.filter(f => 
                                        f.endsWith('.so') || 
                                        f.endsWith('.dylib')
                                    );
                                    if (wrongFiles.length > 0) {
                                        console.warn('Found files from wrong platform, removing:', wrongFiles);
                                        wrongFiles.forEach(file => {
                                            try {
                                                fs.unlinkSync(path.join(nativesPath, file));
                                            } catch (e) {
                                                console.warn(`Could not remove ${file}:`, e);
                                            }
                                        });
                                    }
                                    
                                    // Проверяем размер lwjgl.dll
                                    // 32-bit lwjgl.dll для LWJGL 3.3.3 обычно ~300-350KB
                                    // 64-bit lwjgl.dll для LWJGL 3.3.3 обычно ~400-500KB
                                    try {
                                        const stats = fs.statSync(lwjglDll);
                                        console.log(`lwjgl.dll size: ${stats.size} bytes (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
                                        // Используем порог 350KB для различения 32-bit и 64-bit
                                        if (stats.size < 350000) { // Меньше ~350KB - вероятно 32-битная версия
                                            console.error('ERROR: lwjgl.dll seems too small, might be 32-bit version!');
                                            console.error('This will cause "Can\'t load IA 32-bit .dll on a AMD 64-bit platform" error');
                                            // Удаляем неправильный файл
                                            try {
                                                fs.unlinkSync(lwjglDll);
                                                console.error('Removed incorrect 32-bit lwjgl.dll');
                                            } catch (e) {
                                                console.error('Could not remove incorrect lwjgl.dll:', e);
                                            }
                                        } else {
                                            console.log('lwjgl.dll size looks correct for 64-bit version');
                                        }
                                    } catch (e) {
                                        console.warn('Could not check lwjgl.dll size:', e);
                                    }
                                } catch (e) {
                                    console.warn('Could not verify extracted files:', e);
                                }
                                
                                resolve();
                            } else {
                                console.warn('Native libraries still not found after extracting from LWJGL JARs');
                                resolve(); // Продолжаем даже если не нашли
                            }
                            return;
                        }
                        
                        const lwjglLib = lwjglLibs[index];
                        const jarPath = path.join(librariesPath, lwjglLib.path);
                        
                        // Проверяем, что путь JAR содержит правильный classifier
                        if (!jarPath.includes(targetClassifier.replace('natives-', ''))) {
                            console.warn(`Skipping ${lwjglLib.name} - path doesn't match target classifier: ${jarPath}`);
                            extractFromLwjglLibs(index + 1);
                            return;
                        }
                        
                        if (fs.existsSync(jarPath)) {
                            console.log(`Extracting natives from ${lwjglLib.name} (${targetClassifier})...`);
                            extractFromJar(jarPath, nativesPath, index, lwjglLibs.length).then(() => {
                                extractedCount++;
                                extractFromLwjglLibs(index + 1);
                            }).catch((error) => {
                                console.warn(`Failed to extract from ${lwjglLib.name}:`, error);
                                extractFromLwjglLibs(index + 1);
                            });
                        } else {
                            console.warn(`LWJGL JAR not found: ${jarPath}`);
                            extractFromLwjglLibs(index + 1);
                        }
                    };
                    
                    extractFromLwjglLibs(0);
                    return; // Выходим, так как используем альтернативный подход
                }
                
                console.error('No LWJGL libraries found and no classifiers available');
                resolve();
                return;
            }
            
            console.log(`Found ${nativeLibs.length} native libraries to extract for ${nativeClassifier}`);
            nativeLibs.forEach((lib, idx) => {
                console.log(`  ${idx + 1}. ${lib.path}`);
            });
            
            // Загружаем и извлекаем нативные библиотеки
            const extractNext = (index) => {
                if (index >= nativeLibs.length) {
                    // Проверяем, что файлы действительно извлечены
                    const lwjglDll = path.join(nativesPath, 'lwjgl.dll');
                    if (fs.existsSync(lwjglDll)) {
                        console.log('Native libraries successfully extracted to:', nativesPath);
                        try {
                            const files = fs.readdirSync(nativesPath);
                            console.log(`Extracted files (${files.length}):`, files.slice(0, 10).join(', '), files.length > 10 ? '...' : '');
                        } catch (e) {
                            console.warn('Could not list files in natives folder:', e);
                        }
                    } else {
                        console.warn('lwjgl.dll not found after extraction in:', nativesPath);
                        try {
                            const files = fs.readdirSync(nativesPath);
                            console.warn('Files in natives folder:', files);
                        } catch (e) {
                            console.warn('Could not list files in natives folder:', e);
                        }
                    }
                    resolve();
                    return;
                }
                
                const nativeLib = nativeLibs[index];
                const nativeJarPath = path.join(librariesPath, nativeLib.path);
                const destDir = path.dirname(nativeJarPath);
                
                // Скачиваем если нет
                if (!fs.existsSync(nativeJarPath)) {
                    if (!fs.existsSync(destDir)) {
                        fs.mkdirSync(destDir, { recursive: true });
                    }
                    
                    updateProgress(70 + (index / nativeLibs.length) * 10, `Загрузка нативных библиотек: ${index + 1}/${nativeLibs.length}`);
                    
                    downloadFile(nativeLib.url, nativeJarPath).then(() => {
                        extractFromJar(nativeJarPath, nativesPath, index, nativeLibs.length).then(() => {
                            extracted++;
                            extractNext(index + 1);
                        }).catch((error) => {
                            console.warn('Failed to extract natives from', nativeLib.path, error);
                            extractNext(index + 1); // Продолжаем даже при ошибке
                        });
                    }).catch((error) => {
                        console.warn('Failed to download native library:', nativeLib.path, error);
                        extractNext(index + 1); // Продолжаем даже при ошибке
                    });
                } else {
                    // Файл уже есть, просто извлекаем
                    extractFromJar(nativeJarPath, nativesPath, index, nativeLibs.length).then(() => {
                        extracted++;
                        extractNext(index + 1);
                    }).catch((error) => {
                        console.warn('Failed to extract natives from', nativeLib.path, error);
                        extractNext(index + 1); // Продолжаем даже при ошибке
                    });
                }
            };
            
            extractNext(0);
        } catch (error) {
            console.warn('Error extracting natives:', error);
            resolve(); // Продолжаем даже при ошибке
        }
    });
}

// Извлечение файлов из JAR архива
function extractFromJar(jarPath, destPath, index, total) {
    return new Promise((resolve, reject) => {
        try {
            if (!fs.existsSync(jarPath)) {
                reject(new Error(`JAR file not found: ${jarPath}`));
                return;
            }
            
            const AdmZip = require('adm-zip');
            const zip = new AdmZip(jarPath);
            const zipEntries = zip.getEntries();
            
            let extractedFiles = 0;
            
            console.log(`Extracting natives from ${path.basename(jarPath)} (${zipEntries.length} entries)`);
            
            zipEntries.forEach((entry) => {
                // Извлекаем только нативные библиотеки (dll, so, dylib)
                if (entry.entryName.match(/\.(dll|so|dylib)$/i)) {
                    const fileName = path.basename(entry.entryName);
                    const destFile = path.join(destPath, fileName);
                    
                    try {
                        // Извлекаем файл напрямую в папку назначения
                        const fileData = zip.readFile(entry);
                        if (fileData) {
                            fs.writeFileSync(destFile, fileData);
                            extractedFiles++;
                            console.log(`  Extracted: ${fileName}`);
                        }
                    } catch (extractError) {
                        console.warn(`  Failed to extract ${fileName}:`, extractError);
                    }
                }
            });
            
            if (extractedFiles > 0) {
                updateProgress(70 + ((index + 1) / total) * 10, `Нативные библиотеки: ${index + 1}/${total} (${extractedFiles} файлов)`);
                console.log(`Successfully extracted ${extractedFiles} native files from`, path.basename(jarPath), 'to', destPath);
            } else {
                console.warn(`No native files found in ${path.basename(jarPath)}`);
            }
            
            resolve();
        } catch (error) {
            console.error(`Error extracting from ${jarPath}:`, error);
            reject(error);
        }
    });
}

// Список файлов настроек Minecraft, которые нужно сохранять
const SETTINGS_FILES = [
    'options.txt',           // Основные настройки Minecraft
    'optionsof.txt',         // Настройки OptiFine
    'optionsshaders.txt',    // Настройки шейдеров
    'servers.dat',           // Список серверов
    'servers.dat_old',       // Резервная копия списка серверов
    'usercache.json',        // Кэш пользователей (но он обновляется лаунчером, так что это нормально)
    'banned-ips.json',       // Забаненные IP
    'banned-players.json',   // Забаненные игроки
    'ops.json',              // Операторы сервера
    'whitelist.json'         // Белый список
];

// Проверка, является ли путь файлом конфигурации, который нужно сохранить
function isConfigFile(filePath, basePath) {
    try {
        const relativePath = path.relative(basePath, filePath);
        const normalizedPath = relativePath.replace(/\\/g, '/');
        const fileName = path.basename(filePath).toLowerCase();
        
        // Проверяем, находится ли файл в папке config (может быть на любом уровне вложенности)
        const pathParts = normalizedPath.split('/').filter(p => p !== '');
        if (pathParts.includes('config')) {
            return true;
        }
        
        // Проверяем, является ли файл файлом настроек Minecraft в корневой папке
        if (SETTINGS_FILES.includes(fileName)) {
            // Проверяем, что файл находится в корневой папке Minecraft (не в подпапках)
            // Если путь состоит только из имени файла (без подпапок), значит он в корне
            if (pathParts.length === 1 && pathParts[0].toLowerCase() === fileName) {
                return true;
            }
        }
        
        return false;
    } catch (e) {
        // Если не удалось определить относительный путь, проверяем абсолютный путь
        const normalizedPath = filePath.replace(/\\/g, '/');
        const fileName = path.basename(filePath).toLowerCase();
        
        if (normalizedPath.includes('/config/') || normalizedPath.endsWith('/config')) {
            return true;
        }
        
        // Проверяем, является ли файл файлом настроек и находится ли он в корневой папке
        // (проверяем, что перед именем файла нет подпапок в пути)
        if (SETTINGS_FILES.includes(fileName)) {
            const pathWithoutBase = normalizedPath.replace(/^.*[/\\]/, '');
            if (pathWithoutBase.toLowerCase() === fileName) {
                return true;
            }
        }
        
        return false;
    }
}

// Рекурсивное копирование папки
function copyDirectoryRecursive(src, dest) {
    if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
    }
    
    const entries = fs.readdirSync(src, { withFileTypes: true });
    
    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        
        if (entry.isDirectory()) {
            copyDirectoryRecursive(srcPath, destPath);
        } else {
            // Пропускаем файлы конфигурации, если они уже существуют (чтобы сохранить настройки пользователя)
            if (isConfigFile(destPath, dest) && fs.existsSync(destPath)) {
                console.log(`Preserving existing config file: ${path.relative(dest, destPath)}`);
                continue;
            }
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

// Загрузка сборки с GitHub
function downloadAssemblyFromGitHub(githubRepo, targetPath, versionType) {
    return new Promise((resolve, reject) => {
        console.log(`Downloading assembly from GitHub: ${githubRepo}`);
        updateProgress(27, 'Загрузка сборки с GitHub...');
        
        // Всегда пробуем сначала git clone (более надёжный метод)
        // Проверяем наличие git
        exec('git --version', (error) => {
            if (error) {
                // Если git не установлен, используем альтернативный метод через raw.githubusercontent.com
                console.log('Git not found, using direct file download method');
                downloadAssemblyFromGitHubDirect(githubRepo, targetPath, versionType)
                    .then(resolve)
                    .catch((directError) => {
                        console.error('Direct download failed, trying API method:', directError);
                        // Пробуем API метод как запасной
                        downloadAssemblyFromGitHubAPI(githubRepo, targetPath, versionType)
                            .then(resolve)
                            .catch(reject);
                    });
                return;
            }
            
            // Используем git clone
            const tempDir = path.join(os.tmpdir(), 'fixlauncher-download-' + Date.now());
            
            // НЕ удаляем целевую папку - там уже может быть версия Minecraft
            // Вместо этого клонируем во временную папку и копируем только файлы сборки
            
            // Создаём родительскую папку если её нет
            const parentDir = path.dirname(targetPath);
            if (!fs.existsSync(parentDir)) {
                fs.mkdirSync(parentDir, { recursive: true });
            }
            
            // Создаём целевую папку если её нет
            if (!fs.existsSync(targetPath)) {
                fs.mkdirSync(targetPath, { recursive: true });
            }
            
            // Клонируем репозиторий во временную папку
            updateProgress(28, 'Клонирование репозитория с GitHub...');
            console.log(`Cloning repository to temporary directory: ${tempDir}`);
            exec(`git clone --depth 1 ${githubRepo} "${tempDir}"`, { timeout: 60000 }, (cloneError, stdout, stderr) => {
                if (cloneError) {
                    console.error('Git clone error:', cloneError);
                    console.error('Git clone stderr:', stderr);
                    // Пробуем альтернативный метод - прямой доступ к файлам
                    console.log('Trying direct file download method...');
                    downloadAssemblyFromGitHubDirect(githubRepo, targetPath, versionType)
                        .then(resolve)
                        .catch((directError) => {
                            console.error('Direct download also failed, trying API method:', directError);
                            // Пробуем API метод как последний вариант
                            downloadAssemblyFromGitHubAPI(githubRepo, targetPath, versionType)
                                .then(resolve)
                                .catch(reject);
                        });
                    return;
                }
                
                try {
                    // Копируем содержимое из временной папки в целевую (не удаляя существующие файлы)
                    if (fs.existsSync(tempDir)) {
                        console.log('Copying files from temporary directory to Minecraft folder...');
                        copyDirectoryRecursive(tempDir, targetPath);
                        
                        // Удаляем временную папку
                        try {
                            fs.rmSync(tempDir, { recursive: true, force: true });
                        } catch (e) {
                            console.warn('Could not remove temporary directory:', e);
                        }
                        
                        console.log(`Successfully downloaded assembly to ${targetPath}`);
                        updateProgress(30, 'Сборка загружена с GitHub');
                        resolve();
                    } else {
                        reject(new Error('Downloaded folder not found'));
                    }
                } catch (copyError) {
                    console.error('Error copying downloaded files:', copyError);
                    reject(copyError);
                }
            });
        });
    });
}

// Альтернативный метод загрузки через raw.githubusercontent.com (обходит API ограничения)
function downloadAssemblyFromGitHubDirect(githubRepo, targetPath, versionType) {
    return new Promise((resolve, reject) => {
        console.log('Using direct file download method (raw.githubusercontent.com)');
        updateProgress(28, 'Загрузка файлов напрямую с GitHub...');
        
        // Парсим URL репозитория
        const repoMatch = githubRepo.match(/github\.com\/([^/]+)\/([^/]+)(?:\.git)?$/);
        if (!repoMatch) {
            reject(new Error('Неверный URL репозитория GitHub'));
            return;
        }
        
        const [, owner, repo] = repoMatch;
        
        // Создаём целевую папку
        if (!fs.existsSync(targetPath)) {
            fs.mkdirSync(targetPath, { recursive: true });
        }
        
        // Получаем список файлов через git trees API (если доступен)
        // Если API возвращает 403, пробуем загрузить файлы напрямую по известной структуре
        getGitHubFileList(githubRepo)
            .then((fileList) => {
                if (fileList.length === 0) {
                    // Если список пустой, пробуем загрузить файлы по известной структуре
                    console.log('File list empty or API unavailable, trying to download by structure...');
                    return downloadByStructure(owner, repo, targetPath);
                } else {
                    // Загружаем все файлы из списка
                    return downloadFilesFromList(fileList, owner, repo, targetPath);
                }
            })
            .then(() => {
                console.log(`Successfully downloaded assembly via direct method to ${targetPath}`);
                updateProgress(30, 'Сборка загружена с GitHub');
                resolve();
            })
            .catch((error) => {
                console.error('Direct download failed:', error);
                // Если не удалось получить список, пробуем загрузить по структуре
                if (error.message && error.message.includes('403')) {
                    console.log('API returned 403, trying to download by structure...');
                    downloadByStructure(owner, repo, targetPath)
                        .then(() => {
                            console.log(`Successfully downloaded assembly via structure method to ${targetPath}`);
                            updateProgress(30, 'Сборка загружена с GitHub');
                            resolve();
                        })
                        .catch(reject);
                } else {
                    reject(error);
                }
            });
    });
}

// Загрузка по известной структуре (если API недоступен)
function downloadByStructure(owner, repo, targetPath) {
    return new Promise((resolve, reject) => {
        console.log('Downloading files by known structure...');
        updateProgress(28, 'Загрузка по структуре репозитория...');
        
        // Пробуем загрузить основные файлы и папки
        const filesToTry = [
            'modpack.json',
            'options.txt',
            'README.md'
        ];
        
        const promises = filesToTry.map(file => {
            const filePath = path.join(targetPath, file);
            const dir = path.dirname(filePath);
            
            // Пропускаем файлы настроек, если они уже существуют (чтобы сохранить настройки пользователя)
            if (isConfigFile(filePath, targetPath) && fs.existsSync(filePath)) {
                console.log(`Preserving existing settings file: ${file}`);
                return Promise.resolve(); // Возвращаем успешный промис, чтобы не нарушить Promise.all
            }
            
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            
            const tryBranch = (branch) => {
                const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${file}`;
                return downloadFile(url, filePath).catch(() => {
                    if (branch === 'main') {
                        return tryBranch('master');
                    }
                    return Promise.reject();
                });
            };
            
            return tryBranch('main').catch(() => {
                console.warn(`Could not download ${file}`);
            });
        });
        
        // Пробуем загрузить моды из папки mods
        const modsPath = path.join(targetPath, 'mods');
        if (!fs.existsSync(modsPath)) {
            fs.mkdirSync(modsPath, { recursive: true });
        }
        
        // Пробуем получить список файлов из папки mods через API
        const modsApiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/mods`;
        fetchJSON(modsApiUrl)
            .then((modsContents) => {
                const modPromises = modsContents
                    .filter(item => item.type === 'file' && item.name.endsWith('.jar'))
                    .map(mod => {
                        const modPath = path.join(modsPath, mod.name);
                        const url = mod.download_url || `https://raw.githubusercontent.com/${owner}/${repo}/main/mods/${mod.name}`;
                        return downloadFile(url, modPath)
                            .then(() => console.log(`Downloaded mod: ${mod.name}`))
                            .catch(() => {
                                // Пробуем через raw
                                const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/main/mods/${mod.name}`;
                                return downloadFile(rawUrl, modPath)
                                    .catch(() => {
                                        const masterUrl = `https://raw.githubusercontent.com/${owner}/${repo}/master/mods/${mod.name}`;
                                        return downloadFile(masterUrl, modPath);
                                    });
                            })
                            .catch(() => console.warn(`Could not download mod: ${mod.name}`));
                    });
                
                return Promise.all([...promises, ...modPromises]);
            })
            .catch((apiError) => {
                // Если API недоступен, просто загружаем основные файлы
                console.warn('Could not get mods list from API, downloading basic files only:', apiError.message);
                return Promise.all(promises);
            })
            .then(() => {
                console.log('Files downloaded by structure');
                resolve();
            })
            .catch(reject);
    });
}

// Загрузка файлов из списка через raw.githubusercontent.com
function downloadFilesFromList(fileList, owner, repo, targetPath) {
    return new Promise((resolve, reject) => {
        const promises = [];
        let downloaded = 0;
        const total = fileList.length;
        
        if (total === 0) {
            resolve();
            return;
        }
        
        console.log(`Downloading ${total} files via raw.githubusercontent.com...`);
        
        for (const file of fileList) {
            const filePath = path.join(targetPath, file.path);
            const dir = path.dirname(filePath);
            
            // Пропускаем файлы конфигурации, если они уже существуют (чтобы сохранить настройки пользователя)
            if (isConfigFile(filePath, targetPath) && fs.existsSync(filePath)) {
                console.log(`Preserving existing config file: ${file.path}`);
                downloaded++;
                continue;
            }
            
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            
            const url = `https://raw.githubusercontent.com/${owner}/${repo}/main/${file.path}`;
            const promise = downloadFile(url, filePath)
                .then(() => {
                    downloaded++;
                    const progress = 28 + Math.floor((downloaded / total) * 2);
                    updateProgress(progress, `Загружено ${downloaded}/${total} файлов...`);
                    console.log(`Downloaded: ${file.path}`);
                })
                .catch(() => {
                    // Пробуем master ветку
                    const masterUrl = `https://raw.githubusercontent.com/${owner}/${repo}/master/${file.path}`;
                    return downloadFile(masterUrl, filePath)
                        .then(() => {
                            downloaded++;
                            const progress = 28 + Math.floor((downloaded / total) * 2);
                            updateProgress(progress, `Загружено ${downloaded}/${total} файлов...`);
                            console.log(`Downloaded (from master): ${file.path}`);
                        })
                        .catch((err) => {
                            console.error(`Failed to download ${file.path}:`, err.message);
                            // Продолжаем загрузку других файлов
                        });
                });
            
            promises.push(promise);
        }
        
        Promise.all(promises)
            .then(() => {
                console.log(`Downloaded ${downloaded}/${total} files successfully`);
                resolve();
            })
            .catch((error) => {
                // Даже если некоторые файлы не загрузились, продолжаем
                console.warn('Some files failed to download, but continuing...', error);
                resolve();
            });
    });
}

// Альтернативный метод загрузки через GitHub API (если git не установлен)
function downloadAssemblyFromGitHubAPI(githubRepo, targetPath, versionType) {
    return new Promise((resolve, reject) => {
        console.log('Using GitHub API method (may have rate limits)');
        // Парсим URL репозитория
        const repoMatch = githubRepo.match(/github\.com\/([^/]+)\/([^/]+)(?:\.git)?$/);
        if (!repoMatch) {
            reject(new Error('Неверный URL репозитория GitHub'));
            return;
        }
        
        const [, owner, repo] = repoMatch;
        const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents`;
        
        // Создаём целевую папку
        if (!fs.existsSync(targetPath)) {
            fs.mkdirSync(targetPath, { recursive: true });
        }
        
        // Рекурсивно загружаем все файлы
        downloadGitHubDirectory(apiUrl, targetPath, owner, repo)
            .then(() => {
                console.log(`Successfully downloaded assembly via API to ${targetPath}`);
                resolve();
            })
            .catch((error) => {
                console.error('GitHub API download failed:', error);
                // Если API не работает, пробуем прямой метод
                console.log('Trying direct download method as fallback...');
                downloadAssemblyFromGitHubDirect(githubRepo, targetPath, versionType)
                    .then(resolve)
                    .catch(reject);
            });
    });
}

// Рекурсивная загрузка директории с GitHub
function downloadGitHubDirectory(apiUrl, targetPath, owner, repo) {
    return new Promise((resolve, reject) => {
        fetchJSON(apiUrl).then((contents) => {
            const promises = [];
            
            for (const item of contents) {
                const itemPath = path.join(targetPath, item.name);
                
                if (item.type === 'file') {
                    // Пропускаем файлы конфигурации, если они уже существуют (чтобы сохранить настройки пользователя)
                    if (isConfigFile(itemPath, targetPath) && fs.existsSync(itemPath)) {
                        console.log(`Preserving existing config file: ${item.name}`);
                        continue;
                    }
                    
                    // Загружаем файл
                    promises.push(
                        downloadFile(item.download_url, itemPath)
                            .then(() => console.log(`Downloaded: ${item.name}`))
                            .catch(err => console.error(`Error downloading ${item.name}:`, err))
                    );
                } else if (item.type === 'dir') {
                    // Рекурсивно загружаем директорию
                    if (!fs.existsSync(itemPath)) {
                        fs.mkdirSync(itemPath, { recursive: true });
                    }
                    const dirApiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${item.path}`;
                    promises.push(downloadGitHubDirectory(dirApiUrl, itemPath, owner, repo));
                }
            }
            
            Promise.all(promises).then(resolve).catch(reject);
        }).catch(reject);
    });
}

// Получение списка всех файлов из GitHub репозитория
function getGitHubFileList(githubRepo) {
    return new Promise((resolve, reject) => {
        const repoMatch = githubRepo.match(/github\.com\/([^/]+)\/([^/]+)(?:\.git)?$/);
        if (!repoMatch) {
            reject(new Error('Неверный URL репозитория GitHub'));
            return;
        }
        
        const [, owner, repo] = repoMatch;
        console.log(`Getting file list from GitHub: ${owner}/${repo}`);
        
        // Пробуем сначала main, потом master
        const tryBranch = (branch) => {
            const apiUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
            return fetchJSON(apiUrl).then((data) => {
                const fileList = [];
                
                if (data.tree && Array.isArray(data.tree)) {
                    for (const item of data.tree) {
                        if (item.type === 'blob') { // blob = файл
                            fileList.push({
                                path: item.path,
                                sha: item.sha,
                                size: item.size || 0
                            });
                        }
                    }
                    console.log(`Found ${fileList.length} files in ${branch} branch`);
                } else {
                    console.warn(`No tree data found in ${branch} branch`);
                }
                
                if (fileList.length === 0) {
                    // Если репозиторий пустой, это не ошибка, просто возвращаем пустой список
                    console.warn(`Repository ${owner}/${repo} appears to be empty`);
                }
                
                return fileList;
            });
        };
        
        // Пробуем main, затем master
        tryBranch('main')
            .then((fileList) => {
                if (fileList.length > 0) {
                    resolve(fileList);
                } else {
                    // Если main пустая, пробуем master
                    console.log('Main branch is empty, trying master...');
                    tryBranch('master')
                        .then(resolve)
                        .catch((error) => {
                            console.error('Error fetching from master branch:', error);
                            // Если обе ветки пустые, это нормально для нового репозитория
                            resolve([]);
                        });
                }
            })
            .catch((error) => {
                console.log('Error fetching from main branch, trying master...', error.message);
                // Если ошибка 403, пробуем master, но если и там 403 - возвращаем пустой список
                if (error.message && error.message.includes('403')) {
                    console.warn('GitHub API returned 403, will try direct download method');
                    // Возвращаем пустой список, чтобы использовать прямой метод загрузки
                    resolve([]);
                } else {
                    tryBranch('master')
                        .then(resolve)
                        .catch((masterError) => {
                            if (masterError.message && masterError.message.includes('403')) {
                                console.warn('GitHub API returned 403 for master branch too');
                                resolve([]); // Возвращаем пустой список для использования прямого метода
                            } else {
                                console.error('Error fetching from both branches:', masterError);
                                reject(new Error(`Не удалось получить список файлов из репозитория: ${masterError.message}`));
                            }
                        });
                }
            });
    });
}

// Проверка целостности сборки
function checkAssemblyIntegrity(assemblyPath, githubRepo) {
    return new Promise((resolve, reject) => {
        console.log('Checking assembly integrity...');
        updateProgress(26, 'Проверка целостности сборки...');
        
        // Проверяем, есть ли хотя бы основные файлы сборки (mods папка)
        const modsPath = path.join(assemblyPath, 'mods');
        const hasMods = fs.existsSync(modsPath) && fs.readdirSync(modsPath).filter(f => f.endsWith('.jar')).length > 0;
        
        if (!fs.existsSync(assemblyPath) || !hasMods) {
            // Если папки нет или нет модов, нужно загрузить всё
            console.log('Assembly folder missing or empty, will download from GitHub');
            resolve({ needsDownload: true, missingFiles: [] });
            return;
        }
        
        // Получ��ем список файлов из GitHub
        getGitHubFileList(githubRepo)
            .then((githubFiles) => {
                // Если репозиторий пустой, считаем что проверка прошла успешно
                if (githubFiles.length === 0) {
                    console.warn('GitHub repository is empty, skipping integrity check');
                    resolve({
                        needsDownload: false,
                        needsRepair: false,
                        missingFiles: [],
                        corruptedFiles: [],
                        isEmpty: true
                    });
                    return;
                }
                
                const missingFiles = [];
                const corruptedFiles = [];
                
                console.log(`Checking ${githubFiles.length} files for integrity...`);
                
                // Проверяем каждый файл
                for (const githubFile of githubFiles) {
                    const localFilePath = path.join(assemblyPath, githubFile.path);
                    const localDir = path.dirname(localFilePath);
                    
                    // Создаём директорию если её нет
                    if (!fs.existsSync(localDir)) {
                        fs.mkdirSync(localDir, { recursive: true });
                    }
                    
                    // Проверяем существование файла
                    if (!fs.existsSync(localFilePath)) {
                        missingFiles.push(githubFile);
                        console.log(`Missing file: ${githubFile.path}`);
                    } else {
                        // Проверяем размер файла (базовая проверка целостности)
                        try {
                            const stats = fs.statSync(localFilePath);
                            if (githubFile.size > 0 && Math.abs(stats.size - githubFile.size) > 100) {
                                // Размер сильно отличается, возможно файл повреждён
                                corruptedFiles.push(githubFile);
                                console.log(`Corrupted file (size mismatch): ${githubFile.path} (local: ${stats.size}, expected: ${githubFile.size})`);
                            }
                        } catch (error) {
                            console.warn(`Error checking file ${githubFile.path}:`, error);
                            corruptedFiles.push(githubFile);
                        }
                    }
                }
                
                const needsRepair = missingFiles.length > 0 || corruptedFiles.length > 0;
                
                if (needsRepair) {
                    console.log(`Assembly integrity check: ${missingFiles.length} missing files, ${corruptedFiles.length} corrupted files`);
                    resolve({
                        needsDownload: false,
                        needsRepair: true,
                        missingFiles: missingFiles,
                        corruptedFiles: corruptedFiles
                    });
                } else {
                    console.log('Assembly integrity check: All files are present and valid');
                    resolve({
                        needsDownload: false,
                        needsRepair: false,
                        missingFiles: [],
                        corruptedFiles: []
                    });
                }
            })
            .catch((error) => {
                console.error('Error checking assembly integrity:', error);
                // Если не удалось проверить, проверяем наличие основных файлов
                const modsPath = path.join(assemblyPath, 'mods');
                const hasMods = fs.existsSync(modsPath) && fs.readdirSync(modsPath).filter(f => f.endsWith('.jar')).length > 0;
                
                if (!hasMods) {
                    // Если модов нет, нужно загрузить
                    console.log('Cannot verify integrity, but mods are missing. Will download.');
                    resolve({
                        needsDownload: true,
                        missingFiles: [],
                        checkFailed: true
                    });
                } else {
                    // Если моды есть, продолжаем (возможно временная проблема с сетью)
                    console.warn('Integrity check failed, but mods exist. Continuing...');
                    resolve({
                        needsDownload: false,
                        needsRepair: false,
                        checkFailed: true
                    });
                }
            });
    });
}

// Загрузка недостающих файлов сборки
function repairAssembly(assemblyPath, githubRepo, missingFiles, corruptedFiles) {
    return new Promise((resolve, reject) => {
        const allFilesToDownload = [...missingFiles, ...corruptedFiles];
        
        if (allFilesToDownload.length === 0) {
            resolve();
            return;
        }
        
        console.log(`Repairing assembly: downloading ${allFilesToDownload.length} files...`);
        updateProgress(27, `Восстановление сборки: ${allFilesToDownload.length} файлов...`);
        
        const repoMatch = githubRepo.match(/github\.com\/([^/]+)\/([^/]+)(?:\.git)?$/);
        if (!repoMatch) {
            reject(new Error('Invalid GitHub repository URL'));
            return;
        }
        
        const [, owner, repo] = repoMatch;
        let downloaded = 0;
        const total = allFilesToDownload.length;
        
        const downloadPromises = allFilesToDownload.map((file) => {
            const localFilePath = path.join(assemblyPath, file.path);
            const localDir = path.dirname(localFilePath);
            
            // Пропускаем файлы настроек, если они уже существуют (чтобы сохранить настройки пользователя)
            if (isConfigFile(localFilePath, assemblyPath) && fs.existsSync(localFilePath)) {
                console.log(`Preserving existing settings file during repair: ${file.path}`);
                downloaded++;
                return Promise.resolve(); // Возвращаем успешный промис
            }
            
            // Создаём директорию если её нет
            if (!fs.existsSync(localDir)) {
                fs.mkdirSync(localDir, { recursive: true });
            }
            
            // Удаляем повреждённый файл если он существует
            if (fs.existsSync(localFilePath)) {
                try {
                    fs.unlinkSync(localFilePath);
                } catch (e) {
                    console.warn(`Could not remove corrupted file ${file.path}:`, e);
                }
            }
            
            // Загружаем файл через raw.githubusercontent.com
            const downloadUrl = `https://raw.githubusercontent.com/${owner}/${repo}/main/${file.path}`;
            
            return downloadFile(downloadUrl, localFilePath)
                .then(() => {
                    downloaded++;
                    const progress = 27 + Math.floor((downloaded / total) * 3);
                    updateProgress(progress, `Загружено ${downloaded}/${total} файлов...`);
                    console.log(`Downloaded: ${file.path}`);
                })
                .catch((error) => {
                    // Пробуем master ветку если main не работает
                    const masterUrl = `https://raw.githubusercontent.com/${owner}/${repo}/master/${file.path}`;
                    return downloadFile(masterUrl, localFilePath)
                        .then(() => {
                            downloaded++;
                            const progress = 27 + Math.floor((downloaded / total) * 3);
                            updateProgress(progress, `Загружено ${downloaded}/${total} файлов...`);
                            console.log(`Downloaded (from master): ${file.path}`);
                        })
                        .catch((err) => {
                            console.error(`Failed to download ${file.path}:`, err);
                            throw err;
                        });
                });
        });
        
        Promise.all(downloadPromises)
            .then(() => {
                console.log(`Assembly repair completed: ${downloaded} files downloaded`);
                updateProgress(30, 'Сборка восстановлена');
                resolve();
            })
            .catch((error) => {
                console.error('Error repairing assembly:', error);
                reject(error);
            });
    });
}

// Установка сборки модов
function installModpack(minecraftPath, versionType = 'evacuation') {
    return new Promise((resolve, reject) => {
        updateProgress(25, 'Чтение сборки модов...');
        
        // Файлы из репозитория загружаются напрямую в папку Minecraft
        // Не создаём отдельные папки для сборок
        const assemblyPath = minecraftPath;
        
        console.log('installModpack: Starting installation');
        console.log('  Minecraft path:', minecraftPath);
        console.log('  Version type:', versionType);
        console.log('  Path exists:', fs.existsSync(assemblyPath));
        
        // Репозиторий сборки для выживания
        const githubRepo = versionType === 'evacuation'
            ? 'https://github.com/stalker22072003-cell/sborka_modov'
            : null;
        
        console.log('  GitHub repo:', githubRepo);
        
        // Проверяем целостность сборки
        if (githubRepo) {
            checkAssemblyIntegrity(assemblyPath, githubRepo)
                .then((integrityResult) => {
                    // Если репозиторий пустой, просто продолжаем с существующей сборкой
                    if (integrityResult.isEmpty) {
                        console.log('Repository is empty, using existing assembly if available');
                        if (fs.existsSync(assemblyPath) && fs.existsSync(path.join(assemblyPath, 'mods'))) {
                            continueInstallation();
                        } else {
                            reject(new Error('Репозиторий сборки пуст, и локальная сборка не найдена. Пожалуйста, добавьте файлы в репозиторий или локальную папку.'));
                        }
                        return;
                    }
                    
                    // Если проверка не удалась, проверяем наличие файлов
                    if (integrityResult.checkFailed) {
                        const modsPath = path.join(assemblyPath, 'mods');
                        let hasMods = false;
                        try {
                            hasMods = fs.existsSync(modsPath) && fs.readdirSync(modsPath).filter(f => f.endsWith('.jar')).length > 0;
                        } catch (e) {
                            console.warn('Error checking mods:', e);
                        }
                        
                        if (integrityResult.needsDownload || !hasMods) {
                            // Нужно загрузить сборку
                            console.log('Integrity check failed and mods missing. Downloading assembly...');
                            updateProgress(27, 'Загрузка сборки с GitHub...');
                            downloadAssemblyFromGitHub(githubRepo, assemblyPath, versionType)
                                .then(() => {
                                    console.log('Assembly downloaded from GitHub, continuing installation...');
                                    continueInstallation();
                                })
                                .catch((downloadError) => {
                                    reject(new Error(`Не удалось загрузить сборку с GitHub: ${downloadError.message}`));
                                });
                        } else {
                            // Моды есть, продолжаем
                            console.warn('Integrity check failed, but mods exist. Continuing...');
                            continueInstallation();
                        }
                        return;
                    }
                    
                    if (integrityResult.needsDownload) {
                        // Сборка отсутствует, загружаем полностью
                        console.log('Assembly needs to be downloaded from GitHub');
                        updateProgress(27, 'Загрузка сборки с GitHub...');
                        downloadAssemblyFromGitHub(githubRepo, assemblyPath, versionType)
                            .then(() => {
                                console.log('✓ Assembly downloaded from GitHub successfully');
                                console.log('  Downloaded to:', assemblyPath);
                                // Проверяем что файлы действит��льно загрузились
                                const modsPath = path.join(assemblyPath, 'mods');
                                if (fs.existsSync(modsPath)) {
                                    const modCount = fs.readdirSync(modsPath).filter(f => f.endsWith('.jar')).length;
                                    console.log(`  Found ${modCount} mods after download`);
                                }
                                continueInstallation();
                            })
                            .catch((downloadError) => {
                                console.error('✗ Error downloading from GitHub:', downloadError);
                                console.error('  Error details:', downloadError.message);
                                console.error('  Stack:', downloadError.stack);
                                reject(new Error(`Не удалось загрузить сборку с GitHub: ${downloadError.message || 'Неизвестная ошибка'}`));
                            });
                    } else if (integrityResult.needsRepair) {
                        // Нужно восстановить недостающие/повреждённые файлы
                        repairAssembly(assemblyPath, githubRepo, integrityResult.missingFiles, integrityResult.corruptedFiles)
                            .then(() => {
                                console.log('Assembly repaired, continuing installation...');
                                continueInstallation();
                            })
                            .catch((repairError) => {
                                console.error('Error repairing assembly:', repairError);
                                // Пробуем загрузить полностью
                                updateProgress(27, 'Попытка пол��ой загрузки сборки...');
                                downloadAssemblyFromGitHub(githubRepo, assemblyPath, versionType)
                                    .then(() => {
                                        console.log('Assembly re-downloaded, continuing installation...');
                                        continueInstallation();
                                    })
                                    .catch((downloadError) => {
                                        reject(new Error(`Не удалось восстановить сборку: ${repairError.message || 'Неизвестная ошибка'}`));
                                    });
                            });
                    } else {
                        // Сборка в порядке, продолжаем установку
                        continueInstallation();
                    }
                })
                .catch((checkError) => {
                    console.error('Error checking assembly integrity:', checkError);
                    // Проверяем наличие основных файлов сборки
                    const modsPath = path.join(assemblyPath, 'mods');
                    let hasMods = false;
                    try {
                        hasMods = fs.existsSync(modsPath) && fs.readdirSync(modsPath).filter(f => f.endsWith('.jar')).length > 0;
                    } catch (e) {
                        console.warn('Error checking mods folder:', e);
                    }
                    
                    if (hasMods) {
                        // Если моды есть, продолжаем (возможно временная проблема с сетью)
                        console.warn('Integrity check failed, but mods exist. Continuing...');
                        continueInstallation();
                    } else {
                        // Если модов нет, загружаем сборку
                        console.log('Integrity check failed and no mods found. Downloading assembly...');
                        updateProgress(27, 'Загрузка сборки с GitHub...');
                        downloadAssemblyFromGitHub(githubRepo, assemblyPath, versionType)
                            .then(() => {
                                console.log('Assembly downloaded from GitHub, continuing installation...');
                                continueInstallation();
                            })
                            .catch((downloadError) => {
                                reject(new Error(`Не удалось загрузить сборку с GitHub: ${downloadError.message}`));
                            });
                    }
                });
        } else {
            reject(new Error('Неизвестный тип сборки'));
        }
        
        function continueInstallation() {
            console.log('installModpack: Minecraft path (assembly path):', assemblyPath);
            console.log('installModpack: Path exists:', fs.existsSync(assemblyPath));
            
            // assemblyPath и minecraftPath теперь одно и то же
            // Файлы из репозитория загружаются напрямую в папку Minecraft
            const modsPath = path.join(minecraftPath, 'mods');
            const configPath = path.join(minecraftPath, 'config');
        
        updateProgress(30, 'Создание папок...');
        
        // Создаём папки если их нет
        if (!fs.existsSync(minecraftPath)) {
            fs.mkdirSync(minecraftPath, { recursive: true });
        }
        if (!fs.existsSync(modsPath)) {
            fs.mkdirSync(modsPath, { recursive: true });
        }
        if (!fs.existsSync(configPath)) {
            fs.mkdirSync(configPath, { recursive: true });
        }
        
        // Файлы из репозитория уже находятся в правильных местах
        // Моды уже в minecraftPath/mods, конфиги в minecraftPath/config и т.д.
        // Просто проверяем, что всё на месте
        console.log('installModpack: Checking mods...');
        console.log('  Mods path:', modsPath);
        console.log('  Mods path exists:', fs.existsSync(modsPath));
        
        if (fs.existsSync(modsPath)) {
            try {
                const modFiles = fs.readdirSync(modsPath).filter(f => f.endsWith('.jar') && f !== '.gitkeep');
                console.log(`  Found ${modFiles.length} mod files in mods folder`);
                if (modFiles.length > 0) {
                    updateProgress(50, `Найдено ${modFiles.length} модов`);
                }
            } catch (error) {
                console.warn('Error reading mods folder:', error);
            }
        }
        
        // Проверяем modpack.json для информации о сборке (если есть)
        // Файлы уж�� находятся в правильных местах, загружены из GitHub
        const modpackFile = path.join(minecraftPath, 'modpack.json');
        if (fs.existsSync(modpackFile)) {
            try {
                const modpack = JSON.parse(fs.readFileSync(modpackFile, 'utf8'));
                console.log('Found modpack.json:', modpack);
                updateProgress(60, 'Сборка проверена');
            } catch (error) {
                console.warn('Error reading modpack.json:', error);
            }
        } else {
            console.log('modpack.json not found, files are already in place from GitHub');
        }
        
        updateProgress(70, 'Сборка готова!');
        
        resolve();
        } // конец continueInstallation
    }); // конец Promise
}

// Запуск Minecraft
// Проверка версии Java
function checkJavaVersion(javaPath) {
    return new Promise((resolve, reject) => {
        const checkProcess = spawn(javaPath, ['-version'], {
            stdio: ['ignore', 'pipe', 'pipe']
        });
        
        let output = '';
        checkProcess.stderr.on('data', (data) => {
            output += data.toString();
        });
        
        checkProcess.stdout.on('data', (data) => {
            output += data.toString();
        });
        
        checkProcess.on('close', (code) => {
            // Парсим версию из вывода
            const versionMatch = output.match(/version "(\d+)/);
            if (versionMatch) {
                const version = parseInt(versionMatch[1]);
                resolve(version);
            } else {
                // Пробуем другой формат
                const altMatch = output.match(/openjdk version "(\d+)/);
                if (altMatch) {
                    resolve(parseInt(altMatch[1]));
                } else {
                    reject(new Error('Не удалось опр��делить версию Java'));
                }
            }
        });
        
        checkProcess.on('error', (error) => {
            reject(error);
        });
    });
}

// Загру��ка и установка Java 21
function downloadAndInstallJava(minecraftPath) {
    return new Promise((resolve, reject) => {
        const osType = os.platform();
        const arch = os.arch();
        
        if (osType !== 'win32') {
            reject(new Error('Автоматическая загрузка Java пока поддерживается только для Windows'));
            return;
        }
        
        updateProgress(5, 'Получение информации о Java 21...');
        
        // Используем Adoptium (Eclipse Temurin) - бесплат��ый OpenJDK
        // Для Windows x64 используем прямую ссылку на Java 21 LTS
        const javaVersion = '21.0.5+11';
        const javaUrl = `https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse?project=jdk`;
        
        const javaDir = path.join(minecraftPath, 'java');
        const javaZipPath = path.join(javaDir, 'java21.zip');
        const javaExtractPath = path.join(javaDir, 'extracted');
        
        // Создаём папку для Java
        if (!fs.existsSync(javaDir)) {
            fs.mkdirSync(javaDir, { recursive: true });
        }
        
        updateProgress(10, 'Загрузка Java 21...');
        
        // Сначала получаем прямую ссылку через API
        fetchJSON('https://api.adoptium.net/v3/assets/latest/21/hotspot?os=windows&architecture=x64&image_type=jdk&vendor=eclipse')
            .then(assets => {
                if (!assets || assets.length === 0) {
                    throw new Error('Не удалось получить информацию о Java');
                }
                
                // Находим Windows x64 JDK
                const windowsAsset = assets.find(a => 
                    a.binary && 
                    a.binary.os === 'windows' && 
                    a.binary.architecture === 'x64' &&
                    a.binary.image_type === 'jdk'
                );
                
                if (!windowsAsset || !windowsAsset.binary || !windowsAsset.binary.package) {
                    throw new Error('Не найдена подходящая версия Java для Windows');
                }
                
                const downloadUrl = windowsAsset.binary.package.link;
                const fileName = windowsAsset.binary.package.name;
                
                console.log('Downloading Java from:', downloadUrl);
                updateProgress(15, `Загрузка Java 21 (${Math.floor(windowsAsset.binary.package.size / 1024 / 1024)}MB)...`);
                
                return downloadFile(downloadUrl, javaZipPath, (downloaded, total) => {
                    const percent = 15 + Math.floor((downloaded / total) * 60);
                    updateProgress(percent, `Загрузка Java: ${Math.floor(downloaded / 1024 / 1024)}MB / ${Math.floor(total / 1024 / 1024)}MB`);
                }).then(() => ({ fileName, downloadUrl }));
            })
            .then(({ fileName }) => {
                updateProgress(75, 'Распаковка Java 21...');
                
                // Распаковываем ZIP архив
                return new Promise((resolveExtract, rejectExtract) => {
                    try {
                        // Используем встроенный модуль для распаковки
                        const AdmZip = require('adm-zip');
                        const zip = new AdmZip(javaZipPath);
                        
                        zip.extractAllTo(javaExtractPath, true);
                        
                        // Находим папку с Java (обычно jdk-21.x.x+xx)
                        const extractedDirs = fs.readdirSync(javaExtractPath);
                        const jdkDir = extractedDirs.find(dir => dir.startsWith('jdk'));
                        
                        if (!jdkDir) {
                            rejectExtract(new Error('Не найдена папка JDK в архиве'));
                            return;
                        }
                        
                        const javaBinPath = path.join(javaExtractPath, jdkDir, 'bin', 'java.exe');
                        
                        if (!fs.existsSync(javaBinPath)) {
                            rejectExtract(new Error('Не найден java.exe в распакованном архиве'));
                            return;
                        }
                        
                        // Удаляем ZIP файл
                        try {
                            fs.unlinkSync(javaZipPath);
                        } catch (e) {
                            console.warn('Could not delete Java ZIP:', e);
                        }
                        
                        updateProgress(95, 'Проверка установленной Java...');
                        
                        // Проверяем версию установленной Java
                        checkJavaVersion(javaBinPath).then(version => {
                            if (version >= 21) {
                                console.log('Java 21 successfully installed:', javaBinPath);
                                updateProgress(100, 'Java 21 установлена!');
                                resolveExtract(javaBinPath);
                            } else {
                                rejectExtract(new Error(`Установлена Java ${version}, требуется Java 21+`));
                            }
                        }).catch(rejectExtract);
                        
                    } catch (error) {
                        // Если adm-zip не установлен, пробуем альтернативный способ
                        console.warn('adm-zip not available, trying alternative method:', error);
                        rejectExtract(new Error('Требуется модуль adm-zip для распаковки. Установите: npm install adm-zip'));
                    }
                });
            })
            .then((javaPath) => {
                // Сохраняем путь к Java
                localStorage.setItem('java-path', javaPath);
                resolve(javaPath);
            })
            .catch(reject);
    });
}

// Проверка и установка Java если нужно
function ensureJava(minecraftPath, currentJavaPath) {
    return new Promise((resolve, reject) => {
        // Сначала проверяем текущую Java
        if (currentJavaPath && currentJavaPath !== 'java') {
            if (fs.existsSync(currentJavaPath)) {
                checkJavaVersion(currentJavaPath).then(version => {
                    if (version >= 21) {
                        console.log('Java version OK:', version);
                        resolve(currentJavaPath);
                        return;
                    } else {
                        console.log('Java version too old:', version, ', need 21+');
                        // Версия слишком старая, загружаем новую
                        updateProgress(3, `Java ${version} устарела, загрузка Java 21...`);
                        downloadAndInstallJava(minecraftPath).then(resolve).catch(reject);
                    }
                }).catch(() => {
                    // Не удалось проверить версию, пробуем загрузить
                    console.log('Could not check Java version, downloading Java 21...');
                    updateProgress(3, 'Проверка Java не удалась, загрузка Java 21...');
                    downloadAndInstallJava(minecraftPath).then(resolve).catch(reject);
                });
            } else {
                // Java не найдена, загружаем
                console.log('Java not found, downloading Java 21...');
                updateProgress(3, 'Java не найдена, загрузка Java 21...');
                downloadAndInstallJava(minecraftPath).then(resolve).catch(reject);
            }
        } else {
            // Путь не указан, пробуем системную Java
            checkJavaVersion('java').then(version => {
                if (version >= 21) {
                    console.log('System Java version OK:', version);
                    resolve('java');
                } else {
                    console.log('System Java version too old:', version);
                    updateProgress(3, `Системная Java ${version} устарела, загрузка Java 21...`);
                    downloadAndInstallJava(minecraftPath).then(resolve).catch(reject);
                }
            }).catch(() => {
                // Системная Java не найдена, загружаем
                console.log('System Java not found, downloading Java 21...');
                updateProgress(3, 'Системная Java не найдена, загрузка Java 21...');
                downloadAndInstallJava(minecraftPath).then(resolve).catch(reject);
            });
        }
    });
}

function runMinecraft(minecraftPath, javaPath, playerName, ram, withMods, versionType = 'evacuation', versionOverride = null) {
    // versionOverride всегда должен передаваться из launchMinecraft (versionString)
    // Хардкод 1.21.4 остаётся только для evacuation (кастомная сборка)
    const selectedVer = getSelectedVersion();
    const fallbackMc = (selectedVer && selectedVer.mcVersion) ? selectedVer.mcVersion : '1.21.4';
    const version = versionOverride || (withMods ? fallbackMc + '-fabric' : fallbackMc);
    console.log('Running Minecraft with settings:');
    console.log('  Path:', minecraftPath);
    console.log('  Java:', javaPath);
    console.log('  RAM:', ram + 'GB');
    console.log('  Player:', playerName);
    console.log('  Mods:', withMods);
    console.log('  Version:', version);
    
    // Проверяем существование Java
    if (javaPath !== 'java' && !fs.existsSync(javaPath)) {
        hideProgress();
        resetPlayButton();
        showLauncherAlert(`Ошибка: Java не найдена по пути: ${javaPath}\nПожалуйста, проверьте путь в настройках.`);
        return;
    }
    
    // Проверяем версию Java перед запуском
    updateProgress(85, 'Проверка версии Java...');
    checkJavaVersion(javaPath).then((javaVersion) => {
        console.log('Java version detected:', javaVersion);
        if (javaVersion < 21) {
            hideProgress();
            resetPlayButton();
            showLauncherAlert(`Ошибка: Несовместимая версия Java!\n\n` +
                  `Minecraft 1.21.4 требует Java 21 или выше.\n` +
                  `Обнаружена Java ${javaVersion}.\n\n` +
                  `Пожалуйста:\n` +
                  `1. Установите Java 21 или выше\n` +
                  `2. Укажите путь к новой версии Java в настройках\n\n` +
                  `Текущий путь: ${javaPath}`);
            return;
        }
        
        // Проверяем наличие нативных библиотек (используем выбранную версию)
        const nativesPath = path.join(minecraftPath, 'natives');
        const lwjglDll = path.join(nativesPath, 'lwjgl.dll');
        
        if (!fs.existsSync(lwjglDll)) {
            console.log('Native libraries not found, extracting...');
            updateProgress(88, 'Извлечение нативных библиотек...');
            
            extractNatives(minecraftPath, version).then(() => {
                console.log('Native libraries extracted');
                continueMinecraftLaunch(minecraftPath, javaPath, playerName, ram, withMods, versionType, version);
            }).catch((error) => {
                console.warn('Failed to extract natives:', error);
                continueMinecraftLaunch(minecraftPath, javaPath, playerName, ram, withMods, versionType, version);
            });
        } else {
            // Проверяем размер lwjgl.dll - если он слишком мал, это может быть 32-битная версия
            const nativesPath = path.join(minecraftPath, 'natives');
            const lwjglDll = path.join(nativesPath, 'lwjgl.dll');
            
            if (fs.existsSync(lwjglDll)) {
                try {
                    const stats = fs.statSync(lwjglDll);
                    const sizeMB = stats.size / 1024 / 1024;
                    console.log(`lwjgl.dll size: ${sizeMB.toFixed(2)} MB`);
                    
                    // 32-bit lwjgl.dll для LWJGL 3.3.3 обычно ~300-350KB
                    // 64-bit lwjgl.dll для LWJGL 3.3.3 обычно ~400-500KB
                    // Используем порог 350KB для различения 32-bit и 64-bit
                    if (stats.size < 350000) { // Меньше ~350KB - вероятно 32-битная версия
                        console.warn('lwjgl.dll is too small, might be 32-bit. Re-extracting...');
                        updateProgress(88, 'Переизвлечение нативных библиотек...');
                        
                        // Удаляем неправильный файл и переизвлекаем
                        try {
                            fs.unlinkSync(lwjglDll);
                        } catch (e) {
                            console.warn('Could not remove incorrect lwjgl.dll:', e);
                        }
                        
                        extractNatives(minecraftPath, version).then(() => {
                            console.log('Native libraries re-extracted');
                            continueMinecraftLaunch(minecraftPath, javaPath, playerName, ram, withMods, versionType, version);
                        }).catch((error) => {
                            console.warn('Failed to re-extract natives:', error);
                            continueMinecraftLaunch(minecraftPath, javaPath, playerName, ram, withMods, versionType, version);
                        });
                        return;
                    }
                } catch (e) {
                    console.warn('Could not check lwjgl.dll size:', e);
                }
            }
            
            continueMinecraftLaunch(minecraftPath, javaPath, playerName, ram, withMods, versionType, version);
        }
    }).catch((error) => {
        console.warn('Could not check Java version:', error);
        continueMinecraftLaunch(minecraftPath, javaPath, playerName, ram, withMods, versionType, version);
    });
}

function continueMinecraftLaunch(minecraftPath, javaPath, playerName, ram, withMods, versionType = 'evacuation', versionOverride = null) {
    const version = versionOverride || (withMods ? '1.21.4-fabric' : '1.21.4');
    
    // Создаём папку игры если её нет
    if (!fs.existsSync(minecraftPath)) {
        fs.mkdirSync(minecraftPath, { recursive: true });
        console.log('Created Minecraft directory:', minecraftPath);
    }
    
    // Файлы из репозитория уже находятся в папке Minecraft
    // Не нужно искать отдельную папку assembly
    const assemblyPath = minecraftPath;
    
    console.log('continueMinecraftLaunch: Minecraft path:', minecraftPath);
    console.log('continueMinecraftLaunch: Assembly path (same as Minecraft):', assemblyPath);
    console.log('continueMinecraftLaunch: Path exists:', fs.existsSync(assemblyPath));
    
    // Проверяем наличие модов если версия с модами
    // Файлы уже находятся в правильных местах (загружены из GitHub напрямую в папку Minecraft)
    if (withMods) {
        const modsPath = path.join(minecraftPath, 'mods');
        
        // Создаём папку mods если её нет
        if (!fs.existsSync(modsPath)) {
            fs.mkdirSync(modsPath, { recursive: true });
        }
        
        // Проверяем, есть ли моды в папке mods
        let installedMods = [];
        if (fs.existsSync(modsPath)) {
            installedMods = fs.readdirSync(modsPath).filter(f => f.endsWith('.jar') && f !== '.gitkeep');
        }
        
        console.log('Checking mods installation...');
        console.log('  Mods path:', modsPath);
        console.log('  Installed mods count:', installedMods.length);
        
        if (installedMods.length > 0) {
            console.log(`Found ${installedMods.length} installed mods:`, installedMods);
        } else {
            console.warn('No mods found in mods folder. Files should be downloaded from GitHub repository.');
        }
    }
    
    const versionsPath = path.join(minecraftPath, 'versions', version);
    const versionJsonPath = path.join(versionsPath, version + '.json');
    const clientJarPath = path.join(versionsPath, version + '.jar');
    
    // Проверяем, что версия установлена
    if (!fs.existsSync(clientJarPath)) {
        hideProgress();
        resetPlayButton();
        showLauncherAlert(`Ошибка: Версия Minecraft ${version} не установлена.\nПожалуйста, дождитесь завершения загрузки.`);
        return;
    }
    
    // Проверяем наличие нативных библиотек и извлекаем если нужно
    const nativesPath = path.join(minecraftPath, 'natives');
    const lwjglDll = path.join(nativesPath, 'lwjgl.dll');
    
    // Проверяем, что lwjgl.dll существует и правильного размера
    // 32-bit lwjgl.dll для LWJGL 3.3.3 обычно ~300-350KB
    // 64-bit lwjgl.dll для LWJGL 3.3.3 обычно ~400-500KB
    let needsExtraction = true;
    if (fs.existsSync(lwjglDll)) {
        try {
            const stats = fs.statSync(lwjglDll);
            // 32-bit lwjgl.dll для LWJGL 3.3.3 обычно ~300-350KB
            // 64-bit lwjgl.dll для LWJGL 3.3.3 обычно ~400-500KB
            // Используем порог 350KB для различения 32-bit и 64-bit
            if (stats.size > 350000) { // Больше ~350KB - вероятно 64-битная версия
                console.log(`lwjgl.dll exists and size looks correct: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
                needsExtraction = false;
            } else {
                console.warn(`lwjgl.dll exists but size is too small (${(stats.size / 1024 / 1024).toFixed(2)} MB), might be 32-bit. Will re-extract.`);
                // Удаляем неправильный файл
                try {
                    fs.unlinkSync(lwjglDll);
                    console.log('Removed incorrect lwjgl.dll');
                } catch (e) {
                    console.warn('Could not remove incorrect lwjgl.dll:', e);
                }
            }
        } catch (e) {
            console.warn('Could not check lwjgl.dll:', e);
        }
    }
    
    // Создаём папку natives если её нет
    if (!fs.existsSync(nativesPath)) {
        fs.mkdirSync(nativesPath, { recursive: true });
    }
    
    if (needsExtraction) {
        console.log('Native libraries not found, extracting...');
        console.log('Natives path:', nativesPath);
        updateProgress(85, 'Извлечение нативных библиотек...');
        
        extractNatives(minecraftPath, version).then(() => {
            // Проверяем снова после извлечения
            if (fs.existsSync(lwjglDll)) {
                console.log('Native libraries successfully extracted!');
                continueWithLaunch();
            } else {
                console.error('Native libraries still not found after extraction!');
                console.error('Natives path:', nativesPath);
                try {
                    const files = fs.readdirSync(nativesPath);
                    console.error('Files in natives folder:', files);
                } catch (e) {
                    console.error('Could not read natives folder:', e);
                }
                hideProgress();
                resetPlayButton();
                showLauncherAlert(`Ошибка: Не удалось извлечь нативные библиотеки!\n\n` +
                      `Путь: ${nativesPath}\n\n` +
                      `Проверьте консоль (F12) для подробностей.`);
            }
        }).catch((error) => {
            console.error('Failed to extract natives:', error);
            hideProgress();
            resetPlayButton();
            showLauncherAlert(`Ошибка при извлечении нативных библиотек: ${error.message}\n\n` +
                  `Проверьте консоль (F12) для подробностей.`);
        });
    } else {
        console.log('Native libraries already exist');
        continueWithLaunch();
    }
    
    function continueWithLaunch() {
        const classpath = getMinecraftClasspath(minecraftPath, withMods, version);
    if (!classpath) {
        hideProgress();
        resetPlayButton();
        showLauncherAlert('Ошибка: Не удалось собрать classpath для Minecraft.\nПроверьте, что версия полностью загружена.');
        return;
    }
    
    console.log('Classpath:', classpath);
    
    // Определяем главный класс
    let mainClass = 'net.minecraft.client.main.Main';
    if (withMods) {
        // Для Fabric используем специальный класс
        mainClass = 'net.fabricmc.loader.impl.launch.knot.KnotClient';
    }
    
    // Создаём папку natives если её нет
    const nativesPath = path.join(minecraftPath, 'natives');
    if (!fs.existsSync(nativesPath)) {
        fs.mkdirSync(nativesPath, { recursive: true });
    }
    
    // Получаем assetIndex из version.json
    let assetIndex = '1.21'; // Значение по умолчанию
    try {
        if (fs.existsSync(versionJsonPath)) {
            const versionData = JSON.parse(fs.readFileSync(versionJsonPath, 'utf8'));
            if (versionData.assetIndex && versionData.assetIndex.id) {
                assetIndex = versionData.assetIndex.id;
                console.log('Using assetIndex from version.json:', assetIndex);
            }
        }
    } catch (e) {
        console.warn('Could not read assetIndex from version.json, using default:', e);
    }
        
        // Проверяем наличие нативных библиотек перед запуском
        const lwjglDll = path.join(nativesPath, 'lwjgl.dll');
        if (!fs.existsSync(lwjglDll)) {
            console.error('lwjgl.dll not found in:', nativesPath);
            try {
                const files = fs.readdirSync(nativesPath);
                console.error('Files in natives folder:', files);
            } catch (e) {
                console.error('Could not read natives folder:', e);
            }
            hideProgress();
            resetPlayButton();
            showLauncherAlert(`Ошибка: Нативные библиотеки не найдены!\n\n` +
                  `Путь: ${nativesPath}\n\n` +
                  `Попробуйте удалить папку версии и переустановить Minecraft.`);
            return;
        }
        
        console.log('Native libraries found in:', nativesPath);
        try {
            const files = fs.readdirSync(nativesPath);
            console.log('Native files:', files.filter(f => f.endsWith('.dll')).join(', '));
        } catch (e) {
            console.warn('Could not list native files:', e);
        }
        
        // Базовые параметры JVM с настройками из лаунчера
        // Используем абсолютный путь для natives
        const absoluteNativesPath = path.resolve(nativesPath);
        console.log('Using absolute natives path:', absoluteNativesPath);
        
        const jvmArgs = [
            `-Xmx${ram}G`,           // Максимальная память из настроек
            `-Xms${Math.min(parseInt(ram), 2)}G`,  // Начальная память
            '-Djava.library.path=' + absoluteNativesPath,
            '-Dorg.lwjgl.librarypath=' + absoluteNativesPath,
            '-Dorg.lwjgl.util.Debug=true',
            '-Dorg.lwjgl.util.DebugLoader=true',
            '-Dminecraft.launcher.brand=custom',
            '-Dminecraft.launcher.version=1.0',
            '-Dminecraft.demo=false',
            '-Dminecraft.client=true',
            '-Dminecraft.fullscreen=false',
            '-cp', classpath,
            mainClass,
        '--version', version,
        '--gameDir', minecraftPath,
        '--assetsDir', path.join(minecraftPath, 'assets'),
        '--assetIndex', assetIndex,
        '--width', '854',
        '--height', '480'
    ];
    
    // Генерируем offline UUID на основе имени игрока (как в T-launcher)
    // Это критически важно для полной версии без демо-режима
    // UUID должен быть постоянным для одного и того же имени игрока
    const crypto = require('crypto');
    const uuidKey = `player-uuid-${playerName}`;
    let playerUUID = localStorage.getItem(uuidKey);
    
    if (!playerUUID) {
        // Генерируем offline UUID на основе имени игрока (стандартный алгоритм Minecraft)
        // Используем правильный алгоритм для offline UUID (UUID v3)
        const hash = crypto.createHash('md5').update('OfflinePlayer:' + playerName).digest();
        const uuid = [
            hash.toString('hex', 0, 4),
            hash.toString('hex', 4, 6),
            ((parseInt(hash.toString('hex', 6, 8), 16) & 0x0fff) | 0x3000).toString(16),
            ((parseInt(hash.toString('hex', 8, 10), 16) & 0x3fff) | 0x8000).toString(16),
            hash.toString('hex', 10, 16)
        ].join('-');
        playerUUID = uuid;
        localStorage.setItem(uuidKey, playerUUID);
        console.log('Generated offline UUID for player:', playerName, '->', playerUUID);
    } else {
        console.log('Using saved offline UUID for player:', playerName, '->', playerUUID);
    }
    
    // Создаём файл профиля игрока (как в T-launcher) для полной версии
    // Это помогает Minecraft распознать игрока как полную версию, а не демо
    try {
        const usercachePath = path.join(minecraftPath, 'usercache.json');
        let userCache = [];
        
        // Читаем существующий файл если есть
        if (fs.existsSync(usercachePath)) {
            try {
                userCache = JSON.parse(fs.readFileSync(usercachePath, 'utf8'));
            } catch (e) {
                console.warn('Could not read existing usercache.json:', e);
            }
        }
        
        // Добавляем или обновляем профиль игрока
        const existingIndex = userCache.findIndex(u => u.name === playerName);
        const userEntry = {
            name: playerName,
            uuid: playerUUID,
            expiresOn: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
        };
        
        if (existingIndex >= 0) {
            userCache[existingIndex] = userEntry;
        } else {
            userCache.push(userEntry);
        }
        
        fs.writeFileSync(usercachePath, JSON.stringify(userCache, null, 2), 'utf8');
        console.log('Created/updated user profile file:', usercachePath);
    } catch (e) {
        console.warn('Could not create user profile file:', e);
    }
    
    // Для офлайн-режима добавляем параметры для полной версии (как в T-launcher)
    // КРИТИЧЕСКИ ВАЖНО: порядок параметров должен быть правильным для полной версии
    // Удаляем старые параметры если они есть (чтобы избежать дублирования)
    let usernameIndex = jvmArgs.indexOf('--username');
    while (usernameIndex !== -1) {
        jvmArgs.splice(usernameIndex, 2);
        usernameIndex = jvmArgs.indexOf('--username');
    }
    let versionTypeIndex = jvmArgs.indexOf('--versionType');
    while (versionTypeIndex !== -1) {
        jvmArgs.splice(versionTypeIndex, 2);
        versionTypeIndex = jvmArgs.indexOf('--versionType');
    }
    
    // Добавляем параметры в правильном порядке (как в T-launcher)
    // КРИТИЧЕСКИ ВАЖНО: параметр --demo НЕ РАБОТАЕТ в новых версиях Minecraft!
    // Minecraft игнорирует его (видно в логах: "Completely ignored arguments: [false]")
    // Вместо этого используем только системные свойства и правильный UUID
    jvmArgs.push(
        '--username', playerName,
        '--uuid', playerUUID,
        '--accessToken', '0',
        '--userType', 'legacy',
        '--versionType', withMods ? 'release-modded' : 'release',
        '--lang', 'ru_RU'  // Русский язык по умолчанию
    );
    
    // НЕ добавляем --demo false, так как Minecraft его игнорирует
    // Вместо этого полагаемся на:
    // 1. Правильный offline UUID (на основе имени игрока)
    // 2. Системное свойство -Dminecraft.demo=false
    // 3. Файл профиля игрока (usercache.json)
    
    console.log('=== Launching Minecraft in FULL offline mode (NOT demo) - like T-launcher ===');
    console.log('Player name:', playerName);
    console.log('Player UUID (offline):', playerUUID);
    console.log('All launch parameters:', jvmArgs.join(' '));
    
    if (withMods) {
        // Получаем версию Fabric Loader из localStorage или используем fallback
        const fabricLoaderVersion = localStorage.getItem('fabric-loader-version') || '0.16.0';
        // Используем реальную mcVersion из version, а не хардкод 1.21.4
        const fabricGameVersion = version.replace(/-fabric$/, '');
        jvmArgs.push(
            '--fabric.gameVersion', fabricGameVersion,
            '--fabric.loaderVersion', fabricLoaderVersion
        );
        console.log('Using Fabric game version:', fabricGameVersion, 'Loader version:', fabricLoaderVersion);
    }

    console.log('Java executable:', javaPath);
    console.log('JVM arguments (before custom):', jvmArgs.join(' '));

    // Добавляем пользовательские аргументы
    addUserJVMArgs(jvmArgs);
    console.log('JVM arguments (after custom):', jvmArgs.join(' '));

    // Для Electron нужно использовать spawn
    const mcProcess = spawn(javaPath, jvmArgs, {
        cwd: minecraftPath,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'], // Показываем вывод для отладки
        env: {
            ...process.env
        }
    });
    
    let errorOutput = '';
    let hasError = false;
    
    // Логируем вывод для отладки
    mcProcess.stdout.on('data', (data) => {
        const output = data.toString();
        console.log('Minecraft stdout:', output);
        if (output.toLowerCase().includes('error') || output.toLowerCase().includes('exception')) {
            errorOutput += output;
            hasError = true;
        }
    });
    
    mcProcess.stderr.on('data', (data) => {
        const output = data.toString();
        console.error('Minecraft stderr:', output);
        errorOutput += output;
        // Не все stderr - это ошибки, но логируем
        if (output.toLowerCase().includes('error') || output.toLowerCase().includes('exception') || output.toLowerCase().includes('fatal')) {
            hasError = true;
        }
    });
    
    mcProcess.on('error', (error) => {
        console.error('Error launching Minecraft:', error);
        console.error('Java path:', javaPath);
        console.error('Minecraft path:', minecraftPath);
        console.error('Classpath length:', classpath.split(path.delimiter).length);
        hasError = true;
        hideProgress();
        resetPlayButton();
        let errorMsg = `Ошибка при запуске Minecraft: ${error.message}\n\n`;
        errorMsg += `Детали:\n`;
        errorMsg += `- Java: ${javaPath}\n`;
        errorMsg += `- Путь игры: ${minecraftPath}\n`;
        errorMsg += `- Версия: ${version}\n\n`;
        errorMsg += `Проверьте:\n`;
        errorMsg += `1. Путь к Java правильный (${javaPath === 'java' ? 'используется системная Java' : javaPath})\n`;
        errorMsg += `2. Версия Minecraft загружена (${fs.existsSync(clientJarPath) ? 'да' : 'нет'})\n`;
        errorMsg += `3. Консоль разработчика открыта автоматически\n`;
        
        showLauncherAlert(errorMsg);
    });
    
    mcProcess.on('exit', (code, signal) => {
        console.log(`Minecraft process exited with code ${code} and signal ${signal}`);
        if (code !== 0 && code !== null && code !== 130) {
            console.error('Minecraft exited with error code:', code);

            const allOutput = errorOutput || '';
            let errorMessage = '';

            // ── Умный анализ лога ───────────────────────────────────────────
            // 1. Несовместимые моды (Fabric)
            const incompatMatch = allOutput.match(/Incompatible mods found!(.*?)(?=\n\[|\nat |$)/si);
            const formattedMatch = allOutput.match(/FormattedException[^\n]*([^\n]+)/i);
            const modConflict = allOutput.match(/Mod '([^']+)' \(([^)]+)\)[^\n]*(requires|conflicts)[^\n]*/gi);
            const missingDep  = allOutput.match(/requires? (?:mod )?'?([\w-]+)'?[^\n]*/gi);

            if (incompatMatch || formattedMatch) {
                // Определяем тип проблемы: отсутствующая зависимость или настоящий конфликт
                const missingLines = modConflict ? modConflict.filter(m => /missing|отсутствует/i.test(m)) : [];
                const conflictLines = modConflict ? modConflict.filter(m => /conflicts|incompatible/i.test(m)) : [];
                const requiresLines = modConflict ? modConflict.filter(m => /requires/i.test(m) && !/conflicts/i.test(m)) : [];

                // Если есть "requires ... which is missing" — это зависимость, а не конфликт
                const isMissingDep = missingLines.length > 0 || (requiresLines.length > 0 && conflictLines.length === 0);

                if (isMissingDep) {
                    errorMessage = '📦 Отсутствует зависимость мода\n\n';
                    errorMessage += 'Один или несколько модов требуют дополнительные моды, которые не установлены.\n\n';
                    const depLines = [...missingLines, ...requiresLines];
                    if (depLines.length > 0) {
                        errorMessage += 'Проблемы:\n';
                        // Дедупликация по паре (кто требует → что требуется)
                        const seen = new Set();
                        depLines.slice(0, 8).forEach(m => {
                            const clean = m.replace(/\[\d+:\d+:\d+\][^:]*: /g, '').trim();
                            // Парсим: Mod 'ИМЯ' (id) ... requires ... version of МОД
                            const matchFull = clean.match(/Mod '([^']+)'\s*\([^)]+\)[^r]*requires[^v]*version of ([a-zA-Z0-9_\-]+)/i);
                            // Парсим: Mod 'ИМЯ' (id) ... requires mod МОД
                            const matchMod  = clean.match(/Mod '([^']+)'\s*\([^)]+\)[^r]*requires mod ([a-zA-Z0-9_\-]+)/i);
                            // Парсим: requires any X.x version of МОД
                            const matchVer  = clean.match(/requires any ([^\s]+) version of ([a-zA-Z0-9_\-]+)/i);

                            let line;
                            if (matchFull) {
                                const requirer = matchFull[1];
                                const needed   = matchFull[2];
                                const version  = matchVer ? matchVer[1] : null;
                                const key = requirer + '→' + needed;
                                if (seen.has(key)) return;
                                seen.add(key);
                                line = `Мод "${requirer}" требует установить "${needed}"` + (version ? ` (версия ${version})` : '');
                            } else if (matchMod) {
                                const requirer = matchMod[1];
                                const needed   = matchMod[2];
                                const key = requirer + '→' + needed;
                                if (seen.has(key)) return;
                                seen.add(key);
                                line = `Мод "${requirer}" требует установить "${needed}"`;
                            } else {
                                // fallback — просто вычленяем название мода после "of" или "mod"
                                const fallback = clean.match(/(?:version of|requires mod)\s+([a-zA-Z0-9_\-]+)/i);
                                const needed = fallback ? fallback[1] : clean.substring(0, 80);
                                if (seen.has(needed)) return;
                                seen.add(needed);
                                line = `Требуется установить мод "${needed}"`;
                            }
                            errorMessage += '• ' + line + '\n';
                        });
                        errorMessage += '\n';
                    }
                    errorMessage += 'Что делать:\n';
                    errorMessage += '1. Установите недостающие моды-зависимости\n';
                    errorMessage += '2. Найдите мод в разделе «Ресурсы» → «Поиск модов»\n';
                    errorMessage += '3. Или удалите мод, которому не хватает зависимости';
                } else {
                    errorMessage = '⚠️ Конфликт модов\n\n';
                    errorMessage += 'Два или более мода несовместимы друг с другом.\n\n';
                    if (conflictLines.length > 0 || (modConflict && modConflict.length > 0)) {
                        errorMessage += 'Конфликты:\n';
                        const seen = new Set();
                        (conflictLines.length > 0 ? conflictLines : modConflict).slice(0, 8).forEach(m => {
                            const clean = m.replace(/\[\d+:\d+:\d+\][^:]*: /g, '').trim();
                            // Парсим: Mod 'A' ... conflicts with 'B'
                            const matchConflict = clean.match(/Mod '([^']+)'[^c]*conflicts with[^']*'([^']+)'/i);
                            // Парсим: Mod 'A' ... incompatible with 'B'
                            const matchIncompat = clean.match(/Mod '([^']+)'[^i]*incompatible with[^']*'([^']+)'/i);
                            let line;
                            if (matchConflict) {
                                const key = matchConflict[1] + '↔' + matchConflict[2];
                                if (seen.has(key)) return;
                                seen.add(key);
                                line = `"${matchConflict[1]}" конфликтует с "${matchConflict[2]}"`;
                            } else if (matchIncompat) {
                                const key = matchIncompat[1] + '↔' + matchIncompat[2];
                                if (seen.has(key)) return;
                                seen.add(key);
                                line = `"${matchIncompat[1]}" несовместим с "${matchIncompat[2]}"`;
                            } else {
                                if (seen.has(clean)) return;
                                seen.add(clean);
                                line = clean.substring(0, 100);
                            }
                            errorMessage += '• ' + line + '\n';
                        });
                        errorMessage += '\n';
                    }
                    errorMessage += 'Что делать:\n';
                    errorMessage += '1. Удалите один из конфликтующих модов\n';
                    errorMessage += '2. Проверьте совместимость версий модов\n';
                    errorMessage += '3. Обновите моды до версии игры';
                }

            // 2. Нехватка памяти
            } else if (allOutput.includes('OutOfMemoryError') || allOutput.includes('Java heap space')) {
                errorMessage = '💾 Не хватает памяти (RAM)\n\n';
                errorMessage += 'Java закончилась доступная оперативная память.\n\n';
                errorMessage += 'Что делать:\n';
                errorMessage += '1. Увеличьте RAM в настройках лаунчера (рекомендуется 4–6 GB)\n';
                errorMessage += '2. Уменьшите количество модов\n';
                errorMessage += '3. Закройте другие приложения';

            // 3. Ошибка JVM / битая Java
            } else if (allOutput.includes('A JNI error') || allOutput.includes('Could not find or load main class') || allOutput.includes('UnsupportedClassVersionError')) {
                errorMessage = '☕ Проблема с Java\n\n';
                errorMessage += 'Не удалось запустить JVM. Возможно установлена неподходящая версия Java.\n\n';
                errorMessage += 'Что делать:\n';
                errorMessage += '1. Установите Java 21 (требуется для MC 1.21+)\n';
                errorMessage += '2. Проверьте путь к Java в настройках\n';
                errorMessage += '3. Переустановите Java';

            // 4. Битые/отсутствующие нативные файлы
            // 4. Битые/отсутствующие нативные файлы (только UnsatisfiedLinkError, без ложных срабатываний на .dll в путях)
            } else if (allOutput.includes('UnsatisfiedLinkError')) {
                const dllMatch = allOutput.match(/UnsatisfiedLinkError[^\n]*?([^\s/\\]+\.(?:dll|so|dylib))/i);
                const missingLib = dllMatch ? dllMatch[1] : null;
                errorMessage = '📦 Отсутствует нативная библиотека\n\n';
                if (missingLib) {
                    errorMessage += `Не найден системный файл: ${missingLib}\n\n`;
                } else {
                    errorMessage += 'Не найден системный файл (.dll/.so), необходимый для запуска.\n\n';
                }
                errorMessage += 'Что делать:\n';
                errorMessage += '1. Переустановите версию Minecraft через лаунчер\n';
                errorMessage += '2. Проверьте антивирус — он мог удалить файлы\n';
                errorMessage += '3. Запустите лаунчер от имени администратора';

            // 5. NoClassDefFoundError — мод или компонент скомпилирован под другую версию Java
            } else if (allOutput.includes('NoClassDefFoundError') || allOutput.includes('ClassNotFoundException')) {
                const classMatch = allOutput.match(/(?:NoClassDefFoundError|ClassNotFoundException)[:\s]+([a-zA-Z0-9$/._-]+)/);
                const className = classMatch ? classMatch[1].split('/').pop().split('.').pop() : null;
                errorMessage = '☕ Несовместимая версия Java или мода\n\n';
                if (className) {
                    errorMessage += `Не удалось загрузить класс: ${className}\n\n`;
                } else {
                    errorMessage += 'Один из модов или компонентов Minecraft скомпилирован под другую версию Java.\n\n';
                }
                errorMessage += 'Что делать:\n';
                errorMessage += '1. Установите Java 21 — она нужна для Minecraft 1.21+\n';
                errorMessage += '2. Убедитесь, что в настройках лаунчера выбрана правильная Java\n';
                errorMessage += '3. Проверьте, что все моды совместимы с версией игры\n';
                errorMessage += '4. Попробуйте удалить последние установленные моды';

            // 6. StackOverflowError — бесконечная рекурсия в моде
            } else if (allOutput.includes('StackOverflowError')) {
                // Пытаемся найти имя мода в стектрейсе
                const stackLines = allOutput.split('\n').filter(l => l.includes('StackOverflowError') || l.includes('\tat '));
                const modHint = stackLines.slice(1, 6).find(l => {
                    const ll = l.toLowerCase();
                    return ll.includes('mod') || ll.includes('fabric') || ll.includes('forge') ||
                           (!ll.includes('java.') && !ll.includes('javax.') && !ll.includes('sun.') && !ll.includes('net.minecraft'));
                });
                const modClass = modHint ? modHint.replace(/\s*at\s+/, '').split('(')[0].trim() : null;
                errorMessage = '🔁 Ошибка в моде (бесконечный цикл)\n\n';
                if (modClass) {
                    errorMessage += `Ошибка обнаружена в: ${modClass}\n\n`;
                } else {
                    errorMessage += 'Один из модов вызвал бесконечную рекурсию и Minecraft упал.\n\n';
                }
                errorMessage += 'Что делать:\n';
                errorMessage += '1. Отключайте моды по одному, чтобы найти виновника\n';
                errorMessage += '2. Обновите все моды до последних версий\n';
                errorMessage += '3. Проверьте совместимость версий модов друг с другом\n';
                errorMessage += '4. Сообщите об ошибке автору мода';

            // 7. Нет прав доступа к файлам/папкам
            } else if (allOutput.includes('AccessDeniedException') || allOutput.includes('Permission denied') || allOutput.includes('Access is denied')) {
                const pathMatch = allOutput.match(/(?:AccessDeniedException|Permission denied)[:\s]+([^\n\r"]+)/i);
                const deniedPath = pathMatch ? pathMatch[1].trim().substring(0, 80) : null;
                errorMessage = '🔒 Нет прав доступа к файлам\n\n';
                if (deniedPath) {
                    errorMessage += `Доступ запрещён: ${deniedPath}\n\n`;
                } else {
                    errorMessage += 'Minecraft не может читать или записывать файлы — недостаточно прав.\n\n';
                }
                errorMessage += 'Что делать:\n';
                errorMessage += '1. Запустите лаунчер от имени администратора\n';
                errorMessage += '2. Проверьте, что папка .minecraft не заблокирована антивирусом\n';
                errorMessage += '3. Откройте свойства папки .minecraft и выдайте полный доступ вашему пользователю\n';
                errorMessage += '4. Убедитесь, что Minecraft не запущен в другом месте';

            // 8. Forge-специфичные ошибки загрузки модов
            } else if (allOutput.includes('FMLLoader') || allOutput.includes('ModLoadingException') || allOutput.includes('fml.loading') || allOutput.includes('net.minecraftforge')) {
                // Пытаемся вытащить имя проблемного мода из Forge-лога
                const fmlModMatch = allOutput.match(/(?:Mod ID|modid|mod id)[:\s"']+([a-zA-Z0-9_\-]+)/i) ||
                                    allOutput.match(/Exception caught during firing event[^\n]*?mod[:\s]+([a-zA-Z0-9_\-]+)/i);
                const forgeMod = fmlModMatch ? fmlModMatch[1] : null;
                const fmlCause = allOutput.match(/Caused by:[^\n]+/);
                const causeText = fmlCause ? fmlCause[0].replace('Caused by:', '').trim().substring(0, 100) : null;
                errorMessage = '⚙️ Ошибка загрузки Forge-мода\n\n';
                if (forgeMod) {
                    errorMessage += `Проблема с модом: ${forgeMod}\n`;
                }
                if (causeText) {
                    errorMessage += `Причина: ${causeText}\n`;
                }
                errorMessage += '\n';
                errorMessage += 'Что делать:\n';
                errorMessage += '1. Проверьте, что все моды предназначены для версии Forge, которую вы используете\n';
                errorMessage += '2. Убедитесь, что Forge совместим с версией Minecraft\n';
                errorMessage += '3. Удалите последние добавленные моды и попробуйте снова\n';
                errorMessage += '4. Обновите Forge до последней рекомендуемой версии';

            // 9. OpenGL / GLFW — проблемы с видеодрайвером или GPU
            } else if (allOutput.includes('GlfwException') || allOutput.includes('OpenGL') || allOutput.includes('GLFW') ||
                       allOutput.includes('org.lwjgl') || allOutput.includes('GLXBadFBConfig') || allOutput.includes('WGL_ARB')) {
                const glMatch = allOutput.match(/(?:GlfwException|GLFW error|OpenGL error)[^\n]*/i);
                const glDetail = glMatch ? glMatch[0].replace(/\[\d+:\d+:\d+\][^:]*: /g, '').trim().substring(0, 100) : null;
                errorMessage = '🖥️ Ошибка видеодрайвера (OpenGL/GLFW)\n\n';
                if (glDetail) {
                    errorMessage += `Детали: ${glDetail}\n\n`;
                } else {
                    errorMessage += 'Minecraft не может инициализировать графику. Проблема с видеодрайвером или GPU.\n\n';
                }
                errorMessage += 'Что делать:\n';
                errorMessage += '1. Обновите драйверы видеокарты (NVIDIA/AMD/Intel) до последней версии\n';
                errorMessage += '2. Если используете шейдеры — отключите их и попробуйте запустить без них\n';
                errorMessage += '3. На ноутбуке: убедитесь, что Minecraft использует дискретную видеокарту, а не встроенную\n';
                errorMessage += '4. Попробуйте добавить в настройки JVM флаг: -Dorg.lwjgl.opengl.Display.allowSoftwareOpenGL=true';

            // 10. Общая ошибка — показываем наиболее информативные строки из лога
            } else {
                errorMessage = `❌ Minecraft завершился с ошибкой (код ${code})\n\n`;
                const lines = allOutput.split('\n');
                // Берём строки с ключевыми словами, фильтруем шум
                const keyLines = lines.filter(l => {
                    const ll = l.toLowerCase();
                    return (ll.includes('error') || ll.includes('exception') || ll.includes('fatal') || ll.includes('caused by')) &&
                           !ll.includes('log4j') && !ll.includes('warn') && l.trim().length > 10;
                }).slice(0, 5);
                if (keyLines.length > 0) {
                    errorMessage += 'Детали из лога:\n';
                    keyLines.forEach(l => {
                        errorMessage += '• ' + l.replace(/\[\d+:\d+:\d+\][^:]*: /g, '').trim().substring(0, 120) + '\n';
                    });
                    errorMessage += '\n';
                }
                errorMessage += 'Если проблема повторяется — откройте DevTools (главное меню → помощь) и скопируйте полный лог.';
            }

            hideProgress();
            resetPlayButton();
            showLauncherAlert(errorMessage);
        } else {
            console.log('Minecraft process ended normally');
        }
    });
    
    console.log('Minecraft process started with PID:', mcProcess.pid);

    // Даём 5 секунд на старт — если процесс ещё жив, скрываем лаунчер.
    // Ошибки запуска поймает mcProcess.on('exit') выше (код != 0).
    setTimeout(() => {
        if (mcProcess.exitCode !== null) {
            // Процесс уже завершился — on('exit') разберётся
            return;
        }
        console.log('Minecraft is running, hiding launcher. PID:', mcProcess.pid);
        hideProgress();
        // Отключаем процесс от родительского только после того, как IPC отправлен
        try {
            const { ipcRenderer: _ipc } = require('electron');
            // Discord RPC — ставим статус "В игре"
            const _playerNameForDiscord = document.getElementById('player-name')?.value || 'Player';
            const _selectedVerForDiscord = getSelectedVersion();
            const _verLabelForDiscord = _selectedVerForDiscord?.label || _selectedVerForDiscord?.id || 'Minecraft';
            _ipc.invoke('discord-set-playing', { playerName: _playerNameForDiscord, version: _verLabelForDiscord }).catch(() => {});
            _ipc.invoke('mc-launched', mcProcess.pid).then(() => {
                console.log('[PLAYTIME] mc-launched IPC sent OK');
                mcProcess.unref(); // unref только после успешной отправки IPC
            }).catch(e => {
                console.error('[PLAYTIME] mc-launched IPC error:', e);
                window.close();
            });
        } catch(e) {
            console.error('[PLAYTIME] require electron failed:', e);
            window.close();
        }
    }, 5000);
    } // end continueWithLaunch
} // end continueMinecraftLaunch

// Получение classpath для Minecraft
function getMinecraftClasspath(minecraftPath, withMods, versionOverride = null) {
    const version = versionOverride || (withMods ? '1.21.4-fabric' : '1.21.4');
    const versionsPath = path.join(minecraftPath, 'versions', version);
    const versionJsonPath = path.join(versionsPath, version + '.json');
    const libsPath = path.join(minecraftPath, 'libraries');
    
    let classpath = [];
    
    // Читаем version.json для получения списка библиотек
    if (fs.existsSync(versionJsonPath)) {
        try {
            const versionData = JSON.parse(fs.readFileSync(versionJsonPath, 'utf8'));
            
            // Добавляем все библиотеки в classpath
            if (versionData.libraries) {
                const osName = os.platform();
                versionData.libraries.forEach(lib => {
                    // Проверяем правила для библиотек (OS, architecture)
                    let shouldInclude = true;
                    if (lib.rules && lib.rules.length > 0) {
                        shouldInclude = false;
                        for (const rule of lib.rules) {
                            if (rule.action === 'allow') {
                                if (!rule.os || rule.os.name === osName) {
                                    shouldInclude = true;
                                    break;
                                }
                            } else if (rule.action === 'disallow') {
                                if (rule.os && rule.os.name === osName) {
                                    shouldInclude = false;
                                    break;
                                }
                            }
                        }
                    }
                    
                    if (shouldInclude) {
                        // Проверяем основной артефакт
                        if (lib.downloads?.artifact?.path) {
                            const libPath = path.join(libsPath, lib.downloads.artifact.path);
                            if (fs.existsSync(libPath)) {
                                classpath.push(libPath);
                            } else {
                                console.warn('Library not found:', libPath, 'for library:', lib.name);
                            }
                        }
                        
                        // Для Fabric версии также проверяем classifiers (например, natives)
                        // Но не добавляем их в classpath, так как они уже извлечены в natives
                    }
                });
            }
            
            // Для Fabric версии порядок важен: сначала библиотеки, потом клиентский jar
            // Но для Fabric Loader нужно добавить его перед клиентским jar
            if (withMods) {
                // Для Fabric версии добавляем клиентский jar в конце
                const clientJar = path.join(versionsPath, version + '.jar');
                if (fs.existsSync(clientJar)) {
                    classpath.push(clientJar);
                }
            } else {
                // Для обычной версии добавляем клиентский jar
                const clientJar = path.join(versionsPath, version + '.jar');
                if (fs.existsSync(clientJar)) {
                    classpath.push(clientJar);
                }
            }
        } catch (error) {
            console.error('Error reading version.json:', error);
            // Fallback на ��ростой путь
            const jarFile = path.join(versionsPath, version + '.jar');
            if (fs.existsSync(jarFile)) {
                classpath.push(jarFile);
            }
        }
    } else {
        // Fallback если version.json не найден
        const jarFile = path.join(versionsPath, version + '.jar');
        if (fs.existsSync(jarFile)) {
            classpath.push(jarFile);
        }
    }
    
    // Добавляем моды если есть
    if (withMods) {
        // Для Fabric версии порядок важен: сначала ASM, потом Fabric Loader, потом моды, потом клиентский jar
        // ВАЖНО: Удаляем старые версии ASM (9.6) из classpath, так как Fabric Loader требует версию 9.9
        // и не допускает дублирования ASM классов
        classpath = classpath.filter(jarPath => {
            // Исключаем стары�� версии ASM (9.6 и ниже)
            if (jarPath.includes('org/ow2/asm') || jarPath.includes('org\\ow2\\asm')) {
                // Проверяем версию в пути
                const versionMatch = jarPath.match(/asm[/\\](\d+)\.(\d+)/);
                if (versionMatch) {
                    const major = parseInt(versionMatch[1]);
                    const minor = parseInt(versionMatch[2]);
                    // Исключаем версии 9.6 и ниже, оставляем только 9.9 и выше
                    if (major < 9 || (major === 9 && minor < 9)) {
                        console.log('Excluding old ASM version from classpath:', jarPath);
                        return false;
                    }
                }
            }
            return true;
        });
        
        // Теперь добавляем ASM библиотеки версии 9.9 (Fabric Loader требует их)
        const asmLibsPath = path.join(minecraftPath, 'libraries', 'org', 'ow2', 'asm');
        if (fs.existsSync(asmLibsPath)) {
            const findJars = (dir) => {
                const jars = [];
                try {
                    const entries = fs.readdirSync(dir, { withFileTypes: true });
                    for (const entry of entries) {
                        const fullPath = path.join(dir, entry.name);
                        if (entry.isDirectory()) {
                            jars.push(...findJars(fullPath));
                        } else if (entry.isFile() && entry.name.endsWith('.jar')) {
                            jars.push(fullPath);
                        }
                    }
                } catch (e) {
                    console.warn('Error reading directory:', dir, e);
                }
                return jars;
            };
            
            const asmJars = findJars(asmLibsPath);
            asmJars.forEach(jar => {
                // Добавляем только версии 9.9 и выше
                const versionMatch = jar.match(/asm[/\\](\d+)\.(\d+)/);
                if (versionMatch) {
                    const major = parseInt(versionMatch[1]);
                    const minor = parseInt(versionMatch[2]);
                    if (major > 9 || (major === 9 && minor >= 9)) {
                        if (!classpath.includes(jar)) {
                            classpath.push(jar);
                            console.log('Added ASM library to classpath:', jar);
                        }
                    } else {
                        console.log('Skipping old ASM version:', jar);
                    }
                } else if (!classpath.includes(jar)) {
                    // Если не можем определить версию, добавляем на всякий случай
                    classpath.push(jar);
                    console.log('Added ASM library to classpath (version unknown):', jar);
                }
            });
        }
        
        // Затем добавляем Fabric Loader библиотеки
        const fabricLibsPath = path.join(minecraftPath, 'libraries', 'net', 'fabricmc');
        if (fs.existsSync(fabricLibsPath)) {
            const findJars = (dir) => {
                const jars = [];
                try {
                    const entries = fs.readdirSync(dir, { withFileTypes: true });
                    for (const entry of entries) {
                        const fullPath = path.join(dir, entry.name);
                        if (entry.isDirectory()) {
                            jars.push(...findJars(fullPath));
                        } else if (entry.isFile() && entry.name.endsWith('.jar')) {
                            jars.push(fullPath);
                        }
                    }
                } catch (e) {
                    console.warn('Error reading directory:', dir, e);
                }
                return jars;
            };
            
            const fabricJars = findJars(fabricLibsPath);
            fabricJars.forEach(jar => {
                if (!classpath.includes(jar)) {
                    classpath.push(jar);
                    console.log('Added Fabric library to classpath:', jar);
                }
            });
        }
        
        // Затем добавляем моды
        const modsPath = path.join(minecraftPath, 'mods');
        if (fs.existsSync(modsPath)) {
            const mods = fs.readdirSync(modsPath).filter(f => f.endsWith('.jar'));
            mods.forEach(mod => {
                classpath.push(path.join(modsPath, mod));
            });
        }
    }
    
    const classpathString = classpath.join(path.delimiter);
    console.log('Classpath contains', classpath.length, 'entries');
    
    return classpathString;
}

// Генерация UUID для игрока
// Генерация offline UUID на основе имени игрока (как в T-launcher)
// Это важно для полной версии без демо-режима
function generateOfflineUUID(username) {
    // Используем crypto для генерации UUID на основе имени
    const crypto = require('crypto');
    const hash = crypto.createHash('md5').update('OfflinePlayer:' + username).digest();
    
    // Форматируем как UUID v3
    const uuid = [
        hash.toString('hex', 0, 4),
        hash.toString('hex', 4, 6),
        ((parseInt(hash.toString('hex', 6, 8), 16) & 0x0fff) | 0x3000).toString(16),
        ((parseInt(hash.toString('hex', 8, 10), 16) & 0x3fff) | 0x8000).toString(16),
        hash.toString('hex', 10, 16)
    ].join('-');
    
    return uuid;
}

function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

/** Включает кнопку «ИГРАТЬ» (вызывать при ошибке запуска) */
function resetPlayButton() {
    const playButton = document.getElementById('play-button');
    if (playButton) {
        playButton.disabled = false;
        playButton.textContent = 'ИГРАТЬ';
    }
}

// Инициализация кнопки запуска
function initPlayButton() {
    const playButton = document.getElementById('play-button');
    if (playButton) {
        playButton.addEventListener('click', () => {
            const playerNameInput = document.getElementById('player-name');
            const username = playerNameInput ? playerNameInput.value : '';
            saveCredentials(username);
            playButton.disabled = true;
            playButton.textContent = 'ЗАПУСК...';
            try {
                launchMinecraft();
            } catch (error) {
                console.error('Error launching Minecraft:', error);
                showLauncherAlert('Ошибка при запуске Minecraft: ' + error.message);
                resetPlayButton();
            }
        });
    }
}

// Инициализация при загрузке
// Инициализация переключателя тем
function initThemeSwitcher() {
    const themeCircles = document.querySelectorAll('.theme-circle');
    const html = document.documentElement;
    
    // Загружаем сохранённую тему из localStorage
    const savedTheme = localStorage.getItem('launcher-theme') || 'blue';
    html.setAttribute('data-theme', savedTheme);
    
    // Устанавливаем активный кружок
    themeCircles.forEach(circle => {
        if (circle.getAttribute('data-theme') === savedTheme) {
            circle.classList.add('active');
        }
    });
    
    // Обработчик клика на кружки
    themeCircles.forEach(circle => {
        circle.addEventListener('click', () => {
            const theme = circle.getAttribute('data-theme');
            
            // Убираем активный класс со всех кружков
            themeCircles.forEach(c => c.classList.remove('active'));
            
            // Добавляем активный класс к выбранному кружку
            circle.classList.add('active');
            
            // Применяем тему плавно (включая сохранение в localStorage)
            applyThemeSmooth(theme);
            console.log('Theme changed to:', theme);
        });
    });
}

function initWindowControls() {
    const { ipcRenderer } = require('electron');
    const btnMinimize = document.getElementById('btn-minimize');
    const btnMaximize = document.getElementById('btn-maximize');
    const btnClose = document.getElementById('btn-close');
    if (btnMinimize) {
        btnMinimize.addEventListener('click', () => ipcRenderer.invoke('minimize-window'));
    }
    if (btnMaximize) {
        btnMaximize.addEventListener('click', () => ipcRenderer.invoke('maximize-window'));
    }
    if (btnClose) {
        btnClose.addEventListener('click', () => window.close());
    }
    ipcRenderer.on('window-maximized', () => document.body.classList.add('window-maximized'));
    ipcRenderer.on('window-unmaximized', () => document.body.classList.remove('window-maximized'));
}

// ═══════════════════════════════════════════════════
// JVM FLAGS MODAL
// ═══════════════════════════════════════════════════
function initJvmModal() {
    // Список доступных JVM флагов с описанием
    const jvmFlags = [
        {
            id: 'g1gc',
            name: '-XX:+UseG1GC',
            description: 'Использовать Garbage Collector G1 (рекомендуется для Minecraft)',
            details: 'G1GC — это современный сборщик мусора, оптимизированный для больших объёмов памяти. Обеспечивает лучшую производительность и меньшие задержки по сравнению с стандартным GC. Рекомендуется для Minecraft с модами.'
        },
        {
            id: 'parallel-gc',
            name: '-XX:+UseParallelGC',
            description: 'Использовать Parallel Garbage Collector',
            details: 'ParallelGC использует многопоточную сборку мусора. Может быть производительнее на системах с несколькими ядрами CPU, но иногда вызывает микро-фризы.'
        },
        {
            id: 'serial-gc',
            name: '-XX:+UseSerialGC',
            description: 'Использовать последовательный Garbage Collector',
            details: 'SerialGC — простой однопоточный сборщик мусора. Подходит только для очень слабых систем с 1-2 ядрами CPU. Не рекомендуется для современных сборок.'
        },
        {
            id: 'zgc',
            name: '-XX:+UseZGC',
            description: 'Использовать Z Garbage Collector (низкие задержки)',
            details: 'ZGC — экспериментальный сборщик мусора с минимальными задержками (<10ms). Требует Java 11+. Может быть нестабилен на некоторых системах.'
        },
        {
            id: 'string-dedup',
            name: '-XX:+UseStringDeduplication',
            description: 'Включить дедупликацию строк (экономия памяти)',
            details: 'Эта опция уменьшает использование памяти за счёт объединения одинаковых строк в памяти. Работает только с G1GC. Может сэконом��ть 5-15% памяти.'
        },
        {
            id: 'tiered',
            name: '-XX:+TieredCompilation',
            description: 'Включить многоуровневую компиляцию',
            details: 'TieredCompilation использует как интерпретатор, так и JIT-компилятор для оптимизации кода во время выполнения. Улучшает производительность на 10-20%.'
        },
        {
            id: 'large-pages',
            name: '-XX:+UseLargePages',
            description: 'Использовать большие страницы памяти',
            details: 'Использование больших страниц памяти может улучшить производительность за счёт уменьшения количества страниц в таблице страниц. Требует настройки ОС.'
        },
        {
            id: 'disable-explicit-gc',
            name: '-XX:-DisableExplicitGC',
            description: 'Запретить вызов System.gc() (рекомендуется)',
            details: 'Minecraft часто вызывает System.gc(), что вызывает ненужные полные сборки мусора и фризы. Эта опция запрещает такие вызовы.'
        },
        {
            id: 'compile-threshold',
            name: '-XX:CompileThreshold=1000',
            description: 'Порог компиляции методов (1000 вызовов)',
            details: 'Определяет, сколько раз метод должен быть вызван перед его JIT-компиляцией. Меньшее значение ускоряет оптимизацию, но увеличивает время запуска.'
        },
        {
            id: 'inline',
            name: '-XX:+AggressiveOpts',
            description: 'Включить агрессивные оптимизации',
            details: 'AggressiveOpts включает экспериментальные оптимизации JIT-компилятора. Может улучшить производительность, но требует тестирования.'
        }
    ];

    // Кнопка открытия модального окна
    const jvmArgsBtn = document.getElementById('jvm-args-btn');
    const jvmModalOverlay = document.getElementById('jvm-modal-overlay');
    const jvmModalClose = document.getElementById('jvm-modal-close');
    const jvmModalCancel = document.getElementById('jvm-modal-cancel');
    const jvmModalSave = document.getElementById('jvm-modal-save');
    const jvmFlagsList = document.getElementById('jvm-flags-list');
    const jvmCustomArgsInput = document.getElementById('jvm-custom-args-input');

    if (!jvmArgsBtn || !jvmModalOverlay) {
        return;
    }

    // Загрузка сохранённых флагов
    function loadSavedFlags() {
        const savedFlags = localStorage.getItem('jvm-selected-flags');
        const savedCustom = localStorage.getItem('jvm-custom-args');
        return {
            flags: savedFlags ? JSON.parse(savedFlags) : [],
            custom: savedCustom || ''
        };
    }

    // Сохранение флагов
    function saveFlags(selectedFlags, customArgs) {
        localStorage.setItem('jvm-selected-flags', JSON.stringify(selectedFlags));
        localStorage.setItem('jvm-custom-args', customArgs);
    }

    // Рендеринг списка флагов
    function renderFlags(savedFlags) {
        if (!jvmFlagsList) return;

        jvmFlagsList.innerHTML = '';

        jvmFlags.forEach(flag => {
            const isSelected = savedFlags.includes(flag.id);

            const item = document.createElement('div');
            item.className = 'jvm-flag-item' + (isSelected ? ' is-selected' : '');
            item.dataset.flagId = flag.id;

            item.innerHTML = `
                <label class="jvm-flag-checkbox">
                    <input type="checkbox" ${isSelected ? 'checked' : ''} data-flag-id="${flag.id}">
                    <span class="jvm-flag-check"></span>
                </label>
                <div class="jvm-flag-content">
                    <div class="jvm-flag-name">${flag.name}</div>
                    <div class="jvm-flag-desc">${flag.description}</div>
                    <button type="button" class="jvm-flag-info-btn" data-flag-id="${flag.id}" title="Подробное описание">i</button>
                    <div class="jvm-flag-details" id="details-${flag.id}">
                        <div class="jvm-flag-details-title">Подробное описание:</div>
                        <div class="jvm-flag-details-text">${flag.details}</div>
                    </div>
                </div>
            `;

            jvmFlagsList.appendChild(item);
        });

        // Обработчики для чекбоксов
        jvmFlagsList.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
            checkbox.addEventListener('change', (e) => {
                const flagId = e.target.dataset.flagId;
                const item = e.target.closest('.jvm-flag-item');
                if (e.target.checked) {
                    item.classList.add('is-selected');
                } else {
                    item.classList.remove('is-selected');
                }
            });
        });

        // Обработчики для кнопок "i"
        jvmFlagsList.querySelectorAll('.jvm-flag-info-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const flagId = btn.dataset.flagId;
                const details = document.getElementById(`details-${flagId}`);
                if (details) {
                    details.classList.toggle('is-visible');
                }
            });
        });

        // Клик по элементу тоже переключает чекбокс
        jvmFlagsList.querySelectorAll('.jvm-flag-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.classList.contains('jvm-flag-info-btn')) {
                    return;
                }
                const checkbox = item.querySelector('input[type="checkbox"]');
                if (checkbox && e.target !== checkbox) {
                    checkbox.checked = !checkbox.checked;
                    checkbox.dispatchEvent(new Event('change'));
                }
            });
        });
    }

    // Открытие модального окна
    jvmArgsBtn.addEventListener('click', () => {
        const { flags, custom } = loadSavedFlags();
        renderFlags(flags);
        if (jvmCustomArgsInput) {
            jvmCustomArgsInput.value = custom;
        }
        jvmModalOverlay.style.display = 'flex';
        jvmModalOverlay.setAttribute('aria-hidden', 'false');
        jvmArgsBtn.setAttribute('aria-expanded', 'true');
    });

    // Закрытие модального окна
    function closeJvmModal() {
        jvmModalOverlay.style.display = 'none';
        jvmModalOverlay.setAttribute('aria-hidden', 'true');
        jvmArgsBtn.setAttribute('aria-expanded', 'false');
    }

    if (jvmModalClose) {
        jvmModalClose.addEventListener('click', closeJvmModal);
    }

    if (jvmModalCancel) {
        jvmModalCancel.addEventListener('click', closeJvmModal);
    }

    // Закрытие по клику вне окна
    jvmModalOverlay.addEventListener('click', (e) => {
        if (e.target === jvmModalOverlay) {
            closeJvmModal();
        }
    });

    // Сохранение флагов
    if (jvmModalSave) {
        jvmModalSave.addEventListener('click', () => {
            const selectedFlags = [];
            jvmFlagsList.querySelectorAll('input[type="checkbox"]:checked').forEach(checkbox => {
                selectedFlags.push(checkbox.dataset.flagId);
            });

            const customArgs = jvmCustomArgsInput ? jvmCustomArgsInput.value.trim() : '';

            saveFlags(selectedFlags, customArgs);
            closeJvmModal();
            showLauncherAlert('Флаги запуска сохранены!', 'Готово');
        });
    }

    // Закрытие по Escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && jvmModalOverlay.style.display === 'flex') {
            closeJvmModal();
        }
    });
}

// ─── SPLASH helpers ───────────────────────────────────────────────────────
function splashSet(pct, text) {
    const bar = document.getElementById('splash-bar');
    const status = document.getElementById('splash-status');
    if (bar) bar.style.width = pct + '%';
    if (status) status.textContent = text;
}
function splashHide() {
    const el = document.getElementById('splash-screen');
    if (el) el.classList.add('splash-hidden');
}
// ──────────────────────────────────────────────────────────────────────────

function initPowerFeatures () {
    const profileSelect = document.getElementById('game-profile-select');
    const applyProfileBtn = document.getElementById('apply-profile-btn');
    const quickFixBtn = document.getElementById('quick-fix-btn');
    const detectConflictsBtn = document.getElementById('detect-conflicts-btn');
    const analyzeCrashBtn = document.getElementById('analyze-crash-btn');
    const turboToggle = document.getElementById('turbo-mode-toggle');

    if (turboToggle) {
        turboToggle.checked = localStorage.getItem('launcher-turbo-mode') === '1';
        turboToggle.addEventListener('change', () => {
            localStorage.setItem('launcher-turbo-mode', turboToggle.checked ? '1' : '0');
            showToast(turboToggle.checked ? 'Турбо-режим включён' : 'Турбо-режим выключен', 'info');
        });
    }

<<<<<<< HEAD
    // ── Profile modal ──
    const PROFILES = [
        { value: 'pvp',    label: 'PvP (сбаланс.)',  desc: 'Оптимальный баланс производительности для PvP' },
        { value: 'lowend', label: 'Low-end PC',       desc: 'Минимум ресурсов, максимум стабильности' },
        { value: 'shaders',label: 'Shaders',          desc: 'Настройки для работы с шейдерами' },
        { value: 'stream', label: 'Stream',           desc: 'Оптимизация для стриминга' },
    ];
    let selectedProfileValue = profileSelect ? profileSelect.value : 'pvp';

    const profileModalOverlay = document.getElementById('profile-modal-overlay');
    const profileModalClose   = document.getElementById('profile-modal-close');
    const profileModalCancel  = document.getElementById('profile-modal-cancel');
    const profileModalSave    = document.getElementById('profile-modal-save');
    const profileOptionsList  = document.getElementById('profile-options-list');
    const profileSelectBtn    = document.getElementById('game-profile-select-btn');
    const profileLabel        = document.getElementById('game-profile-label');

    function openProfileModal () {
        if (!profileModalOverlay) return;
        selectedProfileValue = profileSelect ? profileSelect.value : 'pvp';
        if (profileOptionsList) {
            profileOptionsList.innerHTML = '';
            PROFILES.forEach(p => {
                const item = document.createElement('div');
                item.className = 'jvm-flag-item';
                item.style.cssText = 'display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:10px;cursor:pointer;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.04);transition:all 0.2s;';
                item.innerHTML = `<input type="radio" name="profile-option" value="${p.value}" style="accent-color:var(--accent-primary,#3b82f6);width:16px;height:16px;" ${selectedProfileValue===p.value?'checked':''}><div><div style="font-weight:600;font-size:13px;color:#f1f5f9;">${p.label}</div><div style="font-size:11px;color:rgba(255,255,255,0.5);margin-top:2px;">${p.desc}</div></div>`;
                item.addEventListener('click', () => {
                    item.querySelector('input').checked = true;
                    selectedProfileValue = p.value;
                    profileOptionsList.querySelectorAll('.jvm-flag-item').forEach(el => el.style.borderColor = 'rgba(255,255,255,0.08)');
                    item.style.borderColor = 'var(--accent-primary,#3b82f6)';
                });
                if (selectedProfileValue === p.value) item.style.borderColor = 'var(--accent-primary,#3b82f6)';
                profileOptionsList.appendChild(item);
            });
        }
        profileModalOverlay.style.display = 'flex';
    }

    function closeProfileModal () {
        if (profileModalOverlay) profileModalOverlay.style.display = 'none';
    }

    if (profileSelectBtn) profileSelectBtn.addEventListener('click', openProfileModal);
    if (profileModalClose) profileModalClose.addEventListener('click', closeProfileModal);
    if (profileModalCancel) profileModalCancel.addEventListener('click', closeProfileModal);
    if (profileModalOverlay) profileModalOverlay.addEventListener('click', e => { if (e.target === profileModalOverlay) closeProfileModal(); });

    if (profileModalSave) {
        profileModalSave.addEventListener('click', () => {
            const selected = profileOptionsList ? profileOptionsList.querySelector('input[name="profile-option"]:checked') : null;
            const val = selected ? selected.value : selectedProfileValue;
            if (profileSelect) profileSelect.value = val;
            const found = PROFILES.find(p => p.value === val);
            if (profileLabel && found) profileLabel.textContent = found.label;
            closeProfileModal();
            // Apply preset
            const preset = getProfilePreset(val);
            if (preset) {
                localStorage.setItem('minecraft-ram', preset.ram);
                localStorage.setItem('jvm-selected-flags', JSON.stringify(preset.jvmFlags));
                const ramSlider = document.getElementById('ram-slider');
                const ramValue  = document.getElementById('ram-value');
                if (ramSlider) ramSlider.value = preset.ram;
                if (ramValue)  ramValue.textContent = preset.ram;
                showToast(`Профиль «${preset.name}» применён`, 'success');
            }
        });
    }

=======
>>>>>>> f7d31353fa62e5c18778e8d4edb7c4d62bee9f02
    if (applyProfileBtn && profileSelect) {
        applyProfileBtn.addEventListener('click', () => {
            const preset = getProfilePreset(profileSelect.value);
            localStorage.setItem('minecraft-ram', preset.ram);
            localStorage.setItem('jvm-selected-flags', JSON.stringify(preset.jvmFlags));
            const ramSlider = document.getElementById('ram-slider');
            const ramValue = document.getElementById('ram-value');
            if (ramSlider) ramSlider.value = preset.ram;
            if (ramValue) ramValue.textContent = preset.ram;
            showLauncherAlert(`Профиль ${preset.name} применён. RAM: ${preset.ram} GB`);
        });
    }

    if (quickFixBtn) {
        quickFixBtn.addEventListener('click', () => {
            try {
                const versionId = localStorage.getItem(VERSION_STORAGE_KEY) || DEFAULT_VERSION_ID;
                const dataPath = getDataPathForVersion(versionId);
                const dirs = ['mods', 'resourcepacks', 'shaderpacks', 'logs', 'crash-reports'];
                dirs.forEach((dir) => {
                    const full = path.join(dataPath, dir);
                    if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true });
                });

                const modsPath = path.join(dataPath, 'mods');
                let removed = 0;
                if (fs.existsSync(modsPath)) {
                    fs.readdirSync(modsPath).forEach((file) => {
                        const fp = path.join(modsPath, file);
                        if (file.endsWith('.jar') && fs.statSync(fp).size === 0) {
                            fs.unlinkSync(fp);
                            removed += 1;
                        }
                    });
                }

<<<<<<< HEAD
                showLauncherAlert(
                    `✅ Быстрая починка завершена!

` +
                    `🔧 Что было сделано:
` +
                    `• Проверены и созданы папки игры (mods, resourcepacks, shaderpacks, logs, crash-reports)
` +
                    `• Удалены пустые (повреждённые) .jar файлы из папки модов
` +
                    `• Восстановлена структура директорий профиля

` +
                    `📋 Результат:
` +
                    `— Проверено папок: ${dirs.length}
` +
                    `— Удалено битых .jar: ${removed}`,
                    'Починить всё'
                );
=======
                showLauncherAlert(`Быстрая починка завершена.
Создано/проверено папок: ${dirs.length}
Удалено битых .jar: ${removed}`);
>>>>>>> f7d31353fa62e5c18778e8d4edb7c4d62bee9f02
            } catch (e) {
                showLauncherAlert('Ошибка быстрой починки: ' + e.message);
            }
        });
    }

    if (detectConflictsBtn) {
        detectConflictsBtn.addEventListener('click', () => {
            try {
                const versionId = localStorage.getItem(VERSION_STORAGE_KEY) || DEFAULT_VERSION_ID;
                const modsPath = getModsPathForVersion(versionId);
                if (!fs.existsSync(modsPath)) {
                    showLauncherAlert('Папка модов не найдена.');
                    return;
                }
                const files = fs.readdirSync(modsPath).filter((f) => f.toLowerCase().endsWith('.jar'));
                const conflicts = detectModConflicts(files);
                if (!conflicts.length) {
                    showLauncherAlert('Явных конфликтов модов не найдено ✅');
                } else {
<<<<<<< HEAD
                    const conflictText = conflicts.map(c => `• ${c.message || c.pair}`).join('\n');
                    showLauncherAlert('Найдены потенциальные конфликты:\n' + conflictText, 'Конфликты модов');
=======
                    showLauncherAlert('Найдены потенциальные конфликты\n- ' + conflicts.join('\n- '), 'Конфликты модов');
>>>>>>> f7d31353fa62e5c18778e8d4edb7c4d62bee9f02
                }
            } catch (e) {
                showLauncherAlert('Ошибка проверки модов: ' + e.message);
            }
        });
    }

    if (analyzeCrashBtn) {
        analyzeCrashBtn.addEventListener('click', () => {
            try {
                const versionId = localStorage.getItem(VERSION_STORAGE_KEY) || DEFAULT_VERSION_ID;
                const dataPath = getDataPathForVersion(versionId);
                const crashDir = path.join(dataPath, 'crash-reports');
                const candidates = [];
                if (fs.existsSync(crashDir)) {
                    fs.readdirSync(crashDir)
                        .filter((f) => f.endsWith('.txt'))
                        .forEach((f) => candidates.push(path.join(crashDir, f)));
                }
                if (!candidates.length) {
                    showLauncherAlert('Краш-логи не найдены.');
                    return;
                }
                candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
                const latest = candidates[0];
                const text = fs.readFileSync(latest, 'utf8');
                const message = analyzeCrashText(text);
                showLauncherAlert(`Файл: ${path.basename(latest)}

${message}`, 'Анализ краша');
            } catch (e) {
                showLauncherAlert('Ошибка анализа краша: ' + e.message);
            }
        });
    }
}

function initSupportTools () {
    const diagnosticsBtn = document.getElementById('run-diagnostics-btn');
    const exportBtn = document.getElementById('export-logs-btn');
    const statusEl = document.getElementById('diagnostics-status');

    if (diagnosticsBtn) {
        diagnosticsBtn.addEventListener('click', async () => {
            diagnosticsBtn.disabled = true;
            if (statusEl) statusEl.textContent = 'Выполняется диагностика...';
            try {
                const { ipcRenderer } = require('electron');
                const result = await ipcRenderer.invoke('run-diagnostics');
                const report = formatDiagnosticsReport(result);
                if (statusEl) statusEl.textContent = 'Диагностика завершена';
                showLauncherAlert(report, 'Отчёт диагностики');
            } catch (e) {
                if (statusEl) statusEl.textContent = 'Ошибка диагностики';
                showLauncherAlert('Диагностика завершилась ошибкой: ' + e.message);
            } finally {
                diagnosticsBtn.disabled = false;
            }
        });
    }

    if (exportBtn) {
        exportBtn.addEventListener('click', async () => {
            exportBtn.disabled = true;
            try {
                const { ipcRenderer } = require('electron');
                const filePath = await ipcRenderer.invoke('export-debug-log');
                if (filePath) {
                    if (statusEl) statusEl.textContent = 'Лог экспортирован: ' + filePath;
                    showToast('Лог экспортирован', 'success');
                }
            } catch (e) {
                showToast('Не удалось экспортировать лог', 'error');
            } finally {
                exportBtn.disabled = false;
            }
        });
    }
}

async function init() {
    try {
        splashSet(10, 'Инициализация интерфейса...');
        console.log('[INIT] step: windowControls');
        initWindowControls();
        console.log('[INIT] step: themeSwitcher');
        initThemeSwitcher();
        console.log('[INIT] step: tabs');
        initTabs();
        console.log('[INIT] step: ramSlider');
        initRamSlider();
        console.log('[INIT] step: browseButton');
        initBrowseButton();
        console.log('[INIT] step: saveButton');
        initSaveButton();
        console.log('[INIT] step: supportTools');
        initSupportTools();
        console.log('[INIT] step: powerFeatures');
        initPowerFeatures();
        console.log('[INIT] step: links');
        initLinks();
        console.log('[INIT] step: playerName');
        initPlayerName();
        console.log('[INIT] step: playButton');
        initPlayButton();
        console.log('[INIT] step: versionSelector');
        initVersionSelector();
        console.log('[INIT] step: newsLinks');
        initNewsLinks();
        console.log('[INIT] step: newsScrollbar');
        initNewsScrollbar();
        console.log('[INIT] step: jvmModal');
        initJvmModal();

        splashSet(30, 'Загрузка настроек...');
        console.log('[INIT] step: loadSettings');
        loadSettings();
        await new Promise(r => setTimeout(r, 0));

        const turboMode = localStorage.getItem('launcher-turbo-mode') === '1';
        splashSet(50, turboMode ? 'Турбо-режим: минимум блокирующих задач...' : 'Загрузка новостей...');
        console.log('[INIT] step: loadNews (background)');
        if (turboMode) {
            setTimeout(() => loadNews(), 1200);
        } else {
            loadNews();
        }
        await new Promise(r => setTimeout(r, 0));

        splashSet(75, turboMode ? 'Турбо-режим: отложенная загрузка модов...' : 'Загрузка модов...');
        console.log('[INIT] step: loadModsPanel');
        if (turboMode) {
            setTimeout(() => loadModsPanel(), 1800);
        } else {
            loadModsPanel();
        }
        await new Promise(r => setTimeout(r, 0));

        splashSet(100, 'Готово!');
        await new Promise(r => setTimeout(r, 250));
        splashHide();

        console.log('[INIT] Launcher initialized successfully');
    } catch (error) {
        console.error('[INIT] Error:', error);
        splashHide();
        showLauncherAlert('Ошибка при инициализации лаунчера: ' + error.message);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

// ══════════════════════════════════════════════════════════
// SHARE POPUP — показываем после 7 дней использования
// ══════════════════════════════════════════════════════════

function initSharePopup() {
    try {
        const FIRST_LAUNCH_KEY = 'fixlauncher-first-launch';
        const SHARE_SHOWN_KEY = 'fixlauncher-share-shown';
        const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

        // Запоминаем первый запуск
        if (!localStorage.getItem(FIRST_LAUNCH_KEY)) {
            localStorage.setItem(FIRST_LAUNCH_KEY, String(Date.now()));
        }

        // Уже показывали — не показываем снова
        if (localStorage.getItem(SHARE_SHOWN_KEY)) return;

        const firstLaunch = parseInt(localStorage.getItem(FIRST_LAUNCH_KEY), 10);
        const elapsed = Date.now() - firstLaunch;

        if (elapsed < SEVEN_DAYS_MS) {
            // Проверим позже
            const remaining = SEVEN_DAYS_MS - elapsed;
            setTimeout(showSharePopup, Math.min(remaining, 2147483647));
            return;
        }

        // 7 дней прошло — показываем с небольшой задержкой после загрузки
        setTimeout(showSharePopup, 3000);
    } catch(e) {}
}

// ══════════════════════════════════════════════════════════
// Генерация invite-картинки через Canvas
// ══════════════════════════════════════════════════════════
async function generateShareImage(playerName, playtimeStr) {
    // 2x pixel ratio — чёткое изображение
    const W = 900, H = 500, S = 2;
    const canvas = document.createElement('canvas');
    canvas.width = W * S; canvas.height = H * S;
    const ctx = canvas.getContext('2d');
    ctx.scale(S, S);

    function rr(x, y, w, h, r) {
        if (typeof r === 'number') r = [r,r,r,r];
        const [tl,tr,br,bl] = r;
        ctx.beginPath();
        ctx.moveTo(x+tl, y);
        ctx.lineTo(x+w-tr, y); ctx.quadraticCurveTo(x+w, y, x+w, y+tr);
        ctx.lineTo(x+w, y+h-br); ctx.quadraticCurveTo(x+w, y+h, x+w-br, y+h);
        ctx.lineTo(x+bl, y+h); ctx.quadraticCurveTo(x, y+h, x, y+h-bl);
        ctx.lineTo(x, y+tl); ctx.quadraticCurveTo(x, y, x+tl, y);
        ctx.closePath();
    }

    // === ФОН ===
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#080f1c');
    bg.addColorStop(0.45, '#0b1e3a');
    bg.addColorStop(1, '#060e1a');
    ctx.fillStyle = bg;
    rr(0, 0, W, H, 0); ctx.fill();

    // Глоу слева (синий)
    const g1 = ctx.createRadialGradient(160, 200, 0, 160, 200, 260);
    g1.addColorStop(0, 'rgba(55,120,255,0.22)'); g1.addColorStop(1, 'rgba(55,120,255,0)');
    ctx.fillStyle = g1; ctx.beginPath(); ctx.arc(160, 200, 260, 0, Math.PI*2); ctx.fill();

    // Глоу справа (фиолетовый)
    const g2 = ctx.createRadialGradient(760, 300, 0, 760, 300, 230);
    g2.addColorStop(0, 'rgba(110,60,255,0.16)'); g2.addColorStop(1, 'rgba(110,60,255,0)');
    ctx.fillStyle = g2; ctx.beginPath(); ctx.arc(760, 300, 230, 0, Math.PI*2); ctx.fill();

    // Сетка точек
    ctx.fillStyle = 'rgba(255,255,255,0.032)';
    for (let x = 25; x < W; x += 38) for (let y = 25; y < H; y += 38) {
        ctx.beginPath(); ctx.arc(x, y, 1.2, 0, Math.PI*2); ctx.fill();
    }

    // === ПОЛОСКА СЛЕВА ===
    const stripeG = ctx.createLinearGradient(0, 0, 0, H);
    stripeG.addColorStop(0, '#3b82f6'); stripeG.addColorStop(1, '#7c3aed');
    ctx.fillStyle = stripeG; rr(0, 0, 7, H, 0); ctx.fill();

    // === ЛОГОТИП ===
    const LS = 112, LX = 44, LY = H/2 - LS/2;
    try {
        const logoImg = await new Promise((res, rej) => {
            const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = 'logo.png';
        });
        ctx.save();
        ctx.shadowColor = 'rgba(59,130,246,0.7)'; ctx.shadowBlur = 28;
        const logoG = ctx.createLinearGradient(LX, LY, LX+LS, LY+LS);
        logoG.addColorStop(0, '#1d4ed8'); logoG.addColorStop(1, '#4f46e5');
        ctx.fillStyle = logoG; rr(LX, LY, LS, LS, 22); ctx.fill();
        ctx.restore();
        ctx.save(); rr(LX, LY, LS, LS, 22); ctx.clip();
        ctx.drawImage(logoImg, LX, LY, LS, LS);
        ctx.restore();
    } catch(e) {}

    // === ТЕКСТ ===
    const TX = 185;

    // Бренд
    ctx.save();
    ctx.font = '700 13px "Segoe UI",Arial,sans-serif';
    ctx.fillStyle = 'rgba(96,165,250,0.85)';
    ctx.letterSpacing = '5px';
    ctx.fillText('FIXLAUNCHER', TX, 104);
    ctx.restore();

    // Заголовок
    ctx.save();
    ctx.font = '700 48px "Segoe UI",Arial,sans-serif';
    ctx.shadowColor = 'rgba(59,130,246,0.45)'; ctx.shadowBlur = 16;
    const hg = ctx.createLinearGradient(TX, 115, TX+580, 165);
    hg.addColorStop(0, '#ffffff'); hg.addColorStop(1, '#93c5fd');
    ctx.fillStyle = hg;
    ctx.fillText('Присоединяйся к нам!', TX, 162);
    ctx.restore();

    // Подзаголовок
    ctx.save();
    ctx.font = '400 19px "Segoe UI",Arial,sans-serif';
    ctx.fillStyle = 'rgba(186,220,255,0.8)';
    ctx.fillText('Лучший Minecraft лаунчер с модами и удобным управлением', TX, 200);
    ctx.restore();

    // Разделитель
    const dg = ctx.createLinearGradient(TX, 0, TX+520, 0);
    dg.addColorStop(0, 'rgba(59,130,246,0.75)'); dg.addColorStop(1, 'rgba(59,130,246,0)');
    ctx.fillStyle = dg; ctx.fillRect(TX, 218, 520, 1.5);

    // === КАРТОЧКА ИГРОКА ===
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.065)';
    rr(TX, 234, 494, 106, 16); ctx.fill();
    ctx.strokeStyle = 'rgba(59,130,246,0.32)'; ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();

    // Аватар
    const AS = 62, AX = TX+16, AY = 252;
    const ag = ctx.createLinearGradient(AX, AY, AX+AS, AY+AS);
    ag.addColorStop(0, '#3730a3'); ag.addColorStop(1, '#7c3aed');
    ctx.fillStyle = ag; rr(AX, AY, AS, AS, 12); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = '700 27px "Segoe UI",Arial,sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText((playerName||'И')[0].toUpperCase(), AX+AS/2, AY+AS/2+10);
    ctx.textAlign = 'left';

    // Ник
    ctx.font = '700 22px "Segoe UI",Arial,sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(playerName||'Игрок', TX+92, 278);

    ctx.font = '400 15px "Segoe UI",Arial,sans-serif';
    ctx.fillStyle = 'rgba(148,197,255,0.85)';
    ctx.fillText('⏱ Игровое время: ' + playtimeStr, TX+92, 302);

    ctx.fillStyle = 'rgba(74,222,128,0.9)';
    ctx.font = '700 13px "Segoe UI",Arial,sans-serif';
    ctx.fillText('● Онлайн', TX+92, 328);

    // === ФИЧИ ===
    const feats = ['⚡ Быстрый запуск', '🎮 Готовые сборки', '🔧 Авто-обновления'];
    let fx = TX;
    feats.forEach(f => {
        ctx.save();
        ctx.font = '400 14px "Segoe UI",Arial,sans-serif';
        const fw = ctx.measureText(f).width + 26;
        ctx.fillStyle = 'rgba(255,255,255,0.075)';
        rr(fx, 360, fw, 32, 9); ctx.fill();
        ctx.strokeStyle = 'rgba(59,130,246,0.28)'; ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = 'rgba(196,228,255,0.9)';
        ctx.fillText(f, fx+13, 381);
        ctx.restore();
        fx += fw + 10;
    });

    // === КНОПКА-ССЫЛКА ===
    ctx.save();
    const lb = ctx.createLinearGradient(TX, 408, TX+340, 448);
    lb.addColorStop(0, 'rgba(29,78,216,0.9)'); lb.addColorStop(1, 'rgba(79,70,229,0.9)');
    ctx.fillStyle = lb; rr(TX, 408, 345, 40, 11); ctx.fill();
    ctx.shadowColor = 'rgba(59,130,246,0.55)'; ctx.shadowBlur = 14;
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 14px "Segoe UI",Arial,sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('🔗 github.com/fixsirt/FixLauncher/releases', TX+172, 433);
    ctx.restore();

    // Копирайт
    ctx.save();
    ctx.font = '400 11px "Segoe UI",Arial,sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.textAlign = 'right';
    ctx.fillText('fixlauncher', W-22, H-14);
    ctx.restore();

    return canvas.toDataURL('image/png');
}

function roundRect(ctx, x, y, w, h, r) {
    if (typeof r === 'number') r = [r,r,r,r];
    const [tl,tr,br,bl] = r;
    ctx.moveTo(x+tl, y);
    ctx.lineTo(x+w-tr, y); ctx.quadraticCurveTo(x+w, y, x+w, y+tr);
    ctx.lineTo(x+w, y+h-br); ctx.quadraticCurveTo(x+w, y+h, x+w-br, y+h);
    ctx.lineTo(x+bl, y+h); ctx.quadraticCurveTo(x, y+h, x, y+h-bl);
    ctx.lineTo(x, y+tl); ctx.quadraticCurveTo(x, y, x+tl, y);
}

function loadImage(src) {
    return new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = rej;
        img.src = src;
    });
}

function showSharePopup() {
    try {
        if (document.getElementById('share-popup-overlay')) return;

        const playerName = document.getElementById('player-name')?.value || 'Игрок';
        const totalSeconds = playtimeGetTotal();
        const playtimeStr = playtimeFormat(totalSeconds) || '0м';
        const downloadUrl = 'https://github.com/fixsirt/FixLauncher/releases';

        const overlay = document.createElement('div');
        overlay.id = 'share-popup-overlay';
        overlay.innerHTML = `
            <div class="share-popup" id="share-popup" style="max-width:520px;width:100%;">
                <button class="share-popup-close" id="share-popup-close">✕</button>
                <div class="share-popup-header">
                    <div class="share-popup-logo">
                        <img src="logo.png" alt="FixLauncher" width="48" height="48">
                    </div>
                    <div class="share-popup-titles">
                        <div class="share-popup-title">Ты уже 7 дней с нами! 🎉</div>
                        <div class="share-popup-sub">Расскажи друзьям — поделись красивой картинкой</div>
                    </div>
                </div>

                <div id="share-img-preview" style="
                    width:100%; border-radius:12px; overflow:hidden;
                    background:rgba(255,255,255,0.05); margin:14px 0 16px;
                    min-height:72px; display:flex; align-items:center; justify-content:center;
                ">
                    <span style="color:rgba(255,255,255,0.38);font-size:13px;">⏳ Генерация...</span>
                </div>

                <div class="share-buttons" style="display:flex;flex-direction:column;gap:10px;">
                    <button class="share-btn" id="share-save-img" style="
                        background:linear-gradient(135deg,#1e3a6e,#2d2d6e);
                        border:1px solid rgba(100,130,255,0.25);
                        display:flex;align-items:center;justify-content:center;gap:9px;
                        padding:12px 20px;border-radius:12px;
                        color:rgba(200,220,255,0.85);font-size:14px;font-weight:500;cursor:pointer;
                        transition:opacity .15s;
                    ">
                        <svg viewBox="0 0 24 24" fill="currentColor" width="17" height="17"><path d="M12 16l-6-6h4V4h4v6h4l-6 6zm-6 2h12v2H6v-2z"/></svg>
                        Сохранить картинку
                    </button>

                    <button class="share-btn share-tg" id="share-tg-btn" style="
                        background:linear-gradient(135deg,#0088cc,#006aad);
                        display:flex;align-items:center;justify-content:center;gap:10px;
                        padding:15px 20px;border-radius:12px;border:none;
                        color:#fff;font-size:15px;font-weight:700;cursor:pointer;
                        box-shadow:0 4px 20px rgba(0,136,204,0.4);
                        transition:opacity .15s;
                    ">
                        <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.894 8.221l-1.97 9.28c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12L7.19 13.6l-2.938-.916c-.638-.2-.65-.638.136-.944l11.47-4.42c.533-.193 1 .13.837.9z"/></svg>
                        Поделиться в Telegram
                    </button>
                </div>

                <!-- Тост-уведомление -->
                <div id="share-toast" style="
                    display:none; margin-top:12px;
                    padding:12px 16px; border-radius:10px;
                    background:rgba(0,180,100,0.15); border:1px solid rgba(0,200,100,0.3);
                    color:rgba(100,255,160,0.95); font-size:13px; text-align:center;
                    animation: fadeInToast .25s ease;
                "></div>

                <button class="share-popup-later" id="share-popup-later">Напомнить позже</button>
            </div>
        `;
        document.body.appendChild(overlay);

        // Инжектим анимацию тоста если нет
        if (!document.getElementById('share-toast-style')) {
            const st = document.createElement('style');
            st.id = 'share-toast-style';
            st.textContent = `@keyframes fadeInToast { from{opacity:0;transform:translateY(4px)} to{opacity:1;transform:none} }`;
            document.head.appendChild(st);
        }

        let imageDataUrl = null;

        generateShareImage(playerName, playtimeStr).then(dataUrl => {
            imageDataUrl = dataUrl;
            const preview = document.getElementById('share-img-preview');
            if (preview) {
                preview.innerHTML = '';
                const img = document.createElement('img');
                img.src = dataUrl;
                img.style.cssText = 'width:100%;border-radius:10px;display:block;cursor:pointer;';
                preview.appendChild(img);
            }
        }).catch(e => console.warn('Image gen error:', e));

        const showToast = (msg, color = 'rgba(100,255,160,0.95)', bg = 'rgba(0,180,100,0.15)', border = 'rgba(0,200,100,0.3)') => {
            const t = document.getElementById('share-toast');
            if (!t) return;
            t.textContent = msg;
            t.style.color = color;
            t.style.background = bg;
            t.style.borderColor = border;
            t.style.display = 'block';
            t.style.animation = 'none';
            requestAnimationFrame(() => { t.style.animation = 'fadeInToast .25s ease'; });
        }

        const openExternal = (url) => {
            try {
                const { ipcRenderer: _ipc } = require('electron');
                _ipc.invoke('open-external', url);
            } catch(e) { window.open(url, '_blank'); }
        }

        const markShown = () => {
            localStorage.setItem('fixlauncher-share-shown', '1');
        }

        // Копируем картинку в буфер через Electron clipboard
        const copyImageToClipboard = async (dataUrl, text) => {
            try {
                const { ipcRenderer: _ipc } = require('electron');
                await _ipc.invoke('copy-image-to-clipboard', dataUrl, text || '');
                return true;
            } catch(e) {
                return false;
            }
        }

        // Сохранить картинку
        document.getElementById('share-save-img').addEventListener('click', async () => {
            if (!imageDataUrl) { showToast('⏳ Картинка ещё генерируется...', 'rgba(255,200,80,0.9)', 'rgba(200,150,0,0.12)', 'rgba(255,180,0,0.25)'); return; }
            try {
                const { ipcRenderer: _ipc } = require('electron');
                const p = await _ipc.invoke('save-share-image', imageDataUrl);
                if (p) showToast('✅ Сохранено: ' + p.split(/[\\/]/).pop());
                else throw new Error('no path');
            } catch(e) {
                const a = document.createElement('a');
                a.href = imageDataUrl;
                a.download = 'fixlauncher-share.png';
                a.click();
                showToast('✅ Картинка скачана!');
            }
            markShown();
        });

        // Telegram — копируем в буфер и открываем TG
        document.getElementById('share-tg-btn').addEventListener('click', async () => {
            if (!imageDataUrl) { showToast('⏳ Картинка ещё генерируется, подожди секунду...', 'rgba(255,200,80,0.9)', 'rgba(200,150,0,0.12)', 'rgba(255,180,0,0.25)'); return; }

            const btn = document.getElementById('share-tg-btn');
            btn.disabled = true;
            btn.innerHTML = '<span style="opacity:.7">⏳ Копирую...</span>';

            // Копируем картинку + текст одновременно в один clipboard.write()
            const caption = `🎮 Играю на FixLauncher уже ${playtimeStr}! Ник: ${playerName}\n⬇️ Скачать: ${downloadUrl}`;
            const imgOk = await copyImageToClipboard(imageDataUrl, ''); // только картинка

            btn.disabled = false;
            btn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.894 8.221l-1.97 9.28c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12L7.19 13.6l-2.938-.916c-.638-.2-.65-.638.136-.944l11.47-4.42c.533-.193 1 .13.837.9z"/></svg> Поделиться в Telegram`;

            // Показываем инструкцию
            showShareInstructions(imgOk, caption, () => {
                openExternal('tg://');
                markShown();
                overlay.remove();
            });
        });

        const showShareInstructions = (imgOk, caption, onOk) => {
            // Убираем старый модал если есть
            const old = document.getElementById('share-instruction-modal');
            if (old) old.remove();

            const modal = document.createElement('div');
            modal.id = 'share-instruction-modal';
            modal.style.cssText = `
                position:fixed; inset:0; z-index:10002;
                display:flex; align-items:center; justify-content:center;
                background:rgba(0,0,0,0.7); backdrop-filter:blur(8px);
            `;

            const steps = imgOk ? [
                { icon: '📋', title: 'Картинка скопирована!', desc: 'Фото в буфере обмена — готово к вставке' },
                { icon: '1️⃣', title: 'Открой нужный чат в Telegram', desc: 'Telegram сейчас откроется автоматически' },
                { icon: '2️⃣', title: 'Нажми Ctrl+V', desc: 'Вставится картинка' },
                { icon: '✅', title: 'Нажми отправить!', desc: 'Друзья увидят карточку и смогут скачать лаунчер 🎉' },
            ] : [
                { icon: '⚠️', title: 'Буфер обмена недоступен', desc: 'Картинка сохранена как файл <b>fixlauncher-share.png</b>' },
                { icon: '1️⃣', title: 'Открой нужный чат в Telegram', desc: 'Telegram сейчас откроется автоматически' },
                { icon: '2️⃣', title: 'Прикрепи файл', desc: 'Нажми 📎 и выбери сохранённый файл <b>fixlauncher-share.png</b>' },
                { icon: '3️⃣', title: 'Добавь подпись', desc: `<span style="font-size:12px;color:rgba(150,200,255,0.9);">${caption.replace(/\n/g,'<br>')}</span>` },
                { icon: '✅', title: 'Отправь!', desc: 'Готово!' },
            ];

            modal.innerHTML = `
                <div style="
                    background:linear-gradient(160deg,#0d1d35,#091525);
                    border:1px solid rgba(59,130,246,0.3);
                    border-radius:20px; padding:28px 28px 22px;
                    max-width:400px; width:92%;
                    box-shadow:0 24px 80px rgba(0,0,0,0.7);
                ">
                    <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;">
                        <div style="
                            width:42px;height:42px;border-radius:11px;flex-shrink:0;
                            background:linear-gradient(135deg,#0088cc,#006aad);
                            display:flex;align-items:center;justify-content:center;font-size:22px;
                        ">📤</div>
                        <div>
                            <div style="font-size:17px;font-weight:700;color:#fff;">Как поделиться в Telegram</div>
                            <div style="font-size:12px;color:rgba(150,190,255,0.7);margin-top:2px;">Следуй инструкции — это займёт 10 секунд</div>
                        </div>
                    </div>

                    <div style="display:flex;flex-direction:column;gap:9px;margin-bottom:20px;">
                        ${steps.map(s => `
                            <div style="
                                display:flex;align-items:flex-start;gap:12px;
                                background:rgba(255,255,255,0.05);
                                border:1px solid rgba(59,130,246,0.15);
                                border-radius:12px; padding:11px 13px;
                            ">
                                <span style="font-size:20px;flex-shrink:0;line-height:1.3">${s.icon}</span>
                                <div>
                                    <div style="font-size:13px;font-weight:600;color:#fff;margin-bottom:2px;">${s.title}</div>
                                    <div style="font-size:12px;color:rgba(180,210,255,0.7);line-height:1.5;">${s.desc}</div>
                                </div>
                            </div>
                        `).join('')}
                    </div>

                    <button id="share-instr-ok" style="
                        width:100%; padding:14px;
                        background:linear-gradient(135deg,#0088cc,#0060a0);
                        border:none; border-radius:12px; cursor:pointer;
                        color:#fff; font-size:15px; font-weight:700;
                        box-shadow:0 4px 18px rgba(0,136,204,0.4);
                        transition:opacity .15s;
                    ">Понятно, открыть Telegram →</button>
                </div>
            `;

            document.body.appendChild(modal);


            document.getElementById('share-instr-ok').addEventListener('click', () => {
                modal.remove();
                onOk();
            });

            modal.addEventListener('click', e => { if (e.target === modal) { modal.remove(); onOk(); } });
        }

        document.getElementById('share-popup-close').addEventListener('click', () => { markShown(); overlay.remove(); });
        document.getElementById('share-popup-later').addEventListener('click', () => {
            localStorage.setItem('fixlauncher-first-launch', String(Date.now() - (4 * 24 * 60 * 60 * 1000)));
            overlay.remove();
        });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) { markShown(); overlay.remove(); } });

        requestAnimationFrame(() => overlay.classList.add('share-popup-visible'));
    } catch(e) {
        console.error('Share popup error:', e);
    }
}

// Запускаем проверку после инициализации
setTimeout(initSharePopup, 5000);

// ══════════════════════════════════════════════════════════
// DEV HELPER — тест попапа: в консоли вызови testSharePopup()
// ══════════════════════════════════════════════════════════
window.testSharePopup = function() {
    try {
        localStorage.removeItem('fixlauncher-share-shown');
        const eightDaysAgo = Date.now() - (8 * 24 * 60 * 60 * 1000);
        localStorage.setItem('fixlauncher-first-launch', String(eightDaysAgo));
        const existing = document.getElementById('share-popup-overlay');
        if (existing) existing.remove();
        showSharePopup();
        console.log('[testSharePopup] Попап показан! Для сброса: resetSharePopup()');
    } catch(e) { console.error(e); }
};

window.resetSharePopup = function() {
    localStorage.removeItem('fixlauncher-share-shown');
    localStorage.removeItem('fixlauncher-first-launch');
    console.log('[resetSharePopup] Сброшено. Таймер начнётся заново.');
};
