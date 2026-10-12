using System.Diagnostics;
using System.Text;

namespace PopcornTray;

/** Starts command-line programs hidden, with their output going to the log. */
static class Commands
{
    /** npm through cmd.exe: npm.cmd works whatever PowerShell's script policy says. */
    public static ProcessStartInfo Npm(string args, string dir) => Info("cmd.exe", $"/d /s /c \"npm.cmd {args}\"", dir);

    public static ProcessStartInfo Info(string file, string args, string dir)
    {
        var psi = new ProcessStartInfo(file, args)
        {
            WorkingDirectory = dir,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        psi.Environment["NO_COLOR"] = "1";
        psi.Environment["FORCE_COLOR"] = "0";
        return psi;
    }

    public static Process Start(ProcessStartInfo psi, Action<string> onLine)
    {
        var p = new Process { StartInfo = psi, EnableRaisingEvents = true };
        p.OutputDataReceived += (_, e) => { if (e.Data != null) onLine(e.Data); };
        p.ErrorDataReceived += (_, e) => { if (e.Data != null) onLine(e.Data); };
        p.Start();
        p.BeginOutputReadLine();
        p.BeginErrorReadLine();
        return p;
    }

    /** Runs to the end and returns what it printed; empty if it failed. */
    public static async Task<string> Output(ProcessStartInfo psi)
    {
        try
        {
            using var p = Process.Start(psi)!;
            var text = await p.StandardOutput.ReadToEndAsync();
            await p.WaitForExitAsync();
            return p.ExitCode == 0 ? text : "";
        }
        catch
        {
            return "";
        }
    }

    /** Runs to the end and returns the exit code; -1 if the program couldn't start. */
    public static async Task<int> Run(ProcessStartInfo psi, Action<string> onLine)
    {
        onLine($"> {Path.GetFileNameWithoutExtension(psi.FileName)} {psi.Arguments}");
        try
        {
            using var p = Start(psi, onLine);
            await p.WaitForExitAsync();
            return p.ExitCode;
        }
        catch (Exception e)
        {
            onLine($"Couldn't run {psi.FileName}: {e.Message}");
            return -1;
        }
    }
}
