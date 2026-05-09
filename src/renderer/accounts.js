(function() {
'use strict';

const STORAGE_KEY_ACCOUNTS = 'fixlauncher_accounts';
const STORAGE_KEY_SELECTED = 'fixlauncher_selected_account';

function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

function getAccounts() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY_ACCOUNTS);
        return raw ? JSON.parse(raw) : [];
    } catch { return []; }
}

function saveAccounts(accounts) {
    localStorage.setItem(STORAGE_KEY_ACCOUNTS, JSON.stringify(accounts));
}

function getSelectedUuid() {
    return localStorage.getItem(STORAGE_KEY_SELECTED);
}

function setSelectedUuid(uuid) {
    if (uuid) {
        localStorage.setItem(STORAGE_KEY_SELECTED, uuid);
    } else {
        localStorage.removeItem(STORAGE_KEY_SELECTED);
    }
}

function getSelectedAccount() {
    const uuid = getSelectedUuid();
    if (!uuid) return null;
    return getAccounts().find(a => a.uuid === uuid) || null;
}

function addAccount(account) {
    const accounts = getAccounts();
    if (!account.uuid) account.uuid = generateUUID();
    if (!account.type) account.type = 'crack';
    accounts.push(account);
    saveAccounts(accounts);
    if (accounts.length === 1) setSelectedUuid(account.uuid);
    return account;
}

function removeAccount(uuid) {
    let accounts = getAccounts();
    accounts = accounts.filter(a => a.uuid !== uuid);
    saveAccounts(accounts);
    if (getSelectedUuid() === uuid) {
        setSelectedUuid(accounts.length > 0 ? accounts[0].uuid : null);
    }
    renderDropdown();
}

function selectAccount(uuid) {
    const accounts = getAccounts();
    if (accounts.find(a => a.uuid === uuid)) {
        setSelectedUuid(uuid);
        renderDropdown();
    }
}

function ensureDefaultAccount() {
    const accounts = getAccounts();
    if (accounts.length === 0) {
        const defaultName = 'FixLauncher' + Math.floor(1000 + Math.random() * 9000);
        const account = {
            uuid: generateUUID(),
            type: 'crack',
            username: defaultName,
        };
        accounts.push(account);
        saveAccounts(accounts);
        setSelectedUuid(account.uuid);
    } else if (!getSelectedUuid()) {
        setSelectedUuid(accounts[0].uuid);
    }
}

async function showAddCrackDialog() {
    const overlay = document.getElementById('account-dialog-overlay');
    const titleEl = document.getElementById('account-dialog-title');
    const inputEl = document.getElementById('account-dialog-input');
    const cancelBtn = document.getElementById('account-dialog-cancel');
    const confirmBtn = document.getElementById('account-dialog-confirm');
    const closeBtn = document.getElementById('account-dialog-close');

    if (!overlay) return;
    titleEl.textContent = 'Введите никнейм';
    inputEl.value = '';
    inputEl.placeholder = 'Игровое имя...';
    overlay.style.display = 'flex';
    inputEl.focus();

    return new Promise(resolve => {
        const cleanup = () => {
            overlay.style.display = 'none';
            cancelBtn.removeEventListener('click', onCancel);
            confirmBtn.removeEventListener('click', onConfirm);
            closeBtn.removeEventListener('click', onCancel);
            inputEl.removeEventListener('keydown', onKey);
        };
        const onCancel = () => { cleanup(); resolve(null); };
        const onConfirm = () => {
            const val = inputEl.value.trim();
            if (!val) { inputEl.focus(); return; }
            cleanup();
            resolve(val);
        };
        const onKey = (e) => { if (e.key === 'Enter') onConfirm(); if (e.key === 'Escape') onCancel(); };
        cancelBtn.addEventListener('click', onCancel);
        confirmBtn.addEventListener('click', onConfirm);
        closeBtn.addEventListener('click', onCancel);
        inputEl.addEventListener('keydown', onKey);
    });
}

async function handleAddCrack() {
    const name = await showAddCrackDialog();
    if (!name) return;
    addAccount({ type: 'crack', username: name });
    renderDropdown();
}

