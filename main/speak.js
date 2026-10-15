/* Speak (desktop): Windows' own offline dictation (System.Speech), run in a hidden PowerShell. It listens
   to the default microphone until a pause, streams what it's hearing ("P:" lines → the task box), and
   returns the final text ("F:" line); the renderer turns it into a task the same way as on the phone. */
let ctx = null; // { agentLog }
function init(c) { ctx = c; }
const agentLog = (m) => ctx.agentLog(m);
const handlers = {};
const handle = (ch, fn) => { handlers[ch] = fn; };

const VOICE_PS = `
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Speech
$code = @"
using System; using System.Speech.Recognition; using System.Globalization;
public static class Dict {
  public static string Run() {
    using (var e = new SpeechRecognitionEngine(new CultureInfo("en-US"))) {
      e.LoadGrammar(new DictationGrammar());
      e.SetInputToDefaultAudioDevice();
      e.EndSilenceTimeout = TimeSpan.FromSeconds(1.2);
      e.SpeechHypothesized += (s, a) => { Console.WriteLine("P:" + a.Result.Text); Console.Out.Flush(); };
      var r = e.Recognize(TimeSpan.FromSeconds(10));
      return r == null ? "" : r.Text;
    }
  }
}
"@
Add-Type -ReferencedAssemblies System.Speech -TypeDefinition $code
[Console]::WriteLine("F:" + [Dict]::Run())
`;
let voiceProc = null;
handle('voice:listen', (event) => new Promise((resolve) => {
  if (voiceProc) { try { voiceProc.kill(); } catch (e) {} }
  let out = '', finalText = null, err = '';
  const p = voiceProc = require('child_process').spawn('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(VOICE_PS, 'utf16le').toString('base64')],
    { windowsHide: true });
  // constant background sound (a video, people talking) never gives it the pause it waits for: give up
  // after 20 s and let James check what it heard instead of adding it
  let timedOut = false;
  const killer = setTimeout(() => { timedOut = true; try { p.kill(); } catch (e) {} }, 20 * 1000);
  p.stdout.on('data', (d) => {
    out += d;
    let i;
    while ((i = out.indexOf('\n')) >= 0) {
      const line = out.slice(0, i).replace(/\r$/, ''); out = out.slice(i + 1);
      if (line.startsWith('P:') && !event.sender.isDestroyed()) event.sender.send('voice:partial', line.slice(2));
      else if (line.startsWith('F:')) finalText = line.slice(2);
    }
  });
  p.stderr.on('data', (d) => { err += d; });
  p.on('error', (e) => { clearTimeout(killer); if (voiceProc === p) voiceProc = null; resolve({ text: '', error: e.message }); });
  p.on('close', () => {
    clearTimeout(killer);
    const stopped = voiceProc !== p; // Stop pressed (or a new listen): keep what was heard so far
    if (voiceProc === p) voiceProc = null;
    if (finalText === null && err) agentLog('voice: ' + err.replace(/\s+/g, ' ').slice(0, 200));
    resolve({ text: (finalText != null ? finalText : '').trim(), stopped, timedOut,
      error: finalText === null && !stopped && !timedOut && err ?'Windows speech recognition didn’t start (is the microphone allowed for desktop apps?)' : undefined });
  });
}));
handle('voice:stop', () => { const p = voiceProc; voiceProc = null; if (p) { try { p.kill(); } catch (e) {} } return true; });


module.exports = { init, handlers };
