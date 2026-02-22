const { contextBridge, ipcRenderer } = require('electron');

// Безопасный API для renderer процесса
contextBridge.exposeInMainWorld('electronAPI', {
    // Новости
    getNews: () => ipcRenderer.invoke('get-news'),
    
    // Диалоги
    openFileDialog: (options) => ipcRenderer.invoke('open-folder-dialog', options),
    openFile: (options) => ipcRenderer.invoke('open-file-dialog', options),
    
    // Управление окном
    closeWindow: () => ipcRenderer.invoke('close-launcher'),
    mcLaunched: (pid) => ipcRenderer.invoke('mc-launched', pid),
    minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
    maximizeWindow: () => ipcRenderer.invoke('maximize-window'),
    
    // Обновления
    checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
    downloadUpdate: () => ipcRenderer.invoke('download-update'),
    quitAndInstall: () => ipcRenderer.invoke('quit-and-install'),
    
    // Логирование
    log: (message, level) => ipcRenderer.invoke('log', message, level),
    
    // События
    onUpdateProgress: (callback) => {
        ipcRenderer.on('update-progress', (event, data) => callback(data));
    },
    onUpdateStatus: (callback) => {
        ipcRenderer.on('update-available', (event, data) => callback(data));
    }
});

// Версия приложения
contextBridge.exposeInMainWorld('appVersion', {
    getVersion: () => require('./package.json').version
});
