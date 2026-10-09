import { describe, expect, it } from 'vitest';
import type { StudyCard, Snapshot } from '../types';
import { createEntry, defaultSettings, eligibleCards, emptySnapshot, initialState, isReady, learningDay, previewIntervals, schedule } from './domain';

const now = new Date('2026-10-09T14:00:00.000Z');
const entry = createEntry({ term: 'apple', ipa_us: '/ˈæpəl/', definition_en: 'A round fruit.', meaning_zh: '苹果', example: 'An {{apple}}.' });
const makeCard = (kind: StudyCard['kind'] = 'recognition'): StudyCard => ({ id: crypto.randomUUID(), entry_id: entry.id, kind, state: initialState(now), revision: 0, bury_until: null });
const settings = { ...defaultSettings(), timezone: 'America/New_York' };

describe('learning eligibility', () => {
  it('requires IPA and English definition but not Chinese', () => {
    expect(isReady({ ...entry, meaning_zh: '' })).toBe(true);
    expect(isReady({ ...entry, ipa_us: '' })).toBe(false);
    expect(isReady({ ...entry, definition_en: '待确认' })).toBe(false);
    expect(isReady({ ...entry, ipa_us: 'TODO' })).toBe(false);
    expect(isReady({ ...entry, notes: '读音待确认' })).toBe(false);
  });
  it('excludes new recognition and disables optional directions by default', () => {
    const snapshot = { ...emptySnapshot(), settings, entries: [entry], cards: [makeCard(), makeCard('production'), makeCard('cloze')] };
    expect(eligibleCards(snapshot, now)).toEqual([]);
  });
  it('keeps own short-term relearning eligible, buries siblings for one local day', () => {
    const before = makeCard();
    const recognition = { ...before, state: schedule(before, 1, settings, now) };
    const production = makeCard('production');
    const snapshot: Snapshot = { ...emptySnapshot(), settings: { ...settings, production_enabled: true }, entries: [entry], cards: [recognition, production], reviews: [{ id: crypto.randomUUID(), card_id: before.id, entry_id: entry.id, rating: 1, reviewed_at: now.toISOString(), before, after: recognition, undone: false }] };
    expect(eligibleCards(snapshot, new Date(now.getTime() + 60_000)).map(card => card.id)).toEqual([recognition.id]);
    expect(eligibleCards(snapshot, new Date('2026-10-10T04:00:00Z')).map(card => card.id)).toContain(production.id);
    snapshot.entries[0] = { ...entry, suspended: true };
    expect(eligibleCards(snapshot, new Date('2026-10-10T04:00:00Z'))).toEqual([]);
  });
  it('excludes orphaned cards after deletion and optional cards lacking their content', () => {
    const card = makeCard(); card.state = schedule(card, 3, settings, now);
    expect(eligibleCards({ ...emptySnapshot(), cards: [card] }, new Date('2026-10-12T00:00:00Z'))).toEqual([]);
  });
});

describe('FSRS scheduling', () => {
  it('uses 1 minute and 10 minute learning steps, serializes dates without mutating input', () => {
    const card = makeCard();
    const copy = structuredClone(card);
    expect(schedule(card, 1, settings, now).due).toBe('2026-10-09T14:01:00.000Z');
    const good = schedule(card, 3, settings, now);
    expect(good.due).toBe('2026-10-09T14:10:00.000Z');
    expect(good.state).toBe(1);
    const graduated = schedule({ ...card, state: good }, 3, settings, new Date(good.due));
    expect(graduated.state).toBe(2);
    expect(graduated.scheduled_days).toBeGreaterThanOrEqual(1);
    expect(card).toEqual(copy);
  });
  it('generates all four ratings for new, learning, review, and relearning states', () => {
    const card = makeCard();
    const learning = { ...card, state: schedule(card, 1, settings, now) };
    const review = { ...card, state: schedule(card, 4, settings, now) };
    const nextTime = new Date('2026-11-01T14:00:00Z');
    const relearning = { ...card, state: schedule(review, 1, settings, nextTime) };
    expect(relearning.state.state).toBe(3);
    expect(new Date(relearning.state.due).getTime() - nextTime.getTime()).toBe(10 * 60_000);
    for (const testCard of [card, learning, review, relearning]) {
      const preview = previewIntervals(testCard, settings, new Date('2026-11-02T14:00:00Z'));
      expect(preview.map(result => result.rating)).toEqual([1, 2, 3, 4]);
      preview.forEach(result => {
        expect(result.state.reps).toBe(testCard.state.reps + 1);
        expect(Number.isFinite(result.state.stability)).toBe(true);
        expect(result.state.last_review).toBe('2026-11-02T14:00:00.000Z');
        expect(result.label).toMatch(/分钟|小时|天/);
        expect(new Date(result.state.due).getTime()).toBeGreaterThan(new Date('2026-11-02T14:00:00Z').getTime());
      });
    }
  });
  it('rejects a stale timestamp earlier than the last review', () => {
    const card = makeCard();
    card.state = schedule(card, 3, settings, now);
    expect(() => schedule(card, 3, settings, new Date('2026-10-08T00:00:00Z'))).toThrow('不能早于');
  });
});

describe('local learning day', () => {
  it('uses account timezone and handles DST midnight boundaries', () => {
    expect(learningDay('2026-10-09T02:00:00Z', 'America/New_York')).toBe('2026-10-08');
    expect(learningDay('2026-10-09T02:00:00Z', 'Asia/Shanghai')).toBe('2026-10-09');
    expect(learningDay('2026-11-01T04:30:00Z', 'America/New_York')).toBe('2026-11-01');
    expect(learningDay('2026-11-02T04:30:00Z', 'America/New_York')).toBe('2026-11-01');
  });
});
