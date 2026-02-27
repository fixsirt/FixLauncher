/**
 * Модуль управления настройками
 * @module settings
 */

const path = require('path');
const os = require('os');
const { getLauncherBasePath } = require('./paths');

const DEFAULT_SETTINGS = {
    ram: '4',
    javaPath: 'auto',
    minecraftPath: 'auto'
};

/**
 * Получить путь по умолчанию для FixLauncher
 * @returns {string}
 */
function getDefaultMinecraftPath () {
    return getLauncherBasePath(os.platform(), os.homedir(), process.env.APPDATA);
}

/**
 * Загрузить настройки из localStorage
 * @returns {Object}
 */
function loadSettings () {
    const settings = { ...DEFAULT_SETTINGS };

    try {
        const ram = localStorage.getItem('minecraft-ram');
        const javaPath = localStorage.getItem('java-path');
        const minecraftPath = localStorage.getItem('minecraft-path');

        if (ram) settings.ram = ram;
        if (javaPath) settings.javaPath = javaPath;
        if (minecraftPath) settings.minecraftPath = minecraftPath;
    } catch (e) {
        console.error('Error loading settings:', e);
    }

    return settings;
}

/**
 * Сохранить настройки в localStorage
 * @param {Object} settings
 */
function saveSettings (settings) {
    try {
        if (settings.ram) localStorage.setItem('minecraft-ram', settings.ram);
        if (settings.javaPath) localStorage.setItem('java-path', settings.javaPath);
        if (settings.minecraftPath) localStorage.setItem('minecraft-path', settings.minecraftPath);
    } catch (e) {
        console.error('Error saving settings:', e);
    }
}

/**
 * Получить путь к Java
 * @returns {string|null}
 */
function getJavaPath () {
    const saved = localStorage.getItem('java-path');
    if (saved && saved !== 'Java не найдена') {
        return saved;
    }

    const javaHome = process.env.JAVA_HOME;
    if (javaHome) {
        const javaPath = path.join(javaHome, 'bin', os.platform() === 'win32' ? 'java.exe' : 'java');
        try {
            const fs = require('fs');
            if (fs.existsSync(javaPath)) {
                return javaPath;
            }
        } catch (e) {
            // Игнорируем
        }
    }

    return null;
}

/**
 * Получить путь к FixLauncher
 * @returns {string}
 */
function getVanillaSunsPath () {
    const saved = localStorage.getItem('minecraft-path');
    if (saved) return saved;
    return getDefaultMinecraftPath();
}

/**
 * Получить объём RAM
 * @returns {number}
 */
function getRam () {
    const saved = localStorage.getItem('minecraft-ram');
    return saved ? parseInt(saved, 10) : 4;
}

module.exports = {
    loadSettings,
    saveSettings,
    getJavaPath,
    getVanillaSunsPath,
    getRam,
    getDefaultMinecraftPath,
    DEFAULT_SETTINGS
};
