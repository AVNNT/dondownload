using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

// DonDownload tray stub.
//
// When the desktop app has nothing to do, Electron hands the tray icon to this
// tiny native stub and quits. The stub owns nothing but a NotifyIcon: no window,
// no polling timer, no network and no browser bridge. Its whole job is to show
// the same tray entry, to reopen the real app and to remove its own icon on the
// way out.
//
// CLI contract (the Electron side depends on it exactly):
//   dondownload-tray.exe --app "<full path to DonDownload.exe>" [--icon "<path to .ico>"]
//       Show the tray icon. No icon means the icon is extracted from --app.
//       A second normal launch exits immediately (named mutex).
//   dondownload-tray.exe --exit
//       Ask the running stub to remove its icon and exit, then return 0. When no
//       stub is running this still returns 0.
//
// Exits: 0 success (including "nothing to do"), 1 invalid --app path, 2 usage.
internal static class TrayStub
{
    // Local\ keeps the names per logon session, so two users can each own one
    // tray icon without blocking each other.
    private const string MutexName = @"Local\DonDownloadTrayStub";
    private const string ExitEventName = @"Local\DonDownloadTrayStubExit";
    private const string Tooltip = "DonDownload";

    [STAThread]
    private static int Main(string[] args)
    {
        string appPath = null;
        string iconPath = null;
        bool exitRequested = false;

        for (int index = 0; index < args.Length; index++)
        {
            string argument = args[index];
            if (string.Equals(argument, "--exit", StringComparison.OrdinalIgnoreCase))
            {
                exitRequested = true;
            }
            else if (string.Equals(argument, "--app", StringComparison.OrdinalIgnoreCase))
            {
                if (index + 1 < args.Length)
                {
                    appPath = args[++index];
                }
            }
            else if (string.Equals(argument, "--icon", StringComparison.OrdinalIgnoreCase))
            {
                if (index + 1 < args.Length)
                {
                    iconPath = args[++index];
                }
            }
        }

        // --exit never takes the single-instance mutex: it must reach the stub
        // that already owns it.
        if (exitRequested)
        {
            return SignalExit();
        }

        if (string.IsNullOrEmpty(appPath))
        {
            return 2;
        }

        string fullAppPath;
        try
        {
            fullAppPath = Path.GetFullPath(appPath);
        }
        catch (Exception error)
        {
            CompanionLog.Write("stub.log", "invalid --app path (" + error.GetType().Name + ")");
            return 1;
        }
        if (!File.Exists(fullAppPath))
        {
            CompanionLog.Write("stub.log", "the --app executable does not exist");
            return 1;
        }

        return RunTray(fullAppPath, iconPath);
    }

    private static int SignalExit()
    {
        try
        {
            using (EventWaitHandle signal = EventWaitHandle.OpenExisting(ExitEventName))
            {
                signal.Set();
            }
        }
        catch (Exception)
        {
            // No stub is running, so there is nothing to stop. This is the
            // normal case during shutdown races.
        }
        return 0;
    }

    private static int RunTray(string appPath, string iconPath)
    {
        bool createdNew;
        using (Mutex instance = new Mutex(true, MutexName, out createdNew))
        {
            if (!createdNew)
            {
                // A second launch must not add a duplicate icon.
                return 0;
            }

            using (EventWaitHandle exitSignal = new EventWaitHandle(
                false,
                EventResetMode.ManualReset,
                ExitEventName))
            {
                // Clear a signal left behind by a stub that was killed.
                exitSignal.Reset();

                Application.EnableVisualStyles();

                Icon icon = LoadTrayIcon(iconPath, appPath);
                // An invisible window used only to marshal the --exit signal
                // onto the UI thread. No window is ever shown.
                Control dispatcher = new Control();
                dispatcher.CreateControl();

                NotifyIcon tray = new NotifyIcon();
                ContextMenuStrip menu = new ContextMenuStrip();
                RegisteredWaitHandle registration = null;

                try
                {
                    // One handler for every open gesture. A double click raises
                    // two clicks, so the flag keeps the app a single launch.
                    bool opening = false;
                    EventHandler open = delegate
                    {
                        if (opening)
                        {
                            return;
                        }
                        opening = true;
                        if (StartApp(appPath))
                        {
                            CompanionLog.Write("stub.log", "woke DonDownload and exited");
                            Application.Exit();
                        }
                        else
                        {
                            opening = false;
                        }
                    };

                    EventHandler quit = delegate { Application.Exit(); };

                    menu.Items.Add("Open DonDownload", null, open);
                    menu.Items.Add("Quit DonDownload", null, quit);

                    tray.Icon = icon;
                    tray.Text = Tooltip;
                    tray.ContextMenuStrip = menu;
                    tray.MouseClick += delegate(object sender, MouseEventArgs eventArgs)
                    {
                        if (eventArgs.Button == MouseButtons.Left)
                        {
                            open(sender, EventArgs.Empty);
                        }
                    };
                    tray.DoubleClick += open;
                    tray.Visible = true;

                    // One background wait, no timer and no polling: the pool
                    // thread wakes only when --exit signals the event.
                    registration = ThreadPool.RegisterWaitForSingleObject(
                        exitSignal,
                        delegate
                        {
                            try
                            {
                                dispatcher.BeginInvoke((Action)delegate { Application.Exit(); });
                            }
                            catch (Exception)
                            {
                                // The UI thread is already gone.
                            }
                        },
                        null,
                        Timeout.Infinite,
                        true);

                    // Start-up debris (icon bitmaps, JIT pages) is released once,
                    // as soon as the message loop is idle.
                    EventHandler trim = null;
                    trim = delegate
                    {
                        Application.Idle -= trim;
                        TrimWorkingSet();
                    };
                    Application.Idle += trim;

                    Application.Run();
                }
                finally
                {
                    if (registration != null)
                    {
                        registration.Unregister(null);
                    }
                    // Every exit path removes the icon before disposing, so no
                    // ghost icon is left in the notification area.
                    try
                    {
                        tray.Visible = false;
                    }
                    catch (Exception)
                    {
                    }
                    tray.Dispose();
                    menu.Dispose();
                    icon.Dispose();
                    dispatcher.Dispose();
                }
            }
        }
        return 0;
    }

