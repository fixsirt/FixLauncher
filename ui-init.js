/**
 * ui-init.js — инициализация UI, вынесена из inline-скриптов index.html.
 *
 * Ранее код был прямо в index.html через <script> теги (unsafe-inline).
 * Перенос в отдельный файл позволяет убрать 'unsafe-inline' из CSP.
 *
 * ВАЖНО: этот файл загружается ПОСЛЕ renderer.js (defer), поэтому
 * window.electronAPI и все renderer-функции уже доступны.
 */

'use strict';

// ══════════════════════════════════════════════════════════════════════════════
// SIDEBAR NAVIGATION
// ══════════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
    const navItems = document.querySelectorAll('.nav-item');
    const panels = {
        main:        document.getElementById('main-panel'),
        news:        document.getElementById('news-panel'),
        mods:        document.getElementById('mods-panel'),
        servers:     document.getElementById('servers-panel'),
        settings:    document.getElementById('settings-panel'),
        instances:   document.getElementById('instances-panel'),
        screenshots: document.getElementById('screenshots-panel'),
        about:       document.getElementById('about-panel'),
    };

    let _currentTab = null;

    function switchPanel(tab) {
        // Уже на этой вкладке — не перезагружаем
        if (tab === _currentTab) return;
        _currentTab = tab;

        Object.entries(panels).forEach(([key, panel]) => {
            if (!panel) return;
            if (key === tab) {
                panel.style.display = 'block';
                setTimeout(() => panel.classList.add('active'), 10);
            } else {
                panel.classList.remove('active');
                panel.style.display = 'none';
            }
        });
        const compatTab = document.getElementById('compat-tab-' + tab);
        if (compatTab) {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            compatTab.classList.add('active');
        }
        document.dispatchEvent(new CustomEvent('panel-switched', { detail: { tab } }));
    }

    // ── LIQUID NAV — Canvas blob animation ───────────────────────────────────
    const nav = document.querySelector('.sidebar-nav');

    // Canvas поверх nav
    const lqCanvas = document.createElement('canvas');
    lqCanvas.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:0;border-radius:10px;overflow:hidden;';
    if (nav) nav.style.position = 'relative';
    if (nav) nav.insertBefore(lqCanvas, nav.firstChild);

    // Текущее и целевое состояние
    let lq = {
        // Текущие координаты blob (пружинная физика)
        y:    0, h:    40,
        // Целевые
        ty:   0, th:   40,
        // Скорости
        vy:   0, vh:   0,
        // Wobble — боковое колебание после приземления
        wobble: 0, wobbleV: 0,
        // Фаза перехода: idle / moving
        phase: 'idle',
        prevY: 0, prevH: 40,
        progress: 1,
    };
    let rafId = null;
    let accentColor = [59, 130, 246];

    function readAccent() {
        const raw = getComputedStyle(document.documentElement).getPropertyValue('--accent-g').trim();
        if (raw) {
            const p = raw.split(',').map(Number);
            if (p.length === 3 && !p.some(isNaN)) accentColor = p;
        }
    }

    function resizeLqCanvas() {
        if (!nav || !lqCanvas) return;
        lqCanvas.width  = nav.offsetWidth;
        lqCanvas.height = nav.offsetHeight;
    }

    // Пружинный интегратор
    function spring(cur, vel, target, stiffness, damping) {
        const force = (target - cur) * stiffness - vel * damping;
        vel += force;
        cur += vel;
        return [cur, vel];
    }

    function drawBlob(ctx, W, y, h, wobble, phase, progress) {
        const [r, g, b] = accentColor;
        const pad = 2; // отступ от краёв
        const x0  = pad;
        const x1  = W - pad;
        const bw  = x1 - x0;
        const rx  = 10; // border-radius

        // Центр и половины высоты
        const cy = y + h / 2;
        const hy = h / 2;

        // Wobble: боковое "дрожание" краёв (синусоида)
        const wAmp = wobble * 6;

        ctx.save();

        // Градиент заливки
        const grd = ctx.createLinearGradient(x0, y, x1, y + h);
        grd.addColorStop(0,   `rgba(${r},${g},${b},0.95)`);
        grd.addColorStop(0.5, `rgba(${r},${g},${b},1)`);
        grd.addColorStop(1,   `rgba(${Math.max(0,r-20)},${Math.max(0,g-20)},${b},0.9)`);

        ctx.fillStyle = grd;
        ctx.beginPath();

        // Строим blob-форму:
        // Верхний-левый
        ctx.moveTo(x0 + rx, y);

        // Верхняя сторона с волной
        const topMidX = x0 + bw * 0.5;
        const topWave = -Math.abs(wAmp) * 0.4; // вдавленность при движении
        ctx.bezierCurveTo(
            topMidX - bw * 0.25, y + topWave,
            topMidX + bw * 0.25, y + topWave,
            x1 - rx, y
        );

        // Верхний-правый угол
        ctx.quadraticCurveTo(x1, y, x1, y + rx);

        // Правая сторона — wobble
        ctx.bezierCurveTo(
            x1 + wAmp, cy - hy * 0.3,
            x1 + wAmp, cy + hy * 0.3,
            x1, y + h - rx
        );

        // Нижний-правый угол
        ctx.quadraticCurveTo(x1, y + h, x1 - rx, y + h);

        // Нижняя сторона с волной
        const botWave = Math.abs(wAmp) * 0.4;
        ctx.bezierCurveTo(
            topMidX + bw * 0.25, y + h + botWave,
            topMidX - bw * 0.25, y + h + botWave,
            x0 + rx, y + h
        );

        // Нижний-левый угол
        ctx.quadraticCurveTo(x0, y + h, x0, y + h - rx);

        // Левая сторона — wobble (противофаза)
        ctx.bezierCurveTo(
            x0 - wAmp, cy + hy * 0.3,
            x0 - wAmp, cy - hy * 0.3,
            x0, y + rx
        );

        // Верхний-левый угол
        ctx.quadraticCurveTo(x0, y, x0 + rx, y);

        ctx.closePath();
        ctx.fill();

        // Блик сверху
        const gloss = ctx.createLinearGradient(x0, y, x0, y + h * 0.5);
        gloss.addColorStop(0,   'rgba(255,255,255,0.22)');
        gloss.addColorStop(1,   'rgba(255,255,255,0)');
        ctx.fillStyle = gloss;
        ctx.fill();

        ctx.restore();
    }

    function tick() {
        if (!lqCanvas || !nav) return;
        const ctx = lqCanvas.getContext('2d');
        const W = lqCanvas.width;
        const H = lqCanvas.height;
        ctx.clearRect(0, 0, W, H);

        // Пружина для Y (плавный перелёт)
        [lq.y, lq.vy] = spring(lq.y, lq.vy, lq.ty, 0.18, 0.78);
        // Пружина для H (сжатие при движении)
        [lq.h, lq.vh] = spring(lq.h, lq.vh, lq.th, 0.22, 0.80);
        // Wobble затухает
        lq.wobbleV += (-lq.wobble * 0.35 - lq.wobbleV * 0.55);
        lq.wobble  += lq.wobbleV;

        drawBlob(ctx, W, lq.y, lq.h, lq.wobble, lq.phase, lq.progress);

        // Продолжаем если ещё двигаемся
        const moving =
            Math.abs(lq.ty - lq.y) > 0.1 ||
            Math.abs(lq.th - lq.h) > 0.1 ||
            Math.abs(lq.wobble)    > 0.02 ||
            Math.abs(lq.vy)        > 0.05;

        if (moving) {
            rafId = requestAnimationFrame(tick);
        } else {
            lq.y = lq.ty; lq.h = lq.th; lq.wobble = 0;
            drawBlob(ctx, W, lq.y, lq.h, 0);
            rafId = null;
        }
    }

    function moveLiquidTo(item, animate) {
        if (!item || !nav || !lqCanvas) return;
        readAccent();
        resizeLqCanvas();

        const navRect  = nav.getBoundingClientRect();
        const itemRect = item.getBoundingClientRect();
        const newY = itemRect.top  - navRect.top  + nav.scrollTop;
        const newH = itemRect.height;

        if (!animate) {
            lq.y = lq.ty = newY;
            lq.h = lq.th = newH;
            lq.vy = lq.vh = 0;
            lq.wobble = lq.wobbleV = 0;
            const ctx = lqCanvas.getContext('2d');
            resizeLqCanvas();
            ctx.clearRect(0, 0, lqCanvas.width, lqCanvas.height);
            drawBlob(ctx, lqCanvas.width, lq.y, lq.h, 0);
            return;
        }

        // Squish: при большом расстоянии blob сжимается по высоте в середине пути
        const dist = Math.abs(newY - lq.y);
        const squish = dist > 60 ? -8 : dist > 30 ? -4 : 0;

        lq.th = newH + squish;
        lq.ty = newY - squish / 2;

        // Запускаем с wobble
        lq.wobble  = (newY > lq.y ? 1 : -1) * Math.min(dist / 40, 2.5);
        lq.wobbleV = 0;

        // Корректируем финальные значения
        setTimeout(() => { lq.th = newH; lq.ty = newY; }, 120);

        if (!rafId) rafId = requestAnimationFrame(tick);
    }

    // Инициализация
    if (nav) {
        resizeLqCanvas();
        readAccent();
        const activeItem = nav.querySelector('.nav-item.active');
        if (activeItem) moveLiquidTo(activeItem, false);
        window.addEventListener('resize', () => { resizeLqCanvas(); moveLiquidTo(nav.querySelector('.nav-item.active'), false); });
        // Обновляем цвет при смене темы
        new MutationObserver(() => { readAccent(); if (!rafId) rafId = requestAnimationFrame(tick); })
            .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }

    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const tab = item.dataset.tab;
            navItems.forEach(n => n.classList.remove('active'));
            item.classList.add('active');
            moveLiquidTo(item, true);
            switchPanel(tab);
        });
    });

    // ── PARALLAX (оптимизированный: RAF + throttle) ───────────────────────────
    const body = document.body;
    let targetX = 0, targetY = 0;
    let currentX = 0, currentY = 0;
    let parallaxRafId = null;
    let lastMouseTime = 0;

    document.addEventListener('mousemove', (e) => {
        const now = performance.now();
        if (now - lastMouseTime < 32) return; // ~30fps достаточно для параллакса
        lastMouseTime = now;
        const cx = window.innerWidth / 2;
        const cy = window.innerHeight / 2;
        targetX = (e.clientX - cx) / cx * 14;
        targetY = (e.clientY - cy) / cy * 10;
        if (!parallaxRafId) {
            parallaxRafId = requestAnimationFrame(animateParallax);
        }
    });

    function animateParallax() {
        currentX += (targetX - currentX) * 0.05;
        currentY += (targetY - currentY) * 0.05;
        body.style.setProperty('--parallax-x', `${currentX.toFixed(2)}px`);
        body.style.setProperty('--parallax-y', `${currentY.toFixed(2)}px`);
        if (Math.abs(targetX - currentX) > 0.05 || Math.abs(targetY - currentY) > 0.05) {
            parallaxRafId = requestAnimationFrame(animateParallax);
        } else {
            parallaxRafId = null;
        }
    }

    // ── WINDOW CONTROLS — обработчики в renderer.js, здесь только title ─────
    const btnMaximize = document.getElementById('btn-maximize');
    window.electronAPI?.on?.windowMaximized?.(() => {
        if (btnMaximize) btnMaximize.title = 'Восстановить';
        document.body.classList.add('window-maximized');
    });
    window.electronAPI?.on?.windowUnmaximized?.(() => {
        if (btnMaximize) btnMaximize.title = 'Развернуть';
        document.body.classList.remove('window-maximized');
    });

    // ── STAT CARD LINKS — кликабельные карточки статистики ───────────────────
    document.querySelectorAll('.stat-card-link[data-nav]').forEach(card => {
        card.addEventListener('click', () => {
            const tab = card.dataset.nav;
            const navItem = document.querySelector(`.nav-item[data-tab="${tab}"]`);
            if (navItem) navItem.click();
        });
    });

    // ── PLAYTIME UI ───────────────────────────────────────────────────────────
    // playtimeUpdateUI живёт в модуле ui-helpers.js и экспортирована через
    // window.__launcherAPI (см. конец renderer.js).
    // Используем её безопасно через опциональный вызов.
    function callPlaytimeUpdate() {
        window.__launcherAPI?.playtimeUpdateUI?.();
    }
    callPlaytimeUpdate();
    document.addEventListener('settings-saved', callPlaytimeUpdate);

    // ── MODS COUNT STAT (через IPC, без require('fs')) ────────────────────────
    async function updateModsCountStat() {
        const statMods = document.getElementById('stat-mods');
        if (!statMods) return;
        try {
            const versionId = localStorage.getItem('launcher-selected-version') || 'evacuation';
            const basePath = localStorage.getItem('minecraft-path') || (() => {
                // Вычисляем путь по умолчанию через electronAPI (нет require())
                const platform = window.electronAPI?.os?.platform?.() || 'win32';
                const homedir  = window.electronAPI?.os?.homedir?.()  || '';
                const appdata  = window.electronAPI?.env?.APPDATA       || null;
                if (platform === 'win32') {
                    return window.electronAPI?.path?.join(appdata || window.electronAPI?.path?.join(homedir, 'AppData', 'Roaming'), '.fixlauncher');
                }
                if (platform === 'darwin') {
                    return window.electronAPI?.path?.join(homedir, 'Library', 'Application Support', 'fixlauncher');
                }
                return window.electronAPI?.path?.join(homedir, '.fixlauncher');
            })();

            if (!basePath || !window.electronAPI?.mods?.count) {
                statMods.textContent = '—';
                return;
            }

            // Используем IPC-обработчик вместо прямого fs.readdirSync
            const count = await window.electronAPI.mods.count(basePath, versionId);
            if (statMods.textContent !== String(count)) {
                statMods.classList.remove('counting');
                void statMods.offsetWidth; // force reflow
                statMods.textContent = String(count);
                statMods.classList.add('counting');
            }
        } catch (e) {
            statMods.textContent = '—';
        }
    }

    updateModsCountStat();

    // Обновляем при изменении DOM списка модов
    const modsInner = document.getElementById('mods-installed-list-inner');
    if (modsInner && window.MutationObserver) {
        const obs = new MutationObserver(updateModsCountStat);
        obs.observe(modsInner, { childList: true });
    }
    document.addEventListener('settings-saved', updateModsCountStat);
    document.addEventListener('version-changed', updateModsCountStat);

    // ── OPEN VERSION FOLDER (через electronAPI, без require) ──────────────────
    const openFolderBtn = document.getElementById('open-version-folder-btn');
    if (openFolderBtn) {
        openFolderBtn.addEventListener('click', () => {
            const versionSelect = document.getElementById('version-select') || document.getElementById('version-hidden-input');
            const versionId     = versionSelect?.value || null;
            const saved         = localStorage.getItem('minecraft-path');

            const pathAPI    = window.electronAPI?.path;
            const osAPI      = window.electronAPI?.os;
            const envAPI     = window.electronAPI?.env;

            if (!pathAPI || !osAPI || !envAPI) return;

            const platform = osAPI.platform();
            const homedir  = osAPI.homedir();
            const appdata  = envAPI.APPDATA;

            const basePath = saved || (
                platform === 'win32'
                    ? pathAPI.join(appdata || pathAPI.join(homedir, 'AppData', 'Roaming'), '.fixlauncher')
                    : platform === 'darwin'
                        ? pathAPI.join(homedir, 'Library', 'Application Support', 'fixlauncher')
                        : pathAPI.join(homedir, '.fixlauncher')
            );

            let folderName;
            if (!versionId || versionId === 'evacuation') {
                folderName = 'minecraft-survival';
            } else if (versionId.startsWith('instance:')) {
                folderName = versionId.slice('instance:'.length);
            } else {
                folderName = 'minecraft-' + String(versionId).replace(/:/g, '-').replace(/[^a-zA-Z0-9.-]/g, '-');
            }

            const folderPath = pathAPI.join(basePath, folderName);
            window.electronAPI.openPath(folderPath);
        });
    }
});

