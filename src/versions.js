/**
 * Модуль управления версиями Minecraft
 * @module versions
 */

const fs = require('fs');
const path = require('path');
const { getVanillaSunsPath } = require('./settings');

const VERSION_STORAGE_KEY = 'launcher-selected-version';
const DEFAULT_VERSION_ID = 'fabric:1.21.4';

/** Кастомная сборка FixLauncher — Выживание */
const CUSTOM_BUILDS = [];

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

/**
 * Получить путь к профилю версии
 * @param {string} versionId
 * @returns {string}
 */
function getMinecraftProfilePath (versionId) {
    const base = getVanillaSunsPath();
    const folder = 'minecraft-' + String(versionId).replace(/:/g, '-').replace(/[^a-zA-Z0-9.-]/g, '-');
    return path.join(base, folder);
}

/**
 * Получить имена директорий для проверки версии
 * @param {Object} version
 * @returns {Array<string>}
 */
function getVersionDirNamesForCheck (version) {
    if (!version) return [];

    const mc = version.mcVersion || '';
    if (version.type === 'fabric') return [mc ? mc + '-fabric' : '1.21.4-fabric'];

    return [mc || version.id.split(':')[1] || ''].filter(Boolean);
}

/**
 * Проверить, установлена ли версия
 * @param {Object} version
 * @returns {boolean}
 */
function isVersionInstalled (version) {
    try {
        const profilePath = getMinecraftProfilePath(version.id);
        const dirs = getVersionDirNamesForCheck(version);

        for (const dir of dirs) {
            const base = path.join(profilePath, 'versions', dir);
            const jsonExists = fs.existsSync(path.join(base, dir + '.json'));
            const jarExists = fs.existsSync(path.join(base, dir + '.jar'));

            if (jsonExists && jarExists) return true;
        }
    } catch (e) {
        // Игнорируем ошибки
    }

    return false;
}

/**
 * Получить выбранную версию
 * @returns {Object}
 */
function getSelectedVersion () {
    const raw = localStorage.getItem(VERSION_STORAGE_KEY) || DEFAULT_VERSION_ID;


    const [type, mcVersion] = raw.includes(':') ? raw.split(':') : ['release', raw];
    const label = type === 'fabric' ? `Fabric ${mcVersion}` : mcVersion;

    return {
        id: raw,
        type,
        label,
        mcVersion,
        description: VERSION_TYPE_LABELS[type] || type,
        icon: '📦'
    };
}

/**
 * Проверить, есть ли у версии модлоадер
 * @param {Object} version
 * @returns {boolean}
 */
function versionHasModLoader (version) {
    if (!version || !version.type) return false;
    const t = version.type.toLowerCase();
    if (t === 'instance') {
        // Instance has loader from instance.json
        if (version.loader && version.loader !== 'vanilla') return true;
        // Fallback: check dir name
        const dir = version.dir || version.id || '';
        return /fabric|forge|neoforge|quilt/i.test(dir);
    }
    return t === 'custom' ||
           t === 'fabric' || t === 'forge' ||
           t === 'neoforge' || t === 'quilt' || t === 'legacy_forge';
}

/**
 * Установить выбранную версию
 * @param {string} versionId
 */
function setSelectedVersion (versionId) {
    localStorage.setItem(VERSION_STORAGE_KEY, versionId);
}

module.exports = {
    CUSTOM_BUILDS,
    VERSION_TYPE_LABELS,
    VERSION_STORAGE_KEY,
    DEFAULT_VERSION_ID,
    getMinecraftProfilePath,
    getVersionDirNamesForCheck,
    isVersionInstalled,
    getSelectedVersion,
    versionHasModLoader,
    setSelectedVersion
};
