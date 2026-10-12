using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace PopcornTray;

/**
 * Makes the tray menu look like a Windows 11 menu: rounded corners, light or dark to match Windows,
 * Segoe Fluent icons, rounded hover highlights and roomier rows. On Windows 10 it keeps square corners.
 */
static class ModernMenu
{
    // Glyphs from Segoe Fluent Icons (Windows 11), which Segoe MDL2 Assets (Windows 10) also has.
    public const char Open = '';
    public const char Play = '';
    public const char Stop = '';
    public const char Restart = '';
    public const char Log = '';
    public const char Update = '';
    public const char Settings = '';
    public const char Edit = '';
    public const char Folder = '';
    public const char Quit = '';
    const char Check = '';

    static readonly bool Windows11 = Environment.OSVersion.Version.Build >= 22000;
    static readonly string IconFont = HasFont("Segoe Fluent Icons") ? "Segoe Fluent Icons" : "Segoe MDL2 Assets";
    static readonly string TextFont = HasFont("Segoe UI Variable Text") ? "Segoe UI Variable Text" : "Segoe UI";

    static readonly Dictionary<ToolStripItem, char> glyphs = new();
    static readonly Renderer renderer = new();

    /** Styles a menu and its submenus. Icons follow the light or dark theme each time it opens. */
    public static void Apply(ContextMenuStrip menu)
    {
        Style(menu);
        menu.Opening += (_, _) =>
        {
            renderer.Palette = Palette.Current();
            menu.BackColor = renderer.Palette.Background;
            RefreshIcons(menu.Items);
        };
    }

    /** Gives a menu item a Fluent icon. */
    public static T WithIcon<T>(this T item, char glyph) where T : ToolStripItem
    {
        glyphs[item] = glyph;
        return item;
    }

    /** A small filled circle, for the status line. */
    public static Image Dot(Color color, int size)
    {
        var bmp = new Bitmap(size, size);
        using var g = Graphics.FromImage(bmp);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var d = size / 2f;
        using var brush = new SolidBrush(color);
        g.FillEllipse(brush, (size - d) / 2, (size - d) / 2, d, d);
        return bmp;
    }

    static void Style(ToolStripDropDownMenu menu)
    {
        menu.Renderer = renderer;
        menu.Font = new Font(TextFont, 9f);
        menu.Padding = new Padding(4, 4, 4, 4);
        menu.ShowCheckMargin = false;
        menu.ShowImageMargin = true;
        menu.ImageScalingSize = new Size(16, 16);
        // Windows 11 draws its own soft shadow around rounded menus; the classic one is square.
        menu.DropShadowEnabled = !Windows11;
        menu.HandleCreated += (_, _) => RoundCorners(menu);
        foreach (ToolStripItem item in menu.Items) StyleItem(item);
        menu.ItemAdded += (_, e) => StyleItem(e.Item!);
    }

    /** How far icons and text sit in from WinForms' default spot, for more room at the left edge. */
    const int Indent = 6;

    static void StyleItem(ToolStripItem item)
    {
        if (item is ToolStripSeparator)
        {
            item.AutoSize = false;
            item.Height = 9;
            return;
        }
        // Extra room on the right makes up for the icons and text being moved right by Indent.
        item.Padding = new Padding(4, 5, 4 + Indent, 5);
        // Checks HasDropDownItems first: reading DropDown would give every item an empty submenu.
        if (item is ToolStripMenuItem { HasDropDownItems: true } parent && parent.DropDown is ToolStripDropDownMenu sub)
        {
            Style(sub);
            sub.Opening += (_, _) =>
            {
                sub.BackColor = renderer.Palette.Background;
                RefreshIcons(sub.Items);
            };
        }
    }

    static void RefreshIcons(ToolStripItemCollection items)
    {
        foreach (ToolStripItem item in items)
        {
            if (!glyphs.TryGetValue(item, out var glyph)) continue;
            var color = item.Enabled ? renderer.Palette.Text : renderer.Palette.Disabled;
            var old = item.Image;
            item.Image = Glyph(glyph, color, 16);
            old?.Dispose();
        }
    }

    static Bitmap Glyph(char glyph, Color color, int size)
    {
        var bmp = new Bitmap(size, size);
        using var g = Graphics.FromImage(bmp);
        g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
        using var font = new Font(IconFont, size * 0.8f, GraphicsUnit.Pixel);
        using var brush = new SolidBrush(color);
        using var format = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
        g.DrawString(glyph.ToString(), font, brush, new RectangleF(0, 0, size, size), format);
        return bmp;
    }

