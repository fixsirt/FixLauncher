# PowerShell Script для создания установщика FixLauncher Launcher
# Использует 7-Zip SFX для создания самораспаковывающегося установщика

$ErrorActionPreference = "Stop"

$projectDir = Split-Path -Parent $PSScriptRoot
$distDir = Join-Path $projectDir "dist"
$appDir = Join-Path $distDir "FixLauncher-win32-x64"
$outputExe = Join-Path $distDir "FixLauncher-Installer.exe"
$7zSfx = Join-Path $projectDir "7zS.sfx"
$7zSfxIcon = Join-Path $projectDir "7zS-icon.sfx"
$logoIco = Join-Path $projectDir "logo.ico"
$7za = Join-Path $projectDir "node_modules\7zip-bin\win\x64\7za.exe"
$rhPath = "$env:TEMP\resource_hacker\ResourceHacker.exe"

Write-Host "=== FixLauncher Launcher Installer Builder ===" -ForegroundColor Cyan

# Проверяем существование файлов
if (-not (Test-Path $appDir)) {
    Write-Host "Error: App directory not found. Run 'npm run pack:win' first." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $7zSfx)) {
    Write-Host "Error: 7zS.sfx not found." -ForegroundColor Red
    exit 1
}

# Создаем SFX с иконкой если еще не создан
if (-not (Test-Path $7zSfxIcon)) {
    Write-Host "Creating SFX module with icon..." -ForegroundColor Yellow
    if (Test-Path $rhPath) {
        & $rhPath -open $7zSfx -save $7zSfxIcon -action addoverwrite -res $logoIco -mask ICONGROUP,MAINICON | Out-Null
        Copy-Item $7zSfx $7zSfxIcon -Force  # Если Resource Hacker не сработал
    } else {
        Copy-Item $7zSfx $7zSfxIcon -Force
    }
}

# Создаем конфигурационный файл SFX
$configContent = @'
;!@Install@!UTF-8!
Title="FixLauncher Installer"
BeginPrompt="Do you want to install FixLauncher?"
RunProgram="FixLauncher.exe"
;!@InstallEnd@!
'@

$configFile = Join-Path $distDir "installer-config.txt"
Set-Content -Path $configFile -Value $configContent -Encoding UTF8

# Создаем 7z архив
$archiveFile = Join-Path $distDir "installer.7z"
Write-Host "Creating 7z archive..." -ForegroundColor Yellow
& $7za a -t7z $archiveFile "$appDir\*" "$projectDir\scripts\create-shortcuts.vbs" "$projectDir\scripts\uninstall.vbs" | Out-Null

# Объединяем файлы в SFX с иконкой
Write-Host "Creating SFX installer with logo icon..." -ForegroundColor Yellow
$sfxBytes = [System.IO.File]::ReadAllBytes($7zSfxIcon)
$configBytes = [System.IO.File]::ReadAllBytes($configFile)
$archiveBytes = [System.IO.File]::ReadAllBytes($archiveFile)

$outputStream = [System.IO.File]::Create($outputExe)
$outputStream.Write($sfxBytes, 0, $sfxBytes.Length)
$outputStream.Write($configBytes, 0, $configBytes.Length)
$outputStream.Write($archiveBytes, 0, $archiveBytes.Length)
$outputStream.Close()

# Очищаем временные файлы
Remove-Item $configFile -Force
Remove-Item $archiveFile -Force

# Выводим результат
$outputInfo = Get-Item $outputExe
Write-Host "`n=== Build Complete ===" -ForegroundColor Green
Write-Host "Installer: $outputExe" -ForegroundColor Green
Write-Host "Size: $([math]::Round($outputInfo.Length/1MB, 2)) MB" -ForegroundColor Green
Write-Host "Icon: $logoIco" -ForegroundColor Green
Write-Host "`nPortable version: $appDir\FixLauncher.exe" -ForegroundColor Cyan
