const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const https = require("https");
const http = require("http");
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

// ========== Состояние ==========
let mainWindow = null;
const newsCache = { items: [], timestamp: 0 };

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

function getPlaytimePath() {
    try {
        // Читаем путь из файла настроек рядом с лаунчером (сохраняется renderer-ом через localStorage)
        // Fallback — дефолтный путь .fixlauncher
        const p = process.platform;
        let base;
        if (p === "win32") base = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), ".fixlauncher");
        else if (p === "darwin") base = path.join(os.homedir(), "Library", "Application Support", "vanilla-suns");
        else base = path.join(os.homedir(), ".fixlauncher");
        return path.join(base, "launcher-playtime.json");
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
        fs.appendFileSync(LOG_FILE, line);
    } catch (e) {}
}

// ========== Утилиты ==========

function getHttpLib(url) {
    return url.startsWith("https") ? https : http;
}

function findMessageBlockBounds(html, startIndex) {
    const openTag = /<div\s+[^>]*class="[^"]*tgme_widget_message(?!_text)[^"]*"[^>]*>/i;
    const match = html.slice(startIndex).match(openTag);
    if (!match) return null;

    const openStart = startIndex + match.index;
    const openEnd = openStart + match[0].length;
    let depth = 1;
    let i = openEnd;

    while (i < html.length && depth > 0) {
        const nextOpen = html.indexOf("<div", i);
        const nextClose = html.indexOf("</div>", i);
        if (nextClose === -1) break;

        if (nextOpen !== -1 && nextOpen < nextClose) {
            depth++;
            i = nextOpen + 4;
        } else {
            depth--;
            i = nextClose + 6;
            if (depth === 0) {
                return { start: openStart, end: i, content: html.slice(openEnd, i - 6) };
            }
        }
    }
    return null;
}

function stripHtmlToText(html) {
    if (!html) return "";
    return html
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>\s*<p[^>]*>/gi, "\n")
        .replace(/<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => href && inner ? `${inner.trim()} (${href})` : "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, " ")
        .trim();
}

function sanitizeHtmlForNews(html) {
    if (!html || typeof html !== "string") return "";
    return String(html)
        .replace(/<script\b[\s\S]*?<\/script>/gi, "")
        .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, "")
        .replace(/\s+on\w+=["'][^"']*["']/gi, "")
        .replace(/\bhref=["']javascript:[^"']*["']/gi, 'href="#"')
        .replace(/<a\s+([^>]*?)href=["']([^"']*)["']([^>]*)>/gi, (m, before, href, after) => {
            if (/^https?:\/\//i.test(href)) {
                return `<a ${before} href="${href.replace(/&/g, "&amp;")}" ${after} target="_blank" rel="noopener">`;
            }
            return "<span>";
        });
}

function parseTelegramDate(timeMatch) {
    if (!timeMatch) return { dateUnix: 0, dateStr: "" };
    const d = new Date(timeMatch[1]);
    return {
        dateUnix: Math.floor(d.getTime() / 1000),
        dateStr: d.toLocaleDateString("ru-RU", {
            day: "numeric",
            month: "long",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit"
        })
    };
}

function extractMessageContent(content) {
    let rawText = "";
    let rawHtml = "";

    const textDivMatch = content.match(/<div[^>]*class="[^"]*tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (textDivMatch) {
        rawHtml = textDivMatch[1];
        rawText = stripHtmlToText(rawHtml);
    }

    if (!rawText && !rawHtml) {
        const bubbleMatch = content.match(/<div[^>]*tgme_widget_message_bubble[^>]*>([\s\S]*?)<\/div>/i);
        if (bubbleMatch) {
            rawHtml = bubbleMatch[1];
            rawText = stripHtmlToText(rawHtml);
        }
    }

    if (!rawText && !rawHtml) {
        const anyTextRe = /<div[^>]*>([\s\S]{10,}?)<\/div>/gi;
        let m;
        while ((m = anyTextRe.exec(content)) !== null) {
            const t = stripHtmlToText(m[1]);
            if (t.length > 5 && !/^\d{1,2}\.\d{1,2}\.\d{2,4}/.test(t) && !/^https?:\/\//.test(t) && !/^\d{1,2}:\d{2}/.test(t)) {
                rawText = t;
                break;
            }
        }
    }

    const text = rawText || "";
    const firstLine = text.split("\n")[0] || text;
    const title = firstLine.trim().slice(0, 80) + (firstLine.length > 80 ? "…" : "");

    let contentHtml = "";
    let contentRestHtml = "";

    if (rawHtml) {
        const safeHtml = sanitizeHtmlForNews(rawHtml);
        const parts = safeHtml.split(/<br\s*\/?>/gi);
        contentHtml = safeHtml;
        contentRestHtml = parts.length > 1 ? parts.slice(1).join("<br>").trim() : "";
    } else {
        contentHtml = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>") || "—";
        const restText = text.includes("\n") ? text.split("\n").slice(1).join("\n").trim() : "";
        contentRestHtml = restText ? restText.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>") : "";
    }

    return { title, contentHtml, contentRestHtml };
}

