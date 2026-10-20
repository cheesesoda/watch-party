using System.Diagnostics;
using System.Security.Cryptography;

namespace PopcornTray;

/** The Popcorn Club server (npm start in the checkout), running hidden. */
sealed class Server(Log log)
{
    Process? process;
    ServerJob? job;

    public bool Running => process != null;
    /**
     * A fresh random key each start (TRAY_KEY), so the server takes Rescan library from this app and nobody else:
     * friends' connections through Tailscale Funnel also arrive from this PC.
     */
    public string Key { get; private set; } = "";
    /** True once the server has printed its "listening on" line. */
    public bool Listening { get; private set; }

    /** Fires on the server's own thread when it stops without being asked to (a crash, a bad .env). */
    public event Action? Crashed;
    public event Action? Ready;

    public bool Start(string repo)
    {
        if (process != null) return true;
        Listening = false;
        log.Add("--- Starting the server ---");
        Key = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        var info = Commands.Npm("start", repo);
        info.Environment["TRAY_KEY"] = Key;
        var p = new Process { StartInfo = info, EnableRaisingEvents = true };
        p.OutputDataReceived += (_, e) => OnLine(e.Data);
        p.ErrorDataReceived += (_, e) => OnLine(e.Data);
        // Hooked up before Start, so even an instant failure (npm not found) is noticed.
        p.Exited += (_, _) =>
        {
            if (!ReferenceEquals(process, p)) return;
            process = null;
            Listening = false;
            EndJob();
            log.Add($"--- The server stopped (exit code {p.ExitCode}) ---");
            Crashed?.Invoke();
        };
        process = p;
        var j = new ServerJob();
        job = j;
        try
        {
            p.Start();
            // Straight away, before cmd has had time to start npm, so every child lands in the job.
            if (!j.Add(p)) log.Add("(Couldn't group the server's processes; Stop may miss some.)");
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            return true;
        }
        catch (Exception e)
        {
            process = null;
            EndJob();
            p.Dispose();
            log.Add($"Couldn't start the server: {e.Message}");
            return false;
        }
    }

    void OnLine(string? line)
    {
        if (line == null) return;
        log.Add(line);
        if (!Listening && line.Contains("listening on"))
        {
            Listening = true;
            Ready?.Invoke();
        }
    }

    public void Stop()
    {
        var p = process;
        process = null;
        Listening = false;
        if (p == null) return;
        try
        {
            // npm starts cmd, which starts node: stop the whole tree, then anything left in the job.
            if (!p.HasExited) p.Kill(entireProcessTree: true);
            p.WaitForExit(5000);
        }
        catch { }
        EndJob();
        p.Dispose();
        log.Add("--- Server stopped ---");
    }

    void EndJob()
    {
        var j = job;
        job = null;
        if (j == null) return;
        j.Kill();
        j.Dispose();
    }
}
