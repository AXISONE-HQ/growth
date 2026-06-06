/**
 * KAN-1107 — action-icon-projection helper tests.
 *
 * Locks the icon + status mappings used by Dashboard Decision Feed +
 * Agent Actions panels + sibling settings/page.tsx consumer.
 */
import { describe, it, expect } from 'vitest';
import { Mail, Phone, Activity } from 'lucide-react';
import {
  channelIcon,
  actionIcon,
  channelLabel,
  statusBadge,
} from '../action-icon-projection';

describe('channelIcon', () => {
  it('returns Mail for email', () => {
    const cfg = channelIcon('email');
    expect(cfg?.icon).toBe(Mail);
  });

  it('returns Phone for sms', () => {
    const cfg = channelIcon('sms');
    expect(cfg?.icon).toBe(Phone);
  });

  it('returns undefined for unknown channel (sibling consumer fallback path)', () => {
    expect(channelIcon('unknown_channel')).toBeUndefined();
  });

  it('case-insensitive — uppercase EMAIL matches', () => {
    expect(channelIcon('EMAIL')?.icon).toBe(Mail);
  });
});

describe('actionIcon precedence', () => {
  it('channel wins when present (email)', () => {
    const cfg = actionIcon({ channel: 'email', agentType: 'communication_agent' });
    expect(cfg.icon).toBe(Mail);
    expect(cfg.label).toBe('Email');
  });

  it('falls back to agentType when channel null (meeting_agent)', () => {
    const cfg = actionIcon({ channel: null, agentType: 'meeting_agent' });
    expect(cfg.label).toBe('Meeting');
  });

  it('falls back to Activity icon when both unknown', () => {
    const cfg = actionIcon({ channel: 'nope', agentType: 'nope' });
    expect(cfg.icon).toBe(Activity);
    expect(cfg.label).toBe('Other');
  });

  it('crm_sync_agent renders CRM Sync label', () => {
    const cfg = actionIcon({ channel: null, agentType: 'crm_sync_agent' });
    expect(cfg.label).toBe('CRM Sync');
  });
});

describe('channelLabel — Decision Feed channel chip', () => {
  it('returns Email for email', () => {
    expect(channelLabel('email')).toBe('Email');
  });

  it('returns — for null (Action-empty PROD state; honest "—" signal)', () => {
    expect(channelLabel(null)).toBe('—');
    expect(channelLabel(undefined)).toBe('—');
  });

  it('echoes unknown channel through for transparency', () => {
    expect(channelLabel('custom')).toBe('custom');
  });
});

describe('statusBadge', () => {
  it('renders ✓ Delivered for delivered status', () => {
    const badge = statusBadge('delivered');
    expect(badge.label).toBe('✓ Delivered');
    expect(badge.className).toMatch(/emerald/);
  });

  it('renders ⏳ Pending for pending status', () => {
    const badge = statusBadge('pending');
    expect(badge.label).toBe('⏳ Pending');
    expect(badge.className).toMatch(/amber/);
  });

  it('renders ✗ Failed for failed status', () => {
    const badge = statusBadge('failed');
    expect(badge.label).toBe('✗ Failed');
    expect(badge.className).toMatch(/red/);
  });

  it('defensive fallback for unknown status (muted treatment)', () => {
    const badge = statusBadge('mystery_status');
    expect(badge.label).toBe('mystery_status');
    expect(badge.className).toMatch(/muted/);
  });

  it('covers full CommunicationAgent vocab (pending/sent/delivered/failed/bounced/blocked/rejected)', () => {
    const vocab = ['pending', 'sent', 'delivered', 'failed', 'bounced', 'blocked', 'rejected'];
    for (const status of vocab) {
      const badge = statusBadge(status);
      // Known vocab — label should NOT be the raw status (it gets ✓/✗/⏳ prefix)
      expect(badge.label).not.toBe(status);
    }
  });
});
