using System.Text;

namespace PopcornTray;

/** The server's output: the last lines in memory for the log window, everything in server.log. */
sealed class Log
{
    const int Keep = 2000;
    const long MaxFileBytes = 5_000_000;

    readonly object gate = new();
    readonly LinkedList<string> lines = new();
    readonly StreamWriter? file;

    public event Action<string>? LineAdded;

    public Log()
    {
        try
        {
            Directory.CreateDirectory(Settings.Dir);
            var info = new FileInfo(Settings.LogPath);
            var append = !info.Exists || info.Length < MaxFileBytes;
            file = new StreamWriter(Settings.LogPath, append, new UTF8Encoding(false)) { AutoFlush = true };
        }
        catch
        {
            file = null;
        }
    }

    public void Add(string text)
    {
        var line = $"{DateTime.Now:HH:mm:ss}  {text}";
        lock (gate)
        {
            lines.AddLast(line);
            if (lines.Count > Keep) lines.RemoveFirst();
            try { file?.WriteLine(line); } catch { }
        }
        LineAdded?.Invoke(line);
    }

    public string[] Snapshot()
    {
        lock (gate) return lines.ToArray();
    }
}
