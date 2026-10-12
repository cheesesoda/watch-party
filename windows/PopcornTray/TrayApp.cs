using System.Diagnostics;

namespace PopcornTray;

/** The tray icon and its menu. Runs the server, opens the app, shows the log and installs updates. */
sealed class TrayApp : ApplicationContext
{
    public const string AfterUpdateArg = "--after-update";
    const string StartServerArg = "--start-server";

    readonly SynchronizationContext ui;
    readonly Settings settings = Settings.Load();
    readonly Log log = new();
    readonly Server server;
    readonly NotifyIcon tray;
    readonly Icon runningIcon = LoadIcon("icon.ico");
    readonly Icon stoppedIcon = LoadIcon("icon-stopped.ico");

    readonly ToolStripMenuItem statusItem = new() { Enabled = false };
    readonly ToolStripMenuItem openItem;
    readonly ToolStripMenuItem startItem;
    readonly ToolStripMenuItem stopItem;
    readonly ToolStripMenuItem restartItem;
    readonly ToolStripMenuItem updateItem;
    readonly ToolStripMenuItem startupItem;

    LogWindow? logWindow;
    bool updating;
    bool starting;

    public TrayApp(string[] args)
    {
        ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
        SelfUpdate.CleanUp();
        server = new Server(log);
        server.Ready += () => ui.Post(_ => Refresh(), null);
        server.Crashed += () => ui.Post(_ => OnCrash(), null);

        openItem = new ToolStripMenuItem("Open Popcorn Club", null, (_, _) => OpenApp()).WithIcon(ModernMenu.Open);
        startItem = new ToolStripMenuItem("Start server", null, (_, _) => StartServer()).WithIcon(ModernMenu.Play);
        stopItem = new ToolStripMenuItem("Stop server", null, (_, _) => { server.Stop(); Refresh(); }).WithIcon(ModernMenu.Stop);
        restartItem = new ToolStripMenuItem("Restart server", null, (_, _) => { server.Stop(); StartServer(); }).WithIcon(ModernMenu.Restart);
        updateItem = new ToolStripMenuItem("Update now…", null, async (_, _) => await Update()).WithIcon(ModernMenu.Update);
        // No icon: its check mark shows in the icon column.
        startupItem = new ToolStripMenuItem("Start with Windows", null, (_, _) => ToggleStartup());

        var settingsMenu = new ToolStripMenuItem("Settings").WithIcon(ModernMenu.Settings);
        settingsMenu.DropDownItems.AddRange(new ToolStripItem[] {
            startupItem,
            new ToolStripSeparator(),
            new ToolStripMenuItem("Edit server settings (.env)", null, (_, _) => OpenPath(Path.Combine(settings.RepoPath, ".env"), notepad: true)).WithIcon(ModernMenu.Edit),
            new ToolStripMenuItem("Open server folder", null, (_, _) => OpenPath(settings.RepoPath)).WithIcon(ModernMenu.Folder),
            new ToolStripMenuItem("Choose server folder…", null, (_, _) => { if (PickRepo()) { server.Stop(); StartServer(); } }).WithIcon(ModernMenu.Folder),
        });

        var menu = new ContextMenuStrip();
        menu.Items.AddRange(new ToolStripItem[] {
            statusItem,
            new ToolStripSeparator(),
            openItem,
            new ToolStripSeparator(),
            startItem,
            stopItem,
            restartItem,
            new ToolStripMenuItem("Show log", null, (_, _) => ShowLog()).WithIcon(ModernMenu.Log),
            new ToolStripSeparator(),
            updateItem,
            settingsMenu,
            new ToolStripSeparator(),
            new ToolStripMenuItem("Quit", null, (_, _) => Quit()).WithIcon(ModernMenu.Quit),
        });
        // Refresh first, so the icons are drawn for the items' current enabled state.
        menu.Opening += (_, _) => Refresh();
        ModernMenu.Apply(menu);
        openItem.Font = new Font(menu.Font, FontStyle.Bold);

        tray = new NotifyIcon { Icon = stoppedIcon, Text = "Popcorn Club", ContextMenuStrip = menu, Visible = true };
        tray.MouseClick += (_, e) => { if (e.Button == MouseButtons.Left) OpenApp(); };

        if (!Settings.IsRepo(settings.RepoPath)) FindRepo();
        Refresh();

        var startNow = args.Contains(StartServerArg) || (!args.Contains(AfterUpdateArg) && settings.StartServerOnLaunch);
        if (startNow && Settings.IsRepo(settings.RepoPath)) StartServer();
        if (args.Contains(AfterUpdateArg)) Notify(TakeSavedNews() ?? "Updated. The tray app was rebuilt with the latest changes.");
    }

