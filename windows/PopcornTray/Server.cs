using System.Diagnostics;

namespace PopcornTray;

/** The Popcorn Club server (npm start in the checkout), running hidden. */
sealed class Server(Log log)
{
    Process? process;

    public bool Running => process != null;
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
        var p = new Process { StartInfo = Commands.Npm("start", repo), EnableRaisingEvents = true };
        p.OutputDataReceived += (_, e) => OnLine(e.Data);
        p.ErrorDataReceived += (_, e) => OnLine(e.Data);
        // Hooked up before Start, so even an instant failure (npm not found) is noticed.
        p.Exited += (_, _) =>
        {
            if (!ReferenceEquals(process, p)) return;
            process = null;
            Listening = false;
            log.Add($"--- The server stopped (exit code {p.ExitCode}) ---");
            Crashed?.Invoke();
        };
        process = p;
        try
        {
            p.Start();
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            return true;
        }
        catch (Exception e)
        {
            process = null;
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
            // npm starts cmd, which starts node: stop the whole tree.
            if (!p.HasExited) p.Kill(entireProcessTree: true);
            p.WaitForExit(5000);
        }
        catch { }
        p.Dispose();
        log.Add("--- Server stopped ---");
    }
}
