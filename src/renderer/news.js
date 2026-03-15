(function() {
'use strict';

/**
 * Новостная панель — загрузка, рендер Markdown, навигация по ссылкам
 * @module renderer/news
 */

const { renderMd, escapeHtmlText } = window.RendererUtils;
const { showNewsSkeleton } = window.UiHelpers;

let _newsLoaded = false;

async function loadNews() {
    const listEl = document.getElementById('news-list');
    const loadingEl = document.getElementById('news-loading');
    const errorEl = document.getElementById('news-error');
    if (!listEl || !loadingEl || !errorEl) return;

    // Уже загружено — не перезагружаем
    if (_newsLoaded && listEl.children.length > 0) return;

    showNewsSkeleton();
    errorEl.style.display = 'none';

    try {
        const result = await window.electronAPI.getNews();
        loadingEl.style.display = 'none';
        _newsLoaded = true;

        if (!result.ok || !result.items || result.items.length === 0) {
            listEl.innerHTML = '';
            errorEl.textContent = result.error || 'Новостей пока нет.';
            errorEl.style.display = 'block';
            return;
        }

        listEl.innerHTML = '';
        result.items.forEach((item) => {
            const card = document.createElement('article');
            card.className = 'news-card';
            card.innerHTML = `
                <h2 class="news-card-title">${escapeHtmlText(item.title)}</h2>
                ${item.date ? `<time class="news-card-date">${escapeHtmlText(item.date)}</time>` : ''}
                <div class="news-card-content">${renderMd(item.body)}</div>
            `;
            listEl.appendChild(card);
        });
    } catch (err) {
        listEl.innerHTML = '';
        errorEl.textContent = 'Ошибка: ' + (err.message || 'неизвестная ошибка');
        errorEl.style.display = 'block';
    }
}


// Клик по ссылкам в новостях — открытие во внешнем браузере (делегирование)
function initNewsLinks() {
    const listEl = document.getElementById('news-list');
    if (!listEl) return;
    listEl.addEventListener('click', (e) => {
        const a = e.target.closest('a');
        if (a && a.href && a.getAttribute('href').startsWith('http')) {
            e.preventDefault();
            window.electronAPI.openExternal(a.href);
        }
    });
}

// Скроллбар новостей: показывать при прокрутке/наведении
function initNewsScrollbar() {
    const container = document.getElementById('news-container');
    if (!container) return;
    let scrollTimeout = null;
    container.addEventListener('scroll', () => {
        container.classList.add('scrolling');
        if (scrollTimeout) clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(() => {
            container.classList.remove('scrolling');
            scrollTimeout = null;
        }, 800);
    });
}

// Dual export: window.* для renderer, module.exports для Node.js/main
const _RendererNews = { loadNews, initNewsLinks, initNewsScrollbar };
if (typeof window !== 'undefined') { window.RendererNews = _RendererNews; }
if (typeof module !== 'undefined' && module.exports) { module.exports = _RendererNews; }
})();
