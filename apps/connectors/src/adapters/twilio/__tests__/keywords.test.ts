/**
 * Unit tests for SMS keyword detection.
 * Covers TCPA-mandated STOP/HELP/START plus common carrier variants.
 */

import { describe, expect, it } from 'vitest';
import { detectKeyword } from '../keywords.js';

describe('detectKeyword', () => {
  describe('STOP variants', () => {
    it.each(['STOP', 'stop', 'Stop', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', '  STOP  '])(
      'detects %s as STOP',
      (input) => {
        expect(detectKeyword(input)).toBe('STOP');
      },
    );
  });

  describe('HELP variants', () => {
    it.each(['HELP', 'help', 'INFO', 'info'])('detects %s as HELP', (input) => {
      expect(detectKeyword(input)).toBe('HELP');
    });
  });

  describe('START variants', () => {
    it.each(['START', 'YES', 'UNSTOP'])('detects %s as START', (input) => {
      expect(detectKeyword(input)).toBe('START');
    });
  });

  describe('false positives', () => {
    it('ignores STOP mid-sentence ("please stop calling")', () => {
      expect(detectKeyword('please stop calling')).toBeNull();
    });

    it('ignores "I need help understanding"', () => {
      expect(detectKeyword('I need help understanding')).toBeNull();
    });

    it('ignores normal messages', () => {
      expect(detectKeyword("What's the deal with your service?")).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(detectKeyword('')).toBeNull();
    });
  });
});
