/**
 * servers.js — Панель серверов Vanilla Suns
 * Пинг серверов, отображение MOTD/иконки/онлайна, добавление в servers.dat
 */

'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');

// ─── NBT / servers.dat helpers ───────────────────────────────────────────────

/**
 * Читаем servers.dat (uncompressed NBT).
 * Возвращаем массив { name, ip } или [].
 */
function readServersDat(mcDir) {
    const file = path.join(mcDir, 'servers.dat');
    if (!fs.existsSync(file)) return null; // null = файл не существует
    try {
        const buf = fs.readFileSync(file);
        return parseServersDat(buf);
    } catch (e) {
        console.error('servers.dat read error:', e);
        return [];
    }
}

/**
 * Минимальный парсер NBT для servers.dat.
 * servers.dat: TAG_Compound → TAG_List "servers" → TAG_Compound[] {name, ip, ...}
 */
function parseServersDat(buf) {
    let pos = 0;

    function readByte() { return buf[pos++]; }
    function readShort() { const v = buf.readInt16BE(pos); pos += 2; return v; }
    function readInt()   { const v = buf.readInt32BE(pos); pos += 4; return v; }
    function readLong()  { pos += 8; }
    function readFloat() { pos += 4; }
    function readDouble(){ pos += 8; }
    function readString() {
        const len = buf.readUInt16BE(pos); pos += 2;
        const str = buf.slice(pos, pos + len).toString('utf8');
        pos += len;
        return str;
    }

    function readPayload(type) {
        switch(type) {
            case 1:  return readByte();
            case 2:  return readShort();
            case 3:  return readInt();
            case 4:  readLong(); return null;
            case 5:  readFloat(); return null;
            case 6:  readDouble(); return null;
            case 7:  { const len = readInt(); pos += len; return null; }
            case 8:  return readString();
            case 9:  {
                const lt = readByte(); const sz = readInt();
                const arr = [];
                for(let i=0;i<sz;i++) arr.push(readPayload(lt));
                return arr;
            }
            case 10: return readCompound();
            case 11: { const len = readInt(); pos += len*4; return null; }
            case 12: { const len = readInt(); pos += len*8; return null; }
            default: return null;
        }
    }

    function readCompound() {
        const obj = {};
        for (;;) {
            const type = readByte();
            if(type === 0) break; // TAG_End
            const name = readString();
            obj[name] = readPayload(type);
        }
        return obj;
    }

    try {
        const rootType = readByte();
        if(rootType !== 10) return [];
        readString(); // root name
        const root = readCompound();
        const list = root['servers'];
        if(!Array.isArray(list)) return [];
        return list
            .filter(e => e && typeof e === 'object')
            .map(e => ({ name: String(e.name || ''), ip: String(e.ip || '') }))
            .filter(e => e.ip);
    } catch(e) {
        console.error('NBT parse error:', e.message);
        return [];
    }
}

/**
 * Записываем NBT servers.dat с новым сервером в начале списка.
 */
function addServerToFile(mcDir, serverName, serverIp) {
    const file = path.join(mcDir, 'servers.dat');
    const existing = readServersDat(mcDir) || [];

    // Убираем дубликат если уже есть
    const filtered = existing.filter(s => s.ip !== serverIp);
    const list = [{ name: serverName, ip: serverIp }, ...filtered];

    const buf = buildServersDat(list);
    fs.mkdirSync(mcDir, { recursive: true });
    fs.writeFileSync(file, buf);
}

function writeNBTString(buf, offset, str) {
    const bytes = Buffer.from(str, 'utf8');
    buf.writeUInt16BE(bytes.length, offset);
    bytes.copy(buf, offset + 2);
    return offset + 2 + bytes.length;
}

