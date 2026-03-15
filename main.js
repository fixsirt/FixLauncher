const { app, BrowserWindow, ipcMain, dialog, shell, session } = require("electron");
const path = require("path");
const https = require("https");
const http  = require("http");
const fs = require("fs");

// ========== Discord Rich Presence ==========
let discordRpcClient = null;
let discordConnected = false;
let discordStartTimestamp = null;
let discordReconnectTimer = null;
let discordCurrentActivity = null;
let DiscordRPCLib = null;

function initDiscordRPC() {
    try {
        DiscordRPCLib = require('discord-rpc');
        discordConnect();
    } catch(e) {
        log("WARN", "discord-rpc module not available: " + e.message);
    }
}

function discordConnect() {
    if (!DiscordRPCLib) return;
    const clientId = '1475132415373742140';
    try {
        if (discordRpcClient) {
            try { discordRpcClient.destroy(); } catch(e) {}
            discordRpcClient = null;
        }
        const client = new DiscordRPCLib.Client({ transport: 'ipc' });
        discordRpcClient = client;

        client.on('ready', () => {
            discordConnected = true;
            if (discordReconnectTimer) {
                clearInterval(discordReconnectTimer);
                discordReconnectTimer = null;
            }
            log("INFO", "Discord RPC connected");
            // Восстанавливаем статус после реконнекта
            if (discordCurrentActivity) {
                applyDiscordActivity(discordCurrentActivity);
            } else {
                setDiscordActivity({ playing: false });
            }
        });

        client.on('disconnected', () => {
            discordConnected = false;
            log("WARN", "Discord RPC disconnected, scheduling reconnect...");
            discordScheduleReconnect();
        });

        client.login({ clientId }).catch(e => {
            discordConnected = false;
            log("WARN", "Discord RPC login failed: " + e.message);
            discordScheduleReconnect();
        });
    } catch(e) {
        log("WARN", "Discord connect() error: " + e.message);
        discordScheduleReconnect();
    }
}

function discordScheduleReconnect() {
    if (discordReconnectTimer) return;
    discordReconnectTimer = setInterval(() => {
        log("INFO", "Discord RPC reconnect attempt...");
        discordConnect();
    }, 15000);
}

function applyDiscordActivity(activity) {
    if (!discordRpcClient || !discordConnected) return;
    try {
        discordRpcClient.setActivity(activity);
    } catch(e) {
        log("WARN", "Discord setActivity error: " + e.message);
    }
}

function setDiscordActivity({ playing, playerName, version }) {
    const now = Date.now();
    if (playing && !discordStartTimestamp) discordStartTimestamp = now;
    if (!playing) discordStartTimestamp = null;

    const activity = {
        largeImageKey: 'fixlauncher_logo', // загрузи logo.png в Discord Dev Portal → Rich Presence → Art Assets с ключом fixlauncher_logo
        largeImageText: 'FixLauncher',
        instance: false,
    };

    if (playing && playerName && version) {
        activity.details = `Играет: ${playerName}`;
        activity.state = `Сборка: ${version}`;
        activity.smallImageKey = 'fixlauncher_logo';
        activity.smallImageText = 'В игре';
        activity.startTimestamp = discordStartTimestamp;
        activity.buttons = [
            { label: '⬇️ Скачать FixLauncher', url: 'https://t.me/rodfix_perehod' }
        ];
    } else {
        activity.details = 'FixLauncher';
        activity.state = 'Выбор сборки';
        activity.buttons = [
            { label: '⬇️ Скачать FixLauncher', url: 'https://t.me/rodfix_perehod' }
        ];
    }

    discordCurrentActivity = activity;
    applyDiscordActivity(activity);
}

function clearDiscordActivity() {
    discordCurrentActivity = null;
    discordStartTimestamp = null;
    if (!discordRpcClient || !discordConnected) return;
    try { discordRpcClient.clearActivity(); } catch(e) {}
}

// ========== Константы ==========
const NEWS_LAST_N_POSTS = 10;
const REQUEST_TIMEOUT = 5000;
const NEWS_CACHE_TTL = 5 * 60 * 1000; // 5 минут
// Константы вынесены в src/renderer/constants.js (П.5 рефакторинга)
const { NEWS_MD_URL: _NEWS_MD_URL, LOG_FILE_NAME } = require('./src/renderer/constants');
const NEWS_MD_URL = _NEWS_MD_URL;
const LOG_FILE    = path.join(__dirname, LOG_FILE_NAME);
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const LOG_ROTATIONS = 3;
const { getLauncherBasePath } = require("./src/paths");
const NEWS_CACHE_FILE = path.join(getLauncherBasePath(process.platform, require("os").homedir(), process.env.APPDATA), "news-cache.json");

// ========== Состояние ==========
let mainWindow = null;
const newsCache = { items: [], timestamp: 0 };

function rotateLogsIfNeeded() {
    try {
        if (!fs.existsSync(LOG_FILE)) return;
        const stat = fs.statSync(LOG_FILE);
        if (stat.size < LOG_MAX_BYTES) return;

        for (let i = LOG_ROTATIONS - 1; i >= 1; i--) {
            const src = `${LOG_FILE}.${i}`;
            const dst = `${LOG_FILE}.${i + 1}`;
            if (fs.existsSync(src)) fs.renameSync(src, dst);
        }

        fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    } catch (e) {
        console.error('Log rotation error:', e.message);
    }
}

