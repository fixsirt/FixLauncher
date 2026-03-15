(function() {
'use strict';

/**
 * Панель настроек, credentials, поиск Java, player name
 * @module renderer/settings-panel
 *
 * РЕФАКТОРИНГ:
 *   - Удалены require('path'), require('os'), require('fs'), require('child_process')
 *   - loadSettings() использует window.electronAPI.os / .path / .env
 *   - findJavaPath() — только IPC (java:find), без локального fallback
 *   - saveCredentials / loadCredentials — через window.electronAPI.fs (async)
 *   - Хардкодные '.fixlauncher' заменены константами LAUNCHER_DIR_*
 */

'use strict';

const { showLauncherAlert } = window.UiHelpers;
const { LAUNCHER_DIR_WIN, LAUNCHER_DIR_MAC, LAUNCHER_DIR_LINUX } = window.RendererConstants;

function getDefaultLauncherPath() {
    const platform = window.electronAPI.os.platform();
    const homedir  = window.electronAPI.os.homedir();
    const appdata  = window.electronAPI.env.APPDATA;
    const p        = window.electronAPI.path;
    if (platform === 'win32') return p.join(appdata || p.join(homedir, 'AppData', 'Roaming'), LAUNCHER_DIR_WIN);
    if (platform === 'darwin') return p.join(homedir, 'Library', 'Application Support', LAUNCHER_DIR_MAC);
    return p.join(homedir, LAUNCHER_DIR_LINUX);
}

function getVanillaSunsPath() {
    return localStorage.getItem('minecraft-path') || getDefaultLauncherPath();
}

function loadSettings() {
    const savedMinecraftPath = localStorage.getItem('minecraft-path');
    const minecraftPathInput = document.getElementById('minecraft-path');
    if (minecraftPathInput) minecraftPathInput.value = savedMinecraftPath || getDefaultLauncherPath();

    findJavaPath().then(javaPath => {
        const savedJavaPath = localStorage.getItem('java-path');
        const javaPathInput = document.getElementById('java-path');
        if (javaPathInput) javaPathInput.value = savedJavaPath || javaPath || 'Java не найдена';
    });

    const savedRAM = localStorage.getItem('minecraft-ram') || '4';
    const ramSlider = document.getElementById('ram-slider');
    const ramValue  = document.getElementById('ram-value');
    if (ramSlider && ramValue) { ramSlider.value = savedRAM; ramValue.textContent = savedRAM; }

    const savedArgs          = localStorage.getItem('minecraft-args') || '';
    const minecraftArgsInput = document.getElementById('minecraft-args');
    if (minecraftArgsInput) minecraftArgsInput.value = savedArgs;
}

/**
 * Поиск Java через IPC (java:find в main-процессе).
 * Локальный fallback через child_process/fs убран — дублирует логику main и
 * несовместим с contextIsolation:true.
 * @returns {Promise<string|null>}
 */
async function findJavaPath() {
    try {
        return await window.electronAPI.java.find() || null;
    } catch (e) {
        console.warn('[settings] java:find IPC error:', e.message);
        return null;
    }
}

function initBrowseButton() {
    const browseBtn = document.getElementById('browse-minecraft');
    if (browseBtn) {
        browseBtn.addEventListener('click', async () => {
            try {
                const result = await window.electronAPI.openFolderDialog();
                if (!result.canceled && result.filePaths?.[0]) {
                    const inp = document.getElementById('minecraft-path');
                    if (inp) inp.value = result.filePaths[0];
                }
            } catch (error) {
                console.error('Error opening dialog:', error);
                showLauncherAlert('Не удалось открыть диалог выбора папки.');
            }
        });
    }

    const browseJavaBtn = document.getElementById('browse-java');
    if (browseJavaBtn) {
        browseJavaBtn.addEventListener('click', async () => {
            try {
                const platform = window.electronAPI.os.platform();
                const filters  = platform === 'win32' ? [{ name: 'Java Executable', extensions: ['exe'] }] : [];
                const result = await window.electronAPI.openFile({ filters, title: 'Выберите Java (java.exe или java)' });
                if (!result.canceled && result.filePaths?.[0]) {
                    const javaPath = result.filePaths[0];
                    if (javaPath.toLowerCase().includes('java')) {
                        const inp = document.getElementById('java-path');
                        if (inp) inp.value = javaPath;
                    } else {
                        showLauncherAlert('Пожалуйста, выберите файл Java (java.exe на Windows или java на Linux/Mac)');
                    }
                }
            } catch (error) {
                console.error('Error opening dialog:', error);
                showLauncherAlert('Не удалось открыть диалог выбора файла.');
            }
        });
    }
}

function initRamSlider() {
    const ramSlider = document.getElementById('ram-slider');
    const ramValue  = document.getElementById('ram-value');
    if (ramSlider && ramValue) {
        ramSlider.addEventListener('input', (e) => { ramValue.textContent = e.target.value; });
    }
}

function initSaveButton() {
    const saveBtn = document.getElementById('save-settings');
    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            const ram           = document.getElementById('ram-slider')?.value;
            const minecraftPath = document.getElementById('minecraft-path')?.value;
            const javaPath      = document.getElementById('java-path')?.value;
            const minecraftArgs = document.getElementById('minecraft-args')?.value || '';

            localStorage.setItem('minecraft-ram',  ram);
            localStorage.setItem('minecraft-path', minecraftPath);
            localStorage.setItem('java-path',      javaPath);
            localStorage.setItem('minecraft-args', minecraftArgs);

            await showLauncherAlert('Настройки сохранены!', 'Готово');
            document.dispatchEvent(new Event('settings-saved'));
        });
    } else {
        console.warn('Кнопка сохранения настроек не найдена!');
    }
}