function buildServersDat(servers) {
    // We'll use dynamic buffer building
    const parts = [];

    function byte(v)   { const b = Buffer.alloc(1); b[0] = v; parts.push(b); }
    function short(v)  { const b = Buffer.alloc(2); b.writeInt16BE(v); parts.push(b); }
    function int(v)    { const b = Buffer.alloc(4); b.writeInt32BE(v); parts.push(b); }
    function string(s) {
        const sb = Buffer.from(s, 'utf8');
        const lb = Buffer.alloc(2); lb.writeUInt16BE(sb.length);
        parts.push(lb, sb);
    }
    function tagString(name, value) {
        byte(8); string(name); string(value);
    }
    function tagByte(name, value) {
        byte(1); string(name); byte(value);
    }

    // Root TAG_Compound
    byte(10); string(''); // type + name

    // TAG_List "servers" of TAG_Compound
    byte(9); string('servers');
    byte(10); // list element type = compound
    int(servers.length);

    for(const srv of servers) {
        tagString('ip', srv.ip || '');
        tagString('name', srv.name || srv.ip || '');
        tagByte('acceptTextures', 0);
        byte(0); // TAG_End of compound
    }

    byte(0); // TAG_End of root compound

    return Buffer.concat(parts);
}

// ─── Minecraft server ping (1.7+ protocol) ───────────────────────────────────

function pingServer(host, port, timeout) {
    port = port || 25565;
    timeout = timeout || 5000;

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

        socket.connect(port, host, () => {
            // Handshake packet
            const hostBuf = Buffer.from(host, 'utf8');
            // VarInt helpers
            function varInt(v) {
                const arr = [];
                do { let b = v & 0x7F; v >>>= 7; if(v !== 0) b |= 0x80; arr.push(b); } while(v !== 0);
                return Buffer.from(arr);
            }
            function str16(s) {
                const b = Buffer.from(s, 'utf8');
                return Buffer.concat([varInt(b.length), b]);
            }

            // Handshake: packetID=0x00, protocol=-1, host, port, state=1
            const handshake = Buffer.concat([
                varInt(0x00),
                varInt(0x2F), // protocol version (any, -1 for status)
                str16(host),
                Buffer.from([port >> 8, port & 0xFF]),
                varInt(1) // next state = status
            ]);
            const hLen = varInt(handshake.length);
            socket.write(Buffer.concat([hLen, handshake]));

            // Status request: len=1, id=0x00
            socket.write(Buffer.from([0x01, 0x00]));

            // Ping packet
            const pingData = Buffer.from([0x09, 0x01, 0, 0, 0, 0, 0, 0, 0, 0]);
            socket.write(pingData);
        });

        socket.on('data', (chunk) => {
            buf = Buffer.concat([buf, chunk]);
            try {
                // Read VarInt length
                let vi = 0, shift = 0, p = 0;
                for (;;) {
                    if(p >= buf.length) return;
                    const b = buf[p++]; vi |= (b & 0x7F) << shift; shift += 7;
                    if(!(b & 0x80)) break;
                }
                if(buf.length < p + vi) return; // not enough data yet

                // Read packet ID
                let id = 0, s2 = 0, p2 = p;
                for (;;) {
                    const b = buf[p2++]; id |= (b & 0x7F) << s2; s2 += 7;
                    if(!(b & 0x80)) break;
                }
                if(id !== 0x00) return;

                // Read JSON string length (VarInt)
                let jsonLen = 0, s3 = 0;
                for (;;) {
                    const b = buf[p2++]; jsonLen |= (b & 0x7F) << s3; s3 += 7;
                    if(!(b & 0x80)) break;
                }
                if(buf.length < p2 + jsonLen) return;

                const json = buf.slice(p2, p2 + jsonLen).toString('utf8');
                const data = JSON.parse(json);

                clearTimeout(timer);
                done({
                    online: true,
                    version: data.version ? data.version.name : '?',
                    protocol: data.version ? data.version.protocol : 0,
                    players: data.players ? { online: data.players.online, max: data.players.max } : { online: 0, max: 0 },
                    motd: data.description,
                    favicon: data.favicon || null
                });
            } catch(e) { /* wait for more data */ }
        });

        socket.on('error', (e) => { clearTimeout(timer); done({ online: false, error: e.message }); });
        socket.on('close', () => { clearTimeout(timer); done({ online: false, error: 'closed' }); });
    });
}

// ─── MOTD renderer ───────────────────────────────────────────────────────────

