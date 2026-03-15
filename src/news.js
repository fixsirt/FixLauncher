/**
 * Модуль работы с новостями из GitHub NEWS.md
 * @module news
 */

const https = require('https');
const { NEWS_MD_URL } = require('./renderer/constants');
const REQUEST_TIMEOUT = 7000;
const NEWS_LAST_N_POSTS = 10;

/**
 * Разбивает NEWS.md на отдельные посты.
 *
 * Формат файла:
 *   ## Заголовок (Дата)
 *   Тело поста...
 *   ^---$          ← строго: три дефиса на отдельной строке, ничего рядом
 *   ## Следующий...
 *
 * Разделитель ^---$ выбран намеренно: стандартный Markdown HR выглядит как
 * "---" с пустыми строками вокруг, а мы требуем ровно три дефиса БЕЗ
 * окружающего пробела — это практически невозможно случайно получить в тексте.
 */
/** @param {string} md @returns {{title:string, date:string, body:string}[]} Список постов из NEWS.md */
function parseNewsMd(md) {
    const blocks = String(md || '')
        .split(/^---$/m)          // строго три дефиса на отдельной строке
        .map(b => b.trim())
        .filter(Boolean);

    return blocks.map((block, index) => {
        const lines = block.split('\n');
        const first = (lines[0] || '').trim();
        const titleMatch = first.match(/^##\s+(.+?)(?:\s+\((.+?)\))?$/);

        const title = titleMatch
            ? titleMatch[1].trim()
            : first.replace(/^#+\s*/, '').trim() || `Новость #${index + 1}`;
        const date = titleMatch?.[2]?.trim() ?? '';
        const body = lines.slice(1).join('\n').trim();

        return { title, date, body };
    });
}

/** @param {string} [url] @returns {Promise<string|null>} Сырой текст NEWS.md или null при ошибке */
function fetchNewsMd (url = NEWS_MD_URL) {
    return new Promise((resolve) => {
        const req = https.get(url, { timeout: REQUEST_TIMEOUT }, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                resolve(null);
                return;
            }

            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve(data));
        });

        req.on('error', () => resolve(null));
        req.on('timeout', () => {
            req.destroy();
            resolve(null);
        });
    });
}

/** @returns {Promise<{ok:boolean, items:object[], error?:string}>} Новости для рендерера */
async function getNews () {
    try {
        const md = await fetchNewsMd();
        if (!md) throw new Error('Empty response from GitHub NEWS.md');

        return {
            ok: true,
            items: parseNewsMd(md).slice(0, NEWS_LAST_N_POSTS)
        };
    } catch (err) {
        return {
            ok: false,
            error: err.message || 'Ошибка загрузки новостей',
            items: []
        };
    }
}

module.exports = {
    getNews,
    fetchNewsMd,
    parseNewsMd,
    NEWS_MD_URL,
    NEWS_LAST_N_POSTS
};
