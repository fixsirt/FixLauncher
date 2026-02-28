const path = require('path');
const { getLauncherBasePath, getLegacyBasePaths, getPlaytimePath } = require('../src/paths');

describe('paths helpers', () => {
    test('returns canonical fixlauncher path on windows', () => {
        const result = getLauncherBasePath('win32', 'C:/Users/test', 'C:/Users/test/AppData/Roaming');
        expect(result).toBe(path.join('C:/Users/test/AppData/Roaming', '.fixlauncher'));
    });

    test('returns canonical fixlauncher path on macOS', () => {
        const result = getLauncherBasePath('darwin', '/Users/test');
        expect(result).toBe(path.join('/Users/test', 'Library', 'Application Support', 'fixlauncher'));
    });

    test('returns legacy vanilla-suns path list on linux', () => {
        const result = getLegacyBasePaths('linux', '/home/test');
        expect(result).toEqual([path.join('/home/test', '.vanilla-suns')]);
    });

    test('builds playtime file path from canonical base', () => {
        const result = getPlaytimePath('linux', '/home/test');
        expect(result).toBe(path.join('/home/test', '.fixlauncher', 'launcher-playtime.json'));
    });
});
