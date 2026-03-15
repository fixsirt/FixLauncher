(function() {
'use strict';

/**
 * Шаринг статистики игрока — popup, canvas-карточка, экспорт
 * @module renderer/share
 */

// Electron API доступен через window.electronAPI (preload.js / contextBridge)
const { playtimeGetTotal, playtimeFormat, showToast } = window.UiHelpers;

function initSharePopup() {
    try {
        const FIRST_LAUNCH_KEY = 'fixlauncher-first-launch';
        const SHARE_SHOWN_KEY = 'fixlauncher-share-shown';
        const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

        // Запоминаем первый запуск
        if (!localStorage.getItem(FIRST_LAUNCH_KEY)) {
            localStorage.setItem(FIRST_LAUNCH_KEY, String(Date.now()));
        }

        // Уже показывали — не показываем снова
        if (localStorage.getItem(SHARE_SHOWN_KEY)) return;

        const firstLaunch = parseInt(localStorage.getItem(FIRST_LAUNCH_KEY), 10);
        const elapsed = Date.now() - firstLaunch;

        if (elapsed < SEVEN_DAYS_MS) {
            // Проверим позже
            const remaining = SEVEN_DAYS_MS - elapsed;
            setTimeout(showSharePopup, Math.min(remaining, 2147483647));
            return;
        }

        // 7 дней прошло — показываем с небольшой задержкой после загрузки
        setTimeout(showSharePopup, 3000);
    } catch { /* ignore */ }
}

// ══════════════════════════════════════════════════════════
// Генерация invite-картинки через Canvas
// ══════════════════════════════════════════════════════════
async function generateShareImage(playerName, playtimeStr) {
    // 2x pixel ratio — чёткое изображение
    const W = 900, H = 500, S = 2;
    const canvas = document.createElement('canvas');
    canvas.width = W * S; canvas.height = H * S;
    const ctx = canvas.getContext('2d');
    ctx.scale(S, S);

    function rr(x, y, w, h, r) {
        if (typeof r === 'number') r = [r,r,r,r];
        const [tl,tr,br,bl] = r;
        ctx.beginPath();
        ctx.moveTo(x+tl, y);
        ctx.lineTo(x+w-tr, y); ctx.quadraticCurveTo(x+w, y, x+w, y+tr);
        ctx.lineTo(x+w, y+h-br); ctx.quadraticCurveTo(x+w, y+h, x+w-br, y+h);
        ctx.lineTo(x+bl, y+h); ctx.quadraticCurveTo(x, y+h, x, y+h-bl);
        ctx.lineTo(x, y+tl); ctx.quadraticCurveTo(x, y, x+tl, y);
        ctx.closePath();
    }

    // === ФОН ===
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#080f1c');
    bg.addColorStop(0.45, '#0b1e3a');
    bg.addColorStop(1, '#060e1a');
    ctx.fillStyle = bg;
    rr(0, 0, W, H, 0); ctx.fill();

    // Глоу слева (синий)
    const g1 = ctx.createRadialGradient(160, 200, 0, 160, 200, 260);
    g1.addColorStop(0, 'rgba(55,120,255,0.22)'); g1.addColorStop(1, 'rgba(55,120,255,0)');
    ctx.fillStyle = g1; ctx.beginPath(); ctx.arc(160, 200, 260, 0, Math.PI*2); ctx.fill();

    // Глоу справа (фиолетовый)
    const g2 = ctx.createRadialGradient(760, 300, 0, 760, 300, 230);
    g2.addColorStop(0, 'rgba(110,60,255,0.16)'); g2.addColorStop(1, 'rgba(110,60,255,0)');
    ctx.fillStyle = g2; ctx.beginPath(); ctx.arc(760, 300, 230, 0, Math.PI*2); ctx.fill();

    // Сетка точек
    ctx.fillStyle = 'rgba(255,255,255,0.032)';
    for (let x = 25; x < W; x += 38) for (let y = 25; y < H; y += 38) {
        ctx.beginPath(); ctx.arc(x, y, 1.2, 0, Math.PI*2); ctx.fill();
    }

    // === ПОЛОСКА СЛЕВА ===
    const stripeG = ctx.createLinearGradient(0, 0, 0, H);
    stripeG.addColorStop(0, '#3b82f6'); stripeG.addColorStop(1, '#7c3aed');
    ctx.fillStyle = stripeG; rr(0, 0, 7, H, 0); ctx.fill();

    // === ЛОГОТИП ===
    const LS = 112, LX = 44, LY = H/2 - LS/2;
    try {
        const logoImg = await new Promise((res, rej) => {
            const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = 'logo.png';
        });
        ctx.save();
        ctx.shadowColor = 'rgba(59,130,246,0.7)'; ctx.shadowBlur = 28;
        const logoG = ctx.createLinearGradient(LX, LY, LX+LS, LY+LS);
        logoG.addColorStop(0, '#1d4ed8'); logoG.addColorStop(1, '#4f46e5');
        ctx.fillStyle = logoG; rr(LX, LY, LS, LS, 22); ctx.fill();
        ctx.restore();
        ctx.save(); rr(LX, LY, LS, LS, 22); ctx.clip();
        ctx.drawImage(logoImg, LX, LY, LS, LS);
        ctx.restore();
    } catch { /* ignore */ }

    // === ТЕКСТ ===
    const TX = 185;

    // Бренд
    ctx.save();
    ctx.font = '700 13px "Segoe UI",Arial,sans-serif';
    ctx.fillStyle = 'rgba(96,165,250,0.85)';
    ctx.letterSpacing = '5px';
    ctx.fillText('FIXLAUNCHER', TX, 104);
    ctx.restore();

    // Заголовок
    ctx.save();
    ctx.font = '700 48px "Segoe UI",Arial,sans-serif';
    ctx.shadowColor = 'rgba(59,130,246,0.45)'; ctx.shadowBlur = 16;
    const hg = ctx.createLinearGradient(TX, 115, TX+580, 165);
    hg.addColorStop(0, '#ffffff'); hg.addColorStop(1, '#93c5fd');
    ctx.fillStyle = hg;
    ctx.fillText('Присоединяйся к нам!', TX, 162);
    ctx.restore();

    // Подзаголовок
    ctx.save();
    ctx.font = '400 19px "Segoe UI",Arial,sans-serif';
    ctx.fillStyle = 'rgba(186,220,255,0.8)';
    ctx.fillText('Лучший Minecraft лаунчер с модами и удобным управлением', TX, 200);
    ctx.restore();

    // Разделитель
    const dg = ctx.createLinearGradient(TX, 0, TX+520, 0);
    dg.addColorStop(0, 'rgba(59,130,246,0.75)'); dg.addColorStop(1, 'rgba(59,130,246,0)');
    ctx.fillStyle = dg; ctx.fillRect(TX, 218, 520, 1.5);

    // === КАРТОЧКА ИГРОКА ===
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.065)';
    rr(TX, 234, 494, 106, 16); ctx.fill();
    ctx.strokeStyle = 'rgba(59,130,246,0.32)'; ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();

    // Аватар
    const AS = 62, AX = TX+16, AY = 252;
    const ag = ctx.createLinearGradient(AX, AY, AX+AS, AY+AS);
    ag.addColorStop(0, '#3730a3'); ag.addColorStop(1, '#7c3aed');
    ctx.fillStyle = ag; rr(AX, AY, AS, AS, 12); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = '700 27px "Segoe UI",Arial,sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText((playerName||'И')[0].toUpperCase(), AX+AS/2, AY+AS/2+10);
    ctx.textAlign = 'left';

    // Ник
    ctx.font = '700 22px "Segoe UI",Arial,sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(playerName||'Игрок', TX+92, 278);

    ctx.font = '400 15px "Segoe UI",Arial,sans-serif';
    ctx.fillStyle = 'rgba(148,197,255,0.85)';
    ctx.fillText('⏱ Игровое время: ' + playtimeStr, TX+92, 302);

    ctx.fillStyle = 'rgba(74,222,128,0.9)';
    ctx.font = '700 13px "Segoe UI",Arial,sans-serif';
    ctx.fillText('● Онлайн', TX+92, 328);

    // === ФИЧИ ===
    const feats = ['⚡ Быстрый запуск', '🎮 Готовые сборки', '🔧 Авто-обновления'];
    let fx = TX;
    feats.forEach(f => {
        ctx.save();
        ctx.font = '400 14px "Segoe UI",Arial,sans-serif';
        const fw = ctx.measureText(f).width + 26;
        ctx.fillStyle = 'rgba(255,255,255,0.075)';
        rr(fx, 360, fw, 32, 9); ctx.fill();
        ctx.strokeStyle = 'rgba(59,130,246,0.28)'; ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = 'rgba(196,228,255,0.9)';
        ctx.fillText(f, fx+13, 381);
        ctx.restore();
        fx += fw + 10;
    });

    // === КНОПКА-ССЫЛКА ===
    ctx.save();
    const lb = ctx.createLinearGradient(TX, 408, TX+340, 448);
    lb.addColorStop(0, 'rgba(29,78,216,0.9)'); lb.addColorStop(1, 'rgba(79,70,229,0.9)');
    ctx.fillStyle = lb; rr(TX, 408, 345, 40, 11); ctx.fill();
    ctx.shadowColor = 'rgba(59,130,246,0.55)'; ctx.shadowBlur = 14;
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 14px "Segoe UI",Arial,sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('🔗 github.com/fixsirt/FixLauncher/releases', TX+172, 433);
    ctx.restore();

    // Копирайт
    ctx.save();
    ctx.font = '400 11px "Segoe UI",Arial,sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.textAlign = 'right';
    ctx.fillText('fixlauncher', W-22, H-14);
    ctx.restore();

    return canvas.toDataURL('image/png');
}

function roundRect(ctx, x, y, w, h, r) {
    if (typeof r === 'number') r = [r,r,r,r];
    const [tl,tr,br,bl] = r;
    ctx.moveTo(x+tl, y);
    ctx.lineTo(x+w-tr, y); ctx.quadraticCurveTo(x+w, y, x+w, y+tr);
    ctx.lineTo(x+w, y+h-br); ctx.quadraticCurveTo(x+w, y+h, x+w-br, y+h);
    ctx.lineTo(x+bl, y+h); ctx.quadraticCurveTo(x, y+h, x, y+h-bl);
    ctx.lineTo(x, y+tl); ctx.quadraticCurveTo(x, y, x+tl, y);
}

function loadImage(src) {
    return new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = rej;
        img.src = src;
    });
}

