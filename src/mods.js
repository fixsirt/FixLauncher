/**
 * Модуль управления модами
 * @module mods
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const AdmZip = require('adm-zip');
const { getVanillaSunsPath } = require('./settings');
const { getSelectedVersion } = require('./versions');

const MODRINTH_API = 'https://api.modrinth.com/v2';
const MODRINTH_USER_AGENT = 'VanillaSunsLauncher/1.0';

/**
 * Получить путь к папке mods для версии
 * @param {string} versionId
 * @returns {string}
 */
function getModsPathForVersion (versionId) {
    const basePath = localStorage.getItem('minecraft-path') || getVanillaSunsPath();
    let folderName;

    if (versionId === 'evacuation') {
        folderName = 'minecraft-survival';
    } else {
        folderName = 'minecraft-' + String(versionId).replace(/:/g, '-').replace(/[^a-zA-Z0-9.-]/g, '-');
    }

    return path.join(basePath, folderName, 'mods');
}

/**
 * Извлечь метаданные мода из .jar
 * @param {string} jarPath
 * @returns {Object}
 */
function parseModMetadata (jarPath) {
    const result = {
        name: null,
        version: null,
        loader: null,
        description: null,
        id: null,
        fileName: path.basename(jarPath)
    };

    try {
        const zip = new AdmZip(jarPath);
        const entries = zip.getEntries();

        // Fabric: fabric.mod.json
        for (const entry of entries) {
            if (entry.entryName === 'fabric.mod.json' || entry.entryName.endsWith('/fabric.mod.json')) {
                const text = entry.getData().toString('utf8');
                try {
                    const json = JSON.parse(text);
                    result.name = json.name || json.id || result.fileName.replace(/\.(jar|disabled)$/i, '');
                    result.version = json.version || '—';
                    result.loader = 'Fabric';
                    result.id = json.id || null;
                    result.description = json.description || null;
                    break;
                } catch (e) {
                    // Игнорируем ошибки парсинга
                }
            }
        }

        // Forge: mods.toml
        if (!result.name) {
            for (const entry of entries) {
                if (entry.entryName === 'META-INF/mods.toml') {
                    const text = entry.getData().toString('utf8');
                    const displayNameMatch = text.match(/displayName\s*=\s*["']([^"']+)["']/);
                    const versionMatch = text.match(/version\s*=\s*["']([^"']+)["']/);
                    const modIdMatch = text.match(/modId\s*=\s*["']([^"']+)["']/);

                    if (displayNameMatch) result.name = displayNameMatch[1];
                    if (versionMatch) result.version = versionMatch[1];
                    if (modIdMatch) result.id = modIdMatch[1];
                    result.loader = 'Forge';
                    break;
                }
            }
        }

        // Если не нашли метаданные, используем имя файла
        if (!result.name) {
            result.name = result.fileName.replace(/\.(jar|disabled)$/i, '');
        }

        if (!result.version) result.version = '—';
        if (!result.loader) result.loader = 'Unknown';
    } catch (e) {
        console.error('Error parsing mod metadata:', e);
        result.name = path.basename(jarPath).replace(/\.(jar|disabled)$/i, '');
        result.version = '—';
        result.loader = 'Error';
    }

    return result;
}

/**
 * Получить список установленных модов
 * @param {string} versionId
 * @returns {Array}
 */
function getInstalledMods (versionId) {
    const modsPath = getModsPathForVersion(versionId);
    const mods = [];

    try {
        if (!fs.existsSync(modsPath)) {
            return mods;
        }

        const files = fs.readdirSync(modsPath);

        for (const file of files) {
            if (file.endsWith('.jar') || file.endsWith('.jar.disabled')) {
                const filePath = path.join(modsPath, file);
                const stat = fs.statSync(filePath);

                if (stat.isFile()) {
                    const metadata = parseModMetadata(filePath);
                    mods.push({
                        ...metadata,
                        path: filePath,
                        enabled: !file.endsWith('.disabled'),
                        size: stat.size,
                        modified: stat.mtime
                    });
                }
            }
        }
    } catch (e) {
        console.error('Error reading mods:', e);
    }

    return mods;
}

/**
 * Включить/выключить мод
 * @param {string} filePath
 * @param {boolean} enable
 */