async function handleAddMicrosoft() {
    const result = await window.electronAPI.microsoftAuth();
    if (!result || !result.ok) {
        if (result && result.error) {
            alert('Ошибка входа: ' + result.error);
        }
        return;
    }
    addAccount({
        type: 'microsoft',
        uuid: result.account.uuid || generateUUID(),
        username: result.account.username,
        accessToken: result.account.accessToken,
    });
    renderDropdown();
}

function renderDropdown() {
    const label = document.getElementById('account-selector-label');
    const list = document.getElementById('account-list');
    if (!list) return;

    const accounts = getAccounts();
    const selected = getSelectedAccount();

    if (label && selected) {
        label.textContent = selected.username;
    } else if (label) {
        label.textContent = 'Нет аккаунта';
    }

    list.innerHTML = '';
    for (const acc of accounts) {
        const isSelected = selected && acc.uuid === selected.uuid;
        const div = document.createElement('div');
        div.className = 'version-item' + (isSelected ? ' is-selected' : '');
        div.setAttribute('role', 'option');
        div.setAttribute('aria-selected', String(isSelected));

        const icon = document.createElement('span');
        icon.className = 'version-item-icon';
        icon.textContent = acc.type === 'microsoft' ? '🟢' : '👤';

        const body = document.createElement('div');
        body.className = 'version-item-body';

        const nameDiv = document.createElement('div');
        nameDiv.className = 'version-item-title';
        nameDiv.textContent = acc.username;

        const metaDiv = document.createElement('div');
        metaDiv.className = 'version-item-meta';
        metaDiv.textContent = acc.type === 'microsoft' ? 'Microsoft' : 'Crack';

        body.appendChild(nameDiv);
        body.appendChild(metaDiv);

        const delBtn = document.createElement('button');
        delBtn.className = 'account-del-btn';
        delBtn.textContent = '✕';
        delBtn.title = 'Удалить аккаунт';
        delBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const confirmed = await window.UiHelpers.showLauncherConfirm(`Удалить аккаунт "${acc.username}"?`, 'Удаление аккаунта');
            if (confirmed) {
                removeAccount(acc.uuid);
            }
        });

        div.appendChild(icon);
        div.appendChild(body);
        div.appendChild(delBtn);

        div.addEventListener('click', () => {
            selectAccount(acc.uuid);
            closeDropdown();
        });

        list.appendChild(div);
    }
}

let dropdownOpen = false;

function openDropdown() {
    const dropdown = document.getElementById('account-selector-dropdown');
    const btn = document.getElementById('account-selector-btn');
    if (!dropdown) return;
    dropdown.classList.add('is-open');
    dropdown.setAttribute('aria-hidden', 'false');
    btn.setAttribute('aria-expanded', 'true');
    dropdownOpen = true;
    renderDropdown();
}

function closeDropdown() {
    const dropdown = document.getElementById('account-selector-dropdown');
    const btn = document.getElementById('account-selector-btn');
    if (!dropdown) return;
    dropdown.classList.remove('is-open');
    dropdown.setAttribute('aria-hidden', 'true');
    btn.setAttribute('aria-expanded', 'false');
    dropdownOpen = false;
}

function toggleDropdown() {
    if (dropdownOpen) closeDropdown();
    else openDropdown();
}

function init() {
    ensureDefaultAccount();

    const btn = document.getElementById('account-selector-btn');
    const addCrack = document.getElementById('account-add-crack');
    const addMs = document.getElementById('account-add-ms');

    if (btn) btn.addEventListener('click', toggleDropdown);

    if (addCrack) addCrack.addEventListener('click', () => {
        closeDropdown();
        setTimeout(() => handleAddCrack(), 100);
    });

    if (addMs) addMs.addEventListener('click', () => {
        closeDropdown();
        setTimeout(() => handleAddMicrosoft(), 100);
    });

    document.addEventListener('click', (e) => {
        if (dropdownOpen) {
            const selector = document.getElementById('account-selector');
            if (selector && !selector.contains(e.target)) {
                closeDropdown();
            }
        }
    });

    renderDropdown();
}

const _AccountsManager = {
    getAccounts,
    getSelectedAccount,
    addAccount,
    removeAccount,
    selectAccount,
    renderDropdown,
    init,
};

if (typeof window !== 'undefined') { window.AccountsManager = _AccountsManager; }
if (typeof module !== 'undefined' && module.exports) { module.exports = _AccountsManager; }
})();
