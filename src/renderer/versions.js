(function() {
'use strict';

/**
 * Выбор версии Minecraft — официальные релизы, снапшоты, кастомные сборки
 * @module renderer/versions
 *
 * Node.js-зависимости убраны: path/fs → window.electronAPI.path / .fs.*,
 * paths.getBasePath → window.electronAPI.path.join + os/env через electronAPI.
 */

'use strict';

const { fetchJSON } = window.RendererUtils;
const { animateStatValue } = window.UiHelpers;

/**
 * Базовая папка лаунчера — дублируем логику paths.getBasePath(),
 * но без require('path'/'os') — всё через window.electronAPI.
 */
function getBasePath() {
    if (typeof localStorage !== 'undefined') {
        const saved = localStorage.getItem('minecraft-path');
        if (saved) return saved;
    }
    const api = window.electronAPI;
    const platform = api.os.platform();
    const home = api.os.homedir();
    const appData = api.env.APPDATA;
    if (platform === 'win32') {
        const roaming = appData || api.path.join(home, 'AppData', 'Roaming');
        return api.path.join(roaming, '.fixlauncher');
    }
    if (platform === 'darwin') {
        return api.path.join(home, 'Library', 'Application Support', 'fixlauncher');
    }
    return api.path.join(home, '.fixlauncher');
}

/** Путь к базовой папке лаунчера (используется в launcher.js) */
const getVanillaSunsPath = () => getBasePath();
const {
    MOJANG_VERSION_MANIFEST,
    FABRIC_VERSIONS_GAME,
    QUILT_VERSIONS_GAME,
    FORGE_PROMOTIONS,
    NEOFORGE_MAVEN_META,
    EVACUATION_MC_VERSION,
    STORAGE_KEYS,
    DEFAULT_VERSION_ID,
} = window.RendererConstants;

// ─── Константы ────────────────────────────────────────────────────────────────

const VERSION_STORAGE_KEY = STORAGE_KEYS.selectedVersion;

const CUSTOM_BUILDS = [];

/** Типы версий для группировки в списке */
const VERSION_TYPE_LABELS = {
    custom:      'Сборки FixLauncher',
    release:     'Release',
    snapshot:    'Snapshot',
    old_alpha:   'Old Alpha',
    old_beta:    'Old Beta',
    vanilla:     'Vanilla',
    fabric:      'Fabric',
    forge:       'Forge',
    neoforge:    'NeoForge',
    quilt:       'Quilt',
    legacy_forge: 'Legacy Forge',
};

// ─── Пути ─────────────────────────────────────────────────────────────────────

/** Путь к папке Minecraft для версии (id: evacuation | release:1.21.4 | fabric:1.21.4 | ...) */
/** @param {string} versionId @returns {string} Абсолютный путь к папке профиля версии */
function getMinecraftProfilePath(versionId) {
    const base   = getVanillaSunsPath();
    const folder = 'minecraft-' + String(versionId).replace(/:/g, '-').replace(/[^a-zA-Z0-9.-]/g, '-');
    return window.electronAPI.path.join(base, folder);
}

/** Имя папки версии в versions/ (для проверки установки). */
/** @param {object} version @returns {string[]} Имена папок в versions/ для проверки установки */
function getVersionDirNamesForCheck(version) {
    if (!version) return [];
    const mc = version.mcVersion || '';
    if (version.type === 'fabric') return [mc ? mc + '-fabric' : `${EVACUATION_MC_VERSION}-fabric`];
    return [mc || version.id.split(':')[1] || ''].filter(Boolean);
}

/** Проверка, установлена ли версия (есть versions/<dir>/ с .jar и .json). */
/** @param {object} version @returns {Promise<boolean>} true если версия установлена */
async function isVersionInstalled(version) {
    try {
        const api = window.electronAPI;
        const profilePath = getMinecraftProfilePath(version.id);
        const dirs        = getVersionDirNamesForCheck(version);
        for (const dir of dirs) {
            const base = api.path.join(profilePath, 'versions', dir);
            const hasJson = await api.fs.exists(api.path.join(base, dir + '.json'));
            const hasJar  = await api.fs.exists(api.path.join(base, dir + '.jar'));
            if (hasJson && hasJar) return true;
        }
    } catch (err) {
        console.warn('[versions] isVersionInstalled:', err.message);
    }
    return false;
}

// ─── Инстансы с диска ────────────────────────────────────────────────────────

/** Читает инстансы с диска (minecraft-* папки) */
/** @returns {Promise<object[]>} Список инстансов с диска (minecraft-* папки) */
async function getInstalledInstances() {
    try {
        const api = window.electronAPI;
        const base = getVanillaSunsPath();
        if (!await api.fs.exists(base)) return [];

        const entries = await api.fs.readdir(base);
        const results = [];

        for (const entry of entries) {
            const dir = entry.name;
            if (!dir.startsWith('minecraft-')) continue;
            if (!entry.isDirectory) continue;

            let meta = null;
            try {
                const mp = api.path.join(base, dir, 'instance.json');
                if (await api.fs.exists(mp)) {
                    const raw = await api.fs.read(mp, 'utf8');
                    if (raw) meta = JSON.parse(raw);
                }
            } catch (err) {
                console.warn('[versions] Не удалось прочитать instance.json:', err.message);
            }

            const label = meta?.name
                || dir.replace(/^minecraft-/, '').replace(/-/g, ' ').replace(/\b(fabric|forge|neoforge|quilt)\b/gi, m => m[0].toUpperCase() + m.slice(1))
                || dir;

            // neoforge проверяем раньше forge
            let icon = '📦';
            if (dir.includes('neoforge'))     icon = '🔧';
            else if (dir.includes('forge'))   icon = '⚙️';
            else if (dir.includes('fabric'))  icon = '🧵';
            else if (dir.includes('quilt'))   icon = '🪡';

            // Извлекаем версию MC из имени папки если нет в meta
            const mcVersionFromDir = (dir.match(/(\d+\.\d+(?:\.\d+)?)(?:$|[^\d])/) || [])[1] || '';
            const mcVersion = meta?.mcVersion || mcVersionFromDir;

            // Строим строку версии с модлоадером: "Fabric 1.21.11"
            const loaderRaw = meta?.loader || '';
            const loaderName = (loaderRaw && loaderRaw !== 'vanilla')
                ? loaderRaw.charAt(0).toUpperCase() + loaderRaw.slice(1)
                : null;
            const versionDisplay = loaderName && mcVersion
                ? `${loaderName} ${mcVersion}`
                : (mcVersion || ('Инстанс · ' + dir));

            results.push({
                id: 'instance:' + dir,
                type: 'instance',
                label,
                mcVersion,
                versionDisplay,
                description: versionDisplay,
                icon,
                dir,
            });
        }

        return results;
    } catch (err) {
        console.error('[versions] getInstalledInstances:', err.message);
        return [];
    }
}

// ─── Загрузка списка версий ───────────────────────────────────────────────────

let cachedVersionList  = null;
let _versionListRequest = null; // guard от race conditions

/** @returns {Promise<object[]>} Полный список версий: инстансы + сборки + официальные */
async function fetchVersionList() {
    const instanceVersions = await getInstalledInstances(); // всегда свежие с диска

    if (cachedVersionList) {
        return [...CUSTOM_BUILDS, ...instanceVersions, ...cachedVersionList.filter(v => v.type !== 'custom')];
    }

    // Если запрос уже летит — возвращаем тот же промис, не плодим дубли
    if (_versionListRequest) {
        return _versionListRequest.then(list =>
            [...CUSTOM_BUILDS, ...instanceVersions, ...list.filter(v => v.type !== 'custom')]
        );
    }

    _versionListRequest = Promise.all([
        fetchJSON(MOJANG_VERSION_MANIFEST).catch(() => null),
        fetchJSON(FABRIC_VERSIONS_GAME).catch(() => null),
        fetchJSON(QUILT_VERSIONS_GAME).catch(() => null),
        fetchJSON(FORGE_PROMOTIONS).catch(() => null),
        fetchJSON(NEOFORGE_MAVEN_META).catch(() => null),
    ]).then(([mojangManifest, fabricGames, quiltGames, forgePromos, _neoMeta]) => {
        const list = [];

        // ── Все релизы Vanilla ──
        const releases = (mojangManifest && Array.isArray(mojangManifest.versions))
            ? mojangManifest.versions.filter(v => v.type === 'release').map(v => v.id)
            : [];
        releases.forEach(id => {
            list.push({ id: `release:${id}`, type: 'release', label: id, mcVersion: id, description: 'Vanilla', icon: '🟢' });
        });

        // ── Fabric — только версии MC которые поддерживает Fabric ──
        const fabricSupported = new Set();
        if (fabricGames && Array.isArray(fabricGames)) {
            fabricGames.forEach(v => {
                const id = v?.version || (typeof v === 'string' ? v : null);
                if (id && releases.includes(id)) fabricSupported.add(id);
            });
        }
        fabricSupported.forEach(id => {
            list.push({ id: `fabric:${id}`, type: 'fabric', label: `Fabric ${id}`, mcVersion: id, description: 'Fabric Loader', icon: '🧵' });
        });

        // ── Forge — только версии у которых есть promoted build ──
        if (forgePromos?.promos) {
            const forgeMcVersions = new Set();
            Object.keys(forgePromos.promos).forEach(key => {
                const mc = key.split('-')[0];
                if (releases.includes(mc)) forgeMcVersions.add(mc);
            });
            forgeMcVersions.forEach(mc => {
                const rec      = forgePromos.promos[`${mc}-recommended`];
                const lat      = forgePromos.promos[`${mc}-latest`];
                const forgeVer = rec || lat;
                if (forgeVer) {
                    list.push({ id: `forge:${mc}`, type: 'forge', label: `Forge ${mc}`, mcVersion: mc, description: `Forge ${mc}-${forgeVer}`, icon: '⚙️' });
                }
            });
        }

        // ── NeoForge — версии начиная с 1.20.2 ──
        const neoSupported = releases.filter(id => {
            const [maj, min] = id.split('.').map(Number);
            return maj === 1 && (min > 20 || (min === 20 && id.split('.')[2] >= 2));
        });
        neoSupported.forEach(mc => {
            list.push({ id: `neoforge:${mc}`, type: 'neoforge', label: `NeoForge ${mc}`, mcVersion: mc, description: 'NeoForge', icon: '🔧' });
        });

        // ── Quilt ──
        const quiltSupported = new Set();
        if (quiltGames && Array.isArray(quiltGames)) {
            quiltGames.forEach(v => {
                const id = v?.version || (typeof v === 'string' ? v : null);
                if (id && releases.includes(id)) quiltSupported.add(id);
            });
        }
        quiltSupported.forEach(id => {
            list.push({ id: `quilt:${id}`, type: 'quilt', label: `Quilt ${id}`, mcVersion: id, description: 'Quilt Loader', icon: '🪡' });
        });

        cachedVersionList   = list;
        _versionListRequest = null; // запрос завершён — сбрасываем guard
        return list;
    }).catch(err => {
        _versionListRequest = null; // на ошибке тоже сбрасываем — чтобы следующий вызов повторил запрос
        console.error('[versions] fetchVersionList:', err.message);
        return [];
    });

    return _versionListRequest.then(list =>
        [...CUSTOM_BUILDS, ...instanceVersions, ...list.filter(v => v.type !== 'custom')]
    );
}

// ─── Выбранная версия ─────────────────────────────────────────────────────────

/** Возвращает выбранную версию из localStorage */
/** @returns {object} Объект выбранной версии из localStorage */
function getSelectedVersion() {
    const raw = localStorage.getItem(VERSION_STORAGE_KEY) || DEFAULT_VERSION_ID;
    // Инстанс
    if (raw.startsWith('instance:')) {
        const dir  = raw.slice('instance:'.length);
        const base = getVanillaSunsPath();
        const api  = window.electronAPI;
        let meta   = null;
        // Примечание: getSelectedVersion теперь async-ready, но для обратной
        // совместимости возвращает объект без meta при первом вызове.
        // Полные данные загружаются через getInstalledInstances() (async).
        try {
            const mp = api.path.join(base, dir, 'instance.json');
            // Синхронного доступа к fs нет — возвращаем базовый объект,
            // meta подгрузится при следующем getInstalledInstances().\
        } catch (err) {
            console.warn('[versions] getSelectedVersion instance meta:', err.message);
        }

        const mcVersionRaw  = meta?.mcVersion || '';
        // Если mcVersion не в meta — пробуем вытащить из имени папки
        // Формат папок: minecraft-fabric-1.21.4, minecraft-forge-1.20.1, minecraft-1.21.4 и т.д.
        let mcVersion = mcVersionRaw;
        if (!mcVersion) {
            const vMatch = dir.match(/(\d+\.\d+(?:\.\d+)?(?:[-_]\d+)?)(?:\.|$|-[^0-9]|$)/);
            if (vMatch) mcVersion = vMatch[1];
        }
        // Определяем загрузчик: сначала из meta, потом из имени папки (fallback)
        let loader = (meta?.loader && meta.loader !== 'vanilla') ? meta.loader : null;
        if (!loader) {
            const dirLower = dir.toLowerCase();
            if (dirLower.includes('neoforge'))   loader = 'neoforge';
            else if (dirLower.includes('forge'))  loader = 'forge';
            else if (dirLower.includes('fabric')) loader = 'fabric';
            else if (dirLower.includes('quilt'))  loader = 'quilt';
        }
        const loaderVersion = meta?.loaderVersion || null;
        // Если имя не задано — строим из папки: minecraft-fabric-1.21.11 → Fabric 1.21.11
        const dirClean = dir.replace(/^minecraft-/, '');
        const labelFromDir = dirClean
            .replace(/-/g, ' ')
            .replace(/\b(fabric|forge|neoforge|quilt)\b/gi, m => m[0].toUpperCase() + m.slice(1))
            .trim() || dir;
        const label = meta?.name || labelFromDir;

        let icon = '📦';
        if (dir.includes('neoforge'))     icon = '🔧';
        else if (dir.includes('forge'))   icon = '⚙️';
        else if (dir.includes('fabric'))  icon = '🧵';
        else if (dir.includes('quilt'))   icon = '🪡';

        return { id: raw, type: 'instance', label, mcVersion, loader, loaderVersion, dir, instPath: api.path.join(base, dir), description: 'Инстанс', icon };
    }

    const [type, mcVersion] = raw.includes(':') ? raw.split(':') : ['release', raw];
    const loaderLabels = { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', quilt: 'Quilt', legacy_forge: 'Forge' };
    const loaderIcons  = { fabric: '🧵', forge: '⚙️', neoforge: '🔧', quilt: '🪡', legacy_forge: '⚙️', release: '🟢' };
    const loaderPrefix = loaderLabels[type];
    const label = loaderPrefix ? `${loaderPrefix} ${mcVersion}` : mcVersion;
    const icon  = loaderIcons[type] || '📦';
    return { id: raw, type, label, mcVersion, description: VERSION_TYPE_LABELS[type] || type, icon };
}

/** Проверка, что у выбранной версии есть модлоадер */
/** @param {object} version @returns {boolean} true если версия использует мод-загрузчик */
function versionHasModLoader(version) {
    if (!version?.type) return false;
    const t = version.type.toLowerCase();
    if (t === 'instance') {
        if (version.loader && version.loader !== 'vanilla') return true;
        return /fabric|forge|neoforge|quilt/i.test(version.dir || version.id || '');
    }
    return ['custom', 'fabric', 'forge', 'neoforge', 'quilt', 'legacy_forge'].includes(t);
}

/** Сохраняет выбранную версию и обновляет UI */
/** @param {string} versionId — сохраняет выбор и обновляет UI */
function setSelectedVersion(versionId) {
    localStorage.setItem(VERSION_STORAGE_KEY, versionId);
    const hiddenInput = document.getElementById('version-hidden-input');
    if (hiddenInput) hiddenInput.value = versionId;

    const v = getSelectedVersion();
    const icon = v?.icon || '📦';
    console.log('[versions] setSelectedVersion:', versionId, '→ label:', v?.label, 'icon:', icon);

    // Для инстанса читаем instance.json async чтобы получить настоящее имя
    if (versionId.startsWith('instance:')) {
        const dir  = versionId.slice('instance:'.length);
        const base = getVanillaSunsPath();
        const api  = window.electronAPI;
        const mp   = api.path.join(base, dir, 'instance.json');

        // Сначала рендерим с fallback-именем (из папки)
        const fallbackLabel = v?.label || dir;
        const fallbackMc    = v?.mcVersion || '';
        // Для stat-version строим строку с лоадером из имени папки
        const fallbackLoader = dir.toLowerCase().includes('neoforge') ? 'NeoForge'
            : dir.toLowerCase().includes('forge')  ? 'Forge'
            : dir.toLowerCase().includes('fabric') ? 'Fabric'
            : dir.toLowerCase().includes('quilt')  ? 'Quilt'
            : null;
        const fallbackStat = fallbackLoader && fallbackMc
            ? `${fallbackLoader} ${fallbackMc}`
            : (fallbackMc || fallbackLabel);
        _applyVersionLabel(icon, fallbackLabel, fallbackStat, versionId);

        // Потом обновляем с реальными данными из instance.json
        api.fs.read(mp, 'utf8').then(raw => {
            if (!raw) return;
            try {
                const meta = JSON.parse(raw);
                const realLabel = meta.name || fallbackLabel;
                const realMc    = meta.mcVersion || fallbackMc;
                // Добавляем модлоадер: "Fabric 1.21.11", "Forge 1.20.1" и т.д.
                const loaderName = meta.loader && meta.loader !== 'vanilla'
                    ? meta.loader.charAt(0).toUpperCase() + meta.loader.slice(1)
                    : null;
                const statText = loaderName && realMc
                    ? `${loaderName} ${realMc}`
                    : (realMc || realLabel);
                _applyVersionLabel(icon, realLabel, statText, versionId);
            } catch(e) {}
        }).catch(() => {});
    } else {
        // stat-version показывает label (например "Fabric 1.21.11"), а не голый mcVersion
        const statText = v ? v.label : versionId;
        _applyVersionLabel(icon, v?.label || versionId, statText, versionId);
    }

    document.dispatchEvent(new Event('version-changed'));
}

function _applyVersionLabel(icon, name, mcVersion, versionId) {
    const labelText = `${icon} ${name}`;
    const statText  = mcVersion || name;

    const labelEl = document.getElementById('version-selector-label');
    if (labelEl) labelEl.textContent = labelText;

    const modsVersionEl = document.getElementById('mods-version-value');
    if (modsVersionEl) modsVersionEl.textContent = labelText;

    // Напрямую через DOM — не через animateStatValue который может не работать при инициализации
    const statVersionEl = document.getElementById('stat-version');
    if (statVersionEl) statVersionEl.textContent = statText;
}

// ─── Рендер дропдауна ─────────────────────────────────────────────────────────

/** @param {object[]} versions — рендерит список в дропдаун */
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
        // Для инстанса: title = имя, meta = версия MC
        const itemMeta = v.type === 'instance'
            ? (v.versionDisplay || v.mcVersion || v.description || '')
            : (v.description || v.mcVersion || '');
        item.innerHTML = `
            <span class="version-item-icon">${v.icon || '📦'}</span>
            <div class="version-item-body">
                <div class="version-item-title">${v.label}</div>
                <div class="version-item-meta">${itemMeta}</div>
            </div>
        `;
        item.addEventListener('click', () => {
            setSelectedVersion(v.id);
            listEl.querySelectorAll('.version-item').forEach(el => el.classList.remove('is-selected'));
            item.classList.add('is-selected');
            closeVersionDropdown();
        });
        listEl.appendChild(item);
    }

    function appendGroup(label, list) {
        if (!list?.length) return;
        const groupEl = document.createElement('div');
        groupEl.className   = 'version-group-label';
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

    appendGroup('Мои инстансы', groups.instance || []);
    appendGroup('Сборки FixLauncher', groups.custom || []);
    ['release', 'fabric', 'forge', 'neoforge', 'quilt'].forEach(type => {
        const labels = { release: 'Vanilla', fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', quilt: 'Quilt' };
        appendGroup(labels[type] || type, groups[type] || []);
    });
}

/** Открывает дропдаун выбора версии и загружает список */
function openVersionDropdown() {
    const dropdown = document.getElementById('version-selector-dropdown');
    const btn      = document.getElementById('version-selector-btn');
    if (dropdown && btn) {
        dropdown.classList.add('is-open');
        btn.setAttribute('aria-expanded', 'true');
        dropdown.setAttribute('aria-hidden', 'false');
        fetchVersionList().then(renderVersionList).catch(err =>
            console.error('[versions] openVersionDropdown:', err.message)
        );
    }
}

/** Закрывает дропдаун выбора версии */
function closeVersionDropdown() {
    const dropdown = document.getElementById('version-selector-dropdown');
    const btn      = document.getElementById('version-selector-btn');
    if (dropdown && btn) {
        dropdown.classList.remove('is-open');
        btn.setAttribute('aria-expanded', 'false');
        dropdown.setAttribute('aria-hidden', 'true');
    }
}

/** Инициализирует дропдаун выбора версии (вешает listeners) */
function initVersionSelector() {
    const btn      = document.getElementById('version-selector-btn');
    const dropdown = document.getElementById('version-selector-dropdown');
    if (!btn || !dropdown) return;

    setSelectedVersion(localStorage.getItem(VERSION_STORAGE_KEY) || DEFAULT_VERSION_ID);

    btn.addEventListener('click', e => {
        e.preventDefault();
        dropdown.classList.contains('is-open') ? closeVersionDropdown() : openVersionDropdown();
    });

    document.addEventListener('click', e => {
        if (dropdown.classList.contains('is-open') && !dropdown.contains(e.target) && !btn.contains(e.target)) {
            closeVersionDropdown();
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────

// Dual export: window.* для renderer/браузера, module.exports для Node.js/main
const _VersionsModule = {
    VERSION_STORAGE_KEY,
    DEFAULT_VERSION_ID,
    getMinecraftProfilePath,
    getVersionDirNamesForCheck,
    isVersionInstalled,
    fetchVersionList,
    getSelectedVersion,
    versionHasModLoader,
    setSelectedVersion,
    renderVersionList,
    openVersionDropdown,
    closeVersionDropdown,
    initVersionSelector,
};
if (typeof window !== 'undefined') { window.VersionsModule = _VersionsModule; }
if (typeof module !== 'undefined' && module.exports) { module.exports = _VersionsModule; }
})();
