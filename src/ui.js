/**
 * UI модуль для управления интерфейсом
 * @module ui
 */

const { debounce } = require('./utils');

/**
 * Показать модальное окно
 * @param {string} message
 * @param {string} title
 * @returns {Promise}
 */
function showModal (message, title = 'Сообщение') {
    return new Promise((resolve) => {
        const overlay = document.getElementById('launcher-modal-overlay');
        const titleEl = document.getElementById('launcher-modal-title');
        const messageEl = document.getElementById('launcher-modal-message');
        const buttonsEl = document.getElementById('launcher-modal-buttons');

        if (!overlay || !messageEl) {
            resolve();
            return;
        }

        titleEl.textContent = title;
        messageEl.textContent = String(message);
        buttonsEl.innerHTML = '';

        const okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.className = 'launcher-modal-btn launcher-modal-btn-primary';
        okBtn.textContent = 'OK';
        buttonsEl.appendChild(okBtn);

        overlay.style.display = 'flex';
        overlay.setAttribute('aria-hidden', 'false');

        okBtn.addEventListener('click', () => {
            overlay.style.display = 'none';
            overlay.setAttribute('aria-hidden', 'true');
            resolve();
        });
    });
}

/**
 * Показать модальное окно с подтверждением
 * @param {string} message
 * @param {string} title
 * @returns {Promise<boolean>}
 */
function showConfirm (message, title = 'Подтверждение') {
    return new Promise((resolve) => {
        const overlay = document.getElementById('launcher-modal-overlay');
        const titleEl = document.getElementById('launcher-modal-title');
        const messageEl = document.getElementById('launcher-modal-message');
        const buttonsEl = document.getElementById('launcher-modal-buttons');

        if (!overlay || !messageEl) {
            resolve(false);
            return;
        }

        titleEl.textContent = title;
        messageEl.textContent = String(message);
        buttonsEl.innerHTML = '';

        const okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.className = 'launcher-modal-btn launcher-modal-btn-primary';
        okBtn.textContent = 'OK';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'launcher-modal-btn launcher-modal-btn-secondary';
        cancelBtn.textContent = 'Отмена';

        buttonsEl.appendChild(okBtn);
        buttonsEl.appendChild(cancelBtn);

        overlay.style.display = 'flex';
        overlay.setAttribute('aria-hidden', 'false');

        const cleanup = () => {
            overlay.style.display = 'none';
            overlay.setAttribute('aria-hidden', 'true');
        };

        okBtn.addEventListener('click', () => {
            cleanup();
            resolve(true);
        });

        cancelBtn.addEventListener('click', () => {
            cleanup();
            resolve(false);
        });
    });
}

/**
 * Показать панель прогресса
 */
function showProgress () {
    const overlay = document.getElementById('progress-overlay');
    if (overlay) {
        overlay.style.display = 'flex';
    }
}

/**
 * Скрыть панель прогресса
 */
function hideProgress () {
    const overlay = document.getElementById('progress-overlay');
    if (overlay) {
        overlay.style.display = 'none';
    }
}

/**
 * Обновить прогресс
 * @param {number} percent
 * @param {string} text
 */
function updateProgress (percent, text) {
    const progressBar = document.getElementById('progress-bar');
    const progressText = document.getElementById('progress-text');

    if (progressBar) {
        progressBar.style.width = percent + '%';
    }
    if (progressText) {
        progressText.textContent = text || 'Загрузка...';
    }
}

/**
 * Инициализация вкладок
 * @param {Function} onTabChange
 */
function initTabs (onTabChange) {
    const tabs = document.querySelectorAll('.tab');

    tabs.forEach((tab, index) => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            const mainPanel = document.getElementById('main-panel');
            const newsPanel = document.getElementById('news-panel');
            const settingsPanel = document.getElementById('settings-panel');
            const modsPanel = document.getElementById('mods-panel');
            const aboutPanel = document.getElementById('about-panel');
            const allPanels = [mainPanel, newsPanel, settingsPanel, modsPanel, aboutPanel];

            let targetPanel = null;
            if (index === 0) targetPanel = mainPanel;
            else if (index === 1) targetPanel = newsPanel;
            else if (index === 2) targetPanel = settingsPanel;
            else if (index === 3) targetPanel = modsPanel;
            else if (index === 4) targetPanel = aboutPanel;

            allPanels.forEach(panel => {
                if (panel && panel !== targetPanel) {
                    panel.classList.remove('active');
                    panel.classList.add('fade-out');
                    setTimeout(() => {
                        if (panel !== targetPanel) {
                            panel.style.display = 'none';
                            panel.classList.remove('fade-out');
                        }
                    }, 200);
                }
            });

            if (targetPanel) {
                targetPanel.style.display = 'block';
                setTimeout(() => {
                    targetPanel.classList.add('active');
                    targetPanel.classList.remove('fade-out');
                }, 10);

                if (onTabChange) {
                    onTabChange(index, targetPanel);
                }
            }
        });
    });
}

