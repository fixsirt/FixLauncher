(function() {
'use strict';

/**
 * servers.js — Панель серверов FixLauncher
 * Пинг серверов, отображение MOTD/иконки/онлайна, добавление в servers.dat
 *
 * РЕФАКТОРИНГ:
 *   - Удалены require('net'), require('fs'), require('path') из renderer
 *   - pingServer()      → window.electronAPI.servers.ping()     (IPC: server:ping)
 *   - readServersDat()  → window.electronAPI.servers.readDat()  (IPC: server:read-dat)
 *   - addServerToFile() → window.electronAPI.servers.writeDat() (IPC: server:write-dat)
 *   - fetchAdServers()  → fetch() вместо require('https')
 *   - getMinecraftDir() → window.electronAPI.path.join()
 */

'use strict';

const { SERVERS_JSON_URL } = window.RendererConstants;

// ─── Fetch рекламных серверов (fetch вместо require('https')) ─────────────────

async function fetchAdServers() {
    // 1. Локальный файл через IPC
    try {
        const local = await window.electronAPI.servers.loadLocalServers();
        if (Array.isArray(local) && local.length > 0) return local;
    } catch { /* fallback to network */ }

    // 2. GitHub fallback через fetch()
    try {
        const ctrl = new AbortController();
        const tid  = setTimeout(() => ctrl.abort(), 8000);
        const res  = await fetch(SERVERS_JSON_URL, { signal: ctrl.signal });
        clearTimeout(tid);
        if (!res.ok) return [];
        const parsed = await res.json();
        return Array.isArray(parsed) && parsed.length > 0 ? parsed : [];
    } catch {
        return [];
    }
}

// ─── Директория Minecraft ─────────────────────────────────────────────────────

function getDefaultBasePath() {
    try {
        const p        = window.electronAPI.path;
        const platform = window.electronAPI.os.platform();
        const homedir  = window.electronAPI.os.homedir();
        const appdata  = window.electronAPI.env.APPDATA;
        if (platform === 'win32') return p.join(appdata || p.join(homedir, 'AppData', 'Roaming'), '.fixlauncher');
        if (platform === 'darwin') return p.join(homedir, 'Library', 'Application Support', 'fixlauncher');
        return p.join(homedir, '.fixlauncher');
    } catch { return null; }
}

function getMinecraftDir() {
    try {
        const basePath = localStorage.getItem('minecraft-path') || getDefaultBasePath();
        if (!basePath) return null;
        const versionHidden = document.getElementById('version-hidden-input');
        const versionType   = versionHidden ? versionHidden.value : '';
        let folderName;
        if (String(versionType).startsWith('instance:')) folderName = String(versionType).slice('instance:'.length);
        else folderName = 'minecraft-' + String(versionType).replace(/:/g, '-').replace(/[^a-zA-Z0-9.-]/g, '-');
        return window.electronAPI.path.join(basePath, folderName);
    } catch { return null; }
}

// ─── MOTD renderer (чистая функция, без Node.js) ──────────────────────────────

function motdToHtml(motd) {
    if (!motd) return '';
    if (typeof motd === 'object') return flattenMotd(motd);

    const colorMap = {
        '0':'#000000','1':'#0000AA','2':'#00AA00','3':'#00AAAA',
        '4':'#AA0000','5':'#AA00AA','6':'#FFAA00','7':'#AAAAAA',
        '8':'#555555','9':'#5555FF','a':'#55FF55','b':'#55FFFF',
        'c':'#FF5555','d':'#FF55FF','e':'#FFFF55','f':'#ffffff','g':'#DDD605',
    };
    let result = '', i = 0, openSpan = false;
    while (i < motd.length) {
        if ((motd[i] === '§' || motd[i] === '\u00A7') && i + 1 < motd.length) {
            const code = motd[i + 1].toLowerCase();
            if (openSpan) { result += '</span>'; openSpan = false; }
            if (colorMap[code])      { result += `<span style="color:${colorMap[code]}">`;  openSpan = true; }
            else if (code === 'l')   { result += '<span style="font-weight:bold">';          openSpan = true; }
            else if (code === 'o')   { result += '<span style="font-style:italic">';         openSpan = true; }
            else if (code === 'n')   { result += '<span style="text-decoration:underline">'; openSpan = true; }
            i += 2;
        } else if (motd[i] === '\n') {
            if (openSpan) { result += '</span>'; openSpan = false; }
            result += '<br>'; i++;
        } else {
            const c = motd[i];
            result += c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c;
            i++;
        }
    }
    if (openSpan) result += '</span>';
    return result;
}

function flattenMotd(obj) {
    if (!obj) return '';
    if (typeof obj === 'string') return motdToHtml(obj);
    const webColors = {
        black:'#000000',dark_blue:'#0000AA',dark_green:'#00AA00',dark_aqua:'#00AAAA',
        dark_red:'#AA0000',dark_purple:'#AA00AA',gold:'#FFAA00',gray:'#AAAAAA',
        dark_gray:'#555555',blue:'#5555FF',green:'#55FF55',aqua:'#55FFFF',
        red:'#FF5555',light_purple:'#FF55FF',yellow:'#FFFF55',white:'#ffffff',
    };
    let inner = '';
    if (obj.text)  inner += motdToHtml(obj.text);
    if (Array.isArray(obj.extra)) inner += obj.extra.map(flattenMotd).join('');
    const styles = [];
    if (obj.color)     styles.push(`color:${webColors[obj.color] || obj.color}`);
    if (obj.bold)      styles.push('font-weight:bold');
    if (obj.italic)    styles.push('font-style:italic');
    if (obj.underlined)styles.push('text-decoration:underline');
    return styles.length && inner
        ? `<span style="${styles.join(';')}">${inner}</span>`
        : inner;
}

function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── UI ───────────────────────────────────────────────────────────────────────

let serversInitialized = false;

let _pingIntervalId = null;

async function initServersPanel() {
    if (serversInitialized) { refreshUserServers(); loadAdServers(); return; }
    serversInitialized = true;

    const versionLabel = document.getElementById('version-selector-label');
    const badge = document.getElementById('servers-version-badge');
    if (badge && versionLabel) badge.textContent = versionLabel.textContent;

    loadAdServers();
    refreshUserServers();

    const refreshBtn = document.getElementById('servers-refresh-btn');
    if (refreshBtn) refreshBtn.addEventListener('click', () => { refreshUserServers(); loadAdServers(); });

    // Живой пинг — перепинговываем все видимые карточки каждые 30 сек
    if (_pingIntervalId) clearInterval(_pingIntervalId);
    _pingIntervalId = setInterval(() => {
        const panel = document.getElementById('servers-panel');
        if (!panel || panel.style.display === 'none') return;
        const cards = panel.querySelectorAll('.server-card[data-ip]');
        cards.forEach(card => {
            const ip = card.dataset.ip;
            if (ip) {
                const statusEl = card.querySelector('.server-card-status');
                if (statusEl) {
                    // Мягкий индикатор обновления
                    statusEl.style.opacity = '0.5';
                    statusEl.style.transition = 'opacity 0.3s';
                }
                pingAndUpdate(card, ip).then(() => {
                    if (statusEl) statusEl.style.opacity = '1';
                });
            }
        });
    }, 30000);
}

async function loadAdServers() {
    const list    = document.getElementById('servers-ad-list');
    const loading = document.getElementById('servers-ad-loading');
    if (!list) return;

    Array.from(list.querySelectorAll('.server-card')).forEach(c => c.remove());
    if (loading) loading.style.display = 'flex';

    const adServers = await fetchAdServers();
    if (loading) loading.style.display = 'none';

    if (adServers.length === 0) {
        const empty = document.createElement('div');
        empty.className  = 'servers-empty';
        empty.textContent = 'Нет рекомендуемых серверов или не удалось загрузить список.';
        list.appendChild(empty);
        return;
    }
    for (const srv of adServers) {
        const card = createServerCard(srv, true);
        list.appendChild(card);
        pingAndUpdate(card, srv.ip);
    }
}

async function refreshUserServers() {
    const list  = document.getElementById('servers-user-list');
    const empty = document.getElementById('servers-user-empty');
    if (!list) return;

    Array.from(list.querySelectorAll('.server-card')).forEach(c => c.remove());

    const mcDir = getMinecraftDir();
    if (!mcDir) {
        if (empty) { empty.style.display = 'block'; empty.textContent = 'Укажите папку игры в Настройках.'; }
        return;
    }

    // IPC вместо fs.readFileSync
    const servers = await window.electronAPI.servers.readDat(mcDir);
    if (servers === null) {
        if (empty) { empty.style.display = 'block'; empty.textContent = 'Файл серверов не найден. Запустите игру хотя бы один раз.'; }
        return;
    }
    if (servers.length === 0) {
        if (empty) { empty.style.display = 'block'; empty.textContent = 'Список серверов пуст.'; }
        return;
    }

    if (empty) empty.style.display = 'none';
    for (const srv of servers) {
        const card = createServerCard(srv, false);
        list.appendChild(card);
        pingAndUpdate(card, srv.ip);
    }
}

function createServerCard(srv, isAd) {
    const card = document.createElement('div');
    card.className  = 'server-card' + (isAd ? ' server-card-ad' : '');
    card.dataset.ip = srv.ip;
    const [host, portStr] = srv.ip.split(':');
    const port = portStr ? parseInt(portStr) : 25565;
    card.innerHTML = `
        <div class="server-card-icon-wrap">
            <img class="server-card-icon" src="" alt="" style="display:none">
            <div class="server-card-icon-placeholder">🖥️</div>
        </div>
        <div class="server-card-info">
            <div class="server-card-name">${escHtml(srv.name || srv.ip)}${isAd ? '<span class="server-ad-badge">реклама</span>' : ''}</div>
            <div class="server-card-motd">Подключение...</div>
            <div class="server-card-meta">
                <span class="server-card-ip">🌐 ${escHtml(srv.ip)}</span>
                <span class="server-card-status server-status-loading">⏳ Пинг...</span>
            </div>
        </div>
        ${isAd ? `<button class="server-add-btn" data-host="${escHtml(host)}" data-port="${port}" data-name="${escHtml(srv.name || srv.ip)}" data-ip="${escHtml(srv.ip)}">
            <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14"><path fill-rule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clip-rule="evenodd"/></svg>
            Добавить
        </button>` : ''}
    `;
    if (isAd) {
        const btn = card.querySelector('.server-add-btn');
        btn.addEventListener('click', () => addAdServer(srv.name || srv.ip, srv.ip, btn));
    }
    return card;
}

async function addAdServer(name, ip, btn) {
    const mcDir = getMinecraftDir();
    if (!mcDir) { alert('Укажите папку игры в Настройках.'); return; }
    try {
        // IPC вместо fs.writeFileSync
        const result = await window.electronAPI.servers.writeDat(mcDir, name, ip);
        if (!result.ok) throw new Error(result.error || 'write failed');
        btn.textContent = '✓ Добавлен';
        btn.disabled = true;
        btn.classList.add('server-add-btn-done');
        refreshUserServers();
    } catch(e) {
        alert('Ошибка записи: ' + e.message);
    }
}

async function pingAndUpdate(card, ipStr) {
    const [host, portStr] = ipStr.split(':');
    const port = portStr ? parseInt(portStr) : 25565;

    // IPC вместо прямого new net.Socket()
    const result = await window.electronAPI.servers.ping(host, port, 6000);

    const statusEl      = card.querySelector('.server-card-status');
    const motdEl        = card.querySelector('.server-card-motd');
    const iconEl        = card.querySelector('.server-card-icon');
    const placeholderEl = card.querySelector('.server-card-icon-placeholder');

    if (result.online) {
        statusEl.className = 'server-card-status server-status-online';
        statusEl.innerHTML = `<span class="srv-dot srv-dot-online"></span>${result.players.online}/${result.players.max} · <span class="srv-ping">${result.latency || '?'}ms</span>`;
        motdEl.innerHTML   = motdToHtml(result.motd);
        if (result.favicon?.startsWith('data:image')) {
            iconEl.src = result.favicon;
            iconEl.style.display = 'block';
            if (placeholderEl) placeholderEl.style.display = 'none';
        }
    } else {
        statusEl.className   = 'server-card-status server-status-offline';
        statusEl.innerHTML   = '<span class="srv-dot srv-dot-offline"></span>Недоступен';
        statusEl.textContent = '🔴 Недоступен';
        motdEl.textContent   = 'Сервер не отвечает';
    }
}

// Dual export: window.* для renderer, module.exports для Node.js/main
const _ServersModule = { initServersPanel };
if (typeof window !== 'undefined') { window.ServersModule = _ServersModule; }
if (typeof module !== 'undefined' && module.exports) { module.exports = _ServersModule; }
})();
