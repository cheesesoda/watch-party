namespace PopcornTray;

/** Shows the server's output as it comes in. */
sealed class LogWindow : Form
{
    readonly Log log;
    readonly TextBox box;

    public LogWindow(Log log)
    {
        this.log = log;
        Text = "Popcorn Club log";
        Icon = TrayApp.LoadIcon("icon.ico");
        Width = 900;
        Height = 520;
        StartPosition = FormStartPosition.CenterScreen;
        box = new TextBox
        {
            Dock = DockStyle.Fill,
            Multiline = true,
            ReadOnly = true,
            ScrollBars = ScrollBars.Both,
            WordWrap = false,
            Font = new Font("Consolas", 10f),
            BackColor = Color.FromArgb(15, 17, 21),
            ForeColor = Color.FromArgb(236, 238, 243),
        };
        var openFile = new Button { Text = "Open log file", AutoSize = true, Dock = DockStyle.Right };
        openFile.Click += (_, _) => TrayApp.OpenPath(Settings.LogPath);
        var bar = new Panel { Dock = DockStyle.Bottom, Height = 36, Padding = new Padding(6) };
        bar.Controls.Add(openFile);
        Controls.Add(box);
        Controls.Add(bar);

        box.Lines = log.Snapshot();
        log.LineAdded += OnLine;
        FormClosed += (_, _) => log.LineAdded -= OnLine;
        Shown += (_, _) => ScrollToEnd();
    }

    void OnLine(string line)
    {
        if (IsDisposed || !IsHandleCreated) return;
        BeginInvoke(() =>
        {
            if (box.TextLength > 1_000_000) box.Lines = log.Snapshot();
            else box.AppendText(Environment.NewLine + line);
            ScrollToEnd();
        });
    }

    void ScrollToEnd()
    {
        box.SelectionStart = box.TextLength;
        box.ScrollToCaret();
    }
}
