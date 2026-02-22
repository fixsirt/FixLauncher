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

module.exports = {
    showModal,
    showConfirm,
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
