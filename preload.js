/**
 * preload.js — запускается до renderer.js в изолированном Node.js-контексте.
 *
 * АРХИТЕКТУРА (contextIsolation: true):
 *   contextBridge.exposeInMainWorld() — единственный безопасный способ передать
 *   API из Node.js-мира в изолированный мир renderer.
 *
 *   window.electronAPI — единая точка входа для всех IPC-вызовов.
 *   window.appVersion  — версия приложения.
 *
 *   Renderer НЕ имеет доступа к require(), Node.js или ipcRenderer напрямую.
 *   Все операции идут только через этот мост.
 */

'use strict';

const { ipcRenderer, contextBridge } = require('electron');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');

// ─── Вспомогательная: listener с возможностью отписки ────────────────────────
function makeListener(channel, transform) {
    const handler = (_, ...args) => transform(...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
}

// ─── Публичный API рендерера через contextBridge ─────────────────────────────
contextBridge.exposeInMainWorld('electronAPI', {

    // ── Новости ───────────────────────────────────────────────────────────────
    getNews: () => ipcRenderer.invoke('get-news'),

    // ── Диалоги ───────────────────────────────────────────────────────────────
    openFolderDialog: () => ipcRenderer.invoke('open-folder-dialog'),
    openFile: (options) => ipcRenderer.invoke('open-file-dialog', options),

    // ── Управление окном ──────────────────────────────────────────────────────
    closeWindow:    () => ipcRenderer.send('close-launcher'),
    minimizeWindow: () => ipcRenderer.send('minimize-window'),
    maximizeWindow: () => ipcRenderer.send('maximize-window'),

    // ── Minecraft ─────────────────────────────────────────────────────────────
    mcLaunched: (pid) => ipcRenderer.invoke('mc-launched', pid),

    // ── Обновления ────────────────────────────────────────────────────────────
    checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
    downloadUpdate:  () => ipcRenderer.invoke('download-update'),
    quitAndInstall:  () => ipcRenderer.invoke('quit-and-install'),

    // ── Внешние ссылки ────────────────────────────────────────────────────────
    openExternal: (url) => ipcRenderer.invoke('open-external', url),
    openPath: (folderPath) => ipcRenderer.invoke('open-path', folderPath),

    // ── Буфер обмена / шаринг ─────────────────────────────────────────────────
    copyImageToClipboard: (dataUrl, text) =>
        ipcRenderer.invoke('copy-image-to-clipboard', dataUrl, text),
    saveShareImage: (dataUrl) => ipcRenderer.invoke('save-share-image', dataUrl),

    // ── Логирование ───────────────────────────────────────────────────────────
    log: (message, level) => ipcRenderer.invoke('log', message, level),

    // ── Диагностика ───────────────────────────────────────────────────────────
    runDiagnostics: () => ipcRenderer.invoke('run-diagnostics'),
    exportDebugLog: () => ipcRenderer.invoke('export-debug-log'),

    // ── Системная информация ──────────────────────────────────────────────────
    getProcessInfo: () => ipcRenderer.invoke('process:info'),
    getPlaytime:    () => ipcRenderer.invoke('playtime:get'),

    // ────────────────────────────────────────────────────────────────────────
    // FS BRIDGE — async файловые операции через IPC (main-процесс)
    // ────────────────────────────────────────────────────────────────────────
    fs: {
        exists:          (p)            => ipcRenderer.invoke('fs:exists', p),
        readdir:         (p)            => ipcRenderer.invoke('fs:readdir', p),
        readdirNames:    (p)            => ipcRenderer.invoke('fs:readdir-names', p),
        read:            (p, enc)       => ipcRenderer.invoke('fs:read', p, enc),
        write:           (p, data, enc) => ipcRenderer.invoke('fs:write', p, data, enc),
        append:          (p, data)      => ipcRenderer.invoke('fs:append', p, data),
        mkdir:           (p, opts)      => ipcRenderer.invoke('fs:mkdir', p, opts),
        unlink:          (p)            => ipcRenderer.invoke('fs:unlink', p),
        rename:          (o, n)         => ipcRenderer.invoke('fs:rename', o, n),
        copy:            (s, d)         => ipcRenderer.invoke('fs:copy', s, d),
        stat:            (p)            => ipcRenderer.invoke('fs:stat', p),
        readBinaryDataUrl: (p)          => ipcRenderer.invoke('fs:read-binary-dataurl', p),
        isDllCompatible: (p)           => ipcRenderer.invoke('fs:dll-compatible', p),
    },

    // ────────────────────────────────────────────────────────────────────────
    // DOWNLOAD — скачивание файлов в main-процессе (с прогрессом)
    // ────────────────────────────────────────────────────────────────────────
    download: {
        file:  (url, dest, id) => ipcRenderer.invoke('download:file', url, dest, id),
        abort: (id)            => ipcRenderer.invoke('download:abort', id),
    },

    // ────────────────────────────────────────────────────────────────────────
    // ZIP
    // ────────────────────────────────────────────────────────────────────────
    zip: {
        extract:   (z, d) => ipcRenderer.invoke('zip:extract', z, d),
        list:      (z)    => ipcRenderer.invoke('zip:list', z),
        readEntry: (z, e) => ipcRenderer.invoke('zip:read-entry', z, e),
    },

    // ────────────────────────────────────────────────────────────────────────
    // SHELL
    // ────────────────────────────────────────────────────────────────────────
    shell: {
        exec:  (cmd, opts) => ipcRenderer.invoke('shell:exec', cmd, opts),
        which: (bin)       => ipcRenderer.invoke('shell:which', bin),
    },

    // ────────────────────────────────────────────────────────────────────────
    // JAVA
    // ────────────────────────────────────────────────────────────────────────
    java: {
        find:         ()                        => ipcRenderer.invoke('java:find'),
        checkVersion: (jp)                      => ipcRenderer.invoke('java:check-version', jp),
        ensure:       (minecraftPath, javaPath) => ipcRenderer.invoke('java:ensure', { minecraftPath, currentJavaPath: javaPath }),
        onProgress:   (cb)                      => {
            ipcRenderer.on('java:progress', (_, data) => cb(data));
            return () => ipcRenderer.removeAllListeners('java:progress');
        },
    },

    // ────────────────────────────────────────────────────────────────────────
    // INSTALLER
    // ────────────────────────────────────────────────────────────────────────
    installer: {
        checkAndDownload: (minecraftPath, version, withMods) =>
            ipcRenderer.invoke('installer:check-and-download', { minecraftPath, version, withMods }),
        installModpack: (minecraftPath, versionType) =>
            ipcRenderer.invoke('installer:install-modpack', { minecraftPath, versionType }),
        extractNatives: (minecraftPath, version) =>
            ipcRenderer.invoke('installer:extract-natives', { minecraftPath, version }),
        onProgress: (cb) => {
            ipcRenderer.on('installer:progress', (_, data) => cb(data));
            return () => ipcRenderer.removeAllListeners('installer:progress');
        },
    },

    // ────────────────────────────────────────────────────────────────────────
    // MC SPAWN
    // ────────────────────────────────────────────────────────────────────────
    mc: {
        spawn: (params) => ipcRenderer.invoke('mc:spawn', params),
    },

    // ────────────────────────────────────────────────────────────────────────
    // SCREENSHOTS
    // ────────────────────────────────────────────────────────────────────────
    screenshots: {
        list:   (basePath) => ipcRenderer.invoke('screenshots:list', basePath),
        delete: (filePath) => ipcRenderer.invoke('screenshots:delete', filePath),
    },

    // ────────────────────────────────────────────────────────────────────────
    // INSTANCES
    // ────────────────────────────────────────────────────────────────────────
    instances: {
        list:        (bp)         => ipcRenderer.invoke('instances:list', bp),
        readConfig:  (ip)         => ipcRenderer.invoke('instances:read-config', ip),
        writeConfig: (ip, cfg)    => ipcRenderer.invoke('instances:write-config', ip, cfg),
        delete:      (ip)         => ipcRenderer.invoke('instances:delete', ip),
        createDirs:  (ip, subs)   => ipcRenderer.invoke('instances:create-dirs', ip, subs),
        export:      (ip, destDir)         => ipcRenderer.invoke('instances:export', ip, destDir),
        import:      (zip, base, name)     => ipcRenderer.invoke('instances:import', zip, base, name),
    },

    // ────────────────────────────────────────────────────────────────────────
    // MODS
    // ────────────────────────────────────────────────────────────────────────
    mods: {
        list:          (versionId, basePath) => ipcRenderer.invoke('mods:list', { versionId, basePath }),
        toggle:        (filePath, enable)    => ipcRenderer.invoke('mods:toggle', { filePath, enable }),
        delete:        (filePath)            => ipcRenderer.invoke('mods:delete', { filePath }),
        count:         (bp, vid)             => ipcRenderer.invoke('mods:count', bp, vid),
        parseMetadata: (jarPath)             => ipcRenderer.invoke('mods:parse-metadata', jarPath),
        copyToFolder:  (src, dir, name)      => ipcRenderer.invoke('mods:copy-to-folder', src, dir, name),
    },

    // ────────────────────────────────────────────────────────────────────────
    // SERVERS — пинг и servers.dat
    // ────────────────────────────────────────────────────────────────────────
    servers: {
        ping:              (host, port, timeout) => ipcRenderer.invoke('server:ping', host, port, timeout),
        readDat:           (mcDir)               => ipcRenderer.invoke('server:read-dat', mcDir),
        writeDat:          (mcDir, name, ip)     => ipcRenderer.invoke('server:write-dat', mcDir, name, ip),
        loadLocalServers:  ()                    => ipcRenderer.invoke('server:load-local'),
    },

    // ────────────────────────────────────────────────────────────────────────
    // CRYPTO
    // ────────────────────────────────────────────────────────────────────────
    crypto: {
        offlineUUID: (username) => ipcRenderer.invoke('crypto:offline-uuid', username),
        randomId: () => crypto.randomUUID(),
    },

    // ────────────────────────────────────────────────────────────────────────
    // HTTP — fetch JSON через main (убирает require('https') из renderer)
    // ────────────────────────────────────────────────────────────────────────
    http: {
        fetchJSON: (url) => ipcRenderer.invoke('http:fetch-json', url),
    },

    // ────────────────────────────────────────────────────────────────────────
    // PATH — синхронные утилиты (чистые функции, нет IPC, нет require в renderer)
    // ────────────────────────────────────────────────────────────────────────
    path: {
        join:       (...args) => path.join(...args),
        resolve:    (...args) => path.resolve(...args),
        basename:   (p, ext)  => path.basename(p, ext),
        dirname:    (p)       => path.dirname(p),
        extname:    (p)       => path.extname(p),
        relative:   (f, t)    => path.relative(f, t),
        isAbsolute: (p)       => path.isAbsolute(p),
        sep:        path.sep,
        delimiter:  path.delimiter,
    },

    // ────────────────────────────────────────────────────────────────────────
    // OS — синхронно (нет IPC)
    // ────────────────────────────────────────────────────────────────────────
    os: {
        platform: () => os.platform(),
        homedir:  () => os.homedir(),
        arch:     () => os.arch(),
        totalmem: () => os.totalmem(),
        freemem:  () => os.freemem(),
    },

    // ────────────────────────────────────────────────────────────────────────
    // ENV — ограниченный набор переменных окружения
    // ────────────────────────────────────────────────────────────────────────
    env: {
        APPDATA:   process.env.APPDATA   || null,
        JAVA_HOME: process.env.JAVA_HOME || null,
        HOME:      process.env.HOME      || null,
    },

    // ────────────────────────────────────────────────────────────────────────
    // СОБЫТИЯ из main (с авто-cleanup через возвращаемый unsubscribe)
    // ────────────────────────────────────────────────────────────────────────
    on: {
        updateProgress:     (cb) => makeListener('update-progress',       d  => cb(d)),
        updateAvailable:    (cb) => makeListener('update-available',       d  => cb(d)),
        mcClosed:           (cb) => makeListener('mc-closed',              () => cb()),
        mcProcessError:     (cb) => makeListener('mc-process-error',       d  => cb(d)),
        mcProcessExitError: (cb) => makeListener('mc-process-exit-error',  d  => cb(d)),
        playtimeUpdate:     (cb) => makeListener('playtime-update',        () => cb()),
        windowMaximized:    (cb) => makeListener('window-maximized',       () => cb()),
        windowUnmaximized:  (cb) => makeListener('window-unmaximized',     () => cb()),
        downloadProgress: (id, cb) =>
            makeListener(`download:progress:${id}`, d => cb(d)),
    },

    // ────────────────────────────────────────────────────────────────────────
    // LAUNCHER — служебные данные от main-процесса
    // ────────────────────────────────────────────────────────────────────────
    launcher: {
        basePath: () => ipcRenderer.invoke('launcher:base-path'),
    },

    // ────────────────────────────────────────────────────────────────────────
    // YGGDRASIL — порт локального mock-сервера авторизации (для MC < 1.17)
    // ────────────────────────────────────────────────────────────────────────
    yggdrasil: {
        getPort: () => ipcRenderer.invoke('yggdrasil:port'),
    },

    removeListener: (channel, callback) => ipcRenderer.removeListener(channel, callback),
});

// ── Версия приложения ─────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('appVersion', {
    getVersion: () => {
        try { return require('./package.json').version; }
        catch { return '0.0.0'; }
    },
});

