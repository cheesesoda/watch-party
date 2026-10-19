using System.Text.Json;
using Microsoft.Win32;

namespace PopcornTray;

/** What the tray app remembers, in %AppData%\Popcorn Club\settings.json. */
sealed class Settings
{
    /** The watch-party checkout: package.json, server\, web\ and .env live here. */
    public string RepoPath { get; set; } = "";
    public bool StartServerOnLaunch { get; set; } = true;

    public static string Dir => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Popcorn Club");
    static string FilePath => Path.Combine(Dir, "settings.json");
    public static string LogPath => Path.Combine(Dir, "server.log");

    public static Settings Load()
    {
        try { return JsonSerializer.Deserialize<Settings>(File.ReadAllText(FilePath)) ?? new Settings(); }
        catch { return new Settings(); }
    }

    public void Save()
    {
        Directory.CreateDirectory(Dir);
        File.WriteAllText(FilePath, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
    }

    public static bool IsRepo(string path) =>
        path.Length > 0 && File.Exists(Path.Combine(path, "package.json")) && Directory.Exists(Path.Combine(path, "server"));

    /** The port from the checkout's .env (PORT=…), else the server's default. */
    public int Port() => int.TryParse(Env("PORT"), out var port) ? port : 8080;

    /** A setting from the checkout's .env (NAME=…), or null. */
    public string? Env(string name)
    {
        try
        {
            foreach (var line in File.ReadLines(Path.Combine(RepoPath, ".env")))
            {
                var t = line.Trim();
                if (t.StartsWith(name + "=")) return t[(name.Length + 1)..].Trim().Trim('"');
            }
        }
        catch { }
        return null;
    }

    // "Start with Windows" is the usual per-user Run key, so it needs no admin rights.
    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    const string RunName = "Popcorn Club";

    public static bool StartsWithWindows
    {
        get
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKey);
            return key?.GetValue(RunName) is string;
        }
        set
        {
            using var key = Registry.CurrentUser.CreateSubKey(RunKey);
            if (value) key.SetValue(RunName, $"\"{Environment.ProcessPath}\"");
            else key.DeleteValue(RunName, false);
        }
    }
}
