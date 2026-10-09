import type { Entry } from '../types';

// Formatting controls are not pronunciation marks. Keep ordinary whitespace,
// combining diacritics, vowel symbols and stress placement exactly as entered.
const hiddenFormatting = /[\u00ad\u034f\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;

export function normalizeIpaNotation(value: string): string {
  return value.replace(hiddenFormatting, '').replace(/ɹ/g, 'r');
}

// Use only at manual/Markdown input boundaries, never in backup restoration.
export function normalizeEntryIpa(entry: Entry): Entry {
  const ipa_us = normalizeIpaNotation(entry.ipa_us);
  return ipa_us === entry.ipa_us ? entry : { ...entry, ipa_us };
}

export function needsIpaNotationReview(value: string): boolean {
  return /[ᵻɐɾ]/u.test(value);
}