// ══════════════════════════════════════════════════════════════════════════════
// AUTO UPDATE MODAL
// ══════════════════════════════════════════════════════════════════════════════

(function () {
    const badge        = document.getElementById('update-badge');
    const badgeLabel   = document.getElementById('update-badge-label');
    const overlay      = document.getElementById('update-modal-overlay');
    const modalVersion = document.getElementById('update-modal-version');
    const progressWrap = document.getElementById('update-progress-wrap');
    const progressFill = document.getElementById('update-progress-fill');
    const progressText = document.getElementById('update-progress-text');
    const btnInstall   = document.getElementById('update-btn-install');
    const btnCancel    = document.getElementById('update-btn-cancel');

    let updateInfo = null;
    let isDownloading = false;

    function showBadge(info) {
        updateInfo = info;
        if (!badge || !badgeLabel) return;
        badgeLabel.textContent = 'v' + info.version;
        badge.style.display = 'flex';
        badge.classList.add('update-badge-enter');
        setTimeout(() => badge.classList.remove('update-badge-enter'), 600);
    }

    function openModal() {
        if (!updateInfo || !overlay) return;
        if (modalVersion) modalVersion.textContent = 'Версия ' + updateInfo.version;
        overlay.style.display = 'flex';
        if (progressWrap) progressWrap.style.display = 'none';
        if (progressFill) progressFill.style.width = '0%';
        if (progressText) progressText.textContent = '0%';
        if (btnInstall) {
            btnInstall.disabled = false;
            btnInstall.innerHTML =
                '<svg viewBox="0 0 16 16" fill="none" width="14" height="14">' +
                '<path d="M8 2v8M8 10L5 7M8 10L11 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>' +
                '<path d="M2 12h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg> Обновить сейчас';
        }
    }

    function closeModal() {
        if (overlay) overlay.style.display = 'none';
        isDownloading = false;
    }

    if (badge)   badge.addEventListener('click', openModal);
    if (btnCancel) btnCancel.addEventListener('click', closeModal);
    if (overlay)   overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });

    if (btnInstall) {
        btnInstall.addEventListener('click', async () => {
            if (isDownloading) return;
            isDownloading = true;
            if (progressWrap) progressWrap.style.display = 'flex';
            btnInstall.disabled = true;
            btnInstall.textContent = 'Скачивание...';

            // Прогресс-бар обновления
            window.electronAPI?.onUpdateProgress?.((pct) => {
                if (progressFill) progressFill.style.width = pct + '%';
                if (progressText) progressText.textContent = pct + '%';
            });

            const result = await window.electronAPI?.downloadUpdate();
            if (result?.ok) {
                btnInstall.textContent = 'Готово! Закрываем...';
            } else {
                btnInstall.textContent = 'Открыта страница загрузки';
                setTimeout(closeModal, 2000);
            }
        });
    }

    // Слушаем событие от main-процесса
    window.electronAPI?.onUpdateStatus?.((info) => {
        if (info?.version) showBadge(info);
    });

    // На случай если событие пришло до навешивания слушателя
    document.addEventListener('DOMContentLoaded', async () => {
        try {
            const info = await window.electronAPI?.checkForUpdates();
            if (info?.version) showBadge(info);
        } catch { /* ignore */ }
    });
})();

