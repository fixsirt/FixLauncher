(function() {
'use strict';

/**
 * Управление Java — проверка версии, загрузка, установка
 * @module renderer/java
 *
 * Вся логика перенесена в main-процесс (java:ensure IPC handler).
 * Renderer только вызывает IPC и пробрасывает прогресс в updateProgress.
 */

const { updateProgress } = window.UiHelpers;
const log = window.RendererLog.log;

async function checkJavaVersion(javaPath) {
    const version = await window.electronAPI.java.checkVersion(javaPath);
    if (version === null) throw new Error('Не удалось определить версию Java');
    return version;
}

async function ensureJava(minecraftPath, currentJavaPath) {
    // Подписываемся на прогресс из main
    const unsubscribe = window.electronAPI.java.onProgress(({ pct, msg }) => {
        updateProgress(pct, msg);
    });

    try {
        const result = await window.electronAPI.java.ensure(minecraftPath, currentJavaPath);
        if (!result.ok) throw new Error(result.error || 'Ошибка установки Java');
        return result.javaPath;
    } finally {
        unsubscribe();
    }
}

// Dual export: window.* для renderer, module.exports для Node.js/main
const _JavaModule = { checkJavaVersion, ensureJava };
if (typeof window !== 'undefined') { window.JavaModule = _JavaModule; }
if (typeof module !== 'undefined' && module.exports) { module.exports = _JavaModule; }
})();
