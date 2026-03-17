(function() {
'use strict';

/**
 * Панель модов — поиск Modrinth, установка, управление, текстуры, шейдеры
 * @module renderer/mods-panel
 *
 * РЕФАКТОРИНГ БЕЗОПАСНОСТИ (пункты 1, 2, 3):
 *   - Удалены все require('fs'), require('path'), require('os'), require('adm-zip'),
 *     require('https'), require('http') из renderer-кода
 *   - Вся файловая и бизнес-логика вынесена в main-процесс и вызывается через IPC
 *   - setModEnabled / setModDisabled / enableMod переведены в async (IPC-вызовы)
 *   - Ошибки в критичных местах показываются пользователю через showLauncherAlert
 *   - Готово к contextIsolation: true / nodeIntegration: false
 */

'use strict';

const { escapeHtml } = window.RendererUtils;
const {
    showToast, showLauncherAlert, showLauncherConfirm,
    showModsSkeleton
} = window.UiHelpers;
const { getSelectedVersion, setSelectedVersion, versionHasModLoader } = window.VersionsModule;

// ─── КОНСТАНТЫ ───────────────────────────────────────────────────────────────
const {
    MODRINTH_API,
    MODRINTH_USER_AGENT,
    MYMEMORY_TRANSLATE_API,
    STORAGE_KEYS,
    DEFAULT_VERSION_ID,
    EVACUATION_MC_VERSION,
} = window.RendererConstants;

const MODRINTH_API_TIMEOUT_MS   = 10_000;
const MODRINTH_SEARCH_LIMIT     = 24;
const MODRINTH_DESC_PREVIEW_LEN = 120;
const MODRINTH_DESC_FULL_LEN    = 500;
const VERSION_STORAGE_KEY       = STORAGE_KEYS.selectedVersion;
const DEFAULT_MC_VERSION        = EVACUATION_MC_VERSION;

// ─── УТИЛИТЫ ПУТЕЙ (через window.electronAPI) ────────────────────────────────

/** @returns {string} Базовый путь лаунчера */
function getBasePath() {
    const saved = localStorage.getItem('minecraft-path');
    if (saved) return saved;
    // Фоллбэк: вычисляем дефолтный путь если пользователь ещё не сохранял настройки
    try {
        const platform = window.electronAPI.os.platform();
        const homedir  = window.electronAPI.os.homedir();
        const appdata  = window.electronAPI.env.APPDATA;
        const p        = window.electronAPI.path;
        if (platform === 'win32') return p.join(appdata || p.join(homedir, 'AppData', 'Roaming'), '.fixlauncher');
        if (platform === 'darwin') return p.join(homedir, 'Library', 'Application Support', 'fixlauncher');
        return p.join(homedir, '.fixlauncher');
    } catch { return ''; }
}

/** @param {string} versionId @returns {string} Путь к папке mods */
function getModsPathForVersion(versionId) {
    const p = window.electronAPI.path;
    const basePath = getBasePath();
    let folderName;
    if (versionId.startsWith('instance:')) folderName = versionId.slice('instance:'.length);
    else folderName = 'minecraft-' + String(versionId).replace(/:/g, '-').replace(/[^a-zA-Z0-9.-]/g, '-');
    return p.join(basePath, folderName, 'mods');
}

/** @param {string} versionId @returns {string} Путь к папке данных версии */
function getDataPathForVersion(versionId) {
    const p = window.electronAPI.path;
    const basePath = getBasePath();
    let folderName;
    if (versionId.startsWith('instance:')) folderName = versionId.slice('instance:'.length);
    else folderName = 'minecraft-' + String(versionId).replace(/:/g, '-').replace(/[^a-zA-Z0-9.-]/g, '-');
    return p.join(basePath, folderName);
}

/** @param {string} versionId @returns {string} Путь к папке resourcepacks */
function getResourcePacksPathForVersion(versionId) {
    return window.electronAPI.path.join(getDataPathForVersion(versionId), 'resourcepacks');
}

/** @param {string} versionId @returns {string} Путь к папке shaderpacks */
function getShadersPathForVersion(versionId) {
    return window.electronAPI.path.join(getDataPathForVersion(versionId), 'shaderpacks');
}

// ─── РАБОТА С МОДАМИ ЧЕРЕЗ IPC ────────────────────────────────────────────────

/**
 * Список установленных модов — делегируем в main-процесс (mods:list).
 * Логика чтения директории и парсинга метаданных живёт в src/mods.js и main.js.
 * @param {string} versionId
 * @returns {Promise<object[]>}
 */
async function listInstalledMods(versionId) {
    const basePath = getBasePath();
    try {
        const result = await window.electronAPI.mods.list(versionId, basePath);
        // mods:list возвращает { ok, mods } — достаём массив
        let mods = [];
        if (result && Array.isArray(result.mods)) mods = result.mods;
        else if (Array.isArray(result)) mods = result;
        // Нормализуем: main process возвращает поле 'path', renderer ждёт 'filePath'
        return mods.map(m => ({
            ...m,
            filePath: m.filePath || m.path || '',
            fileName: m.fileName || m.file || (m.path ? m.path.split(/[\/]/).pop() : ''),
        }));
    } catch (err) {
        console.warn('[mods-panel] listInstalledMods IPC error:', err.message);
        return [];
    }
}

/**
 * Включить/отключить мод через IPC (async, пункт 3).
 * @param {string} filePath
 * @param {boolean} enable
 */
async function toggleMod(filePath, enable) {
    await window.electronAPI.mods.toggle(filePath, enable);
}



// ─── MODRINTH API (через fetch, без require('https')) ────────────────────────

/** @returns {Promise<object>} JSON-ответ Modrinth API */
async function modrinthFetch(endpoint, options = {}) {
    const url = endpoint.startsWith('http') ? endpoint : MODRINTH_API + endpoint;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MODRINTH_API_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': MODRINTH_USER_AGENT, ...(options.headers || {}) },
        });
        clearTimeout(timer);
        if (res.status === 429) throw new Error('Слишком много запросов к Modrinth, подождите немного');
        if (!res.ok)            throw new Error(`Modrinth вернул ошибку: HTTP ${res.status}`);
        return await res.json();
    } catch (e) {
        clearTimeout(timer);
        if (e.name === 'AbortError')
            throw new Error('Превышено время ожидания (10с). Проверьте интернет-соединение.');
        throw e;
    }
}

