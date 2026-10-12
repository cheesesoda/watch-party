namespace PopcornTray;

/**
 * Rebuilds this tray app from the checkout after an update pulled changes to windows\, and swaps
 * the new .exe in. Only runs when you choose Update; nothing checks in the background.
 */
static class SelfUpdate
{
    /** Builds the new tray app into a staging folder and returns the .exe, or null when nothing changed or the build failed. */
    public static async Task<string?> RebuildIfChanged(string repo, string before, Action<string> log)
    {
        // git diff --quiet exits 1 when the folder changed between the two commits.
        var diff = await Commands.Run(Commands.Info("git", $"diff --quiet {before} HEAD -- windows", repo), log);
        if (diff == 0)
        {
            log("The tray app hasn't changed.");
            return null;
        }
        if (diff != 1) return null;

        var staging = Path.Combine(Settings.Dir, "build");
        try { if (Directory.Exists(staging)) Directory.Delete(staging, true); } catch { }
        var project = Path.Combine(repo, "windows", "PopcornTray", "PopcornTray.csproj");
        var code = await Commands.Run(Commands.Info("dotnet", $"publish \"{project}\" -c Release -o \"{staging}\"", repo), log);
        if (code != 0)
        {
            log(code == -1
                ? "The tray app changed, but the .NET 8 SDK isn't installed, so it wasn't rebuilt. The server is updated."
                : "The tray app didn't build, so the old one stays. The server is updated.");
            return null;
        }
        var exe = Path.Combine(staging, "PopcornClub.exe");
        return File.Exists(exe) ? exe : null;
    }

    /** Windows lets a running .exe be renamed but not overwritten: move this one aside, put the new one in its place. */
    public static void Swap(string built)
    {
        var exe = Environment.ProcessPath!;
        var old = exe + ".old";
        if (File.Exists(old)) File.Delete(old);
        File.Move(exe, old);
        File.Copy(built, exe);
    }

    /** Removes the copy left over from the last update. */
    public static void CleanUp()
    {
        try
        {
            var old = Environment.ProcessPath + ".old";
            if (File.Exists(old)) File.Delete(old);
        }
        catch { }
    }
}