    // --- server ---

    async void StartServer()
    {
        if (starting || server.Running) return;
        if (!Settings.IsRepo(settings.RepoPath) && !PickRepo()) return;
        starting = true;
        try
        {
            if (!await FreePort(settings.Port())) return;
            if (!server.Start(settings.RepoPath)) Notify("The server couldn't start. Is Node installed? See Show log.");
        }
        finally
        {
            starting = false;
            Refresh();
        }
    }

    /**
     * Makes sure nothing else holds the port: a server started from PowerShell, or one left over
     * from an earlier copy of the tray app. Offers to stop it rather than failing with EADDRINUSE.
     */
    async Task<bool> FreePort(int port)
    {
        if (await PortCheck.WaitFree(port, 5000)) return true;
        using var owner = await PortCheck.Owner(port);
        var who = owner == null ? "another program" : $"{owner.ProcessName}.exe (process {owner.Id})";
        log.Add($"Port {port} is already in use by {who}.");
        if (owner == null || !owner.ProcessName.Equals("node", StringComparison.OrdinalIgnoreCase))
        {
            Notify($"Port {port} is already in use by {who}, so the server can't start. See Show log.");
            return false;
        }
        var answer = MessageBox.Show(
            $"Another server is already using port {port} ({who}). It may have been started from PowerShell " +
            "or left over from before.\n\nStop it and start Popcorn Club here?",
            "Popcorn Club", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
        if (answer != DialogResult.Yes)
        {
            log.Add("Left the other server running.");
            return false;
        }
        try
        {
            owner.Kill(entireProcessTree: true);
            owner.WaitForExit(5000);
        }
        catch (Exception e)
        {
            log.Add($"Couldn't stop it: {e.Message}");
        }
        if (await PortCheck.WaitFree(port, 5000))
        {
            log.Add("Stopped the other server.");
            return true;
        }
        Notify($"Port {port} is still in use, so the server can't start. See Show log.");
        return false;
    }

    void OnCrash()
    {
        Refresh();
        if (!updating) Notify("The server stopped. Choose Show log to see why, or Start server to try again.");
    }

    void OpenApp()
    {
        if (!server.Running) StartServer();
        OpenPath($"http://localhost:{settings.Port()}");
    }

    // --- update (only when chosen from the menu) ---

    async Task Update()
    {
        if (updating) return;
        if (!Settings.IsRepo(settings.RepoPath) && !PickRepo()) return;
        updating = true;
        var wasRunning = server.Running;
        Refresh();
        Notify("Updating Popcorn Club…");
        log.Add("--- Updating ---");
        server.Stop();

        var repo = settings.RepoPath;
        var before = (await Commands.Output(Commands.Info("git", "rev-parse HEAD", repo))).Trim();
        var steps = new (string Label, Func<System.Diagnostics.ProcessStartInfo> Step)[]
        {
            ("switching to main", () => Commands.Info("git", "checkout main", repo)),
            ("downloading the latest code", () => Commands.Info("git", "pull --ff-only origin main", repo)),
            ("installing packages", () => Commands.Npm("ci", repo)),
            ("building the web app", () => Commands.Npm("run build", repo)),
        };
        foreach (var (label, step) in steps)
        {
            var code = await Commands.Run(step(), log.Add);
            if (code != 0)
            {
                log.Add($"--- Update failed while {label} ---");
                Notify($"The update failed while {label}. See Show log for details.");
                Finish(restart: wasRunning);
                return;
            }
        }

        // What's new: the titles of the PRs merged since the last update.
        var changes = before.Length == 0 ? "" : (await Commands.Output(
            Commands.Info("git", $"log --first-parent --merges --format=%b {before}..HEAD", repo))).Trim();
        var changeList = changes.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        log.Add(changeList.Length == 0 ? "What's new: nothing since the last update." : "What's new:");
        foreach (var change in changeList) log.Add($"  - {change}");

        string? newExe = null;
        if (before.Length > 0)
        {
            try { newExe = await SelfUpdate.RebuildIfChanged(repo, before, log.Add); }
            catch (Exception e) { log.Add($"Couldn't rebuild the tray app: {e.Message}"); }
        }

        if (newExe != null)
        {
            try
            {
                SelfUpdate.Swap(newExe);
                log.Add("--- Restarting the tray app ---");
                try { File.WriteAllText(NewsPath, News(changeList)); } catch { }
                var args = AfterUpdateArg + (wasRunning ? " " + StartServerArg : "");
                Process.Start(new ProcessStartInfo(Environment.ProcessPath!, args) { UseShellExecute = false });
                Quit();
                return;
            }
            catch (Exception e)
            {
                log.Add($"Couldn't replace the tray app: {e.Message}");
            }
        }

        log.Add("--- Update finished ---");
        Notify(News(changeList));
        Finish(restart: wasRunning);
    }

    static string NewsPath => Path.Combine(Settings.Dir, "whatsnew.txt");

    static string News(string[] changes) => changes.Length == 0
        ? "Popcorn Club is up to date. Nothing new since the last update."
        : $"Updated with {changes.Length} change{(changes.Length == 1 ? "" : "s")}: {string.Join("; ", changes)}";

    /** The news the copy before a self-update left behind. */
    static string? TakeSavedNews()
    {
        try
        {
            if (!File.Exists(NewsPath)) return null;
            var text = File.ReadAllText(NewsPath);
            File.Delete(NewsPath);
            return text;
        }
        catch
        {
            return null;
        }
    }

    void Finish(bool restart)
    {
        updating = false;
        if (restart) StartServer();
        Refresh();
    }

    // --- settings ---

    /** First run: use %UserProfile%\watch-party if it's there, otherwise ask. */
    void FindRepo()
    {
        var guess = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "watch-party");
        if (Settings.IsRepo(guess))
        {
            settings.RepoPath = guess;
            settings.Save();
            return;
        }
        PickRepo();
    }