function motdToHtml(motd) {
    if (!motd) return '';

    // Объектный MOTD (JSON chat component)
    if (typeof motd === 'object') {
        return flattenMotd(motd);
    }

    // Строковый MOTD — парсим §-коды
    const text = String(motd);
    const colorMap = {
        '0':'#000000','1':'#0000AA','2':'#00AA00','3':'#00AAAA',
        '4':'#AA0000','5':'#AA00AA','6':'#FFAA00','7':'#AAAAAA',
        '8':'#555555','9':'#5555FF','a':'#55FF55','b':'#55FFFF',
        'c':'#FF5555','d':'#FF55FF','e':'#FFFF55','f':'#ffffff',
        'g':'#DDD605'
    };
    let result = '';
    let i = 0;
    let openSpan = false;
    while(i < text.length) {
        if((text[i] === '§' || text[i] === '\u00A7') && i+1 < text.length) {
            const code = text[i+1].toLowerCase();
            if(openSpan) { result += '</span>'; openSpan = false; }
            if(colorMap[code]) {
                result += `<span style="color:${colorMap[code]}">`;
                openSpan = true;
            } else if(code === 'l') {
                result += '<span style="font-weight:bold">'; openSpan = true;
            } else if(code === 'o') {
                result += '<span style="font-style:italic">'; openSpan = true;
            } else if(code === 'n') {
                result += '<span style="text-decoration:underline">'; openSpan = true;
            }
            // r, m, k — reset/obfuscated, просто закрываем
            i += 2;
        } else if(text[i] === '\n') {
            if(openSpan) { result += '</span>'; openSpan = false; }
            result += '<br>';
            i++;
        } else {
            const c = text[i];
            result += c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c;
            i++;
        }
    }
    if(openSpan) result += '</span>';
    return result;
}

function flattenMotd(obj) {
    if(!obj) return '';
    if(typeof obj === 'string') {
        // Строка внутри объекта тоже может содержать §-коды
        return motdToHtml(obj);
    }

    const webColors = {
        black:'#000000',dark_blue:'#0000AA',dark_green:'#00AA00',dark_aqua:'#00AAAA',
        dark_red:'#AA0000',dark_purple:'#AA00AA',gold:'#FFAA00',gray:'#AAAAAA',
        dark_gray:'#555555',blue:'#5555FF',green:'#55FF55',aqua:'#55FFFF',
        red:'#FF5555',light_purple:'#FF55FF',yellow:'#FFFF55',white:'#ffffff'
    };

    // Текст узла
    let inner = '';
    if(obj.text) {
        inner += motdToHtml(obj.text);
    }
    // Рекурсивно добавляем extra
    if(obj.extra && Array.isArray(obj.extra)) {
        inner += obj.extra.map(flattenMotd).join('');
    }

    // Оборачиваем в span если есть стили
    const styles = [];
    if(obj.color) {
        const c = webColors[obj.color] || obj.color;
        styles.push(`color:${c}`);
    }
    if(obj.bold) styles.push('font-weight:bold');
    if(obj.italic) styles.push('font-style:italic');
    if(obj.underlined) styles.push('text-decoration:underline');

    if(styles.length > 0 && inner) {
        return `<span style="${styles.join(';')}">${inner}</span>`;
    }
    return inner;
}

// ─── Fetch ad servers from GitHub raw JSON ───────────────────────────────────

async function fetchAdServers() {
    const url = 'https://raw.githubusercontent.com/fixsirt/FixLauncher/main/servers.json';
    return new Promise((resolve) => {
        const https = require('https');
        const req = https.get(url, { timeout: 8000 }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch(e) { resolve([]); }
            });
        });
        req.on('error', () => resolve([]));
        req.on('timeout', () => { req.destroy(); resolve([]); });
    });
}

// ─── Main init ───────────────────────────────────────────────────────────────

let serversInitialized = false;

async function initServersPanel() {
    if (serversInitialized) {
        refreshUserServers();
        loadAdServers();
        return;
    }
    serversInitialized = true;

    // Sync version badge
    const versionLabel = document.getElementById('version-selector-label');
    const badge = document.getElementById('servers-version-badge');
    if(badge && versionLabel) badge.textContent = versionLabel.textContent;

    // Load ad servers
    loadAdServers();

    // Load user servers
    refreshUserServers();

    // Refresh button
    const refreshBtn = document.getElementById('servers-refresh-btn');
    if(refreshBtn) refreshBtn.addEventListener('click', () => {
        refreshUserServers();
        loadAdServers();
    });
}