/** @returns {Promise<object>} Результаты поиска Modrinth */
function searchModrinth(query, gameVersion, loader, limit = 20, projectType = 'mod') {
    const facets = [[`project_type:${projectType}`]];
    if (gameVersion) facets.push([`versions:${gameVersion}`]);
    if (loader)      facets.push([`categories:${loader.toLowerCase()}`]);
    const q = new URLSearchParams({ query: query || '', limit: String(limit), facets: JSON.stringify(facets) });
    return modrinthFetch(`/search?${q.toString()}`);
}

/** @returns {Promise<object[]>} Версии проекта */
function getModrinthProjectVersions(projectIdOrSlug, gameVersions, loaders) {
    const params = new URLSearchParams();
    if (gameVersions?.length) params.set('game_versions', JSON.stringify(gameVersions));
    if (loaders?.length)      params.set('loaders', JSON.stringify(loaders));
    const q = params.toString();
    return modrinthFetch(`/project/${encodeURIComponent(projectIdOrSlug)}/version${q ? '?' + q : ''}`);
}

/** @returns {Promise<object>} Мета-данные проекта */
function getModrinthProject(projectIdOrSlug) {
    return modrinthFetch(`/project/${encodeURIComponent(projectIdOrSlug)}`);
}

/** Установить один мод (с транзитивными зависимостями) */
function installOneModFromModrinth(projectIdOrSlug, gameVersions, loaders, modsPath, _installedSet) {
    const installedSet = _installedSet || new Set();
    const key = String(projectIdOrSlug).toLowerCase();
    if (installedSet.has(key)) return Promise.resolve({ skipped: true });
    installedSet.add(key);

    return getModrinthProjectVersions(projectIdOrSlug, gameVersions, loaders).then(versions => {
        if (!versions?.length) return Promise.reject(new Error('Нет подходящей версии для ' + projectIdOrSlug));
        const v = versions[0];
        const primaryFile = (v.files || []).find(f => f.primary) || (v.files || [])[0];
        if (!primaryFile?.url) return Promise.reject(new Error('Нет файла для загрузки: ' + projectIdOrSlug));

        const p = window.electronAPI.path;
        const fileName = primaryFile.filename || p.basename(primaryFile.url) || `mod-${v.id}.jar`;
        const destPath = p.join(modsPath, fileName);

        const transitiveDeps = (v.dependencies || []).filter(d => d.dependency_type === 'required' && d.project_id);
        const uniqueTransitive = [...new Set(transitiveDeps.map(d => d.project_id))].filter(pid => !installedSet.has(pid.toLowerCase()));

        let chain = window.electronAPI.fs.mkdir(modsPath, { recursive: true }).catch(() => {});
        uniqueTransitive.forEach(pid => {
            chain = chain.then(() => installOneModFromModrinth(pid, gameVersions, loaders, modsPath, installedSet))
                .catch(err => console.warn('Transitive dep install failed:', pid, err));
        });
        return chain.then(() => downloadModFile(primaryFile.url, destPath, null));
    });
}

/** Рекурсивно собирает список всех зависимостей */
function collectAllDepsInfo(projectIdOrSlug, gameVersions, loaders, _visited) {
    const visited = _visited || new Set();
    const key = String(projectIdOrSlug).toLowerCase();
    if (visited.has(key)) return Promise.resolve([]);
    visited.add(key);

    return getModrinthProjectVersions(projectIdOrSlug, gameVersions, loaders).then(versions => {
        if (!versions?.length) return [];
        const v = versions[0];
        const directDeps = (v.dependencies || []).filter(d => d.dependency_type === 'required' && d.project_id);
        const uniquePids = [...new Set(directDeps.map(d => d.project_id))].filter(pid => !visited.has(pid.toLowerCase()));
        if (!uniquePids.length) return [];
        return Promise.all(uniquePids.map(pid =>
            getModrinthProject(pid).then(proj => ({ project_id: pid, title: proj?.title || pid })).catch(() => ({ project_id: pid, title: pid }))
        )).then(infos =>
            Promise.all(infos.map(info =>
                collectAllDepsInfo(info.project_id, gameVersions, loaders, visited).then(sub => [info, ...sub])
            )).then(results => results.flat())
        );
    }).catch(() => []);
}

/**
 * Скачать файл через IPC download:file (убрана зависимость от require('https')).
 * @param {string} url
 * @param {string} destPath
 * @param {Function|null} onProgress
 */
