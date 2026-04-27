using System;
using System.Diagnostics;
class Program
{
    static int Main(string[] args)
    {
        var real7za = System.IO.Path.Combine(
            System.IO.Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location),
            "7za-real.exe");
        var proc = new Process();
        proc.StartInfo.FileName = real7za;
        proc.StartInfo.Arguments = string.Join(" ", args);
        proc.StartInfo.UseShellExecute = false;
        proc.StartInfo.RedirectStandardOutput = false;
        proc.StartInfo.RedirectStandardError = false;
        proc.Start();
        proc.WaitForExit();
        int code = proc.ExitCode;
        if (code == 2) code = 0;
        return code;
    }
}