/**
 * Инициализация ссылок для открытия в браузере
 */
function initLinks () {
    const linkButtons = document.querySelectorAll('.link-btn, .creator-name');

    linkButtons.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const url = link.getAttribute('href');
            if (url && window.electronAPI) {
                // Для внешних ссылок используем shell
                const { shell } = require('electron');
                shell.openExternal(url);
            }
        });
    });
}

/**
 * Инициализация кнопок управления окном
 */
function initWindowControls () {
    const closeBtn = document.getElementById('btn-close');
    const minimizeBtn = document.getElementById('btn-minimize');
    const maximizeBtn = document.getElementById('btn-maximize');

    if (closeBtn && window.electronAPI) {
        closeBtn.addEventListener('click', () => window.electronAPI.closeWindow());
    }

    if (minimizeBtn && window.electronAPI) {
        minimizeBtn.addEventListener('click', () => window.electronAPI.minimizeWindow());
    }

    if (maximizeBtn && window.electronAPI) {
        maximizeBtn.addEventListener('click', () => window.electronAPI.maximizeWindow());
    }
}

/**
 * Инициализация тем
 */
function initThemes () {
    const themeCircles = document.querySelectorAll('.theme-circle');
    const savedTheme = localStorage.getItem('theme') || 'blue';

    // Применяем сохранённую тему
    document.documentElement.setAttribute('data-theme', savedTheme);

    themeCircles.forEach(circle => {
        circle.addEventListener('click', () => {
            const theme = circle.getAttribute('data-theme');
            document.documentElement.setAttribute('data-theme', theme);
            localStorage.setItem('theme', theme);
        });
    });
}

/**
 * Инициализация слайдера RAM
 */
function initRamSlider () {
    const ramSlider = document.getElementById('ram-slider');
    const ramValue = document.getElementById('ram-value');

    if (ramSlider && ramValue) {
        const savedRam = localStorage.getItem('minecraft-ram') || '4';
        ramSlider.value = savedRam;
        ramValue.textContent = savedRam;

        ramSlider.addEventListener('input', (e) => {
            ramValue.textContent = e.target.value;
        });
    }
}

/**
 * Инициализация поиска с debounce
 * @param {string} inputId
 * @param {Function} onSearch
 */
function initSearch (inputId, onSearch) {
    const input = document.getElementById(inputId);
    if (!input) return;

    const debouncedSearch = debounce(onSearch, 300);
    input.addEventListener('input', (e) => {
        debouncedSearch(e.target.value);
    });
}

/**
 * Показать диалог с ошибками зависимостей модов
 * @param {Array} issues - массив объектов из parseDependencyError
 * @returns {Promise}
 */