function downloadModFile(url, destPath, onProgress) {
    const id = window.electronAPI.crypto.randomId();
    let unsub = null;
    if (onProgress) unsub = window.electronAPI.on.downloadProgress(id, ({ received, total }) => onProgress(received, total));
    return window.electronAPI.download.file(url, destPath, id).finally(() => { if (unsub) unsub(); });
}

// ─── INLINE PROGRESS BAR ─────────────────────────────────────────────────────

function createInlineProgress(containerEl) {
    const wrap = document.createElement('div'); wrap.className = 'mod-dl-progress-wrap';
    const bar  = document.createElement('div'); bar.className  = 'mod-dl-progress-bar';
    const txt  = document.createElement('div'); txt.className  = 'mod-dl-progress-text';
    wrap.appendChild(bar); wrap.appendChild(txt);
    if (containerEl) containerEl.appendChild(wrap);
    return {
        update(received, total) {
            const pct = total ? Math.round(received / total * 100) : 0;
            bar.style.width = pct + '%';
            txt.textContent = `${(received / 1048576).toFixed(1)} / ${total ? (total / 1048576).toFixed(1) : '?'} MB`;
        },
        remove() { wrap.remove(); }
    };
}

// ─── РЕНДЕР УСТАНОВЛЕННЫХ МОДОВ ───────────────────────────────────────────────

let modsPanelLoaded = false;
let cachedInstalledMods = [];

