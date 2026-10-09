import { beforeEach, describe, expect, it } from 'vitest';
import { createDemoRepository } from './repository';
import { createEntry, defaultSettings, schedule } from './domain';
import { exportBackup } from './backup';
import type { Repository, ReviewInput } from '../types';

const values = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => values.set(key, value),
  removeItem: (key: string) => values.delete(key),
} });
const entry = (index: number) => createEntry({ term: `word ${index}`, ipa_us: '/wɝd/', definition_en: `A vocabulary item ${index}.`,
  created_at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString() });
async function answer(repository: Repository, entryId: string): Promise<ReviewInput> {
  const data = await repository.load();
  const card = data.cards.find(card => card.entry_id === entryId && card.kind === 'recognition')!;
  const now = new Date();
  return { operation_id: crypto.randomUUID(), card_id: card.id, expected_revision: card.revision,
    rating: 3, reviewed_at: now.toISOString(), next_state: schedule(card, 3, data.settings, now) };
}
beforeEach(() => { values.clear(); });

describe('explicit demo transactional persistence', () => {
  it('learns successive 10-item batches without a daily cap and restores pending work', async () => {
    const repository = createDemoRepository();
    await repository.saveEntries(Array.from({ length: 24 }, (_, index) => entry(index)));
    const first = (await repository.startBatch())!;
    expect(first.entry_ids).toHaveLength(10);
    expect((await createDemoRepository().startBatch())?.id).toBe(first.id);
    for (const id of first.entry_ids) await repository.submitReview(await answer(repository, id));
    const second = (await repository.startBatch())!;
    expect(second.entry_ids).toHaveLength(10);
    expect(second.entry_ids.some(id => first.entry_ids.includes(id))).toBe(false);
    for (const id of second.entry_ids) await repository.submitReview(await answer(repository, id));
    const third = (await repository.startBatch())!;
    expect(third.entry_ids).toHaveLength(4);
    for (const id of third.entry_ids) await repository.submitReview(await answer(repository, id));
    expect(await repository.startBatch()).toBe(null);
  });

  it('requires IPA and English, and preserves card progress when content is edited', async () => {
    const repository = createDemoRepository();
    const ready = entry(1), draft = { ...entry(2), ipa_us: '' }, uncertain = { ...entry(3), definition_en: '待确认' };
    await repository.saveEntries([ready, draft, uncertain]);
    let data = await repository.load();
    expect(data.cards).toHaveLength(1);
    await repository.submitReview(await answer(repository, ready.id));
    data = await repository.load();
    const original = data.cards[0];
    await repository.saveEntries([{ ...data.entries[0], ipa_us: '/nʊ/' }]);
    expect((await repository.load()).cards[0]).toEqual(original);
  });

  it('deduplicates retries, rejects competing versions and never resurrects deleted entries', async () => {
    const repository = createDemoRepository();
    await repository.saveEntries([entry(0), entry(1)]);
    const data = await repository.load();
    const batch = (await repository.startBatch())!;
    const input = await answer(repository, batch.entry_ids[0]);
    await repository.submitReview(input);
    await repository.submitReview(input);
    expect((await repository.load()).reviews).toHaveLength(1);
    await expect(repository.submitReview({ ...input, operation_id: crypto.randomUUID() })).rejects.toThrow('进度');
    await repository.deleteEntry(data.entries[0].id, data.entries[0].revision);
    const deleted = await repository.load();
    expect(deleted.entries).toHaveLength(1);
    expect(deleted.cards).toHaveLength(1);
    expect(deleted.reviews).toHaveLength(0);
    expect(deleted.batches[0].entry_ids).toHaveLength(1);
    expect(deleted.batches[0].completed_ids).toHaveLength(0);
    await expect(repository.saveEntries([data.entries[0]])).rejects.toThrow('删除');
    await expect(repository.submitReview(input)).rejects.toThrow('删除');
  });

  it('buries siblings to next account day and undoes rating and completion together', async () => {
    const repository = createDemoRepository();
    await repository.saveSettings({ ...defaultSettings(), production_enabled: true, cloze_enabled: true, timezone: 'America/New_York' });
    await repository.saveEntries([{ ...entry(0), meaning_zh: '词', example: 'A {{word}} here.' }]);
    const batch = (await repository.startBatch())!;
    const input = await answer(repository, batch.entry_ids[0]);
    await repository.submitReview(input);
    let data = await repository.load();
    expect(data.cards.filter(card => card.kind !== 'recognition').every(card => !!card.bury_until)).toBe(true);
    expect(data.batches[0].completed_at).toBeTruthy();
    await repository.undoReview(input.operation_id);
    data = await repository.load();
    expect(data.cards.every(card => card.bury_until === null)).toBe(true);
    expect(data.cards[0].state.reps).toBe(0);
    expect(data.batches[0].completed_ids).toHaveLength(0);
    expect(data.batches[0].completed_at).toBeNull();
    await expect(repository.submitReview(input)).rejects.toThrow('编号');
  });

  it('also buries optional cards enabled after a same-day recognition review', async () => {
    const repository = createDemoRepository();
    await repository.saveEntries([{ ...entry(0), meaning_zh: '词' }]);
    const data = await repository.load();
    await repository.submitReview(await answer(repository, data.entries[0].id));
    await repository.saveSettings({ ...data.settings, production_enabled: true });
    const production = (await repository.load()).cards.find(card => card.kind === 'production')!;
    expect(Date.parse(production.bury_until!)).toBeGreaterThan(Date.now());
  });

  it('reopens previous batch on undo without leaving two active batches', async () => {
    const repository = createDemoRepository();
    await repository.saveSettings({ ...defaultSettings(), batch_size: 1 });
    await repository.saveEntries([entry(0), entry(1)]);
    const batch = (await repository.startBatch())!;
    const input = await answer(repository, batch.entry_ids[0]);
    await repository.submitReview(input);
    await repository.startBatch();
    await repository.undoReview(input.operation_id);
    expect((await repository.load()).batches).toHaveLength(1);
    expect((await repository.startBatch())?.id).toBe(batch.id);
  });

  it('drops ineligible pending items without refilling the current batch', async () => {
    const repository = createDemoRepository();
    await repository.saveSettings({ ...defaultSettings(), batch_size: 1 });
    await repository.saveEntries([entry(0), entry(1)]);
    const batch = (await repository.startBatch())!;
    const data = await repository.load();
    await repository.saveEntries([{ ...data.entries[0], suspended: true }]);
    const next = (await repository.startBatch())!;
    expect(next.id).not.toBe(batch.id);
    expect(next.entry_ids).toEqual([data.entries[1].id]);
  });

  it('restores atomically, rejects malformed backups and invalidates stale submissions', async () => {
    const repository = createDemoRepository();
    await repository.saveEntries([entry(0)]);
    const original = await repository.load();
    const stale = await answer(repository, original.entries[0].id);
    await repository.restoreBackup(exportBackup(original));
    await expect(repository.submitReview(stale)).rejects.toThrow('进度');
    await expect(repository.saveEntries([original.entries[0]])).rejects.toThrow('修改');
    const current = await repository.load();
    const invalid = exportBackup(current);
    invalid.data.entries = [];
    await expect(repository.restoreBackup(invalid)).rejects.toThrow('引用');
    expect(await repository.load()).toEqual(current);
  });
});
