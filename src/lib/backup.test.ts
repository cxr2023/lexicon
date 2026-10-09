import { describe, expect, it } from 'vitest';
import type { Snapshot, StudyCard } from '../types';
import { exportBackup, parseBackup, validateBackup } from './backup';
import { createEntry, emptySnapshot, initialState, schedule } from './domain';

function sample(): Snapshot {
  const snapshot = emptySnapshot();
  const entry = createEntry({ term: 'apple', ipa_us: '/ˈæpəl/', definition_en: 'A round fruit.' });
  const before: StudyCard = { id: crypto.randomUUID(), entry_id: entry.id, kind: 'recognition', state: initialState(new Date('2026-10-09T10:00:00Z')), revision: 1, bury_until: null };
  const now = new Date('2026-10-09T11:00:00Z');
  const after = { ...before, state: schedule(before, 3, snapshot.settings, now), revision: 2 };
  snapshot.entries.push(entry);
  snapshot.cards.push(after);
  snapshot.reviews.push({ id: crypto.randomUUID(), card_id: after.id, entry_id: entry.id, rating: 3, reviewed_at: now.toISOString(), before, after, undone: false });
  snapshot.batches.push({ id: crypto.randomUUID(), entry_ids: [entry.id], completed_ids: [entry.id], created_at: now.toISOString(), completed_at: now.toISOString() });
  return snapshot;
}

describe('versioned backup validation', () => {
  it('roundtrips content, scheduler, history, batches and settings without sharing references', () => {
    const original = sample();
    const backup = exportBackup(original);
    expect(parseBackup(JSON.stringify(backup)).data).toEqual(original);
    backup.data.entries[0].ipa_us = 'modified';
    expect(original.entries[0].ipa_us).toBe('/ˈæpəl/');
  });
  it('rejects malformed JSON, future versions and unsupported fields', () => {
    expect(() => parseBackup('{bad json}')).toThrow('JSON');
    expect(() => validateBackup({ ...exportBackup(sample()), version: 2 })).toThrow('版本');
    const backup = exportBackup(sample());
    expect(() => validateBackup({ ...backup, arbitrary: true })).toThrow('不支持的字段');
  });
  it('rejects duplicate IDs and orphaned graph references', () => {
    const duplicate = exportBackup(sample());
    duplicate.data.entries.push(duplicate.data.entries[0]);
    expect(() => validateBackup(duplicate)).toThrow('重复 ID');
    const orphan = exportBackup(sample());
    orphan.data.cards[0].entry_id = crypto.randomUUID();
    expect(() => validateBackup(orphan)).toThrow('不存在的条目');
    const badReview = exportBackup(sample());
    badReview.data.reviews[0].after.id = crypto.randomUUID();
    expect(() => validateBackup(badReview)).toThrow('不匹配');
    const badBatch = exportBackup(sample());
    badBatch.data.batches[0].completed_ids.push(crypto.randomUUID());
    expect(() => validateBackup(badBatch)).toThrow('不属于该批次');
  });
  it('rejects nonfinite scheduler numbers, bad state, missing dates and duplicate directions', () => {
    const nonfinite = exportBackup(sample());
    nonfinite.data.cards[0].state.stability = Number.NaN;
    expect(() => validateBackup(nonfinite)).toThrow('有限数值');
    const wrongState = exportBackup(sample());
    wrongState.data.cards[0].state.state = 4;
    expect(() => validateBackup(wrongState)).toThrow('整数');
    const missingDate = exportBackup(sample());
    delete missingDate.data.cards[0].state.last_review;
    expect(() => validateBackup(missingDate)).toThrow('上次复习时间');
    const duplicateKind = exportBackup(sample());
    duplicateKind.data.cards.push({ ...duplicateKind.data.cards[0], id: crypto.randomUUID() });
    expect(() => validateBackup(duplicateKind)).toThrow('同一题型');
  });
  it('validates settings and requires complete entry shapes while allowing drafts', () => {
    const draft = emptySnapshot();
    draft.entries.push(createEntry({ term: 'pending' }));
    expect(() => exportBackup(draft)).not.toThrow();
    const badSettings = exportBackup(sample());
    badSettings.data.settings.timezone = 'Not/A-Timezone';
    expect(() => validateBackup(badSettings)).toThrow('时区');
    const badDate = exportBackup(sample());
    badDate.exported_at = '2026-02-30T00:00:00.000Z';
    expect(() => validateBackup(badDate)).toThrow('日历日期');
    const dateOnlyBurial = exportBackup(sample());
    dateOnlyBurial.data.cards[0].bury_until = '2026-10-10';
    expect(() => validateBackup(dateOnlyBurial)).toThrow('有效日期');
    const badRetention = exportBackup(sample());
    badRetention.data.settings.retention = 1;
    expect(() => validateBackup(badRetention)).toThrow('retention');
    const missingIpa = JSON.parse(JSON.stringify(exportBackup(sample())));
    delete missingIpa.data.entries[0].ipa_us;
    expect(() => validateBackup(missingIpa)).toThrow('ipa_us 缺失');
  });
});
