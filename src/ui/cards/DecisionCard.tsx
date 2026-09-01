import { createElement, useState } from 'react';
import type { Decision } from '../../contracts/decision.js';
import type { PostResult } from '../state/humanAction.js';

export interface DecisionCardProps {
  decision: Decision;
  /** The option that carried, once one has. */
  outcome?: string;
  /** Absent when the viewer cannot answer — a read-only hub, or not a voter. */
  onVote?: (decisionId: string, option: string, rationale: string) => Promise<PostResult>;
  testId?: string;
}

/**
 * A question the operator can answer with one click.
 *
 * Everything under this was already built and nobody could find it. `Decision`
 * has carried a question, a list of options, who may answer, their choices and
 * their reasons since v1; a decision with no `claimId` lands on `#floor`;
 * `awaitsHuman` already lights the NEEDS YOU banner for `method: 'human'`; and
 * the vote handler accepts any string, so an answer outside the options has
 * always been legal. What was missing was this card: `ProtocolCard` drew the
 * question and *not the options*, and the only vote control in the hub lived
 * inside `DisputeView`, which a claimless decision never reaches. So the one
 * surface for planning with the operator rendered as a dead line of text.
 *
 * The rationale is optional here and required by the daemon, which is the right
 * split: in court a bare vote settling a dispute is the thing to prevent, and
 * on a planning question the operator is the authority and their reasoning is a
 * bonus. When they give none, the record says how the answer arrived rather
 * than inventing a reason they did not offer.
 */
export function DecisionCard({ decision, outcome, onVote, testId = `card-decision-${decision.id}` }: DecisionCardProps) {
  const [why, setWhy] = useState('');
  const [pending, setPending] = useState<string | undefined>(undefined);
  const [failed, setFailed] = useState<string | undefined>(undefined);

  const answer = async (option: string): Promise<void> => {
    if (onVote === undefined || pending !== undefined) return;
    setPending(option);
    setFailed(undefined);
    const result = await onVote(decision.id, option, why.trim() === '' ? 'answered from the hub' : why.trim());
    setPending(undefined);
    if (!result.ok) setFailed(result.reason ?? 'the daemon refused it');
  };

  const answered = outcome !== undefined;

  return createElement(
    'article',
    { className: 'decision-card', 'data-card-kind': 'decision', 'data-testid': testId, 'data-answered': answered ? 'true' : 'false' },
    createElement('span', { className: 'fact-label' }, answered ? 'decision answered' : 'needs your answer'),
    createElement('p', { className: 'decision-question', 'data-testid': 'decision-question' }, decision.question),
    answered
      ? createElement('p', { className: 'decision-outcome', 'data-testid': 'decision-outcome' }, outcome)
      : createElement(
          'div',
          { className: 'decision-answers' },
          createElement(
            'div',
            { className: 'decision-options' },
            ...decision.options.map((option) =>
              createElement(
                'button',
                {
                  key: option,
                  type: 'button',
                  className: 'decision-option',
                  'data-testid': `decision-option-${option}`,
                  disabled: onVote === undefined || pending !== undefined,
                  onClick: () => void answer(option),
                },
                option,
              ),
            ),
          ),
          // Their own answer, not one of ours. `option` is a free string on the
          // wire and always has been, so "Other" needs no protocol change — only
          // somewhere to type it.
          createElement('input', {
            className: 'decision-why',
            'data-testid': 'decision-why',
            placeholder: 'why, or an answer of your own',
            value: why,
            onChange: (event: { target: { value: string } }) => setWhy(event.target.value),
          }),
          why.trim() === ''
            ? null
            : createElement(
                'button',
                {
                  type: 'button',
                  className: 'decision-option is-own',
                  'data-testid': 'decision-answer-own',
                  disabled: onVote === undefined || pending !== undefined,
                  onClick: () => void answer(why.trim()),
                },
                'Answer with this',
              ),
        ),
    failed === undefined ? null : createElement('p', { className: 'decision-error', 'data-testid': 'decision-error' }, failed),
  );
}
