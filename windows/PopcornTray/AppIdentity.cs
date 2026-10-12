using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace PopcornTray;

/// <summary>
/// Gives the app its own Windows identity, so notifications say "Popcorn Club" with the popcorn icon. Without one,
/// Windows names them after the .exe ("PopcornClub") and keeps showing whatever icon it cached for that path, which
/// was still the old square logo after the rebrand. A new ID means nothing cached to fall back on.
/// </summary>
static class AppIdentity
{
    public const string Id = "Cheesesoda.PopcornClub";

    [DllImport("shell32.dll", PreserveSig = false)]
    static extern void SetCurrentProcessExplicitAppUserModelID([MarshalAs(UnmanagedType.LPWStr)] string appId);

    public static void Register()
    {
        try
        {
            Directory.CreateDirectory(Settings.Dir);
            var iconPath = Path.Combine(Settings.Dir, "notification.png");
            using (var src = typeof(AppIdentity).Assembly.GetManifestResourceStream("notification.png")!)
            using (var dest = File.Create(iconPath))
                src.CopyTo(dest);

            using var key = Registry.CurrentUser.CreateSubKey($@"Software\Classes\AppUserModelId\{Id}");
            key.SetValue("DisplayName", "Popcorn Club");
            key.SetValue("IconUri", iconPath);
            SetCurrentProcessExplicitAppUserModelID(Id);
        }
        catch
        {
            // Only the notifications' name and icon depend on this, so the app runs on without it.
        }
    }
}
