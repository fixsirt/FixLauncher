/**
 * Centralized paths for FixLauncher data files.
 *
 * Используется как в main-процессе, так и в рендерере.
 * НЕ импортируй сюда ничего из src/renderer/ — это создаст циклы.
 */

const path = require('path');
const os   = require('os');

function getLauncherBasePath(platform = os.platform(), homeDir = os.homedir(), appData = process.env.APPDATA) {
    if (platform === 'win32') {
        const roaming = appData || path.join(homeDir, 'AppData', 'Roaming');
        return path.join(roaming, '.fixlauncher');
    }

    if (platform === 'darwin') {
        return path.join(homeDir, 'Library', 'Application Support', 'fixlauncher');
    }

    return path.join(homeDir, '.fixlauncher');
}

function getLegacyBasePaths(platform = os.platform(), homeDir = os.homedir(), appData = process.env.APPDATA) {
    if (platform === 'win32') {
        const roaming = appData || path.join(homeDir, 'AppData', 'Roaming');
        return [path.join(roaming, '.vanilla-suns')];
    }

    if (platform === 'darwin') {
        return [path.join(homeDir, 'Library', 'Application Support', 'vanilla-suns')];
    }

    return [path.join(homeDir, '.vanilla-suns')];
}

function getPlaytimePath(platform, homeDir, appData) {
    return path.join(getLauncherBasePath(platform, homeDir, appData), 'launcher-playtime.json');
}

module.exports = {
    getLauncherBasePath,
    getLegacyBasePaths,
    getPlaytimePath,

    /**
     * Путь к папке mods для данной версии/инстанса.
     * Используется и в main и в renderer для согласованности.
     * @param {string} basePath
     * @param {string} versionId
     * @returns {string}
     */
    getModsFolderForVersion(basePath, versionId) {
        const path = require('path');
        let folderName;
        if (versionId.startsWith('instance:')) {
            folderName = versionId.slice('instance:'.length);
        } else {
            folderName = 'minecraft-' + String(versionId).replace(/:/g, '-').replace(/[^a-zA-Z0-9.-]/g, '-');
        }
        return path.join(basePath, folderName, 'mods');
    },

    /**
     * Базовая папка лаунчера с учётом пользовательского пути из localStorage.
     * Работает только в рендерере (использует localStorage).
     * В main-процессе используй getLauncherBasePath() напрямую.
     * @returns {string}
     */
    getBasePath() {
        if (typeof localStorage !== 'undefined') {
            const saved = localStorage.getItem('minecraft-path');
            if (saved) return saved;
        }
        return getLauncherBasePath();
    },
};