function showSharePopup() {
    try {
        if (document.getElementById('share-popup-overlay')) return;

        const playerName = document.getElementById('player-name')?.value || 'Игрок';
        const totalSeconds = playtimeGetTotal();
        const playtimeStr = playtimeFormat(totalSeconds) || '0м';
        const downloadUrl = 'https://github.com/fixsirt/FixLauncher/releases';

        const overlay = document.createElement('div');
        overlay.id = 'share-popup-overlay';
        overlay.innerHTML = `
            <div class="share-popup" id="share-popup" style="max-width:520px;width:100%;">
                <button class="share-popup-close" id="share-popup-close">✕</button>
                <div class="share-popup-header">
                    <div class="share-popup-logo">
                        <img src="logo.png" alt="FixLauncher" width="48" height="48">
                    </div>
                    <div class="share-popup-titles">
                        <div class="share-popup-title">Ты уже 7 дней с нами! 🎉</div>
                        <div class="share-popup-sub">Расскажи друзьям — поделись красивой картинкой</div>
                    </div>
                </div>

                <div id="share-img-preview" style="
                    width:100%; border-radius:12px; overflow:hidden;
                    background:rgba(255,255,255,0.05); margin:14px 0 16px;
                    min-height:72px; display:flex; align-items:center; justify-content:center;
                ">
                    <span style="color:rgba(255,255,255,0.38);font-size:13px;">⏳ Генерация...</span>
                </div>

                <div class="share-buttons" style="display:flex;flex-direction:column;gap:10px;">
                    <button class="share-btn" id="share-save-img" style="
                        background:linear-gradient(135deg,#1e3a6e,#2d2d6e);
                        border:1px solid rgba(100,130,255,0.25);
                        display:flex;align-items:center;justify-content:center;gap:9px;
                        padding:12px 20px;border-radius:12px;
                        color:rgba(200,220,255,0.85);font-size:14px;font-weight:500;cursor:pointer;
                        transition:opacity .15s;
                    ">
                        <svg viewBox="0 0 24 24" fill="currentColor" width="17" height="17"><path d="M12 16l-6-6h4V4h4v6h4l-6 6zm-6 2h12v2H6v-2z"/></svg>
                        Сохранить картинку
                    </button>

                    <button class="share-btn share-tg" id="share-tg-btn" style="
                        background:linear-gradient(135deg,#0088cc,#006aad);
                        display:flex;align-items:center;justify-content:center;gap:10px;
                        padding:15px 20px;border-radius:12px;border:none;
                        color:#fff;font-size:15px;font-weight:700;cursor:pointer;
                        box-shadow:0 4px 20px rgba(0,136,204,0.4);
                        transition:opacity .15s;
                    ">
                        <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.894 8.221l-1.97 9.28c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12L7.19 13.6l-2.938-.916c-.638-.2-.65-.638.136-.944l11.47-4.42c.533-.193 1 .13.837.9z"/></svg>
                        Поделиться в Telegram
                    </button>
                </div>

                <!-- Тост-уведомление -->
                <div id="share-toast" style="
                    display:none; margin-top:12px;
                    padding:12px 16px; border-radius:10px;
                    background:rgba(0,180,100,0.15); border:1px solid rgba(0,200,100,0.3);
                    color:rgba(100,255,160,0.95); font-size:13px; text-align:center;
                    animation: fadeInToast .25s ease;
                "></div>

                <button class="share-popup-later" id="share-popup-later">Напомнить позже</button>
            </div>
        `;
        document.body.appendChild(overlay);

        // Инжектим анимацию тоста если нет
        if (!document.getElementById('share-toast-style')) {
            const st = document.createElement('style');
            st.id = 'share-toast-style';
            st.textContent = `@keyframes fadeInToast { from{opacity:0;transform:translateY(4px)} to{opacity:1;transform:none} }`;
            document.head.appendChild(st);
        }

        let imageDataUrl = null;

        generateShareImage(playerName, playtimeStr).then(dataUrl => {
            imageDataUrl = dataUrl;
            const preview = document.getElementById('share-img-preview');
            if (preview) {
                preview.innerHTML = '';
                const img = document.createElement('img');
                img.src = dataUrl;
                img.style.cssText = 'width:100%;border-radius:10px;display:block;cursor:pointer;';
                preview.appendChild(img);
            }
        }).catch(e => console.warn('Image gen error:', e));

        const showToast = (msg, color = 'rgba(100,255,160,0.95)', bg = 'rgba(0,180,100,0.15)', border = 'rgba(0,200,100,0.3)') => {
            const t = document.getElementById('share-toast');
            if (!t) return;
            t.textContent = msg;
            t.style.color = color;
            t.style.background = bg;
            t.style.borderColor = border;
            t.style.display = 'block';
            t.style.animation = 'none';
            requestAnimationFrame(() => { t.style.animation = 'fadeInToast .25s ease'; });
        }

        const openExternal = (url) => {
            try {
                window.electronAPI.openExternal(url);
            } catch(e) { window.open(url, '_blank'); }
        }

        const markShown = () => {
            localStorage.setItem('fixlauncher-share-shown', '1');
        }

        // Копируем картинку в буфер через Electron clipboard
        const copyImageToClipboard = async (dataUrl, text) => {
            try {
                await window.electronAPI.copyImageToClipboard(dataUrl, text || '');
                return true;
            } catch(e) {
                return false;
            }
        }

        // Сохранить картинку
        document.getElementById('share-save-img')?.addEventListener('click', async () => {
            if (!imageDataUrl) { showToast('⏳ Картинка ещё генерируется...', 'rgba(255,200,80,0.9)', 'rgba(200,150,0,0.12)', 'rgba(255,180,0,0.25)'); return; }
            try {
                const p = await window.electronAPI.saveShareImage(imageDataUrl);
                if (p) showToast('✅ Сохранено: ' + p.split(/[\\/]/).pop());
                else throw new Error('no path');
            } catch(e) {
                const a = document.createElement('a');
                a.href = imageDataUrl;
                a.download = 'fixlauncher-share.png';
                a.click();
                showToast('✅ Картинка скачана!');
            }
            markShown();
        });

        // Telegram — копируем в буфер и открываем TG
        document.getElementById('share-tg-btn')?.addEventListener('click', async () => {
            if (!imageDataUrl) { showToast('⏳ Картинка ещё генерируется, подожди секунду...', 'rgba(255,200,80,0.9)', 'rgba(200,150,0,0.12)', 'rgba(255,180,0,0.25)'); return; }

            const btn = document.getElementById('share-tg-btn');
            btn.disabled = true;
            btn.innerHTML = '<span style="opacity:.7">⏳ Копирую...</span>';

            // Копируем картинку + текст одновременно в один clipboard.write()
            const caption = `🎮 Играю на FixLauncher уже ${playtimeStr}! Ник: ${playerName}\n⬇️ Скачать: ${downloadUrl}`;
            const imgOk = await copyImageToClipboard(imageDataUrl, ''); // только картинка

            btn.disabled = false;
            btn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.894 8.221l-1.97 9.28c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12L7.19 13.6l-2.938-.916c-.638-.2-.65-.638.136-.944l11.47-4.42c.533-.193 1 .13.837.9z"/></svg> Поделиться в Telegram`;

            // Показываем инструкцию
            showShareInstructions(imgOk, caption, () => {
                openExternal('tg://');
                markShown();
                overlay.remove();
            });
        });

        const showShareInstructions = (imgOk, caption, onOk) => {
            // Убираем старый модал если есть
            const old = document.getElementById('share-instruction-modal');
            if (old) old.remove();

            const modal = document.createElement('div');
            modal.id = 'share-instruction-modal';
            modal.style.cssText = `
                position:fixed; inset:0; z-index:10002;
                display:flex; align-items:center; justify-content:center;
                background:rgba(0,0,0,0.7); backdrop-filter:blur(8px);
            `;

            const steps = imgOk ? [
                { icon: '📋', title: 'Картинка скопирована!', desc: 'Фото в буфере обмена — готово к вставке' },
                { icon: '1️⃣', title: 'Открой нужный чат в Telegram', desc: 'Telegram сейчас откроется автоматически' },
                { icon: '2️⃣', title: 'Нажми Ctrl+V', desc: 'Вставится картинка' },
                { icon: '✅', title: 'Нажми отправить!', desc: 'Друзья увидят карточку и смогут скачать лаунчер 🎉' },
            ] : [
                { icon: '⚠️', title: 'Буфер обмена недоступен', desc: 'Картинка сохранена как файл <b>fixlauncher-share.png</b>' },
                { icon: '1️⃣', title: 'Открой нужный чат в Telegram', desc: 'Telegram сейчас откроется автоматически' },
                { icon: '2️⃣', title: 'Прикрепи файл', desc: 'Нажми 📎 и выбери сохранённый файл <b>fixlauncher-share.png</b>' },
                { icon: '3️⃣', title: 'Добавь подпись', desc: `<span style="font-size:12px;color:rgba(150,200,255,0.9);">${caption.replace(/\n/g,'<br>')}</span>` },
                { icon: '✅', title: 'Отправь!', desc: 'Готово!' },
            ];

            modal.innerHTML = `
                <div style="
                    background:linear-gradient(160deg,#0d1d35,#091525);
                    border:1px solid rgba(59,130,246,0.3);
                    border-radius:20px; padding:28px 28px 22px;
                    max-width:400px; width:92%;
                    box-shadow:0 24px 80px rgba(0,0,0,0.7);
                ">
                    <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;">
                        <div style="
                            width:42px;height:42px;border-radius:11px;flex-shrink:0;
                            background:linear-gradient(135deg,#0088cc,#006aad);
                            display:flex;align-items:center;justify-content:center;font-size:22px;
                        ">📤</div>
                        <div>
                            <div style="font-size:17px;font-weight:700;color:#fff;">Как поделиться в Telegram</div>
                            <div style="font-size:12px;color:rgba(150,190,255,0.7);margin-top:2px;">Следуй инструкции — это займёт 10 секунд</div>
                        </div>
                    </div>

                    <div style="display:flex;flex-direction:column;gap:9px;margin-bottom:20px;">
                        ${steps.map(s => `
                            <div style="
                                display:flex;align-items:flex-start;gap:12px;
                                background:rgba(255,255,255,0.05);
                                border:1px solid rgba(59,130,246,0.15);
                                border-radius:12px; padding:11px 13px;
                            ">
                                <span style="font-size:20px;flex-shrink:0;line-height:1.3">${s.icon}</span>
                                <div>
                                    <div style="font-size:13px;font-weight:600;color:#fff;margin-bottom:2px;">${s.title}</div>
                                    <div style="font-size:12px;color:rgba(180,210,255,0.7);line-height:1.5;">${s.desc}</div>
                                </div>
                            </div>
                        `).join('')}
                    </div>

                    <button id="share-instr-ok" style="
                        width:100%; padding:14px;
                        background:linear-gradient(135deg,#0088cc,#0060a0);
                        border:none; border-radius:12px; cursor:pointer;
                        color:#fff; font-size:15px; font-weight:700;
                        box-shadow:0 4px 18px rgba(0,136,204,0.4);
                        transition:opacity .15s;
                    ">Понятно, открыть Telegram →</button>
                </div>
            `;

            document.body.appendChild(modal);


            document.getElementById('share-instr-ok')?.addEventListener('click', () => {
                modal.remove();
                onOk();
            });

            modal.addEventListener('click', e => { if (e.target === modal) { modal.remove(); onOk(); } });
        }

        document.getElementById('share-popup-close')?.addEventListener('click', () => { markShown(); overlay.remove(); });
        document.getElementById('share-popup-later')?.addEventListener('click', () => {
            localStorage.setItem('fixlauncher-first-launch', String(Date.now() - (4 * 24 * 60 * 60 * 1000)));
            overlay.remove();
        });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) { markShown(); overlay.remove(); } });

        requestAnimationFrame(() => overlay.classList.add('share-popup-visible'));
    } catch(e) {
        console.error('Share popup error:', e);
    }
}

// Dual export: window.* для renderer, module.exports для Node.js/main
const _ShareModule = { initSharePopup, generateShareImage, showSharePopup };
if (typeof window !== 'undefined') { window.ShareModule = _ShareModule; }
if (typeof module !== 'undefined' && module.exports) { module.exports = _ShareModule; }
})();
