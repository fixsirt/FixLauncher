Set objShell = CreateObject("WScript.Shell")
Set objFSO = CreateObject("Scripting.FileSystemObject")

' Получаем папку где лежит этот скрипт
strDir = objFSO.GetParentFolderName(WScript.ScriptFullName)

' Путь к electron.cmd в node_modules
strElectron = strDir & "\node_modules\.bin\electron.cmd"

' Запускаем без окна консоли (0 = скрытое окно)
objShell.Run "cmd /c """ & strElectron & """ """ & strDir & """", 0, False