function writeNewsDiskCache(items) {
    try {
        const dir = path.dirname(NEWS_CACHE_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(NEWS_CACHE_FILE, JSON.stringify({ items, timestamp: Date.now() }), 'utf8');
    } catch (e) {
        log('WARN', `Failed to write news cache: ${e.message}`);
    }
}

function readNewsDiskCache() {
    try {
        if (!fs.existsSync(NEWS_CACHE_FILE)) return [];
        const data = JSON.parse(fs.readFileSync(NEWS_CACHE_FILE, 'utf8'));
        return Array.isArray(data.items) ? data.items : [];
    } catch (e) {
        return [];
    }
}

/**
 * Парсер NEWS.md.
 *
 * Поддерживаемый формат:
 *   ## Заголовок (дата)
 *   Тело новости...
 *
 *   ---
 *
 *   ## Следующая новость (дата)
 *   ...
 *
 * Разделитель — `---` на ОТДЕЛЬНОЙ строке с пустыми строками вокруг (^---$).
 * Это позволяет использовать `---` внутри тела новости без разрыва блока.
 * Ранее `split(/\n---+\n/)` было хрупким — любой дефис-ряд ломал парсинг.
 */
function parseNewsMd(md) {
    // Разделитель: строка, состоящая ровно из трёх дефисов, окружённая переносами строк.
    // ^---$ матчит только "---" в начале строки (без дополнительного контента).
    const blocks = md.split(/\n{1,2}^---$\n{1,2}/m)
        .map(b => b.trim())
        .filter(Boolean);

    return blocks.map(block => {
        const lines = block.split('\n');
        let title = '';
        let date  = '';
        const titleMatch = lines[0].match(/^##\s+(.+?)(?:\s+\((.+?)\))?$/);
        if (titleMatch) {
            title = titleMatch[1].trim();
            date  = titleMatch[2] ? titleMatch[2].trim() : '';
        } else {
            title = lines[0].replace(/^#+\s*/, '').trim();
        }
        const body = lines.slice(1).join('\n').trim();
        return { title, date, body };
    });
}

function fetchUrl(url, redirectsLeft) {
    if (redirectsLeft === undefined) redirectsLeft = 5;
    return new Promise((resolve) => {
        const https = require('https');
        const req = https.get(url, { timeout: REQUEST_TIMEOUT }, (res) => {
            // Обработка редиректов (301, 302, 307, 308)
            if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
                res.resume(); // сбросить тело
                resolve(fetchUrl(res.headers.location, redirectsLeft - 1));
                return;
            }
            if (res.statusCode !== 200) {
                log('WARN', `fetchUrl: HTTP ${res.statusCode} for ${url}`);
                res.resume();
                resolve(null);
                return;
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        });
        req.on('error', (e) => { log('ERROR', `fetchUrl error: ${e.message}`); resolve(null); });
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

function fetchNewsMd() {
    return fetchUrl(NEWS_MD_URL);
}

// ========== Playtime + MC Watch ==========
const os = require("os");
const { getPlaytimePath: getCanonicalPlaytimePath, getLegacyBasePaths } = require("./src/paths");

function getPlaytimePath() {
    try {
        const canonicalPath = getCanonicalPlaytimePath(process.platform, os.homedir(), process.env.APPDATA);
        if (fs.existsSync(canonicalPath)) return canonicalPath;

        const legacyPaths = getLegacyBasePaths(process.platform, os.homedir(), process.env.APPDATA)
            .map((legacyBase) => path.join(legacyBase, 'launcher-playtime.json'));

        const legacyExisting = legacyPaths.find((legacyPath) => fs.existsSync(legacyPath));
        if (legacyExisting) {
            const canonicalDir = path.dirname(canonicalPath);
            if (!fs.existsSync(canonicalDir)) fs.mkdirSync(canonicalDir, { recursive: true });
            fs.copyFileSync(legacyExisting, canonicalPath);
            log('INFO', `Migrated legacy playtime file: ${legacyExisting} -> ${canonicalPath}`);
            return canonicalPath;
        }

        return canonicalPath;
    } catch(e) { return null; }
}

function readPlaytime() {
    try {
        const fp = getPlaytimePath();
        if (!fp || !fs.existsSync(fp)) return { totalSeconds: 0, sessionStart: null };
        return JSON.parse(fs.readFileSync(fp, "utf8"));
    } catch(e) { return { totalSeconds: 0, sessionStart: null }; }
}

function writePlaytime(data) {
    try {
        const fp = getPlaytimePath();
        if (!fp) return;
        const dir = path.dirname(fp);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(fp, JSON.stringify(data), "utf8");
        log("INFO", "Playtime saved: " + JSON.stringify(data));
    } catch(e) { log("ERROR", "Playtime write error: " + e.message); }
}

let mcWatchInterval = null;
let mcPid = null;

function isPidRunning(pid) {
    try {
        // signal 0 не убивает процесс, но бросает исключение если PID не существует
        process.kill(pid, 0);
        return true;
    } catch(e) {
        return false;
    }
}

function addDailySeconds(data, seconds) {
    if (!seconds || seconds <= 0) return;
    const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
    if (!data.daily) data.daily = {};
    data.daily[today] = (data.daily[today] || 0) + seconds;
    // Чистим данные старше 30 дней
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    for (const key of Object.keys(data.daily)) {
        if (key < cutoff) delete data.daily[key];
    }
}

function startMcWatch(pid) {
    mcPid = pid;
    // Записываем старт сессии
    const data = readPlaytime();
    if (data.sessionStart) {
        // Предыдущая сессия не закрылась — засчитываем
        const elapsed = Math.floor((Date.now() - data.sessionStart) / 1000);
        if (elapsed > 0 && elapsed < 86400) {
            data.totalSeconds = (data.totalSeconds || 0) + elapsed;
            addDailySeconds(data, elapsed);
        }
    }
    data.sessionStart = Date.now();
    writePlaytime(data);

    // Скрываем окно лаунчера (не закрываем — иначе app.quit() убьёт процесс)
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.hide();
    }

    // Следим за MC процессом — проверяем раз в 5 сек (минимальная нагрузка)
    if (mcWatchInterval) clearInterval(mcWatchInterval);
    mcWatchInterval = setInterval(() => {
        if (!isPidRunning(mcPid)) {
            clearInterval(mcWatchInterval);
            mcWatchInterval = null;
            mcPid = null;
            // Завершаем сессию
            const d = readPlaytime();
            if (d.sessionStart) {
                const elapsed = Math.floor((Date.now() - d.sessionStart) / 1000);
                if (elapsed > 0 && elapsed < 86400) {
                    d.totalSeconds = (d.totalSeconds || 0) + elapsed;
                    addDailySeconds(d, elapsed);
                }
                d.sessionStart = null;
                writePlaytime(d);
            }
            // Discord — возвращаемся в лаунчер
            setDiscordActivity({ playing: false });
            // Открываем лаунчер снова
            log("INFO", "Minecraft closed, reopening launcher");
            createWindow();
        }
    }, 5000);
}

// При старте приложения — закрываем незавершённую сессию (если лаунчер упал)
function initPlaytimeOnStart() {
    try {
        const data = readPlaytime();
        if (data.sessionStart) {
            const elapsed = Math.floor((Date.now() - data.sessionStart) / 1000);
            if (elapsed > 0 && elapsed < 86400) {
                data.totalSeconds = (data.totalSeconds || 0) + elapsed;
                addDailySeconds(data, elapsed);
            }
            data.sessionStart = null;
            writePlaytime(data);
            log("INFO", "Recovered unfinished playtime session");
        }
    } catch(e) {}
}



// ========== Логирование ==========
function log(level, message) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}][${level}] ${message}\n`;
    console.log(line.trim());
    try {
        rotateLogsIfNeeded();
        fs.appendFileSync(LOG_FILE, line);
    } catch (e) {}
}

// ========== Создание окна ==========



function createWindow() {
    // Если окно уже существует (было скрыто) — просто показываем его
    if (mainWindow && !mainWindow.isDestroyed()) {
        log("INFO", "Showing existing window");
        mainWindow.show();
        mainWindow.focus();
        // Сбрасываем кнопку ИГРАТЬ и обновляем playtime
        setTimeout(() => {
            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                mainWindow.webContents.send('mc-closed');
                mainWindow.webContents.send('playtime-update');
            }
        }, 300);
        return;
    }
    log("INFO", "Creating main window");
    
    mainWindow = new BrowserWindow({
        width: 1100,
        height: 650,
        minWidth: 900,
        minHeight: 600,
        frame: false,
        resizable: true,
        maximizable: true,
        fullscreenable: true,
        show: false,
        backgroundColor: "#0d0d0d",
        icon: path.join(__dirname, "logo.ico"),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            // ── Безопасность ────────────────────────────────────────────────────────────
            // contextIsolation: true  — renderer изолирован от Node.js-мира.
            //   Весь доступ к Node.js/IPC идёт только через contextBridge (preload.js).
            // nodeIntegration: false  — renderer не имеет доступа к require() Node.js.
            //   Renderer-код использует CommonJS require() только для локальных модулей
            //   (launcher.js, versions.js и т.д.), которые в свою очередь работают
            //   исключительно через window.electronAPI (contextBridge).
            //
            // Дополнительные меры:
            //   - setPermissionRequestHandler → всё запрещено
            //   - setWindowOpenHandler → только https/http, deny всё остальное
            //   - will-navigate → блокируем навигацию на внешние URL
            //   - open-external IPC → валидация протокола (только https/http)
            //   - sandbox: true — renderer запускается в OS-sandbox (Chromium sandbox)
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false, // sandbox:true несовместим с preload, использующим require('electron')
            enableRemoteModule: false,
        }
    });

    mainWindow.loadFile("index.html");

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        try {
            const u = new URL(url);
            if (u.protocol === "https:" || u.protocol === "http:") {
                shell.openExternal(u.toString());
            }
        } catch (e) {}
        return { action: "deny" };
    });

    mainWindow.webContents.on("will-navigate", (event, url) => {
        if (!url.startsWith("file://")) {
            event.preventDefault();
            shell.openExternal(url);
        }
    });

    mainWindow.once("ready-to-show", () => {
        mainWindow.show();
    });

    const sendMaximizedState = () => {
        if (mainWindow?.webContents && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send(mainWindow.isMaximized() ? "window-maximized" : "window-unmaximized");
        }
    };

    mainWindow.on("maximize", sendMaximizedState);
    mainWindow.on("unmaximize", sendMaximizedState);
    
    log("INFO", "Main window created successfully");
}

// ========== Авто-обновление через GitHub Releases ==========

const GITHUB_REPO = 'fixsirt/FixLauncher';
let latestReleaseInfo = null;

function versionToInt(v) {
    return v.split('.').map(Number).reduce((a, b) => a * 1000 + b, 0);
}

async function fetchJsonWithRetry(url, attempts = 3, timeout = 10000) {
    for (let i = 1; i <= attempts; i++) {
        const rawData = await new Promise((resolve) => {
            const req = require('https').get(url, {
                headers: { 'User-Agent': 'FixLauncher-Updater' },
                timeout
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve(res.statusCode === 200 ? data : null));
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
        });
        if (rawData) return JSON.parse(rawData);
        await new Promise((r) => setTimeout(r, 500 * i));
    }
    return null;
}

async function checkGitHubUpdate() {
    try {
        const currentVersion = app.getVersion();
        log('INFO', `Checking for updates. Current version: ${currentVersion}`);
        const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
        const release = await fetchJsonWithRetry(apiUrl, 3, 10000);
        if (!release) throw new Error('Empty response from GitHub API');
        const latestVersion = (release.tag_name || '').replace(/^[^\d]*/i, '').replace(/[^\d.].*/,'').trim();
        log('INFO', `Latest version on GitHub: ${latestVersion}`);
        if (versionToInt(latestVersion) > versionToInt(currentVersion)) {
            // Найти .exe или платформо-специфичный ассет
            const platform = process.platform;
            let assetUrl = null;
            let assetName = null;
            if (release.assets && release.assets.length > 0) {
                let asset = null;
                if (platform === 'win32') {
                    asset = release.assets.find(a => a.name.endsWith('.exe') || a.name.includes('Setup'));
                } else if (platform === 'darwin') {
                    asset = release.assets.find(a => a.name.endsWith('.dmg'));
                } else {
                    asset = release.assets.find(a => a.name.endsWith('.AppImage') || a.name.endsWith('.deb'));
                }
                if (!asset) asset = release.assets[0];
                assetUrl = asset.browser_download_url;
                assetName = asset.name;
            }

            latestReleaseInfo = {
                version: latestVersion,
                url: release.html_url,
                downloadUrl: assetUrl,
                assetName: assetName,
                notes: release.body || ''
            };
            log('INFO', `New version available: ${latestVersion}`);
            // Уведомить renderer
            if (mainWindow && mainWindow.webContents) {
                mainWindow.webContents.send('update-available', latestReleaseInfo);
            }
        } else {
            log('INFO', 'No updates available.');
            latestReleaseInfo = null;
        }
    } catch (e) {
        log('ERROR', `Update check failed: ${e.message}`);
    }
}

// IPC: запросить инфо о последнем обновлении (если уже есть)
ipcMain.handle('check-for-updates', async () => {
    await checkGitHubUpdate();
    return latestReleaseInfo;
});

// IPC: скачать и установить обновление
ipcMain.handle('download-update', async () => {
    if (!latestReleaseInfo || !latestReleaseInfo.downloadUrl) {
        if (latestReleaseInfo && latestReleaseInfo.url) {
            shell.openExternal(latestReleaseInfo.url);
        }
        return { ok: false, reason: 'no_asset' };
    }
    try {
        const tmpDir = require('os').tmpdir();
        const destPath = require('path').join(tmpDir, latestReleaseInfo.assetName);
        log('INFO', `Downloading update to: ${destPath}`);

        await new Promise((resolve, reject) => {
            const file = fs.createWriteStream(destPath);
            function download(url) {
                const mod = url.startsWith('https') ? require('https') : require('http');
                mod.get(url, { headers: { 'User-Agent': 'FixLauncher-Updater' } }, res => {
                    if (res.statusCode === 302 || res.statusCode === 301) {
                        file.close();
                        const newFile = fs.createWriteStream(destPath);
                        const newMod = res.headers.location.startsWith('https') ? require('https') : require('http');
                        newMod.get(res.headers.location, { headers: { 'User-Agent': 'FixLauncher-Updater' } }, res2 => {
                            const total = parseInt(res2.headers['content-length'] || '0', 10);
                            let received = 0;
                            res2.on('data', chunk => {
                                received += chunk.length;
                                newFile.write(chunk);
                                if (total > 0 && mainWindow) {
                                    mainWindow.webContents.send('update-progress', Math.round(received / total * 100));
                                }
                            });
                            res2.on('end', () => { newFile.close(); resolve(); });
                            res2.on('error', reject);
                        }).on('error', reject);
                    } else {
                        const total = parseInt(res.headers['content-length'] || '0', 10);
                        let received = 0;
                        res.on('data', chunk => {
                            received += chunk.length;
                            file.write(chunk);
                            if (total > 0 && mainWindow) {
                                mainWindow.webContents.send('update-progress', Math.round(received / total * 100));
                            }
                        });
                        res.on('end', () => { file.close(); resolve(); });
                        res.on('error', reject);
                    }
                }).on('error', reject);
            }
            download(latestReleaseInfo.downloadUrl);
        });

        log('INFO', 'Update downloaded. Opening installer.');
        shell.openPath(destPath);
        setTimeout(() => { app.quit(); }, 2000);
        return { ok: true };
    } catch (e) {
        log('ERROR', `Download update failed: ${e.message}`);
        // Fallback: открыть страницу релиза
        shell.openExternal(latestReleaseInfo.url);
        return { ok: false, reason: e.message };
    }
});

ipcMain.handle('quit-and-install', () => {
    app.quit();
});

// ========== IPC Обработчики ==========

// Новости (с кэшем!)
ipcMain.handle("get-news", async () => {
    const now = Date.now();
    if (newsCache.items.length > 0 && now - newsCache.timestamp < NEWS_CACHE_TTL) {
        log("INFO", "Returning cached news");
        return { ok: true, items: newsCache.items, cached: true };
    }
    log("INFO", "Fetching NEWS.md from GitHub");
    try {
        const md = await fetchNewsMd();
        if (!md) throw new Error("Empty response");
        const items = parseNewsMd(md).slice(0, NEWS_LAST_N_POSTS);
        newsCache.items = items;
        newsCache.timestamp = now;
        writeNewsDiskCache(items);
        log("INFO", `Parsed ${items.length} news items from NEWS.md`);
        return { ok: true, items, cached: false };
    } catch (err) {
        log("ERROR", `News fetch error: ${err.message}`);
        const fallbackItems = newsCache.items.length > 0 ? newsCache.items : readNewsDiskCache();
        return {
            ok: fallbackItems.length > 0,
            error: err.message || "Ошибка загрузки",
            items: fallbackItems,
            cached: fallbackItems.length > 0
        };
    }
});

// Выбор папки
ipcMain.handle("open-folder-dialog", async () => {
    log("INFO", "Opening folder dialog");
    return dialog.showOpenDialog({
        properties: ["openDirectory"],
        title: "Выберите папку FixLauncher"
    });
});

// Открыть папку в проводнике
ipcMain.handle("open-path", async (event, folderPath) => {
    log("INFO", `Opening path: ${folderPath}`);
    const fs = require('fs');
    if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true });
    }
    shell.openPath(folderPath);
});

// Выбор файла
ipcMain.handle("open-file-dialog", async (event, options) => {
    log("INFO", "Opening file dialog");
    return dialog.showOpenDialog({
        filters: options?.filters || [],
        title: options?.title || "Выберите файл",
        properties: ["openFile"]
    });
});

ipcMain.handle('log', (event, message, level = 'INFO') => {
    const safeLevel = String(level || 'INFO').toUpperCase();
    const safeMessage = typeof message === 'string' ? message : JSON.stringify(message);
    log(safeLevel, `[renderer] ${safeMessage}`);
    return true;
});

// Закрыть окно
ipcMain.on("close-launcher", () => {
    log("INFO", "Closing launcher");
    mainWindow?.close();
});

// Свернуть
ipcMain.on("minimize-window", () => {
    log("INFO", "Minimizing window");
    mainWindow?.minimize();
});

// Развернуть / восстановить
ipcMain.on("maximize-window", () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
    } else {
        mainWindow.maximize();
    }
});


// MC запущен — renderer сообщает PID, main следит и переоткрывает лаунчер
ipcMain.handle("mc-launched", (event, pid) => {
    log("INFO", "Minecraft launched, PID: " + pid);
    startMcWatch(pid);
});

// Discord RPC — статус в меню / запуск
ipcMain.handle("discord-set-playing", (event, { playerName, version }) => {
    setDiscordActivity({ playing: true, playerName, version });
});
ipcMain.handle("discord-set-idle", () => {
    setDiscordActivity({ playing: false });
});

// Открытие ссылки в браузере (для шаринга)
ipcMain.handle('open-external', (event, url) => {
    try {
        const parsed = new URL(String(url || ''));
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
            log('WARN', `Blocked open-external with unsupported protocol: ${parsed.protocol}`);
            return false;
        }
        shell.openExternal(parsed.toString());
        return true;
    } catch (e) {
        log('WARN', `Blocked open-external with invalid URL: ${url}`);
        return false;
    }
});

ipcMain.handle("copy-image-to-clipboard", (event, dataUrl, text) => {
    try {
        const { clipboard, nativeImage } = require('electron');
        const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
        const img = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'));
        // Записываем картинку и текст одновременно в один вызов
        clipboard.write({
            image: img,
            text: text || ''
        });
        log("INFO", "Share image+text copied to clipboard");
        return true;
    } catch(e) {
        log("ERROR", "copy-image-to-clipboard: " + e.message);
        return false;
    }
});

ipcMain.handle("save-share-image", async (event, dataUrl) => {
    try {
        const { filePath } = await dialog.showSaveDialog({
            title: 'Сохранить картинку для шэринга',
            defaultPath: 'fixlauncher-share.png',
            filters: [{ name: 'PNG Image', extensions: ['png'] }]
        });
        if (!filePath) return null;
        const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
        require('fs').writeFileSync(filePath, Buffer.from(base64, 'base64'));
        log("INFO", "Share image saved: " + filePath);
        return filePath;
    } catch(e) {
        log("ERROR", "save-share-image: " + e.message);
        return null;
    }
});



// ─── IPC: Моды (делегируем в src/mods.js — единая бизнес-логика) ─────────────
// Рендерер вызывает эти хэндлеры вместо того чтобы дублировать логику у себя.
// Пока рендерер ещё использует свой код напрямую (nodeIntegration: true),
// но при переходе на contextIsolation все вызовы fs уедут сюда.
const srcMods = (() => {
    try { return require('./src/mods'); }
    catch { log('WARN', 'src/mods.js не загружен'); return null; }
})();

ipcMain.handle('mods:list', async (event, { versionId, basePath }) => {
    if (!srcMods) return { ok: false, code: 'ERR_MODULE_UNAVAILABLE', error: 'mods module not available', mods: [] };
    try {
        const mods = srcMods.getInstalledMods(versionId, basePath);
        return { ok: true, mods };
    } catch (err) {
        log('ERROR', `mods:list failed: ${err.message}`);
        return { ok: false, code: 'ERR_FS_READ', error: err.message, mods: [] };
    }
});

ipcMain.handle('mods:toggle', async (event, { filePath, enable }) => {
    if (!srcMods) return { ok: false, code: 'ERR_MODULE_UNAVAILABLE', error: 'mods module not available' };
    try {
        srcMods.toggleMod(filePath, enable);
        return { ok: true };
    } catch (err) {
        log('ERROR', `mods:toggle failed: ${err.message}`);
        return { ok: false, code: 'ERR_FS_WRITE', error: err.message };
    }
});

ipcMain.handle('mods:delete', async (event, { filePath }) => {
    if (!srcMods) return { ok: false, code: 'ERR_MODULE_UNAVAILABLE', error: 'mods module not available' };
    try {
        srcMods.deleteMod(filePath);
        return { ok: true };
    } catch (err) {
        log('ERROR', `mods:delete failed: ${err.message}`);
        return { ok: false, code: 'ERR_FS_WRITE', error: err.message };
    }
});

ipcMain.handle('run-diagnostics', async () => {
    const basePath = getLauncherBasePath(process.platform, require('os').homedir(), process.env.APPDATA);
    const checks = []; // FIX: was undefined — caused TypeError crash

    try {
        if (!fs.existsSync(basePath)) fs.mkdirSync(basePath, { recursive: true });
        const probe = path.join(basePath, '.write-test');
        fs.writeFileSync(probe, 'ok');
        fs.unlinkSync(probe);
        checks.push({ name: 'Data directory writable', ok: true, details: basePath });
    } catch (e) {
        checks.push({ name: 'Data directory writable', ok: false, details: e.message });
    }

    checks.push({ name: 'News disk cache', ok: fs.existsSync(NEWS_CACHE_FILE), details: NEWS_CACHE_FILE });
    checks.push({ name: 'Debug log present', ok: fs.existsSync(LOG_FILE), details: LOG_FILE });

    try {
        const release = await fetchJsonWithRetry(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, 1, 6000);
        checks.push({ name: 'GitHub API reachability', ok: !!release, details: release ? 'ok' : 'failed' });
    } catch (e) {
        checks.push({ name: 'GitHub API reachability', ok: false, details: e.message });
    }

    return {
        platform: process.platform,
        checks,
        generatedAt: Date.now()
    };
});

ipcMain.handle('export-debug-log', async () => {
    try {
        const { filePath } = await dialog.showSaveDialog({
            title: 'Экспорт debug.log',
            defaultPath: `fixlauncher-debug-${Date.now()}.log`,
            filters: [{ name: 'Log', extensions: ['log', 'txt'] }]
        });

        if (!filePath) return null;
        if (!fs.existsSync(LOG_FILE)) {
            fs.writeFileSync(filePath, 'No debug log yet', 'utf8');
        } else {
            fs.copyFileSync(LOG_FILE, filePath);
        }
        return filePath;
    } catch (e) {
        log('ERROR', `Export debug log failed: ${e.message}`);
        return null;
    }
});

// ════════════════════════════════════════════════════════════════════════════════
// ─── HTTP BRIDGE — fetchJSON для renderer (убирает require('https') из renderer) ──
// Renderer при contextIsolation:true не может использовать require('https').
// Этот хендлер делает HTTP/HTTPS GET-запрос в main-процессе и возвращает
// распарсенный JSON обратно в renderer через IPC.
ipcMain.handle('http:fetch-json', async (_, url) => {
    const urlStr = String(url);
    try {
        const parsed = new URL(urlStr);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
            return { error: `Недопустимый протокол: ${parsed.protocol}` };
        }
    } catch {
        return { error: `Некорректный URL: ${urlStr}` };
    }
    return new Promise((resolve) => {
        const mod = urlStr.startsWith('https') ? require('https') : require('http');
        const req = mod.get(urlStr, { headers: { 'User-Agent': 'FixLauncher/1.0' } }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                // Один редирект
                mod.get(res.headers.location, { headers: { 'User-Agent': 'FixLauncher/1.0' } }, (res2) => {
                    let d = '';
                    res2.on('data', c => { d += c; });
                    res2.on('end', () => {
                        try { resolve(JSON.parse(d)); }
                        catch (e) { resolve({ error: 'JSON parse error: ' + e.message }); }
                    });
                }).on('error', e => resolve({ error: e.message }));
                return;
            }
            if (res.statusCode === 403) { resolve({ error: 'HTTP 403 — доступ запрещён' }); return; }
            if (res.statusCode !== 200) { resolve({ error: `HTTP ${res.statusCode}` }); return; }
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { resolve({ error: 'JSON parse error: ' + e.message }); }
            });
        });
        req.on('error', e => resolve({ error: 'Network error: ' + e.message }));
        req.setTimeout(30000, () => { req.destroy(); resolve({ error: 'Request timeout' }); });
    });
});

// ─── ЗАЩИТА ПУТЕЙ — проверка path traversal для всех файловых IPC ────────────
// Возвращает true, если resolvedPath находится внутри одной из разрешённых папок.
// Вызывается во всех fs:* хендлерах перед операцией.
function isAllowedPath(targetPath) {
    const resolved = path.resolve(String(targetPath));
    const launcherBase = path.resolve(getLauncherBasePath(process.platform, require('os').homedir(), process.env.APPDATA));
    const appDir       = path.resolve(__dirname);
    const tempDir      = path.resolve(require('os').tmpdir());

    // Разрешаем только пути внутри: папки лаунчера, папки самого приложения, temp
    const allowed = [launcherBase, appDir, tempDir];
    return allowed.some(base => resolved === base || resolved.startsWith(base + path.sep));
}

// FS-BRIDGE — безопасный мост к файловой системе для renderer
// Renderer не имеет прямого доступа к fs через contextBridge при nodeIntegration:false.
// Все операции проходят через isAllowedPath() — защита от path traversal атак.
// ════════════════════════════════════════════════════════════════════════════════

ipcMain.handle('fs:exists', (_, filePath) => {
    try { return fs.existsSync(String(filePath)); }
    catch { return false; }
});

ipcMain.handle('fs:readdir', async (_, dirPath, opts = {}) => {
    try {
        const entries = await fs.promises.readdir(String(dirPath), { withFileTypes: true });
        return entries.map(e => ({
            name: e.name,
            isDirectory: e.isDirectory(),
            isFile: e.isFile(),
        }));
    } catch { return []; }
});

ipcMain.handle('fs:readdir-names', async (_, dirPath) => {
    try { return await fs.promises.readdir(String(dirPath)); }
    catch { return []; }
});

ipcMain.handle('fs:read', async (_, filePath, encoding = 'utf8') => {
    try { return await fs.promises.readFile(String(filePath), encoding); }
    catch { return null; }
});

ipcMain.handle('fs:write', async (_, filePath, data, encoding = 'utf8') => {
    if (!isAllowedPath(filePath)) {
        log('WARN', `fs:write blocked — path outside allowed dirs: ${filePath}`);
        return false;
    }
    try {
        const dir = path.dirname(String(filePath));
        await fs.promises.mkdir(dir, { recursive: true });
        await fs.promises.writeFile(String(filePath), data, encoding);
        return true;
    } catch (e) {
        log('ERROR', `fs:write ${filePath}: ${e.message}`);
        return false;
    }
});

ipcMain.handle('fs:append', async (_, filePath, data) => {
    if (!isAllowedPath(filePath)) {
        log('WARN', `fs:append blocked — path outside allowed dirs: ${filePath}`);
        return false;
    }
    try { await fs.promises.appendFile(String(filePath), data, 'utf8'); return true; }
    catch { return false; }
});

ipcMain.handle('fs:mkdir', async (_, dirPath, opts = { recursive: true }) => {
    if (!isAllowedPath(dirPath)) {
        log('WARN', `fs:mkdir blocked — path outside allowed dirs: ${dirPath}`);
        return false;
    }
    try { await fs.promises.mkdir(String(dirPath), opts); return true; }
    catch { return false; }
});

ipcMain.handle('fs:unlink', async (_, filePath) => {
    if (!isAllowedPath(filePath)) {
        log('WARN', `fs:unlink blocked — path outside allowed dirs: ${filePath}`);
        return false;
    }
    try { await fs.promises.unlink(String(filePath)); return true; }
    catch { return false; }
});

ipcMain.handle('fs:rename', async (_, oldPath, newPath) => {
    if (!isAllowedPath(oldPath) || !isAllowedPath(newPath)) {
        log('WARN', `fs:rename blocked — path outside allowed dirs: ${oldPath} → ${newPath}`);
        return false;
    }
    try { await fs.promises.rename(String(oldPath), String(newPath)); return true; }
    catch (e) { log('ERROR', `fs:rename: ${e.message}`); return false; }
});

ipcMain.handle('fs:copy', async (_, src, dst) => {
    if (!isAllowedPath(src) || !isAllowedPath(dst)) {
        log('WARN', `fs:copy blocked — path outside allowed dirs: ${src} → ${dst}`);
        return false;
    }
    try {
        await fs.promises.mkdir(path.dirname(String(dst)), { recursive: true });
        await fs.promises.copyFile(String(src), String(dst));
        return true;
    } catch (e) { log('ERROR', `fs:copy: ${e.message}`); return false; }
});

ipcMain.handle('fs:stat', async (_, filePath) => {
    try {
        const s = await fs.promises.stat(String(filePath));
        return { isDirectory: s.isDirectory(), isFile: s.isFile(), size: s.size, mtimeMs: s.mtimeMs };
    } catch { return null; }
});

// Проверяет совместимость DLL с текущей архитектурой по PE-заголовку.
// Возвращает true если DLL подходит, false если нет или файл повреждён.
ipcMain.handle('fs:dll-compatible', async (_, dllPath) => {
    try {
        const fd = await fs.promises.open(String(dllPath), 'r');
        try {
            const mzBuf = Buffer.alloc(4);
            await fd.read(mzBuf, 0, 4, 0);
            if (mzBuf[0] !== 0x4D || mzBuf[1] !== 0x5A) return false; // not MZ
            const peBuf = Buffer.alloc(4);
            await fd.read(peBuf, 0, 4, 0x3C);
            const peOffset = peBuf.readUInt32LE(0);
            const machineBuf = Buffer.alloc(2);
            await fd.read(machineBuf, 0, 2, peOffset + 4);
            const machine = machineBuf.readUInt16LE(0);
            const is64bit = (machine === 0x8664 || machine === 0xAA64);
            return process.arch === 'x64' ? is64bit : !is64bit;
        } finally {
            await fd.close();
        }
    } catch { return false; }
});



ipcMain.handle('fs:read-binary-dataurl', async (_, filePath) => {
    try {
        const buf = await fs.promises.readFile(String(filePath));
        const ext = path.extname(filePath).slice(1).toLowerCase();
        const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[ext] || 'application/octet-stream';
        return `data:${mime};base64,${buf.toString('base64')}`;
    } catch { return null; }
});

// ════════════════════════════════════════════════════════════════════════════════
// DOWNLOAD — скачивание файлов из main-процесса (с прогрессом)
// ════════════════════════════════════════════════════════════════════════════════

/** Активные загрузки: Map<progressId, AbortController-like> */
const _activeDownloads = new Map();

ipcMain.handle('download:file', async (event, url, destPath, progressId) => {
    const { net } = require('electron');
    const id = String(progressId || Date.now());
    let aborted = false;
    _activeDownloads.set(id, { abort: () => { aborted = true; } });

    try {
        await fs.promises.mkdir(path.dirname(String(destPath)), { recursive: true });

        const result = await new Promise((resolve, reject) => {
            function doDownload(targetUrl, redirectsLeft = 5) {
                if (aborted) { reject(new Error('aborted')); return; }
                const mod = targetUrl.startsWith('https') ? require('https') : require('http');
                mod.get(targetUrl, { headers: { 'User-Agent': 'FixLauncher/2.0' } }, res => {
                    if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
                        res.resume();
                        doDownload(res.headers.location, redirectsLeft - 1);
                        return;
                    }
                    if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }

                    const total = parseInt(res.headers['content-length'] || '0', 10);
                    let received = 0;
                    const file = fs.createWriteStream(String(destPath));

                    res.on('data', chunk => {
                        if (aborted) { file.close(); reject(new Error('aborted')); return; }
                        received += chunk.length;
                        file.write(chunk);
                        if (total > 0 && mainWindow && !mainWindow.isDestroyed()) {
                            mainWindow.webContents.send(`download:progress:${id}`, { received, total, pct: Math.round(received / total * 100) });
                        }
                    });
                    res.on('end', () => { file.close(); resolve(); });
                    res.on('error', reject);
                    file.on('error', reject);
                }).on('error', reject);
            }
            doDownload(String(url));
        });

        _activeDownloads.delete(id);
        return { ok: true };
    } catch (e) {
        _activeDownloads.delete(id);
        log('ERROR', `download:file ${url} → ${destPath}: ${e.message}`);
        try { await fs.promises.unlink(String(destPath)); } catch { /* ignore cleanup errors */ }
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('download:abort', (_, progressId) => {
    const dl = _activeDownloads.get(String(progressId));
    if (dl) { dl.abort(); _activeDownloads.delete(String(progressId)); return true; }
    return false;
});

// ════════════════════════════════════════════════════════════════════════════════
// ZIP — распаковка архивов
// ════════════════════════════════════════════════════════════════════════════════

ipcMain.handle('zip:extract', async (_, zipPath, destDir) => {
    try {
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(String(zipPath));
        await fs.promises.mkdir(String(destDir), { recursive: true });
        zip.extractAllTo(String(destDir), true);
        return { ok: true };
    } catch (e) {
        log('ERROR', `zip:extract ${zipPath}: ${e.message}`);
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('zip:list', async (_, zipPath) => {
    try {
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(String(zipPath));
        return { ok: true, entries: zip.getEntries().map(e => e.entryName) };
    } catch (e) {
        return { ok: false, entries: [], error: e.message };
    }
});

ipcMain.handle('zip:read-entry', async (_, zipPath, entryName) => {
    try {
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(String(zipPath));
        const entry = zip.getEntry(String(entryName));
        if (!entry) return null;
        return entry.getData().toString('utf8');
    } catch { return null; }
});

// ════════════════════════════════════════════════════════════════════════════════
// SHELL / PROCESS
// ════════════════════════════════════════════════════════════════════════════════

ipcMain.handle('shell:exec', async (_, cmd, opts = {}) => {
    return new Promise(resolve => {
        const { exec } = require('child_process');
        exec(String(cmd), { timeout: opts.timeout || 10000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
            resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', exitCode: err ? err.code : 0 });
        });
    });
});

ipcMain.handle('shell:which', async (_, binaryName) => {
    const { exec } = require('child_process');
    const cmd = process.platform === 'win32' ? `where ${binaryName}` : `which ${binaryName}`;
    return new Promise(resolve => {
        exec(cmd, { timeout: 5000 }, (err, stdout) => {
            resolve(err ? null : (stdout || '').trim().split('\n')[0].trim() || null);
        });
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// JAVA — поиск и проверка Java
// ════════════════════════════════════════════════════════════════════════════════

ipcMain.handle('java:find', async () => {
    // 1. JAVA_HOME
    const javaHome = process.env.JAVA_HOME;
    const javaExe = process.platform === 'win32' ? 'java.exe' : 'java';
    if (javaHome) {
        const javaPath = path.join(javaHome, 'bin', javaExe);
        if (fs.existsSync(javaPath)) return javaPath;
    }
    // 2. which/where
    const cmd = process.platform === 'win32' ? 'where java' : 'which java';
    return new Promise(resolve => {
        require('child_process').exec(cmd, { timeout: 5000 }, (err, stdout) => {
            resolve(err ? null : (stdout || '').trim().split('\n')[0].trim() || null);
        });
    });
});

ipcMain.handle('java:check-version', async (_, javaPath) => {
    return new Promise(resolve => {
        const proc = require('child_process').spawn(String(javaPath), ['-version'], {
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let out = '';
        proc.stdout.on('data', d => { out += d; });
        proc.stderr.on('data', d => { out += d; });
        proc.on('close', () => {
            const m = out.match(/version "(\d+)/);
            if (m) resolve(parseInt(m[1]));
            else resolve(null);
        });
        proc.on('error', () => resolve(null));
        setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } resolve(null); }, 8000);
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// JAVA ENSURE — проверка и автоустановка Java 21 (Windows)
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Проверяет версию java по заданному пути.
 * Возвращает номер major-версии или null при ошибке.
 */
async function _javaCheckVersion(javaPath) {
    return new Promise(resolve => {
        const proc = require('child_process').spawn(String(javaPath), ['-version'], {
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let out = '';
        proc.stdout.on('data', d => { out += d; });
        proc.stderr.on('data', d => { out += d; });
        proc.on('close', () => {
            const m = out.match(/version "(\d+)/);
            resolve(m ? parseInt(m[1]) : null);
        });
        proc.on('error', () => resolve(null));
        setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } resolve(null); }, 8000);
    });
}

/**
 * Скачивает и распаковывает Java 21 (только Windows x64).
 * Отправляет прогресс через event.sender.send('java:progress', {pct, msg}).
 */
async function _javaDownloadAndInstall(event, minecraftPath) {
    if (process.platform !== 'win32') throw new Error('Автоматическая загрузка Java поддерживается только для Windows');

    const send = (pct, msg) => {
        try { event.sender.send('java:progress', { pct, msg }); } catch { /* window closed */ }
    };

    send(5, 'Получение информации о Java 21...');
    const https = require('https');
    const AdmZip = require('adm-zip');

    const fetchJSON = (url) => new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'FixLauncher/1.0' } }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
        }).on('error', reject);
    });

    const assets = await fetchJSON('https://api.adoptium.net/v3/assets/latest/21/hotspot?os=windows&architecture=x64&image_type=jdk&vendor=eclipse');
    if (!assets?.length) throw new Error('Не удалось получить информацию о Java');
    const asset = assets.find(a => a.binary?.os === 'windows' && a.binary?.architecture === 'x64' && a.binary?.image_type === 'jdk');
    if (!asset?.binary?.package) throw new Error('Не найдена подходящая версия Java для Windows');

    const { link: downloadUrl, size } = asset.binary.package;
    const javaDir         = path.join(minecraftPath, 'java');
    const javaZipPath     = path.join(javaDir, 'java21.zip');
    const javaExtractPath = path.join(javaDir, 'extracted');
    fs.mkdirSync(javaDir, { recursive: true });

    send(10, `Загрузка Java 21 (${Math.floor(size / 1048576)}MB)...`);
    log('INFO', 'Downloading Java from:', downloadUrl);

    await new Promise((resolve, reject) => {
        const file = require('fs').createWriteStream(javaZipPath);
        let downloaded = 0;
        https.get(downloadUrl, res => {
            res.on('data', chunk => {
                downloaded += chunk.length;
                file.write(chunk);
                send(15 + Math.floor((downloaded / size) * 60),
                    `Загрузка Java: ${Math.floor(downloaded / 1048576)}MB / ${Math.floor(size / 1048576)}MB`);
            });
            res.on('end', () => { file.end(); resolve(); });
            res.on('error', reject);
        }).on('error', reject);
    });

    send(75, 'Распаковка Java 21...');
    const zip = new AdmZip(javaZipPath);
    zip.extractAllTo(javaExtractPath, true);

    const jdkDir = fs.readdirSync(javaExtractPath).find(d => d.startsWith('jdk'));
    if (!jdkDir) throw new Error('Не найдена папка JDK в архиве');

    const javaBinPath = path.join(javaExtractPath, jdkDir, 'bin', 'java.exe');
    if (!fs.existsSync(javaBinPath)) throw new Error('Не найден java.exe в распакованном архиве');

    try { fs.unlinkSync(javaZipPath); } catch (e) { log('WARN', 'Could not delete Java ZIP:', e); }

    send(95, 'Проверка установленной Java...');
    const version = await _javaCheckVersion(javaBinPath);
    if (!version || version < 21) throw new Error(`Установлена Java ${version}, требуется 21+`);

    log('INFO', 'Java 21 installed:', javaBinPath);
    send(100, 'Java 21 установлена!');
    return javaBinPath;
}

ipcMain.handle('java:ensure', async (event, { minecraftPath, currentJavaPath }) => {
    try {
        // 1. Проверяем указанный пользователем путь
        if (currentJavaPath && currentJavaPath !== 'java') {
            if (fs.existsSync(currentJavaPath)) {
                const version = await _javaCheckVersion(currentJavaPath);
                if (version && version >= 21) {
                    log('INFO', `Java OK (custom): ${version} at ${currentJavaPath}`);
                    return { ok: true, javaPath: currentJavaPath };
                }
                log('INFO', `Java too old (${version}) at ${currentJavaPath}, downloading 21...`);
            } else {
                log('INFO', 'Java not found at specified path, downloading...');
            }
            const javaPath = await _javaDownloadAndInstall(event, minecraftPath);
            return { ok: true, javaPath };
        }

        // 2. Системная Java
        const sysVersion = await _javaCheckVersion('java');
        if (sysVersion && sysVersion >= 21) {
            log('INFO', `System Java OK: ${sysVersion}`);
            return { ok: true, javaPath: 'java' };
        }
        log('INFO', sysVersion ? `System Java too old (${sysVersion}), downloading...` : 'System Java not found, downloading...');
        const javaPath = await _javaDownloadAndInstall(event, minecraftPath);
        return { ok: true, javaPath };
    } catch (e) {
        log('ERROR', 'java:ensure failed:', e.message);
        return { ok: false, error: e.message };
    }
});

// ════════════════════════════════════════════════════════════════════════════════
// INSTALLER — установка Minecraft, Fabric, библиотек, ассетов, нативов, сборок
// ════════════════════════════════════════════════════════════════════════════════

(function() {
    const AdmZip = require('adm-zip');
    const https  = require('https');
    const { spawn: _spawn, exec: _exec } = require('child_process');

    // ── helpers ───────────────────────────────────────────────────────────────

    function send(event, pct, msg) {
        try { event.sender.send('installer:progress', { pct, msg }); } catch { /* window closed */ }
    }

    function fetchJSON(url) {
        return new Promise((resolve, reject) => {
            https.get(url, { headers: { 'User-Agent': 'FixLauncher/1.0' } }, res => {
                // follow one redirect
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    return fetchJSON(res.headers.location).then(resolve).catch(reject);
                }
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
                res.on('error', reject);
            }).on('error', reject);
        });
    }

    function downloadFile(url, dest, onProgress) {
        return new Promise((resolve, reject) => {
            const doGet = (u) => {
                https.get(u, { headers: { 'User-Agent': 'FixLauncher/1.0' } }, res => {
                    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
                        return doGet(res.headers.location);
                    if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${u}`));
                    const total = parseInt(res.headers['content-length'] || '0');
                    let downloaded = 0;
                    fs.mkdirSync(path.dirname(dest), { recursive: true });
                    const file = fs.createWriteStream(dest);
                    res.on('data', chunk => { downloaded += chunk.length; file.write(chunk); onProgress && onProgress(downloaded, total); });
                    res.on('end', () => { file.end(); resolve(); });
                    res.on('error', reject);
                }).on('error', reject);
            };
            doGet(url);
        });
    }

    /**
     * Проверяет, совместима ли DLL с текущей архитектурой процесса по PE-заголовку.
     * 0x014c = IMAGE_FILE_MACHINE_I386 (32-бит), 0x8664 = IMAGE_FILE_MACHINE_AMD64 (64-бит).
     * Возвращает true если DLL подходит, false если нет или файл повреждён.
     */
    function isDllCompatible(dllPath) {
        try {
            const fd = fs.openSync(dllPath, 'r');
            const mzBuf = Buffer.alloc(4);
            fs.readSync(fd, mzBuf, 0, 4, 0);
            // Проверяем сигнатуру MZ
            if (mzBuf[0] !== 0x4D || mzBuf[1] !== 0x5A) { fs.closeSync(fd); return false; }
            // Смещение PE-заголовка находится по адресу 0x3C
            const peBuf = Buffer.alloc(4);
            fs.readSync(fd, peBuf, 0, 4, 0x3C);
            const peOffset = peBuf.readUInt32LE(0);
            // Machine type — 2 байта после сигнатуры PE (peOffset + 4)
            const machineBuf = Buffer.alloc(2);
            fs.readSync(fd, machineBuf, 0, 2, peOffset + 4);
            fs.closeSync(fd);
            const machine = machineBuf.readUInt16LE(0);
            // 0x8664 = AMD64, 0xAA64 = ARM64
            const is64bit = (machine === 0x8664 || machine === 0xAA64);
            // process.arch 'x64' → нужна 64-бит DLL, 'ia32' → 32-бит
            return process.arch === 'x64' ? is64bit : !is64bit;
        } catch { return false; }
    }

    function getNativeClassifier() {
        const p = process.platform, a = process.arch;
        return p === 'win32'  ? (a === 'x64' ? 'natives-windows' : 'natives-windows-x86')
             : p === 'darwin' ? (a === 'arm64' ? 'natives-macos-arm64' : 'natives-macos')
             : 'natives-linux';
    }

    const SETTINGS_FILES = new Set(['options.txt','optionsof.txt','optionsshaders.txt',
        'servers.dat','servers.dat_old','usercache.json',
        'banned-ips.json','banned-players.json','ops.json','whitelist.json']);

    function isConfigFile(filePath, basePath) {
        try {
            const rel = path.relative(basePath, filePath).replace(/\\/g, '/');
            const parts = rel.split('/').filter(Boolean);
            if (parts.includes('config')) return true;
            if (parts.length === 1 && SETTINGS_FILES.has(parts[0].toLowerCase())) return true;
        } catch { if (filePath.replace(/\\/g,'/').includes('/config/')) return true; }
        return false;
    }

    function copyDirRecursive(src, dest) {
        fs.mkdirSync(dest, { recursive: true });
        for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
            const s = path.join(src, entry.name), d = path.join(dest, entry.name);
            if (entry.isDirectory()) copyDirRecursive(s, d);
            else if (!(isConfigFile(d, dest) && fs.existsSync(d))) fs.copyFileSync(s, d);
        }
    }

    function parseGitHubUrl(url) {
        const m = url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
        if (!m) throw new Error(`Invalid GitHub URL: ${url}`);
        return m;
    }

    // ── vanilla ───────────────────────────────────────────────────────────────

    async function installVanillaVersion(event, minecraftPath, version) {
        send(event, 20, 'Загрузка манифеста версий...');
        const manifest = await fetchJSON('https://launchermeta.mojang.com/mc/game/version_manifest.json');

        // Ищем версию — если точного совпадения нет, пробуем убрать последний патч
        // Например 1.21.11 → 1.21.1, 1.20.10 → 1.20.1
        let versionInfo = manifest.versions.find(v => v.id === version);
        let resolvedVersion = version;
        if (!versionInfo) {
            // Пробуем сократить: 1.21.11 → 1.21.1, 1.21.10 → 1.21.1
            const shortened = version.replace(/^(\d+\.\d+)\.(\d{2,})$/, (_, base, patch) => `${base}.${patch[0]}`);
            if (shortened !== version) {
                versionInfo = manifest.versions.find(v => v.id === shortened);
                if (versionInfo) {
                    resolvedVersion = shortened;
                    log('WARN', `Version ${version} not found, using ${shortened} instead`);
                }
            }
        }
        if (!versionInfo) throw new Error(`Version ${version} not found in manifest`);
        version = resolvedVersion;

        send(event, 25, 'Загрузка информации о версии...');
        const versionData = await fetchJSON(versionInfo.url);

        const versionsPath = path.join(minecraftPath, 'versions', version);
        fs.mkdirSync(versionsPath, { recursive: true });
        fs.writeFileSync(path.join(versionsPath, version + '.json'), JSON.stringify(versionData, null, 2));

        send(event, 30, 'Загрузка клиентского jar...');
        await downloadFile(versionData.downloads.client.url, path.join(versionsPath, version + '.jar'),
            (dl, total) => send(event, 30 + Math.floor((dl / total) * 20), `Клиент: ${Math.floor(dl/1048576)}MB / ${Math.floor(total/1048576)}MB`));

        send(event, 50, 'Загрузка библиотек...');
        await downloadLibraries(event, minecraftPath, version, versionData);

        send(event, 60, 'Загрузка ресурсов...');
        await downloadAssets(event, minecraftPath, versionData);

        send(event, 70, 'Извлечение нативных библиотек...');
        await extractNatives(event, minecraftPath, version, versionData);

        send(event, 100, 'Версия установлена!');
        return versionData;
    }

    /**
     * Проверяет rules библиотеки — нужно ли её скачивать на текущей платформе.
     * Возвращает true если библиотека должна быть включена.
     */
    function libraryMatchesRules(lib) {
        if (!lib.rules || lib.rules.length === 0) return true;
        const osName = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
        let allow = false;
        for (const rule of lib.rules) {
            const osMatch = !rule.os || rule.os.name === osName;
            if (rule.action === 'allow'    &&  osMatch) allow = true;
            if (rule.action === 'disallow' &&  osMatch) allow = false;
        }
        return allow;
    }

    /**
     * Строит Maven URL из lib.name (group:artifact:version[:classifier]).
     * Используется для старых версий (до 1.19), где downloads.artifact может отсутствовать.
     */
    function mavenUrlFromName(libName) {
        const parts = libName.split(':');
        if (parts.length < 3) return null;
        const [group, artifact, version, classifier] = parts;
        const groupPath = group.replace(/\./g, '/');
        const fileName  = classifier
            ? `${artifact}-${version}-${classifier}.jar`
            : `${artifact}-${version}.jar`;
        const libPath   = `${groupPath}/${artifact}/${version}/${fileName}`;
        return {
            url:  `https://libraries.minecraft.net/${libPath}`,
            path: libPath,
        };
    }

    async function downloadLibraries(event, minecraftPath, version, versionData) {
        const libraries     = versionData.libraries || [];
        const librariesPath = path.join(minecraftPath, 'libraries');
        const nativeCls     = getNativeClassifier();
        fs.mkdirSync(librariesPath, { recursive: true });
        for (let i = 0; i < libraries.length; i++) {
            const lib = libraries[i];

            // Пропускаем библиотеки, не предназначенные для текущей платформы
            if (!libraryMatchesRules(lib)) continue;

            const tasks = [];
            if (lib.downloads?.artifact?.url && lib.downloads?.artifact?.path) {
                const dest = path.join(librariesPath, lib.downloads.artifact.path);
                if (!fs.existsSync(dest)) {
                    fs.mkdirSync(path.dirname(dest), { recursive: true });
                    tasks.push(downloadFile(lib.downloads.artifact.url, dest).catch(e => log('WARN', 'Lib:', lib.downloads.artifact.path, e.message)));
                }
            } else if (lib.name && !lib.downloads?.artifact) {
                // Старый формат (до 1.19): нет downloads.artifact — строим Maven URL из имени
                const maven = mavenUrlFromName(lib.name);
                if (maven) {
                    const dest = path.join(librariesPath, maven.path);
                    if (!fs.existsSync(dest)) {
                        fs.mkdirSync(path.dirname(dest), { recursive: true });
                        tasks.push(downloadFile(maven.url, dest).catch(e => log('WARN', 'LibMaven:', maven.path, e.message)));
                    }
                }
            }

            const nativeInfo = lib.downloads?.classifiers?.[nativeCls];
            if (nativeInfo?.url && nativeInfo?.path) {
                const dest = path.join(librariesPath, nativeInfo.path);
                if (!fs.existsSync(dest)) {
                    fs.mkdirSync(path.dirname(dest), { recursive: true });
                    tasks.push(downloadFile(nativeInfo.url, dest).catch(e => log('WARN', 'NativeLib:', nativeInfo.path, e.message)));
                }
            } else if (lib.natives?.[process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'] && lib.name) {
                // Старый формат нативок: lib.natives.windows = "natives-windows-${arch}"
                const osKey = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
                const classifier = lib.natives[osKey].replace('${arch}', process.arch === 'x64' ? '64' : '32');
                const maven = mavenUrlFromName(lib.name + ':' + classifier);
                if (maven) {
                    const dest = path.join(librariesPath, maven.path);
                    if (!fs.existsSync(dest)) {
                        fs.mkdirSync(path.dirname(dest), { recursive: true });
                        tasks.push(downloadFile(maven.url, dest).catch(e => log('WARN', 'NativeMaven:', maven.path, e.message)));
                    }
                }
            }

            await Promise.all(tasks);
            if (i % 10 === 0) send(event, 50 + Math.floor((i / libraries.length) * 20), `Библиотеки: ${i+1}/${libraries.length}`);
        }
    }

    async function downloadAssets(event, minecraftPath, versionData) {
        if (!versionData?.assetIndex) return;
        const assetIndex = versionData.assetIndex.id || versionData.assetIndex;
        const assetIndexUrl = versionData.assetIndex.url ||
            `https://piston-meta.mojang.com/v1/packages/${versionData.assetIndex.sha1}/${assetIndex}.json`;
        const assetsPath  = path.join(minecraftPath, 'assets');
        const indexesPath = path.join(assetsPath, 'indexes');
        const objectsPath = path.join(assetsPath, 'objects');
        fs.mkdirSync(indexesPath, { recursive: true });
        fs.mkdirSync(objectsPath, { recursive: true });
        const assetIndexPath = path.join(indexesPath, assetIndex + '.json');

        let objects;
        if (fs.existsSync(assetIndexPath)) {
            try { objects = JSON.parse(fs.readFileSync(assetIndexPath, 'utf8')).objects || {}; } catch { objects = {}; }
        }
        if (!objects) {
            const data = await fetchJSON(assetIndexUrl).catch(() => null);
            if (!data) return;
            fs.writeFileSync(assetIndexPath, JSON.stringify(data, null, 2));
            objects = data.objects || {};
        }
        const keys = Object.keys(objects);
        let downloaded = 0;
        for (let i = 0; i < keys.length; i++) {
            const { hash } = objects[keys[i]];
            const prefix = hash.substring(0, 2);
            const dest   = path.join(objectsPath, prefix, hash);
            if (!fs.existsSync(dest)) {
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                await downloadFile(`https://resources.download.minecraft.net/${prefix}/${hash}`, dest).catch(() => {});
                if (i % 50 === 0) await new Promise(r => setTimeout(r, 5));
            }
            downloaded++;
            if (downloaded % 100 === 0 || i === keys.length - 1)
                send(event, 62 + Math.floor((downloaded / keys.length) * 7), `Ресурсы: ${downloaded}/${keys.length}`);
        }
        send(event, 69, 'Ресурсы загружены!');
    }

    async function extractNatives(event, minecraftPath, version, versionData) {
        const libraries     = versionData.libraries || [];
        const librariesPath = path.join(minecraftPath, 'libraries');
        const nativesPath   = path.join(minecraftPath, 'natives');
        const nativeCls     = getNativeClassifier();
        try { fs.rmSync(nativesPath, { recursive: true, force: true }); } catch { /* ignore */ }
        fs.mkdirSync(nativesPath, { recursive: true });

        log('INFO', `extractNatives: version=${version}, nativeCls=${nativeCls}, libraries=${libraries.length}`);

        // ── Формат до 1.19: нативки в downloads.classifiers ──────────────────
        const legacyNativeLibs = [];
        const seen = new Set();
        const osKey = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
        // Only use classifiers matching the current architecture — never fall back to x86 on x64
        const clfCandidates = process.arch === 'x64'
            ? [nativeCls, 'natives-windows']
            : [nativeCls, 'natives-windows-x86'];
        for (const lib of libraries) {
            // Пропускаем библиотеки, не предназначенные для текущей платформы
            if (!libraryMatchesRules(lib)) continue;

            // Формат с downloads.classifiers (1.12 – 1.18)
            let found = false;
            for (const clf of clfCandidates) {
                const info = lib.downloads?.classifiers?.[clf];
                if (info?.path && !seen.has(info.path)) { seen.add(info.path); legacyNativeLibs.push(info); found = true; break; }
            }

            // Очень старый формат (до 1.12): lib.natives.windows = "natives-windows-${arch}"
            // downloads.classifiers может отсутствовать — строим Maven URL вручную
            if (!found && lib.natives?.[osKey] && lib.name) {
                const archStr = process.arch === 'x64' ? '64' : '32';
                const classifier = lib.natives[osKey].replace('${arch}', archStr);
                const maven = mavenUrlFromName(lib.name + ':' + classifier);
                if (maven && !seen.has(maven.path)) {
                    seen.add(maven.path);
                    legacyNativeLibs.push(maven);
                }
            }
        }
        log('INFO', `extractNatives: legacy (classifiers) native libs found: ${legacyNativeLibs.length}`);

        // ── Формат 1.19+: нативки — обычные artifact с правилом extract ───────
        // Признаки: lib.natives существует ИЛИ lib.name содержит 'natives-windows'
        // ИЛИ lib.downloads.artifact.path содержит 'natives-windows'
        const modernNativeLibs = [];
        const osName = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
        // Exact classifier expected for this platform+arch (no substring matching)
        const exactNativeSuffix = process.platform === 'win32'
            ? (process.arch === 'x64' ? 'natives-windows' : 'natives-windows-x86')
            : (process.platform === 'darwin'
                ? (process.arch === 'arm64' ? 'natives-macos-arm64' : 'natives-macos')
                : 'natives-linux');
        for (const lib of libraries) {
            if (!lib.downloads?.artifact?.path) continue;
            const artifactPath = lib.downloads.artifact.path;
            // Match exact native suffix — avoid matching natives-windows-x86 when we want natives-windows
            const pathParts = artifactPath.replace(/\\/g, '/').split('/');
            const isNativeForUs = pathParts.some(p => p === exactNativeSuffix || p.startsWith(exactNativeSuffix + '-') || p.startsWith(exactNativeSuffix + '.'))
                || (lib.natives && lib.natives[osName])
                || (lib.name && (() => {
                    // lib.name format: group:artifact:version[:classifier]
                    const nameParts = lib.name.split(':');
                    const classifier = nameParts[3] || '';
                    return classifier === exactNativeSuffix || nameParts[1] === exactNativeSuffix;
                })());
            if (!isNativeForUs) continue;
            // Проверяем правила (rules) — нужно ли включать для текущей ОС
            let include = true;
            if (lib.rules && lib.rules.length > 0) {
                include = false;
                for (const rule of lib.rules) {
                    if (rule.action === 'allow' && (!rule.os || rule.os.name === osName)) { include = true; break; }
                    if (rule.action === 'disallow' && rule.os && rule.os.name === osName) { include = false; break; }
                }
            }
            if (include && !seen.has(artifactPath)) {
                seen.add(artifactPath);
                modernNativeLibs.push(lib.downloads.artifact);
            }
        }
        log('INFO', `extractNatives: modern (artifact) native libs found: ${modernNativeLibs.length}`);

        const allNativeLibs = [...legacyNativeLibs, ...modernNativeLibs];
        log('INFO', `extractNatives: total native libs to extract: ${allNativeLibs.length}`);

        if (allNativeLibs.length === 0) {
            log('WARN', 'extractNatives: NO native libs found in version.json! Check if correct version data was passed.');
            log('WARN', 'extractNatives: First 3 library names:', libraries.slice(0, 3).map(l => l.name).join(', '));
        }

        for (let i = 0; i < allNativeLibs.length; i++) {
            const lib = allNativeLibs[i];
            const jarPath = path.join(librariesPath, lib.path);
            log('INFO', `extractNatives: [${i+1}/${allNativeLibs.length}] ${lib.path}, exists=${fs.existsSync(jarPath)}`);
            if (!fs.existsSync(jarPath) && lib.url) {
                send(event, 70 + Math.floor((i / allNativeLibs.length) * 10), `Загрузка нативных: ${i+1}/${allNativeLibs.length}`);
                fs.mkdirSync(path.dirname(jarPath), { recursive: true });
                await downloadFile(lib.url, jarPath).catch(e => log('WARN', 'NativeDl:', e.message));
            }
            if (fs.existsSync(jarPath)) {
                try {
                    const zip = new AdmZip(jarPath);
                    let extracted = 0;
                    for (const entry of zip.getEntries()) {
                        if (!entry.entryName.match(/\.(dll|so|dylib)$/i)) continue;
                        // Пропускаем файлы в подпапках META-INF
                        if (entry.entryName.startsWith('META-INF/')) continue;
                        try {
                            const data = zip.readFile(entry);
                            if (data) {
                                // ── Защита от 32-битных DLL на 64-битной системе ──────────────
                                if (process.platform === 'win32' && entry.entryName.match(/\.dll$/i)) {
                                    // Читаем PE-заголовок из буфера
                                    let archOk = true;
                                    if (data.length > 0x40) {
                                        try {
                                            if (data[0] === 0x4D && data[1] === 0x5A) { // MZ
                                                const peOffset = data.readUInt32LE(0x3C);
                                                if (peOffset + 6 < data.length) {
                                                    const machine = data.readUInt16LE(peOffset + 4);
                                                    const is64bit = (machine === 0x8664 || machine === 0xAA64);
                                                    archOk = process.arch === 'x64' ? is64bit : !is64bit;
                                                    if (!archOk) {
                                                        log('WARN', `extractNatives: SKIP 32-bit DLL on 64-bit system: ${entry.entryName} (machine=0x${machine.toString(16)})`);
                                                    }
                                                }
                                            }
                                        } catch (peErr) { /* if PE read fails, allow the file */ }
                                    }
                                    if (!archOk) continue;
                                }
                                fs.writeFileSync(path.join(nativesPath, path.basename(entry.entryName)), data);
                                extracted++;
                            }
                        } catch (e) { log('WARN', 'Extract:', entry.entryName, e.message); }
                    }
                    log('INFO', `extractNatives: extracted ${extracted} files from ${path.basename(jarPath)}`);
                } catch (e) {
                    log('WARN', `extractNatives: failed to open zip ${jarPath}:`, e.message);
                }
            } else {
                log('WARN', `extractNatives: jar not found and could not download: ${jarPath}`);
            }
            send(event, 70 + Math.floor(((i+1) / allNativeLibs.length) * 10), `Нативные: ${i+1}/${allNativeLibs.length}`);
        }

        // Итоговый список файлов в natives
        try {
            const extracted = fs.readdirSync(nativesPath);
            log('INFO', `extractNatives: done. Files in natives (${extracted.length}): ${extracted.join(', ')}`);
        } catch { /* ignore */ }
    }

    // ── fabric ────────────────────────────────────────────────────────────────

    async function installFabricVersion(event, minecraftPath, version) {
        const mcVersion = version.replace(/-(fabric|forge|neoforge|quilt).*$/i, '') || '1.21.4';

        send(event, 20, 'Установка базовой версии Minecraft...');
        // Если vanilla уже скачана — не переустанавливаем
        const vanillaJar = path.join(minecraftPath, 'versions', mcVersion, mcVersion + '.jar');
        let versionData;
        if (fs.existsSync(vanillaJar)) {
            try {
                versionData = JSON.parse(fs.readFileSync(
                    path.join(minecraftPath, 'versions', mcVersion, mcVersion + '.json'), 'utf8'
                ));
                send(event, 35, 'Базовая версия уже установлена...');
            } catch { versionData = null; }
        }
        if (!versionData) {
            versionData = await installVanillaVersion(event, minecraftPath, mcVersion);
        }

        send(event, 38, 'Получение версии Fabric Loader...');
        let fabricLoaderVersion = '0.16.0';
        try {
            const versions = await fetchJSON(`https://meta.fabricmc.net/v2/versions/loader/${mcVersion}`);
            fabricLoaderVersion = versions?.[0]?.loader?.version ?? fabricLoaderVersion;
        } catch (e) { log('WARN', 'Fabric version fetch failed:', e.message); }

        send(event, 40, 'Загрузка Fabric Installer...');
        const tempInstallerPath = path.join(minecraftPath, 'fabric-installer.jar');
        await downloadFile('https://maven.fabricmc.net/net/fabricmc/fabric-installer/1.0.0/fabric-installer-1.0.0.jar', tempInstallerPath);

        const lpPath = path.join(minecraftPath, 'launcher_profiles.json');
        if (!fs.existsSync(lpPath)) {
            fs.writeFileSync(lpPath, JSON.stringify({
                profiles: {}, selectedProfile: null, clientToken: '',
                authenticationDatabase: {}, selectedUser: null,
                launcherVersion: { name: 'fixlauncher', format: 21 }
            }, null, 2));
        }

        const javaPath = 'java'; // always use system java for Fabric installer
        send(event, 45, 'Установка Fabric...');
        const installerArgs = ['-jar', tempInstallerPath, 'client', '-mcversion', mcVersion, '-loader', fabricLoaderVersion, '-dir', minecraftPath];

        const { code, stderr } = await new Promise(resolve => {
            const proc = _spawn(javaPath, installerArgs, { cwd: minecraftPath, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
            let err = '';
            proc.stderr.on('data', d => err += d);
            proc.on('error', e => resolve({ code: -1, stderr: e.message }));
            proc.on('close', c => resolve({ code: c, stderr: err }));
        });

        try { fs.unlinkSync(tempInstallerPath); } catch { /* ignore */ }

        if (!fs.existsSync(path.join(minecraftPath, 'versions', version))) {
            if (code === 0) {
                // Create version folder manually
                const fabricVersionPath = path.join(minecraftPath, 'versions', version);
                fs.mkdirSync(fabricVersionPath, { recursive: true });
                const baseJson = JSON.parse(JSON.stringify(versionData));
                baseJson.id = version;
                baseJson.mainClass = 'net.fabricmc.loader.impl.launch.knot.KnotClient';
                baseJson.libraries = baseJson.libraries || [];
                baseJson.libraries.push({ name: `net.fabricmc:fabric-loader:${fabricLoaderVersion}`,
                    downloads: { artifact: { path: `net/fabricmc/fabric-loader/${fabricLoaderVersion}/fabric-loader-${fabricLoaderVersion}.jar`,
                        url: `https://maven.fabricmc.net/net/fabricmc/fabric-loader/${fabricLoaderVersion}/fabric-loader-${fabricLoaderVersion}.jar`, sha1: '', size: 0 }}});
                fs.writeFileSync(path.join(fabricVersionPath, version + '.json'), JSON.stringify(baseJson, null, 2));
                const baseJar = path.join(minecraftPath, 'versions', mcVersion, mcVersion + '.jar');
                if (fs.existsSync(baseJar)) fs.copyFileSync(baseJar, path.join(fabricVersionPath, version + '.jar'));

                const libsPath = path.join(minecraftPath, 'libraries', 'net', 'fabricmc', 'fabric-loader', fabricLoaderVersion);
                fs.mkdirSync(libsPath, { recursive: true });
                await downloadFile(`https://maven.fabricmc.net/net/fabricmc/fabric-loader/${fabricLoaderVersion}/fabric-loader-${fabricLoaderVersion}.jar`,
                    path.join(libsPath, `fabric-loader-${fabricLoaderVersion}.jar`));
            } else {
                throw new Error(`Fabric installer failed (code ${code}).\n${stderr}`);
            }
        }
        send(event, 50, 'Fabric установлен!');
    }

    // ── github assembly ───────────────────────────────────────────────────────

    async function getGitHubFileList(githubRepo) {
        const [, owner, repo] = parseGitHubUrl(githubRepo);
        for (const branch of ['main', 'master']) {
            try {
                const data = await fetchJSON(`https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`);
                if (data?.tree?.length) return data.tree.filter(i => i.type === 'blob').map(i => ({ path: i.path, sha: i.sha, size: i.size || 0 }));
            } catch (e) {
                if (e.message?.includes('403')) { log('WARN', 'GitHub API rate-limited'); return []; }
            }
        }
        return [];
    }

    async function downloadAssembly(event, githubRepo, targetPath) {
        const [, owner, repo] = parseGitHubUrl(githubRepo);
        fs.mkdirSync(targetPath, { recursive: true });

        // Try git clone first
        const gitOk = await new Promise(r => _exec('git --version', e => r(!e)));
        if (gitOk) {
            const tempDir = path.join(require('os').tmpdir(), 'fixlauncher-' + Date.now());
            const cloneOk = await new Promise(r => _exec(`git clone --depth 1 ${githubRepo} "${tempDir}"`, { timeout: 60000 }, e => r(!e)));
            if (cloneOk && fs.existsSync(tempDir)) {
                copyDirRecursive(tempDir, targetPath);
                try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
                send(event, 30, 'Сборка загружена (git clone)');
                return;
            }
        }

        // Fallback: GitHub API tree
        send(event, 28, 'Загрузка файлов с GitHub...');
        const fileList = await getGitHubFileList(githubRepo);
        if (fileList.length) {
            let done = 0;
            for (const file of fileList) {
                const dest = path.join(targetPath, file.path);
                if (isConfigFile(dest, targetPath) && fs.existsSync(dest)) { done++; continue; }
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                for (const branch of ['main', 'master']) {
                    try { await downloadFile(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${file.path}`, dest); break; } catch { /* next */ }
                }
                done++;
                if (done % 10 === 0) send(event, 28 + Math.floor((done / fileList.length) * 2), `Загружено ${done}/${fileList.length}...`);
            }
        }
        send(event, 30, 'Сборка загружена с GitHub');
    }

    async function checkAssemblyIntegrity(githubRepo, assemblyPath) {
        const modsPath = path.join(assemblyPath, 'mods');
        const hasMods  = fs.existsSync(modsPath) && fs.readdirSync(modsPath).filter(f => f.endsWith('.jar')).length > 0;
        if (!fs.existsSync(assemblyPath) || !hasMods) return { needsDownload: true };
        try {
            const files = await getGitHubFileList(githubRepo);
            if (!files.length) return { needsDownload: false, needsRepair: false, isEmpty: true };
            const missing = [], corrupted = [];
            for (const file of files) {
                const local = path.join(assemblyPath, file.path);
                if (!fs.existsSync(local)) { missing.push(file); continue; }
                if (file.size > 0) try { if (Math.abs(fs.statSync(local).size - file.size) > 100) corrupted.push(file); } catch { corrupted.push(file); }
            }
            return { needsDownload: false, needsRepair: missing.length > 0 || corrupted.length > 0, missing, corrupted };
        } catch (e) {
            return hasMods ? { needsDownload: false, needsRepair: false } : { needsDownload: true };
        }
    }

    async function repairAssembly(event, githubRepo, assemblyPath, files) {
        const [, owner, repo] = parseGitHubUrl(githubRepo);
        let done = 0;
        for (const file of files) {
            const local = path.join(assemblyPath, file.path);
            if (isConfigFile(local, assemblyPath) && fs.existsSync(local)) { done++; continue; }
            fs.mkdirSync(path.dirname(local), { recursive: true });
            try { if (fs.existsSync(local)) fs.unlinkSync(local); } catch { /* ignore */ }
            for (const branch of ['main', 'master']) {
                try { await downloadFile(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${file.path}`, local); break; } catch { /* next */ }
            }
            done++;
            send(event, 27 + Math.floor((done / files.length) * 3), `Восстановлено ${done}/${files.length}...`);
        }
    }

    // ── IPC handlers ──────────────────────────────────────────────────────────

    ipcMain.handle('installer:check-and-download', async (event, { minecraftPath, version, withMods }) => {
        try {
            const versionJsonPath = path.join(minecraftPath, 'versions', version, version + '.json');
            const clientJarPath   = path.join(minecraftPath, 'versions', version, version + '.jar');

            if (fs.existsSync(clientJarPath) && fs.existsSync(versionJsonPath)) {
                log('INFO', 'Version already installed:', version);
                send(event, 30, 'Версия уже установлена, проверка ресурсов...');
                try {
                    const versionData = JSON.parse(fs.readFileSync(versionJsonPath, 'utf8'));
                    const assetIndex  = versionData.assetIndex?.id || versionData.assetIndex;
                    const assetsIdxPath = path.join(minecraftPath, 'assets', 'indexes', (assetIndex || '1.21') + '.json');
                    if (!fs.existsSync(assetsIdxPath) && versionData.assetIndex) {
                        send(event, 40, 'Загрузка ресурсов...');
                        await downloadAssets(event, minecraftPath, versionData);
                    }
                    const lwjglDll = path.join(minecraftPath, 'natives', 'lwjgl.dll');
                    const nativesOk = fs.existsSync(lwjglDll) && isDllCompatible(lwjglDll);
                    if (!nativesOk) {
                        // Если DLL несовместима (например 32-бит на 64-бит системе) — удаляем и переустанавливаем
                        if (fs.existsSync(lwjglDll)) {
                            log('WARN', 'check-and-download: lwjgl.dll incompatible architecture, forcing re-extraction');
                            try { fs.rmSync(path.join(minecraftPath, 'natives'), { recursive: true, force: true }); } catch { /* ignore */ }
                        }
                        send(event, 50, 'Извлечение нативных библиотек...');
                        // Для Fabric/модовых версий нативки берём из vanilla version.json
                        let nativeSourceData = versionData;
                        const hasNativeCls = (versionData.libraries || []).some(
                            lib => lib.downloads?.classifiers && Object.keys(lib.downloads.classifiers).some(k => k.startsWith('natives-'))
                        );
                        if (!hasNativeCls) {
                            const mcVer = version.replace(/-(fabric|forge|neoforge|quilt|loader).*$/i, '');
                            if (mcVer && mcVer !== version) {
                                const vanillaJson = path.join(minecraftPath, 'versions', mcVer, mcVer + '.json');
                                if (fs.existsSync(vanillaJson)) {
                                    try { nativeSourceData = JSON.parse(fs.readFileSync(vanillaJson, 'utf8')); } catch { /* ignore */ }
                                }
                            }
                        }
                        await extractNatives(event, minecraftPath, version, nativeSourceData);
                    }
                } catch (e) { log('WARN', 'check-version.json:', e.message); }
                return { ok: true };
            }

            send(event, 15, 'Получение информации о версии...');
            if (withMods) await installFabricVersion(event, minecraftPath, version);
            else          await installVanillaVersion(event, minecraftPath, version);
            return { ok: true };
        } catch (e) {
            log('ERROR', 'installer:check-and-download:', e.message);
            return { ok: false, error: e.message };
        }
    });

    ipcMain.handle('installer:install-modpack', async (event, { minecraftPath, versionType }) => {
        try {
            const githubRepo = null;
            if (!githubRepo) throw new Error('Неизвестный тип сборки');

            send(event, 25, 'Проверка целостности сборки...');
            const integrity = await checkAssemblyIntegrity(githubRepo, minecraftPath);

            if (integrity.needsDownload) {
                send(event, 27, 'Загрузка сборки с GitHub...');
                await downloadAssembly(event, githubRepo, minecraftPath);
            } else if (integrity.needsRepair) {
                const all = [...(integrity.missing || []), ...(integrity.corrupted || [])];
                await repairAssembly(event, githubRepo, minecraftPath, all);
            }

            for (const dir of [minecraftPath, path.join(minecraftPath, 'mods'), path.join(minecraftPath, 'config')])
                fs.mkdirSync(dir, { recursive: true });

            send(event, 70, 'Сборка готова!');
            return { ok: true };
        } catch (e) {
            log('ERROR', 'installer:install-modpack:', e.message);
            return { ok: false, error: e.message };
        }
    });

    ipcMain.handle('installer:extract-natives', async (event, { minecraftPath, version }) => {
        try {
            const versionJsonPath = path.join(minecraftPath, 'versions', version, version + '.json');
            if (!fs.existsSync(versionJsonPath)) return { ok: false, error: 'version.json not found' };
            let versionData = JSON.parse(fs.readFileSync(versionJsonPath, 'utf8'));

            // Для Fabric/модовых версий нативные либы хранятся в vanilla version.json.
            // Проверяем: если в текущем versionData нет ни одной библиотеки с classifiers — 
            // пробуем загрузить vanilla version.json (mcVersion = version без суффикса типа -fabric).
            const hasNativeClassifiers = (versionData.libraries || []).some(
                lib => lib.downloads?.classifiers && Object.keys(lib.downloads.classifiers).some(k => k.startsWith('natives-'))
            );
            if (!hasNativeClassifiers) {
                // Определяем базовую MC-версию (убираем -fabric, -forge, -neoforge, -quilt и т.д.)
                const mcVersion = version.replace(/-(fabric|forge|neoforge|quilt|loader).*$/i, '');
                if (mcVersion && mcVersion !== version) {
                    const vanillaJsonPath = path.join(minecraftPath, 'versions', mcVersion, mcVersion + '.json');
                    if (fs.existsSync(vanillaJsonPath)) {
                        try {
                            const vanillaData = JSON.parse(fs.readFileSync(vanillaJsonPath, 'utf8'));
                            log('INFO', `extract-natives: using vanilla version.json (${mcVersion}) for native libs`);
                            // Берём данные для нативок из vanilla, остальное — из текущей версии
                            versionData = vanillaData;
                        } catch (e) {
                            log('WARN', 'extract-natives: could not read vanilla version.json:', e.message);
                        }
                    } else {
                        log('WARN', `extract-natives: vanilla version.json not found at ${vanillaJsonPath}, trying manifest...`);
                        // Пробуем скачать vanilla version.json из манифеста Mojang
                        try {
                            const manifest = await fetchJSON('https://launchermeta.mojang.com/mc/game/version_manifest.json');
                            const vInfo = manifest.versions.find(v => v.id === mcVersion);
                            if (vInfo) {
                                const vanillaData = await fetchJSON(vInfo.url);
                                const vanillaVersionsPath = path.join(minecraftPath, 'versions', mcVersion);
                                fs.mkdirSync(vanillaVersionsPath, { recursive: true });
                                fs.writeFileSync(vanillaJsonPath, JSON.stringify(vanillaData, null, 2));
                                log('INFO', `extract-natives: downloaded vanilla version.json for ${mcVersion}`);
                                versionData = vanillaData;
                            }
                        } catch (e) {
                            log('WARN', 'extract-natives: could not fetch vanilla version.json from Mojang:', e.message);
                        }
                    }
                }
            }

            await extractNatives(event, minecraftPath, version, versionData);
            return { ok: true };
        } catch (e) {
            log('ERROR', 'installer:extract-natives:', e.message);
            return { ok: false, error: e.message };
        }
    });
})();

// ════════════════════════════════════════════════════════════════════════════════
// MC SPAWN — запуск Minecraft из main-процесса
// ════════════════════════════════════════════════════════════════════════════════

ipcMain.handle('mc:spawn', async (event, { javaPath, args, cwd }) => {
    try {
        log('INFO', `mc:spawn — java: ${javaPath}, args count: ${args.length}, cwd: ${cwd}`);

        // Проверяем java
        if (javaPath !== 'java' && !fs.existsSync(String(javaPath))) {
            return { ok: false, error: `Java не найдена: ${javaPath}` };
        }

        const { spawn } = require('child_process');
        const mcProcess = spawn(String(javaPath), args.map(String), {
            cwd: String(cwd),
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env }
        });

        const pid = mcProcess.pid;
        log('INFO', `Minecraft spawned with PID: ${pid}`);

        let errorOutput = '';
        let fullOutput = '';
        mcProcess.stdout.on('data', d => {
            const out = d.toString();
            fullOutput += out;
            if (out.toLowerCase().includes('error') || out.toLowerCase().includes('exception')) errorOutput += out;
        });
        mcProcess.stderr.on('data', d => {
            const err = d.toString();
            fullOutput += err;
            errorOutput += err;
        });

        mcProcess.on('error', err => {
            log('ERROR', `Minecraft spawn error: ${err.message}`);
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('mc-process-error', { message: err.message, errorOutput });
            }
        });

        mcProcess.on('exit', (code, signal) => {
            log('INFO', `Minecraft exited: code=${code} signal=${signal}`);
            // Логируем последние 100 строк вывода для диагностики
            if (code !== 0) {
                const lines = fullOutput.split('\n');
                const tail = lines.slice(-100).join('\n');
                log('ERROR', `Minecraft exit output (last 100 lines):\n${tail}`);
            }
            if (code !== 0 && code !== null && code !== 130 && mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('mc-process-exit-error', { code, errorOutput: errorOutput || fullOutput.slice(-3000) });
            }
        });

        // Запускаем слежку за PID (скрывает launcher, показывает после закрытия MC)
        startMcWatch(pid);

        return { ok: true, pid };
    } catch (e) {
        log('ERROR', `mc:spawn failed: ${e.message}`);
        return { ok: false, error: e.message };
    }
});

