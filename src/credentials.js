/**
 * Модуль управления учётными данными
 * @module credentials
 */

const path = require('path');
const fs = require('fs');
const { getVanillaSunsPath } = require('./settings');

/**
 * Сохранить учётные данные
 * @param {string} username
 * @param {string} password
 */
function saveCredentials (username, password) {
    try {
        const vanillaSunsPath = getVanillaSunsPath();
        const credentialsPath = path.join(vanillaSunsPath, 'credentials.json');

        if (!fs.existsSync(vanillaSunsPath)) {
            fs.mkdirSync(vanillaSunsPath, { recursive: true });
        }

        const credentials = {
            username: username || '',
            password: password || ''
        };

        fs.writeFileSync(credentialsPath, JSON.stringify(credentials, null, 2), 'utf8');
        console.log('Credentials saved successfully');
    } catch (error) {
        console.error('Error saving credentials:', error);
    }
}

/**
 * Загрузить учётные данные
 * @returns {Object}
 */
function loadCredentials () {
    try {
        const vanillaSunsPath = getVanillaSunsPath();
        const credentialsPath = path.join(vanillaSunsPath, 'credentials.json');

        if (fs.existsSync(credentialsPath)) {
            const data = fs.readFileSync(credentialsPath, 'utf8');
            const credentials = JSON.parse(data);
            return {
                username: credentials.username || '',
                password: credentials.password || ''
            };
        }
    } catch (error) {
        console.error('Error loading credentials:', error);
    }

    return { username: '', password: '' };
}

module.exports = {
    saveCredentials,
    loadCredentials
};
