function getProfilePreset (profileId) {
    const presets = {
        lowend: {
            id: 'lowend',
            name: 'Low-end',
            ram: '2',
            jvmFlags: ['serial-gc', 'tiered']
        },
        pvp: {
            id: 'pvp',
            name: 'PvP',
            ram: '4',
            jvmFlags: ['g1gc', 'compile-threshold']
        },
        shaders: {
            id: 'shaders',
            name: 'Shaders',
            ram: '8',
            jvmFlags: ['g1gc', 'string-dedup', 'large-pages']
        },
        stream: {
            id: 'stream',
            name: 'Stream',
            ram: '6',
            jvmFlags: ['g1gc', 'disable-explicit-gc']
        }
    };

    return presets[profileId] || presets.pvp;
}

function detectModConflicts (fileNames) {
    const names = (fileNames || []).map((n) => String(n).toLowerCase());
    const conflicts = [];

    const pairs = [
        ['optifine', 'iris'],
        ['sodium', 'optifine'],
        ['rubidium', 'sodium'],
        ['forge', 'fabric']
    ];

    pairs.forEach(([a, b]) => {
        const hasA = names.some((n) => n.includes(a));
        const hasB = names.some((n) => n.includes(b));
        if (hasA && hasB) conflicts.push(`${a} ↔ ${b}`);
    });

    return conflicts;
}

function analyzeCrashText (text) {
    const src = String(text || '').toLowerCase();

    if (!src) return 'Краш-лог пустой или не найден.';
    if (src.includes('outofmemoryerror') || src.includes('java heap space')) {
        return 'Похоже, не хватает RAM. Увеличьте RAM в настройках лаунчера.';
    }
    if (src.includes('nosuchmethoderror') || src.includes('classnotfoundexception')) {
        return 'Похоже на конфликт/неверную версию мода. Проверьте совместимость модов.';
    }
    if (src.includes('exception') && src.includes('fabric')) {
        return 'Ошибка связана с Fabric-модами. Попробуйте временно отключить последние моды.';
    }

    return 'Точная причина не определена автоматически. Экспортируйте лог и отправьте в поддержку.';
}

module.exports = {
    getProfilePreset,
    detectModConflicts,
    analyzeCrashText
};