    static bool HasFont(string name)
    {
        using var fonts = new InstalledFontCollection();
        return fonts.Families.Any(f => f.Name.Equals(name, StringComparison.OrdinalIgnoreCase));
    }

    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    static void RoundCorners(Control menu)
    {
        if (!Windows11) return;
        const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
        const int DWMWCP_ROUND = 2;
        var preference = DWMWCP_ROUND;
        try { DwmSetWindowAttribute(menu.Handle, DWMWA_WINDOW_CORNER_PREFERENCE, ref preference, sizeof(int)); }
        catch { }
    }

    /** Windows 11 menu colors, light or dark. */
    internal sealed record Palette(Color Background, Color Text, Color Disabled, Color Hover, Color Separator, Color Border)
    {
        static readonly Palette Dark = new(
            Color.FromArgb(0x2C, 0x2C, 0x2C), Color.FromArgb(0xFF, 0xFF, 0xFF), Color.FromArgb(0x9D, 0x9D, 0x9D),
            Color.FromArgb(0x3D, 0x3D, 0x3D), Color.FromArgb(0x45, 0x45, 0x45), Color.FromArgb(0x48, 0x48, 0x48));

        static readonly Palette Light = new(
            Color.FromArgb(0xF9, 0xF9, 0xF9), Color.FromArgb(0x1A, 0x1A, 0x1A), Color.FromArgb(0x8A, 0x8A, 0x8A),
            Color.FromArgb(0xEA, 0xEA, 0xEA), Color.FromArgb(0xE0, 0xE0, 0xE0), Color.FromArgb(0xD0, 0xD0, 0xD0));

        /** Follows Settings > Personalization > Colors ("Choose your mode", the Windows part of it). */
        public static Palette Current()
        {
            try
            {
                using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
                return key?.GetValue("SystemUsesLightTheme") is int light && light == 0 ? Dark : Light;
            }
            catch
            {
                return Light;
            }
        }
    }

    internal sealed class Renderer : ToolStripRenderer
    {
        public Palette Palette { get; set; } = Palette.Current();

        protected override void OnRenderToolStripBackground(ToolStripRenderEventArgs e) =>
            e.Graphics.Clear(Palette.Background);

        protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e)
        {
            // Windows 11 draws the border of a rounded menu itself.
            if (Windows11) return;
            using var pen = new Pen(Palette.Border);
            var r = new Rectangle(Point.Empty, e.ToolStrip.Size);
            r.Width--;
            r.Height--;
            e.Graphics.DrawRectangle(pen, r);
        }

        protected override void OnRenderImageMargin(ToolStripRenderEventArgs e) { }

        protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e)
        {
            if (!e.Item.Selected || !e.Item.Enabled) return;
            var r = new Rectangle(Point.Empty, e.Item.Size);
            r.Inflate(-2, -1);
            using var path = RoundedRect(r, 4);
            using var brush = new SolidBrush(Palette.Hover);
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            e.Graphics.FillPath(brush, path);
        }

        // Icons are already drawn in the right color for enabled and disabled items, and the status dot
        // keeps its color, so images are never grayed out.
        protected override void OnRenderItemImage(ToolStripItemImageRenderEventArgs e)
        {
            if (e.Image != null) e.Graphics.DrawImage(e.Image, Centered(e.Item, e.ImageRectangle));
        }

        // With padded items WinForms puts the image a few pixels lower than the text, so both are
        // centered on the item's full height instead.
        protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
        {
            e.TextColor = e.Item.Enabled ? Palette.Text : Palette.Disabled;
            e.TextRectangle = new Rectangle(e.TextRectangle.X + Indent, 0, e.TextRectangle.Width, e.Item.Height);
            e.TextFormat = (e.TextFormat & ~(TextFormatFlags.Top | TextFormatFlags.Bottom)) | TextFormatFlags.VerticalCenter;
            base.OnRenderItemText(e);
        }

        static Rectangle Centered(ToolStripItem item, Rectangle r) =>
            new(r.X + Indent, (item.Height - r.Height) / 2, r.Width, r.Height);

        protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e)
        {
            using var pen = new Pen(Palette.Separator);
            var y = e.Item.Height / 2;
            e.Graphics.DrawLine(pen, 4, y, e.Item.Width - 4, y);
        }

        protected override void OnRenderItemCheck(ToolStripItemImageRenderEventArgs e)
        {
            using var check = Glyph(Check, Palette.Text, e.ImageRectangle.Height);
            e.Graphics.DrawImage(check, Centered(e.Item, e.ImageRectangle));
        }

        protected override void OnRenderArrow(ToolStripArrowRenderEventArgs e)
        {
            e.ArrowColor = Palette.Text;
            base.OnRenderArrow(e);
        }

        static GraphicsPath RoundedRect(Rectangle r, int radius)
        {
            var d = radius * 2;
            var path = new GraphicsPath();
            path.AddArc(r.X, r.Y, d, d, 180, 90);
            path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }
    }
}
