(function() {
'use strict';

/**
 * Панель настроек, поиск Java, RAM, прокси
 * @module renderer/settings-panel
 *
 * РЕФАКТОРИНГ:
 *   - Удалены require('path'), require('os'), require('fs'), require('child_process')
 *   - loadSettings() использует window.electronAPI.os / .path / .env
 *   - findJavaPath() — только IPC (java:find), без локального fallback
 *   - Аккаунты вынесены в accounts.js (localStorage)
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
    const statRam   = document.getElementById('stat-ram');
    if (ramSlider && ramValue) { ramSlider.value = savedRAM; ramValue.textContent = savedRAM; }
    if (statRam) { statRam.textContent = savedRAM + ' GB'; }

    const savedArgs          = localStorage.getItem('minecraft-args') || '';
    const minecraftArgsInput = document.getElementById('minecraft-args');
    if (minecraftArgsInput) minecraftArgsInput.value = savedArgs;
}

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
    const statRam   = document.getElementById('stat-ram');
    if (ramSlider && ramValue) {
        ramSlider.addEventListener('input', (e) => {
            ramValue.textContent = e.target.value;
            if (statRam) { statRam.textContent = e.target.value + ' GB'; }
        });
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

            const statRam = document.getElementById('stat-ram');
            if (statRam) { statRam.textContent = ram + ' GB'; }

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

async function initProxy() {
    const autoBtn      = document.getElementById('proxy-auto-btn');
    const disableBtn   = document.getElementById('proxy-disable-btn');
    const status       = document.getElementById('proxy-status');
    const progressWrap = document.getElementById('proxy-progress-wrap');
    const progressBar  = document.getElementById('proxy-progress-bar');

    if (!autoBtn) return;

    // Восстанавливаем активный прокси
    try {
        const active = await window.electronAPI.proxy.get();
        if (active) {
            status.textContent = `✅ ${active.protocol}://${active.host}:${active.port}`;
            disableBtn.style.display = '';
            autoBtn.textContent = '🔄 Найти другой';
        }
    } catch { /* нет доступа */ }

    autoBtn.addEventListener('click', async () => {
        autoBtn.disabled = true;
        autoBtn.textContent = '⏳ Запуск…';
        progressWrap.style.display = '';
        progressBar.style.width = '0%';
        status.textContent = 'Подключаюсь к списку прокси…';

        let removeListener = null;

        try {
            // Подписываемся на прогресс до запуска scan
            removeListener = window.electronAPI.proxy.onProgress(({ checked, total, working, found }) => {
                if (total > 0) {
                    progressBar.style.width = Math.min(95, Math.round(checked / total * 100)) + '%';
                }
                let msg = `Проверено: ${checked}`;
                if (total > 0) msg += `/${total}`;
                msg += ` · Рабочих: ${working}`;
                if (found) msg += ` · ✅ ${found.proxy.protocol}://${found.proxy.host}:${found.proxy.port} ${found.ms}мс`;
                status.textContent = msg;
            });

            // Один вызов — скачивает и проверяет одновременно
            const ranked = await window.electronAPI.proxy.scan();

            if (!ranked || ranked.length === 0) {
                status.textContent = '❌ Ни один прокси не ответил. Попробуйте позже.';
                progressBar.style.width = '100%';
                return;
            }

            const best = ranked[0];
            await window.electronAPI.proxy.set(best.proxy);
            localStorage.setItem('proxy-active', JSON.stringify(best.proxy));

            progressBar.style.width = '100%';
            const { host, port, protocol } = best.proxy;
            status.textContent = `✅ Применён: ${protocol}://${host}:${port} · ${best.ms} мс`;
            disableBtn.style.display = '';
            autoBtn.textContent = '🔄 Найти другой';

        } catch (e) {
            status.textContent = '❌ ' + e.message;
        } finally {
            autoBtn.disabled = false;
            if (removeListener) removeListener();
            setTimeout(() => { progressWrap.style.display = 'none'; }, 3000);
        }
    });

    disableBtn.addEventListener('click', async () => {
        await window.electronAPI.proxy.set(null);
        localStorage.removeItem('proxy-active');
        status.textContent = 'Прокси отключён';
        disableBtn.style.display = 'none';
        autoBtn.textContent = '🔍 Найти лучший прокси';
        autoBtn.disabled = false;
    });
}

// Dual export: window.* для renderer/браузера, module.exports для Node.js/main
const _SettingsPanel = {
    loadSettings,
    findJavaPath, initBrowseButton, initRamSlider, initSaveButton, initLinks,
    getVanillaSunsPath,
    initProxy,
};
if (typeof window !== 'undefined') { window.SettingsPanel = _SettingsPanel; }
if (typeof module !== 'undefined' && module.exports) { module.exports = _SettingsPanel; }
})();
