namespace PopcornTray;

/**
 * Whether friends can reach the server from outside: asks for /api/health the way they come in, through the proxy
 * (app.tv.chzsda.com), so over the internet and Tailscale Funnel. The ts.net address itself would answer from this PC
 * over Tailscale even when Funnel has stopped, as it did on 2026-10-15.
 */
sealed class OutsideCheck(Log log)
{
    static readonly HttpClient http = new() { Timeout = TimeSpan.FromSeconds(15) };
    /** Missed this many times in a row before it counts as down, so one slow answer doesn't warn. */
    const int Misses = 2;
    int missed;

    /** Down after Misses failed checks in a row; null when there's nothing to check. */
    public bool? Down { get; private set; }

    /**
     * Where friends open the app: OUTSIDE_URL from .env, else the proxy's app address next to INVITE_URL
     * (https://tv.chzsda.com gives https://app.tv.chzsda.com; the invite address itself only redirects).
     */
    public static string? Address(Settings settings)
    {
        var set = settings.Env("OUTSIDE_URL");
        if (!string.IsNullOrWhiteSpace(set)) return set;
        return Uri.TryCreate(settings.Env("INVITE_URL"), UriKind.Absolute, out var invite) ? $"{invite.Scheme}://app.{invite.Host}" : null;
    }

    public void Reset()
    {
        missed = 0;
        Down = null;
    }

    /** Checks once; true when Down changed. */
    public async Task<bool> Check(string? address)
    {
        if (string.IsNullOrWhiteSpace(address))
        {
            var had = Down != null;
            Reset();
            return had;
        }
        var url = address.TrimEnd('/') + "/api/health";
        string? problem = null;
        try
        {
            using var res = await http.GetAsync(url);
            var body = await res.Content.ReadAsStringAsync();
            if (!res.IsSuccessStatusCode) problem = $"{(int)res.StatusCode} {res.ReasonPhrase}";
            else if (!body.Contains("\"ok\":true")) problem = "an answer that isn't from the server";
        }
        catch (Exception e)
        {
            problem = e is TaskCanceledException ? "no answer in 15 s" : e.Message;
        }
        var was = Down;
        if (problem == null)
        {
            missed = 0;
            Down = false;
        }
        else
        {
            missed++;
            log.Add($"Outside check: {url} gave {problem}.");
            if (missed >= Misses) Down = true;
            else Down ??= false;
        }
        return was != Down && !(was == null && Down == false);
    }
}
