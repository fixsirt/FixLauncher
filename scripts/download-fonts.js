#!/usr/bin/env node
/**
 * Скрипт для скачивания шрифтов Inter и Space Grotesk локально.
 * Запустить один раз: node scripts/download-fonts.js
 * После этого шрифты будут загружаться из assets/fonts/ без интернета.
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const FONTS_DIR = path.join(__dirname, '..', 'assets', 'fonts');
fs.mkdirSync(FONTS_DIR, { recursive: true });

// URL-ы актуальных woff2 с Google Fonts (получены через https://fonts.googleapis.com)
const FONTS = [
    // Inter (переменный шрифт — один файл для всех начертаний 100–900)
    {
        file: 'inter-variable.woff2',
        url:  'https://fonts.gstatic.com/s/inter/v13/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMw2boKoduKmMEVuLyfAZ9hiJ-Ek-_EeA.woff2',
    },
    // Space Grotesk — 500, 600, 700
    {
        file: 'space-grotesk-variable.woff2',
        url:  'https://fonts.gstatic.com/s/spacegrotesk/v16/V8mQoQDjQSkFtoMM3T6r8E7mF71Q-gOoraIAEj7oUXskPMBBSSJLm2E.woff2',
    },
];

function download(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, res => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                file.close();
                return download(res.headers.location, dest).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                file.close();
                fs.unlinkSync(dest);
                return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            }
            res.pipe(file);
            file.on('finish', () => { file.close(); resolve(); });
        }).on('error', err => { fs.unlinkSync(dest); reject(err); });
    });
}

(async () => {
    for (const font of FONTS) {
        const dest = path.join(FONTS_DIR, font.file);
        if (fs.existsSync(dest) && fs.statSync(dest).size > 10000) {
            console.log(`✓ ${font.file} already exists`);
            continue;
        }
        process.stdout.write(`  Downloading ${font.file}... `);
        try {
            await download(font.url, dest);
            const kb = Math.round(fs.statSync(dest).size / 1024);
            console.log(`OK (${kb} KB)`);
        } catch (e) {
            console.log(`FAILED: ${e.message}`);
        }
    }
    console.log('\nDone! You can now remove the Google Fonts <link> tags from index.html.');
})();
