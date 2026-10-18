import { spawn } from 'child_process';

/**
 * Desktop notifications without dependencies:
 * - Windows (and WSL, through Windows interop): a toast via PowerShell's WinRT access
 * - macOS: osascript
 * - Linux: notify-send
 * The text travels in environment variables, never inside a command string,
 * so titles and descriptions cannot break or inject into the command.
 */

export interface NotifyCommand {
  cmd: string;
  args: string[];
  env: Record<string, string>;
}

const TOAST = String.raw`
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$text = $xml.GetElementsByTagName('text')
$text.Item(0).AppendChild($xml.CreateTextNode($env:CLAUDE_AGENTS_TITLE)) | Out-Null
$text.Item(1).AppendChild($xml.CreateTextNode($env:CLAUDE_AGENTS_BODY)) | Out-Null
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
`;

export function notifyCommand(title: string, body: string, platform: NodeJS.Platform, wsl: boolean, wslenv = ''): NotifyCommand | undefined {
  const env: Record<string, string> = { CLAUDE_AGENTS_TITLE: title, CLAUDE_AGENTS_BODY: body };
  if (platform === 'win32' || wsl) {
    // From WSL, WSLENV lists which variables cross over to Windows programs.
    if (wsl) env.WSLENV = [wslenv.replace(/:+$/, ''), 'CLAUDE_AGENTS_TITLE/u', 'CLAUDE_AGENTS_BODY/u'].filter(Boolean).join(':');
    return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', TOAST], env };
  }
  if (platform === 'darwin') {
    return {
      cmd: 'osascript',
      args: ['-e', 'display notification (system attribute "CLAUDE_AGENTS_BODY") with title (system attribute "CLAUDE_AGENTS_TITLE")'],
      env,
    };
  }
  if (platform === 'linux') return { cmd: 'notify-send', args: ['--app-name=claude-agents', title, body], env };
  return undefined;
}

/** Fire-and-forget: a missing notifier or a failure never disturbs the UI. */
export function notify(title: string, body: string, platform: NodeJS.Platform, wsl: boolean): void {
  const c = notifyCommand(title, body, platform, wsl, process.env.WSLENV);
  if (!c) return;
  try {
    const child = spawn(c.cmd, c.args, { env: { ...process.env, ...c.env }, stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // no notifier available
  }
}
