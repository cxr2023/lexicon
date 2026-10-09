import { createClient } from '@supabase/supabase-js';
import type { Backup, Entry, Repository, ReviewInput, Settings, Snapshot, StudyBatch, StudyCard } from '../types';
import { defaultSettings, emptySnapshot, initialState, isReady, learningDay } from './domain';
import { validateBackup } from './backup';

const url = import.meta.env.VITE_SUPABASE_URL;
const publicKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY;
export const supabase = url && publicKey ? createClient(url, publicKey) : null;
export const DEMO_STORAGE_KEY = 'lexicon-garden-demo-v1';
const clone = <T,>(value: T): T => structuredClone(value);
function fail(message: string): never { throw new Error(message); }
const enabled = (entry: Entry, card: StudyCard, settings: Settings) => isReady(entry) && !entry.suspended &&
  (card.kind === 'recognition' || (card.kind === 'production' && settings.production_enabled && !!entry.meaning_zh.trim()) ||
  (card.kind === 'cloze' && settings.cloze_enabled && /\{\{[^{}]+\}\}/.test(entry.example)));

function maintainCards(snapshot: Snapshot) {
  for (const batch of snapshot.batches.filter(item => !item.completed_at)) {
    batch.entry_ids = batch.entry_ids.filter(id => batch.completed_ids.includes(id) || snapshot.entries.some(entry => entry.id === id && isReady(entry) && !entry.suspended));
    if (batch.entry_ids.every(id => batch.completed_ids.includes(id))) batch.completed_at = new Date().toISOString();
  }
  for (const entry of snapshot.entries.filter(isReady)) {
    const kinds: StudyCard['kind'][] = ['recognition'];
    if (snapshot.settings.production_enabled && entry.meaning_zh.trim()) kinds.push('production');
    if (snapshot.settings.cloze_enabled && /\{\{[^{}]+\}\}/.test(entry.example)) kinds.push('cloze');
    for (const kind of kinds) {
      if (!snapshot.cards.some(card => card.entry_id === entry.id && card.kind === kind)) {
        const until = snapshot.reviews.filter(event => event.entry_id === entry.id && !event.undone)
          .map(event => nextLearningDay(event.reviewed_at, snapshot.settings.timezone)).sort().at(-1);
        snapshot.cards.push({ id: crypto.randomUUID(), entry_id: entry.id, kind, state: initialState(), revision: 1,
          bury_until: until && Date.parse(until) > Date.now() ? until : null });
      }
    }
  }
}

// Find the next midnight in the account timezone, including DST transitions.
function nextLearningDay(at: string, timezone: string): string {
  const day = learningDay(at, timezone);
  let lo = new Date(at).getTime(), hi = lo + 27 * 60 * 60 * 1000;
  while (hi - lo > 1) {
    const mid = Math.floor((hi + lo) / 2);
    if (learningDay(new Date(mid), timezone) === day) lo = mid;
    else hi = mid;
  }
  return new Date(hi).toISOString();
}

function updateBatches(snapshot: Snapshot, entryId: string, complete: boolean) {
  for (const batch of snapshot.batches) {
    if (!batch.entry_ids.includes(entryId)) continue;
    batch.completed_ids = batch.completed_ids.filter(id => id !== entryId);
    if (complete) batch.completed_ids.push(entryId);
    batch.completed_at = batch.entry_ids.every(id => batch.completed_ids.includes(id)) ? (batch.completed_at || new Date().toISOString()) : null;
  }
}

function validateSettings(settings: Settings) {
  if (!Number.isInteger(settings.batch_size) || settings.batch_size < 1 || settings.batch_size > 100 ||
    typeof settings.retention !== 'number' || settings.retention < 0.7 || settings.retention > 0.99 ||
    ['hide_chinese', 'production_enabled', 'cloze_enabled'].some(key => typeof settings[key as keyof Settings] !== 'boolean')) {
    fail('设置无效：每批数量须为 1–100，目标保持率须为 70%–99%。');
  }
  try { new Intl.DateTimeFormat('en-US', { timeZone: settings.timezone }).format(); }
  catch { fail('学习时区无效。'); }
}

function sameSubmission(event: Snapshot['reviews'][number], input: ReviewInput) {
  return event.card_id === input.card_id && event.before.revision === input.expected_revision && event.rating === input.rating &&
    event.reviewed_at === input.reviewed_at && Object.keys(event.after.state).length === Object.keys(input.next_state).length &&
    Object.entries(event.after.state).every(([key, value]) => input.next_state[key as keyof typeof input.next_state] === value);
}

