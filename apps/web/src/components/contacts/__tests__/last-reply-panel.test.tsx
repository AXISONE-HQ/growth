/**
 * KAN-1037-PR5 — Last reply panel component tests.
 *
 * Coverage:
 *   - Renders the reply body, sender, subject, signal-class chip
 *   - Renders correlation link with first-8-char of correlatedDecisionId
 *   - Status branch rendering for all 4 enum values (escalated /
 *     no_action / filtered_autoresponder / evaluating)
 *   - "Show more" expand toggle when body > 200 chars
 *   - Escalated status includes the engineReasoning blockquote +
 *     Recommendations queue link
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LastReplyPanel } from '../last-reply-panel';
import type { LatestReply } from '@/lib/api';

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

vi.mock('@/lib/fmt-date', () => ({
  fmtDateTime: (s: string) => `formatted(${s})`,
}));

import { vi } from 'vitest';

function makeReply(overrides: Partial<LatestReply> = {}): LatestReply {
  return {
    id: 'eng_1',
    bodyPreview: 'Yes, looking to start in Q3. Tuesday afternoon works for a call.',
    fromAddress: 'alice@customer.example',
    subject: 'Re: pricing inquiry',
    occurredAt: '2026-05-31T13:41:12.000Z',
    signalClass: 'positive',
    correlatedDecisionId: 'cl_decision_abc123def',
    engineResponseStatus: 'escalated',
    engineResponseAt: '2026-05-31T13:41:34.000Z',
    engineResponseEscalationId: '184f002c-d24b-43d1-8faf-7a2d48404b0a',
    engineReasoning:
      'Contact requested a 30-minute call next Tuesday afternoon; needs human review before scheduling.',
    ...overrides,
  };
}

describe('KAN-1037-PR5 — LastReplyPanel', () => {
  it('renders sender, subject, body, signal-class chip, correlation link', () => {
    render(<LastReplyPanel latestReply={makeReply()} />);
    expect(screen.getByText('Last reply received')).toBeDefined();
    expect(screen.getByText('alice@customer.example')).toBeDefined();
    expect(screen.getByText('Re: pricing inquiry')).toBeDefined();
    expect(
      screen.getByText(
        'Yes, looking to start in Q3. Tuesday afternoon works for a call.',
      ),
    ).toBeDefined();
    expect(screen.getByText('positive')).toBeDefined();
    // Correlation link shows first 8 chars of cuid.
    expect(screen.getByText('cl_decis')).toBeDefined();
  });

  it('escalated status: renders engine reasoning blockquote + Recommendations queue link', () => {
    render(<LastReplyPanel latestReply={makeReply()} />);
    expect(
      screen.getByText('Engine escalated to Recommendations queue'),
    ).toBeDefined();
    expect(
      screen.getByText(
        'Contact requested a 30-minute call next Tuesday afternoon; needs human review before scheduling.',
      ),
    ).toBeDefined();
    const link = screen.getByRole('link', {
      name: /View escalation in Recommendations queue/,
    });
    expect(link.getAttribute('href')).toBe(
      '/escalations?id=184f002c-d24b-43d1-8faf-7a2d48404b0a',
    );
  });

  it('no_action status: muted chip, no reasoning blockquote, no queue link', () => {
    render(
      <LastReplyPanel
        latestReply={makeReply({
          engineResponseStatus: 'no_action',
          engineReasoning: null,
          engineResponseEscalationId: null,
        })}
      />,
    );
    expect(
      screen.getByText('Engine evaluated, no action taken'),
    ).toBeDefined();
    expect(
      screen.queryByRole('link', {
        name: /View escalation in Recommendations queue/,
      }),
    ).toBeNull();
  });

  it('filtered_autoresponder status: shield chip', () => {
    render(
      <LastReplyPanel
        latestReply={makeReply({
          engineResponseStatus: 'filtered_autoresponder',
          engineReasoning: null,
          engineResponseEscalationId: null,
        })}
      />,
    );
    expect(screen.getByText('Filtered as autoresponder')).toBeDefined();
  });

  it('evaluating status (implicit fallback): violet spinner chip', () => {
    render(
      <LastReplyPanel
        latestReply={makeReply({
          engineResponseStatus: 'evaluating',
          engineResponseAt: null,
          engineResponseEscalationId: null,
          engineReasoning: null,
        })}
      />,
    );
    expect(screen.getByText('Engine evaluating…')).toBeDefined();
    // No "at <time>" trailing text since engineResponseAt is null.
    expect(screen.queryByText(/^at /)).toBeNull();
  });

  it('body > 200 chars: clamps + shows "Show more" toggle', () => {
    const longBody =
      'A'.repeat(150) +
      ' This sentence pushes the body past the 200-char clamp boundary into expand-toggle territory.';
    const replyWithLongBody = makeReply({ bodyPreview: longBody });
    render(<LastReplyPanel latestReply={replyWithLongBody} />);
    expect(screen.getByText(/Show more/)).toBeDefined();
    // Body initially clamped (ellipsis after 200 chars).
    expect(
      screen.queryByText(longBody),
    ).toBeNull();
    fireEvent.click(screen.getByText(/Show more/));
    // After expansion the full body is visible AND toggle flips to "Show less".
    expect(screen.getByText(longBody)).toBeDefined();
    expect(screen.getByText(/Show less/)).toBeDefined();
  });

  it('body ≤ 200 chars: no expand toggle', () => {
    render(
      <LastReplyPanel latestReply={makeReply({ bodyPreview: 'Short reply.' })} />,
    );
    expect(screen.queryByText(/Show more/)).toBeNull();
    expect(screen.queryByText(/Show less/)).toBeNull();
  });

  it('null correlatedDecisionId: correlation block hidden', () => {
    render(
      <LastReplyPanel
        latestReply={makeReply({ correlatedDecisionId: null })}
      />,
    );
    expect(screen.queryByText(/Correlated to Decision/)).toBeNull();
  });

  it('empty bodyPreview: "(no body captured)" placeholder', () => {
    render(<LastReplyPanel latestReply={makeReply({ bodyPreview: '' })} />);
    expect(screen.getByText('(no body captured)')).toBeDefined();
  });
});
