/**
 * Утилиты для лаунчера
 * @module utils
 */

/**
 * Декодирование HTML-сущностей и извлечение текста из HTML
 * @param {string} html
 * @returns {string}
 */
function stripHtmlToText (html) {
    return html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>\s*<p[^>]*>/gi, '\n')
        .replace(/<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => (href && inner ? `${inner.trim()} (${href})` : ''))
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Санитизация HTML из t.me/s: убираем опасное, сохраняем форматирование
 * @param {string} html
 * @returns {string}
 */
function sanitizeHtmlForNews (html) {
    if (!html || typeof html !== 'string') return '';
    return String(html)
        .replace(/<script\b[\s\S]*?<\/script>/gi, '')
        .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, '')
        .replace(/\s+on\w+=["'][^"']*["']/gi, '')
        .replace(/\bhref=["']javascript:[^"']*["']/gi, 'href="#"')
        .replace(/<a\s+([^>]*?)href=["']([^"']*)["']([^>]*)>/gi, (m, before, href, after) => {
            if (/^https?:\/\//i.test(href)) return `<a ${before} href="${href.replace(/&/g, '&amp;')}" ${after} target="_blank" rel="noopener">`;
            return '<span>';
        });
}

/**
 * Экранирование HTML текста
 * @param {string} s
 * @returns {string}
 */
function escapeHtmlText (s) {
    if (!s) return '';
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
}

/**
 * Форматирование размера байт в человекочитаемый формат
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes (bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Форматирование даты
 * @param {Date|string} date
 * @param {string} locale
 * @returns {string}
 */
function formatDate (date, locale = 'ru-RU') {
    const d = new Date(date);
    return d.toLocaleDateString(locale, {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

/**
 * Debounce функция
 * @param {Function} func
 * @param {number} wait
 * @returns {Function}
 */
function debounce (func, wait) {
    let timeout;
    return function executedFunction (...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

/**
 * Throttle функция
 * @param {Function} func
 * @param {number} limit
 * @returns {Function}
 */
function throttle (func, limit) {
    let inThrottle;
    return function (...args) {
        if (!inThrottle) {
            func.apply(this, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    };
}

/**
 * Проверка на пустой объект
 * @param {Object} obj
 * @returns {boolean}
 */
function isEmpty (obj) {
    return Object.keys(obj).length === 0;
}

/**
 * Глубокое копирование объекта
 * @param {Object} obj
 * @returns {Object}
 */
function deepClone (obj) {
    return JSON.parse(JSON.stringify(obj));
}

module.exports = {
    stripHtmlToText,
    sanitizeHtmlForNews,
    escapeHtmlText,
    formatBytes,
    formatDate,
    debounce,
    throttle,
    isEmpty,
    deepClone
};
