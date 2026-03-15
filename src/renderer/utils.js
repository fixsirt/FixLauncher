(function() {
'use strict';

/**
 * Утилиты рендерера — чистые функции без зависимостей от UI/DOM
 * @module renderer/utils
 *
 * Все Node.js-зависимости (path, https, http, crypto) убраны.
 * Сетевые запросы делаются через window.electronAPI.http.fetchJSON (IPC → main)
 * или через нативный window.fetch (для Modrinth/CDN).
 * Crypto — через window.electronAPI.crypto.offlineUUID (IPC → main).
 */

function renderMd(md) {
    if (!md) return '';
    let html = md
        .replace(/^### (.+)$/gm, '<h3>$1</h3>')
        .replace(/^## (.+)$/gm, '<h2>$1</h2>')
        .replace(/^# (.+)$/gm, '<h1>$1</h1>')
        .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,0.1);padding:1px 5px;border-radius:4px;font-size:0.9em;">$1</code>')
        .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
        .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
        .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" style="color:#60a5fa;text-decoration:underline;">$1</a>');
    // Оборачиваем подряд идущие <li> в <ul>
    html = html.replace(/(<li>[\s\S]*?<\/li>\n?)+/g, m => '<ul style="margin:6px 0 6px 16px;padding:0;">' + m + '</ul>');
    // Параграфы
    html = html.split(/\n{2,}/).map(p => {
        if (/^<[hul]/.test(p.trim())) return p;
        return '<p>' + p.replace(/\n/g, '<br>') + '</p>';
    }).join('');
    return html;
}

function escapeHtmlText(s) {
    if (!s) return '';
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
}

/**
 * Скачать файл через IPC (window.electronAPI.download.file).
 * Функция оставлена для обратной совместимости — предпочтительно использовать
 * window.electronAPI.download.file напрямую с обработчиком прогресса.
 */
function downloadFile(url, dest, onProgress) {
    const id = window.electronAPI.crypto.randomId();
    let unsub = null;
    if (onProgress) {
        unsub = window.electronAPI.on.downloadProgress(id, ({ received, total }) => {
            onProgress(received, total);
        });
    }
    return window.electronAPI.download.file(url, dest, id).finally(() => {
        if (unsub) unsub();
    });
}

/**
 * Получение JSON по URL.
 * Использует IPC-обработчик http:fetch-json в main-процессе,
 * чтобы не держать require('https') в renderer.
 */
async function fetchJSON(url) {
    const result = await window.electronAPI.http.fetchJSON(url);
    if (result && result.error) throw new Error(result.error);
    return result;
}

function escapeHtml(str) {
    if (str == null) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
}

/**
 * Генерация offline UUID.
 * Делегирует в main через IPC (crypto:offline-uuid), так как
 * require('crypto') недоступен в renderer при contextIsolation:true.
 */
async function generateOfflineUUID(username) {
    return window.electronAPI.crypto.offlineUUID(username);
}

function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// Dual export: window.* для renderer/браузера, module.exports для Node.js/main
const _RendererUtils = {
    renderMd,
    escapeHtmlText,
    escapeHtml,
    downloadFile,
    fetchJSON,
    generateOfflineUUID,
    generateUUID
};
if (typeof window !== 'undefined') { window.RendererUtils = _RendererUtils; }
if (typeof module !== 'undefined' && module.exports) { module.exports = _RendererUtils; }
})();