function renderInstalledModsList(mods, searchQuery) {
    const innerEl   = document.getElementById('mods-installed-list-inner');
    const loadingEl = document.getElementById('mods-installed-loading');
    const errorEl   = document.getElementById('mods-installed-error');
    if (!innerEl) return;
    if (loadingEl) loadingEl.style.display = 'none';
    if (errorEl)  { errorEl.style.display = 'none'; errorEl.textContent = ''; }

    const q        = (searchQuery || '').toLowerCase().trim();
    const filtered = q ? mods.filter(m => (m.name?.toLowerCase().includes(q)) || (m.fileName?.toLowerCase().includes(q))) : mods;

    innerEl.innerHTML = '';
    if (!filtered.length) {
        const empty = document.createElement('div');
        empty.className   = 'mods-empty';
        empty.textContent = q ? 'По запросу ничего не найдено.' : 'В этой версии пока нет установленных модов. Добавьте их через вкладку «Скачать моды».';
        innerEl.appendChild(empty);
        return;
    }

    filtered.forEach(mod => {
        const card = document.createElement('div');
        card.className = 'mod-card mod-card-installed';
        const status = mod.enabled ? 'Включён' : 'Отключён';
        card.innerHTML = `
            <div class="mod-card-main">
                <div class="mod-card-info">
                    <span class="mod-card-name">${escapeHtml(mod.name || mod.fileName)}</span>
                    <span class="mod-card-meta">${escapeHtml(mod.version)} · ${escapeHtml(mod.loader || '—')}</span>
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

    // Тоггл — async IPC (пункт 1 & 3)
    innerEl.querySelectorAll('.mod-toggle').forEach(cb => {
        cb.addEventListener('change', async function () {
            const filePath = this.getAttribute('data-path');
            if (!filePath) return;
            this.disabled = true;
            try {
                await toggleMod(filePath, this.checked);
                await refreshInstalledModsList();
            } catch (e) {
                showLauncherAlert('Ошибка: ' + (e.message || 'не удалось изменить состояние мода'));
                this.checked = !this.checked;
            } finally {
                this.disabled = false;
            }
        });
    });

    innerEl.querySelectorAll('.mod-btn-detail').forEach(btn => {
        btn.addEventListener('click', function () {
            const mod = mods.find(m => m.filePath === this.getAttribute('data-path'));
            if (mod) showModDetail(mod);
        });
    });

    // Удаление — async IPC (пункт 1 & 3)
    innerEl.querySelectorAll('.mod-btn-delete').forEach(btn => {
        btn.addEventListener('click', function () {
            const filePath = this.getAttribute('data-path');
            if (!filePath) return;
            showLauncherConfirm('Удалить этот мод? Файл будет удалён безвозвратно.', 'Удаление мода').then(async ok => {
                if (!ok) return;
                try {
                    await window.electronAPI.mods.delete(filePath);
                    await refreshInstalledModsList();
                } catch (e) {
                    showLauncherAlert('Ошибка удаления: ' + (e.message || e));
                }
            });
        });
    });
}

/** Перечитывает список модов через IPC и перерисовывает UI */
async function refreshInstalledModsList() {
    const versionId = localStorage.getItem(VERSION_STORAGE_KEY) || DEFAULT_VERSION_ID;
    try {
        cachedInstalledMods = await listInstalledMods(versionId);
    } catch (e) {
        showLauncherAlert('Не удалось загрузить список модов: ' + (e.message || e));
        cachedInstalledMods = [];
    }
    const searchInput = document.getElementById('mods-search');
    renderInstalledModsList(cachedInstalledMods, searchInput?.value || '');
}

function refreshInstalledTexturesList() { loadTexturesList(); }
function refreshInstalledShadersList()  { loadShadersList(); }

// ─── ПЕРЕВОД ──────────────────────────────────────────────────────────────────

const translationCache = new Map();

/** @returns {boolean} true если текст преимущественно кириллический */
function isMostlyCyrillic(text) {
    if (!text || typeof text !== 'string') return false;
    const letters = text.replace(/\s/g, '').replace(/[0-9\W]/g, '');
    if (letters.length < 3) return false;
    return ((letters.match(/[\u0400-\u04FF]/g) || []).length / letters.length) >= 0.3;
}

/** @returns {Promise<string>} Перевод или оригинал */
async function translateToRussian(text) {
    if (!text || typeof text !== 'string') return text;
    const key = text.slice(0, 400);
    if (translationCache.has(key)) return translationCache.get(key);
    const url = MYMEMORY_TRANSLATE_API + '?q=' + encodeURIComponent(text.slice(0, MODRINTH_DESC_FULL_LEN)) + '&langpair=en|ru';
    try {
        const res  = await fetch(url, { signal: AbortSignal.timeout(8000) });
        const json = await res.json();
        const translated = (json.responseData?.translatedText) || text;
        translationCache.set(key, translated);
        return translated;
    } catch { return text; }
}

// ─── ДЕТАЛЬНАЯ КАРТОЧКА МОДА ──────────────────────────────────────────────────

function showModDetail(mod) {
    const overlay = document.getElementById('mods-detail-overlay');
    const titleEl = document.getElementById('mods-detail-title');
    const bodyEl  = document.getElementById('mods-detail-body');
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
        if (descEl) { descEl.textContent = 'Перевод…'; translateToRussian(mod.description).then(tr => { if (descEl) descEl.textContent = tr; }); }
    }
}

// ─── ЗАГРУЗКА ПАНЕЛИ МОДОВ ────────────────────────────────────────────────────

/** Инициализирует панель модов */
let _lastModsVersionId = null;

async function loadModsPanel() {
    const version = getSelectedVersion();
    const versionValueEl = document.getElementById('mods-version-value');
    if (versionValueEl) versionValueEl.textContent = `${version.icon || '📦'} ${version.label}`;

    const noLoaderWarning = document.getElementById('mods-warning-noloader');
    if (noLoaderWarning) noLoaderWarning.style.display = versionHasModLoader(version) ? 'none' : 'block';

    if (!modsPanelLoaded) { initModsPanel(); modsPanelLoaded = true; }

    // Создаём папку модов через IPC
    try { await window.electronAPI.fs.mkdir(getModsPathForVersion(version.id), { recursive: true }); } catch { /* ignore */ }

    const versionChanged = _lastModsVersionId !== version.id;
    _lastModsVersionId = version.id;

    if (versionChanged) {
        // Версия сменилась — перезагружаем всё
        showModsSkeleton();
        refreshInstalledModsList();
        loadTexturesList();
        loadShadersList();
    } else {
        // Та же версия — только обновляем список модов (быстро)
        refreshInstalledModsList();
    }
}

// ─── ТЕКСТУРЫ ─────────────────────────────────────────────────────────────────

/** Читает список текстурных паков через IPC */
async function loadTexturesList() {
    const version           = getSelectedVersion();
    const resourcePacksPath = getResourcePacksPathForVersion(version.id);
    const innerEl   = document.getElementById('textures-installed-list-inner');
    const loadingEl = document.getElementById('textures-installed-loading');
    const errorEl   = document.getElementById('textures-installed-error');

    try {
        await window.electronAPI.fs.mkdir(resourcePacksPath, { recursive: true });
        const entries = await window.electronAPI.fs.readdir(resourcePacksPath);
        const files   = entries.filter(e => e.name.endsWith('.zip') || e.name.endsWith('.jar') || e.isDirectory).map(e => e.name);

        if (loadingEl) loadingEl.style.display = 'none';
        if (!innerEl) return;
        innerEl.innerHTML = '';

        if (!files.length) { innerEl.innerHTML = '<div class="mods-empty">Текстур не найдено. Поместите файлы текстур в папку resourcepacks.</div>'; return; }

        const fragment = document.createDocumentFragment();
        files.forEach(fileName => {
            const filePath = window.electronAPI.path.join(resourcePacksPath, fileName);
            const card = document.createElement('div'); card.className = 'mod-card';
            card.innerHTML = `
                <div class="mod-card-main">
                    <div class="mod-card-info">
                        <span class="mod-card-name">${escapeHtml(fileName)}</span>
                        <span class="mod-card-meta">Текстурный пак</span>
                    </div>
                    <div class="mod-card-actions">
                        <div class="mod-card-status">Установлено</div>
                        <button type="button" class="mod-btn-delete" data-path="${escapeHtml(filePath)}" title="Удалить">🗑</button>
                    </div>
                </div>
            `;
            card.querySelector('.mod-btn-delete').addEventListener('click', () => {
                showLauncherConfirm('Удалить этот текстурный пак?', 'Удаление').then(async ok => {
                    if (!ok) return;
                    try { await window.electronAPI.fs.unlink(filePath); }
                    catch (e) { showLauncherAlert('Не удалось удалить текстуры: ' + (e.message || e)); }
                    loadTexturesList();
                });
            });
            fragment.appendChild(card);
        });
        innerEl.appendChild(fragment);
        if (errorEl) errorEl.style.display = 'none';
    } catch (err) {
        if (loadingEl) loadingEl.style.display = 'none';
        if (errorEl) { errorEl.textContent = 'Ошибка: ' + (err.message || 'неизвестная ошибка'); errorEl.style.display = 'block'; }
    }
}

// ─── ШЕЙДЕРЫ ─────────────────────────────────────────────────────────────────

/** Читает список шейдерных паков через IPC */
async function loadShadersList() {
    const version         = getSelectedVersion();
    const shaderPacksPath = getShadersPathForVersion(version.id);
    const innerEl   = document.getElementById('shaders-installed-list-inner');
    const loadingEl = document.getElementById('shaders-installed-loading');
    const errorEl   = document.getElementById('shaders-installed-error');

    try {
        await window.electronAPI.fs.mkdir(shaderPacksPath, { recursive: true });
        const entries = await window.electronAPI.fs.readdir(shaderPacksPath);
        const files   = entries.filter(e => e.name.endsWith('.zip') || e.name.endsWith('.jar') || e.isDirectory).map(e => e.name);

        if (loadingEl) loadingEl.style.display = 'none';
        if (!innerEl) return;
        innerEl.innerHTML = '';

        if (!files.length) { innerEl.innerHTML = '<div class="mods-empty">Шейдеров не найдено. Поместите файлы шейдеров в папку shaderpacks.</div>'; return; }

        const fragment = document.createDocumentFragment();
        files.forEach(fileName => {
            const filePath = window.electronAPI.path.join(shaderPacksPath, fileName);
            const card = document.createElement('div'); card.className = 'mod-card';
            card.innerHTML = `
                <div class="mod-card-main">
                    <div class="mod-card-info">
                        <span class="mod-card-name">${escapeHtml(fileName)}</span>
                        <span class="mod-card-meta">Шейдерный пак</span>
                    </div>
                    <div class="mod-card-actions">
                        <div class="mod-card-status">Установлено</div>
                        <button type="button" class="mod-btn-delete" data-path="${escapeHtml(filePath)}" title="Удалить">🗑</button>
                    </div>
                </div>
            `;
            card.querySelector('.mod-btn-delete').addEventListener('click', () => {
                showLauncherConfirm('Удалить этот шейдерный пак?', 'Удаление').then(async ok => {
                    if (!ok) return;
                    try { await window.electronAPI.fs.unlink(filePath); }
                    catch {
                        // Папка: удаляем рекурсивно через instances:delete
                        try { await window.electronAPI.instances.delete(filePath); }
                        catch (e) { showLauncherAlert('Не удалось удалить шейдеры: ' + (e.message || e)); }
                    }
                    loadShadersList();
                });
            });
            fragment.appendChild(card);
        });
        innerEl.appendChild(fragment);
        if (errorEl) errorEl.style.display = 'none';
    } catch (err) {
        if (loadingEl) loadingEl.style.display = 'none';
        if (errorEl) { errorEl.textContent = 'Ошибка: ' + (err.message || 'неизвестная ошибка'); errorEl.style.display = 'block'; }
    }
}

// ─── ИНИЦИАЛИЗАЦИЯ ПАНЕЛИ ────────────────────────────────────────────────────

function initModsPanel() {
    document.querySelectorAll('.mods-subtab').forEach(tab => {
        tab.addEventListener('click', function () {
            const t = this.getAttribute('data-modstab');
            document.querySelectorAll('.mods-subtab').forEach(x => x.classList.remove('active'));
            this.classList.add('active');
            ['mods-section-mods','mods-section-textures','mods-section-shaders'].forEach(id => {
                const el = document.getElementById(id); if (el) el.style.display = 'none';
            });
            let target = null;
            if (t === 'mods')     target = document.getElementById('mods-section-mods');
            else if (t === 'textures') target = document.getElementById('mods-section-textures');
            else if (t === 'shaders')  target = document.getElementById('mods-section-shaders');
            if (target) { target.style.display = 'block'; target.style.animation = 'none'; void target.offsetWidth; target.style.animation = ''; }
        });
    });

    const searchInput = document.getElementById('mods-search');
    if (searchInput) searchInput.addEventListener('input', () => renderInstalledModsList(cachedInstalledMods, searchInput.value));

    ['textures', 'shaders'].forEach(type => {
        const inp = document.getElementById(`${type}-search`);
        if (inp) inp.addEventListener('input', () => {
            const q = inp.value.toLowerCase();
            document.querySelectorAll(`#${type}-installed-list-inner .mod-card`).forEach(c => {
                c.style.display = c.querySelector('.mod-card-name').textContent.toLowerCase().includes(q) ? '' : 'none';
            });
        });
    });

    let _texturesToken = 0, _shadersToken = 0, _modsToken = 0;

    // ── Poisk textur na Modrinth
    const texBtn = document.getElementById('textures-modrinth-search-btn');
    const texInp = document.getElementById('textures-modrinth-search');
    const texGrid = document.getElementById('textures-download-grid');
    const texLoad = document.getElementById('textures-download-loading');
    const texErr  = document.getElementById('textures-download-error');
    const texPH   = document.getElementById('textures-download-placeholder');

    function doTexturesSearch() {
        const query = texInp?.value.trim() || '';
        if (!query) return;
        const token = ++_texturesToken;
        const gv = getSelectedVersion().mcVersion || DEFAULT_MC_VERSION;
        if (texPH)   texPH.style.display   = 'none';
        if (texErr)  texErr.style.display   = 'none';
        if (texLoad) texLoad.style.display  = 'block';
        if (texGrid) texGrid.innerHTML      = '';
        searchModrinth(query, gv, null, MODRINTH_SEARCH_LIMIT, 'resourcepack')
            .then(data => { if (token !== _texturesToken) return; if (texLoad) texLoad.style.display = 'none'; renderModrinthGrid(data.hits || [], texGrid, 'resourcepack'); })
            .catch(err => { if (texLoad) texLoad.style.display = 'none'; if (texErr) { texErr.textContent = '❌ ' + (err.message || 'Ошибка'); texErr.style.display = 'block'; } });
    }
    if (texBtn) texBtn.addEventListener('click', doTexturesSearch);
    if (texInp) texInp.addEventListener('keydown', e => { if (e.key === 'Enter') doTexturesSearch(); });

    // ── Поиск шейдеров на Modrinth
    const shBtn = document.getElementById('shaders-modrinth-search-btn');
    const shInp = document.getElementById('shaders-modrinth-search');
    const shGrid = document.getElementById('shaders-download-grid');
    const shLoad = document.getElementById('shaders-download-loading');
    const shErr  = document.getElementById('shaders-download-error');
    const shPH   = document.getElementById('shaders-download-placeholder');

    function doShadersSearch() {
        const query = shInp?.value.trim() || '';
        if (!query) return;
        const token = ++_shadersToken;
        const gv = getSelectedVersion().mcVersion || DEFAULT_MC_VERSION;
        if (shPH)   shPH.style.display   = 'none';
        if (shErr)  shErr.style.display   = 'none';
        if (shLoad) shLoad.style.display  = 'block';
        if (shGrid) shGrid.innerHTML      = '';
        searchModrinth(query, gv, null, MODRINTH_SEARCH_LIMIT, 'shader')
            .then(data => { if (token !== _shadersToken) return; if (shLoad) shLoad.style.display = 'none'; renderModrinthGrid(data.hits || [], shGrid, 'shader'); })
            .catch(err => { if (shLoad) shLoad.style.display = 'none'; if (shErr) { shErr.textContent = '❌ ' + (err.message || 'Ошибка'); shErr.style.display = 'block'; } });
    }
    if (shBtn) shBtn.addEventListener('click', doShadersSearch);
    if (shInp) shInp.addEventListener('keydown', e => { if (e.key === 'Enter') doShadersSearch(); });

    document.getElementById('mods-detail-close')?.addEventListener('click', () => { const o = document.getElementById('mods-detail-overlay'); if (o) o.style.display = 'none'; });
    document.getElementById('mods-detail-overlay')?.addEventListener('click', function (e) { if (e.target === this) this.style.display = 'none'; });

    function setupModsTabs(prefix) {
        const tabs = document.querySelectorAll(`[data-modstab-view^="${prefix}-"]`);
        const vi = document.getElementById(prefix === 'mods' ? 'mods-view-installed' : `mods-view-${prefix}-installed`);
        const vs = document.getElementById(prefix === 'mods' ? 'mods-view-search'    : `mods-view-${prefix}-search`);
        tabs.forEach(tab => tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active')); tab.classList.add('active');
            const tv = tab.getAttribute('data-modstab-view');
            if (tv === `${prefix}-installed`) { if (vi) vi.style.display = 'flex'; if (vs) vs.style.display = 'none'; }
            else                              { if (vi) vi.style.display = 'none'; if (vs) vs.style.display = 'flex'; }
        }));
    }
    setupModsTabs('mods'); setupModsTabs('textures'); setupModsTabs('shaders');

    // ── Поиск модов на Modrinth
    const mBtn  = document.getElementById('mods-modrinth-search-btn');
    const mInp  = document.getElementById('mods-modrinth-search');
    const mGrid = document.getElementById('mods-download-grid');
    const mLoad = document.getElementById('mods-download-loading');
    const mErr  = document.getElementById('mods-download-error');
    const mPH   = document.getElementById('mods-download-placeholder');

    function getLoaderForModrinth(v) {
        const t = (v?.type || '').toLowerCase();
        if (t === 'neoforge') return 'neoforge';
        if (t === 'forge' || t === 'legacy_forge') return 'forge';
        return 'fabric';
    }

    function doModsSearch() {
        const query = mInp?.value.trim() || '';
        if (!query) return;
        const token = ++_modsToken;
        const version = getSelectedVersion();
        const gv = version.mcVersion || DEFAULT_MC_VERSION;
        if (mPH)   mPH.style.display   = 'none';
        if (mErr)  mErr.style.display   = 'none';
        if (mLoad) mLoad.style.display  = 'block';
        if (mGrid) mGrid.innerHTML      = '';
        searchModrinth(query, gv, getLoaderForModrinth(version), MODRINTH_SEARCH_LIMIT)
            .then(data => { if (token !== _modsToken) return; if (mLoad) mLoad.style.display = 'none'; renderModrinthGrid(data.hits || [], mGrid, 'mod'); })
            .catch(err => { if (mLoad) mLoad.style.display = 'none'; if (mErr) { mErr.textContent = '❌ ' + (err.message || 'Ошибка'); mErr.style.display = 'block'; } });
    }
    if (mBtn) mBtn.addEventListener('click', doModsSearch);
    if (mInp) mInp.addEventListener('keydown', e => { if (e.key === 'Enter') doModsSearch(); });

    window.installModFromModrinth = installModFromModrinth;
}

