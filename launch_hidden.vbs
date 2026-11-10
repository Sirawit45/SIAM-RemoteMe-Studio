Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "c:\Users\Jo_save\Documents\Remote_me"
WshShell.Run """C:\Users\Jo_save\AppData\Local\Programs\Python\Python313\python.exe"" server.py", 0, False
