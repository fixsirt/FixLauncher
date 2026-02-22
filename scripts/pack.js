const packager = require('electron-packager');
const path = require('path');
const fs = require('fs');

async function build() {
    console.log('📦 Сборка лаунчера...');
    
    const opts = {
        dir: path.join(__dirname, '..'),
        name: 'VanillaSunsLauncher',
        platform: 'win32',
        arch: 'x64',
        electronVersion: '39.2.7',
        icon: path.join(__dirname, '..', 'logo.png'),
        out: path.join(__dirname, '..', 'dist'),
        overwrite: true,
        asar: {
            unpackDir: '{node_modules/adm-zip,node_modules/electron-updater}'
        },
        prune: true,
        ignore: [
            /^\/node_modules\/(?!adm-zip|electron-updater)/,
            /^\/__tests__\//,
            /^\/\.git/,
            /^\/\.vscode/,
            /^\/\.idea/,
            /^\/dist\//,
            /^\/build\//,
            /\.md$/,
            /\.txt$/,
            /^\/scripts\//,
            /^\/optimize-build\.ps1$/
        ]
    };

    try {
        const appPaths = await packager(opts);
        console.log('✅ Сборка завершена!');
        console.log('📁 Путь:', appPaths[0]);
        
        // Удаляем лишние файлы после сборки
        const appPath = appPaths[0];
        const resourcesPath = path.join(appPath, 'resources');
        
        // Проверяем размер
        const appSize = getFileSize(resourcesPath);
        console.log(`📊 Размер resources: ${(appSize / 1024 / 1024).toFixed(2)} MB`);
        
    } catch (error) {
        console.error('❌ Ошибка сборки:', error);
        process.exit(1);
    }
}

function getFileSize(dir) {
    let size = 0;
    const items = fs.readdirSync(dir);
    for (const item of items) {
        const itemPath = path.join(dir, item);
        const stat = fs.statSync(itemPath);
        if (stat.isDirectory()) {
            size += getFileSize(itemPath);
        } else {
            size += stat.size;
        }
    }
    return size;
}

build();
