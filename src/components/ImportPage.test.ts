import { describe, expect, it } from 'vitest';
import { createEntry } from '../lib/domain';
import { buildImportPlan, enrichmentCandidates, mergeImportedEntry, type ImportRow } from './ImportPage';
import { exportMarkdown, parseMarkdown } from '../lib/markdown';
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

  it('matches cleaned heads and refuses heads containing only parenthetical notes', () => {
    const existing = createEntry({ term: 'write (written)', revision: 8 });
    const incoming = createEntry({ term: 'write（wrote）' });
    const unresolved = buildImportPlan([row(incoming)], [existing]);
    expect(unresolved.unresolved).toBe(1);
    expect(unresolved.rows[0].row).toMatchObject({ entry: { term: 'write' }, originalTerm: 'write（wrote）' });
    const merged = buildImportPlan([row(incoming, { action: 'merge' })], [existing]);
    expect(merged.entries[0]).toMatchObject({ id: existing.id, term: 'write', revision: 8 });
    expect(buildImportPlan([row(createEntry({ term: '(only a note)' }))], []).entries).toEqual([]);
    const legacy = createEntry({ term: '(旧说明)', revision: 3 });
    const corrected = createEntry({ term: 'write', id: legacy.id });
    expect(buildImportPlan([row(corrected, { suppliedId: legacy.id })], [legacy]).entries[0]).toMatchObject({ term: 'write', id: legacy.id, revision: 3 });
  });

  it('fills individual word forms after a real Markdown roundtrip and protects nonempty forms', () => {
    const existing = createEntry({ term: 'write', revision: 12, favorite: true, word_forms: {
      verb: { base: 'write', third_person: 'writes', past: 'my past note', past_participle: '', present_participle: 'writing', note: 'Personal explanation' },
      derivatives: [{ term: 'writer', pos: 'noun', meaning: 'My meaning', affix: '' }, { term: 'rewriter', pos: 'noun', meaning: '重写者', affix: 're- + writer' }],
    } });
    const incoming = createEntry({ id: existing.id, term: 'write (wrote)', word_forms: {
      verb: { base: 'write', third_person: '', past: 'wrote', past_participle: 'written', present_participle: '', note: 'Imported note' },
      derivatives: [{ term: 'writer', pos: 'noun', meaning: 'An author', affix: 'write + -er' }, { term: 'rewrite', pos: 'verb', meaning: '重写', affix: 're- + write' }],
    } });
    const parsed = parseMarkdown(exportMarkdown([incoming]));
    expect(parsed.issues).toEqual([]);
    const importRow = row(parsed.entries[0], { suppliedId: existing.id });
    const protectedEntry = buildImportPlan([importRow], [existing]).entries[0];
    expect(protectedEntry).toMatchObject({ id: existing.id, revision: 12, favorite: true, word_forms: { verb: { past: 'my past note', past_participle: 'written', third_person: 'writes', note: 'Personal explanation' } } });
    expect(protectedEntry.word_forms?.derivatives).toEqual([
      { term: 'writer', pos: 'noun', meaning: 'My meaning', affix: 'write + -er' },
      existing.word_forms!.derivatives![1], incoming.word_forms!.derivatives![1],
    ]);
    const replaced = buildImportPlan([{ ...importRow, overwrite: true }], [existing]).entries[0];
    expect(replaced.word_forms?.verb).toMatchObject({ past: 'wrote', third_person: 'writes', present_participle: 'writing', note: 'Imported note' });
    expect(replaced.word_forms?.derivatives?.[0].meaning).toBe('An author');
    expect(existing.word_forms?.verb?.past_participle).toBe('');
    expect(existing.word_forms?.derivatives?.[0].affix).toBe('');
  });

  it('keeps new metadata when importing a legacy template, even with overwrite enabled', () => {
    const existing = createEntry({ term: 'unique', word_forms: { comparison: { positive: 'unique', comparative: '', superlative: '', note: 'Not gradable in this sense.' } } });
    const legacy = parseMarkdown(`## unique\n- ID: ${existing.id}\n- 英文释义: The only one of its kind.`).entries[0];
    const plan = buildImportPlan([row(legacy, { suppliedId: existing.id, overwrite: true })], [existing]);
    expect(plan.entries[0].word_forms).toEqual(existing.word_forms);
  });

  it('does not multiply identical unnamed derivative drafts on repeated imports', () => {
    const draft = { term: '', pos: 'noun', meaning: '待补作者词形', affix: '-er' };
    const otherDraft = { ...draft, meaning: '另一条待补词形' };
    const existing = createEntry({ term: 'write', word_forms: { derivatives: [draft] } });
    const incoming = createEntry({ term: 'write', word_forms: { derivatives: [draft, otherDraft] } });
    const once = mergeImportedEntry(existing, incoming, false);
    const twice = mergeImportedEntry(once, incoming, false);
    expect(twice.word_forms?.derivatives).toEqual([draft, otherDraft]);
  });

  it('offers complete verbs missing forms, while unknown words and nouns remain selectable in all entries', () => {
    const ready = { ipa_us: '/test/', definition_en: 'An existing definition.' };
    const verb = createEntry({ ...ready, term: 'write', pos: '动词' });
    const phrase = createEntry({ ...ready, term: 'give up', type: 'phrase', tags: ['动词短语'] });
    const noun = createEntry({ ...ready, term: 'apple', pos: '名词' });
    const unknown = createEntry({ ...ready, term: 'fast' });
    const draft = createEntry({ term: 'a new sentence', type: 'sentence' });
    const entries = [verb, phrase, noun, unknown, draft];
    expect(enrichmentCandidates(entries).map(entry => entry.id)).toEqual([verb.id, phrase.id, draft.id]);
    expect(enrichmentCandidates(entries, true)).toEqual(entries);
  });
});
