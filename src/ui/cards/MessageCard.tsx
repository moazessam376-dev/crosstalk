import { createElement } from 'react';

export interface MessageCardProps {
  from: string;
  body: string;
  ts?: string;
  seq?: number;
  testId?: string;
}

export function MessageCard({ from, body, ts, seq, testId = 'message-card' }: MessageCardProps) {
  return createElement(
    'article',
    { className: 'message-card', 'data-card-kind': 'message', 'data-testid': testId },
    createElement(
      'header',
      { className: 'message-card-header' },
      createElement('strong', { className: 'message-author' }, from),
      seq !== undefined ? createElement('span', { className: 'message-seq fact' }, `#${seq}`) : null,
      ts ? createElement('time', { className: 'message-time fact', dateTime: ts }, ts.slice(11, 16)) : null,
    ),
    createElement('p', { className: 'message-body' }, body),
  );
}
