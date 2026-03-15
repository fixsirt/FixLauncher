(function() {
'use strict';

/**
 * Панель скриншотов — показывает скриншоты из ВСЕХ версий и инстансов.
 * initScreenshots() вызывается БЕЗ аргумента из renderer.js — контейнер
 * ищем сами через getElementById.
 */

const { showLauncherAlert, showLauncherConfirm } = window.UiHelpers;

function formatVersionLabel(dir, displayName) {
    if (displayName) return displayName;
    if (!dir) return '?';

    let label = dir.replace(/^minecraft-/, '');
    if      (label.startsWith('fabric-'))  label = label.replace('fabric-', '')  + ' (Fabric)';
    else if (label.startsWith('release-')) label = label.replace('release-', '');
    else if (label.startsWith('quilt-'))   label = label.replace('quilt-', '')   + ' (Quilt)';
    else if (label.startsWith('forge-'))   label = label.replace('forge-', '')   + ' (Forge)';
    return label || dir;
}

function formatDate(mtime) {
    if (!mtime) return '';
    const d = new Date(mtime);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function collectAllScreenshots() {
    try {
        const basePath = await window.electronAPI.launcher.basePath();
        if (!basePath) {
            console.error('[screenshots] launcher.basePath() returned empty');
            return [];
        }
        console.log('[screenshots] scanning:', basePath);
        const result = await window.electronAPI.screenshots.list(basePath);
        console.log('[screenshots] found', result.length, 'screenshots');
        return result;
    } catch (e) {
        console.error('[screenshots] error:', e);
        return [];
    }
}

// ── Состояние модуля (живёт в замыкании IIFE) ─────────────────────────────────
let allScreenshots      = [];
let filteredScreenshots = [];
let activeFilter        = 'all';
let searchQuery         = '';
let lightboxIdx         = 0;
let lightboxInited      = false;

function initLightbox() {
    if (lightboxInited) return;
    lightboxInited = true;

    const lightbox = document.getElementById('ss-lightbox');
    if (!lightbox) return;

    // Добавляем кнопки prev / next если их ещё нет
    if (!document.getElementById('ss-lb-prev')) {
        const actions = lightbox.querySelector('.ss-lightbox-actions');
        if (actions) {
            const prev = document.createElement('button');
            prev.id = 'ss-lb-prev';
            prev.className = 'ss-lb-btn';
            prev.title = 'Предыдущий (←)';
            prev.style.cssText = 'font-size:18px;line-height:1;padding:3px 10px;';
            prev.textContent = '‹';

            const next = document.createElement('button');
            next.id = 'ss-lb-next';
            next.className = 'ss-lb-btn';
            next.title = 'Следующий (→)';
            next.style.cssText = 'font-size:18px;line-height:1;padding:3px 10px;';
            next.textContent = '›';

            actions.insertBefore(next, actions.firstChild);
            actions.insertBefore(prev, actions.firstChild);

            prev.addEventListener('click', () => navigateLightbox(-1));
            next.addEventListener('click', () => navigateLightbox(1));
        }
    }

    const lbBg     = document.getElementById('ss-lightbox-bg');
    const lbClose  = document.getElementById('ss-lb-close');
    const lbCopy   = document.getElementById('ss-lb-copy');
    const lbFolder = document.getElementById('ss-lb-folder');
    const lbDelete = document.getElementById('ss-lb-delete');

    if (lbBg)    lbBg.addEventListener('click', closeLightbox);
    if (lbClose) lbClose.addEventListener('click', closeLightbox);

    if (lbCopy) lbCopy.addEventListener('click', async () => {
        const ss = filteredScreenshots[lightboxIdx];
        if (!ss) return;
        try {
            const dataUrl = await window.electronAPI.fs.readBinaryDataUrl(ss.filePath);
            if (dataUrl) await window.electronAPI.copyImageToClipboard(dataUrl, ss.file);
        } catch (e) { console.warn('[screenshots] copy error:', e); }
    });

    if (lbFolder) lbFolder.addEventListener('click', () => {
        const ss = filteredScreenshots[lightboxIdx];
        if (!ss) return;
        window.electronAPI.openPath(window.electronAPI.path.dirname(ss.filePath));
    });

    if (lbDelete) lbDelete.addEventListener('click', async () => {
        const ss = filteredScreenshots[lightboxIdx];
        if (!ss) return;
        const confirmed = await showLauncherConfirm(`Удалить скриншот ${ss.file}?`);
        if (!confirmed) return;
        const ok = await window.electronAPI.screenshots.delete(ss.filePath);
        if (ok) {
            allScreenshots      = allScreenshots.filter(s => s !== ss);
            filteredScreenshots = filteredScreenshots.filter(s => s !== ss);
            if (!filteredScreenshots.length) {
                closeLightbox();
            } else {
                lightboxIdx = Math.min(lightboxIdx, filteredScreenshots.length - 1);
                openLightbox(lightboxIdx);
            }
            rerender();
        } else {
            showLauncherAlert('Не удалось удалить скриншот.');
        }
    });

    document.addEventListener('keydown', (e) => {
        const lb = document.getElementById('ss-lightbox');
        if (!lb || lb.style.display === 'none') return;
        if (e.key === 'Escape')      closeLightbox();
        if (e.key === 'ArrowLeft')   navigateLightbox(-1);
        if (e.key === 'ArrowRight')  navigateLightbox(1);
    });
}

function openLightbox(idx) {
    const lightbox = document.getElementById('ss-lightbox');
    const lbImg    = document.getElementById('ss-lightbox-img');
    const lbName   = document.getElementById('ss-lightbox-name');
    if (!lightbox) return;

    lightboxIdx = idx;
    const ss = filteredScreenshots[idx];
    if (!ss) return;

    if (lbImg) {
        lbImg.src = '';
        lbImg.style.opacity = '0.3';
        window.electronAPI.fs.readBinaryDataUrl(ss.filePath).then(dataUrl => {
            if (lbImg && dataUrl) { lbImg.src = dataUrl; lbImg.style.opacity = '1'; }
        }).catch(() => {});
    }
    if (lbName) {
        lbName.textContent =
            `${formatVersionLabel(ss.version, ss.displayName)}  ·  ${ss.file}  ·  ${formatDate(ss.mtime)}`;
    }
    lightbox.style.display = 'flex';
}

function closeLightbox() {
    const lb = document.getElementById('ss-lightbox');
    if (lb) lb.style.display = 'none';
}

function navigateLightbox(dir) {
    if (!filteredScreenshots.length) return;
    lightboxIdx = (lightboxIdx + dir + filteredScreenshots.length) % filteredScreenshots.length;
    openLightbox(lightboxIdx);
}

// ── Рендер ────────────────────────────────────────────────────────────────────

// Применяет поиск + фильтр по версии
function applyFilters(screenshots) {
    let result = screenshots;
    if (activeFilter !== 'all') {
        result = result.filter(s => s.version === activeFilter);
    }
    if (searchQuery) {
        const q = searchQuery.toLowerCase();
        result = result.filter(s =>
            s.file.toLowerCase().includes(q) ||
            formatVersionLabel(s.version, s.displayName).toLowerCase().includes(q) ||
            s.version.toLowerCase().includes(q)
        );
    }
    return result;
}

function buildFilterBar(container, screenshots) {
    const existing = container.querySelector('.ss-filter-bar');
    if (existing) existing.remove();

    const versions = [];
    const seen = new Set();
    screenshots.forEach(ss => {
        if (!seen.has(ss.version)) {
            seen.add(ss.version);
            versions.push({ key: ss.version, label: formatVersionLabel(ss.version, ss.displayName) });
        }
    });
    if (versions.length <= 1) return;

    const grid = container.querySelector('.screenshots-grid');
    const bar  = document.createElement('div');
    bar.className = 'ss-filter-bar';
    bar.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px;';

    const makeBtn = (text, key) => {
        const btn = document.createElement('button');
        const active = activeFilter === key;
        btn.textContent = text;
        btn.style.cssText = `
            padding:5px 14px;border-radius:20px;cursor:pointer;
            font-size:11px;font-family:inherit;border:1px solid;
            transition:all 0.12s ease;
            border-color:${active ? 'rgba(99,179,237,.7)' : 'rgba(255,255,255,.15)'};
            background:${active ? 'rgba(99,179,237,.2)' : 'rgba(255,255,255,.06)'};
            color:${active ? '#fff' : 'rgba(255,255,255,.6)'};
        `;
        btn.addEventListener('click', () => {
            activeFilter = key;
            filteredScreenshots = key === 'all'
                ? allScreenshots
                : allScreenshots.filter(s => s.version === key);
            renderCards(container, filteredScreenshots);
            buildFilterBar(container, allScreenshots);
        });
        return btn;
    };

    bar.appendChild(makeBtn(`Все (${screenshots.length})`, 'all'));
    versions.forEach(({ key, label }) => {
        const cnt = screenshots.filter(s => s.version === key).length;
        bar.appendChild(makeBtn(`${label} (${cnt})`, key));
    });

    if (grid) grid.parentNode.insertBefore(bar, grid);
}

function renderCards(container, screenshots) {
    const grid    = container.querySelector('.screenshots-grid');
    const emptyMsg= container.querySelector('.screenshots-empty');
    if (!grid) return;

    grid.innerHTML = '';

    if (!screenshots.length) {
        if (emptyMsg) emptyMsg.style.display = '';
        return;
    }
    if (emptyMsg) emptyMsg.style.display = 'none';

    screenshots.forEach((ss, idx) => {
        const card = document.createElement('div');
        card.className = 'ss-card';

        const img = document.createElement('img');
        img.className = 'ss-card-img';
        img.alt = ss.file;

        window.electronAPI.fs.readBinaryDataUrl(ss.filePath)
            .then(d => { if (d) img.src = d; })
            .catch(() => {});

        const overlay = document.createElement('div');
        overlay.className = 'ss-card-overlay';

        const info = document.createElement('div');
        info.className = 'ss-card-info';

        const nameEl = document.createElement('div');
        nameEl.className = 'ss-card-name';
        nameEl.textContent = ss.file;

        const verEl = document.createElement('div');
        verEl.className = 'ss-card-ver';
        verEl.textContent = formatVersionLabel(ss.version, ss.displayName);

        info.appendChild(nameEl);
        info.appendChild(verEl);

        const actions = document.createElement('div');
        actions.className = 'ss-card-actions';

        const folderBtn = document.createElement('button');
        folderBtn.className = 'ss-action-btn';
        folderBtn.title = 'Открыть папку';
        folderBtn.innerHTML = '<svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14"><path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/></svg>';
        folderBtn.addEventListener('click', e => {
            e.stopPropagation();
            window.electronAPI.openPath(window.electronAPI.path.dirname(ss.filePath));
        });

        const delBtn = document.createElement('button');
        delBtn.className = 'ss-action-btn ss-action-danger';
        delBtn.title = 'Удалить';
        delBtn.innerHTML = '<svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>';
        delBtn.addEventListener('click', async e => {
            e.stopPropagation();
            const confirmed = await showLauncherConfirm(`Удалить скриншот ${ss.file}?`);
            if (!confirmed) return;
            const ok = await window.electronAPI.screenshots.delete(ss.filePath);
            if (ok) {
                allScreenshots      = allScreenshots.filter(s => s !== ss);
                filteredScreenshots = filteredScreenshots.filter(s => s !== ss);
                card.style.transition = 'opacity .2s,transform .2s';
                card.style.opacity = '0';
                card.style.transform = 'scale(.92)';
                setTimeout(() => {
                    card.remove();
                    const countEl = container.querySelector('.screenshots-count');
                    if (countEl) countEl.textContent = allScreenshots.length ? `${allScreenshots.length} скриншотов` : '';
                    if (!grid.children.length && emptyMsg) emptyMsg.style.display = '';
                    buildFilterBar(container, allScreenshots);
                }, 220);
            } else {
                showLauncherAlert('Не удалось удалить скриншот.');
            }
        });

        actions.appendChild(folderBtn);
        actions.appendChild(delBtn);
        overlay.appendChild(info);
        overlay.appendChild(actions);
        card.appendChild(img);
        card.appendChild(overlay);
        card.addEventListener('click', () => openLightbox(idx));
        grid.appendChild(card);
    });
}

function rerender() {
    const container = document.getElementById('screenshots-panel');
    if (!container) return;
    const countEl = container.querySelector('.screenshots-count');
    if (countEl) countEl.textContent = allScreenshots.length ? `${allScreenshots.length} скриншотов` : '';
    buildFilterBar(container, allScreenshots);
    renderCards(container, filteredScreenshots);
}

// ── Главная функция — вызывается из renderer.js БЕЗ аргументов ────────────────
function initScreenshots() {
    // Контейнер ищем сами
    const container = document.getElementById('screenshots-panel');
    if (!container) {
        console.error('[screenshots] #screenshots-panel not found');
        return;
    }

    const grid       = container.querySelector('.screenshots-grid');
    const emptyMsg   = container.querySelector('.screenshots-empty');
    const refreshBtn = container.querySelector('.screenshots-refresh');
    const countEl    = container.querySelector('.screenshots-count');

    if (!grid) {
        console.error('[screenshots] .screenshots-grid not found');
        return;
    }

    // Инициализируем lightbox (один раз)
    initLightbox();

    function showSkeleton() {
        const fb = container.querySelector('.ss-filter-bar');
        if (fb) fb.remove();
        grid.innerHTML = Array.from({length: 8}, () =>
            '<div class="ss-card skeleton" style="aspect-ratio:16/9"></div>'
        ).join('');
        if (emptyMsg) emptyMsg.style.display = 'none';
        if (countEl)  countEl.textContent = '';
    }

    async function loadScreenshots() {
        showSkeleton();
        activeFilter = 'all';
        searchQuery  = '';
        const searchInput = document.getElementById('ss-search-input');
        if (searchInput) searchInput.value = '';
        allScreenshots      = await collectAllScreenshots();
        filteredScreenshots = applyFilters(allScreenshots);
        if (countEl) countEl.textContent = allScreenshots.length ? `${allScreenshots.length} скриншотов` : '';
        buildFilterBar(container, allScreenshots);
        renderCards(container, filteredScreenshots);
    }

    // Поиск по имени/версии
    const searchInput = document.getElementById('ss-search-input');
    if (searchInput) {
        searchInput.addEventListener('input', () => {
            searchQuery = searchInput.value.trim();
            filteredScreenshots = applyFilters(allScreenshots);
            renderCards(container, filteredScreenshots);
            buildFilterBar(container, allScreenshots);
            const countEl = container.querySelector('.screenshots-count');
            if (countEl) countEl.textContent = allScreenshots.length
                ? `${filteredScreenshots.length} / ${allScreenshots.length} скриншотов`
                : '';
        });
    }

    if (refreshBtn) refreshBtn.addEventListener('click', loadScreenshots);

    let _screenshotsLoaded = false;

    // Загружаем при переключении на вкладку — только если ещё не загружено
    document.addEventListener('panel-switched', e => {
        if (e.detail?.tab === 'screenshots') {
            if (!_screenshotsLoaded) {
                _screenshotsLoaded = true;
                loadScreenshots();
            }
            // Повторный клик — ничего не делаем, данные уже есть
        }
    });
}

const _Screenshots = { initScreenshots };
if (typeof window !== 'undefined') { window.Screenshots = _Screenshots; }
if (typeof module !== 'undefined' && module.exports) { module.exports = _Screenshots; }
})();
