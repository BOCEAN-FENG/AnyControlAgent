using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;

class Launcher : Form {
    readonly string root = AppDomain.CurrentDomain.BaseDirectory;
    readonly string settings = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AnyControlAgent", "workspace.txt");
    TextBox workspace = new TextBox(), key = new TextBox(), remote = new TextBox(), log = new TextBox();
    Label status = new Label();
    Button start = new Button(), stop = new Button(), tunnelButton = new Button(), choose;
    Process server, tunnel;
    string localUrl;
    bool stopping;
    IntPtr job;
    Timer tunnelTimeout = new Timer();

    [STAThread] static void Main() {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new Launcher());
    }
    public Launcher() {
        Text = "AnyControlAgent · 手机控制电脑";
        ClientSize = new Size(760, 565); MinimumSize = new Size(776, 604);
        Font = new Font("Microsoft YaHei UI", 10); StartPosition = FormStartPosition.CenterScreen;
        Label title = new Label { Text = "AnyControlAgent", Font = new Font(Font.FontFamily, 22, FontStyle.Bold), Left = 24, Top = 18, AutoSize = true }; Controls.Add(title);
        LabelAt("双击即启动 · Codex / Claude Code / 系统终端", 24, 65);
        LabelAt("工作目录", 24, 108);
        workspace.SetBounds(110, 104, 510, 30); Controls.Add(workspace);
        choose = ButtonAt("选择…", 632, 103, 100, delegate {
            using (FolderBrowserDialog d = new FolderBrowserDialog()) {
                d.SelectedPath = workspace.Text;
                if (d.ShowDialog() == DialogResult.OK) workspace.Text = d.SelectedPath;
            }
        });
        LabelAt("访问密钥", 24, 153);
        key.SetBounds(110, 148, 510, 30); key.ReadOnly = true; key.UseSystemPasswordChar = true; Controls.Add(key);
        ButtonAt("复制密钥", 632, 147, 100, delegate { Copy(key.Text); });
        CheckBox show = new CheckBox { Text = "显示密钥", Left = 110, Top = 183, Width = 130 };
        show.CheckedChanged += delegate { key.UseSystemPasswordChar = !show.Checked; }; Controls.Add(show);
        LabelAt("手机地址", 24, 221);
        remote.SetBounds(110, 217, 510, 30); remote.ReadOnly = true; Controls.Add(remote);
        ButtonAt("复制地址", 632, 216, 100, delegate { if (remote.Text.StartsWith("https://")) Copy(remote.Text); });
        start = ButtonAt("启动服务", 24, 266, 112, delegate { StartService(); });
        stop = ButtonAt("停止服务", 146, 266, 112, delegate { StopService(); }); stop.Enabled = false;
        ButtonAt("打开本机页面", 268, 266, 145, delegate { if (localUrl != null) Open(localUrl); });
        tunnelButton = ButtonAt("重连手机隧道", 423, 266, 145, delegate { StartTunnel(); }); tunnelButton.Enabled = false;
        status.SetBounds(24, 312, 708, 28); status.Text = "准备启动…"; Controls.Add(status);
        log.SetBounds(24, 345, 708, 162); log.Multiline = true; log.ReadOnly = true; log.ScrollBars = ScrollBars.Vertical;
        log.Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Top | AnchorStyles.Bottom; Controls.Add(log);
        Label note = new Label { Text = "手机打开 HTTPS 地址后输入密钥。关闭此窗口会结束服务和终端任务。", Left = 24, Top = 527, AutoSize = true, Anchor = AnchorStyles.Left | AnchorStyles.Bottom }; Controls.Add(note);
        workspace.Text = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
        if (File.Exists(settings)) { string saved = File.ReadAllText(settings); if (Directory.Exists(saved)) workspace.Text = saved; }
        CreateJob();
        tunnelTimeout.Interval = 60000;
        tunnelTimeout.Tick += delegate { tunnelTimeout.Stop(); if (!remote.Text.StartsWith("https://")) { status.Text = "本机服务可用；手机隧道尚未连接，可点击重连。"; Append("隧道连接超时，请检查网络或点击重连。"); } };
        Shown += delegate { StartService(); };
        FormClosing += delegate(object sender, FormClosingEventArgs e) {
            if (server != null && !server.HasExited && MessageBox.Show("关闭窗口会结束当前终端任务，确定退出？", Text, MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) { e.Cancel = true; return; }
            StopService(); if (job != IntPtr.Zero) CloseHandle(job);
        };
    }
    void LabelAt(string text, int x, int y) { Controls.Add(new Label { Text = text, Left = x, Top = y, AutoSize = true }); }
    Button ButtonAt(string text, int x, int y, int width, EventHandler action) {
        Button b = new Button { Text = text, Left = x, Top = y, Width = width, Height = 34 }; b.Click += action; Controls.Add(b); return b;
    }
    void UI(Action a) { if (!IsDisposed && IsHandleCreated) { try { BeginInvoke(a); } catch (InvalidOperationException) {} } }
    void Append(string s) { log.AppendText(DateTime.Now.ToString("HH:mm:ss ") + s + Environment.NewLine); }
    void Copy(string s) { if (!String.IsNullOrEmpty(s)) { try { Clipboard.SetText(s); status.Text = "已复制到剪贴板"; } catch (Exception ex) { Append(ex.Message); } } }
    void Open(string url) { try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch (Exception ex) { Append(ex.Message); } }
    Process MakeProcess(string exe, string args) {
        Process p = new Process();
        p.StartInfo = new ProcessStartInfo(exe, args) { WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8 };
        // Preserve installed CLI locations even when Explorer has an older PATH.
        p.StartInfo.EnvironmentVariables["PATH"] = Path.Combine(root, "runtime") + ";" + Environment.GetEnvironmentVariable("PATH") + ";" + Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "npm") + ";" + Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Microsoft", "WinGet", "Links");
        return p;
    }
    void StartService() {
        if (server != null && !server.HasExited) return;
        if (!Directory.Exists(workspace.Text)) { MessageBox.Show("请选择存在的工作目录。"); return; }
        stopping = false; localUrl = null; remote.Clear();
        try {
            Directory.CreateDirectory(Path.GetDirectoryName(settings)); File.WriteAllText(settings, workspace.Text);
            byte[] bytes = new byte[24]; using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(bytes);
            key.Text = BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant();
            Process p = MakeProcess(Path.Combine(root, "runtime", "node.exe"), "\"" + Path.Combine(root, "desktop", "host.mjs") + "\"");
            p.StartInfo.EnvironmentVariables["BRIDGE_TOKEN"] = key.Text;
            p.StartInfo.EnvironmentVariables["BRIDGE_CWD"] = workspace.Text;
            p.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) UI(delegate {
                if (server != p || stopping) return;
                if (e.Data.StartsWith("READY:")) {
                    int port; if (!Int32.TryParse(e.Data.Substring(6), out port)) return;
                    localUrl = "http://127.0.0.1:" + port; status.Text = "本机服务已启动，正在连接手机隧道…";
                    Append("服务已就绪：" + localUrl); tunnelButton.Enabled = true; Open(localUrl); StartTunnel();
                } else Append(e.Data);
            }); };
            p.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) UI(delegate { Append(e.Data); }); };
            p.EnableRaisingEvents = true;
            p.Exited += delegate { UI(delegate { if (server == p && !stopping) { status.Text = "服务已退出，请查看日志后重新启动。"; StopService(); } }); };
            server = p; p.Start(); Assign(p); p.BeginOutputReadLine(); p.BeginErrorReadLine();
            start.Enabled = false; stop.Enabled = true; workspace.Enabled = false; choose.Enabled = false; status.Text = "正在启动本机服务…";
        } catch (Exception ex) { Append("启动失败：" + ex.Message); StopService(); }
    }
    void StartTunnel() {
        if (localUrl == null || stopping) return;
        KillTunnel(); remote.Text = "正在申请 HTTPS 地址…";
        try {
            Process p = MakeProcess(Path.Combine(root, "runtime", "cloudflared.exe"), "tunnel --config \"" + Path.Combine(root, "desktop", "cloudflared.yml") + "\" --url " + localUrl + " --no-autoupdate --protocol http2 --edge-ip-version 4");
            // The access key is passed only to the local server, never to the tunnel.
            p.StartInfo.EnvironmentVariables.Remove("BRIDGE_TOKEN");
            // This machine's proxy times out on the Quick Tunnel API; the tunnel uses direct transport.
            foreach (string name in new string[] { "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy" }) p.StartInfo.EnvironmentVariables.Remove(name);
            p.StartInfo.EnvironmentVariables["NO_PROXY"] = "*";
            p.StartInfo.EnvironmentVariables["GODEBUG"] = "http2client=0";
            DataReceivedEventHandler line = delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) UI(delegate {
                if (tunnel != p || stopping) return;
                Match m = Regex.Match(e.Data, @"https://[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com");
                if (m.Success) { remote.Text = m.Value; status.Text = "已生成手机地址；连接状态请查看下方日志。"; Append("手机地址：" + m.Value); }
                else { Append(e.Data); if (e.Data.Contains("Registered tunnel connection")) { tunnelTimeout.Stop(); status.Text = "服务与手机隧道已就绪"; } }
            }); };
            p.OutputDataReceived += line; p.ErrorDataReceived += line; p.EnableRaisingEvents = true;
            p.Exited += delegate { UI(delegate { if (tunnel == p && !stopping) { tunnelTimeout.Stop(); remote.Text = "隧道已断开，请点击重连"; status.Text = "本机服务仍可使用；手机隧道已退出。"; } }); };
            tunnel = p; p.Start(); Assign(p); p.BeginOutputReadLine(); p.BeginErrorReadLine(); tunnelTimeout.Start();
        } catch (Exception ex) { remote.Text = "隧道启动失败"; Append(ex.Message); }
    }
    void KillTunnel() { tunnelTimeout.Stop(); Process old = tunnel; tunnel = null; if (old != null) { try { if (!old.HasExited) { old.Kill(); old.WaitForExit(2000); } old.Dispose(); } catch {} } }
    void StopService() {
        stopping = true; KillTunnel(); Process old = server; server = null;
        if (old != null) { try { if (!old.HasExited) { old.StandardInput.WriteLine("stop"); old.StandardInput.Flush(); if (!old.WaitForExit(3000)) old.Kill(); } old.Dispose(); } catch {} }
        localUrl = null; key.Clear(); remote.Clear(); start.Enabled = true; stop.Enabled = false; tunnelButton.Enabled = false; workspace.Enabled = true; choose.Enabled = true; status.Text = "服务已停止";
    }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong a, b, c, d, e, f; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits { public BasicLimits BasicLimitInformation; public IoCounters IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, uint length);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    void CreateJob() {
        job = CreateJobObject(IntPtr.Zero, null); ExtendedLimits limits = new ExtendedLimits(); limits.BasicLimitInformation.LimitFlags = 0x2000;
        IntPtr ptr = Marshal.AllocHGlobal(Marshal.SizeOf(limits)); try { Marshal.StructureToPtr(limits, ptr, false); if (!SetInformationJobObject(job, 9, ptr, (uint)Marshal.SizeOf(limits))) { CloseHandle(job); job = IntPtr.Zero; } } finally { Marshal.FreeHGlobal(ptr); }
    }
    void Assign(Process p) { if (job != IntPtr.Zero && !AssignProcessToJobObject(job, p.Handle)) Append("提示：系统未启用子进程退出保护。"); }
}