// ════════════════════════════════════════════════════════════════════════════════
// SCREENSHOTS — листинг и удаление скриншотов
// ════════════════════════════════════════════════════════════════════════════════

ipcMain.handle('launcher:base-path', () => {
    return getLauncherBasePath(process.platform, require('os').homedir(), process.env.APPDATA);
});

ipcMain.handle('screenshots:list', async (_, basePath) => {
    try {
        const IMG_EXT = ['.png', '.jpg', '.jpeg', '.tga', '.bmp'];

        // Всегда используем реальный путь лаунчера как корень поиска,
        // но также принимаем переданный basePath как дополнительный корень
        const launcherBase = getLauncherBasePath(process.platform, require('os').homedir(), process.env.APPDATA);

        // Собираем все корни для поиска (лаунчер + пользовательский путь если отличается)
        const searchRoots = new Set();
        searchRoots.add(launcherBase);

        if (basePath) {
            let userBase = String(basePath);
            // Если передали путь к конкретному инстансу — идём на уровень выше
            try {
                const bn = path.basename(userBase);
                if (bn.startsWith('minecraft-') || bn === 'minecraft') {
                    userBase = path.dirname(userBase);
                }
            } catch (_) {}
            if (fs.existsSync(userBase)) searchRoots.add(path.resolve(userBase));
        }

        const result = [];
        const seenFiles = new Set(); // дедупликация по абсолютному пути

        for (const base of searchRoots) {
            if (!fs.existsSync(base)) continue;

            let entries = [];
            try {
                entries = await fs.promises.readdir(base, { withFileTypes: true });
            } catch (e) {
                log('ERROR', `[screenshots] readdir failed for ${base}: ${e.message}`);
                continue;
            }

            await Promise.all(entries.map(async entry => {
                if (!entry.isDirectory()) return;

                const dir = entry.name;
                const dirPath = path.join(base, dir);
                const ssDir  = path.join(dirPath, 'screenshots');

                let ssFiles;
                try {
                    ssFiles = await fs.promises.readdir(ssDir, { withFileTypes: true });
                } catch {
                    return; // нет папки screenshots — пропускаем
                }

                // Читаем instance.json для красивого имени (если есть)
                let displayName = null;
                try {
                    const cfgPath = path.join(dirPath, 'instance.json');
                    if (fs.existsSync(cfgPath)) {
                        const cfg = JSON.parse(await fs.promises.readFile(cfgPath, 'utf8'));
                        displayName = cfg.name || cfg.displayName || null;
                    }
                } catch { /* нет instance.json — просто версия */ }

                await Promise.all(ssFiles.map(async ssEntry => {
                    if (!ssEntry.isFile()) return;
                    const file = ssEntry.name;
                    if (!IMG_EXT.includes(path.extname(file).toLowerCase())) return;

                    const filePath = path.resolve(path.join(ssDir, file));
                    if (seenFiles.has(filePath)) return; // дедупликация
                    seenFiles.add(filePath);

                    try {
                        const stat = await fs.promises.stat(filePath);
                        result.push({
                            file,
                            filePath,
                            version:     dir,          // имя папки minecraft-*
                            displayName,               // красивое имя из instance.json (или null)
                            mtime:       stat.mtimeMs,
                            size:        stat.size,
                        });
                    } catch { /* ignore */ }
                }));
            }));
        }

        result.sort((a, b) => b.mtime - a.mtime);
        log('INFO', `[screenshots] Found ${result.length} screenshots across ${searchRoots.size} root(s)`);
        return result;
    } catch (e) {
        log('ERROR', `screenshots:list: ${e.message}`);
        return [];
    }
});