function submit(snapshot: Snapshot, input: ReviewInput) {
  const previous = snapshot.reviews.find(event => event.id === input.operation_id);
  if (previous) {
    if (previous.undone || !sameSubmission(previous, input)) fail('此提交编号已使用，请刷新后重新评分。');
    return;
  }
  const card = snapshot.cards.find(item => item.id === input.card_id);
  if (!card) fail('词条已被删除，请刷新学习队列。');
  if (card.revision !== input.expected_revision) fail('学习进度已在其他页面更新，请刷新后重试。');
  const entry = snapshot.entries.find(item => item.id === card.entry_id)!;
  if (!enabled(entry, card, snapshot.settings)) fail('该词条已暂停、尚未补全或此题型已关闭。');
  if (![1, 2, 3, 4].includes(input.rating) || !Number.isFinite(Date.parse(input.reviewed_at)) ||
    input.next_state.reps !== card.state.reps + 1 || input.next_state.last_review !== input.reviewed_at ||
    Date.parse(input.next_state.due) < Date.parse(input.reviewed_at)) fail('评分数据无效，请刷新后重试。');
  const before = clone(card);
  card.state = clone(input.next_state);
  card.revision += 1;
  card.bury_until = null;
  snapshot.reviews.push({ id: input.operation_id, card_id: card.id, entry_id: card.entry_id, rating: input.rating,
    reviewed_at: input.reviewed_at, before, after: clone(card), undone: false });
  if (card.kind === 'recognition') updateBatches(snapshot, card.entry_id, true);
  const until = nextLearningDay(input.reviewed_at, snapshot.settings.timezone);
  for (const sibling of snapshot.cards.filter(other => other.entry_id === card.entry_id && other.id !== card.id)) {
    if (!sibling.bury_until || sibling.bury_until < until) { sibling.bury_until = until; sibling.revision += 1; }
  }
}

function undo(snapshot: Snapshot, id: string) {
  const event = snapshot.reviews.find(item => item.id === id);
  if (!event) fail('这条评分已不存在。');
  if (event.undone) return;
  const latest = [...snapshot.reviews].reverse().find(item => !item.undone);
  const card = snapshot.cards.find(item => item.id === event.card_id);
  if (latest?.id !== id || !card || card.revision !== event.after.revision) fail('已有更新的学习操作，无法撤销这条评分。');
  Object.assign(card, clone(event.before), { revision: card.revision + 1 });
  event.undone = true;
  if (card.kind === 'recognition' && event.before.state.reps === 0) {
    // Starting the next untouched batch must not make the previous rating impossible to undo.
    snapshot.batches = snapshot.batches.filter(batch => batch.completed_at || batch.completed_ids.length > 0 || batch.entry_ids.includes(card.entry_id));
    updateBatches(snapshot, card.entry_id, false);
  }
  for (const sibling of snapshot.cards.filter(other => other.entry_id === card.entry_id && other.id !== card.id)) {
    const relevant = snapshot.reviews.filter(other => !other.undone && other.entry_id === card.entry_id && other.card_id !== sibling.id);
    const until = relevant.reduce<string | null>((best, other) => {
      const value = nextLearningDay(other.reviewed_at, snapshot.settings.timezone);
      return !best || value > best ? value : best;
    }, null);
    if (sibling.bury_until !== until) { sibling.bury_until = until; sibling.revision += 1; }
  }
}