    bool PickRepo()
    {
        using var dialog = new FolderBrowserDialog
        {
            Description = "Choose the watch-party folder (the one with package.json and the server folder).",
            UseDescriptionForTitle = true,
            SelectedPath = settings.RepoPath,
        };
        while (dialog.ShowDialog() == DialogResult.OK)
        {
            if (Settings.IsRepo(dialog.SelectedPath))
            {
                settings.RepoPath = dialog.SelectedPath;
                settings.Save();
                return true;
            }
            MessageBox.Show("That folder doesn't look like the watch-party folder. It should contain package.json and a server folder.", "Popcorn Club");
        }
        return false;
    }

    void ToggleStartup()
    {
        try { Settings.StartsWithWindows = !Settings.StartsWithWindows; }
        catch (Exception e) { MessageBox.Show($"Couldn't change that: {e.Message}", "Popcorn Club"); }
        Refresh();
    }

    // --- UI ---

    void Refresh()
    {
        var running = server.Running;
        var port = settings.Port();
        statusItem.Text = updating ? "Updating…"
            : !Settings.IsRepo(settings.RepoPath) ? "Server folder not set"
            : server.Listening ? $"Running on port {port}"
            : running ? "Starting…"
            : "Stopped";
        tray.Text = $"Popcorn Club: {statusItem.Text}";
        var dot = updating || (running && !server.Listening) ? Color.FromArgb(0xFF, 0x8E, 0x44)
            : server.Listening ? Color.FromArgb(0x3F, 0xB9, 0x50)
            : Color.FromArgb(0x8A, 0x8A, 0x8A);
        var oldDot = statusItem.Image;
        statusItem.Image = ModernMenu.Dot(dot, 16);
        oldDot?.Dispose();
        tray.Icon = running && !updating ? runningIcon : stoppedIcon;
        startItem.Enabled = !running && !updating;
        stopItem.Enabled = running && !updating;
        restartItem.Enabled = running && !updating;
        updateItem.Enabled = !updating;
        startupItem.Checked = Settings.StartsWithWindows;
    }

    void ShowLog()
    {
        if (logWindow == null || logWindow.IsDisposed)
        {
            logWindow = new LogWindow(log);
            logWindow.Show();
        }
        logWindow.Activate();
    }

    // Windows cuts notifications off at 255 characters; the full list is in the log.
    void Notify(string text) =>
        tray.ShowBalloonTip(4000, "Popcorn Club", text.Length > 250 ? text[..247] + "…" : text, ToolTipIcon.None);

    void Quit()
    {
        server.Stop();
        tray.Visible = false;
        tray.Dispose();
        logWindow?.Close();
        ExitThread();
    }

    // --- helpers ---

    public static Icon LoadIcon(string name)
    {
        using var stream = typeof(TrayApp).Assembly.GetManifestResourceStream(name)!;
        return new Icon(stream, SystemInformation.SmallIconSize);
    }

    public static void OpenPath(string path, bool notepad = false)
    {
        try
        {
            Process.Start(notepad
                ? new ProcessStartInfo("notepad.exe", $"\"{path}\"")
                : new ProcessStartInfo(path) { UseShellExecute = true });
        }
        catch (Exception e)
        {
            MessageBox.Show($"Couldn't open {path}: {e.Message}", "Popcorn Club");
        }
    }
}
