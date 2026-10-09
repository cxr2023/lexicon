import { createEmptyCard, fsrs, type Card, type State } from 'ts-fsrs';
import type { Entry, FSRSState, RatingValue, Settings, Snapshot, StudyCard } from '../types';

export function defaultSettings(): Settings {
  return {
    batch_size: 10,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    hide_chinese: false,
    production_enabled: false,
    cloze_enabled: false,
    retention: 0.9,
  };
}

export function emptySnapshot(): Snapshot {
  return { entries: [], cards: [], reviews: [], batches: [], settings: defaultSettings() };
}

export function createEntry(patch: Partial<Entry> = {}): Entry {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(), term: '', ipa_us: '', definition_en: '', meaning_zh: '',
    type: 'word', pos: '', example: '', example_translation: '', usage: '', tags: [],
    source: '', notes: '', favorite: false, suspended: false,
    created_at: now, updated_at: now, revision: 0, ...patch,
  };
}

const unconfirmed = /待确认|待补全|待核实|需确认|\b(?:TBD|TODO)\b|\[uncertain\]/i;
const placeholder = /^(?:[-—–?？…]+|unknown|n\/a|null|undefined)$/i;
export function isReady(entry: Entry): boolean {
  return [entry.term, entry.ipa_us, entry.definition_en].every(value =>
    Boolean(value.trim()) && !unconfirmed.test(value) && !placeholder.test(value.trim()),
  ) && !unconfirmed.test(entry.notes);
}

export function serializeState(card: Card): FSRSState {
  const { due, last_review, ...rest } = card;
  return { ...rest, due: due.toISOString(), ...(last_review ? { last_review: last_review.toISOString() } : {}) };
}

export function initialState(now = new Date()): FSRSState {
  return serializeState(createEmptyCard(now));
}

export function schedule(card: StudyCard, rating: RatingValue, settings: Settings, now = new Date()): FSRSState {
  if (![1, 2, 3, 4].includes(rating)) throw new Error('无效的评分。');
  if (!Number.isFinite(now.getTime())) throw new Error('无效的复习时间。');
  if (card.state.last_review && now < new Date(card.state.last_review)) throw new Error('复习时间不能早于上次复习。');
  const scheduler = fsrs({
    request_retention: settings.retention,
    enable_fuzz: false,
    enable_short_term: true,
    learning_steps: ['1m', '10m'],
    relearning_steps: ['10m'],
  });
  const state: Card = {
    ...card.state, state: card.state.state as State,
    due: new Date(card.state.due),
    last_review: card.state.last_review ? new Date(card.state.last_review) : undefined,
  };
  return serializeState(scheduler.next(state, now, rating).card);
}

export function previewIntervals(card: StudyCard, settings: Settings, now = new Date()): { rating: RatingValue; label: string; state: FSRSState }[] {
  return ([1, 2, 3, 4] as const).map(rating => {
    const state = schedule(card, rating, settings, now);
    const minutes = Math.max(1, Math.round((new Date(state.due).getTime() - now.getTime()) / 60_000));
    const label = minutes < 60 ? `${minutes} 分钟` : minutes < 1440 ? `${Math.round(minutes / 60)} 小时` : `${Math.round(minutes / 1440)} 天`;
    return { rating, label, state };
  });
}

const dayFormatters = new Map<string, Intl.DateTimeFormat>();
export function learningDay(date: Date | string, timezone: string): string {
  let formatter = dayFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    if (dayFormatters.size >= 64) dayFormatters.clear();
    dayFormatters.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(typeof date === 'string' ? new Date(date) : date);
  const get = (type: string) => parts.find(part => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function hasCloze(entry: Entry): boolean { return /\{\{[^{}]+\}\}/.test(entry.example); }
export function isCardEnabled(card: StudyCard, entry: Entry, settings: Settings): boolean {
  return card.kind === 'recognition' ||
    (card.kind === 'production' && settings.production_enabled && Boolean(entry.meaning_zh.trim())) ||
    (card.kind === 'cloze' && settings.cloze_enabled && hasCloze(entry));
}

export function eligibleCards(snapshot: Snapshot, now = new Date()): StudyCard[] {
  const { settings } = snapshot;
  const today = learningDay(now, settings.timezone);
  const entries = new Map(snapshot.entries.map(entry => [entry.id, entry]));
  const studied = new Set(snapshot.cards.filter(card => card.kind === 'recognition' && card.state.reps > 0).map(card => card.entry_id));
  const reviewedToday = new Map<string, Set<string>>();
  for (const event of snapshot.reviews) {
    if (!event.undone && learningDay(event.reviewed_at, settings.timezone) === today) {
      if (!reviewedToday.has(event.entry_id)) reviewedToday.set(event.entry_id, new Set());
      reviewedToday.get(event.entry_id)!.add(event.card_id);
    }
  }
  return snapshot.cards.filter(card => {
    const entry = entries.get(card.entry_id);
    if (!entry || !isReady(entry) || entry.suspended || !isCardEnabled(card, entry, settings)) return false;
    if (card.bury_until && (/^\d{4}-\d{2}-\d{2}$/.test(card.bury_until) ? card.bury_until > today : new Date(card.bury_until) > now)) return false;
    if ([...(reviewedToday.get(entry.id) || [])].some(id => id !== card.id)) return false;
    if (new Date(card.state.due) > now) return false;
    return card.state.state > 0 || (card.kind !== 'recognition' && studied.has(entry.id));
  }).sort((a, b) => {
    const priority = (card: StudyCard) => card.state.state === 1 || card.state.state === 3 ? 0 : card.state.state === 2 ? 1 : 2;
    return priority(a) - priority(b) || new Date(a.state.due).getTime() - new Date(b.state.due).getTime() || a.id.localeCompare(b.id);
  });
}