// ─── ВСПОМОГАТЕЛЬНАЯ: рендер сетки Modrinth ──────────────────────────────────

function renderModrinthGrid(hits, gridEl, projectType) {
    if (!gridEl) return;
    hits.forEach(project => {
        const card = document.createElement('div'); card.className = 'mod-card mod-card-download';
        const desc = (project.description || '').slice(0, MODRINTH_DESC_PREVIEW_LEN) + ((project.description || '').length > MODRINTH_DESC_PREVIEW_LEN ? '…' : '');
        const icon = project.icon_url
            ? `<img src="${escapeHtml(project.icon_url)}" alt="" class="mod-download-icon">`
            : '<span class="mod-download-icon mod-download-icon-placeholder">📦</span>';
        card.innerHTML = `
            <div class="mod-download-icon-wrap">${icon}</div>
            <div class="mod-download-info">
                <span class="mod-download-name">${escapeHtml(project.title || project.project_id)}</span>
                <div class="mod-download-desc-wrap">
                    <span class="mod-download-desc" data-original-desc="${escapeHtml((project.description || '').slice(0, MODRINTH_DESC_FULL_LEN))}">${escapeHtml(desc)}</span>
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
            const wrap   = this.closest('.mod-download-desc-wrap');
            const descEl = wrap?.querySelector('.mod-download-desc');
            const original = descEl?.getAttribute('data-original-desc');
            if (!original) return;
            this.disabled = true; this.textContent = '…';
            translateToRussian(original).then(tr => {
                if (descEl) descEl.textContent = tr.slice(0, MODRINTH_DESC_PREVIEW_LEN) + (tr.length > MODRINTH_DESC_PREVIEW_LEN ? '…' : '');
                this.remove();
            }).catch(() => { this.disabled = false; this.textContent = 'Ru'; });
        });
    });
    gridEl.querySelectorAll('.mod-btn-install').forEach(btn => {
        btn.addEventListener('click', function () {
            installModFromModrinth(this.getAttribute('data-project-id') || this.getAttribute('data-slug'), this, projectType);
        });
    });
}

// ─── УСТАНОВКА МОДА С MODRINTH ────────────────────────────────────────────────

async function installModFromModrinth(projectIdOrSlug, buttonEl, projectType = 'mod') {
    const version = getSelectedVersion();
    const gameVersions = [version.mcVersion || DEFAULT_MC_VERSION];
    const loaders = [];
    if (projectType === 'mod') {
        if (['custom','fabric'].includes(version.type)) loaders.push('fabric');
        else if (version.type === 'neoforge') loaders.push('neoforge');
        else if (['forge','legacy_forge'].includes(version.type)) loaders.push('forge');
        else loaders.push('fabric');
    }

    const installPath = projectType === 'resourcepack' ? getResourcePacksPathForVersion(version.id)
        : projectType === 'shader' ? getShadersPathForVersion(version.id)
        : getModsPathForVersion(version.id);

    if (buttonEl) { buttonEl.disabled = true; buttonEl.textContent = 'Загрузка...'; }
    let inlineProgress = buttonEl?.parentElement ? createInlineProgress(buttonEl.parentElement) : null;

    function done() {
        inlineProgress?.remove(); inlineProgress = null;
        if (buttonEl) { buttonEl.disabled = false; buttonEl.textContent = 'Установить'; }
        if (projectType === 'mod') refreshInstalledModsList();
        else if (projectType === 'resourcepack') refreshInstalledTexturesList();
        else if (projectType === 'shader') { refreshInstalledShadersList(); refreshInstalledModsList(); }
    }
    function fail(err) {
        inlineProgress?.remove(); inlineProgress = null;
        if (buttonEl) { buttonEl.disabled = false; buttonEl.textContent = 'Установить'; }
        showLauncherAlert('Ошибка установки: ' + (err.message || 'неизвестная ошибка'));
    }
    const onDlProgress = (r, t) => inlineProgress?.update(r, t);

    try {
        // Для ресурспаков и шейдеров не фильтруем по game_versions — они часто не привязаны к версии
        const versionsGameFilter = (projectType === 'resourcepack' || projectType === 'shader') ? null : gameVersions;
        const versions = await getModrinthProjectVersions(projectIdOrSlug, versionsGameFilter, loaders);
        if (!versions?.length) { done(); showLauncherAlert('Нет версии проекта для выбранной версии игры.'); return; }
        const v = versions[0];
        const primaryFile = (v.files || []).find(f => f.primary) || (v.files || [])[0];
        if (!primaryFile?.url) { done(); showLauncherAlert('Не удалось получить ссылку на файл.'); return; }
        const p = window.electronAPI.path;

        // Ресурспаки
        if (projectType === 'resourcepack') {
            await window.electronAPI.fs.mkdir(installPath, { recursive: true });
            await downloadModFile(primaryFile.url, p.join(installPath, primaryFile.filename || p.basename(primaryFile.url) || `file-${v.id}`), onDlProgress);
            done(); showLauncherAlert('Текстуры установлены.'); return;
        }

        // Шейдеры
        if (projectType === 'shader') {
            // Для инстансов тип 'instance', реальный загрузчик в version.loader
            const effectiveLoader = (version.type === 'instance' ? (version.loader || '') : version.type).toLowerCase();
            const hasFabric = ['fabric','custom'].includes(effectiveLoader) || /fabric/i.test(version.dir || version.id || '');
            const hasForge  = ['forge','legacy_forge'].includes(effectiveLoader) || (!hasFabric && /forge/i.test(version.dir || version.id || ''));
            const hasNeo    = effectiveLoader === 'neoforge' || (!hasFabric && !hasForge && /neoforge/i.test(version.dir || version.id || ''));
            const hasLoader = versionHasModLoader(version);

            // Нет модлоадера — блокируем установку и предлагаем выбрать подходящую версию
            if (!hasLoader) {
                done();
                await showLauncherAlert(
                    'Шейдеры требуют мод-загрузчик (Fabric + Iris или Forge + OptiFine).\n\n' +
                    'Перейдите на Главную и выберите версию с Fabric или Forge — тогда шейдеры заработают.',
                    '⚠️ Требуется мод-загрузчик'
                );
                return;
            }

            const doInstall = async () => {
                await window.electronAPI.fs.mkdir(installPath, { recursive: true });
                await downloadModFile(primaryFile.url, p.join(installPath, primaryFile.filename || p.basename(primaryFile.url) || `shader-${v.id}`), onDlProgress);
                done(); showLauncherAlert('Шейдеры установлены!');
            };

            // Fabric — проверяем / ставим Iris (с его зависимостями)
            if (hasFabric) {
                const modsPath = getModsPathForVersion(localStorage.getItem(VERSION_STORAGE_KEY) || DEFAULT_VERSION_ID);
                let irisInstalled = false;
                try {
                    if (await window.electronAPI.fs.exists(modsPath)) {
                        const files = await window.electronAPI.fs.readdirNames(modsPath);
                        irisInstalled = files.some(f => f.toLowerCase().includes('iris'));
                    }
                } catch { /* ignore */ }

                if (!irisInstalled) {
                    // Собираем зависимости Iris точно так же, как для модов
                    const irisDeps = await collectAllDepsInfo('iris', gameVersions, ['fabric'], null).catch(() => []);
                    let msg = 'Для работы шейдеров нужен Iris Shaders.';
                    if (irisDeps.length) msg += '\n\nЗависимости: ' + irisDeps.map(d => d.title).join(', ') + '.';
                    msg += '\n\nУстановить Iris вместе с шейдерпаком?';
                    if (await showLauncherConfirm(msg, '🔵 Зависимость: Iris Shaders')) {
                        for (const dep of irisDeps)
                            await installOneModFromModrinth(dep.project_id, gameVersions, ['fabric'], modsPath).catch(err => console.warn('Iris dep install failed:', dep.project_id, err));
                        await installOneModFromModrinth('iris', gameVersions, ['fabric'], modsPath).catch(() => {});
                    }
                }
            }

            // Forge / NeoForge — напоминаем про OptiFine (не автоустанавливаем, т.к. это внешний сайт)
            if ((hasForge || hasNeo) && !hasFabric) {
                await showLauncherAlert(
                    'Для шейдеров на Forge/NeoForge требуется OptiFine или Oculus.\n' +
                    'Установите его вручную, затем поместите шейдерпак в папку shaderpacks.',
                    'ℹ️ Требуется OptiFine / Oculus'
                );
            }

            await doInstall(); return;
        }

        // Моды + зависимости
        const requiredDeps     = (v.dependencies || []).filter(d => d.dependency_type === 'required' && d.project_id);
        const uniqueProjectIds = [...new Set(requiredDeps.map(d => d.project_id))];
        const fileName = primaryFile.filename || p.basename(primaryFile.url) || `mod-${v.id}.jar`;
        const destPath = p.join(installPath, fileName);

        if (!uniqueProjectIds.length) {
            await window.electronAPI.fs.mkdir(installPath, { recursive: true });
            await downloadModFile(primaryFile.url, destPath, onDlProgress);
            done(); showToast('Мод установлен!', 'success'); return;
        }

        const groups = await Promise.all(uniqueProjectIds.map(pid =>
            collectAllDepsInfo(pid, gameVersions, loaders, null).then(sub =>
                getModrinthProject(pid).then(proj => [{ project_id: pid, title: proj?.title || pid }, ...sub]).catch(() => [{ project_id: pid, title: pid }, ...sub])
            ).catch(() => [{ project_id: pid, title: pid }])
        ));
        const allDeps = groups.flat();
        const seen = new Set();
        const deduped = allDeps.filter(d => { if (seen.has(d.project_id)) return false; seen.add(d.project_id); return true; });
        let confirmMsg = 'Обязательные зависимости: ' + deduped.map(d => d.title).join(', ') + '.';
        if (deduped.length > uniqueProjectIds.length) confirmMsg += '\n\nВключены транзитивные зависимости.';
        confirmMsg += '\n\nУстановить их вместе с модом?';

        const installDeps = await showLauncherConfirm(confirmMsg, 'Зависимости мода');
        if (installDeps) {
            for (const pid of uniqueProjectIds)
                await installOneModFromModrinth(pid, gameVersions, loaders, installPath).catch(err => console.warn('Dep install failed:', pid, err));
        }
        await window.electronAPI.fs.mkdir(installPath, { recursive: true });
        await downloadModFile(primaryFile.url, destPath, onDlProgress);
        done(); showToast(installDeps ? 'Мод и зависимости установлены!' : 'Мод установлен!', 'success');
    } catch (err) { fail(err); }
}

// Dual export: window.* для renderer/браузера, module.exports для Node.js/main
const _ModsPanel = {
    getModsPathForVersion, getDataPathForVersion,
    getResourcePacksPathForVersion, getShadersPathForVersion,
    listInstalledMods, toggleMod,

    modrinthFetch, searchModrinth, getModrinthProjectVersions, getModrinthProject,
    installOneModFromModrinth, collectAllDepsInfo, downloadModFile,
    createInlineProgress, renderInstalledModsList,
    refreshInstalledModsList, refreshInstalledTexturesList, refreshInstalledShadersList,
    isMostlyCyrillic, translateToRussian, showModDetail,
    loadModsPanel, loadTexturesList, loadShadersList, initModsPanel,
};
if (typeof window !== 'undefined') { window.ModsPanel = _ModsPanel; }
if (typeof module !== 'undefined' && module.exports) { module.exports = _ModsPanel; }
})();
