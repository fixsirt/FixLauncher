/**
 * Centralized paths for FixLauncher data files.
 */

const path = require('path');
const os = require('os');

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
    getPlaytimePath
};