    private static bool StartApp(string appPath)
    {
        try
        {
            ProcessStartInfo startInfo = new ProcessStartInfo(appPath);
            startInfo.UseShellExecute = false;
            startInfo.WorkingDirectory = Path.GetDirectoryName(appPath);
            Process.Start(startInfo);
            return true;
        }
        catch (Exception error)
        {
            // Keep the icon so the user can try again instead of losing both
            // the app and the tray entry.
            CompanionLog.Write("stub.log", "could not start the app (" + error.GetType().Name + ")");
            return false;
        }
    }

    private static Icon LoadTrayIcon(string iconPath, string appPath)
    {
        if (!string.IsNullOrEmpty(iconPath))
        {
            try
            {
                if (File.Exists(iconPath))
                {
                    return new Icon(iconPath);
                }
            }
            catch (Exception)
            {
            }
        }

        try
        {
            Icon extracted = Icon.ExtractAssociatedIcon(appPath);
            if (extracted != null)
            {
                return extracted;
            }
        }
        catch (Exception)
        {
        }

        return (Icon)SystemIcons.Application.Clone();
    }

    private static void TrimWorkingSet()
    {
        try
        {
            GC.Collect(GC.MaxGeneration, GCCollectionMode.Forced);
            GC.WaitForPendingFinalizers();
            GC.Collect(GC.MaxGeneration, GCCollectionMode.Forced);
            SetProcessWorkingSetSize(Process.GetCurrentProcess().Handle, new IntPtr(-1), new IntPtr(-1));
        }
        catch (Exception)
        {
        }
    }

    [DllImport("kernel32.dll")]
    private static extern bool SetProcessWorkingSetSize(
        IntPtr process,
        IntPtr minimumWorkingSetSize,
        IntPtr maximumWorkingSetSize);
}

// DonDownload companion log.
//
// The tray stub and the native messaging host are separate executables, so they
// cannot share the Electron logger. Each appends one line to its own small file
// in the same folder the app uses (%APPDATA%\dondownload\logs), capped at
// 256 KB by starting over once it grows past that. Nothing personal is ever
// written: only the event, an exit code or an exception type name.
internal static class CompanionLog
{
    private const long MaxBytes = 256 * 1024;

    internal static void Write(string fileName, string message)
    {
        try
        {
            string root = Environment.GetFolderPath(
                Environment.SpecialFolder.ApplicationData);
            if (string.IsNullOrEmpty(root))
            {
                return;
            }
            string directory = Path.Combine(root, "dondownload", "logs");
            Directory.CreateDirectory(directory);
            string path = Path.Combine(directory, fileName);
            FileInfo info = new FileInfo(path);
            if (info.Exists && info.Length > MaxBytes)
            {
                // One generation is enough for a stub or a host; keep it simple.
                File.Delete(path);
            }
            string line = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ") +
                " " + message + Environment.NewLine;
            File.AppendAllText(path, line);
        }
        catch (Exception)
        {
            // Logging must never break the stub or the host.
        }
    }
}
