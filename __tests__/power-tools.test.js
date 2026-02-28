const { getProfilePreset, detectModConflicts, analyzeCrashText } = require('../src/power-tools');

describe('power tools helpers', () => {
    test('returns fallback preset', () => {
        const preset = getProfilePreset('unknown');
        expect(preset.id).toBe('pvp');
    });

    test('detects known conflicts', () => {
        const conflicts = detectModConflicts(['OptiFine_1.20.jar', 'iris-1.7.jar']);
        expect(conflicts).toContain('optifine ↔ iris');
    });

    test('analyzes crash text', () => {
        const msg = analyzeCrashText('java.lang.OutOfMemoryError: Java heap space');
        expect(msg.toLowerCase()).toContain('ram');
    });
});
