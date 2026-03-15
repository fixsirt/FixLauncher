/**
 * constants.js — единая точка для всех URL, ключей и магических строк.
 * Импортируй отсюда вместо того чтобы хардкодить в каждом файле.
 */

'use strict';

// ─── Внешние API ──────────────────────────────────────────────────────────────

const MOJANG_VERSION_MANIFEST = 'https://launchermeta.mojang.com/mc/game/version_manifest.json';
const MOJANG_PISTON_META      = 'https://piston-meta.mojang.com/v1/packages';
const MOJANG_RESOURCES        = 'https://resources.download.minecraft.net';

const FABRIC_VERSIONS_GAME    = 'https://meta.fabricmc.net/v2/versions/game';
const FABRIC_VERSIONS_LOADER  = 'https://meta.fabricmc.net/v2/versions/loader'; // + /<mcVersion>
const FABRIC_MAVEN            = 'https://maven.fabricmc.net/net/fabricmc';

const QUILT_VERSIONS_GAME     = 'https://meta.quiltmc.org/v3/versions/game';
const QUILT_VERSIONS_LOADER   = 'https://meta.quiltmc.org/v3/versions/loader';

const FORGE_PROMOTIONS        = 'https://files.minecraftforge.net/maven/net/minecraftforge/forge/promotions_slim.json';

const NEOFORGE_MAVEN_META     = 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml';

const ADOPTIUM_ASSETS         = 'https://api.adoptium.net/v3/assets/latest/21/hotspot?os=windows&architecture=x64&image_type=jdk&vendor=eclipse';

const MODRINTH_API            = 'https://api.modrinth.com/v2';
const MODRINTH_USER_AGENT     = 'FixLauncher/2.0 (https://t.me/rodfix_perehod)';

const MYMEMORY_TRANSLATE_API  = 'https://api.mymemory.translated.net/get';

// ─── GitHub ───────────────────────────────────────────────────────────────────

const GITHUB_OWNER            = 'fixsirt';
const GITHUB_REPO             = 'FixLauncher';
const GITHUB_BRANCH           = 'main';
const GITHUB_RAW              = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}`;
const GITHUB_API              = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`;
const GITHUB_RELEASES_URL     = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`;
const GITHUB_RELEASES_LATEST  = `${GITHUB_RELEASES_URL}/latest`;

const NEWS_MD_URL             = `${GITHUB_RAW}/NEWS.md`;
const SERVERS_JSON_URL        = `${GITHUB_RAW}/servers.json`;

// ─── Evacuation (кастомная сборка) ───────────────────────────────────────────

const EVACUATION_GITHUB_OWNER = 'stalker22072003-cell';
const EVACUATION_GITHUB_REPO  = 'sborka_modov';
const EVACUATION_MC_VERSION   = '1.21.4';
const EVACUATION_GITHUB_URL   = `https://github.com/${EVACUATION_GITHUB_OWNER}/${EVACUATION_GITHUB_REPO}`;

// ─── localStorage ключи ───────────────────────────────────────────────────────

const STORAGE_KEYS = {
    selectedVersion:  'launcher-selected-version',
    minecraftPath:    'minecraft-path',
    jvmSelectedFlags: 'jvm-selected-flags',
    jvmCustomArgs:    'minecraft-args',
    launcherTheme:    'launcher-theme',
    turboMode:        'launcher-turbo-mode',
    playtime:         'launcher-playtime',
};

// ─── Прочее ───────────────────────────────────────────────────────────────────

const DEFAULT_VERSION_ID      = '';
const ZIP_TIMEOUT_MS          = 300_000;
const SIZE_CACHE_TTL_MS       = 30_000;
const WATCHER_DEBOUNCE_MS     = 400;
const MC_VERSIONS_CACHE_TTL   = 5 * 60_000;

// Dual export: module.exports для Node.js/main-процесса, window.* для renderer/браузера
const _RendererConstants = {
    MOJANG_VERSION_MANIFEST,
    MOJANG_PISTON_META,
    MOJANG_RESOURCES,
    FABRIC_VERSIONS_GAME,
    FABRIC_VERSIONS_LOADER,
    FABRIC_MAVEN,
    QUILT_VERSIONS_GAME,
    QUILT_VERSIONS_LOADER,
    FORGE_PROMOTIONS,
    NEOFORGE_MAVEN_META,
    ADOPTIUM_ASSETS,
    MODRINTH_API,
    MODRINTH_USER_AGENT,
    MYMEMORY_TRANSLATE_API,
    GITHUB_OWNER,
    GITHUB_REPO,
    GITHUB_BRANCH,
    GITHUB_RAW,
    GITHUB_API,
    GITHUB_RELEASES_URL,
    GITHUB_RELEASES_LATEST,
    NEWS_MD_URL,
    SERVERS_JSON_URL,
    EVACUATION_GITHUB_OWNER,
    EVACUATION_GITHUB_REPO,
    EVACUATION_MC_VERSION,
    EVACUATION_GITHUB_URL,
    STORAGE_KEYS,
    DEFAULT_VERSION_ID,
    ZIP_TIMEOUT_MS,
    SIZE_CACHE_TTL_MS,
    WATCHER_DEBOUNCE_MS,
    MC_VERSIONS_CACHE_TTL,
    // Пункт 4: имена папок данных лаунчера вынесены в константы
    LAUNCHER_DIR_WIN:    '.fixlauncher',
    LAUNCHER_DIR_MAC:    'fixlauncher',
    LAUNCHER_DIR_LINUX:  '.fixlauncher',
    // П.5: имя файла лога (main-процесс использует path.join(__dirname, LOG_FILE_NAME))
    LOG_FILE_NAME:       'debug.log',
};
if (typeof window !== 'undefined') { window.RendererConstants = _RendererConstants; }
if (typeof module !== 'undefined' && module.exports) { module.exports = _RendererConstants; }