// ════════════════════════════════════════════════════════════════════════════════
// PARTICLES — плавающие частицы на фоне (почти невидимые, живые)
// ════════════════════════════════════════════════════════════════════════════════
(function initParticles() {
    // Ждём полной загрузки чтобы canvas точно был в DOM
    function start() {
        const canvas = document.getElementById('particles-canvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');

        let W = 0, H = 0;
        let particles = [];
        let accentR = 245, accentG = 158, accentB = 11; // fallback orange

        function readAccentColor() {
            const raw = getComputedStyle(document.documentElement)
                .getPropertyValue('--accent-g').trim();
            if (raw) {
                const parts = raw.split(',').map(Number);
                if (parts.length === 3 && !parts.some(isNaN)) {
                    [accentR, accentG, accentB] = parts;
                }
            }
        }

        function resize() {
            W = canvas.width  = window.innerWidth;
            H = canvas.height = window.innerHeight;
        }

        function createParticle(atBottom) {
            return {
                x:     Math.random() * W,
                y:     atBottom ? H + Math.random() * 80 : Math.random() * H,
                r:     Math.random() * 2.5 + 1.0,           // 1.0–3.5px — заметнее
                vx:    (Math.random() - 0.5) * 0.25,
                vy:    -(Math.random() * 0.35 + 0.12),       // быстрее вверх
                alpha: Math.random() * 0.45 + 0.20,          // 0.20–0.65 — заметнее
                pulse: Math.random() * Math.PI * 2,
                speed: Math.random() * 0.018 + 0.008,        // скорость мерцания
            };
        }

        function init() {
            resize();
            readAccentColor();
            const count = Math.min(70, Math.floor(W * H / 18000));
            particles = Array.from({ length: count }, () => createParticle(false));
        }

        let frame = 0;
        function tick() {
            ctx.clearRect(0, 0, W, H);

            if (frame % 90 === 0) readAccentColor();
            frame++;

            for (const p of particles) {
                p.x     += p.vx;
                p.y     += p.vy;
                p.pulse += p.speed;

                const a = p.alpha * (0.6 + 0.4 * Math.sin(p.pulse));

                // Сброс снизу
                if (p.y < -6) {
                    Object.assign(p, createParticle(true));
                }
                if (p.x < -6)  p.x = W + 2;
                if (p.x > W + 6) p.x = -2;

                // Рисуем с мягким свечением
                const grd = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 2.5);
                grd.addColorStop(0,   `rgba(${accentR},${accentG},${accentB},${(a).toFixed(3)})`);
                grd.addColorStop(0.5, `rgba(${accentR},${accentG},${accentB},${(a * 0.4).toFixed(3)})`);
                grd.addColorStop(1,   `rgba(${accentR},${accentG},${accentB},0)`);

                ctx.beginPath();
                ctx.arc(p.x, p.y, p.r * 2.5, 0, Math.PI * 2);
                ctx.fillStyle = grd;
                ctx.fill();

                // Яркое ядро
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.r * 0.6, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(${accentR},${accentG},${accentB},${Math.min(1, a * 1.4).toFixed(3)})`;
                ctx.fill();
            }
            if (!document.hidden) requestAnimationFrame(tick);
        }

        const themeObserver = new MutationObserver(() => readAccentColor());
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

        window.addEventListener('resize', () => resize());
        // Пауза частиц когда окно скрыто — экономия CPU/GPU
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) requestAnimationFrame(tick);
        });

        init();
        requestAnimationFrame(tick);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();

// Убеждаемся что parallax CSS переменные инициализированы (не undefined)
;(function() {
    document.body.style.setProperty('--parallax-x', '0px');
    document.body.style.setProperty('--parallax-y', '0px');
})();

// ════════════════════════════════════════════════════════════════════════════════
// MAIN PANEL — ACTIVITY BARS
// ════════════════════════════════════════════════════════════════════════════════
(function initActivityBars() {
    const DAY_LABELS = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];

    function formatTime(seconds) {
        if (!seconds || seconds <= 0) return null;
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        if (h > 0) return m > 0 ? `${h}ч ${m}м` : `${h}ч`;
        if (m > 0) return `${m}м`;
        return '<1м';
    }

    function getLast7Days() {
        const days = [];
        const now = new Date();
        for (let i = 6; i >= 0; i--) {
            const d = new Date(now);
            d.setDate(d.getDate() - i);
            const key = d.toISOString().slice(0, 10);
            const labelIdx = (d.getDay() + 6) % 7; // пн=0
            days.push({ key, label: DAY_LABELS[labelIdx], isToday: i === 0 });
        }
        return days;
    }

    async function render() {
        const container = document.getElementById('main-activity-bars');
        const totalEl   = document.getElementById('main-activity-total');
        if (!container) return;

        let daily = {};
        try {
            const data = await window.electronAPI?.getPlaytime?.();
            daily = (data && data.daily) ? data.daily : {};
        } catch(e) {}

        const days   = getLast7Days();
        const values = days.map(d => daily[d.key] || 0);
        const maxVal = Math.max(...values, 1);
        const weekTotal = values.reduce((a, b) => a + b, 0);

        if (totalEl) {
            const t = formatTime(weekTotal);
            totalEl.textContent = t ? t + ' за неделю' : '';
        }

        container.innerHTML = '';

        days.forEach((day, i) => {
            const sec = values[i];
            // минимальная видимая высота 6%, иначе 0 для пустых дней
            const heightPct = sec > 0 ? Math.max(8, Math.round((sec / maxVal) * 100)) : 0;
            const tooltip   = sec > 0 ? formatTime(sec) : 'Нет данных';

            const col = document.createElement('div');
            col.className = 'main-act-bar-col';

            const wrap = document.createElement('div');
            wrap.className = 'main-act-bar-wrap';
            wrap.setAttribute('data-tooltip', tooltip);

            const bar = document.createElement('div');
            bar.className = 'main-act-bar' +
                (day.isToday ? ' today' : (sec > 0 ? ' has-data' : ''));
            bar.style.height = '0px'; // старт для анимации

            const dayEl = document.createElement('span');
            dayEl.className = 'main-act-day' + (day.isToday ? ' today-label' : '');
            dayEl.textContent = day.label;

            wrap.appendChild(bar);
            col.appendChild(wrap);
            col.appendChild(dayEl);
            container.appendChild(col);

            // Анимируем с задержкой на каждый столбик
            setTimeout(() => {
                bar.style.height = heightPct + '%';
            }, 60 + i * 50);
        });
    }

    function init() {
        render();
        window.electronAPI?.on?.playtimeUpdate?.(() => render());
        document.addEventListener('panel-switched', (e) => {
            if (e.detail?.tab === 'main') render();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
