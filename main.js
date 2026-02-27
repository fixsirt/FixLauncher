const { app, BrowserWindow, ipcMain, dialog, shell, session } = require("electron");
const path = require("path");
const https = require("https");
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
            { label: '⬇️ Скачать FixLauncher', url: 'https://t.me/vanillasunsteam' }
        ];
    } else {
        activity.details = 'FixLauncher';
        activity.state = 'Выбор сборки';
        activity.buttons = [
            { label: '⬇️ Скачать FixLauncher', url: 'https://t.me/vanillasunsteam' }
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
const NEWS_MD_URL = 'https://raw.githubusercontent.com/fixsirt/FixLauncher/main/NEWS.md';
const LOG_FILE = path.join(__dirname, "debug.log");
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

// ========== Парсер NEWS.md ==========
function parseNewsMd(md) {
    // Новости разделяются через ---
    const blocks = md.split(/\n---+\n/).map(b => b.trim()).filter(Boolean);
    return blocks.map(block => {
        const lines = block.split('\n');
        // Первая строка ## Заголовок (дата)
        let title = '';
        let date = '';
        const titleMatch = lines[0].match(/^##\s+(.+?)(?:\s+\((.+?)\))?$/);
        if (titleMatch) {
            title = titleMatch[1].trim();
            date = titleMatch[2] ? titleMatch[2].trim() : '';
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

function startMcWatch(pid) {
    mcPid = pid;
    // Записываем старт сессии
    const data = readPlaytime();
    if (data.sessionStart) {
        // Предыдущая сессия не закрылась — засчитываем
        const elapsed = Math.floor((Date.now() - data.sessionStart) / 1000);
        if (elapsed > 0 && elapsed < 86400) data.totalSeconds = (data.totalSeconds || 0) + elapsed;
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
                if (elapsed > 0 && elapsed < 86400) d.totalSeconds = (d.totalSeconds || 0) + elapsed;
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
            if (elapsed > 0 && elapsed < 86400) data.totalSeconds = (data.totalSeconds || 0) + elapsed;
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
        frame: false,
        resizable: false,
        show: false,
        backgroundColor: "#0d0d0d",
        icon: path.join(__dirname, "logo.ico"),
        webPreferences: {
            nodeIntegration: true,         // ОСТАВЛЯЕМ true для совместимости
            contextIsolation: false,       // ОСТАВЛЯЕМ false для совместимости
            enableRemoteModule: true
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
    mainWindow.webContents.on("did-finish-load", sendMaximizedState);
    
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
ipcMain.handle("close-launcher", () => {
    log("INFO", "Closing launcher");
    mainWindow?.close();
});

// Свернуть
ipcMain.handle("minimize-window", () => {
    log("INFO", "Minimizing window");
    mainWindow?.minimize();
});

// Развернуть
ipcMain.handle("maximize-window", () => {
    if (!mainWindow) return;
    log("INFO", mainWindow.isMaximized() ? "Unmaximizing window" : "Maximizing window");
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


ipcMain.handle('run-diagnostics', async () => {
    const checks = [];
    const basePath = getLauncherBasePath(process.platform, require('os').homedir(), process.env.APPDATA);

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

function registerSafePermissionHandler() {
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
        callback(false);
    });
}

// ========== Жизненный цикл ==========


app.whenReady().then(() => {
    log("INFO", "App ready [PLAYTIME-BUILD v3]");
    initPlaytimeOnStart();
    initDiscordRPC();
    registerSafePermissionHandler();
    createWindow();
    // Проверяем обновления через 3 сек после запуска (чтобы окно успело загрузиться)
    setTimeout(() => checkGitHubUpdate(), 3000);
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
