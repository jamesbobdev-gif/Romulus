/* Windows Hello for the Finance tab: the same Windows PIN, fingerprint or face he signs in with, asked
   through Windows' own prompt (Windows.Security.Credentials.UI.UserConsentVerifier, from PowerShell, since
   Electron has no Windows Hello call). It only answers "was it him?"; main/finance.js then opens the vault
   key it kept with Windows' encryption after his last passphrase unlock. The prompt is attached to the Tasks
   window (IUserConsentVerifierInterop, Microsoft's way for desktop apps), so it opens in front of it; a
   prompt asked from a hidden PowerShell alone can stay out of sight. */
const { spawn } = require('child_process');

const LOAD = `$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null=[Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime]
$asTask=([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op,$type){ $t=$asTask.MakeGenericMethod($type).Invoke($null,@($op)); $t.Wait(); $t.Result }
`;
// the prompt on a window: the interop interface, and IAsyncOperation<UserConsentVerificationResult>'s id
const FOR_WINDOW = `Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
[ComImport, Guid("39E050C3-4E74-441A-8DC0-B81104DF949C"), InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
public interface IUserConsentVerifierInterop {
  [return: MarshalAs(UnmanagedType.IInspectable)] object RequestVerificationForWindowAsync(IntPtr appWindow, [MarshalAs(UnmanagedType.HString)] string message, [In] ref Guid riid);
}
public static class TasksHello {
  public static object Ask(object factory, long hwnd, string msg, Guid iid) { return ((IUserConsentVerifierInterop)factory).RequestVerificationForWindowAsync(new IntPtr(hwnd), msg, ref iid); }
}
'@
$f=[System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeMarshal]::GetActivationFactory([Windows.Security.Credentials.UI.UserConsentVerifier])
$iid=[Guid]'fd596ffd-2318-558f-9dbe-d21df43764a5'
`;
// one PowerShell run → its trimmed output (no console window; the Hello prompt is Windows' own)
function run(script, ms) {
  return new Promise((resolve) => {
    let out = '';
    let p;
    // the whole script at once (its multi-line parts don't survive PowerShell reading it line by line)
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    try { p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true }); }
    catch (e) { resolve(''); return; }
    const timer = setTimeout(() => { try { p.kill(); } catch (e) {} resolve('Timeout'); }, ms);
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => { clearTimeout(timer); resolve(''); });
    p.on('close', () => { clearTimeout(timer); resolve(out.trim().split(/\r?\n/).pop() || ''); });
  });
}

let availableAt = 0, availableWas = false;
// is Windows Hello set up for him on this computer? (asked again after an hour)
async function available() {
  if (process.platform !== 'win32') return false;
  if (Date.now() - availableAt < 60 * 60 * 1000) return availableWas;
  const r = await run(LOAD + 'Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability])', 20000);
  availableWas = r === 'Available'; availableAt = Date.now();
  return availableWas;
}
/* Windows' prompt with this message → 'Verified', 'Canceled', 'RetriesExhausted', 'DeviceNotPresent',
   'NotConfiguredForUser', 'DisabledByPolicy', 'DeviceBusy', 'Timeout' or '' (couldn't ask) */
async function verify(message, hwnd) {
  if (process.platform !== 'win32') return '';
  const msg = String(message || 'Unlock Finance').replace(/'/g, "''").slice(0, 120);
  const type = '([Windows.Security.Credentials.UI.UserConsentVerificationResult])';
  const plain = `Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync('${msg}')) ${type}`;
  // on the Tasks window; if Windows won't (the window isn't in front, say), its plain prompt instead
  const ask = Number.isSafeInteger(hwnd) && hwnd > 0
    ? FOR_WINDOW + `try { Await ([TasksHello]::Ask($f, ${hwnd}, '${msg}', $iid)) ${type} } catch { ${plain} }`
    : plain;
  return run(LOAD + ask, 3 * 60 * 1000);
}
// what to tell him when it wasn't 'Verified'
function why(result) {
  return {
    Canceled: '', RetriesExhausted: 'Too many tries. Use your passphrase.', DeviceNotPresent: 'Windows Hello isn’t available right now. Use your passphrase.',
    NotConfiguredForUser: 'Windows Hello isn’t set up for your account. Use your passphrase.', DisabledByPolicy: 'Windows Hello is turned off on this computer. Use your passphrase.',
    DeviceBusy: 'Windows Hello is busy. Try again.', Timeout: 'Windows Hello didn’t answer. Try again or use your passphrase.',
  }[result] ?? 'Windows Hello couldn’t be asked. Use your passphrase.';
}

module.exports = { available, verify, why };
