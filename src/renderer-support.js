function formatDiagnosticsReport (diagnostics) {
    if (!diagnostics || typeof diagnostics !== 'object') return 'Диагностика недоступна';

    const checks = Array.isArray(diagnostics.checks) ? diagnostics.checks : [];
    const lines = checks.map((item) => {
        const icon = item.ok ? '✅' : '❌';
        return `${icon} ${item.name}: ${item.details || ''}`.trim();
    });

    return [
        `Launcher diagnostics (${new Date().toISOString()})`,
        `Platform: ${diagnostics.platform || 'unknown'}`,
        ...lines
    ].join('\n');
}

module.exports = {
    formatDiagnosticsReport
};
