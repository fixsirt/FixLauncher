(function() {
'use strict';

/**
 * Логирование рендерера — дублирует вывод в debug.log через main process
 * Использование:
 *   const log = require('./log');
 *   log.info('Версия загружена');
 *   log.warn('Нет соединения');
 *   log.error('Критическая ошибка', err);
 * @module renderer/log
 */

function send(level, ...args) {
    const message = args
        .map(a => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === 'object' ? JSON.stringify(a) : String(a)))
        .join(' ');

    // Всегда выводим в DevTools
    const consoleMethod = { INFO: 'log', WARN: 'warn', ERROR: 'error', DEBUG: 'log' }[level] || 'log';
    console[consoleMethod](`[${level}]`, message);

    // И параллельно — в debug.log через main (через window.electronAPI)
    window.electronAPI?.log(message, level).catch(() => {/* main недоступен при тестах */});
}

const log = {
    info:  (...args) => send('INFO',  ...args),
    warn:  (...args) => send('WARN',  ...args),
    error: (...args) => send('ERROR', ...args),
    debug: (...args) => send('DEBUG', ...args),
};

// Dual export: window.* для renderer, module.exports для Node.js/main
const _RendererLog = { log };
if (typeof window !== 'undefined') { window.RendererLog = _RendererLog; }
if (typeof module !== 'undefined' && module.exports) { module.exports = _RendererLog; }
})();
