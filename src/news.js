/**
 * Модуль работы с новостями из GitHub NEWS.md
 * @module news
 */

const https = require('https');

const NEWS_MD_URL = 'https://raw.githubusercontent.com/fixsirt/FixLauncher/main/NEWS.md';
const REQUEST_TIMEOUT = 7000;
const NEWS_LAST_N_POSTS = 10;

function parseNewsMd (md) {
    const blocks = String(md || '')
        .split(/\n---+\n/)
        .map((block) => block.trim())
        .filter(Boolean);

    return blocks.map((block, index) => {
        const lines = block.split('\n');
        const first = (lines[0] || '').trim();
        const titleMatch = first.match(/^##\s+(.+?)(?:\s+\((.+?)\))?$/);

        const title = titleMatch ? titleMatch[1].trim() : first.replace(/^#+\s*/, '').trim() || `Новость #${index + 1}`;
        const date = titleMatch && titleMatch[2] ? titleMatch[2].trim() : '';
        const body = lines.slice(1).join('\n').trim();

        return { title, date, body };
    });
}

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