async function loadAdServers() {
    const list = document.getElementById('servers-ad-list');
    const loading = document.getElementById('servers-ad-loading');
    if(!list) return;

    // Очищаем старые карточки перед загрузкой
    Array.from(list.querySelectorAll('.server-card')).forEach(c => c.remove());

    if(loading) loading.style.display = 'flex';

    const adServers = await fetchAdServers();

    if(loading) loading.style.display = 'none';

    if(adServers.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'servers-empty';
        empty.textContent = 'Нет рекомендуемых серверов или не удалось загрузить список.';
        list.appendChild(empty);
        return;
    }

    for(const srv of adServers) {
        const card = createServerCard(srv, true);
        list.appendChild(card);
        pingAndUpdate(card, srv.ip);
    }
}

async function refreshUserServers() {
    const list = document.getElementById('servers-user-list');
    const empty = document.getElementById('servers-user-empty');
    if(!list) return;

    // Clear old cards (keep empty placeholder)
    Array.from(list.querySelectorAll('.server-card')).forEach(c => c.remove());

    const mcDir = getMinecraftDir();
    if(!mcDir) {
        if(empty) { empty.style.display = 'block'; empty.textContent = 'Укажите папку игры в Настройках.'; }
        return;
    }

    const servers = readServersDat(mcDir);
    if(servers === null) {
        if(empty) { empty.style.display = 'block'; empty.textContent = 'Файл серверов не найден. Запустите игру хотя бы один раз.'; }
        return;
    }
    if(servers.length === 0) {
        if(empty) { empty.style.display = 'block'; empty.textContent = 'Список серверов пуст.'; }
        return;
    }

    if(empty) empty.style.display = 'none';

    for(const srv of servers) {
        const card = createServerCard(srv, false);
        list.appendChild(card);
        pingAndUpdate(card, srv.ip);
    }
}

function getMinecraftDir() {
    try {
        const basePath = localStorage.getItem('minecraft-path');
        if(!basePath) return null;
        // Determine subfolder from selected version
        const versionHidden = document.getElementById('version-hidden-input');
        const versionType = versionHidden ? versionHidden.value : 'evacuation';
        let folderName;
        if(versionType === 'evacuation') {
            folderName = 'minecraft-survival';
        } else {
            folderName = 'minecraft-' + String(versionType).replace(/:/g,'-').replace(/[^a-zA-Z0-9.-]/g,'-');
        }
        return require('path').join(basePath, folderName);
    } catch(e) { return null; }
}

function createServerCard(srv, isAd) {
    const card = document.createElement('div');
    card.className = 'server-card' + (isAd ? ' server-card-ad' : '');
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

    if(isAd) {
        const btn = card.querySelector('.server-add-btn');
        btn.addEventListener('click', () => addAdServer(srv.name || srv.ip, srv.ip, btn));
    }

    return card;
}

function addAdServer(name, ip, btn) {
    const mcDir = getMinecraftDir();
    if(!mcDir) {
        alert('Укажите папку игры в Настройках.');
        return;
    }
    try {
        addServerToFile(mcDir, name, ip);
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

    const result = await pingServer(host, port, 6000);

    const statusEl = card.querySelector('.server-card-status');
    const motdEl = card.querySelector('.server-card-motd');
    const iconEl = card.querySelector('.server-card-icon');
    const placeholderEl = card.querySelector('.server-card-icon-placeholder');

    if(result.online) {
        statusEl.className = 'server-card-status server-status-online';
        statusEl.innerHTML = `🟢 ${result.players.online}/${result.players.max} · ${result.version}`;
        motdEl.innerHTML = motdToHtml(result.motd);
        if(result.favicon && result.favicon.startsWith('data:image')) {
            iconEl.src = result.favicon;
            iconEl.style.display = 'block';
            if(placeholderEl) placeholderEl.style.display = 'none';
        }
    } else {
        statusEl.className = 'server-card-status server-status-offline';
        statusEl.textContent = '🔴 Недоступен';
        motdEl.textContent = 'Сервер не отвечает';
    }
}

function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

module.exports = { initServersPanel };
