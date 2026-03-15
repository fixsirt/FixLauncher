(function() {
'use strict';

/**
 * renderer.js — точка входа рендерера FixLauncher
 *
 * Этот файл содержит только:
 *   - глобальные импорты
 *   - навигацию/вкладки (initTabs, showPanel)
 *   - управление окном (initWindowControls, initThemeSwitcher, initPlayButton)
 *   - JVM-модал
 *   - Power Features / Support Tools
 *   - splash-экран
 *   - главную функцию init()
 *
 * Вся бизнес-логика вынесена в src/renderer/*.js
 */

// ── Node.js недоступен в renderer при contextIsolation:true ───────────────────
// Все операции с файловой системой идут через window.electronAPI (contextBridge).
// Алиасы ниже проксируют electronAPI, чтобы не менять каждый вызов в коде.
const path = {
    join:     (...a) => window.electronAPI.path.join(...a),
    basename: (p, e) => window.electronAPI.path.basename(p, e),
    dirname:  (p)    => window.electronAPI.path.dirname(p),
    resolve:  (...a) => window.electronAPI.path.resolve(...a),
};
const fs = {
    existsSync:   async (p)       => window.electronAPI.fs.exists(p),
    mkdirSync:    async (p, opts) => window.electronAPI.fs.mkdir(p, opts),
    readdirSync:  async (p, opts) => opts && opts.withFileTypes
        ? window.electronAPI.fs.readdir(p)
        : window.electronAPI.fs.readdirNames(p),
    statSync:     async (p)       => window.electronAPI.fs.stat(p),
    unlinkSync:   async (p)       => window.electronAPI.fs.unlink(p),
    readFileSync: async (p, enc)  => window.electronAPI.fs.read(p, enc || 'utf8'),
};

// ── Electron API (через preload.js / window.electronAPI) ─────────────────────
// contextBridge.exposeInMainWorld() устанавливает window.electronAPI ДО загрузки renderer.js.
// eslint-disable-next-line no-var
var electronAPI = window.electronAPI;

// ── Модули (загружены как <script> в index.html, экспортируют в window.*) ────
const { getProfilePreset, detectModConflicts, analyzeCrashText } = window.PowerTools;
const { initServersPanel } = window.ServersModule;
const { formatDiagnosticsReport } = window.RendererSupport;

const {
    renderMd, escapeHtmlText, escapeHtml,
    downloadFile, fetchJSON, generateOfflineUUID, generateUUID
} = window.RendererUtils;

const {
    playtimeGetTotal, playtimeFormat, playtimeUpdateUI,
    showUpdateBanner,
    showToast, showNewsSkeleton, showModsSkeleton, clearSkeleton, initPlayRipple,
    hexToRgb, lerpColor, rgbToHex, easeInOut, applyThemeSmooth, animateStatValue,
    getLauncherModalEls, showLauncherAlert, showLauncherConfirm,
    showProgress, hideProgress, updateProgress,
    resetPlayButton, initElectronListeners
} = window.UiHelpers;

const { loadNews, initNewsLinks, initNewsScrollbar } = window.RendererNews;
const {
    loadSettings, findJavaPath, initBrowseButton, initRamSlider, initSaveButton, initLinks,
    getVanillaSunsPath, saveCredentials, loadCredentials, initPlayerName
} = window.SettingsPanel;
const {
    VERSION_STORAGE_KEY, DEFAULT_VERSION_ID,
    getMinecraftProfilePath, getVersionDirNamesForCheck, isVersionInstalled,
    fetchVersionList, getSelectedVersion, versionHasModLoader, setSelectedVersion,
    renderVersionList, openVersionDropdown, closeVersionDropdown, initVersionSelector
} = window.VersionsModule;
const { initModsPanel, loadModsPanel, getModsPathForVersion, getDataPathForVersion, refreshInstalledModsList } = window.ModsPanel;
const { checkAndDownloadVersion, installModpack } = window.Installer;
const { launchMinecraft } = window.LauncherModule;
const { initSharePopup, showSharePopup } = window.ShareModule;
const { initScreenshots } = window.Screenshots;
const { initInstances } = window.Instances;

// ══════════════════════════════════════════════════════════════════════════════
// НАВИГАЦИЯ / ВКЛАДКИ
// ══════════════════════════════════════════════════════════════════════════════
function showPanel(panel) {
    if (!panel) return;
    panel.style.display = panel.id === 'servers-panel' ? 'flex'
        : panel.id === 'mods-panel' ? 'flex'
        : panel.id === 'news-panel' ? 'flex'
        : 'block';
}

let _tabToken = {};
function isTokenValid(token) { return token === _tabToken; }

const PANEL_MAP = {
    0: 'main-panel',    1: 'news-panel',
    2: 'servers-panel', 3: 'settings-panel',
    4: 'mods-panel',    5: 'about-panel',
    6: 'instances-panel', 7: 'screenshots-panel',
};

function switchToPanel(targetPanel, onAfterShow) {
    if (!targetPanel) return;
    const allPanels = Object.values(PANEL_MAP)
        .map(id => document.getElementById(id)).filter(Boolean);

    if (targetPanel.classList.contains('active') && targetPanel.style.display !== 'none') return;

    // Скрываем всё моментально — анимация только на появлении
    allPanels.forEach(p => {
        if (p !== targetPanel) {
            p.classList.remove('active');
            p.style.display = 'none';
        }
    });

    showPanel(targetPanel);
    // Сброс состояния чтобы transition сработал
    targetPanel.classList.remove('active');
    void targetPanel.offsetHeight; // force reflow
    targetPanel.classList.add('active');
    if (onAfterShow) onAfterShow();
}

function initTabs() {
    const tabs = document.querySelectorAll('.tab');

    tabs.forEach((tab, index) => {
        tab.addEventListener('click', () => {
            _tabToken = {};
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            const panelId = PANEL_MAP[index];
            if (!panelId) return;
            const target = document.getElementById(panelId);
            switchToPanel(target, () => {
                // Данные уже загружены при старте — только обновляем если нужно
                if (index === 2) initServersPanel(); // серверы: refresh пингов
                else if (index === 3) loadSettings(); // настройки: актуальные значения
                else if (index === 4) refreshInstalledModsList(); // моды: только список
            });
        });
    });

    // Навигация через sidebar (panel-switched)
    document.addEventListener('panel-switched', (e) => {
        const tab = e.detail && e.detail.tab;
        const tabMap = {
            main: 0, news: 1, servers: 2, settings: 3,
            mods: 4, about: 5, instances: 6, screenshots: 7
        };
        const idx = tabMap[tab];
        if (idx === undefined) return;
        const panelId = PANEL_MAP[idx];
        if (!panelId) return;
        const target = document.getElementById(panelId);

        // Синхронизируем compat-вкладки
        const compatTab = document.getElementById('compat-tab-' + tab);
        if (compatTab) {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            compatTab.classList.add('active');
        }

        switchToPanel(target, () => {
            if (tab === 'servers') initServersPanel();
            else if (tab === 'settings') loadSettings();
            else if (tab === 'mods') refreshInstalledModsList();
        });
    });
}


// ══════════════════════════════════════════════════════════════════════════════
// КНОПКА ИГРАТЬ
// ══════════════════════════════════════════════════════════════════════════════
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

// ══════════════════════════════════════════════════════════════════════════════
// ПЕРЕКЛЮЧАТЕЛЬ ТЕМЫ
// ══════════════════════════════════════════════════════════════════════════════
function initThemeSwitcher() {
    const themeCircles = document.querySelectorAll('.theme-circle');
    const html = document.documentElement;

    const savedTheme = localStorage.getItem('launcher-theme') || 'blue';
    html.setAttribute('data-theme', savedTheme);

    themeCircles.forEach(circle => {
        if (circle.getAttribute('data-theme') === savedTheme) circle.classList.add('active');
    });

    themeCircles.forEach(circle => {
        circle.addEventListener('click', (e) => {
            const theme = circle.getAttribute('data-theme');
            if (html.getAttribute('data-theme') === theme) return;

            themeCircles.forEach(c => c.classList.remove('active'));
            circle.classList.add('active');

            const rect = circle.getBoundingClientRect();
            const cx = rect.left + rect.width  / 2;
            const cy = rect.top  + rect.height / 2;
            const maxR = Math.hypot(
                Math.max(cx, window.innerWidth  - cx),
                Math.max(cy, window.innerHeight - cy)
            );
            const themeColors = {
                blue: '#3b82f6', green: '#10b981',
                purple: '#8b5cf6', orange: '#f59e0b', pink: '#ec4899'
            };
            const color = themeColors[theme] || '#3b82f6';

            const ripple = document.createElement('div');
            ripple.style.cssText = `
                position:fixed;left:${cx}px;top:${cy}px;
                width:0;height:0;border-radius:50%;
                background:${color};opacity:0.18;
                transform:translate(-50%,-50%);
                pointer-events:none;z-index:9999;
                transition:width 0.55s cubic-bezier(0.22,1,0.36,1),
                           height 0.55s cubic-bezier(0.22,1,0.36,1),
                           opacity 0.55s ease;
            `;
            document.body.appendChild(ripple);
            requestAnimationFrame(() => requestAnimationFrame(() => {
                const d = maxR * 2 + 40;
                ripple.style.width = d + 'px';
                ripple.style.height = d + 'px';
                ripple.style.opacity = '0';
            }));
            setTimeout(() => applyThemeSmooth(theme), 80);
            setTimeout(() => ripple.remove(), 600);
        });
    });
}

// ══════════════════════════════════════════════════════════════════════════════
// УПРАВЛЕНИЕ ОКНОМ
// ══════════════════════════════════════════════════════════════════════════════
function initWindowControls() {
        const btnMinimize = document.getElementById('btn-minimize');
    const btnMaximize = document.getElementById('btn-maximize');
    const btnClose = document.getElementById('btn-close');
    if (btnMinimize) {
        btnMinimize.addEventListener('click', () => electronAPI.minimizeWindow());
    }
    if (btnMaximize) {
        btnMaximize.addEventListener('click', () => electronAPI.maximizeWindow());
    }
    if (btnClose) {
        btnClose.addEventListener('click', () => window.close());
    }
    electronAPI.on?.windowMaximized(() => document.body.classList.add('window-maximized'));
    electronAPI.on?.windowUnmaximized(() => document.body.classList.remove('window-maximized'));
}

// ══════════════════════════════════════════════════════════════════════════════
// JVM-ФЛАГИ MODAL
// ══════════════════════════════════════════════════════════════════════════════
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
            name: '-XX:+DisableExplicitGC',
            description: 'Запретить вызов System.gc() (рекомендуется)',
            details: 'Minecraft часто вызывает System.gc(), что вызывает ненужные полные сборки мусора и фризы. Эта опция (+) запрещает такие вызовы.'
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

// ══════════════════════════════════════════════════════════════════════════════
// SPLASH-ЭКРАН
// ══════════════════════════════════════════════════════════════════════════════
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

// ══════════════════════════════════════════════════════════════════════════════
// POWER FEATURES / SUPPORT TOOLS
// ══════════════════════════════════════════════════════════════════════════════
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
        quickFixBtn.addEventListener('click', async () => {
            try {
                const api = window.electronAPI;
                const versionId = localStorage.getItem(VERSION_STORAGE_KEY) || DEFAULT_VERSION_ID;
                const dataPath = getDataPathForVersion(versionId);
                const dirs = ['mods', 'resourcepacks', 'shaderpacks', 'logs', 'crash-reports'];
                for (const dir of dirs) {
                    const full = api.path.join(dataPath, dir);
                    if (!await api.fs.exists(full)) await api.fs.mkdir(full, { recursive: true });
                }

                const modsPath = api.path.join(dataPath, 'mods');
                let removed = 0;
                if (await api.fs.exists(modsPath)) {
                    const files = await api.fs.readdirNames(modsPath);
                    for (const file of files) {
                        if (!file.endsWith('.jar')) continue;
                        const fp = api.path.join(modsPath, file);
                        const stat = await api.fs.stat(fp);
                        if (stat && stat.size === 0) {
                            await api.fs.unlink(fp);
                            removed += 1;
                        }
                    }
                }


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
            } catch (e) {
                showLauncherAlert('Ошибка быстрой починки: ' + e.message);
            }
        });
    }

    if (detectConflictsBtn) {
        detectConflictsBtn.addEventListener('click', async () => {
            try {
                const api = window.electronAPI;
                const versionId = localStorage.getItem(VERSION_STORAGE_KEY) || DEFAULT_VERSION_ID;
                const modsPath = getModsPathForVersion(versionId);
                if (!await api.fs.exists(modsPath)) {
                    showLauncherAlert('Папка модов не найдена.');
                    return;
                }
                const files = (await api.fs.readdirNames(modsPath)).filter((f) => f.toLowerCase().endsWith('.jar'));
                const conflicts = detectModConflicts(files);
                if (!conflicts.length) {
                    showLauncherAlert('Явных конфликтов модов не найдено ✅');
                } else {
                    const conflictText = conflicts.map(c => `• ${c.message || c.pair}`).join('\n');
                    showLauncherAlert('Найдены потенциальные конфликты:\n' + conflictText, 'Конфликты модов');
                }
            } catch (e) {
                showLauncherAlert('Ошибка проверки модов: ' + e.message);
            }
        });
    }

    if (analyzeCrashBtn) {
        analyzeCrashBtn.addEventListener('click', async () => {
            try {
                const api = window.electronAPI;
                const versionId = localStorage.getItem(VERSION_STORAGE_KEY) || DEFAULT_VERSION_ID;
                const dataPath = getDataPathForVersion(versionId);
                const crashDir = api.path.join(dataPath, 'crash-reports');
                const candidates = [];
                if (await api.fs.exists(crashDir)) {
                    const names = await api.fs.readdirNames(crashDir);
                    names.filter((f) => f.endsWith('.txt'))
                         .forEach((f) => candidates.push(api.path.join(crashDir, f)));
                }
                if (!candidates.length) {
                    showLauncherAlert('Краш-логи не найдены.');
                    return;
                }
                const withStats = await Promise.all(
                    candidates.map(async p => ({ p, stat: await api.fs.stat(p) }))
                );
                withStats.sort((a, b) => (b.stat?.mtimeMs || 0) - (a.stat?.mtimeMs || 0));
                const latest = withStats[0].p;
                const text = await api.fs.read(latest, 'utf8') || '';
                const message = analyzeCrashText(text);
                showLauncherAlert(`Файл: ${api.path.basename(latest)}\n\n${message}`, 'Анализ краша');
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
                const result = await electronAPI.runDiagnostics();
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
                const filePath = await electronAPI.exportDebugLog();
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

// ══════════════════════════════════════════════════════════════════════════════
// ИНИЦИАЛИЗАЦИЯ
// ══════════════════════════════════════════════════════════════════════════════
async function init() {
    try {
        initElectronListeners();

        // ── Шаг 1: UI (синхронно, быстро) ──────────────────────────────────
        splashSet(15, 'Инициализация интерфейса...');
        initWindowControls();
        initThemeSwitcher();
        initTabs();
        initRamSlider();
        initBrowseButton();
        initSaveButton();
        initSupportTools();
        initPowerFeatures();
        initLinks();
        initPlayerName();
        initPlayButton();
        initVersionSelector();
        initNewsLinks();
        initNewsScrollbar();
        initJvmModal();
        initScreenshots();
        initInstances();
        loadSettings();

        // ── Шаг 2: Все вкладки грузятся ПАРАЛЛЕЛЬНО пока показывается сплеш ─
        splashSet(35, 'Загрузка данных...');

        // Запускаем всё одновременно — не ждём друг друга
        const preloadPromises = [
            // Версии — нужны сразу
            fetchVersionList().catch(e => console.warn('[preload] versions:', e.message)),
            // Новости
            loadNews().catch(e => console.warn('[preload] news:', e.message)),
            // Серверы
            initServersPanel().catch(e => console.warn('[preload] servers:', e.message)),
            // Моды / текстуры / шейдеры
            loadModsPanel().catch(e => console.warn('[preload] mods:', e.message)),
        ];

        splashSet(60, 'Загрузка ресурсов...');

        // Ждём первые два (версии + новости) — критичные
        await Promise.race([
            Promise.all(preloadPromises.slice(0, 2)),
            new Promise(r => setTimeout(r, 2000)) // таймаут 2с — не блокируем старт
        ]);

        splashSet(90, 'Почти готово...');

        // Остальное доделается в фоне
        await new Promise(r => setTimeout(r, 80));

        splashSet(100, 'Готово!');
        await new Promise(r => setTimeout(r, 150));
        splashHide();

        // Серверы и моды могут ещё догружаться — это нормально
        Promise.all(preloadPromises).catch(() => {});

        console.log('[INIT] Launcher initialized successfully');
    } catch (error) {
        console.error('[INIT] Error:', error);
        splashHide();
        showLauncherAlert('Ошибка при инициализации лаунчера: ' + error.message);
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// ТЕСТОВЫЕ ХЕЛПЕРЫ (dev-only)
// ══════════════════════════════════════════════════════════════════════════════
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

// ── ЗАПУСК ────────────────────────────────────────────────────────────────────
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

// Попап шаринга — через 5 секунд после запуска
setTimeout(initSharePopup, 5000);

// ── ГЛОБАЛЬНЫЙ ЭКСПОРТ для ui-init.js ────────────────────────────────────────
// ui-init.js загружается как отдельный <script> и не имеет доступа к локальным
// переменным renderer.js (CommonJS module scope). Выставляем нужные функции на window.
window.__launcherAPI = {
    playtimeUpdateUI,
    refreshInstalledModsList,
    loadNews,
    loadSettings,
};

})();
