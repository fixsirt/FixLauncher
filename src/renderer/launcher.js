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
const { getVanillaSunsPath, loadCredentials } = window.SettingsPanel;
const { checkAndDownloadVersion, extractNatives } = window.Installer;
const { ensureJava, checkJavaVersion } = window.JavaModule;

function launchMinecraft() {
    showProgress();
    updateProgress(0, 'Инициализация...');

    const playerName = document.getElementById('player-name').value || 'Player';
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
        minecraftFolderName = 'minecraft-' + String(versionType).replace(/:/g, '-').replace(/[^a-zA-Z0-9.-]/g, '-');
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

    ensureJava(baseMinecraftPath, javaPath).then(async (finalJavaPath) => {
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
                const [loaderType, loaderMcVer] = versionType.includes(':') ? versionType.split(':') : ['vanilla', versionType];
                const instanceMeta = {
                    mcVersion:     loaderMcVer || versionString,
                    loader:        loaderType !== 'release' ? loaderType : 'vanilla',
                    loaderVersion: null,
                    created:       new Date().toISOString(),
                    name:          null, // будет сгенерировано из имени папки
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

        // Определяем минимальную версию Java в зависимости от версии MC:
        // MC 1.20.5+ → Java 21+, MC 1.17-1.20.4 → Java 17+, MC < 1.17 → Java 8+
        function getRequiredJava(mcVer) {
            if (!mcVer) return 21;
            const parts = mcVer.replace(/-.*/, '').split('.').map(Number);
            const maj = parts[1] || 0;
            const min = parts[2] || 0;
            if (maj > 20 || (maj === 20 && min >= 5)) return 21;
            if (maj >= 17) return 17;
            return 8;
        }
        const mcVersionForJava = (selectedVer && selectedVer.mcVersion) ? selectedVer.mcVersion : '1.21.4';
        const requiredJava = getRequiredJava(mcVersionForJava);

        if (javaVersion < requiredJava) {
            hideProgress();
            resetPlayButton();
            showLauncherAlert(`Ошибка: Несовместимая версия Java!\n\nMinecraft ${mcVersionForJava} требует Java ${requiredJava}+.\nОбнаружена Java ${javaVersion}.\n\nУстановите Java ${requiredJava}+ и укажите путь в настройках.\nТекущий путь: ${javaPath}`);
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

        let mainClass = 'net.minecraft.client.main.Main';
        if (withMods) {
            mainClass = 'net.fabricmc.loader.impl.launch.knot.KnotClient';
        }

        if (!await fs.existsSync(nativesPath)) {
            await fs.mkdirSync(nativesPath, { recursive: true });
        }

        // FIX: await при чтении version.json
        let assetIndex = '1.21';
        let versionJsonGameArgs = []; // аргументы игры из version.json (с подстановкой переменных)
        try {
            if (await fs.existsSync(versionJsonPath)) {
                const versionFileContent = await fs.readFileSync(versionJsonPath, 'utf8');
                const versionData = JSON.parse(versionFileContent);
                if (versionData.assetIndex && versionData.assetIndex.id) {
                    assetIndex = versionData.assetIndex.id;
                    console.log('Using assetIndex from version.json:', assetIndex);
                }
                // Читаем game arguments из version.json для подстановки auth-переменных
                // Это критично для Minecraft 1.13+ где аргументы идут из version.json
                const rawArgs = versionData.minecraftArguments
                    ? versionData.minecraftArguments.split(' ')
                    : (versionData.arguments && Array.isArray(versionData.arguments.game))
                        ? versionData.arguments.game.filter(a => typeof a === 'string')
                        : [];
                console.log('[launcher] version.json game args count:', rawArgs.length);
                // Сохраняем для последующей подстановки (не используем напрямую,
                // т.к. наш лаунчер добавляет их сам ниже)
                versionJsonGameArgs = rawArgs;
            }
        } catch (e) {
            console.warn('Could not read assetIndex from version.json, using default:', e);
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

        const uuidKey = `player-uuid-${playerName}`;
        let playerUUID = localStorage.getItem(uuidKey);

        if (!playerUUID) {
            playerUUID = await window.electronAPI.crypto.offlineUUID(playerName);
            localStorage.setItem(uuidKey, playerUUID);
            console.log('Generated offline UUID for player:', playerName, '->', playerUUID);
        } else {
            console.log('Using saved offline UUID for player:', playerName, '->', playerUUID);
        }

        // FIX: await при работе с usercache.json
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

        // Дедупликация не нужна — аргументы теперь добавляются строго один раз

        // Для офлайн-режима: accessToken должен быть непустым hex-строкой (не '0'),
        // userType 'mojang' обходит проверку "Multiplayer is disabled" в 1.16+
        const fakeToken = playerUUID.replace(/-/g, '') + '00000000000000000000000000000000'.slice(playerUUID.replace(/-/g,'').length);

        // Если version.json содержит minecraftArguments или arguments.game — подставляем переменные
        // и НЕ дублируем аргументы. Иначе добавляем вручную.
        const authVars = {
            '${auth_player_name}': playerName,
            '${auth_uuid}': playerUUID,
            '${auth_access_token}': fakeToken,
            '${auth_session}': fakeToken,
            '${user_type}': 'mojang',
            '${version_type}': 'release',
            '${version_name}': version,
            '${game_directory}': minecraftPath,
            '${assets_root}': path.join(minecraftPath, 'assets'),
            '${assets_index_name}': assetIndex,
            '${user_properties}': '{}',
            '${clientid}': playerUUID.replace(/-/g,''),
            '${auth_xuid}': '0',
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
            '--accessToken', fakeToken,
            '--userType', 'mojang',
            '--versionType', 'release',
            '--lang', 'ru_RU'
        );

        console.log('=== Launching Minecraft in FULL offline mode (NOT demo) - like T-launcher ===');
        console.log('Player name:', playerName);
        console.log('Player UUID (offline):', playerUUID);
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

        // Записываем launcher_profiles.json с фейковым авторизованным профилем
        // Это необходимо для Minecraft 1.16+ который проверяет наличие профиля
        try {
            const lpPath = window.electronAPI.path.join(minecraftPath, 'launcher_profiles.json');
            const clientToken = playerUUID.replace(/-/g, '');
            const fakeAccessToken2 = fakeToken;
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
                        accessToken: fakeAccessToken2,
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
            await window.electronAPI.fs.writeFileSync(lpPath, JSON.stringify(profileData, null, 2), 'utf8');
            console.log('[launcher] launcher_profiles.json written for offline multiplayer');
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

        // Discord RPC
        try {
            const _pn = document.getElementById('player-name')?.value || 'Player';
            const _sv = getSelectedVersion();
            const _vl = _sv?.label || _sv?.id || 'Minecraft';
            window.electronAPI.discordSetPlaying(_pn, _vl).catch(() => {});
        } catch { /* ignore */ }

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

    if (await fs.existsSync(versionJsonPath)) {
        try {
            // FIX: await при чтении version.json
            const versionFileContent = await fs.readFileSync(versionJsonPath, 'utf8');
            const versionData = JSON.parse(versionFileContent);

            if (versionData.libraries) {
                // Mojang version.json uses 'windows'/'osx'/'linux', NOT 'win32'/'darwin'
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

                    if (shouldInclude && lib.downloads?.artifact?.path) {
                        const libPath = path.join(libsPath, lib.downloads.artifact.path);
                        // FIX: await при проверке существования библиотеки
                        if (await fs.existsSync(libPath)) {
                            classpath.push(libPath);
                        } else {
                            console.warn('Library not found:', libPath, 'for library:', lib.name);
                        }
                    } else if (shouldInclude && !lib.downloads?.artifact && lib.name) {
                        // Старый формат (до 1.19): нет downloads.artifact — вычисляем Maven путь из имени
                        const parts = lib.name.split(':');
                        if (parts.length >= 3) {
                            const [group, artifact, ver] = parts;
                            const groupPath = group.replace(/\./g, '/');
                            const fileName = `${artifact}-${ver}.jar`;
                            const mavenRelPath = `${groupPath}/${artifact}/${ver}/${fileName}`;
                            const libPath = path.join(libsPath, mavenRelPath);
                            if (await fs.existsSync(libPath)) {
                                classpath.push(libPath);
                            }
                        }
                    }
                }
            }

            // Добавляем клиентский jar
            const clientJar = path.join(versionsPath, version + '.jar');
            if (await fs.existsSync(clientJar)) {
                classpath.push(clientJar);
            }
        } catch (error) {
            console.error('Error reading version.json:', error);
            const jarFile = path.join(versionsPath, version + '.jar');
            if (await fs.existsSync(jarFile)) {
                classpath.push(jarFile);
            }
        }
    } else {
        const jarFile = path.join(versionsPath, version + '.jar');
        if (await fs.existsSync(jarFile)) {
            classpath.push(jarFile);
        }
    }

    if (withMods) {
        // Исключаем старые версии ASM (< 9.9)
        classpath = classpath.filter(jarPath => {
            if (jarPath.includes('org/ow2/asm') || jarPath.includes('org\\ow2\\asm')) {
                const vm = jarPath.match(/asm[/\\](\d+)\.(\d+)/);
                if (vm) {
                    const maj = parseInt(vm[1]);
                    const min = parseInt(vm[2]);
                    if (maj < 9 || (maj === 9 && min < 9)) {
                        console.log('Excluding old ASM version from classpath:', jarPath);
                        return false;
                    }
                }
            }
            return true;
        });

        // Рекурсивный поиск jar-файлов (async)
        const findJars = async (dir) => {
            const jars = [];
            try {
                const entries = await fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory) {  // boolean, not a function
                        jars.push(...await findJars(fullPath));
                    } else if (!entry.isDirectory && entry.name.endsWith('.jar')) {
                        jars.push(fullPath);
                    }
                }
            } catch (e) {
                console.warn('Error reading directory:', dir, e);
            }
            return jars;
        };

        // Добавляем ASM 9.9+
        const asmLibsPath = path.join(minecraftPath, 'libraries', 'org', 'ow2', 'asm');
        if (await fs.existsSync(asmLibsPath)) {
            const asmJars = await findJars(asmLibsPath);
            for (const jar of asmJars) {
                const vm = jar.match(/asm[/\\](\d+)\.(\d+)/);
                if (vm) {
                    const maj = parseInt(vm[1]);
                    const min = parseInt(vm[2]);
                    if (maj > 9 || (maj === 9 && min >= 9)) {
                        if (!classpath.includes(jar)) {
                            classpath.push(jar);
                            console.log('Added ASM library to classpath:', jar);
                        }
                    } else {
                        console.log('Skipping old ASM version:', jar);
                    }
                } else if (!classpath.includes(jar)) {
                    classpath.push(jar);
                    console.log('Added ASM library to classpath (version unknown):', jar);
                }
            }
        }

        // Добавляем Fabric Loader библиотеки
        const fabricLibsPath = path.join(minecraftPath, 'libraries', 'net', 'fabricmc');
        if (await fs.existsSync(fabricLibsPath)) {
            const fabricJars = await findJars(fabricLibsPath);
            for (const jar of fabricJars) {
                if (!classpath.includes(jar)) {
                    classpath.push(jar);
                    console.log('Added Fabric library to classpath:', jar);
                }
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