ipcMain.handle('screenshots:delete', async (_, filePath) => {
    try { await fs.promises.unlink(String(filePath)); return true; }
    catch (e) { log('ERROR', `screenshots:delete: ${e.message}`); return false; }
});

// ════════════════════════════════════════════════════════════════════════════════
// INSTANCES — управление инстансами Minecraft
// ════════════════════════════════════════════════════════════════════════════════

ipcMain.handle('instances:list', async (_, basePath) => {
    try {
        if (!fs.existsSync(String(basePath))) return [];
        const dirs = await fs.promises.readdir(String(basePath), { withFileTypes: true });
        const result = [];

        await Promise.all(dirs
            .filter(d => d.isDirectory() && d.name.startsWith('minecraft-'))
            .map(async d => {
                const dirPath = path.join(String(basePath), d.name);
                const configPath = path.join(dirPath, 'instance.json');
                let config = {};
                try {
                    if (fs.existsSync(configPath)) config = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
                } catch { /* ignore */ }

                // Считаем размер
                let size = 0;
                try {
                    const walk = async p => {
                        const ents = await fs.promises.readdir(p, { withFileTypes: true });
                        await Promise.all(ents.map(async e => {
                            const ep = path.join(p, e.name);
                            if (e.isDirectory()) await walk(ep);
                            else { const s = await fs.promises.stat(ep); size += s.size; }
                        }));
                    };
                    await walk(dirPath);
                } catch { /* ignore */ }

                result.push({ dir: d.name, path: dirPath, config, size });
            })
        );

        return result;
    } catch (e) {
        log('ERROR', `instances:list: ${e.message}`);
        return [];
    }
});

