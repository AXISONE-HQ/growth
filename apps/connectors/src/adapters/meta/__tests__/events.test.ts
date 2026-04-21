import { describe, expect, it } from 'vitest';
import { parseMetaWebhook } from '../events.js';

describe('parseMetaWebhook', () => {
  it('returns empty array for non-page object', () => {
    expect(parseMetaWebhook({ object: 'instagram', entry: [] })).toEqual([]);
  });

  it('extracts text messages', () => {
    const events = parseMetaWebhook({
      object: 'page',
      entry: [
        {
          id: 'PAGE123',
          time: 1700000000,
          messaging: [
            {
              sender: { id: 'PSID_A' },
              recipient: { id: 'PAGE123' },
              timestamp: 1700000000000,
              message: { mid: 'm_abc', text: 'hello' },
            },
          ],
        },
      ],
    });
    expect(events).toHaveLength(1);
    expect(events[0].fromIdentifier).toBe('PSID_A');
    expect(events[0].rawMessage).toBe('hello');
    expect(events[0].threadKey).toBe('meta:PAGE123:PSID_A');
    expect(events[0].providerMessageId).toBe('m_abc');
    expect(events[0].channel).toBe('MESSENGER');
  });

  it('skips echo messages', () => {
    const events = parseMetaWebhook({
      object: 'page',
      entry: [
        {
          id: 'PAGE123',
          time: 1700000000,
          messaging: [
            {
              sender: { id: 'PSID_A' },
              recipient: { id: 'PAGE123' },
              message: { mid: 'm_echo', text: 'sent by us', is_echo: true },
            },
          ],
        },
      ],
    });
    expect(events).toEqual([]);
  });

  it('skips delivery + read receipts', () => {
    const events = parseMetaWebhook({
      object: 'page',
      entry: [
        {
          id: 'PAGE123',
          time: 1700000000,
          messaging: [
            { sender: { id: 'PSID_A' }, delivery: { mids: ['m_abc'], watermark: 1700000000 } },
            { sender: { id: 'PSID_B' }, read: { watermark: 1700000000 } },
          ],
        },
      ],
    });
    expect(events).toEqual([]);
  });

  it('handles postbacks', () => {
    const events = parseMetaWebhook({
      object: 'page',
      entry: [
        {
          id: 'PAGE123',
          time: 1700000000,
          messaging: [
            {
              sender: { id: 'PSID_A' },
              recipient: { id: 'PAGE123' },
              postback: { mid: 'm_pb', title: 'Get Started', payload: 'GET_STARTED' },
            },
          ],
        },
      ],
    });
    expect(events).toHaveLength(1);
    expect(events[0].rawMessage).toContain('POSTBACK:GET_STARTED');
    expect(events[0].providerMessageId).toBe('m_pb');
  });

  it('extracts attachment descriptors when no text', () => {
    const events = parseMetaWebhook({
      object: 'page',
      entry: [
        {
          id: 'PAGE123',
          time: 1700000000,
          messaging: [
            {
              sender: { id: 'PSID_A' },
              message: {
                mid: 'm_att',
                attachments: [{ type: 'image', payload: { url: 'https://cdn.fb/x.jpg' } }],
              },
            },
          ],
        },
      ],
    });
    expect(events).toHaveLength(1);
    expect(events[0].rawMessage).toContain('[image:https://cdn.fb/x.jpg]');
  });

  it('handles batches across multiple entries', () => {
    const events = parseMetaWebhook({
      object: 'page',
      entry: [
        {
          id: 'PAGE1',
          time: 1,
          messaging: [{ sender: { id: 'P1' }, message: { mid: '1', text: 'a' } }],
        },
        {
          id: 'PAGE2',
          time: 2,
          messaging: [{ sender: { id: 'P2' }, message: { mid: '2', text: 'b' } }],
        },
      ],
    });
    expect(events).toHaveLength(2);
    expect(events[0].threadKey).toBe('meta:PAGE1:P1');
    expect(events[1].threadKey).toBe('meta:PAGE2:P2');
  });
});
