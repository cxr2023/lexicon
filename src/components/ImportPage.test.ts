import { describe, expect, it } from 'vitest';
import { createEntry } from '../lib/domain';
import { buildImportPlan, mergeImportedEntry, type ImportRow } from './ImportPage';
import type { Entry } from '../types';

function row(entry: Entry, patch: Partial<ImportRow> = {}): ImportRow {
  return { key: entry.id, entry, line: 1, action: 'auto', overwrite: false, ...patch };
}

describe('import preview decisions', () => {
  it('requires an explicit choice for normalized same-name entries without IDs', () => {
    const existing = createEntry({ term: 'Take a break', revision: 3 });
    const incoming = createEntry({ term: '  ＴＡＫＥ   a break  ' });
    const plan = buildImportPlan([row(incoming)], [existing]);
    expect(plan.unresolved).toBe(1);
    expect(plan.entries).toHaveLength(0);
  });

  it('merges into a matching ID and preserves identity, revision and user preferences', () => {
    const existing = createEntry({ term: 'old term', meaning_zh: '个人释义', favorite: true, suspended: true, revision: 7 });
    const incoming = createEntry({ id: existing.id, term: 'new term', meaning_zh: '导入释义', definition_en: 'An English definition.' });
    const plan = buildImportPlan([row(incoming, { suppliedId: incoming.id })], [existing]);
    expect(plan.updated).toBe(1);
    expect(plan.entries[0]).toMatchObject({ id: existing.id, revision: 7, term: 'old term', meaning_zh: '个人释义', definition_en: 'An English definition.', favorite: true, suspended: true, created_at: existing.created_at });
  });

  it('keeps a valid unfamiliar supplied ID separate even if its term already exists', () => {
    const existing = createEntry({ term: 'bank' });
    const incoming = createEntry({ term: 'bank' });
    const plan = buildImportPlan([row(incoming, { suppliedId: incoming.id })], [existing]);
    expect(plan.added).toBe(1);
    expect(plan.unresolved).toBe(0);
    expect(plan.entries[0].id).toBe(incoming.id);
  });

  it('normalizes incoming IPA but protects existing IPA until replacement is explicitly chosen', () => {
    const existing = createEntry({ term: 'red', ipa_us: '/ɹed/', notes: 'Personal note', revision: 9, favorite: true });
    const incoming = createEntry({ id: existing.id, term: 'red', ipa_us: '/ɹ\u200bed/', definition_en: 'A colour.' });
    const rows = [row(incoming, { suppliedId: existing.id })];
    const protectedPlan = buildImportPlan(rows, [existing]);
    expect(protectedPlan.rows[0].row).toMatchObject({ ipaNormalized: true, entry: { ipa_us: '/red/' } });
    expect(protectedPlan.entries[0]).toMatchObject({ ipa_us: existing.ipa_us, id: existing.id, revision: 9, notes: existing.notes, favorite: true });
    const replacement = buildImportPlan([{ ...rows[0], overwrite: true }], [existing]);
    expect(replacement.entries[0]).toMatchObject({ ipa_us: '/red/', id: existing.id, revision: 9, notes: existing.notes, favorite: true });
    expect(incoming.ipa_us).toBe('/ɹ\u200bed/');
  });

  it('detects same-file duplicates and folds a chosen merge into one new entry', () => {
    const first = createEntry({ term: 'resilient', ipa_us: '/rɪˈzɪliənt/' });
    const second = createEntry({ term: 'resilient', definition_en: 'Able to recover quickly.' });
    expect(buildImportPlan([row(first), row(second)], []).unresolved).toBe(1);
    const merged = buildImportPlan([row(first), row(second, { action: 'merge', targetId: first.id })], []);
    expect(merged.entries).toHaveLength(1);
    expect(merged.entries[0]).toMatchObject({ id: first.id, revision: 0, ipa_us: first.ipa_us, definition_en: second.definition_en });
    expect(merged.added).toBe(1);
  });

  it('folds several merges into one write at the original revision', () => {
    const existing = createEntry({ term: 'resilient', revision: 4 });
    const first = createEntry({ term: 'resilient', ipa_us: '/rɪˈzɪliənt/' });
    const second = createEntry({ term: 'resilient', definition_en: 'Able to recover quickly.' });
    const plan = buildImportPlan([row(first, { action: 'merge' }), row(second, { action: 'merge' })], [existing]);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]).toMatchObject({ id: existing.id, revision: 4, ipa_us: first.ipa_us, definition_en: second.definition_en });
  });

  it('releases a duplicate when its earlier target is skipped', () => {
    const first = createEntry({ term: 'resilient' });
    const second = createEntry({ term: 'resilient' });
    const plan = buildImportPlan([row(first, { action: 'skip' }), row(second)], []);
    expect(plan.unresolved).toBe(0);
    expect(plan.entries.map(entry => entry.id)).toEqual([second.id]);
  });

  it('explicit overwrite replaces nonempty text without erasing absent fields or preferences', () => {
    const existing = createEntry({ term: 'bank', notes: 'My note', source: 'My book', favorite: true, suspended: true, revision: 6 });
    const incoming = createEntry({ term: 'bank on', type: 'phrase', notes: 'Corrected note', source: '' });
    expect(mergeImportedEntry(existing, incoming, true)).toMatchObject({ id: existing.id, revision: 6, term: 'bank on', type: 'phrase', notes: 'Corrected note', source: 'My book', favorite: true, suspended: true });
  });
});