ipcMain.handle('instances:read-config', async (_, instancePath) => {
    try {
        const configPath = path.join(String(instancePath), 'instance.json');
        if (!fs.existsSync(configPath)) return null;
        return JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
    } catch { return null; }
});

ipcMain.handle('instances:write-config', async (_, instancePath, config) => {
    try {
        const configPath = path.join(String(instancePath), 'instance.json');
        await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
        return true;
    } catch (e) { log('ERROR', `instances:write-config: ${e.message}`); return false; }
});

ipcMain.handle('instances:delete', async (_, instancePath) => {
    try {
        await fs.promises.rm(String(instancePath), { recursive: true, force: true });
        return true;
    } catch (e) { log('ERROR', `instances:delete: ${e.message}`); return false; }
});

ipcMain.handle('instances:create-dirs', async (_, instancePath, subdirs) => {
    try {
        await Promise.all(subdirs.map(sub => fs.promises.mkdir(path.join(String(instancePath), sub), { recursive: true })));
        return true;
    } catch (e) { log('ERROR', `instances:create-dirs: ${e.message}`); return false; }
});

// ─── Экспорт инстанса (вынесено из renderer, убран require('child_process')) ──
ipcMain.handle('instances:export', async (_, instancePath, destDir) => {
    const { execFile } = require('child_process');
    const { ZIP_TIMEOUT_MS } = require('./src/renderer/constants');
    try {
        const instDir = path.basename(String(instancePath));
        const destZip = path.join(String(destDir), `${instDir}.zip`);
        const timeout = ZIP_TIMEOUT_MS || 120000;

        await new Promise((resolve, reject) => {
            let proc;
            const platform = os.platform();
            if (platform === 'win32') {
                proc = execFile('powershell', [
                    '-NoProfile', '-NonInteractive', '-Command',
                    `Compress-Archive -Path '${instancePath}\\*' -DestinationPath '${destZip}' -Force`,
                ], { timeout });
            } else {
                proc = execFile('zip', ['-rq', destZip, '.'], { cwd: instancePath, timeout });
            }
            proc.on('close', code => code === 0 ? resolve() : reject(new Error(`zip завершился с кодом ${code}`)));
            proc.on('error', err => reject(err));
        });

        return { ok: true, destZip };
    } catch (e) {
        log('ERROR', `instances:export: ${e.message}`);
        return { ok: false, code: 'ERR_EXPORT', error: e.message };
    }
});

