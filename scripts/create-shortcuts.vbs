Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Получаем путь к папке установки
strAppPath = fso.GetParentFolderName(WScript.ScriptFullName)
strExePath = strAppPath & "\FixLauncher.exe"
strIconPath = strAppPath & "\logo.ico"

' Создаем ярлык на рабочем столе
strDesktop = WshShell.SpecialFolders("AllUsersDesktop")
Set oShellLink = WshShell.CreateShortcut(strDesktop & "\FixLauncher.lnk")
oShellLink.TargetPath = strExePath
oShellLink.IconLocation = strIconPath
oShellLink.WorkingDirectory = strAppPath
oShellLink.Description = "FixLauncher Launcher"
oShellLink.Save

' Создаем ярлык в меню Пуск
strStartMenu = WshShell.SpecialFolders("AllUsersPrograms")
Set oShellLink2 = WshShell.CreateShortcut(strStartMenu & "\FixLauncher\FixLauncher.lnk")
oShellLink2.TargetPath = strExePath
oShellLink2.IconLocation = strIconPath
oShellLink2.WorkingDirectory = strAppPath
oShellLink2.Description = "FixLauncher Launcher"
oShellLink2.Save

' Создаем ярлык для удаления
Set oShellLink3 = WshShell.CreateShortcut(strStartMenu & "\FixLauncher\Uninstall FixLauncher.lnk")
oShellLink3.TargetPath = "wscript.exe"
oShellLink3.Arguments = """uninstall.vbs"""
oShellLink3.IconLocation = strIconPath
oShellLink3.Description = "Uninstall FixLauncher"
oShellLink3.Save

MsgBox "FixLauncher installed successfully!" & vbCrLf & vbCrLf & "Shortcuts created on Desktop and Start Menu", vbInformation, "Installation Complete"
