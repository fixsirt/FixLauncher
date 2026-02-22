/**
 * Модуль работы с новостями из Telegram
 * @module news
 */

const https = require('https');
const http = require('http');
const { stripHtmlToText, sanitizeHtmlForNews, formatDate } = require('./utils');

const NEWS_CHANNEL_USERNAME = 'rodya61_prod';
const NEWS_LAST_N_POSTS = 5;

/**
 * Найти границы полного блока <div class="...tgme_widget_message...">
 * @param {string} html
 * @param {number} startIndex
 * @returns {Object|null}
 */
function findMessageBlockBounds (html, startIndex) {
    const openTag = /<div\s+[^>]*class="[^"]*tgme_widget_message(?!_text)[^"]*"[^>]*>/i;
    const match = html.slice(startIndex).match(openTag);
    if (!match) return null;

    const openStart = startIndex + match.index;
    const openEnd = openStart + match[0].length;
    let depth = 1;
    let i = openEnd;

    while (i < html.length && depth > 0) {
        const nextOpen = html.indexOf('<div', i);
        const nextClose = html.indexOf('</div>', i);
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

/**
 * Парсинг HTML ленты t.me/s
 * @param {string} html
 * @param {string} channelUsername
 * @returns {Array}
 */
function parseTelegramFeedHtml (html, channelUsername) {
    const items = [];

    try {
        let pos = 0;
        for (;;) {
            const block = findMessageBlockBounds(html, pos);
            if (!block) break;
            pos = block.end;
            const content = block.content;

            // Ссылка на пост: t.me/channel/123
            const linkMatch = content.match(/href="https?:\/\/t\.me\/([^"/]+)\/(\d+)"/);
            const postId = linkMatch ? parseInt(linkMatch[2], 10) : 0;

            // Время: <time datetime="...">
            const timeMatch = content.match(/<time[^>]*datetime="([^"]+)"/);
            let dateUnix = 0;
            let dateStr = '';

            if (timeMatch) {
                const d = new Date(timeMatch[1]);
                dateUnix = Math.floor(d.getTime() / 1000);
                dateStr = formatDate(d);
            }

            // Текст: ищем div с tgme_widget_message_text
            let rawText = '';
            let rawHtml = '';
            const textDivRe = /<div[^>]*class="[^"]*tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i;
            const textDivMatch = content.match(textDivRe);

            if (textDivMatch) {
                rawHtml = textDivMatch[1];
                rawText = stripHtmlToText(rawHtml);
            }

            if (!rawText && !rawHtml) {
                const bubbleRe = /<div[^>]*tgme_widget_message_bubble[^>]*>([\s\S]*?)<\/div>/i;
                const bubbleMatch = content.match(bubbleRe);
                if (bubbleMatch) {
                    rawHtml = bubbleMatch[1];
                    rawText = stripHtmlToText(rawHtml);
                }
            }

            const firstLine = rawText.split('\n')[0] || rawText;
            const title = firstLine.trim().slice(0, 80) + (firstLine.length > 80 ? '…' : '');

            let contentHtml = '';
            let contentRestHtml = '';

            if (rawHtml) {
                const safeHtml = sanitizeHtmlForNews(rawHtml);
                const parts = safeHtml.split(/<br\s*\/?>/gi);
                const firstPart = (parts[0] || '').trim();
                contentHtml = safeHtml;
                contentRestHtml = parts.length > 1 ? parts.slice(1).join('<br>').trim() : '';
            } else {
                contentHtml = rawText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>') || '—';
                const restText = rawText.includes('\n') ? rawText.split('\n').slice(1).join('\n').trim() : '';
                contentRestHtml = restText ? restText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>') : '';
            }

            items.push({
                id: postId || dateUnix || items.length,
                date: dateStr,
                dateUnix,
                title: title || 'Без заголовка',
                contentRestHtml,
                contentHtml: contentHtml || '—',
                photoFileId: null
            });
        }
    } catch (e) {
        console.error('Error parsing Telegram feed:', e);
    }

    return items;
}

/**
 * Загрузка постов с публичной страницы t.me/s
 * @param {string} username
 * @returns {Promise<Array>}
 */
function fetchChannelFeedFromWeb (username) {
    if (!username) return Promise.resolve([]);

    return new Promise((resolve) => {
        const url = `https://t.me/s/${username}`;
        const lib = url.startsWith('https') ? https : http;

        const req = lib.get(url, { timeout: 10000 }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                const items = parseTelegramFeedHtml(data, username);
                resolve(items);
            });
        });

        req.on('error', () => resolve([]));
        req.on('timeout', () => { req.destroy(); resolve([]); });
    });
}

/**
 * Получить новости из Telegram
 * @returns {Promise<Object>}
 */
async function getNews () {
    try {
        const webItems = await fetchChannelFeedFromWeb(NEWS_CHANNEL_USERNAME);
        webItems.sort((a, b) => (b.dateUnix || 0) - (a.dateUnix || 0));
        const items = webItems.slice(0, NEWS_LAST_N_POSTS);
        return { ok: true, items };
    } catch (err) {
        return { ok: false, error: err.message || 'Ошибка загрузки', items: [] };
    }
}

module.exports = {
    getNews,
    parseTelegramFeedHtml,
    fetchChannelFeedFromWeb,
    NEWS_CHANNEL_USERNAME,
    NEWS_LAST_N_POSTS
};