// ─── Импорт инстанса (вынесено из renderer, убран require('child_process')) ───
ipcMain.handle('instances:import', async (_, zipPath, baseDir, suggestedName) => {
    const { execFile } = require('child_process');
    const { ZIP_TIMEOUT_MS } = require('./src/renderer/constants');
    let dest = null;
    try {
        const timeout = ZIP_TIMEOUT_MS || 120000;

        const INSTANCE_PREFIX = 'minecraft-';
        let destName = String(suggestedName);
        if (!destName.startsWith(INSTANCE_PREFIX)) destName = INSTANCE_PREFIX + destName;
        const baseName = destName;
        let counter = 2;
        while (fs.existsSync(path.join(String(baseDir), destName))) destName = `${baseName}-${counter++}`;

        dest = path.join(String(baseDir), destName);
        await fs.promises.mkdir(dest, { recursive: true });

        await new Promise((resolve, reject) => {
            const platform = os.platform();
            const proc = platform === 'win32'
                ? execFile('powershell', [
                    '-NoProfile', '-NonInteractive', '-Command',
                    `Expand-Archive -Path '${zipPath}' -DestinationPath '${dest}' -Force`,
                  ], { timeout })
                : execFile('unzip', ['-q', String(zipPath), '-d', dest], { timeout });
            proc.on('close', code => {
                if (code === 0) { resolve(); }
                else {
                    fs.promises.rm(dest, { recursive: true, force: true }).catch(() => {});
                    reject(new Error(`unzip завершился с кодом ${code}`));
                }
            });
            proc.on('error', err => {
                fs.promises.rm(dest, { recursive: true, force: true }).catch(() => {});
                reject(err);
            });
        });

        return { ok: true, destName };
    } catch (e) {
        if (dest) fs.promises.rm(dest, { recursive: true, force: true }).catch(() => {});
        log('ERROR', `instances:import: ${e.message}`);
        return { ok: false, code: 'ERR_IMPORT', error: e.message };
    }
});