function initLinks() {
    const openUrl = (url) => {
        if (!url) return;
        try { window.electronAPI.openExternal(url); }
        catch (e) { console.error('Error opening link:', e); }
    };
    document.querySelectorAll('.link-btn, .dev-link, .creator-name').forEach(link => {
        link.addEventListener('click', (e) => { e.preventDefault(); openUrl(link.getAttribute('href')); });
    });
}

/**
 * Сохранить credentials через IPC (fs:write, async).
 * @param {string} username
 */
async function saveCredentials(username) {
    try {
        const basePath = getVanillaSunsPath();
        const p        = window.electronAPI.path;
        const credPath = p.join(basePath, 'credentials.json');
        await window.electronAPI.fs.mkdir(basePath, { recursive: true });
        await window.electronAPI.fs.write(credPath, JSON.stringify({ username: username || '' }, null, 2));
    } catch (error) {
        console.error('Error saving credentials:', error);
    }
}

/**
 * Загрузить credentials через IPC (fs:read, async).
 * @returns {Promise<{ username: string }>}
 */
async function loadCredentials() {
    try {
        const basePath = getVanillaSunsPath();
        const p        = window.electronAPI.path;
        const credPath = p.join(basePath, 'credentials.json');

        if (!await window.electronAPI.fs.exists(credPath)) return { username: '' };

        const raw  = await window.electronAPI.fs.read(credPath, 'utf8');
        const data = JSON.parse(raw);

        // Миграция: удаляем пароль если вдруг сохранился
        if (Object.prototype.hasOwnProperty.call(data, 'password')) {
            delete data.password;
            await window.electronAPI.fs.write(credPath, JSON.stringify({ username: data.username || '' }, null, 2));
        }
        return { username: data.username || '' };
    } catch (error) {
        console.error('Error loading credentials:', error);
        return { username: '' };
    }
}

async function initPlayerName() {
    const playerNameInput = document.getElementById('player-name');
    const credentials = await loadCredentials();
    if (playerNameInput && credentials.username) playerNameInput.value = credentials.username;

    const saveData = () => saveCredentials(playerNameInput?.value || '');
    if (playerNameInput) {
        playerNameInput.addEventListener('input', saveData);
        playerNameInput.addEventListener('blur',  saveData);
    }
}

// Dual export: window.* для renderer/браузера, module.exports для Node.js/main
const _SettingsPanel = {
    loadSettings,
    findJavaPath, initBrowseButton, initRamSlider, initSaveButton, initLinks,
    getVanillaSunsPath, saveCredentials, loadCredentials, initPlayerName,
};
if (typeof window !== 'undefined') { window.SettingsPanel = _SettingsPanel; }
if (typeof module !== 'undefined' && module.exports) { module.exports = _SettingsPanel; }
})();
