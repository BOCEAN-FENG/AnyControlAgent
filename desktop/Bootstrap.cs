using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

class Bootstrap {
    [STAThread] static int Main(string[] args) {
        Application.EnableVisualStyles();
        bool extractOnly = args.Length == 1 && args[0] == "--extract-only";
        if (extractOnly) { try { Extract(); return 0; } catch { return 1; } }
        Form splash = new Form { Text = "AnyControlAgent", ClientSize = new Size(410, 100), StartPosition = FormStartPosition.CenterScreen, FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false };
        splash.Controls.Add(new Label { Text = "正在准备运行环境，首次启动需要片刻…", AutoSize = true, Left = 22, Top = 37, Font = new Font("Microsoft YaHei UI", 11) });
        splash.Shown += delegate {
            Thread worker = new Thread(delegate() {
                try {
                    string directory = Extract();
                    Process.Start(new ProcessStartInfo(Path.Combine(directory, "AnyControlAgent.exe")) { WorkingDirectory = directory, UseShellExecute = true });
                } catch (Exception ex) { MessageBox.Show("启动失败：" + ex.Message, "AnyControlAgent"); }
                finally { splash.BeginInvoke(new Action(delegate { splash.Close(); })); }
            });
            worker.IsBackground = true; worker.Start();
        };
        Application.Run(splash); return 0;
    }
    static string Extract() {
        string exe = Application.ExecutablePath;
        string id;
        using (var sha = SHA256.Create()) using (var file = File.OpenRead(exe)) id = BitConverter.ToString(sha.ComputeHash(file)).Replace("-", "").Substring(0, 16);
        string directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AnyControlAgent", "app-" + id);
        using (Mutex mutex = new Mutex(false, "Local\\AnyControlAgentExtract" + id)) {
            try { mutex.WaitOne(); } catch (AbandonedMutexException) {}
            try {
                if (File.Exists(Path.Combine(directory, ".ready")) && File.Exists(Path.Combine(directory, "AnyControlAgent.exe"))) return directory;
                Directory.CreateDirectory(directory);
                byte[] marker = Encoding.ASCII.GetBytes("ACA_BUNDLE_V1");
                using (FileStream input = File.OpenRead(exe)) {
                    input.Seek(-marker.Length - 8, SeekOrigin.End);
                    BinaryReader reader = new BinaryReader(input);
                    long size = reader.ReadInt64();
                    if (Encoding.ASCII.GetString(reader.ReadBytes(marker.Length)) != "ACA_BUNDLE_V1" || size <= 0 || size > input.Length - marker.Length - 8) throw new InvalidDataException("内置文件包校验失败");
                    input.Seek(-marker.Length - 8 - size, SeekOrigin.End);
                    string zip = Path.Combine(directory, "payload.zip");
                    using (FileStream output = File.Create(zip)) {
                        byte[] buffer = new byte[1024 * 1024]; long remaining = size;
                        while (remaining > 0) { int read = input.Read(buffer, 0, (int)Math.Min(buffer.Length, remaining)); if (read == 0) throw new EndOfStreamException(); output.Write(buffer, 0, read); remaining -= read; }
                    }
                    using (ZipArchive archive = ZipFile.OpenRead(zip)) foreach (ZipArchiveEntry entry in archive.Entries) {
                        string target = Path.GetFullPath(Path.Combine(directory, entry.FullName));
                        if (!target.StartsWith(directory + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("非法文件路径");
                        if (String.IsNullOrEmpty(entry.Name)) Directory.CreateDirectory(target);
                        else { Directory.CreateDirectory(Path.GetDirectoryName(target)); entry.ExtractToFile(target, true); }
                    }
                    File.Delete(zip);
                }
                File.WriteAllText(Path.Combine(directory, ".ready"), id);
                return directory;
            } finally { mutex.ReleaseMutex(); }
        }
    }
}
