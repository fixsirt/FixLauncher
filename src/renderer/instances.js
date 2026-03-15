(function() {
'use strict';

/**
 * Панель инстансов — управление независимыми сборками Minecraft.
 *
 * РЕФАКТОРИНГ БЕЗОПАСНОСТИ (пункты 1, 2, 4):
 *   - Удалены require('fs'), require('path'), require('os'), require('child_process')
 *   - getInstances() переписан в async IPC-вызов (instances:list)
 *   - exportInstance / importInstance используют IPC-обработчики вместо child_process
 *   - Хардкодные строки '.fixlauncher' вынесены в getBasePath() через electronAPI
 *   - Готово к contextIsolation: true / nodeIntegration: false
 */

'use strict';

const { showLauncherAlert, showLauncherConfirm, showToast } = window.UiHelpers;
const { fetchJSON } = window.RendererUtils;
const {
    MOJANG_VERSION_MANIFEST,
    FABRIC_VERSIONS_LOADER,
    QUILT_VERSIONS_LOADER,
    FORGE_PROMOTIONS,
    STORAGE_KEYS,
    SIZE_CACHE_TTL_MS,
    WATCHER_DEBOUNCE_MS,
    WARMUP_DELAY_MS,
    MC_VERSIONS_CACHE_TTL,
} = window.RendererConstants;

// ─── Константы ────────────────────────────────────────────────────────────────

const INSTANCE_PREFIX       = 'minecraft-';
const INSTANCE_SUBDIRS      = ['mods', 'resourcepacks', 'shaderpacks', 'screenshots', 'saves', 'config'];
const MC_VERSIONS_LIMIT     = 40;
const LOADER_VERSIONS_LIMIT = 15;

// ─── Утилиты ──────────────────────────────────────────────────────────────────

/** @param {number} ms */
const delay = ms => new Promise(r => setTimeout(r, ms));

// ─── Пути (через window.electronAPI, без require('os') / require('path')) ────

/** @returns {string} Базовая папка лаунчера (из настроек или по умолчанию) */
function getBasePath() {
    const saved = localStorage.getItem('minecraft-path');
    if (saved) return saved;

    const platform = window.electronAPI.os.platform();
    const homedir  = window.electronAPI.os.homedir();
    const appdata  = window.electronAPI.env.APPDATA;
    const p        = window.electronAPI.path;

    if (platform === 'win32') return p.join(appdata || p.join(homedir, 'AppData', 'Roaming'), '.fixlauncher');
    if (platform === 'darwin') return p.join(homedir, 'Library', 'Application Support', 'fixlauncher');
    return p.join(homedir, '.fixlauncher');
}

// ─── Форматирование ───────────────────────────────────────────────────────────

/** @param {string} dir @returns {string} Читаемое название инстанса */
function formatLabel(dir) {
    return dir
        .replace(/^minecraft-/, '')
        .replace(/-/g, ' ')
        .replace(/\b(fabric|forge|neoforge|quilt)\b/gi, m => m[0].toUpperCase() + m.slice(1));
}

/** @param {string} dir @returns {string} Эмодзи для мод-загрузчика */
function getLoaderIcon(dir) {
    if (dir.includes('neoforge'))     return '🔧';
    if (dir.includes('forge'))        return '⚙️';
    if (dir.includes('fabric'))       return '🧵';
    if (dir.includes('quilt'))        return '🪡';
    return '📦';
}

/** @param {string} loader @returns {string} Загрузчик с заглавной буквы */
function capitalizeLoader(loader) {
    return loader === 'vanilla' ? 'Vanilla' : loader[0].toUpperCase() + loader.slice(1);
}

// ─── Инстансы (через IPC) ────────────────────────────────────────────────────

/**
 * Получить список инстансов через IPC (async, пункт 1 & 2).
 * Вся логика чтения папок — в main-процессе (instances:list).
 * @returns {Promise<object[]>}
 */
let _instancesCache = null;
let _instancesCacheKey = '';

async function getInstances(forceRefresh = false) {
    const base = getBasePath();
    const cacheKey = base;
    if (!forceRefresh && _instancesCache && _instancesCacheKey === cacheKey) {
        return _instancesCache;
    }
    try {
        const raw = await window.electronAPI.instances.list(base);
        const result = raw.map(inst => ({
            dir:        inst.dir,
            instPath:   inst.path,
            label:      (inst.config?.name) || formatLabel(inst.dir),
            icon:       getLoaderIcon(inst.dir),
            modsCount:  inst.config?.modsCount ?? 0,
            ssCount:    inst.config?.ssCount   ?? 0,
            sizeMb:     inst.size != null ? (inst.size / (1024 * 1024)).toFixed(1) : null,
            // Поля из instance.json — доступны как inst.loader, inst.mcVersion и т.д.
            // Если loader не задан в config — определяем из имени папки
            loader:     (inst.config?.loader && inst.config.loader !== 'vanilla')
                ? inst.config.loader
                : (inst.dir.toLowerCase().includes('neoforge') ? 'neoforge'
                  : inst.dir.toLowerCase().includes('forge')   ? 'forge'
                  : inst.dir.toLowerCase().includes('fabric')  ? 'fabric'
                  : inst.dir.toLowerCase().includes('quilt')   ? 'quilt'
                  : (inst.config?.loader || 'vanilla')),
            // Если mcVersion не задан в config — извлекаем из имени папки: minecraft-fabric-1.21.11 → 1.21.11
            mcVersion:  inst.config?.mcVersion
                || (inst.dir.match(/(\d+\.\d+(?:\.\d+)?)(?:[^\d]|$)/) || [])[1]
                || '',
            created:    inst.config?.created     || null,
        }));
        _instancesCache = result;
        _instancesCacheKey = cacheKey;
        return result;
    } catch (err) {
        console.warn('[instances] getInstances IPC error:', err.message);
        return _instancesCache || [];
    }
}

function invalidateInstancesCache() { _instancesCache = null; }

// ─── Размер директории (через IPC, кэш на стороне renderer) ─────────────────

/** @type {Map<string, { sizeMb: string, ts: number }>} */
const _sizeCache = new Map();

function invalidateSizeCache() { _sizeCache.clear(); }

// ─── Progress modal ───────────────────────────────────────────────────────────

/** @param {string} title @returns {{setStatus, setProgress, close}} */
function showProgressModal(title) {
    document.getElementById('inst-progress-modal')?.remove();
    const el = document.createElement('div');
    el.id = 'inst-progress-modal'; el.className = 'inst-progress-overlay';
    el.innerHTML = `
        <div class="inst-progress-box">
            <div class="inst-progress-title" id="inst-progress-title">${title}</div>
            <div class="inst-progress-bar-wrap">
                <div class="inst-progress-bar-track">
                    <div class="inst-progress-bar-fill" id="inst-progress-bar-fill"></div>
                </div>
                <span class="inst-progress-pct" id="inst-progress-pct">0%</span>
            </div>
            <div class="inst-progress-status" id="inst-progress-status">Подготовка...</div>
        </div>
    `;
    document.body.appendChild(el);
    return {
        setStatus(text)  { const s = document.getElementById('inst-progress-status'); if (s) s.textContent = text; },
        setProgress(pct) {
            const fill  = document.getElementById('inst-progress-bar-fill');
            const label = document.getElementById('inst-progress-pct');
            if (fill)  fill.style.width  = `${pct}%`;
            if (label) label.textContent = `${Math.round(pct)}%`;
        },
        close() { document.getElementById('inst-progress-modal')?.remove(); },
    };
}

// ─── Экспорт / импорт (через IPC — пункт 4, убрать child_process) ────────────

/**
 * Экспорт инстанса в ZIP через IPC-обработчик instances:export.
 * Логика запуска zip/powershell — в main-процессе.
 */
async function exportInstance(inst) {
    const result = await window.electronAPI?.openFolderDialog();
    if (!result?.filePaths?.[0]) return;

    const destDir  = result.filePaths[0];
    const progress = showProgressModal(`Экспорт: ${inst.label}`);

    progress.setStatus('Архивирование файлов...');
    progress.setProgress(5);

    // Симуляция прогресса пока идёт архивация в main
    let fakePct = 5;
    const fakeInterval = setInterval(() => {
        fakePct = Math.min(fakePct + (90 - fakePct) * 0.08, 90);
        progress.setProgress(fakePct);
    }, 200);

    try {
        const result2 = await window.electronAPI.instances.export(inst.instPath, destDir);
        clearInterval(fakeInterval);
        progress.setProgress(100);
        progress.setStatus('Готово!');
        await delay(600);
        progress.close();
        showLauncherAlert(`Инстанс экспортирован:\n${result2.destZip}`, 'Готово');
    } catch (err) {
        clearInterval(fakeInterval);
        progress.close();
        // Пункт 3: показываем ошибку пользователю
        showLauncherAlert(`Ошибка экспорта: ${err.message}`, 'Ошибка');
    }
}

/**
 * Импорт инстанса из ZIP через IPC-обработчик instances:import.
 * Логика распаковки — в main-процессе.
 */
async function importInstance() {
    if (!window.electronAPI) return;

    const result = await window.electronAPI.openFile({
        filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
    });
    if (!result?.filePaths?.[0]) return;

    const zipPath  = result.filePaths[0];
    const base     = getBasePath();
    const p        = window.electronAPI.path;
    let destName   = p.basename(zipPath, '.zip');
    if (!destName.startsWith(INSTANCE_PREFIX)) destName = INSTANCE_PREFIX + destName;

    const progress = showProgressModal(`Импорт: ${p.basename(zipPath)}`);
    progress.setStatus('Распаковка архива...');
    progress.setProgress(5);

    let fakePct = 5;
    const fakeInterval = setInterval(() => {
        fakePct = Math.min(fakePct + (90 - fakePct) * 0.08, 90);
        progress.setProgress(fakePct);
    }, 200);

    try {
        const result2 = await window.electronAPI.instances.import(zipPath, base, destName);
        clearInterval(fakeInterval);
        progress.setProgress(100);
        progress.setStatus('Готово!');
        await delay(600);
        progress.close();
        showLauncherAlert(`Инстанс «${result2.destName}» успешно импортирован!`, 'Готово');
        loadInstances();
    } catch (err) {
        clearInterval(fakeInterval);
        progress.close();
        // Пункт 3: показываем ошибку пользователю
        showLauncherAlert(`Ошибка импорта: ${err.message}`, 'Ошибка');
    }
}

// ─── Версии MC и загрузчиков ──────────────────────────────────────────────────

let _mcVersions       = null;
let _mcVersionsCachedAt = 0;

async function fetchMcVersions() {
    if (_mcVersions && Date.now() - _mcVersionsCachedAt < MC_VERSIONS_CACHE_TTL) return _mcVersions;
    const manifest = await fetchJSON(MOJANG_VERSION_MANIFEST).catch(() => null);
    _mcVersions = manifest
        ? manifest.versions.filter(v => v.type === 'release').slice(0, MC_VERSIONS_LIMIT).map(v => v.id)
        : [];
    _mcVersionsCachedAt = Date.now();
    return _mcVersions;
}

async function fetchLoaderVersions(loader, mcVersion) {
    if (loader === 'fabric') {
        const data = await fetchJSON(`${FABRIC_VERSIONS_LOADER}/${mcVersion}`).catch(() => null);
        if (!Array.isArray(data)) return [];
        return data.slice(0, LOADER_VERSIONS_LIMIT).map(e => ({ label: e.loader.version, value: e.loader.version }));
    }
    if (loader === 'quilt') {
        const data = await fetchJSON(QUILT_VERSIONS_LOADER).catch(() => null);
        if (!Array.isArray(data)) return [];
        return data.slice(0, LOADER_VERSIONS_LIMIT).map((v, i) => {
            const ver = v.version || v;
            return { label: `${ver}${i === 0 ? ' (latest)' : ''}`, value: ver };
        });
    }
    if (loader === 'forge') {
        const data = await fetchJSON(FORGE_PROMOTIONS).catch(() => null);
        if (!data?.promos) return [];
        const rec = data.promos[`${mcVersion}-recommended`];
        const lat = data.promos[`${mcVersion}-latest`];
        return [
            rec               ? { label: `${mcVersion}-${rec} (recommended)`, value: `${mcVersion}-${rec}` } : null,
            lat && lat !== rec ? { label: `${mcVersion}-${lat} (latest)`,      value: `${mcVersion}-${lat}` } : null,
        ].filter(Boolean);
    }
    if (loader === 'neoforge') return [{ label: 'latest', value: 'latest' }];
    return [];
}

// ─── Диалог создания инстанса ─────────────────────────────────────────────────

/** @param {string} str @returns {string} Транслитерация + sanitize для имени папки */
function toSafeSlug(str) {
    const cyr = {
        а:'a', б:'b', в:'v', г:'g', д:'d', е:'e', ё:'yo', ж:'zh', з:'z',
        и:'i', й:'j', к:'k', л:'l', м:'m', н:'n', о:'o', п:'p', р:'r',
        с:'s', т:'t', у:'u', ф:'f', х:'kh', ц:'ts', ч:'ch', ш:'sh',
        щ:'sch', ъ:'', ы:'y', ь:'', э:'e', ю:'yu', я:'ya',
    };
    return str.toLowerCase().split('').map(c => cyr[c] ?? c).join('')
        .replace(/[^a-z0-9.]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/** Показывает диалог создания нового инстанса */
function showCreateDialog() {
    document.getElementById('inst-create-modal')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'inst-create-modal'; overlay.className = 'inst-modal-overlay';
    overlay.innerHTML = `
        <div class="inst-modal">
            <div class="inst-modal-header">
                <span class="inst-modal-title">➕ Создать инстанс</span>
                <button class="inst-modal-close" id="inst-modal-close-btn">✕</button>
            </div>
            <div class="inst-modal-body">
                <div class="inst-field">
                    <label class="inst-field-label">Версия Minecraft</label>
                    <select class="inst-select" id="inst-mc-version"><option value="">Загрузка версий...</option></select>
                </div>
                <div class="inst-field">
                    <label class="inst-field-label">Мод-загрузчик</label>
                    <div class="inst-loader-tabs">
                        <button class="inst-loader-tab active" data-loader="vanilla">Vanilla</button>
                        <button class="inst-loader-tab" data-loader="fabric">Fabric</button>
                        <button class="inst-loader-tab" data-loader="forge">Forge</button>
                        <button class="inst-loader-tab" data-loader="neoforge">NeoForge</button>
                        <button class="inst-loader-tab" data-loader="quilt">Quilt</button>
                    </div>
                </div>
                <div class="inst-field" id="inst-loader-version-field" style="display:none">
                    <label class="inst-field-label" id="inst-loader-version-label">Версия загрузчика</label>
                    <select class="inst-select" id="inst-loader-version"><option value="">Выберите версию MC сначала</option></select>
                </div>
                <div class="inst-field">
                    <label class="inst-field-label">Версия Java</label>
                    <select class="inst-select" id="inst-java-version">
                        <option value="auto">Авто (рекомендуется)</option>
                        <option value="8">Java 8</option>
                        <option value="11">Java 11</option>
                        <option value="17">Java 17</option>
                        <option value="21">Java 21</option>
                    </select>
                </div>
                <div class="inst-field">
                    <label class="inst-field-label">Название (необязательно)</label>
                    <input type="text" class="inst-input" id="inst-name-input" placeholder="Оставьте пустым для авто-названия">
                </div>
                <div id="inst-create-error" class="inst-create-error" style="display:none"></div>
            </div>
            <div class="inst-modal-footer">
                <button class="inst-btn" id="inst-cancel-btn">Отмена</button>
                <button class="inst-btn inst-btn-primary" id="inst-create-confirm-btn">
                    <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14">
                        <path fill-rule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clip-rule="evenodd"/>
                    </svg>
                    Создать
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const mcSelect            = overlay.querySelector('#inst-mc-version');
    const loaderVersionField  = overlay.querySelector('#inst-loader-version-field');
    const loaderVersionSelect = overlay.querySelector('#inst-loader-version');
    const loaderVersionLabel  = overlay.querySelector('#inst-loader-version-label');
    const errorEl             = overlay.querySelector('#inst-create-error');
    let   selectedLoader      = 'vanilla';

    fetchMcVersions().then(versions => {
        mcSelect.innerHTML = '<option value="">Выберите версию...</option>';
        for (const v of versions) {
            const opt = document.createElement('option'); opt.value = v; opt.textContent = v; mcSelect.appendChild(opt);
        }
    });

    async function updateLoaderVersions() {
        if (selectedLoader === 'vanilla') { loaderVersionField.style.display = 'none'; return; }
        loaderVersionField.style.display = 'block';
        loaderVersionLabel.textContent = `Версия ${capitalizeLoader(selectedLoader)} Loader`;
        const mcVer = mcSelect.value;
        if (!mcVer) { loaderVersionSelect.innerHTML = '<option value="">Выберите версию MC сначала</option>'; return; }
        loaderVersionSelect.innerHTML = '<option value="">Загрузка...</option>';
        const versions = await fetchLoaderVersions(selectedLoader, mcVer);
        loaderVersionSelect.innerHTML = '';
        if (!versions.length) { loaderVersionSelect.innerHTML = '<option value="">Нет версий для этого MC</option>'; return; }
        for (const { label, value } of versions) {
            const opt = document.createElement('option'); opt.value = value; opt.textContent = label; loaderVersionSelect.appendChild(opt);
        }
    }

    overlay.querySelectorAll('.inst-loader-tab').forEach(tab => {
        tab.addEventListener('click', async () => {
            overlay.querySelectorAll('.inst-loader-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            selectedLoader = tab.dataset.loader;
            await updateLoaderVersions();
        });
    });
    mcSelect.addEventListener('change', updateLoaderVersions);

    function closeModal() { overlay.remove(); }
    overlay.querySelector('#inst-modal-close-btn').addEventListener('click', closeModal);
    overlay.querySelector('#inst-cancel-btn').addEventListener('click', closeModal);
    overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });

    overlay.querySelector('#inst-create-confirm-btn').addEventListener('click', async () => {
        const mcVer     = mcSelect.value;
        const nameInput = overlay.querySelector('#inst-name-input')?.value?.trim() || '';
        const loaderVer = loaderVersionSelect.value;

        if (!mcVer) { errorEl.textContent = 'Выберите версию Minecraft!'; errorEl.style.display = 'block'; return; }
        if (selectedLoader !== 'vanilla' && !loaderVer) { errorEl.textContent = 'Выберите версию загрузчика!'; errorEl.style.display = 'block'; return; }
        errorEl.style.display = 'none';

        const base = getBasePath();
        const p    = window.electronAPI.path;

        let dirName = nameInput
            ? INSTANCE_PREFIX + toSafeSlug(nameInput)
            : selectedLoader === 'vanilla' ? `${INSTANCE_PREFIX}${mcVer}` : `${INSTANCE_PREFIX}${selectedLoader}-${mcVer}`;
        if (dirName === INSTANCE_PREFIX || dirName === 'minecraft') dirName = `${INSTANCE_PREFIX}${selectedLoader}-${mcVer}`;

        // Проверяем существование через IPC (пункт 1)
        let finalDir = dirName; let c = 1;
        while (await window.electronAPI.fs.exists(p.join(base, finalDir))) finalDir = `${dirName}-${c++}`;

        const instPath = p.join(base, finalDir);
        try {
            await window.electronAPI.instances.createDirs(instPath, INSTANCE_SUBDIRS);
            const meta = {
                mcVersion:     mcVer,
                loader:        selectedLoader,
                loaderVersion: loaderVer || null,
                javaVersion:   overlay.querySelector('#inst-java-version')?.value || 'auto',
                created:       new Date().toISOString(),
                name:          nameInput || formatLabel(finalDir),
            };
            await window.electronAPI.instances.writeConfig(instPath, meta);
            closeModal();
            showLauncherAlert(
                `Инстанс «${meta.name}» создан!\n\nЧтобы запустить — откройте список версий и выберите «${meta.name}» в разделе «Мои инстансы».`,
                'Готово'
            );
            invalidateInstancesCache();
            loadInstances();
        } catch (err) {
            // Пункт 3: ошибка видна пользователю
            showLauncherAlert(`Ошибка создания: ${err.message}`, 'Ошибка');
        }
    });
}

// ─── Карточка инстанса ────────────────────────────────────────────────────────

/** @param {object} inst @param {Function} onReload @returns {HTMLElement} */
function buildInstanceCard(inst, onReload) {
    // Мета-данные уже пришли из IPC (instances:list читает instance.json)
    // Достаём их из inst.config если нужно — или читаем через IPC
    const loader      = inst.loader      || 'vanilla';
    const mcVersion   = inst.mcVersion   || '';
    const loaderLabel = capitalizeLoader(loader);
    const createdDate = inst.created
        ? new Date(inst.created).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' })
        : '';

    const card = document.createElement('div'); card.className = 'inst-card';
    card.innerHTML = `
        <div class="inst-card-stripe inst-card-stripe-${loader}"></div>
        <div class="inst-card-body">
            <div class="inst-card-icon-wrap inst-card-icon-wrap-${loader}">${inst.icon}</div>
            <div class="inst-card-info">
                <div class="inst-card-name" title="${inst.label}">${inst.label}</div>
                <div class="inst-card-badges">
                    ${mcVersion ? `<span class="inst-badge inst-badge-mc">MC ${mcVersion}</span>` : ''}
                    <span class="inst-badge inst-badge-${loader}">${loaderLabel}</span>
                </div>
                <div class="inst-card-stats">
                    <span>🧩 ${inst.modsCount} мода</span>
                    <span class="inst-size-stat" data-path="${inst.instPath}">💾 ${inst.sizeMb !== null ? inst.sizeMb + ' MB' : '…'}</span>
                    ${inst.ssCount   ? `<span>📷 ${inst.ssCount}</span>` : ''}
                    ${createdDate    ? `<span>📅 ${createdDate}</span>`  : ''}
                </div>
            </div>
        </div>
        <div class="inst-card-footer">
            <button class="inst-play-btn" data-action="play">
                <svg viewBox="0 0 20 20" fill="currentColor" width="12" height="12"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clip-rule="evenodd"/></svg>
                Играть
            </button>
            <button class="inst-action-btn" data-action="open" title="Открыть папку">
                <svg viewBox="0 0 20 20" fill="currentColor" width="12" height="12"><path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/></svg>
                Папка
            </button>
            <button class="inst-action-btn" data-action="copy" title="Создать копию">
                <svg viewBox="0 0 20 20" fill="currentColor" width="12" height="12"><path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z"/><path d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z"/></svg>
                Копия
            </button>
            <button class="inst-action-btn" data-action="export" title="Экспортировать ZIP">
                <svg viewBox="0 0 20 20" fill="currentColor" width="12" height="12"><path fill-rule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>
                Экспорт
            </button>
            <button class="inst-action-btn inst-action-danger" data-action="delete" title="Удалить инстанс">
                <svg viewBox="0 0 20 20" fill="currentColor" width="12" height="12"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>
            </button>
        </div>
    `;

    card.querySelector('[data-action="play"]').addEventListener('click', () => {
        try { window.VersionsModule.setSelectedVersion(`instance:${inst.dir}`); } catch { /* optional dep */ }
        document.querySelector('.sidebar-item[data-panel="main"], .nav-item[data-tab="main"], [data-tab="main"], [data-target="main-panel"]')?.click();
    });

    card.querySelector('[data-action="open"]').addEventListener('click', () =>
        window.electronAPI?.openPath(inst.instPath)
    );

    // Копия через IPC (пункт 1)
    card.querySelector('[data-action="copy"]').addEventListener('click', async () => {
        const base = getBasePath();
        const p    = window.electronAPI.path;
        let newName = `${inst.dir}-copy`; let c = 1;
        while (await window.electronAPI.fs.exists(p.join(base, newName))) newName = `${inst.dir}-copy${c++}`;
        try {
            await window.electronAPI.fs.copy(inst.instPath, p.join(base, newName));
            showLauncherAlert(`Скопировано как «${formatLabel(newName)}»`, 'Готово');
            onReload();
        } catch (err) {
            showLauncherAlert(`Ошибка: ${err.message}`, 'Ошибка');
        }
    });

    card.querySelector('[data-action="export"]').addEventListener('click', () => exportInstance(inst));

    card.querySelector('[data-action="delete"]').addEventListener('click', () => {
        showLauncherConfirm(
            `Удалить «${inst.label}»?\nВсе данные будут удалены безвозвратно!`,
            'Удалить'
        ).then(async ok => {
            if (!ok) return;
            const progress = showProgressModal(`Удаление: ${inst.label}`);
            progress.setStatus('Удаление файлов...');
            let fakePct = 0;
            const fakeInterval = setInterval(() => { fakePct = Math.min(fakePct + 8, 90); progress.setProgress(fakePct); }, 80);
            try {
                await window.electronAPI.instances.delete(inst.instPath);
                clearInterval(fakeInterval);
                progress.setProgress(100); progress.setStatus('Готово!');
                await delay(500); progress.close(); onReload();
            } catch (err) {
                clearInterval(fakeInterval); progress.close();
                showLauncherAlert(`Ошибка: ${err.message}`, 'Ошибка');
            }
        });
    });

    return card;
}

// ─── Рендер ───────────────────────────────────────────────────────────────────

/** Перечитывает список инстансов через IPC и рендерит грид */
async function loadInstances() {
    const grid  = document.getElementById('instances-grid');
    const empty = document.getElementById('instances-empty');
    if (!grid) return;

    const instances = await getInstances();

    if (!instances.length) {
        grid.innerHTML = '';
        if (empty) empty.style.display = 'flex';
        return;
    }

    if (empty) empty.style.display = 'none';
    grid.innerHTML = '';
    const fragment = document.createDocumentFragment();
    instances.forEach(inst => fragment.appendChild(buildInstanceCard(inst, loadInstances)));
    grid.appendChild(fragment);
}

// ─── Инициализация ────────────────────────────────────────────────────────────

/** Инициализирует панель инстансов */
function initInstances() {
    document.getElementById('inst-import-btn')?.addEventListener('click', importInstance);
    document.getElementById('inst-create-btn')?.addEventListener('click', showCreateDialog);

    // Watcher убран из renderer — main-процесс может слать событие instances:changed
    // через ipcRenderer.on если нужно авто-обновление. Для простоты: обновляем по переключению вкладки.
    document.addEventListener('panel-switched', e => {
        if (e.detail?.tab === 'instances') loadInstances();
    });
}

// ─────────────────────────────────────────────────────────────────────────────

// Dual export: window.* для renderer, module.exports для Node.js/main
const _Instances = { initInstances, loadInstances };
if (typeof window !== 'undefined') { window.Instances = _Instances; }
if (typeof module !== 'undefined' && module.exports) { module.exports = _Instances; }
})();