let demoQueue: Promise<unknown> = Promise.resolve();
export function createDemoRepository(seed?: Snapshot): Repository {
  const read = (): Snapshot => {
    const raw = localStorage.getItem(DEMO_STORAGE_KEY);
    if (raw) {
      try { return validateBackup({ version: 1, exported_at: new Date().toISOString(), data: JSON.parse(raw) }).data; }
      catch { return fail('本地演示数据无法读取。请先导出浏览器存储数据后再重置演示。'); }
    }
    const initial = clone(seed || emptySnapshot());
    maintainCards(initial);
    localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(initial));
    return initial;
  };
  const transact = <T,>(action: (snapshot: Snapshot) => T): Promise<T> => {
    const execute = async () => {
      const work = () => {
        const snapshot = read();
        const result = action(snapshot);
        // Validate the entire graph before committing a mutation; failed imports are atomic.
        validateBackup({ version: 1, exported_at: new Date().toISOString(), data: snapshot });
        localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(snapshot));
        return clone(result);
      };
      if (typeof window !== 'undefined' && typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request(DEMO_STORAGE_KEY, work);
      return work();
    };
    const queued = demoQueue.then(execute, execute);
    demoQueue = queued.catch(() => undefined);
    return queued;
  };
  return {
    mode: 'demo',
    load: () => transact(snapshot => clone(snapshot)),
    saveEntries: entries => transact(snapshot => {
      if (new Set(entries.map(entry => entry.id)).size !== entries.length) fail('一次保存不能包含重复的词条 ID。');
      for (const incoming of entries) {
        const existing = snapshot.entries.find(entry => entry.id === incoming.id);
        if ((!existing && incoming.revision !== 0) || (existing && existing.revision !== incoming.revision)) {
          fail('词条已修改或删除，请刷新后重试。');
        }
        const saved = { ...clone(incoming), created_at: existing?.created_at || incoming.created_at,
          updated_at: new Date().toISOString(), revision: incoming.revision + 1 };
        if (existing) Object.assign(existing, saved); else snapshot.entries.push(saved);
      }
      maintainCards(snapshot);
    }),
    startBatch: () => transact(snapshot => {
      const pending = snapshot.batches.find(batch => !batch.completed_at && batch.entry_ids.some(id => !batch.completed_ids.includes(id)));
      if (pending) return pending;
      const ids = snapshot.entries.filter(entry => isReady(entry) && !entry.suspended && snapshot.cards.some(card =>
        card.entry_id === entry.id && card.kind === 'recognition' && card.state.reps === 0))
        .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)).slice(0, snapshot.settings.batch_size).map(entry => entry.id);
      if (!ids.length) return null;
      const batch: StudyBatch = { id: crypto.randomUUID(), entry_ids: ids, completed_ids: [], created_at: new Date().toISOString(), completed_at: null };
      snapshot.batches.push(batch);
      return batch;
    }),
    submitReview: input => transact(snapshot => submit(snapshot, input)),
    undoReview: id => transact(snapshot => undo(snapshot, id)),
    deleteEntry: (id, revision) => transact(snapshot => {
      const entry = snapshot.entries.find(item => item.id === id);
      if (!entry) return;
      if (entry.revision !== revision) fail('词条已更新，请刷新后再删除。');
      snapshot.entries = snapshot.entries.filter(item => item.id !== id);
      snapshot.cards = snapshot.cards.filter(item => item.entry_id !== id);
      snapshot.reviews = snapshot.reviews.filter(item => item.entry_id !== id);
      for (const batch of snapshot.batches) {
        batch.entry_ids = batch.entry_ids.filter(value => value !== id);
        batch.completed_ids = batch.completed_ids.filter(value => value !== id);
        if (batch.entry_ids.every(value => batch.completed_ids.includes(value))) batch.completed_at ||= new Date().toISOString();
      }
    }),
    saveSettings: settings => transact(snapshot => { validateSettings(settings); snapshot.settings = clone(settings); maintainCards(snapshot); }),
    restoreBackup: backup => transact(snapshot => {
      const restored = clone(validateBackup(backup).data);
      validateSettings(restored.settings);
      // Move all revisions beyond both snapshots so an in-flight pre-restore mutation cannot win.
      const revision = [snapshot.entries, snapshot.cards, restored.entries, restored.cards]
        .reduce((maximum, records) => records.reduce((inner, record) => Math.max(inner, record.revision), maximum), 0) + 1;
      for (const entry of restored.entries) entry.revision = revision;
      for (const card of restored.cards) card.revision = revision;
      Object.assign(snapshot, restored);
      maintainCards(snapshot);
    }),
  };
}

export function createCloudRepository(): Repository {
  const client = supabase;
  if (!client) throw new Error('尚未配置 Supabase。请配置环境变量，或明确选择本地演示。');
  const call = async <T,>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const { data, error } = await client.rpc(name, args);
    if (error) throw new Error(error.message);
    return data as T;
  };
  return {
    mode: 'cloud',
    load: async () => {
      const data = await call<Snapshot>('load_snapshot', { p_timezone: defaultSettings().timezone });
      return validateBackup({ version: 1, exported_at: new Date().toISOString(), data }).data;
    },
    saveEntries: entries => call('save_entries', { p_entries: entries }),
    startBatch: () => call<StudyBatch | null>('start_next_batch'),
    submitReview: input => call('submit_review', { p_input: input }),
    undoReview: reviewId => call('undo_review', { p_review_id: reviewId }),
    deleteEntry: (id, revision) => call('delete_entry', { p_entry_id: id, p_expected_revision: revision }),
    saveSettings: settings => { validateSettings(settings); return call('save_settings', { p_settings: settings }); },
    restoreBackup: backup => call('restore_backup', { p_backup: validateBackup(backup) }),
  };
}
