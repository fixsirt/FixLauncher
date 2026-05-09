(function() {
'use strict';

/**
 * Запуск Minecraft — аргументы JVM, classpath, OAuth/офлайн-профиль,
 * launch wrapper, слежка за процессом.
 *
 * Node.js-зависимости убраны: path/os/fs/crypto → window.electronAPI.*
 * spawn() → window.electronAPI.mc.spawn() (IPC → main.js)
 * @module renderer/launcher
 *
 * ИСПРАВЛЕНО: Все вызовы fs.* теперь правильно используют await,
 * так как fs-обёртки возвращают Promise через IPC.
 */

'use strict';

// ─── Алиасы для contextIsolation:true ────────────────────────────────────────
const path = {
    join:       (...a) => window.electronAPI.path.join(...a),
    resolve:    (...a) => window.electronAPI.path.resolve(...a),
    basename:   (p, e) => window.electronAPI.path.basename(p, e),
    dirname:    (p)    => window.electronAPI.path.dirname(p),
    extname:    (p)    => window.electronAPI.path.extname(p),
    relative:   (f, t) => window.electronAPI.path.relative(f, t),
    get sep()       { return window.electronAPI.path.sep; },
    get delimiter() { return window.electronAPI.path.delimiter; },
};
const os = {
    platform: () => window.electronAPI.os.platform(),
    homedir:  () => window.electronAPI.os.homedir(),
    arch:     () => window.electronAPI.os.arch(),
    totalmem: () => window.electronAPI.os.totalmem(),
    freemem:  () => window.electronAPI.os.freemem(),
};
// fs-обёртки — ASYNC IPC. Всегда используй await при вызове!
const fs = {
    existsSync:    async (p)        => window.electronAPI.fs.exists(p),
    mkdirSync:     async (p, opts)  => window.electronAPI.fs.mkdir(p, opts),
    statSync:      async (p)        => window.electronAPI.fs.stat(p),
    unlinkSync:    async (p)        => window.electronAPI.fs.unlink(p),
    readdirSync:   async (p, opts)  => {
        if (opts && opts.withFileTypes) return window.electronAPI.fs.readdir(p);
        return window.electronAPI.fs.readdirNames(p);
    },
    readFileSync:  async (p, enc)   => window.electronAPI.fs.read(p, enc || 'utf8'),
    writeFileSync: async (p, d, enc)=> window.electronAPI.fs.write(p, d, enc || 'utf8'),
    isDllCompatible: async (p)      => window.electronAPI.fs.isDllCompatible(p),
    createWriteStream: () => { throw new Error('createWriteStream unavailable in renderer'); },
};
// ─────────────────────────────────────────────────────────────────────────────

const { addUserJVMArgs } = window.JvmArgs;
const { generateOfflineUUID, generateUUID } = window.RendererUtils;
const {
    showProgress, hideProgress, updateProgress,
    showLauncherAlert, showLauncherConfirm, resetPlayButton, showCrashAlert
} = window.UiHelpers;
const { getSelectedVersion, getMinecraftProfilePath } = window.VersionsModule;
const { getVanillaSunsPath } = window.SettingsPanel;
const { checkAndDownloadVersion, extractNatives } = window.Installer;
const { ensureJava, checkJavaVersion } = window.JavaModule;

function launchMinecraft() {
    showProgress();
    updateProgress(0, 'Инициализация...');

    const selectedAccount = window.AccountsManager && window.AccountsManager.getSelectedAccount();
    const playerName = selectedAccount ? selectedAccount.username : 'Player';
    const selectedVersion = getSelectedVersion();
    const versionType = selectedVersion.id;
    const isCustomBuild = versionType === 'custom';
    const isInstance    = selectedVersion.type === 'instance';

    // Для инстансов — асинхронно загружаем instance.json чтобы получить loader и mcVersion
    const instanceMetaPromise = (isInstance && selectedVersion.dir)
        ? (async () => {
            try {
                const base = getVanillaSunsPath();
                const instPath = window.electronAPI.path.join(base, selectedVersion.dir);
                const meta = await window.electronAPI.instances.readConfig(instPath);
                return meta || null;
            } catch (e) {
                console.warn('[launcher] Could not read instance.json:', e.message);
                return null;
            }
        })()
        : Promise.resolve(null);

    instanceMetaPromise.then(instanceMeta => {
        _launchWithMeta(playerName, selectedVersion, versionType, isCustomBuild, isInstance, instanceMeta);
    });
}

function _launchWithMeta(playerName, selectedVersion, versionType, isCustomBuild, isInstance, instanceMeta) {

    // Для инстансов берём loader и mcVersion из instance.json (instanceMeta)
    // Если instanceMeta недоступен — fallback на имя папки (уже реализован в getSelectedVersion)
    const instanceLoader = isInstance
        ? (instanceMeta?.loader && instanceMeta.loader !== 'vanilla' ? instanceMeta.loader : selectedVersion.loader || null)
        : null;
    const instanceMcVersion = isInstance
        ? (instanceMeta?.mcVersion || selectedVersion.mcVersion || null)
        : null;
    const instanceLoaderVersion = isInstance
        ? (instanceMeta?.loaderVersion || selectedVersion.loaderVersion || null)
        : null;
    const withMods = isCustomBuild
        || (selectedVersion.type === 'fabric' || selectedVersion.type === 'forge'
            || selectedVersion.type === 'neoforge' || selectedVersion.type === 'quilt')
        || (isInstance && !!instanceLoader && instanceLoader !== 'vanilla');

    let versionString;
    if (isCustomBuild) {
        versionString = '1.21.4-fabric';
    } else if (isInstance) {
        const mc = instanceMcVersion || '1.21.4';
        if (!instanceLoader || instanceLoader === 'vanilla') {
            versionString = mc;
        } else if (instanceLoader === 'fabric') {
            versionString = mc + '-fabric';
        } else if (instanceLoader === 'forge') {
            versionString = instanceLoaderVersion || (mc + '-forge');
        } else if (instanceLoader === 'neoforge') {
            versionString = mc + '-neoforge';
        } else if (instanceLoader === 'quilt') {
            versionString = mc + '-quilt';
        } else {
            versionString = mc;
        }
    } else {
        versionString = withMods ? selectedVersion.mcVersion + '-fabric' : selectedVersion.mcVersion;
    }

    updateProgress(5, 'Загрузка настроек из лаунчера...');

    let baseMinecraftPath = localStorage.getItem('minecraft-path');
    let javaPath = localStorage.getItem('java-path');
    let ram = localStorage.getItem('minecraft-ram');

    if (!baseMinecraftPath) {
        const pathInput = document.getElementById('minecraft-path');
        if (pathInput && pathInput.value) {
            baseMinecraftPath = pathInput.value;
        } else {
            baseMinecraftPath = os.platform() === 'win32'
                ? path.join(window.electronAPI.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '.fixlauncher')
                : path.join(os.homedir(), '.fixlauncher');
        }
    }

    let minecraftFolderName;
    if (isInstance) {
        minecraftFolderName = selectedVersion.dir;
    } else {
        const safeVersionType = String(versionType || 'fabric-1.21.4').replace(/:/g, '-').replace(/[^a-zA-Z0-9.-]/g, '-');
        minecraftFolderName = 'minecraft-' + safeVersionType;
    }

    const minecraftPath = path.join(baseMinecraftPath, minecraftFolderName);

    if (!javaPath) {
        const javaInput = document.getElementById('java-path');
        if (javaInput && javaInput.value && !javaInput.value.includes('не найдена')) {
            javaPath = javaInput.value;
        } else {
            javaPath = 'java';
        }
    }

    if (!ram) {
        const ramSlider = document.getElementById('ram-slider');
        ram = (ramSlider && ramSlider.value) ? ramSlider.value : '4';
    }

    if (!baseMinecraftPath) {
        hideProgress();
        resetPlayButton();
        showLauncherAlert('Ошибка: не указан путь к папке игры. Пожалуйста, укажите путь в настройках.');
        return;
    }

    if (!javaPath || javaPath === 'Java не найдена') {
        hideProgress();
        resetPlayButton();
        showLauncherAlert('Ошибка: не найдена Java. Пожалуйста, укажите путь к Java в настройках.');
        return;
    }

    console.log('Launch settings:', { baseMinecraftPath, minecraftPath, minecraftFolder: minecraftFolderName, javaPath, ram: ram + 'GB', playerName, versionType, withMods });
    updateProgress(10, 'Проверка настроек...');
    console.log(`Using separate Minecraft folder for ${versionType}: ${minecraftPath}`);

    // Определяем требуемую версию Java ДО ensureJava, чтобы main мог загрузить правильную версию
    const mcVerForJava = instanceMcVersion || selectedVersion.mcVersion || '1.21.4';
    const requiredJavaVer = getRequiredJava(mcVerForJava);

    ensureJava(baseMinecraftPath, javaPath, requiredJavaVer).then(async (finalJavaPath) => {
        console.log('Using Java:', finalJavaPath);
        const verifiedJavaPath = finalJavaPath;
        localStorage.setItem('java-path', verifiedJavaPath);
        updateProgress(15, 'Проверка версии Minecraft...');

        // Создаём папку если её нет (await обязателен!)
        if (!await fs.existsSync(minecraftPath)) {
            await fs.mkdirSync(minecraftPath, { recursive: true });
            console.log(`Created Minecraft directory for ${versionType}: ${minecraftPath}`);
        }

        // Пишем instance.json если его ещё нет — чтобы в инстансах отображался правильный loader
        const instanceConfigPath = window.electronAPI.path.join(minecraftPath, 'instance.json');
        if (!await fs.existsSync(instanceConfigPath)) {
            try {
                // Для инстансов берём реальные mcVersion и loader из уже вычисленных переменных
                const realMcVer  = instanceMcVersion || versionString.replace(/-(fabric|forge|neoforge|quilt).*$/i, '');
                const realLoader = instanceLoader || (withMods ? 'fabric' : 'vanilla');
                const instanceMeta = {
                    mcVersion:     realMcVer,
                    loader:        realLoader,
                    loaderVersion: instanceLoaderVersion || null,
                    created:       new Date().toISOString(),
                    name:          null,
                };
                await window.electronAPI.instances.writeConfig(minecraftPath, instanceMeta);
            } catch(e) { console.warn('[launcher] Could not write instance.json:', e.message); }
        }

        return checkAndDownloadVersion(minecraftPath, versionString, withMods).then(() => {
            return { javaPath: verifiedJavaPath };
        });
    }).then(({ javaPath: verifiedJavaPath }) => {
        if (isCustomBuild && withMods) {
            updateProgress(60, 'Установка Сборки для выживания...');
            installModpack(minecraftPath, versionType).then(() => {
                updateProgress(85, 'Запуск Minecraft Fabric 1.21.4...');
                runMinecraft(minecraftPath, verifiedJavaPath, playerName, ram, withMods, versionType, versionString);
                updateProgress(100, 'Minecraft запущен!');
            }).catch((error) => {
                console.error('Error installing modpack:', error);
                hideProgress();
                resetPlayButton();
                let msg = 'Ошибка при установке сборки модов.\n\n';
                if (error.message) msg += `Детали: ${error.message}\n\n`;
                msg += 'Попробуйте:\n1. Проверить интернет-соединение\n2. Запустить от имени администратора\n3. Удалить папку сборки и повторить\n4. Проверить логи (F12)';
                showLauncherAlert(msg);
            });
        } else {
            updateProgress(80, `Запуск Minecraft ${versionString}...`);
            runMinecraft(minecraftPath, verifiedJavaPath, playerName, ram, withMods, versionType, versionString);
            updateProgress(100, 'Minecraft запущен!');
        }
    }).catch((error) => {
        console.error('Error:', error);
        hideProgress();
        resetPlayButton();
        showLauncherAlert('Ошибка: ' + error.message);
    });
}

/**
 * Определяет минимальную версию Java в зависимости от версии MC:
 * - MC 1.20.5+ или major > 1 → Java 21+
 * - MC 1.17-1.20.4 → Java 17+
 * - MC < 1.17 → Java 8+
 * - MC major >= 26 → Java 25+ (новый формат версий без ведущего "1.")
 */
function getRequiredJava(mcVer) {
    if (!mcVer) return 21;
    const clean = String(mcVer).replace(/-.*/, '');
    const parts = clean.split('.').map(Number);
    // Новый формат (без ведущего "1."): "26.1.2" → major=26
    if (parts[0] > 1) {
        if (parts[0] >= 26) return 25;
        if (parts[0] >= 22) return 22;
        return 21;
    }
    // Традиционный формат "1.x.y"
    const minor = parts[1] || 0;
    const patch = parts[2] || 0;
    if (minor > 20 || (minor === 20 && patch >= 5)) return 21;
    if (minor >= 17) return 17;
    return 8;
}

function runMinecraft(minecraftPath, javaPath, playerName, ram, withMods, versionType = 'fabric', versionOverride = null) {
    const selectedVer = getSelectedVersion();
    const fallbackMc = (selectedVer && selectedVer.mcVersion) ? selectedVer.mcVersion : '1.21.4';
    const version = versionOverride || (withMods ? fallbackMc + '-fabric' : fallbackMc);
    console.log('Running Minecraft with settings:');
    console.log('  Path:', minecraftPath);
    console.log('  Java:', javaPath);
    console.log('  RAM:', ram + 'GB');
    console.log('  Player:', playerName);
    console.log('  Mods:', withMods);
    console.log('  Version:', version);

    updateProgress(85, 'Проверка версии Java...');
    checkJavaVersion(javaPath).then(async (javaVersion) => {
        console.log('Java version detected:', javaVersion);

        // Проверяем существование кастомного пути к Java
        if (javaPath !== 'java' && !await fs.existsSync(javaPath)) {
            hideProgress();
            resetPlayButton();
            showLauncherAlert(`Ошибка: Java не найдена по пути: ${javaPath}\nПожалуйста, проверьте путь в настройках.`);
            return;
        }

        const mcVersionForJava = (selectedVer && selectedVer.mcVersion) ? selectedVer.mcVersion : '1.21.4';
        const requiredJava = getRequiredJava(mcVersionForJava);

        if (javaVersion < requiredJava) {
            hideProgress();
            resetPlayButton();
            let msg = `Ошибка: Несовместимая версия Java!\n\nMinecraft ${mcVersionForJava} требует Java ${requiredJava}+.\nОбнаружена Java ${javaVersion}.\n\n`;
            if (requiredJava > 21) {
                msg += `Это новая версия Minecraft, которая требует Java ${requiredJava}.\nFixLauncher попытается загрузить Java ${requiredJava} автоматически, но если это не удастся — установите Java ${requiredJava} вручную с сайта https://adoptium.net/ и укажите путь в настройках.\n\nТекущий путь: ${javaPath}`;
            } else {
                msg += `Установите Java ${requiredJava}+ и укажите путь в настройках.\nТекущий путь: ${javaPath}`;
            }
            showLauncherAlert(msg);
            return;
        }

        const nativesPath = path.join(minecraftPath, 'natives');
        const lwjglDll = path.join(nativesPath, 'lwjgl.dll');

        if (!await fs.existsSync(lwjglDll)) {
            console.log('Native libraries not found, extracting...');
            updateProgress(88, 'Извлечение нативных библиотек...');
            extractNatives(minecraftPath, version).then(() => {
                console.log('Native libraries extracted');
                continueMinecraftLaunch(minecraftPath, javaPath, playerName, ram, withMods, versionType, version);
            }).catch((error) => {
                console.warn('Failed to extract natives:', error);
                continueMinecraftLaunch(minecraftPath, javaPath, playerName, ram, withMods, versionType, version);
            });
        } else {
            try {
                const compatible = await fs.isDllCompatible(lwjglDll);
                console.log(`lwjgl.dll PE-arch compatible: ${compatible}`);

                if (!compatible) {
                    console.warn('lwjgl.dll is wrong architecture (32-bit on 64-bit?). Re-extracting...');
                    updateProgress(88, 'Переизвлечение нативных библиотек...');
                    try { await fs.unlinkSync(lwjglDll); } catch (e) { console.warn('Could not remove lwjgl.dll:', e); }
                    extractNatives(minecraftPath, version).then(() => {
                        console.log('Native libraries re-extracted');
                        continueMinecraftLaunch(minecraftPath, javaPath, playerName, ram, withMods, versionType, version);
                    }).catch((error) => {
                        console.warn('Failed to re-extract natives:', error);
                        continueMinecraftLaunch(minecraftPath, javaPath, playerName, ram, withMods, versionType, version);
                    });
                    return;
                }
            } catch (e) {
                console.warn('Could not check lwjgl.dll arch:', e);
            }
            continueMinecraftLaunch(minecraftPath, javaPath, playerName, ram, withMods, versionType, version);
        }
    }).catch((error) => {
        console.warn('Could not check Java version:', error);
        continueMinecraftLaunch(minecraftPath, javaPath, playerName, ram, withMods, versionType, version);
    });
}

async function continueMinecraftLaunch(minecraftPath, javaPath, playerName, ram, withMods, versionType = 'fabric', versionOverride = null) {
    const version = versionOverride || (withMods ? '1.21.4-fabric' : '1.21.4');

    if (!await fs.existsSync(minecraftPath)) {
        await fs.mkdirSync(minecraftPath, { recursive: true });
        console.log('Created Minecraft directory:', minecraftPath);
    }

    const assemblyPath = minecraftPath;
    console.log('continueMinecraftLaunch: Minecraft path:', minecraftPath);
    console.log('continueMinecraftLaunch: Assembly path (same as Minecraft):', assemblyPath);
    console.log('continueMinecraftLaunch: Path exists:', await fs.existsSync(assemblyPath));

    if (withMods) {
        const modsPath = path.join(minecraftPath, 'mods');
        if (!await fs.existsSync(modsPath)) {
            await fs.mkdirSync(modsPath, { recursive: true });
        }
        let installedMods = [];
        if (await fs.existsSync(modsPath)) {
            const allFiles = await fs.readdirSync(modsPath);
            installedMods = allFiles.filter(f => f.endsWith('.jar') && f !== '.gitkeep');
        }
        console.log('Checking mods installation...');
        console.log('  Mods path:', modsPath);
        console.log('  Installed mods count:', installedMods.length);
        if (installedMods.length > 0) {
            console.log(`Found ${installedMods.length} installed mods:`, installedMods);
        } else {
            console.warn('No mods found in mods folder.');
        }
    }

    const versionsPath = path.join(minecraftPath, 'versions', version);
    const versionJsonPath = path.join(versionsPath, version + '.json');
    const clientJarPath = path.join(versionsPath, version + '.jar');

    if (!await fs.existsSync(clientJarPath)) {
        hideProgress();
        resetPlayButton();
        showLauncherAlert(`Ошибка: Версия Minecraft ${version} не установлена.\nПожалуйста, дождитесь завершения загрузки.`);
        return;
    }

    const nativesPath = path.join(minecraftPath, 'natives');
    const lwjglDll = path.join(nativesPath, 'lwjgl.dll');

    let needsExtraction = true;
    if (await fs.existsSync(lwjglDll)) {
        try {
            const compatible = await fs.isDllCompatible(lwjglDll);
            if (compatible) {
                console.log('lwjgl.dll exists and architecture is correct (64-bit).');
                needsExtraction = false;
            } else {
                console.warn('lwjgl.dll exists but wrong architecture (32-bit on 64-bit?). Will re-extract.');
                try {
                    await fs.unlinkSync(lwjglDll);
                    console.log('Removed incompatible lwjgl.dll');
                } catch (e) {
                    console.warn('Could not remove incompatible lwjgl.dll:', e);
                }
            }
        } catch (e) {
            console.warn('Could not check lwjgl.dll arch:', e);
        }
    }

    if (!await fs.existsSync(nativesPath)) {
        await fs.mkdirSync(nativesPath, { recursive: true });
    }

    if (needsExtraction) {
        console.log('Native libraries not found, extracting...');
        console.log('Natives path:', nativesPath);
        updateProgress(85, 'Извлечение нативных библиотек...');

        extractNatives(minecraftPath, version).then(async () => {
            if (await fs.existsSync(lwjglDll)) {
                console.log('Native libraries successfully extracted!');
                await continueWithLaunch();
            } else {
                console.error('Native libraries still not found after extraction!');
                console.error('Natives path:', nativesPath);
                try {
                    const files = await fs.readdirSync(nativesPath);
                    console.error('Files in natives folder:', files);
                } catch (e) {
                    console.error('Could not read natives folder:', e);
                }
                hideProgress();
                resetPlayButton();
                showLauncherAlert(`Ошибка: Не удалось извлечь нативные библиотеки!\n\nПуть: ${nativesPath}\n\nПроверьте консоль (F12).`);
            }
        }).catch((error) => {
            console.error('Failed to extract natives:', error);
            hideProgress();
            resetPlayButton();
            showLauncherAlert(`Ошибка при извлечении нативных библиотек: ${error.message}\n\nПроверьте консоль (F12).`);
        });
    } else {
        console.log('Native libraries already exist');
        await continueWithLaunch();
    }

    async function continueWithLaunch() {
        // FIX: getMinecraftClasspath теперь async — нужен await
        const classpath = await getMinecraftClasspath(minecraftPath, withMods, version);
        if (!classpath) {
            hideProgress();
            resetPlayButton();
            showLauncherAlert('Ошибка: Не удалось собрать classpath для Minecraft.\nПроверьте, что версия полностью загружена.');
            return;
        }

        console.log('Classpath:', classpath);

        // СТРАХОВКА: если запускаем Fabric и joptsimple отсутствует — vanilla библиотеки не скачаны.
        // Принудительно переустанавливаем vanilla версию и пересобираем classpath.
        if (withMods) {
            const hasJoptSimple = classpath.toLowerCase().includes('jopt-simple');
            if (!hasJoptSimple) {
                console.error('FATAL: joptsimple missing from classpath! Vanilla libraries incomplete.');
                updateProgress(28, 'Доустановка библиотек Minecraft...');
                const mcVersion = version.replace(/-(fabric|forge|neoforge|quilt|loader).*$/i, '');
                try {
                    await window.electronAPI.installer.checkAndDownload(minecraftPath, mcVersion, false);
                    // Пересобираем classpath после доустановки
                    const newClasspath = await getMinecraftClasspath(minecraftPath, withMods, version);
                    if (newClasspath && newClasspath.toLowerCase().includes('jopt-simple')) {
                        console.log('Classpath rebuilt successfully with vanilla libs.');
                        classpath = newClasspath;
                    } else {
                        throw new Error('joptsimple still missing after reinstall');
                    }
                } catch (reinstallErr) {
                    console.error('Failed to reinstall vanilla libs:', reinstallErr);
                    hideProgress();
                    resetPlayButton();
                    showLauncherAlert('Ошибка: Не удалось доустановить библиотеки Minecraft.\n\nУдалите папку версии и попробуйте снова.\n(' + reinstallErr.message + ')');
                    return;
                }
            }
        }

        let mainClass = 'net.minecraft.client.main.Main';
        if (withMods) {
            mainClass = 'net.fabricmc.loader.impl.launch.knot.KnotClient';
        }

        if (!await fs.existsSync(nativesPath)) {
            await fs.mkdirSync(nativesPath, { recursive: true });
        }

        // Резолвим assetIndex с подъёмом по inheritsFrom
        async function resolveAssetIndex(jsonPath) {
            if (!(await fs.existsSync(jsonPath))) return null;
            try {
                const content = await fs.readFileSync(jsonPath, 'utf8');
                const data = JSON.parse(content);
                if (data.assetIndex) {
                    const id = typeof data.assetIndex === 'string' ? data.assetIndex : data.assetIndex.id;
                    if (id) return id;
                }
                if (data.inheritsFrom) {
                    const parentPath = path.join(minecraftPath, 'versions', data.inheritsFrom, data.inheritsFrom + '.json');
                    return await resolveAssetIndex(parentPath);
                }
                return null;
            } catch { return null; }
        }

        let assetIndex = await resolveAssetIndex(versionJsonPath) || '1.21';
        console.log('Using assetIndex:', assetIndex);

        let versionJsonGameArgs = [];
        try {
            if (await fs.existsSync(versionJsonPath)) {
                const versionFileContent = await fs.readFileSync(versionJsonPath, 'utf8');
                const versionData = JSON.parse(versionFileContent);
                const rawArgs = versionData.minecraftArguments
                    ? versionData.minecraftArguments.split(' ')
                    : (versionData.arguments && Array.isArray(versionData.arguments.game))
                        ? versionData.arguments.game.filter(a => typeof a === 'string')
                        : [];
                console.log('[launcher] version.json game args count:', rawArgs.length);
                versionJsonGameArgs = rawArgs;
            }
        } catch (e) {
            console.warn('Could not read game args from version.json:', e);
        }

        // FIX: await при проверке lwjgl.dll
        if (!await fs.existsSync(lwjglDll)) {
            console.error('lwjgl.dll not found in:', nativesPath);
            try {
                const files = await fs.readdirSync(nativesPath);
                console.error('Files in natives folder:', files);
            } catch (e) {
                console.error('Could not read natives folder:', e);
            }
            hideProgress();
            resetPlayButton();
            showLauncherAlert(`Ошибка: Нативные библиотеки не найдены!\n\nПуть: ${nativesPath}\n\nПопробуйте удалить папку версии и переустановить Minecraft.`);
            return;
        }

        console.log('Native libraries found in:', nativesPath);
        try {
            // FIX: await при чтении списка файлов natives
            const files = await fs.readdirSync(nativesPath);
            console.log('Native files:', files.filter(f => f.endsWith('.dll')).join(', '));
        } catch (e) {
            console.warn('Could not list native files:', e);
        }

        const absoluteNativesPath = path.resolve(nativesPath);
        console.log('Using absolute natives path:', absoluteNativesPath);

        // ── Authlib-injector для MC < 1.17 (обход "Multiplayer is disabled") ──
        // Для версий 1.16.x и старее Minecraft жёстко проверяет авторизацию через
        // api.minecraftservices.com. authlib-injector перенаправляет все запросы на
        // наш локальный Yggdrasil-сервер, который одобряет любого игрока.
        function mcNeedsAuthlibInjector(ver) {
            if (!ver) return false;
            const clean = String(ver).replace(/-.*/, '');
            const parts = clean.split('.').map(Number);
            // Новый формат версий (без "1.") — всегда современные, authlib-injector не нужен
            if (parts[0] > 1) return false;
            const minor = parts[1] || 0;
            return minor < 17; // 1.16.x, 1.15.x, 1.8.x и т.д.
        }

        let authlibJvmArg = null;
        if (mcNeedsAuthlibInjector(version)) {
            try {
                const basePath = path.dirname(minecraftPath); // родительская папка (.fixlauncher)
                const authlibPath = path.join(basePath, 'authlib-injector.jar');
                const AUTHLIB_URL = 'https://github.com/yushijinhun/authlib-injector/releases/download/v1.2.5/authlib-injector-1.2.5.jar';

                if (!await fs.existsSync(authlibPath)) {
                    console.log('[authlib] Downloading authlib-injector...');
                    updateProgress(82, 'Загрузка authlib-injector...');
                    try {
                        await window.electronAPI.download.file(AUTHLIB_URL, authlibPath, 'authlib-injector');
                        console.log('[authlib] Downloaded to:', authlibPath);
                    } catch (dlErr) {
                        console.warn('[authlib] Download failed:', dlErr && dlErr.message);
                    }
                }

                if (await fs.existsSync(authlibPath)) {
                    const yggPort = await window.electronAPI.yggdrasil.getPort();
                    authlibJvmArg = `-javaagent:${authlibPath}=http://127.0.0.1:${yggPort}/`;
                    console.log(`[authlib] Injecting authlib-injector for MC ${version} → port ${yggPort}`);
                } else {
                    console.warn('[authlib] authlib-injector.jar not found, multiplayer may be disabled on', version);
                }
            } catch (ablErr) {
                console.warn('[authlib] Error setting up authlib-injector:', ablErr && ablErr.message);
            }
        }

        // JVM аргументы (до mainClass) — только системные параметры JVM
        // Игровые аргументы (--username, --gameDir, etc.) добавляются после mainClass
        // либо из version.json (с подстановкой переменных), либо вручную
        const jvmArgs = [
            // authlib-injector должен идти ПЕРВЫМ аргументом JVM
            ...(authlibJvmArg ? [authlibJvmArg] : []),
            `-Xmx${ram}G`,
            `-Xms${Math.min(parseInt(ram), 2)}G`,
            '-Djava.library.path=' + absoluteNativesPath,
            '-Dorg.lwjgl.librarypath=' + absoluteNativesPath,
            '-Dorg.lwjgl.util.Debug=true',
            '-Dorg.lwjgl.util.DebugLoader=true',
            '-Dminecraft.launcher.brand=custom',
            '-Dminecraft.launcher.version=1.0',
            '-Dminecraft.demo=false',
            '-Dminecraft.client=true',
            '-Dminecraft.fullscreen=false',
            '-Dcom.mojang.authlib.properties.skipValidation=true',
            '-Djava.net.preferIPv4Stack=true',
            '-cp', classpath,
            mainClass,
        ];
        // Игровые аргументы по умолчанию (используются только если version.json не содержит своих)
        const defaultGameArgs = [
            '--version', version,
            '--gameDir', minecraftPath,
            '--assetsDir', path.join(minecraftPath, 'assets'),
            '--assetIndex', assetIndex,
            '--width', '854',
            '--height', '480',
        ];

        const selectedAccount = window.AccountsManager ? window.AccountsManager.getSelectedAccount() : null;
        const isMicrosoft = selectedAccount && selectedAccount.type === 'microsoft';
        let playerUUID;
        let accessToken;
        let userType;

        if (isMicrosoft && selectedAccount.uuid) {
            const raw = selectedAccount.uuid.replace(/-/g, '');
            playerUUID = raw.length === 32
                ? `${raw.slice(0,8)}-${raw.slice(8,12)}-${raw.slice(12,16)}-${raw.slice(16,20)}-${raw.slice(20)}`
                : raw;
            accessToken = selectedAccount.accessToken || playerUUID.replace(/-/g, '') + '00000000000000000000000000000000';
            userType = 'msa';
            console.log('Using Microsoft account:', playerName, 'UUID:', playerUUID);
        } else {
            const uuidKey = `player-uuid-${playerName}`;
            playerUUID = localStorage.getItem(uuidKey);
            if (!playerUUID) {
                playerUUID = await window.electronAPI.crypto.offlineUUID(playerName);
                localStorage.setItem(uuidKey, playerUUID);
                console.log('Generated offline UUID for player:', playerName, '->', playerUUID);
            } else {
                console.log('Using saved offline UUID for player:', playerName, '->', playerUUID);
            }
            accessToken = playerUUID.replace(/-/g, '') + '00000000000000000000000000000000'.slice(playerUUID.replace(/-/g,'').length);
            userType = 'mojang';
        }

        try {
            const usercachePath = path.join(minecraftPath, 'usercache.json');
            let userCache = [];

            if (await fs.existsSync(usercachePath)) {
                try {
                    const cacheContent = await fs.readFileSync(usercachePath, 'utf8');
                    userCache = JSON.parse(cacheContent);
                } catch (e) {
                    console.warn('Could not read existing usercache.json:', e);
                }
            }

            const existingIndex = userCache.findIndex(u => u.name === playerName);
            const userEntry = {
                name: playerName,
                uuid: playerUUID,
                expiresOn: (() => {
                    const d = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
                    const pad = n => String(n).padStart(2,'0');
                    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`;
                })()
            };

            if (existingIndex >= 0) {
                userCache[existingIndex] = userEntry;
            } else {
                userCache.push(userEntry);
            }

            await fs.writeFileSync(usercachePath, JSON.stringify(userCache, null, 2), 'utf8');
            console.log('Created/updated user profile file:', usercachePath);
        } catch (e) {
            console.warn('Could not create user profile file:', e);
        }

        const authVars = {
            '${auth_player_name}': playerName,
            '${auth_uuid}': playerUUID,
            '${auth_access_token}': accessToken,
            '${auth_session}': accessToken,
            '${user_type}': userType,
            '${version_type}': 'release',
            '${version_name}': version,
            '${game_directory}': minecraftPath,
            '${assets_root}': path.join(minecraftPath, 'assets'),
            '${assets_index_name}': assetIndex,
            '${user_properties}': '{}',
            '${clientid}': playerUUID.replace(/-/g,''),
            '${auth_xuid}': isMicrosoft ? playerUUID.replace(/-/g,'') : '0',
        };

        // ── Дедупликация аргументов ──────────────────────────────────────────
        // Собираем все game-аргументы, исключая дубли по ключу (--flag value)
        function dedupeArgs(args) {
            const seen = new Set();
            const result = [];
            for (let i = 0; i < args.length; i++) {
                const a = args[i];
                if (a.startsWith('--')) {
                    if (seen.has(a)) {
                        // Пропускаем и следующий элемент (значение), если он не флаг
                        if (i + 1 < args.length && !args[i + 1].startsWith('--')) i++;
                        continue;
                    }
                    seen.add(a);
                }
                result.push(a);
            }
            return result;
        }

        // Всегда добавляем аргументы явно — не полагаемся на version.json
        jvmArgs.push(...defaultGameArgs);
        jvmArgs.push(
            '--username', playerName,
            '--uuid', playerUUID,
            '--accessToken', accessToken,
            '--userType', userType,
            '--versionType', 'release',
            '--lang', 'ru_RU'
        );

        console.log('=== Launching Minecraft ===');
        console.log('Player name:', playerName);
        console.log('Player UUID:', playerUUID);
        console.log('Account type:', isMicrosoft ? 'Microsoft (licensed)' : 'Crack (offline)');
        console.log('All launch parameters:', jvmArgs.join(' '));

        if (withMods) {
            const fabricLoaderVersion = localStorage.getItem('fabric-loader-version') || '0.16.0';
            const fabricGameVersion = version.replace(/-fabric$/, '');
            jvmArgs.push(
                '--fabric.gameVersion', fabricGameVersion,
                '--fabric.loaderVersion', fabricLoaderVersion
            );
            console.log('Using Fabric game version:', fabricGameVersion, 'Loader version:', fabricLoaderVersion);
        }

        console.log('Java executable:', javaPath);
        console.log('JVM arguments (before custom):', jvmArgs.join(' '));

        addUserJVMArgs(jvmArgs);

        // Финальная дедупликация — убираем случайные дубли флагов
        const cleanArgs = dedupeArgs(jvmArgs);
        console.log(`[launcher] Args: ${jvmArgs.length} → after dedup: ${cleanArgs.length}`);
        console.log('JVM arguments (after custom):', cleanArgs.join(' '));

        // Записываем launcher_profiles.json с (фейковым или настоящим) профилем
        try {
            const lpPath = window.electronAPI.path.join(minecraftPath, 'launcher_profiles.json');
            const clientToken = playerUUID.replace(/-/g, '');
            const profileData = {
                profiles: {
                    [playerName]: {
                        name: playerName,
                        type: 'latest-release',
                        lastVersionId: version,
                        icon: 'Creeper_Head'
                    }
                },
                selectedProfile: playerName,
                clientToken: clientToken,
                authenticationDatabase: {
                    [clientToken]: {
                        accessToken: accessToken,
                        username: playerName,
                        profiles: {
                            [playerUUID.replace(/-/g,'')]: { displayName: playerName }
                        },
                        properties: []
                    }
                },
                selectedUser: {
                    account: clientToken,
                    profile: playerUUID.replace(/-/g,'')
                },
                launcherVersion: { name: 'fixlauncher', format: 21 }
            };
            await window.electronAPI.fs.write(lpPath, JSON.stringify(profileData, null, 2), 'utf8');
            console.log('[launcher] launcher_profiles.json written');
        } catch(e) {
            console.warn('[launcher] Could not write launcher_profiles.json:', e.message);
        }

        const spawnResult = await window.electronAPI.mc.spawn({
            javaPath: javaPath,
            args: cleanArgs,
            cwd: minecraftPath,
        });

        if (!spawnResult.ok) {
            hideProgress();
            resetPlayButton();
            const errMsg = [
                `Ошибка при запуске Minecraft: ${spawnResult.error || 'Неизвестная ошибка'}`,
                '',
                'Проверьте:',
                `1. Путь к Java правильный (${javaPath === 'java' ? 'системная Java' : javaPath})`,
                `2. Версия Minecraft загружена`,
            ].join('\n');
            showLauncherAlert(errMsg);
            return;
        }

        console.log('[launcher] mc:spawn OK, PID:', spawnResult.pid);
        hideProgress();

        const unsubscribeExitError = window.electronAPI.on.mcProcessExitError(async ({ code, errorOutput }) => {
            unsubscribeExitError();
            console.warn('[launcher] Minecraft exited with code:', code);
            let crashReportText = '';
            let crashFilePath = null;

            try {
                const crashReportsDir = window.electronAPI.path.join(minecraftPath, 'crash-reports');
                const exists = await window.electronAPI.fs.exists(crashReportsDir);
                if (exists) {
                    const entries = await window.electronAPI.fs.readdir(crashReportsDir);
                    const txtFiles = entries
                        .filter(e => !e.isDirectory && e.name.endsWith('.txt'))
                        .sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
                    if (txtFiles.length > 0) {
                        crashFilePath = window.electronAPI.path.join(crashReportsDir, txtFiles[0].name);
                        crashReportText = await window.electronAPI.fs.read(crashFilePath, 'utf8') || '';
                    }
                }
            } catch { /* ignore */ }

            resetPlayButton();
            showCrashAlert(
                `Minecraft завершился с кодом ${code}`,
                crashReportText || errorOutput || '(нет вывода)',
                crashFilePath
            );
        });

        const unsubscribeError = window.electronAPI.on.mcProcessError(({ message }) => {
            unsubscribeError();
            hideProgress();
            resetPlayButton();
            showLauncherAlert(`Ошибка запуска Minecraft: ${message}`);
        });

    } // end continueWithLaunch
} // end continueMinecraftLaunch

// Получение classpath для Minecraft.
// FIX: функция теперь async — все fs-вызовы используют await.
async function getMinecraftClasspath(minecraftPath, withMods, versionOverride = null) {
    const version = versionOverride || (withMods ? '1.21.4-fabric' : '1.21.4');
    const versionsPath = path.join(minecraftPath, 'versions', version);
    const versionJsonPath = path.join(versionsPath, version + '.json');
    const libsPath = path.join(minecraftPath, 'libraries');

    let classpath = [];
    const seenLibs = new Set();

    async function addLibsFromVersionData(versionData) {
        if (!versionData.libraries) return;
        const platformRaw = os.platform();
        const osName = platformRaw === 'win32' ? 'windows' : platformRaw === 'darwin' ? 'osx' : 'linux';
        for (const lib of versionData.libraries) {
            let shouldInclude = true;
            if (lib.rules && lib.rules.length > 0) {
                shouldInclude = false;
                for (const rule of lib.rules) {
                    if (rule.action === 'allow') {
                        if (!rule.os || rule.os.name === osName) { shouldInclude = true; break; }
                    } else if (rule.action === 'disallow') {
                        if (rule.os && rule.os.name === osName) { shouldInclude = false; break; }
                    }
                }
            }

            if (!shouldInclude) continue;

            let libPath = null;
            if (lib.downloads?.artifact?.path) {
                libPath = path.join(libsPath, lib.downloads.artifact.path);
            } else if (lib.name) {
                const parts = lib.name.split(':');
                if (parts.length >= 3) {
                    const [group, artifact, ver] = parts;
                    const groupPath = group.replace(/\./g, '/');
                    const fileName = `${artifact}-${ver}.jar`;
                    const mavenRelPath = `${groupPath}/${artifact}/${ver}/${fileName}`;
                    libPath = path.join(libsPath, mavenRelPath);
                }
            }

            if (libPath) {
                const key = lib.name || libPath;
                if (seenLibs.has(key)) continue;
                if (await fs.existsSync(libPath)) {
                    seenLibs.add(key);
                    classpath.push(libPath);
                } else {
                    console.warn('Library not found on disk:', libPath);
                }
            }
        }
    }

    // Рекурсивно обрабатываем inheritsFrom — собираем все родительские библиотеки
    async function loadWithInherits(jsonPath) {
        if (!(await fs.existsSync(jsonPath))) return null;
        try {
            const content = await fs.readFileSync(jsonPath, 'utf8');
            const data = JSON.parse(content);
            if (data.inheritsFrom && data.inheritsFrom !== data.id) {
                const parentVersion = data.inheritsFrom;
                const parentJsonPath = path.join(minecraftPath, 'versions', parentVersion, parentVersion + '.json');
                await loadWithInherits(parentJsonPath);
            }
            await addLibsFromVersionData(data);
            return data;
        } catch (e) {
            console.warn('Could not read version.json:', jsonPath, e);
            return null;
        }
    }

    const versionData = await loadWithInherits(versionJsonPath);

    const clientJar = path.join(versionsPath, version + '.jar');
    if (await fs.existsSync(clientJar)) {
        classpath.push(clientJar);
    }

    if (withMods) {
        // Если inheritsFrom не сработал (нет vanilla json), пробуем fallback
        if (versionData && (!versionData.inheritsFrom)) {
            const mcVersion = version.replace(/-(fabric|forge|neoforge|quilt|loader).*$/i, '');
            if (mcVersion && mcVersion !== version) {
                const vanillaJsonPath = path.join(minecraftPath, 'versions', mcVersion, mcVersion + '.json');
                if (await fs.existsSync(vanillaJsonPath)) {
                    try {
                        const vanillaContent = await fs.readFileSync(vanillaJsonPath, 'utf8');
                        const vanillaData = JSON.parse(vanillaContent);
                        await addLibsFromVersionData(vanillaData);
                        console.log('Added vanilla libs from', mcVersion, 'to classpath (fallback)');
                    } catch (e) {
                        console.warn('Could not read vanilla version.json:', e);
                    }
                }
            }
        }

        // Рекурсивный поиск jar-файлов через строковый readdir (Dirent не сериализуется через IPC)
        const findJars = async (dir) => {
            const jars = [];
            try {
                const names = await fs.readdirSync(dir);
                for (const name of names) {
                    const fullPath = path.join(dir, name);
                    try {
                        const stat = await fs.statSync(fullPath);
                        if (stat.isDirectory) {
                            const subJars = await findJars(fullPath);
                            for (const j of subJars) jars.push(j);
                        } else if (name.endsWith('.jar')) {
                            jars.push(fullPath);
                        }
                    } catch { /* skip */ }
                }
            } catch (e) {
                console.warn('Error reading directory:', dir, e);
            }
            return jars;
        };

        // Добавляем Fabric Loader библиотеки
        const fabricLibsPath = path.join(minecraftPath, 'libraries', 'net', 'fabricmc');
        if (await fs.existsSync(fabricLibsPath)) {
            const fabricJars = await findJars(fabricLibsPath);
            for (const jar of fabricJars) {
                if (!classpath.includes(jar)) {
                    classpath.push(jar);
                }
            }
        }

        // Обязательно сканируем ВСЮ папку libraries — добавляем любые jar,
        // которые ещё не в classpath. Это гарантирует joptsimple и прочие
        // транзитивные зависимости Fabric Loader'а.
        const allLibJars = await findJars(path.join(minecraftPath, 'libraries'));
        for (const jar of allLibJars) {
            // Пропускаем ASM < 9.9 (конфликтует с Fabric)
            if (jar.includes('org' + path.sep + 'ow2' + path.sep + 'asm') || jar.includes('org/ow2/asm')) {
                const vm = jar.match(/asm[/\\](\d+)\.(\d+)/);
                if (vm) {
                    const maj = parseInt(vm[1]);
                    const min = parseInt(vm[2]);
                    if (maj < 9 || (maj === 9 && min < 9)) {
                        continue;
                    }
                }
            }
            if (!classpath.includes(jar)) {
                classpath.push(jar);
            }
        }

        // Добавляем моды
        const modsPath = path.join(minecraftPath, 'mods');
        if (await fs.existsSync(modsPath)) {
            const allFiles = await fs.readdirSync(modsPath);
            const mods = allFiles.filter(f => f.endsWith('.jar'));
            for (const mod of mods) {
                classpath.push(path.join(modsPath, mod));
            }
        }
    }

    // Диагностика: проверяем наличие критичных библиотек
    const hasJoptSimple = classpath.some(p => p.toLowerCase().includes('jopt-simple') || p.toLowerCase().includes('joptsimple'));
    const hasLog4j = classpath.some(p => p.toLowerCase().includes('log4j'));
    const hasGuava = classpath.some(p => p.toLowerCase().includes('guava'));
    console.log('Classpath diagnostics - joptsimple:', hasJoptSimple, 'log4j:', hasLog4j, 'guava:', hasGuava);

    const classpathString = classpath.join(path.delimiter);
    console.log('Classpath contains', classpath.length, 'entries');
    return classpathString;
}

// Dual export
const _LauncherModule = {
    launchMinecraft,
    _launchWithMeta,
    runMinecraft,
    continueMinecraftLaunch,
    getMinecraftClasspath
};
if (typeof window !== 'undefined') { window.LauncherModule = _LauncherModule; }
if (typeof module !== 'undefined' && module.exports) { module.exports = _LauncherModule; }
})();