function showDependencyError (issues) {
    const overlay = document.getElementById('launcher-modal-overlay');
    const titleEl = document.getElementById('launcher-modal-title');
    const messageEl = document.getElementById('launcher-modal-message');
    const buttonsEl = document.getElementById('launcher-modal-buttons');

    if (!overlay || !messageEl) return Promise.resolve();

    titleEl.textContent = '📦 Отсутствует зависимость мода';
    messageEl.innerHTML = '';

    const intro = document.createElement('p');
    intro.textContent = 'Один или несколько модов требуют дополнительные моды, которые не установлены.';
    intro.style.marginBottom = '10px';
    messageEl.appendChild(intro);

    const list = document.createElement('ul');
    list.style.cssText = 'margin: 0 0 12px 0; padding-left: 18px;';

    const seen = new Set();
    for (const issue of (issues || [])) {
        const key = issue.key || issue.missingMod;
        if (seen.has(key)) continue;
        seen.add(key);

        const li = document.createElement('li');
        li.style.marginBottom = '4px';

        const missingSpan = document.createElement('strong');
        missingSpan.textContent = issue.missingMod;
        missingSpan.style.color = '#e74c3c';

        if (issue.modName) {
            li.appendChild(document.createTextNode('Мод '));
            const modSpan = document.createElement('strong');
            modSpan.textContent = issue.modName;
            li.appendChild(modSpan);
            li.appendChild(document.createTextNode(' требует: '));
        } else {
            li.appendChild(document.createTextNode('Требуется: '));
        }
        li.appendChild(missingSpan);
        list.appendChild(li);
    }
    messageEl.appendChild(list);

    const hint = document.createElement('p');
    hint.style.cssText = 'font-size: 0.85em; opacity: 0.7; margin: 0;';
    hint.textContent = 'Найдите недостающий мод в разделе «Ресурсы» → «Поиск модов».';
    messageEl.appendChild(hint);

    buttonsEl.innerHTML = '';
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'launcher-modal-btn launcher-modal-btn-primary';
    okBtn.textContent = 'OK';
    buttonsEl.appendChild(okBtn);

    overlay.style.display = 'flex';
    overlay.setAttribute('aria-hidden', 'false');

    return new Promise((resolve) => {
        okBtn.addEventListener('click', () => {
            overlay.style.display = 'none';
            overlay.setAttribute('aria-hidden', 'true');
            resolve();
        });
    });
}

/**
 * Показать диалог с конфликтами модов
 * @param {Array} conflicts - массив объектов из detectModConflicts
 * @returns {Promise}
 */
function showConflictsError (conflicts) {
    const overlay = document.getElementById('launcher-modal-overlay');
    const titleEl = document.getElementById('launcher-modal-title');
    const messageEl = document.getElementById('launcher-modal-message');
    const buttonsEl = document.getElementById('launcher-modal-buttons');

    if (!overlay || !messageEl) return Promise.resolve();

    titleEl.textContent = '⚠️ Конфликт модов';
    messageEl.innerHTML = '';

    const intro = document.createElement('p');
    intro.textContent = 'Обнаружены несовместимые моды. Удалите один из каждой пары:';
    intro.style.marginBottom = '10px';
    messageEl.appendChild(intro);

    const list = document.createElement('ul');
    list.style.cssText = 'margin: 0 0 12px 0; padding-left: 18px;';

    for (const conflict of (conflicts || [])) {
        const li = document.createElement('li');
        li.style.marginBottom = '6px';

        const modASpan = document.createElement('strong');
        modASpan.textContent = conflict.modA || conflict.pair.split(' ↔ ')[0];
        modASpan.style.color = '#e74c3c';

        const modBSpan = document.createElement('strong');
        modBSpan.textContent = conflict.modB || conflict.pair.split(' ↔ ')[1];
        modBSpan.style.color = '#e74c3c';

        li.appendChild(modASpan);
        li.appendChild(document.createTextNode(' несовместим с '));
        li.appendChild(modBSpan);
        list.appendChild(li);
    }
    messageEl.appendChild(list);

    const hint = document.createElement('p');
    hint.style.cssText = 'font-size: 0.85em; opacity: 0.7; margin: 0;';
    hint.textContent = 'Перейдите в «Ресурсы» → «Мои моды» и удалите один из конфликтующих модов.';
    messageEl.appendChild(hint);

    buttonsEl.innerHTML = '';
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'launcher-modal-btn launcher-modal-btn-primary';
    okBtn.textContent = 'OK';
    buttonsEl.appendChild(okBtn);

    overlay.style.display = 'flex';
    overlay.setAttribute('aria-hidden', 'false');

    return new Promise((resolve) => {
        okBtn.addEventListener('click', () => {
            overlay.style.display = 'none';
            overlay.setAttribute('aria-hidden', 'true');
            resolve();
        });
    });
}


module.exports = {
    showModal,
    showConfirm,
    showDependencyError,
    showConflictsError,
    showProgress,
    hideProgress,
    updateProgress,
    initTabs,
    initLinks,
    initWindowControls,
    initThemes,
    initRamSlider,
    initSearch
};
