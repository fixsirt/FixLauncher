Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Получаем путь к папке установки
strAppPath = fso.GetParentFolderName(WScript.ScriptFullName)

' Удаляем ярлыки
On Error Resume Next
WshShell.DeleteFile WshShell.SpecialFolders("AllUsersDesktop") & "\FixLauncher.lnk"
WshShell.DeleteFile WshShell.SpecialFolders("AllUsersPrograms") & "\FixLauncher\FixLauncher.lnk"
WshShell.DeleteFile WshShell.SpecialFolders("AllUsersPrograms") & "\FixLauncher\Uninstall FixLauncher.lnk"
On Error GoTo 0

' Удаляем папку FixLauncher в меню Пуск
On Error Resume Next
fso.DeleteFolder WshShell.SpecialFolders("AllUsersPrograms") & "\FixLauncher"
On Error GoTo 0

MsgBox "FixLauncher has been uninstalled.", vbInformation, "Uninstall Complete"

' Ждем немного и удаляем саму папку приложения
WScript.Sleep 1000
On Error Resume Next
fso.DeleteFolder strAppPath, True
On Error GoTo 0
