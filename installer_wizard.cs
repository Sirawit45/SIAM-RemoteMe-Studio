using System;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("SIAM RemoteMe Studio Setup")]
[assembly: AssemblyDescription("SIAM RemoteMe Studio (PRO 60FPS) Setup Wizard")]
[assembly: AssemblyCompany("SIAM RemoteMe Studio")]
[assembly: AssemblyProduct("SIAM RemoteMe Studio")]
[assembly: AssemblyVersion("2.7.0.0")]
[assembly: AssemblyFileVersion("2.7.0.0")]

namespace SiamRemoteMeSetup
{
    public class SetupWizardForm : Form
    {
        private int currentStep = 0; // 0=Welcome, 1=Options, 2=Installing, 3=Finished
        private Panel headerPanel;
        private Label headerTitle;
        private Label headerSubtitle;
        private PictureBox headerLogo;

        private Panel contentPanel;
        private Panel footerPanel;
        private Button btnBack;
        private Button btnNext;
        private Button btnCancel;

        // Step 1 controls
        private Panel pageWelcome;

        // Step 2 controls
        private Panel pageOptions;
        private TextBox txtInstallDir;
        private CheckBox chkDesktopShortcut;
        private CheckBox chkStartMenuShortcut;
        private CheckBox chkAutoStart;

        // Step 3 controls
        private Panel pageProgress;
        private ProgressBar progressBar;
        private Label lblProgressStatus;

        // Step 4 controls
        private Panel pageFinish;
        private CheckBox chkLaunchNow;

        private string defaultInstallDir;

        public SetupWizardForm()
        {
            defaultInstallDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs",
                "SIAM_RemoteMe_Studio"
            );

            this.Text = "ติดตั้งโปรแกรม SIAM RemoteMe Studio (PRO 60FPS) - Setup Wizard";
            this.Size = new Size(620, 450);
            this.FormBorderStyle = FormBorderStyle.FixedDialog;
            this.MaximizeBox = false;
            this.StartPosition = FormStartPosition.CenterScreen;
            this.BackColor = Color.White;
            this.Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);

            try
            {
                this.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            }
            catch { }

