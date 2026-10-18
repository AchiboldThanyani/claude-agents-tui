import { AgentInfo, SessionInfo, Status } from './transcripts';
import { BOLD, C, Style, fg, paint } from './render';

/**
 * Turns status changes between scans into alerts:
 * - an agent that was running goes quiet → it probably waits on a permission prompt
 * - an agent finishes
 * - a session finishes its turn → Claude is waiting for you
 * The first scan only records the starting state, so old work never alerts.
 */

export interface Alert {
  /** 'attention' alerts ring the bell; 'info' ones only show the banner. */
  level: 'attention' | 'info';
  icon: string;
  title: string;
  body: string;
}

interface Seen {
  status: Status;
}

export class AlertTracker {
  private seen = new Map<string, Seen>();
  private seeded = false;

  update(sessions: SessionInfo[]): Alert[] {
    const alerts: Alert[] = [];
    const next = new Map<string, Seen>();

    for (const s of sessions) {
      const title = s.state.title ?? s.state.firstPrompt ?? s.id.slice(0, 8);
      const was = this.seen.get('session:' + s.id)?.status;
      next.set('session:' + s.id, { status: s.status });
      if (this.seeded && was === 'running' && s.status === 'done') {
        alerts.push({ level: 'attention', icon: '✓', title: `Your turn · ${s.project}`, body: title });
      }

      const walk = (agents: AgentInfo[]) =>
        agents.forEach((a) => {
          const before = this.seen.get('agent:' + a.id)?.status;
          next.set('agent:' + a.id, { status: a.status });
          const name = a.agentType.replace(/^.*:/, '');
          if (this.seeded && before === 'running' && a.status === 'idle') {
            alerts.push({ level: 'attention', icon: '◌', title: `${name} is waiting · ${s.project}`, body: `${a.description} (went quiet; it may need a permission answer)` });
          } else if (this.seeded && before && before !== 'done' && a.status === 'done') {
            alerts.push({ level: 'info', icon: '✓', title: `${name} finished · ${s.project}`, body: a.description });
          }
          walk(a.children);
        });
      walk(s.agents);
    }

    this.seen = next;
    this.seeded = true;
    // Attention first, so a banner or notification leads with what needs you.
    return alerts.sort((a, b) => Number(b.level === 'attention') - Number(a.level === 'attention'));
  }
}

/** One notification for a batch of alerts: the first in full, the rest counted. */
export function summarize(alerts: Alert[]): { title: string; body: string } {
  const [first, ...rest] = alerts;
  const more = rest.length ? `\n+${rest.length} more: ${rest.map((a) => a.title).join('; ')}` : '';
  return { title: `${first.icon} ${first.title}`, body: first.body + more };
}

/** The line under the header while an alert is fresh: "── ◌ Explore is waiting · extension ── +1 more ──". */
export function banner(alerts: Alert[], width: number, style: Style): string {
  const [first, ...rest] = alerts;
  const color = first.level === 'attention' ? C.warn : C.ok;
  const text = ` ${first.icon} ${first.title} `;
  const more = rest.length ? ` +${rest.length} more ` : '';
  const room = Math.max(0, width - 2 - more.length);
  const shown = text.length > room ? text.slice(0, Math.max(0, room - 2)) + '… ' : text;
  const fill = Math.max(0, width - 2 - shown.length - more.length);
  return (
    paint('──', fg(C.subtle), style) +
    paint(shown, `${BOLD};${fg(color)}`, style) +
    paint('─'.repeat(fill), fg(C.subtle), style) +
    paint(more, fg(C.muted), style)
  );
}
