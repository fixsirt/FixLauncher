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
<<<<<<< HEAD
    const originals = (fileNames || []).map((n) => String(n));
    const names = originals.map((n) => n.toLowerCase());
=======
    const names = (fileNames || []).map((n) => String(n).toLowerCase());
>>>>>>> f7d31353fa62e5c18778e8d4edb7c4d62bee9f02
    const conflicts = [];

    const pairs = [
        ['optifine', 'iris'],
        ['sodium', 'optifine'],
        ['rubidium', 'sodium'],
        ['forge', 'fabric']
    ];

    pairs.forEach(([a, b]) => {
<<<<<<< HEAD
        const idxA = names.findIndex((n) => n.includes(a));
        const idxB = names.findIndex((n) => n.includes(b));
        if (idxA !== -1 && idxB !== -1) {
            conflicts.push({
                pair: `${a} ↔ ${b}`,
                modA: originals[idxA],
                modB: originals[idxB],
                message: `Конфликт: "${originals[idxA]}" несовместим с "${originals[idxB]}"`
            });
        }
=======
        const hasA = names.some((n) => n.includes(a));
        const hasB = names.some((n) => n.includes(b));
        if (hasA && hasB) conflicts.push(`${a} ↔ ${b}`);
>>>>>>> f7d31353fa62e5c18778e8d4edb7c4d62bee9f02
    });

    return conflicts;
}

<<<<<<< HEAD
function parseDependencyError (errorText) {
    if (!errorText || typeof errorText !== 'string') return null;

    const issues = [];

    // Fabric dependency error patterns:
    // "Mod 'Iris' (iris) 1.10.6+mc1.21.11 requires any 0.8.x version of sodium, which is missing!"
    const requiresPattern = /Mod '([^']+)' \(([^)]+)\)[^\n]*requires[^\n]*?(?:version of |mod )([a-zA-Z0-9_\-]+),\s*which is missing/gi;
    let match;
    while ((match = requiresPattern.exec(errorText)) !== null) {
        const modName = match[1];
        const modId = match[2];
        const missingMod = match[3];
        // Deduplicate
        const key = `${modId}→${missingMod}`;
        if (!issues.find((i) => i.key === key)) {
            issues.push({
                key,
                modName,
                modId,
                missingMod,
                message: `Мод "${modName}" требует мод "${missingMod}", который не установлен`
            });
        }
    }

    // Generic "X requires Y" fallback
    const genericPattern = /requires[^\n]*?of ([a-zA-Z0-9_\-]+)[^\n]*missing/gi;
    while ((match = genericPattern.exec(errorText)) !== null) {
        const missingMod = match[1];
        const key = `?→${missingMod}`;
        if (!issues.find((i) => i.key === key)) {
            issues.push({
                key,
                modName: null,
                modId: null,
                missingMod,
                message: `Не хватает мода "${missingMod}"`
            });
        }
    }

    return issues.length > 0 ? issues : null;
}

=======
>>>>>>> f7d31353fa62e5c18778e8d4edb7c4d62bee9f02
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
<<<<<<< HEAD
    parseDependencyError,
=======
>>>>>>> f7d31353fa62e5c18778e8d4edb7c4d62bee9f02
    analyzeCrashText
};