            InitLayout();
            ShowStep(0);
        }

        private void InitLayout()
        {
            // Header
            headerPanel = new Panel
            {
                Dock = DockStyle.Top,
                Height = 76,
                BackColor = Color.FromArgb(30, 21, 42)
            };

            headerLogo = new PictureBox
            {
                Location = new Point(20, 14),
                Size = new Size(48, 48),
                SizeMode = PictureBoxSizeMode.StretchImage
            };
            try
            {
                Icon appIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                if (appIcon != null) headerLogo.Image = appIcon.ToBitmap();
            }
            catch { }

            headerTitle = new Label
            {
                Text = "SIAM RemoteMe Studio (PRO 60FPS)",
                ForeColor = Color.White,
                Font = new Font("Segoe UI", 13f, FontStyle.Bold),
                Location = new Point(80, 14),
                AutoSize = true
            };

            headerSubtitle = new Label
            {
                Text = "ตัวช่วยติดตั้งโปรแกรมควบคุมหน้าจอระยะไกลและโอนย้ายไฟล์ความเร็วสูง",
                ForeColor = Color.FromArgb(203, 213, 225),
                Font = new Font("Segoe UI", 9f, FontStyle.Regular),
                Location = new Point(82, 42),
                AutoSize = true
            };

            headerPanel.Controls.Add(headerLogo);
            headerPanel.Controls.Add(headerTitle);
            headerPanel.Controls.Add(headerSubtitle);

            // Footer
            footerPanel = new Panel
            {
                Dock = DockStyle.Bottom,
                Height = 58,
                BackColor = Color.FromArgb(248, 250, 252)
            };
            Panel footerLine = new Panel
            {
                Dock = DockStyle.Top,
                Height = 1,
                BackColor = Color.FromArgb(226, 232, 240)
            };
            footerPanel.Controls.Add(footerLine);

            btnBack = new Button
            {
                Text = "< ย้อนกลับ (Back)",
                Size = new Size(125, 34),
                Location = new Point(235, 12),
                FlatStyle = FlatStyle.System,
                Cursor = Cursors.Hand
            };
            btnBack.Click += (s, e) => { if (currentStep == 1) ShowStep(0); };

            btnNext = new Button
            {
                Text = "ถัดไป (Next) >",
                Size = new Size(135, 34),
                Location = new Point(368, 12),
                BackColor = Color.FromArgb(225, 29, 72),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Segoe UI", 9.5f, FontStyle.Bold),
                Cursor = Cursors.Hand
            };
            btnNext.FlatAppearance.BorderSize = 0;
            btnNext.Click += OnNextClicked;

            btnCancel = new Button
            {
                Text = "ยกเลิก (Cancel)",
                Size = new Size(90, 34),
                Location = new Point(510, 12),
                FlatStyle = FlatStyle.System,
                Cursor = Cursors.Hand
            };
            btnCancel.Click += (s, e) =>
            {
                if (currentStep == 2) return;
                if (MessageBox.Show("คุณต้องการยกเลิกการติดตั้ง SIAM RemoteMe Studio หรือไม่?", "ยืนยันการยกเลิก", MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes)
                {
                    Application.Exit();
                }
            };

            footerPanel.Controls.Add(btnBack);
            footerPanel.Controls.Add(btnNext);
            footerPanel.Controls.Add(btnCancel);

            // Content Area
            contentPanel = new Panel
            {
                Dock = DockStyle.Fill,
                Padding = new Padding(28, 22, 28, 18),
                BackColor = Color.White
            };

            BuildWelcomePage();
            BuildOptionsPage();
            BuildProgressPage();
            BuildFinishPage();

            this.Controls.Add(contentPanel);
            this.Controls.Add(footerPanel);
            this.Controls.Add(headerPanel);
        }

        private void BuildWelcomePage()
        {
            pageWelcome = new Panel { Dock = DockStyle.Fill };

            Label lblWelcomeTitle = new Label
            {
                Text = "ยินดีต้อนรับสู่ตัวติดตั้งโปรแกรม SIAM RemoteMe Studio",
                Font = new Font("Segoe UI", 13f, FontStyle.Bold),
                ForeColor = Color.FromArgb(15, 23, 42),
                Location = new Point(0, 5),
                AutoSize = true
            };

            Label lblDesc = new Label
            {
                Text = "วิซาร์ดนี้จะติดตั้งโปรแกรม SIAM RemoteMe Studio (PRO 60FPS) ลงบนคอมพิวเตอร์ของคุณ\r\n\r\n" +
                       "คุณสมบัติหลักของโปรแกรม:\r\n" +
                       "  • แสดงรหัส ID ประจำเครื่อง 9 หลัก และรหัสผ่าน (Password) พร้อมปุ่มรีเฟรชรหัสใหม่\r\n" +
                       "  • ควบคุมหน้าจอระยะไกลความลื่นไหลสูง 60 FPS ข้ามเครือข่ายอินเทอร์เน็ตได้ทันที\r\n" +
                       "  • ระบบความปลอดภัยสูง มีป๊อปอัปแจ้งเตือนให้กดยอมรับ (Accept) และเปลี่ยนรหัสได้ตลอดเวลา\r\n" +
                       "  • โอนย้ายไฟล์ขนาดใหญ่ความเร็วสูง (Pause / Resume) ระหว่างคอมและมือถือ\r\n\r\n" +
                       "คลิกปุ่ม \"ถัดไป (Next) >\" เพื่อดำเนินการต่อ",
                Font = new Font("Segoe UI", 9.5f, FontStyle.Regular),
                ForeColor = Color.FromArgb(51, 65, 85),
                Location = new Point(0, 45),
                Size = new Size(555, 220)
            };

            pageWelcome.Controls.Add(lblWelcomeTitle);
            pageWelcome.Controls.Add(lblDesc);
            contentPanel.Controls.Add(pageWelcome);
        }

        private void BuildOptionsPage()
        {
            pageOptions = new Panel { Dock = DockStyle.Fill };

            Label lblTitle = new Label
            {
                Text = "เลือกโฟลเดอร์ติดตั้งและตั้งค่าทางลัด (Installation Options)",
                Font = new Font("Segoe UI", 11.5f, FontStyle.Bold),
                ForeColor = Color.FromArgb(15, 23, 42),
                Location = new Point(0, 0),
                AutoSize = true
            };

            Label lblFolder = new Label
            {
                Text = "โฟลเดอร์สำหรับติดตั้งโปรแกรม (Destination Folder):",
                Location = new Point(0, 34),
                AutoSize = true
            };

            txtInstallDir = new TextBox
            {
                Text = defaultInstallDir,
                Location = new Point(0, 58),
                Size = new Size(440, 28),
                Font = new Font("Consolas", 9.5f)
            };

            Button btnBrowse = new Button
            {
                Text = "เลือกโฟลเดอร์...",
                Location = new Point(448, 56),
                Size = new Size(105, 28),
                FlatStyle = FlatStyle.System
            };
            btnBrowse.Click += (s, e) =>
            {
                using (var fbd = new FolderBrowserDialog())
                {
                    fbd.SelectedPath = txtInstallDir.Text;
                    if (fbd.ShowDialog() == DialogResult.OK)
                    {
                        txtInstallDir.Text = Path.Combine(fbd.SelectedPath, "SIAM_RemoteMe_Studio");
                    }
                }
            };

            chkDesktopShortcut = new CheckBox
            {
                Text = "สร้างไอคอนโปรแกรมบนหน้าจอ Desktop (Create a Desktop shortcut)",
                Checked = true,
                Location = new Point(4, 108),
                AutoSize = true,
                Font = new Font("Segoe UI", 9.5f, FontStyle.Bold)
            };

            chkStartMenuShortcut = new CheckBox
            {
                Text = "สร้างทางลัดในเมนู Start ของ Windows (Create Start Menu shortcut)",
                Checked = true,
                Location = new Point(4, 140),
                AutoSize = true
            };

            chkAutoStart = new CheckBox
            {
                Text = "เปิดระบบเตรียมพร้อมรับการรีโมทอัตโนมัติเมื่อเปิดเครื่องคอมพิวเตอร์ (Auto-Start)",
                Checked = true,
                Location = new Point(4, 172),
                AutoSize = true
            };

            Label lblNote = new Label
            {
                Text = "เมื่อพร้อมแล้ว คลิกปุ่ม \"ติดตั้ง (Install) >\" เพื่อเริ่มติดตั้งโปรแกรมลงในเครื่อง",
                ForeColor = Color.FromArgb(100, 116, 139),
                Location = new Point(4, 218),
                AutoSize = true
            };

            pageOptions.Controls.Add(lblTitle);
            pageOptions.Controls.Add(lblFolder);
            pageOptions.Controls.Add(txtInstallDir);
            pageOptions.Controls.Add(btnBrowse);
            pageOptions.Controls.Add(chkDesktopShortcut);
            pageOptions.Controls.Add(chkStartMenuShortcut);
            pageOptions.Controls.Add(chkAutoStart);
            pageOptions.Controls.Add(lblNote);
            contentPanel.Controls.Add(pageOptions);
        }

        private void BuildProgressPage()
        {
            pageProgress = new Panel { Dock = DockStyle.Fill };

            Label lblTitle = new Label
            {
                Text = "กำลังติดตั้งโปรแกรม SIAM RemoteMe Studio...",
                Font = new Font("Segoe UI", 11.5f, FontStyle.Bold),
                ForeColor = Color.FromArgb(15, 23, 42),
                Location = new Point(0, 10),
                AutoSize = true
            };

            lblProgressStatus = new Label
            {
                Text = "กำลังเตรียมไฟล์ติดตั้ง...",
                Location = new Point(0, 48),
                Size = new Size(550, 24),
                ForeColor = Color.FromArgb(71, 85, 105)
            };

            progressBar = new ProgressBar
            {
                Location = new Point(0, 78),
                Size = new Size(550, 26),
                Minimum = 0,
                Maximum = 100,
                Value = 0
            };

            pageProgress.Controls.Add(lblTitle);
            pageProgress.Controls.Add(lblProgressStatus);
            pageProgress.Controls.Add(progressBar);
            contentPanel.Controls.Add(pageProgress);
        }

        private void BuildFinishPage()
        {
            pageFinish = new Panel { Dock = DockStyle.Fill };

            Label lblTitle = new Label
            {
                Text = "ติดตั้งโปรแกรม SIAM RemoteMe Studio เสร็จสมบูรณ์!",
                Font = new Font("Segoe UI", 13f, FontStyle.Bold),
                ForeColor = Color.FromArgb(16, 185, 129),
                Location = new Point(0, 10),
                AutoSize = true
            };

            Label lblDesc = new Label
            {
                Text = "ติดตั้งโปรแกรมลงในคอมพิวเตอร์เครื่องนี้เรียบร้อยแล้ว\r\n" +
                       "คุณสามารถเปิดโปรแกรมจากไอคอน \"SIAM RemoteMe Studio\" บนหน้าจอ Desktop ได้ตลอดเวลา\r\n\r\n" +
                       "เมื่อเปิดโปรแกรมขึ้นมา จะแสดงรหัส ID ประจำเครื่องนี้ และรหัสผ่าน (Password)\r\n" +
                       "พร้อมช่องสำหรับกรอก ID และ Password ของเครื่องปลายทางที่คุณต้องการควบคุม",
                Location = new Point(0, 50),
                Size = new Size(550, 115),
                ForeColor = Color.FromArgb(51, 65, 85)
            };

            chkLaunchNow = new CheckBox
            {
                Text = "เปิดโปรแกรม SIAM RemoteMe Studio ทันที (Launch application now)",
                Checked = true,
                Location = new Point(4, 175),
                AutoSize = true,
                Font = new Font("Segoe UI", 10f, FontStyle.Bold)
            };

            pageFinish.Controls.Add(lblTitle);
            pageFinish.Controls.Add(lblDesc);
            pageFinish.Controls.Add(chkLaunchNow);
            contentPanel.Controls.Add(pageFinish);
        }

        private void ShowStep(int step)
        {
            currentStep = step;
            pageWelcome.Visible = (step == 0);
            pageOptions.Visible = (step == 1);
            pageProgress.Visible = (step == 2);
            pageFinish.Visible = (step == 3);

            if (step == 0)
            {
                btnBack.Enabled = false;
                btnNext.Text = "ถัดไป (Next) >";
                btnCancel.Enabled = true;
            }
            else if (step == 1)
            {
                btnBack.Enabled = true;
                btnNext.Text = "ติดตั้ง (Install) >";
                btnCancel.Enabled = true;
            }
            else if (step == 2)
            {
                btnBack.Enabled = false;
                btnNext.Enabled = false;
                btnCancel.Enabled = false;
            }
            else if (step == 3)
            {
                btnBack.Visible = false;
                btnCancel.Visible = false;
                btnNext.Enabled = true;
                btnNext.Location = new Point(465, 12);
                btnNext.Text = "เสร็จสิ้น (Finish)";
            }
        }

        private void OnNextClicked(object sender, EventArgs e)
        {
            if (currentStep == 0)
            {
                ShowStep(1);
            }
            else if (currentStep == 1)
            {
                ShowStep(2);
                Thread t = new Thread(RunInstallation);
                t.IsBackground = true;
                t.Start();
            }
            else if (currentStep == 3)
            {
                if (chkLaunchNow.Checked)
                {
                    try
                    {
                        string exePath = Path.Combine(txtInstallDir.Text.Trim(), "SIAM_RemoteMe_Studio.exe");
                        if (File.Exists(exePath))
                        {
                            ProcessStartInfo psi = new ProcessStartInfo(exePath)
                            {
                                WorkingDirectory = txtInstallDir.Text.Trim(),
                                UseShellExecute = true
                            };
                            Process.Start(psi);
                        }
                    }
                    catch { }
                }
                Application.Exit();
            }
        }

        private void UpdateProgress(int percent, string message)
        {
            if (this.InvokeRequired)
            {
                this.Invoke(new Action<int, string>(UpdateProgress), percent, message);
                return;
            }
            progressBar.Value = Math.Min(100, Math.Max(0, percent));
            lblProgressStatus.Text = message;
        }

        private void RunInstallation()
        {
            string targetDir = txtInstallDir.Text.Trim();
            try
            {
                UpdateProgress(10, "กำลังสร้างโฟลเดอร์ติดตั้ง: " + targetDir);
                if (!Directory.Exists(targetDir))
                {
                    Directory.CreateDirectory(targetDir);
                }

                // Kill existing instance if running from targetDir
                foreach (var proc in Process.GetProcessesByName("SIAM_RemoteMe_Studio"))
                {
                    try { proc.Kill(); proc.WaitForExit(2000); } catch { }
                }

                UpdateProgress(25, "กำลังแตกไฟล์โปรแกรม SIAM RemoteMe Studio...");
                string tempZip = Path.Combine(Path.GetTempPath(), "siam_remoteme_payload_" + Guid.NewGuid().ToString("N") + ".zip");
                using (Stream resStream = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
                {
                    if (resStream == null)
                        throw new Exception("ไม่พบไฟล์ข้อมูลติดตั้งภายในแพ็กเกจ (payload.zip)");
                    using (FileStream fs = new FileStream(tempZip, FileMode.Create, FileAccess.Write))
                    {
                        resStream.CopyTo(fs);
                    }
                }

                UpdateProgress(55, "กำลังคัดลอกไฟล์ระบบและโมดูลเชื่อมต่อออนไลน์...");
                using (ZipArchive archive = ZipFile.OpenRead(tempZip))
                {
                    int total = archive.Entries.Count;
                    int idx = 0;
                    foreach (ZipArchiveEntry entry in archive.Entries)
                    {
                        idx++;
                        string fullPath = Path.Combine(targetDir, entry.FullName);
                        string dirName = Path.GetDirectoryName(fullPath);
                        if (!string.IsNullOrEmpty(dirName) && !Directory.Exists(dirName))
                        {
                            Directory.CreateDirectory(dirName);
                        }
                        if (!string.IsNullOrEmpty(entry.Name))
                        {
                            entry.ExtractToFile(fullPath, true);
                        }
                        int pct = 55 + (int)((idx / (double)Math.Max(1, total)) * 25);
                        UpdateProgress(pct, "กำลังติดตั้ง: " + entry.Name);
                    }
                }
                try { File.Delete(tempZip); } catch { }

                string mainExe = Path.Combine(targetDir, "SIAM_RemoteMe_Studio.exe");

                if (chkDesktopShortcut.Checked)
                {
                    UpdateProgress(85, "กำลังสร้างไอคอนทางลัดบนหน้าจอ Desktop...");
                    string desktopDir = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                    CreateShortcut(Path.Combine(desktopDir, "SIAM RemoteMe Studio.lnk"), mainExe, targetDir, "โปรแกรมรีโมทควบคุมหน้าจอและโอนย้ายไฟล์ 60FPS");
                }

                if (chkStartMenuShortcut.Checked)
                {
                    UpdateProgress(90, "กำลังสร้างทางลัดในเมนู Start...");
                    string startMenuDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "SIAM RemoteMe Studio");
                    if (!Directory.Exists(startMenuDir)) Directory.CreateDirectory(startMenuDir);
                    CreateShortcut(Path.Combine(startMenuDir, "SIAM RemoteMe Studio.lnk"), mainExe, targetDir, "โปรแกรมรีโมทควบคุมหน้าจอและโอนย้ายไฟล์ 60FPS");
                }

                if (chkAutoStart.Checked)
                {
                    UpdateProgress(95, "กำลังตั้งค่าเปิดใช้งานอัตโนมัติเมื่อเปิดเครื่อง...");
                    try
                    {
                        using (RegistryKey rk = Registry.CurrentUser.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Run", true))
                        {
                            if (rk != null)
                            {
                                rk.SetValue("SIAM_RemoteMe_Studio", "\"" + mainExe + "\" --headless");
                            }
                        }
                    }
                    catch { }
                }

                UpdateProgress(100, "ติดตั้งเสร็จสมบูรณ์!");
                Thread.Sleep(400);
                this.Invoke(new Action(() => ShowStep(3)));
            }
            catch (Exception ex)
            {
                this.Invoke(new Action(() =>
                {
                    MessageBox.Show("เกิดข้อผิดพลาดระหว่างการติดตั้ง:\r\n" + ex.Message, "ข้อผิดพลาด", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    ShowStep(1);
                    btnNext.Enabled = true;
                }));
            }
        }

        private void CreateShortcut(string shortcutPath, string targetExe, string workingDir, string description)
        {
            try
            {
                Type shellType = Type.GetTypeFromProgID("WScript.Shell");
                dynamic shell = Activator.CreateInstance(shellType);
                dynamic shortcut = shell.CreateShortcut(shortcutPath);
                shortcut.TargetPath = targetExe;
                shortcut.WorkingDirectory = workingDir;
                shortcut.Description = description;
                shortcut.IconLocation = targetExe + ",0";
                shortcut.Save();
            }
            catch { }
        }

        [STAThread]
        public static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new SetupWizardForm());
        }
    }
}
