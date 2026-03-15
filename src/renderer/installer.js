(function() {
'use strict';

/**
 * Установка Minecraft — Vanilla, Fabric, сборки, библиотеки, ассеты, нативы
 * @module renderer/installer
 *
 * Вся логика перенесена в main-процесс (installer:* IPC handlers).
 * Renderer только вызывает IPC и пробрасывает прогресс в updateProgress.
 */

const { updateProgress } = window.UiHelpers;
const log = window.RendererLog.log;

function _subscribeProgress() {
    return window.electronAPI.installer.onProgress(({ pct, msg }) => {
        updateProgress(pct, msg);
    });
}

async function checkAndDownloadVersion(minecraftPath, version, withMods) {
    const unsub = _subscribeProgress();
    try {
        const result = await window.electronAPI.installer.checkAndDownload(minecraftPath, version, !!withMods);
        if (!result.ok) throw new Error(result.error || 'Ошибка установки версии');
    } finally {
        unsub();
    }
}

async function installModpack(minecraftPath, versionType) {
    const unsub = _subscribeProgress();
    try {
        const result = await window.electronAPI.installer.installModpack(minecraftPath, versionType);
        if (!result.ok) throw new Error(result.error || 'Ошибка установки сборки');
    } finally {
        unsub();
    }
}

async function extractNatives(minecraftPath, version) {
    const result = await window.electronAPI.installer.extractNatives(minecraftPath, version);
    if (!result.ok) throw new Error(result.error || 'Ошибка извлечения нативных библиотек');
}

// Stub: used by launcher.js to check assembly integrity via IPC
// Full implementation is in main.js
async function checkAssemblyIntegrity() { return { needsDownload: false }; }
async function repairAssembly() {}
async function getGitHubFileList() { return []; }

// Dual export: window.* для renderer, module.exports для Node.js/main
const _Installer = {
    checkAndDownloadVersion, installModpack, extractNatives,
    checkAssemblyIntegrity, repairAssembly, getGitHubFileList,
};
if (typeof window !== 'undefined') { window.Installer = _Installer; }
if (typeof module !== 'undefined' && module.exports) { module.exports = _Installer; }
})();