// ════════════════════════════════════════════════════════════════════════════════
// MODS — дополнительные операции (скачивание, установка, метаданные)
// ════════════════════════════════════════════════════════════════════════════════

ipcMain.handle('mods:count', async (_, basePath, versionId) => {
    try {
        const { getModsFolderForVersion } = require('./src/paths');
        const modsPath = getModsFolderForVersion(String(basePath), String(versionId));
        if (!fs.existsSync(modsPath)) return 0;
        const files = await fs.promises.readdir(modsPath);
        return files.filter(f => f.endsWith('.jar')).length;
    } catch { return 0; }
});

ipcMain.handle('mods:parse-metadata', async (_, jarPath) => {
    try {
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(String(jarPath));

        // Fabric / Quilt
        const fabricEntry = zip.getEntry('fabric.mod.json') || zip.getEntry('quilt.mod.json');
        if (fabricEntry) {
            const meta = JSON.parse(fabricEntry.getData().toString('utf8'));
            return { id: meta.id, name: meta.name || meta.id, version: meta.version, description: meta.description || '', loader: 'fabric' };
        }

        // Forge (mods.toml)
        const forgeEntry = zip.getEntry('META-INF/mods.toml');
        if (forgeEntry) {
            const text = forgeEntry.getData().toString('utf8');
            const idM = text.match(/modId\s*=\s*"([^"]+)"/);
            const nameM = text.match(/displayName\s*=\s*"([^"]+)"/);
            const verM = text.match(/version\s*=\s*"([^"]+)"/);
            return {
                id: idM?.[1] || '', name: nameM?.[1] || idM?.[1] || path.basename(jarPath, '.jar'),
                version: verM?.[1] || '', description: '', loader: 'forge'
            };
        }

        return { id: '', name: path.basename(jarPath, '.jar'), version: '', description: '', loader: 'unknown' };
    } catch { return null; }
});

ipcMain.handle('mods:copy-to-folder', async (_, srcPath, modsDir, fileName) => {
    try {
        await fs.promises.mkdir(String(modsDir), { recursive: true });
        const dest = path.join(String(modsDir), String(fileName));
        await fs.promises.copyFile(String(srcPath), dest);
        return { ok: true, dest };
    } catch (e) {
        log('ERROR', `mods:copy-to-folder: ${e.message}`);
        return { ok: false, error: e.message };
    }
});

// ════════════════════════════════════════════════════════════════════════════════
// SERVERS — пинг серверов и работа с servers.dat
// (вынесено из renderer/servers.js — убраны require('net'), require('fs'), require('path'))
// ════════════════════════════════════════════════════════════════════════════════

ipcMain.handle('server:ping', async (_, host, port, timeout) => {
    const net = require('net');
    port    = parseInt(port)    || 25565;
    timeout = parseInt(timeout) || 5000;

    return new Promise((resolve) => {
        const socket = new net.Socket();
        let resolved = false;
        let buf = Buffer.alloc(0);

        const done = (result) => {
            if (resolved) return;
            resolved = true;
            socket.destroy();
            resolve(result);
        };

        const timer = setTimeout(() => done({ online: false, error: 'timeout' }), timeout);

        socket.connect(port, String(host), () => {
            function varInt(v) {
                const arr = [];
                do { let b = v & 0x7F; v >>>= 7; if (v !== 0) b |= 0x80; arr.push(b); } while (v !== 0);
                return Buffer.from(arr);
            }
            function str16(s) { const b = Buffer.from(s, 'utf8'); return Buffer.concat([varInt(b.length), b]); }

            const handshake = Buffer.concat([
                varInt(0x00), varInt(0x2F), str16(String(host)),
                Buffer.from([port >> 8, port & 0xFF]), varInt(1)
            ]);
            socket.write(Buffer.concat([varInt(handshake.length), handshake]));
            socket.write(Buffer.from([0x01, 0x00]));
            socket.write(Buffer.from([0x09, 0x01, 0, 0, 0, 0, 0, 0, 0, 0]));
        });

        socket.on('data', (chunk) => {
            buf = Buffer.concat([buf, chunk]);
            try {
                let vi = 0, shift = 0, p = 0;
                for (;;) {
                    if (p >= buf.length) return;
                    const b = buf[p++]; vi |= (b & 0x7F) << shift; shift += 7;
                    if (!(b & 0x80)) break;
                }
                if (buf.length < p + vi) return;
                let id = 0, s2 = 0, p2 = p;
                for (;;) { const b = buf[p2++]; id |= (b & 0x7F) << s2; s2 += 7; if (!(b & 0x80)) break; }
                if (id !== 0x00) return;
                let jsonLen = 0, s3 = 0;
                for (;;) { const b = buf[p2++]; jsonLen |= (b & 0x7F) << s3; s3 += 7; if (!(b & 0x80)) break; }
                if (buf.length < p2 + jsonLen) return;
                const data = JSON.parse(buf.slice(p2, p2 + jsonLen).toString('utf8'));
                clearTimeout(timer);
                done({
                    online:   true,
                    version:  data.version?.name   || '?',
                    protocol: data.version?.protocol || 0,
                    players:  data.players ? { online: data.players.online, max: data.players.max } : { online: 0, max: 0 },
                    motd:     data.description,
                    favicon:  data.favicon || null,
                });
            } catch { /* wait for more data */ }
        });

        socket.on('error', (e) => { clearTimeout(timer); done({ online: false, error: e.message }); });
        socket.on('close', () => { clearTimeout(timer); done({ online: false, error: 'closed' }); });
    });
});

ipcMain.handle('server:read-dat', async (_, mcDir) => {
    try {
        const file = path.join(String(mcDir), 'servers.dat');
        if (!fs.existsSync(file)) return null;
        const buf = await fs.promises.readFile(file);
        // Минимальный NBT-парсер (servers.dat)
        let pos = 0;
        const readByte   = () => buf[pos++];
        const readShort  = () => { const v = buf.readInt16BE(pos); pos += 2; return v; };
        const readInt    = () => { const v = buf.readInt32BE(pos); pos += 4; return v; };
        const readString = () => { const len = buf.readUInt16BE(pos); pos += 2; const s = buf.slice(pos, pos + len).toString('utf8'); pos += len; return s; };
        const readPayload = (type) => {
            switch(type) {
                case 1: return readByte();
                case 2: return readShort();
                case 3: return readInt();
                case 4: pos += 8; return null;
                case 5: pos += 4; return null;
                case 6: pos += 8; return null;
                case 7: { const l = readInt(); pos += l; return null; }
                case 8: return readString();
                case 9: { const lt = readByte(); const sz = readInt(); const arr = []; for(let i=0;i<sz;i++) arr.push(readPayload(lt)); return arr; }
                case 10: return readCompound();
                case 11: { const l = readInt(); pos += l*4; return null; }
                case 12: { const l = readInt(); pos += l*8; return null; }
                default: return null;
            }
        };
        const readCompound = () => { const obj = {}; for(;;){ const t=readByte(); if(t===0) break; const n=readString(); obj[n]=readPayload(t); } return obj; };
        const rootType = readByte();
        if (rootType !== 10) return [];
        readString();
        const root = readCompound();
        const list = root['servers'];
        if (!Array.isArray(list)) return [];
        return list.filter(e => e && typeof e === 'object')
            .map(e => ({ name: String(e.name || ''), ip: String(e.ip || '') }))
            .filter(e => e.ip);
    } catch(e) {
        log('ERROR', `server:read-dat: ${e.message}`);
        return [];
    }
});

ipcMain.handle('server:load-local', async () => {
    try {
        const candidates = [
            path.join(__dirname, 'servers.json'),
            path.join(__dirname, '..', 'servers.json'),
            path.join(process.resourcesPath || '', 'servers.json'),
        ];
        for (const p of candidates) {
            if (fs.existsSync(p)) {
                const data = JSON.parse(await fs.promises.readFile(p, 'utf8'));
                if (Array.isArray(data) && data.length > 0) return data;
            }
        }
    } catch (e) { log('WARN', `server:load-local: ${e.message}`); }
    return null;
});

ipcMain.handle('server:write-dat', async (_, mcDir, serverName, serverIp) => {
    try {
        const file = path.join(String(mcDir), 'servers.dat');
        // Читаем существующий список
        let existing = [];
        try {
            const result = await ipcMain.listeners && fs.existsSync(file)
                ? (() => { /* inline read */ return []; })()
                : [];
        } catch { /* ignore */ }
        // Простая реализация: читаем сами
        if (fs.existsSync(file)) {
            try {
                // Минимальный read (дублируем, т.к. нет self-IPC)
                const buf = await fs.promises.readFile(file);
                let pos = 0;
                const rB = () => buf[pos++];
                const rS = () => { const v = buf.readInt16BE(pos); pos += 2; return v; };
                const rI = () => { const v = buf.readInt32BE(pos); pos += 4; return v; };
                const rStr = () => { const l = buf.readUInt16BE(pos); pos += 2; const s = buf.slice(pos, pos+l).toString('utf8'); pos += l; return s; };
                const rP = (t) => {
                    switch(t){case 1:return rB();case 2:return rS();case 3:return rI();
                    case 4:pos+=8;return null;case 5:pos+=4;return null;case 6:pos+=8;return null;
                    case 7:{const l=rI();pos+=l;return null;}case 8:return rStr();
                    case 9:{const lt=rB();const sz=rI();const a=[];for(let i=0;i<sz;i++)a.push(rP(lt));return a;}
                    case 10:return rC();case 11:{const l=rI();pos+=l*4;return null;}case 12:{const l=rI();pos+=l*8;return null;}default:return null;}
                };
                const rC = () => { const o={}; for(;;){const t=rB();if(t===0)break;const n=rStr();o[n]=rP(t);}return o; };
                if (rB() === 10) { rStr(); const root = rC(); existing = (root['servers'] || []).filter(e=>e?.ip).map(e=>({name:String(e.name||''),ip:String(e.ip||'')})); }
            } catch { /* ignore */ }
        }

        const filtered = existing.filter(s => s.ip !== String(serverIp));
        const list = [{ name: String(serverName), ip: String(serverIp) }, ...filtered];

        // Build NBT
        const parts = [];
        const byte   = (v) => { const b = Buffer.alloc(1); b[0] = v; parts.push(b); };
        const int    = (v) => { const b = Buffer.alloc(4); b.writeInt32BE(v); parts.push(b); };
        const string = (s) => { const sb = Buffer.from(String(s), 'utf8'); const lb = Buffer.alloc(2); lb.writeUInt16BE(sb.length); parts.push(lb, sb); };
        byte(10); string('');
        byte(9); string('servers'); byte(10); int(list.length);
        for (const srv of list) {
            byte(8); string('ip');   string(srv.ip);
            byte(8); string('name'); string(srv.name || srv.ip);
            byte(1); string('acceptTextures'); byte(0);
            byte(0);
        }
        byte(0);

        await fs.promises.mkdir(String(mcDir), { recursive: true });
        await fs.promises.writeFile(file, Buffer.concat(parts));
        return { ok: true };
    } catch(e) {
        log('ERROR', `server:write-dat: ${e.message}`);
        return { ok: false, code: 'ERR_FS_WRITE', error: e.message };
    }
});


// ════════════════════════════════════════════════════════════════════════════════
// CRYPTO — безопасные криптографические операции
// ════════════════════════════════════════════════════════════════════════════════

ipcMain.handle('crypto:offline-uuid', (_, username) => {
    try {
        const crypto = require('crypto');
        const hash = crypto.createHash('md5').update('OfflinePlayer:' + String(username)).digest();
        return [
            hash.toString('hex', 0, 4),
            hash.toString('hex', 4, 6),
            ((parseInt(hash.toString('hex', 6, 8), 16) & 0x0fff) | 0x3000).toString(16),
            ((parseInt(hash.toString('hex', 8, 10), 16) & 0x3fff) | 0x8000).toString(16),
            hash.toString('hex', 10, 16)
        ].join('-');
    } catch { return null; }
});

// ════════════════════════════════════════════════════════════════════════════════
// PROCESS INFO — системная информация для renderer
// ════════════════════════════════════════════════════════════════════════════════

ipcMain.handle('process:info', () => ({
    platform: process.platform,
    arch: process.arch,
    env: {
        APPDATA: process.env.APPDATA || null,
        JAVA_HOME: process.env.JAVA_HOME || null,
        HOME: process.env.HOME || null,
    },
    versions: { electron: process.versions.electron, node: process.versions.node }
}));

// ════════════════════════════════════════════════════════════════════════════════
// PLAYTIME — чтение времени для renderer (обёртка над IPC)
// ════════════════════════════════════════════════════════════════════════════════

