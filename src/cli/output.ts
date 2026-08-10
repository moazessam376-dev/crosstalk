import type { CrosstalkEvent } from '../contracts/events.js';

/**
 * Older Windows consoles on a legacy codepage render box drawing as mojibake,
 * so nothing here needs Unicode. docs/CROSS-PLATFORM.md §7.
 */
export const useColour =
  process.env['NO_COLOR'] === undefined && process.stdout.isTTY === true;

export function dim(text: string): string {
  return useColour ? `[2m${text}[0m` : text;
}

export function bold(text: string): string {
  return useColour ? `[1m${text}[0m` : text;
}

export function emit(value: unknown, asJson: boolean, human: () => string): void {
  process.stdout.write(asJson ? `${JSON.stringify(value, null, 2)}\n` : `${human()}\n`);
}

export function table(rows: string[][]): string {
  if (rows.length === 0) return '(none)';
  const widths = rows[0]!.map((_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? '').length)),
  );
  return rows
    .map((row) => row.map((cell, index) => (cell ?? '').padEnd(widths[index]!)).join('  ').trimEnd())
    .join('\n');
}

/** One line per event: seq, kind, author, and just enough of the payload to recognise it. */
export function eventLine(event: CrosstalkEvent): string[] {
  return [String(event.seq), event.kind, event.from, event.room ?? '', summarise(event)];
}

function summarise(event: CrosstalkEvent): string {
  switch (event.kind) {
    case 'message':
      return truncate(event.body);
    case 'claim_raised':
      return `${event.claim.id} ${truncate(event.claim.assertion)}`;
    case 'claim_response':
      return `${event.claimId} ${event.verdict}`;
    case 'evidence_added':
      return `${event.claimId} ${event.evidence.sha}`;
    case 'evidence_stale':
      return `${event.claimId} ${event.sha}`;
    case 'task_created':
      return `${event.task.id} ${truncate(event.task.title)}`;
    case 'task_state':
      return `${event.taskId} -> ${event.state}`;
    case 'brief_ack':
      return `${event.taskId} ${truncate(event.ack.restatement)}`;
    case 'self_review':
      return `${event.taskId} ${event.critique.findings.length} finding(s)`;
    case 'rebase_notice':
      return `${event.taskId} ${event.newBase}`;
    case 'decision_opened':
      return `${event.decision.id} ${truncate(event.decision.question)}`;
    case 'vote_cast':
      return `${event.decisionId} ${event.option}`;
    case 'decision_resolved':
      return `${event.decisionId} ${event.outcome}`;
    case 'participant_joined':
      return `${event.participant.id} (${event.participant.role})`;
    case 'participant_left':
      return event.participantId;
    case 'brief_updated':
      return `${event.participant} ${event.version}`;
  }
}

function truncate(text: string, limit = 68): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length <= limit ? single : `${single.slice(0, limit - 1)}…`;
}
