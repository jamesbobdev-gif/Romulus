/* The hands for "Do it" (agent/pc-control.js, main/overlay.js): mouse and keyboard on his Windows PC through
   Windows' own SendInput, from one PowerShell process kept open for the run (no native module to build). It
   takes one JSON command a line on stdin and answers "ok <id>" or "err <id> <why>". x/y are physical screen
   pixels: the process is made per-monitor DPI aware first, so they land where Electron's screen points map to.
   Windows only; nothing else in the app uses it. */
const { spawn } = require('child_process');

const CS = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class RomulusInput {
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  public static void Aware() { try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (Exception) {} }
  // the window that would take the typing: its class and title, tab-separated (agent/pc-control.js terminalInFront)
  public static string Fg() {
    var h = GetForegroundWindow(); var c = new System.Text.StringBuilder(256); var t = new System.Text.StringBuilder(512);
    GetClassName(h, c, 256); GetWindowText(h, t, 512);
    return c.ToString() + "\t" + t.ToString();
  }
  static void Send(INPUT[] a) { if (SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(INPUT))) != a.Length) throw new Exception("Windows blocked the input (an admin window may be in front)"); }
  static INPUT M(uint flags, uint data) { var i = new INPUT(); i.type = 0; i.u.mi.dwFlags = flags; i.u.mi.mouseData = data; return i; }
  static INPUT K(ushort vk, ushort scan, uint flags) { var i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; return i; }
  public static void Move(int x, int y) { SetCursorPos(x, y); }
  public static void Click(int x, int y, string button, int count) {
    SetCursorPos(x, y); Thread.Sleep(40);
    uint down = 2, up = 4;
    if (button == "right") { down = 8; up = 16; } else if (button == "middle") { down = 32; up = 64; }
    for (int n = 0; n < count; n++) { Send(new INPUT[] { M(down, 0), M(up, 0) }); Thread.Sleep(60); }
  }
  public static void Scroll(int x, int y, int amount) { SetCursorPos(x, y); Thread.Sleep(40); Send(new INPUT[] { M(0x0800, (uint)(-amount * 120)) }); }
  public static void Drag(int x, int y, int x2, int y2) {
    SetCursorPos(x, y); Thread.Sleep(60); Send(new INPUT[] { M(2, 0) }); Thread.Sleep(80);
    for (int s = 1; s <= 12; s++) { SetCursorPos(x + (x2 - x) * s / 12, y + (y2 - y) * s / 12); Thread.Sleep(25); }
    Thread.Sleep(80); Send(new INPUT[] { M(4, 0) });
  }
  public static void Keys(int[] vks, bool[] ext) {
    var a = new INPUT[vks.Length * 2];
    for (int i = 0; i < vks.Length; i++) a[i] = K((ushort)vks[i], 0, ext[i] ? 1u : 0u);
    for (int i = 0; i < vks.Length; i++) a[vks.Length + i] = K((ushort)vks[vks.Length - 1 - i], 0, (ext[vks.Length - 1 - i] ? 1u : 0u) | 2u);
    Send(a);
  }
  public static void Type(string text) {
    foreach (char c in text) {
      if (c == '\r') continue;
      if (c == '\n') Send(new INPUT[] { K(13, 0, 0), K(13, 0, 2) });
      else if (c == '\t') Send(new INPUT[] { K(9, 0, 0), K(9, 0, 2) });
      else Send(new INPUT[] { K(0, c, 4), K(0, c, 6) });
      Thread.Sleep(8);
    }
  }
}`;

const PS = 'Add-Type -TypeDefinition @\'\n' + CS + '\n\'@\n' +
  '[RomulusInput]::Aware()\n' +
  '[Console]::Out.WriteLine("ready"); [Console]::Out.Flush()\n' +
  'while ($null -ne ($line = [Console]::In.ReadLine())) {\n' +
  '  $c = $null; $out = ""\n' +
  '  try {\n' +
  '    $c = $line | ConvertFrom-Json\n' +
  '    switch ($c.op) {\n' +
  '      "fg" { $out = [RomulusInput]::Fg() -replace "[\\r\\n]+", " " }\n' +
  '      "move" { [RomulusInput]::Move([int]$c.x, [int]$c.y) }\n' +
  '      "click" { [RomulusInput]::Click([int]$c.x, [int]$c.y, [string]$c.button, [int]$c.count) }\n' +
  '      "scroll" { [RomulusInput]::Scroll([int]$c.x, [int]$c.y, [int]$c.amount) }\n' +
  '      "drag" { [RomulusInput]::Drag([int]$c.x, [int]$c.y, [int]$c.x2, [int]$c.y2) }\n' +
  '      "keys" { [RomulusInput]::Keys([int[]]$c.vks, [bool[]]$c.ext) }\n' +
  '      "type" { [RomulusInput]::Type([string]$c.text) }\n' +
  '      default { throw "unknown command" }\n' +
  '    }\n' +
  '    [Console]::Out.WriteLine("ok " + $c.id + " " + $out)\n' +
  '  } catch { [Console]::Out.WriteLine("err " + $(if ($c) { $c.id } else { 0 }) + " " + ($_.Exception.Message -replace "\\s+", " ")) }\n' +
  '  [Console]::Out.Flush()\n' +
  '}\n';

/* → {run(cmd) → Promise (resolves with what the command answered: nothing, or the window in front for 'fg'), close()};
   rejects when PowerShell won't start. log(line) for what went wrong */
function start(log) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(new Error('Do it only works on Windows for now.'));
    let p;
    try {
      p = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(PS, 'utf16le').toString('base64')],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { return reject(new Error('Could not start PowerShell for the mouse and keyboard.')); }
    let buf = '', id = 0, ready = false, dead = false, errText = '';
    const pending = {};
    const fail = (why) => { dead = true; for (const k of Object.keys(pending)) { pending[k].reject(new Error(why)); delete pending[k]; } };
    const startTimer = setTimeout(() => { if (!ready) { try { p.kill(); } catch (e) {} reject(new Error('PowerShell took too long to start.')); } }, 30000);
    p.on('error', (e) => { fail('PowerShell stopped'); if (!ready) { clearTimeout(startTimer); reject(e); } });
    p.on('exit', () => {
      fail('PowerShell stopped');
      if (!ready) { clearTimeout(startTimer); if (log && errText) log('pc input: ' + errText.slice(0, 300)); reject(new Error('PowerShell could not set up the mouse and keyboard.')); }
    });
    p.stdin.on('error', () => {});
    p.stderr.on('data', (d) => { errText += d; });
    p.stdout.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!ready && line === 'ready') {
          ready = true; clearTimeout(startTimer);
          resolve({ run, close: () => { dead = true; try { p.stdin.end(); p.kill(); } catch (e) {} } });
          continue;
        }
        const m = /^(ok|err) (\d+) ?(.*)$/.exec(line);
        if (m && pending[m[2]]) {
          const q = pending[m[2]]; delete pending[m[2]];
          if (m[1] === 'ok') q.resolve(m[3] || ''); else q.reject(new Error(m[3] || 'input failed'));
        }
      }
    });
    function run(cmd) {
      return new Promise((res, rej) => {
        if (dead) return rej(new Error('PowerShell stopped'));
        const n = ++id;
        const t = setTimeout(() => { if (pending[n]) { delete pending[n]; rej(new Error('the input timed out')); } }, 60000);
        pending[n] = { resolve: (v) => { clearTimeout(t); res(v); }, reject: (e) => { clearTimeout(t); rej(e); } };
        p.stdin.write(JSON.stringify(Object.assign({ id: n }, cmd)) + '\n');
      });
    }
  });
}

module.exports = { start };