ipcMain.handle('playtime:get', () => readPlaytime());

// ════════════════════════════════════════════════════════════════════════════════

function registerSafePermissionHandler() {
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
        callback(false);
    });
}

// ========== Жизненный цикл ==========


// ════════════════════════════════════════════════════════════════════════════════
// YGGDRASIL MOCK SERVER — локальная авторизация для MC < 1.17
// Обходит "Multiplayer is disabled. Please check your Microsoft account settings."
// Использует RSA-4096 ключи для подписи профилей (требование authlib-injector).
// ════════════════════════════════════════════════════════════════════════════════
let yggdrasilPort = 25567;
let yggdrasilServer = null;

// RSA-4096 ключи (PKCS#1 формат — совместим с SHA1 на Node.js 22+ / OpenSSL 3+).
// Приватный ключ используется для подписи профилей, публичный — передаётся authlib-injector.
const YGGDRASIL_PRIVATE_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIIJJwIBAAKCAgEAh7vbfy1+DxC6TQYFJYk6QqZfPT5PnSWccWT6xmIQak7DxMOa
n8KBrXWxSqCmkPhueUqYw9xi9yqDqlbJ8EU30gXxkavI101rRj0gQRV+mp9Ot+m1
OUYSC3Fms0aAW+8W+vAwDzW8cW1CAtKUdxZryfw0YRqPdq0OzuhxplG9gOfbdwsT
cmhXO23adtGKw283vduJmM3cKliTRhGW0cIVurnHnNfsH1HE8036fgFPO7PegsSY
DboALT09ucjlF3LDRXaprKiwUV7NqOJIS3cNXShPSwHlH5N0F7Myq+r1hjH8pf9U
lpFnpmrZMnp8Fxvx/33yDxve4AoDQ7+IutAvGv40WT2n5+ItuI8QNSss35runeTT
3a83JfCHFlQpA+xQOyoT5slj4Z6yUfJzYGoYr4xAuN6R7zkXWNvrMKzgm2q4KoCy
EjUqhwSFYgWANCs6eEgFabmhTtHK7w84CkHd90qkcp9FeFTpeWjLxLXUo+DG9qWz
cmiWiZsUWMmbk6wCM+2q8CrF9iWwUiluEbAnpWh6Al7vNAB+KO/V60Q9YxzO8QZO
XPbZwIO+mJc0Bnhg0esE8xFKI0Go96U1H3OcXZwXANtpooZE3j++ddpvsC/VmvXH
j89y5al4gzncl9yez4udepX5TcS9vv+/i1S8J7TuzLY7XnNGrNVsXbjDLWUCAwEA
AQKCAgAEVaIvvt22vVkpsp6RWvJbZJ5uR8vGKa7D60GorXYdovhhYFq5ej4zmLc2
hu6F+vAyNOJ8f+onWPoqUCOz2QE5MBuAndY0oLvWgVPpaCmQszPFFg3fIponneTP
WebC9Z3LzSxHuN0hi44b8qp790euN1Z0rGLpwaLs37AZ0gq41ig99k9WBbfiOLYA
U3afATGSdIAoIX83DF8sBQDgBj0bgNyVD5fyTX7tdlXG8AoRW5AO20ujLC4Rw8Uk
syIa73BsPgFMnd8L9ivsovwQ8HmvhvHc5BZZ5AnrlztWXjlrFYERmJehSEruUR0X
BAgFVLN6Ot6MqRGJh4a6EBPqdusuIYlpLrD5QMuy1lzUEX1mwOwmM+U6USp3RIaZ
62so/MB7HdBBqvMIWkq0HJeQrI276/svmUzQfgIUhNFbTmFbvlb1AiVSTAIS/ZeC
/8WaYc+aIU0/sEW4PSrvKxzRM3M43bUpftZcHw3aoW20oXGqWWgylp6Wo97fOD1u
LcD8woXpmBe5X931Gau1l1s6TXJt+g4tygT9HD/fSEcB3FG+O5YecGcBpGnQiK90
Wx9n51SBntaoH+r98upSkSRxD08GKasPCtUucmSoLlGYWOCcoV1HHIA6Bt/VuS0i
Bik+s4weQkohoxov98+ezRB0QZoWa9cfngRJgI3jxzqFH9kcaQKCAQEAu9el1brG
/Eacucia2lN0qlHCsqI3TRqjke3vIK8o3HKz2lNTBgC9l43eLq4DBlgkonRR9BGA
iFSvShfRgVztu/3FuKyUobFz3tpuu7R+R/vnq+N3alA8s2+cb7iVdrC+cP9e2GSQ
iLO/eL000IoBwpvLOdKW7AvvyvLzdqa7LPQq9llniPd6XKs2FKALlq7HsVABxcgj
c3qiJAaxHP/6OzLt6i021Ip4hhCCkO+A7YinLxImsoiaYwi8Ola6pvmRD+0s1krE
GvcqmvmP9BK/Ds0SEM9Cq/4nbGoMG43rf2gjSv4Qbm8oudwiG/ny7e3dRBqtrZtr
wUtmzor97Xq3GQKCAQEAuPvvrfLGOZ6E7h8H+w6PnXCnAiR2UWFBfDjeWBhoY/V+
ww/J4jANkqYkkxJTzbGMjn82sU16/LNn1y9Pw+Tu4tfOWa8dQbeLXl0G1lMA3/+r
HD4CGVK1YEwaADzFadlTedIwXplaQ6KWhZDSI4dwotti2vR5/T8QArRDviBPlLP0
n5mGFr912vabZ01Q+0Xw2r8jFkDT9eAz0D6xoJaU5R0c7FVAmheInP4cEeezeceE
2U7t1x/Jhxo5qQsmnHfB9iiBfzyxeB2/tR06+kaeCgSB2fAiC2shAvQB1meR/Ipr
WQuawsMk10Ne2axxjTcnaR99EC8H7mcxj28TrW6uLQKCAQAurFqMTKh8rp7qmqm/
bdUjLMWP1TagdeoGrHQqTtt8SxPdP671YuG48osuVhZyURxpMTXbyy2AsmoLovdv
iUOY3mluhZM4yfrceLHi+eoWwMTDtPVK+Tzb6POZ3udkYm4vbYSHiBVRojgFLB4f
YuslC8jnSSgu5phieRN9e9guR00VgQl0wukodXIulcXLXwpHSHXoSt5kJyh6gx8m
8YOfifwLn8hr7ywbQ6btlFUYsEe6LmxnGAIkcVszs7EVJBWjO29Un6cyfA+eCjx2
jOHkL5g5jQYn7jKlgYQYpJ7LPXjnfVFf30bjR4tCIEz4SY4dCfP1mxSfJrkYwPhv
NXqhAoIBAAhFKzgJrJcS4TqMJJ0yz3Tofm74FloZEQZuvHIP1UryxNIPuKTmJRUz
XFs+7IQ7td8BDP7sSd1WYAQc12IYsB1wLIeR7qrre82iNxYJ6/YXxhyjIRDkw7sk
a90q2mCbGMJPhV4VWRXBBR2/lcWE3qJJUKgdWf7afOrCCG1NoIEzcnJYOMh3kttR
Py1lJYO2YshE11q9Vzyc43Qh+WsGkG2V2Z8vSI4bEz6BlduvEjUVmHjmsHd3sljZ
8U3/c6B3MjLBKNj5a63FFrcQMXzS/2nPPcbyl3MPPRCWvCZLxxkVTytR+39Nni4J
kwoETadUmex3Pe4lTCN6dZrGCoksc5kCggEAWQg9gQl0AbalH1N1OfituOqScxn2
OeFQ+jsj4FPVOfAyEZvxbzyqEZfG4NVOkQL6LhBN2gP6qHJobtJPDI6/rsGdN3TW
A46icMb+hHB+YEXLCSPWriLUo3LC7wyoVUn25SwWzz8UwUNDZ59x8/mYbW9qvTvR
e7A5uU1Z4zrcIsoabD3qY8lY0f7F0epXdC65LtLwC5Nvjl+FI4ZEcgQ1odUG+shs
Irvmw6Hd90mCDNe0ghgEP2kdiaBkYHR8gAZtd3HKKNEgnPT0sj3YML3eZl3nrIJI
wQyWCDf5ueKH6IpTmca9qWhcv5LL0B4w84sQf4JhULLPYhfrU/tyDTEaiw==
-----END RSA PRIVATE KEY-----`;

const YGGDRASIL_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAh7vbfy1+DxC6TQYFJYk6
QqZfPT5PnSWccWT6xmIQak7DxMOan8KBrXWxSqCmkPhueUqYw9xi9yqDqlbJ8EU3
0gXxkavI101rRj0gQRV+mp9Ot+m1OUYSC3Fms0aAW+8W+vAwDzW8cW1CAtKUdxZr
yfw0YRqPdq0OzuhxplG9gOfbdwsTcmhXO23adtGKw283vduJmM3cKliTRhGW0cIV
urnHnNfsH1HE8036fgFPO7PegsSYDboALT09ucjlF3LDRXaprKiwUV7NqOJIS3cN
XShPSwHlH5N0F7Myq+r1hjH8pf9UlpFnpmrZMnp8Fxvx/33yDxve4AoDQ7+IutAv
Gv40WT2n5+ItuI8QNSss35runeTT3a83JfCHFlQpA+xQOyoT5slj4Z6yUfJzYGoY
r4xAuN6R7zkXWNvrMKzgm2q4KoCyEjUqhwSFYgWANCs6eEgFabmhTtHK7w84CkHd
90qkcp9FeFTpeWjLxLXUo+DG9qWzcmiWiZsUWMmbk6wCM+2q8CrF9iWwUiluEbAn
pWh6Al7vNAB+KO/V60Q9YxzO8QZOXPbZwIO+mJc0Bnhg0esE8xFKI0Go96U1H3Oc
XZwXANtpooZE3j++ddpvsC/VmvXHj89y5al4gzncl9yez4udepX5TcS9vv+/i1S8
J7TuzLY7XnNGrNVsXbjDLWUCAwEAAQ==
-----END PUBLIC KEY-----`;

// Хелпер: подписывает строку (value) приватным ключом (SHA1withRSA)
// Используем createSign API — совместимо со всеми версиями Node.js / OpenSSL
function yggdrasilSign(valueStr) {
    try {
        const crypto = require('crypto');
        const signer = crypto.createSign('SHA1');
        signer.update(valueStr);
        return signer.sign(YGGDRASIL_PRIVATE_KEY, 'base64');
    } catch (e) {
        log('ERROR', `[Yggdrasil] Sign error: ${e.message}`);
        return '';
    }
}

// Хелпер: строит объект профиля с подписанными свойствами
function buildProfile(uuid, name) {
    const texturesObj = {
        timestamp: Date.now(),
        profileId: uuid,
        profileName: name,
        textures: {}
    };
    const valueB64 = Buffer.from(JSON.stringify(texturesObj)).toString('base64');
    const signature = yggdrasilSign(valueB64);
    return {
        id: uuid,
        name: name,
        properties: [{
            name: 'textures',
            value: valueB64,
            signature: signature
        }]
    };
}

function startYggdrasilServer() {
    yggdrasilServer = http.createServer((req, res) => {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
            res.setHeader('Content-Type', 'application/json');
            const url = req.url;

            // ALI root meta — signaturePublickey ОБЯЗАН содержать PEM публичного ключа
            if (req.method === 'GET' && (url === '/' || url === '')) {
                res.writeHead(200);
                return res.end(JSON.stringify({
                    meta: {
                        serverName: 'FixLauncher',
                        implementationName: 'FixLauncher Yggdrasil',
                        implementationVersion: '1.0',
                        feature: { non_email_login: true }
                    },
                    skinDomains: ['127.0.0.1', 'localhost'],
                    signaturePublickey: YGGDRASIL_PUBLIC_KEY
                }));
            }

            // authenticate / refresh
            if (url.includes('/authserver/authenticate') || url.includes('/authserver/refresh')) {
                let username = 'Player';
                let uuid = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
                try {
                    const parsed = JSON.parse(body);
                    username = (parsed.username || parsed.agent?.name || 'Player').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 16);
                } catch (_) {}
                const profile = buildProfile(uuid, username);
                res.writeHead(200);
                return res.end(JSON.stringify({
                    accessToken: '00000000000000000000000000000001',
                    clientToken: '00000000000000000000000000000002',
                    selectedProfile: { id: uuid, name: username },
                    availableProfiles: [{ id: uuid, name: username }],
                    user: { id: uuid, properties: [] }
                }));
            }

            // validate / invalidate / signout — 204 no content
            if (url.includes('/authserver/')) {
                res.writeHead(204); return res.end();
            }

            // session join
            if (url.includes('/session/minecraft/join')) {
                res.writeHead(204); return res.end();
            }

            // session hasJoined — ключевой эндпоинт для мультиплеера на серверах
            if (url.includes('/session/minecraft/hasJoined')) {
                try {
                    const params = new URLSearchParams(url.split('?')[1] || '');
                    const name = params.get('username') || 'Player';
                    const uuid = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
                    res.writeHead(200);
                    return res.end(JSON.stringify(buildProfile(uuid, name)));
                } catch (e) {
                    log('ERROR', `[Yggdrasil] hasJoined error: ${e.message}`);
                    res.writeHead(204); return res.end();
                }
            }

            // profile lookup (GET .../profile/:uuid)
            if (url.includes('/session/minecraft/profile/') || url.includes('/api/profiles/') || url.includes('/users/profiles/')) {
                const parts = url.split('/');
                const rawId = parts[parts.length - 1].split('?')[0];
                const name = 'Player';
                const uuid = rawId || 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
                res.writeHead(200);
                return res.end(JSON.stringify(buildProfile(uuid, name)));
            }

            // Всё остальное — пусто
            res.writeHead(204); res.end();
        });
    });

    function tryListen() {
        yggdrasilServer.listen(yggdrasilPort, '127.0.0.1', () => {
            log('INFO', `[Yggdrasil] Mock auth server started on http://127.0.0.1:${yggdrasilPort}/ (RSA-4096 signing enabled)`);
        });
    }

    yggdrasilServer.on('error', (e) => {
        if (e.code === 'EADDRINUSE') {
            yggdrasilPort++;
            tryListen();
        } else {
            log('ERROR', `[Yggdrasil] Server error: ${e.message}`);
        }
    });

    tryListen();
}

ipcMain.handle('yggdrasil:port', () => yggdrasilPort);

app.whenReady().then(() => {
    log("INFO", "App ready [PLAYTIME-BUILD v3]");
    startYggdrasilServer();
    initPlaytimeOnStart();
    initDiscordRPC();
    registerSafePermissionHandler();
    createWindow();
    // Проверяем обновления через 3 сек после запуска (чтобы окно успело загрузиться)
    setTimeout(() => checkGitHubUpdate(), 3000);

    // Периодическая проверка — раз в 2 часа пока лаунчер открыт
    const UPDATE_CHECK_INTERVAL_MS = 2 * 60 * 60 * 1000;
    setInterval(() => checkGitHubUpdate(), UPDATE_CHECK_INTERVAL_MS);
});

app.on("window-all-closed", () => {
    log("INFO", "All windows closed");
    // Если MC запущен — НЕ выходим, ждём пока игра закроется
    if (mcWatchInterval) {
        log("INFO", "MC is running, keeping app alive to watch PID");
        return;
    }
    if (process.platform !== "darwin") {
        app.quit();
    }
});

app.on("activate", () => {
    log("INFO", "App activated");
    if (BrowserWindow.getAllWindows().length === 0) {
        registerSafePermissionHandler();
        createWindow();
    }
});

app.on("quit", () => {
    log("INFO", "App quitting");
});
