import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateBackup } from '../../src/lib/backup';
import { createEntry, schedule } from '../../src/lib/domain';
import type { ReviewInput, Snapshot, StudyBatch, WordForms } from '../../src/types';

let db: PGlite;
const uid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherUid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const sql = (statement: string, args?: unknown[]) => db.query(statement, args);
async function rpc<T>(name: string, args: unknown[] = []): Promise<T> {
  const placeholders = args.map((_, i) => `$${i + 1}${typeof args[i] === 'object' ? '::jsonb' : ''}`);
  const result = await sql(`select public.${name}(${placeholders.join(',')}) as result`, args.map(value => typeof value === 'object' ? JSON.stringify(value) : value));
  return (result.rows[0] as { result: T }).result;
}
const load = async () => validateBackup({ version: 1, exported_at: new Date().toISOString(), data: await rpc<Snapshot>('load_snapshot') }).data;
const makeEntry = (i: number) => createEntry({ term: `word ${i}`, ipa_us: '/wɝd/', definition_en: `An item ${i}.`, created_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() });
async function inputFor(entryId: string) {
  const snapshot = await load();
  const card = snapshot.cards.find(card => card.entry_id === entryId && card.kind === 'recognition')!;
  const now = new Date();
  const input: ReviewInput = { operation_id: crypto.randomUUID(), card_id: card.id, expected_revision: card.revision,
    rating: 3, reviewed_at: now.toISOString(), next_state: schedule(card, 3, snapshot.settings, now) };
  return input;
}
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create schema auth;
    create table auth.users(id uuid primary key);
    insert into auth.users values ('${uid}'), ('${otherUid}');
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
  `);
  const directory = new URL('../migrations/', import.meta.url);
  for (const filename of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
    await db.exec(await readFile(new URL(filename, directory), 'utf8'));
  }
  await sql(`select set_config('request.jwt.claim.sub', $1, false)`, [uid]);
  await db.exec('set role authenticated');
}, 60_000);
afterAll(async () => { await db?.close(); });

describe('Supabase SQL RPC contracts on PostgreSQL', () => {
  it('creates a valid private snapshot, blocks direct updates and hides other users', async () => {
    const snapshot = await rpc<Snapshot>('load_snapshot', ['America/New_York']);
    expect(snapshot.settings.timezone).toBe('America/New_York');
    expect(snapshot.entries).toEqual([]);
    await expect(db.exec(`update public.lexicon_workspaces set data = '{}'::jsonb`)).rejects.toThrow('permission denied');
    await expect(rpc('lexicon_action', ['load'])).rejects.toThrow('permission denied');
    await sql(`select set_config('request.jwt.claim.sub', $1, false)`, [otherUid]);
    expect((await sql('select * from public.lexicon_workspaces')).rows).toHaveLength(0);
    expect((await load()).entries).toHaveLength(0);
    await sql(`select set_config('request.jwt.claim.sub', $1, false)`, [uid]);
  });

  it('excludes drafts and uncertain entries, returns resumed batches, allows >10 per day', async () => {
    await rpc('save_entries', [Array.from({ length: 12 }, (_, i) => makeEntry(i))]);
    await rpc('save_entries', [[{ ...makeEntry(20), ipa_us: '' }]]);
    await rpc('save_entries', [[{ ...makeEntry(21), notes: '待确认' }]]);
    const snapshot = await load();
    expect(snapshot.cards).toHaveLength(12);
    const first = await rpc<StudyBatch>('start_next_batch');
    expect(first.entry_ids).toHaveLength(10);
    expect((await rpc<StudyBatch>('start_next_batch')).id).toBe(first.id);
    for (const id of first.entry_ids) await rpc('submit_review', [await inputFor(id)]);
    const second = await rpc<StudyBatch>('start_next_batch');
    expect(second.entry_ids).toHaveLength(2);
    expect(second.entry_ids.every(id => !first.entry_ids.includes(id))).toBe(true);
  });

  it('deduplicates an exact submission, rejects reused ids and optimistic races', async () => {
    const batch = await rpc<StudyBatch>('start_next_batch');
    const input = await inputFor(batch.entry_ids[0]);
    await rpc('submit_review', [input]);
    await rpc('submit_review', [input]);
    expect((await load()).reviews.filter(review => review.id === input.operation_id)).toHaveLength(1);
    await expect(rpc('submit_review', [{ ...input, rating: 1 }])).rejects.toThrow('编号');
    await expect(rpc('submit_review', [{ ...input, operation_id: crypto.randomUUID() }])).rejects.toMatchObject({ code: 'PT409', message: expect.stringContaining('进度') });
  });

  it('adds optional cards without resetting progress, buries siblings, and undoes atomically', async () => {
    let data = await load();
    const target = data.entries[0];
    const recognition = data.cards.find(card => card.entry_id === target.id)!;
    await rpc('save_entries', [[{ ...target, meaning_zh: '词', example: 'A {{word}} here.' }]]);
    data = await load();
    expect(data.cards.find(card => card.id === recognition.id)).toEqual(recognition);
    await rpc('save_settings', [{ ...data.settings, production_enabled: true, cloze_enabled: true }]);
    expect((await load()).cards.filter(card => card.entry_id === target.id && card.kind !== 'recognition').every(card => !!card.bury_until)).toBe(true);
    const input = await inputFor(target.id);
    await rpc('submit_review', [input]);
    data = await load();
    expect(data.cards.filter(card => card.entry_id === target.id && card.kind !== 'recognition').every(card => !!card.bury_until)).toBe(true);
    await rpc('undo_review', [input.operation_id]);
    data = await load();
    expect(data.cards.find(card => card.id === recognition.id)?.state).toEqual(recognition.state);
    expect(data.reviews.find(event => event.id === input.operation_id)?.undone).toBe(true);
  });

  it('permanently cascades deletion and rejects stale writes and submissions', async () => {
    const data = await load();
    const entry = data.entries[0];
    const stale = await inputFor(entry.id);
    await rpc('delete_entry', [entry.id, entry.revision]);
    const current = await load();
    expect(current.entries.some(item => item.id === entry.id)).toBe(false);
    expect(current.cards.some(item => item.entry_id === entry.id)).toBe(false);
    expect(current.reviews.some(item => item.entry_id === entry.id)).toBe(false);
    expect(current.batches.some(item => item.entry_ids.includes(entry.id) || item.completed_ids.includes(entry.id))).toBe(false);
    await expect(rpc('save_entries', [[entry]])).rejects.toMatchObject({ code: 'PT409', message: expect.stringContaining('删除') });
    await expect(rpc('submit_review', [stale])).rejects.toThrow('删除');
  });

  it('validates restore shape and invalidates every pre-restore card version', async () => {
    const data = await load();
    const stale = await inputFor(data.entries[0].id);
    await expect(rpc('restore_backup', [{ version: 1, exported_at: new Date().toISOString(), data: { ...data, entries: [] } }])).rejects.toThrow('引用');
    expect(await load()).toEqual(data);
    await rpc('restore_backup', [{ version: 1, exported_at: new Date().toISOString(), data }]);
    const restored = await load();
    expect(restored.cards[0].revision).toBeGreaterThan(data.cards[0].revision);
    await expect(rpc('submit_review', [stale])).rejects.toThrow('进度');
  });

  it('rejects malformed server-side backup data without committing partial changes', async () => {
    const data = await load();
    const malformed = structuredClone(data);
    delete (malformed.cards[0].state as unknown as Record<string, unknown>).due;
    await expect(rpc('restore_backup', [{ version: 1, exported_at: new Date().toISOString(), data: malformed }])).rejects.toThrow('卡片');
    await expect(rpc('restore_backup', [{ version: 1, exported_at: new Date().toISOString(), data: { ...data, unexpected: true } }])).rejects.toThrow('备份');
    expect(await load()).toEqual(data);
    const changed = { ...data.entries[0], notes: 'Updated on another device' };
    await rpc('save_entries', [[changed]]);
    await expect(rpc('save_entries', [[makeEntry(30), changed]])).rejects.toThrow('修改');
    expect((await load()).entries).toHaveLength(data.entries.length);
    await expect(rpc('delete_entry', [changed.id, changed.revision])).rejects.toMatchObject({ code: 'PT409', message: expect.stringContaining('更新') });
    await expect(sql('select public.delete_entry($1, $2)', [changed.id, null])).rejects.toThrow('版本');
  });

  it('returns PT409 for a stale undo instead of a retryable serialization failure', async () => {
    const data = await load();
    const first = await inputFor(data.entries[0].id);
    await rpc('submit_review', [first]);
    const second = await inputFor(data.entries[1].id);
    await rpc('submit_review', [second]);
    await expect(rpc('undo_review', [first.operation_id])).rejects.toMatchObject({ code: 'PT409', message: expect.stringContaining('无法撤销') });
  });

  it('preserves word forms omitted by old clients, allows explicit clearing, and leaves study progress intact', async () => {
    const before = await load();
    const target = before.entries[0];
    const forms: WordForms = {
      verb: { base: 'work', third_person: 'works', past: 'worked', past_participle: 'worked', present_participle: 'working', note: '规则变化' },
      comparison: { positive: 'hard', comparative: 'harder', superlative: 'hardest' },
      derivatives: [{ term: 'worker', pos: 'noun', meaning: 'A person who works.', affix: '-er' }],
    };
    await rpc('save_entries', [[{ ...target, word_forms: forms }]]);
    let data = await load();
    expect(data.entries.find(entry => entry.id === target.id)?.word_forms).toEqual(forms);
    const legacy = { ...data.entries.find(entry => entry.id === target.id)!, notes: 'Edited in an older app' };
    delete legacy.word_forms;
    await rpc('save_entries', [[legacy]]);
    data = await load();
    const preserved = data.entries.find(entry => entry.id === target.id)!;
    expect(preserved.word_forms).toEqual(forms);
    expect(preserved.notes).toBe(legacy.notes);
    expect(preserved.revision).toBe(target.revision + 2);
    await expect(rpc('save_entries', [[{ ...target, word_forms: {} }]])).rejects.toMatchObject({ code: 'PT409' });
    await rpc('save_entries', [[{ ...preserved, word_forms: {} }]]);
    data = await load();
    expect(data.entries.find(entry => entry.id === target.id)?.word_forms).toEqual({});
    expect(data.cards).toEqual(before.cards);
    expect(data.reviews).toEqual(before.reviews);
    expect(data.batches).toEqual(before.batches);
  });

  it('roundtrips partial and maximum-sized word forms and still restores legacy v1 backups', async () => {
    const partial: WordForms = { verb: { base: 'go', third_person: '', past: '', past_participle: '', present_participle: '' } };
    const maximum: WordForms = {
      comparison: { positive: 'a'.repeat(2000), comparative: '', superlative: '', note: 'a'.repeat(20000) },
      derivatives: Array.from({ length: 30 }, () => ({ term: '', pos: '', meaning: '', affix: 'a'.repeat(2000) })),
    };
    const entry = { ...makeEntry(50), word_forms: partial };
    await rpc('save_entries', [[entry]]);
    let data = await load();
    expect(data.entries.find(item => item.id === entry.id)?.word_forms).toEqual(partial);
    await rpc('save_entries', [[{ ...data.entries.find(item => item.id === entry.id)!, word_forms: maximum }]]);
    data = await load();
    await rpc('restore_backup', [{ version: 1, exported_at: new Date().toISOString(), data }]);
    let restored = await load();
    expect(restored.entries.find(item => item.id === entry.id)?.word_forms).toEqual(maximum);
    expect(restored.cards.map(card => card.state)).toEqual(data.cards.map(card => card.state));
    const legacy = structuredClone(restored);
    legacy.entries.forEach(item => { delete item.word_forms; });
    await rpc('restore_backup', [{ version: 1, exported_at: new Date().toISOString(), data: legacy }]);
    restored = await load();
    expect(restored.entries.every(item => !Object.hasOwn(item, 'word_forms'))).toBe(true);
  });

  it('rejects malformed word forms in both writes and restores without any partial commit', async () => {
    const before = await load();
    const emptyVerb = { base: '', third_person: '', past: '', past_participle: '', present_participle: '' };
    const derivative = { term: 'worker', pos: '', meaning: '', affix: '-er' };
    const invalid = [null, [], 'go', { unknown: true }, { verb: {} }, { verb: { ...emptyVerb, base: 123 } },
      { verb: { ...emptyVerb, unknown: '' } }, { comparison: { positive: 'good', comparative: 'better' } },
      { comparison: { positive: '', comparative: '', superlative: '', note: false } },
      { derivatives: null }, { derivatives: [{ term: 'worker' }] }, { derivatives: [{ ...derivative, unexpected: '' }] },
      { derivatives: [{ ...derivative, meaning: [] }] }, { derivatives: Array.from({ length: 31 }, () => derivative) },
      { verb: { ...emptyVerb, base: 'a'.repeat(2001) } }, { verb: { ...emptyVerb, note: 'a'.repeat(20001) } },
      { derivatives: [{ ...derivative, affix: 'a'.repeat(2001) }] }];
    for (const word_forms of invalid) {
      const entry = { ...before.entries[0], word_forms };
      await expect(rpc('save_entries', [[makeEntry(60), entry]])).rejects.toThrow(/词形|派生词/);
      await expect(rpc('restore_backup', [{ version: 1, exported_at: new Date().toISOString(),
        data: { ...before, entries: [entry, ...before.entries.slice(1)] } }])).rejects.toThrow(/词形|派生词/);
    }
    expect(await load()).toEqual(before);
  });

  it('can reapply the word-form upgrade without weakening function permissions or conflict checks', async () => {
    await db.exec('begin; reset role;');
    try {
      const functionDefinition = async () => (await sql("select pg_get_functiondef('public.lexicon_action(text,jsonb)'::regprocedure) as body")).rows[0] as { body: string };
      const before = await functionDefinition();
      const upgrade = await readFile(new URL('../migrations/202610100001_word_forms.sql', import.meta.url), 'utf8');
      await db.exec(upgrade);
      expect(await functionDefinition()).toEqual(before);
      expect(before.body.match(/errcode = 'PT409'/g)).toHaveLength(4);
      const permissions = await sql(`select
        has_function_privilege('authenticated', 'public.lexicon_validate_word_forms(jsonb)', 'EXECUTE') as validator,
        has_function_privilege('anon', 'public.lexicon_validate_word_forms(jsonb)', 'EXECUTE') as anon_validator,
        has_function_privilege('authenticated', 'public.lexicon_action(text,jsonb)', 'EXECUTE') as dispatcher,
        prosecdef as security_definer, proconfig from pg_proc where oid = 'public.lexicon_action(text,jsonb)'::regprocedure`);
      expect(permissions.rows[0]).toMatchObject({ validator: false, anon_validator: false, dispatcher: false, security_definer: true });
      expect((permissions.rows[0] as { proconfig: string[] }).proconfig).toContain('search_path=public, pg_temp');
    } finally { await db.exec('rollback'); }
  });

  it('upgrades an already deployed 40001 function while preserving restricted access', async () => {
    await db.exec('begin; reset role;');
    try {
      const result = await sql("select pg_get_functiondef('public.lexicon_action(text,jsonb)'::regprocedure) as body");
      const current = (result.rows[0] as { body: string }).body;
      expect(current.match(/errcode = 'PT409'/g)).toHaveLength(4);
      await db.exec(current.replaceAll("errcode = 'PT409'", "errcode = '40001'"));
      const upgrade = await readFile(new URL('../migrations/202610090002_conflict_status.sql', import.meta.url), 'utf8');
      await db.exec(upgrade);
      await db.exec(upgrade); // Applying the correction twice is harmless.
      const changed = await sql("select pg_get_functiondef('public.lexicon_action(text,jsonb)'::regprocedure) as body");
      const patched = (changed.rows[0] as { body: string }).body;
      expect(patched.match(/errcode = 'PT409'/g)).toHaveLength(4);
      expect(patched).not.toContain("errcode = '40001'");
      await db.exec('set role authenticated');
      await expect(rpc('lexicon_action', ['load'])).rejects.toThrow('permission denied');
    } finally { await db.exec('rollback'); }
  });

  it('requires a signed-in user for every RPC', async () => {
    await sql(`select set_config('request.jwt.claim.sub', '', false)`);
    await expect(load()).rejects.toThrow('请先登录');
    await db.exec('set role anon');
    await expect(load()).rejects.toThrow('permission denied');
    await db.exec('set role authenticated');
    await sql(`select set_config('request.jwt.claim.sub', $1, false)`, [uid]);
  });
});