function parseTelegramFeedHtml(html) {
    const items = [];
    try {
        let pos = 0;
        while (true) {
            const block = findMessageBlockBounds(html, pos);
            if (!block) break;
            pos = block.end;
            const content = block.content;

            const linkMatch = content.match(/href="https?:\/\/t\.me\/([^"/]+)\/(\d+)"/);
            const postId = linkMatch ? parseInt(linkMatch[2], 10) : 0;

            const timeMatch = content.match(/<time[^>]*datetime="([^"]+)"/);
            const { dateUnix, dateStr } = parseTelegramDate(timeMatch);

            const { title, contentHtml, contentRestHtml } = extractMessageContent(content);

            items.push({
                id: postId || dateUnix || items.length,
                date: dateStr,
                dateUnix,
                title: title || "Без заголовка",
                contentRestHtml,
                contentHtml: contentHtml || "—",
                photoFileId: null
            });
        }
    } catch (e) {
        log("ERROR", `Parse error: ${e.message}`);
    }
    return items;
}

function fetchChannelFeedFromWeb(username) {
    if (!username) return Promise.resolve([]);

    return new Promise((resolve) => {
        const url = `${TELEGRAM_URL}${username}`;
        const lib = getHttpLib(url);

        const req = lib.get(url, { timeout: REQUEST_TIMEOUT }, (res) => {
            let data = "";
            res.on("data", (chunk) => { data += chunk; });
            res.on("end", () => resolve(parseTelegramFeedHtml(data)));
        });

        req.on("error", (err) => {
            log("ERROR", `Telegram fetch error: ${err.message}`);
            resolve([]);
        });
        req.on("timeout", () => {
            req.destroy();
            log("WARN", "Telegram request timeout");
            resolve([]);
        });
    });
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

async function checkGitHubUpdate() {
    try {
        const currentVersion = app.getVersion();
        log('INFO', `Checking for updates. Current version: ${currentVersion}`);
        const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
        const rawData = await new Promise((resolve) => {
            const req = require('https').get(apiUrl, {
                headers: { 'User-Agent': 'FixLauncher-Updater' },
                timeout: 10000
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve(res.statusCode === 200 ? data : null));
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
        });
        if (!rawData) throw new Error('Empty response from GitHub API');
        const release = JSON.parse(rawData);
        const latestVersion = (release.tag_name || '').replace(/^v/, '');
        log('INFO', `Latest version on GitHub: ${latestVersion}`);

        function versionToInt(v) {
            return v.split('.').map(Number).reduce((a, b) => a * 1000 + b, 0);
        }

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
        log("INFO", `Parsed ${items.length} news items from NEWS.md`);
        return { ok: true, items, cached: false };
    } catch (err) {
        log("ERROR", `News fetch error: ${err.message}`);
        // Не обновляем newsCache.timestamp при ошибке — чтобы следующий запрос повторил попытку
        return {
            ok: newsCache.items.length > 0,
            error: err.message || "Ошибка загрузки",
            items: newsCache.items
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
ipcMain.handle("open-external", (event, url) => {
    shell.openExternal(url);
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

// ========== Жизненный цикл ==========

app.whenReady().then(() => {
    log("INFO", "App ready [PLAYTIME-BUILD v3]");
    initPlaytimeOnStart();
    initDiscordRPC();
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
        createWindow();
    }
});

app.on("quit", () => {
    log("INFO", "App quitting");
});
