namespace PopcornTray;

static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        // One tray icon at a time. After a self-update the new copy waits for the old one to quit.
        using var mutex = new Mutex(false, @"Local\PopcornClubTray");
        var waitMs = args.Contains(TrayApp.AfterUpdateArg) ? 15_000 : 0;
        bool owned;
        try { owned = mutex.WaitOne(waitMs); }
        catch (AbandonedMutexException) { owned = true; }
        if (!owned)
        {
            MessageBox.Show("Popcorn Club is already running. Look for its icon by the clock.", "Popcorn Club");
            return;
        }

        AppIdentity.Register();
        ApplicationConfiguration.Initialize();
        SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());
        Application.Run(new TrayApp(args));
        mutex.ReleaseMutex();
    }
}