function toggleMod (filePath, enable) {
    try {
        if (!fs.existsSync(filePath)) return;

        if (enable) {
            const newPath = filePath.replace(/\.disabled$/, '');
            if (filePath !== newPath) {
                fs.renameSync(filePath, newPath);
            }
        } else {
            const newPath = filePath + '.disabled';
            if (filePath !== newPath) {
                fs.renameSync(filePath, newPath);
            }
        }
    } catch (e) {
        console.error('Error toggling mod:', e);
    }
}

/**
 * Удалить мод
 * @param {string} filePath
 */
function deleteMod (filePath) {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (e) {
        console.error('Error deleting mod:', e);
    }
}

/**
 * Поиск модов на Modrinth
 * @param {string} query
 * @param {string} gameVersion
 * @param {string} loader
 * @returns {Promise<Array>}
 */
function searchModrinth (query, gameVersion = null, loader = 'fabric') {
    return new Promise((resolve, reject) => {
        const facets = [
            `categories="${loader}"`,
            `versions="${gameVersion}"`,
            'project_type=mod'
        ];

        const url = new URL(`${MODRINTH_API}/search`);
        url.searchParams.set('query', query);
        url.searchParams.set('facets', JSON.stringify([facets]));
        url.searchParams.set('limit', '20');
        url.searchParams.set('index', 'relevance');

        const lib = url.protocol.startsWith('https') ? https : http;

        const req = lib.get(url.toString(), {
            headers: {
                'User-Agent': MODRINTH_USER_AGENT,
                'Accept': 'application/json'
            },
            timeout: 15000
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    resolve(result.hits || []);
                } catch (e) {
                    reject(new Error('Failed to parse Modrinth response'));
                }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });
    });
}

/**
 * Получить информацию о моде на Modrinth
 * @param {string} slug
 * @returns {Promise<Object>}
 */
function getModInfo (slug) {
    return new Promise((resolve, reject) => {
        const url = `${MODRINTH_API}/project/${slug}`;
        const lib = https;

        const req = lib.get(url, {
            headers: {
                'User-Agent': MODRINTH_USER_AGENT,
                'Accept': 'application/json'
            },
            timeout: 10000
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error('Failed to parse mod info'));
                }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });
    });
}

/**
 * Скачать мод
 * @param {string} url
 * @param {string} destPath
 * @param {Function} onProgress
 * @returns {Promise}
 */
function downloadMod (url, destPath, onProgress) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        const lib = url.startsWith('https') ? https : http;

        const req = lib.get(url, {
            headers: {
                'User-Agent': MODRINTH_USER_AGENT
            },
            timeout: 60000
        }, (response) => {
            if (response.statusCode === 301 || response.statusCode === 302) {
                file.close();
                return downloadMod(response.headers.location, destPath, onProgress)
                    .then(resolve)
                    .catch(reject);
            }

            if (response.statusCode !== 200) {
                file.close();
                reject(new Error(`Failed to download: ${response.statusCode}`));
                return;
            }

            const totalSize = parseInt(response.headers['content-length'], 10);
            let downloadedSize = 0;

            response.on('data', (chunk) => {
                downloadedSize += chunk.length;
                if (onProgress && totalSize) {
                    onProgress(downloadedSize, totalSize);
                }
            });

            response.pipe(file);

            file.on('finish', () => {
                file.close();
                resolve();
            });
        });

        req.on('error', (err) => {
            try {
                if (fs.existsSync(destPath)) {
                    fs.unlinkSync(destPath);
                }
            } catch (e) {
                console.error('Error deleting file:', e);
            }
            reject(err);
        });

        req.on('timeout', () => {
            req.destroy();
            try {
                if (fs.existsSync(destPath)) {
                    fs.unlinkSync(destPath);
                }
            } catch (e) {
                console.error('Error deleting file:', e);
            }
            reject(new Error('Download timeout'));
        });
    });
}

module.exports = {
    getModsPathForVersion,
    parseModMetadata,
    getInstalledMods,
    toggleMod,
    deleteMod,
    searchModrinth,
    getModInfo,
    downloadMod,
    MODRINTH_API,
    MODRINTH_USER_AGENT
};
