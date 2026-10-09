import { describe, expect, it } from 'vitest';
import { createEntry } from './domain';
import { needsIpaNotationReview, normalizeEntryIpa, normalizeIpaNotation } from './ipa';

describe('conservative IPA input notation', () => {
  it('removes hidden formatting controls and uses dictionary r, idempotently', () => {
    const hidden = '\u00ad\u034f\u061c\u180e\u200b\u200c\u200d\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2060\u2066\u2067\u2068\u2069\ufeff';
    const result = normalizeIpaNotation(`${hidden}/ˈɹed ɹɪˈlæks/${hidden}`);
    expect(result).toBe('/ˈred rɪˈlæks/');
    expect(normalizeIpaNotation(result)).toBe(result);
  });

  it('leaves pronunciation decisions and visible diacritics unchanged, flagging narrow notation', () => {
    const input = ' /ˌᵻ ɐ ɾ ɜ ɚ ɝː iː uː ɑː ɔː e n̩ ə̃/\n';
    expect(normalizeIpaNotation(input)).toBe(input);
    expect(needsIpaNotationReview(input)).toBe(true);
    expect(needsIpaNotationReview('/rɪˈlæks/')).toBe(false);
  });

  it('changes only input IPA without mutating entry identity, revision or other content', () => {
    const original = createEntry({ term: 'red', ipa_us: '/ɹ\u200bed/', notes: 'keep ɹ\u200b here', revision: 8, favorite: true, suspended: true });
    const normalized = normalizeEntryIpa(original);
    expect(original.ipa_us).toBe('/ɹ\u200bed/');
    expect(normalized).toEqual({ ...original, ipa_us: '/red/' });
    expect(normalizeEntryIpa(normalized)).toBe(normalized);
  });
});
