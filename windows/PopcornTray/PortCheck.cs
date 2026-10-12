using System.Diagnostics;
using System.Net.NetworkInformation;

namespace PopcornTray;

/** Who, if anyone, is already listening on the server's port. */
static class PortCheck
{
    public static bool InUse(int port) =>
        IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners().Any(e => e.Port == port);

    /** Waits up to the timeout for the port to be free (a server that was just stopped can hold it briefly). */
    public static async Task<bool> WaitFree(int port, int timeoutMs)
    {
        var sw = Stopwatch.StartNew();
        while (InUse(port))
        {
            if (sw.ElapsedMilliseconds >= timeoutMs) return false;
            await Task.Delay(250);
        }
        return true;
    }

    /** The process listening on the port, from netstat; null if it can't be found. */
    public static async Task<Process?> Owner(int port)
    {
        var text = await Commands.Output(Commands.Info("netstat", "-ano -p tcp", Environment.SystemDirectory));
        foreach (var line in text.Split('\n'))
        {
            var cols = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            // Proto  Local Address  Foreign Address  State  PID
            if (cols.Length < 5 || cols[3] != "LISTENING" || !cols[1].EndsWith($":{port}")) continue;
            if (!int.TryParse(cols[4], out var pid) || pid == 0) continue;
            try { return Process.GetProcessById(pid); }
            catch { }
        }
        return null;
    }
}
