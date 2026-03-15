(function() {
'use strict';

function formatDiagnosticsReport (diagnostics) {
    if (!diagnostics || typeof diagnostics !== 'object') return 'Диагностика недоступна';

    const checks = Array.isArray(diagnostics.checks) ? diagnostics.checks : [];

    const platformNames = {
        win32: 'Windows',
        darwin: 'macOS',
        linux: 'Linux'
    };
    const platform = platformNames[diagnostics.platform] || diagnostics.platform || 'Неизвестно';

    const now = new Date();
    const dateStr = now.toLocaleString('ru-RU', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });

    const lines = checks.map((item) => {
        const icon = item.ok ? '✅' : '❌';
        return `${icon} ${item.name}: ${item.details || ''}`.trim();
    });

    return [
        `Отчёт диагностики (${dateStr})`,
        `Платформа: ${platform}`,
        '',
        ...lines
    ].join('\n');
}

// Dual export: window.* для renderer/браузера, module.exports для Node.js/main
const _RendererSupport = {
    formatDiagnosticsReport
};
if (typeof window !== 'undefined') { window.RendererSupport = _RendererSupport; }
if (typeof module !== 'undefined' && module.exports) { module.exports = _RendererSupport; }
})();
