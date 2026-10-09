import type { Backup, Entry, FSRSState, Settings, Snapshot, StudyCard } from '../types';
import { UUID_PATTERN } from './markdown';

type ObjectValue = Record<string, unknown>;
const MAX_FILE_SIZE = 50 * 1024 * 1024;
function fail(path: string, message: string): never { throw new Error(`备份无效：${path} ${message}`); }
function object(value: unknown, path: string, required: string[], optional: string[] = []): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(path, '必须是对象。');
  const data = value as ObjectValue;
  for (const key of required) if (!Object.hasOwn(data, key)) fail(`${path}.${key}`, '缺失。');
  const keys = new Set([...required, ...optional]);
  for (const key of Object.keys(data)) if (!keys.has(key)) fail(`${path}.${key}`, '为不支持的字段。');
  return data;
}
function text(value: unknown, path: string, maximum = 20_000): asserts value is string {
  if (typeof value !== 'string' || value.length > maximum) fail(path, `必须是至多 ${maximum} 个字符的文本。`);
}
function uuid(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) fail(path, '必须是有效 UUID。');
}
function date(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string') fail(path, '必须是带时区的有效日期。');
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts || !Number.isFinite(Date.parse(value))) fail(path, '必须是带时区的有效日期。');
  const [, year, month, day, hours, minutes, seconds] = parts.map(Number);
  const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > maxDay || hours > 23 || minutes > 59 || seconds > 59) fail(path, '包含无效的日历日期。');
}
function numeric(value: unknown, path: string, minimum = 0, maximum = 1_000_000_000, integer = false): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isInteger(value))) fail(path, `必须是 ${minimum} 至 ${maximum} 之间的${integer ? '整数' : '有限数值'}。`);
}
function bool(value: unknown, path: string): asserts value is boolean {
  if (typeof value !== 'boolean') fail(path, '必须是布尔值。');
}
function array(value: unknown, path: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) return fail(path, `必须是至多 ${maximum} 项的数组。`);
  return value;
}
function choice(value: unknown, path: string, choices: unknown[]): void {
  if (!choices.includes(value)) fail(path, '包含不支持的取值。');
}
function uniqueIds(values: unknown[], path: string): Set<string> {
  const ids = new Set<string>();
  const normalizedIds = new Set<string>();
  values.forEach((value, index) => {
    uuid(value, `${path}[${index}]`);
    const normalized = value.toLowerCase();
    if (normalizedIds.has(normalized)) fail(path, '包含重复 ID。');
    normalizedIds.add(normalized);
    ids.add(value);
  });
  return ids;
}
function validateState(value: unknown, path: string): FSRSState {
  const state = object(value, path, ['due', 'stability', 'difficulty', 'elapsed_days', 'scheduled_days', 'learning_steps', 'reps', 'lapses', 'state'], ['last_review']);
  date(state.due, `${path}.due`);
  if (state.last_review !== undefined) date(state.last_review, `${path}.last_review`);
  numeric(state.stability, `${path}.stability`, 0, 1_000_000);
  numeric(state.difficulty, `${path}.difficulty`, 0, 10);
  for (const key of ['elapsed_days', 'scheduled_days', 'learning_steps', 'reps', 'lapses', 'state']) numeric(state[key], `${path}.${key}`, 0, key === 'state' ? 3 : 1_000_000_000, true);
  if ((state.lapses as number) > (state.reps as number)) fail(path, '遗忘次数不能超过作答次数。');
  if (state.state !== 0 && (!state.last_review || state.reps === 0)) fail(path, '已学习卡片必须包含上次复习时间与作答次数。');
  if (state.state === 0 && state.reps !== 0) fail(path, '新卡不能包含已有作答次数。');
  return state as unknown as FSRSState;
}
function validateCard(value: unknown, path: string, entryIds: Set<string>): StudyCard {
  const card = object(value, path, ['id', 'entry_id', 'kind', 'state', 'revision', 'bury_until']);
  uuid(card.id, `${path}.id`); uuid(card.entry_id, `${path}.entry_id`);
  if (!entryIds.has(card.entry_id)) fail(path, '引用了不存在的条目。');
  choice(card.kind, `${path}.kind`, ['recognition', 'production', 'cloze']);
  numeric(card.revision, `${path}.revision`, 0, 1_000_000_000, true);
  if (card.bury_until !== null) date(card.bury_until, `${path}.bury_until`);
  validateState(card.state, `${path}.state`);
  return card as unknown as StudyCard;
}
function validateEntry(value: unknown, path: string): Entry {
  const entry = object(value, path, ['id', 'term', 'ipa_us', 'definition_en', 'meaning_zh', 'type', 'pos', 'example', 'example_translation', 'usage', 'tags', 'source', 'notes', 'favorite', 'suspended', 'created_at', 'updated_at', 'revision']);
  uuid(entry.id, `${path}.id`);
  text(entry.term, `${path}.term`, 2000);
  if (!entry.term.trim()) fail(`${path}.term`, '不能为空。');
  for (const key of ['ipa_us', 'definition_en', 'meaning_zh', 'pos', 'example', 'example_translation', 'usage', 'source', 'notes']) text(entry[key], `${path}.${key}`);
  choice(entry.type, `${path}.type`, ['word', 'phrase', 'idiom', 'sentence']);
  bool(entry.favorite, `${path}.favorite`); bool(entry.suspended, `${path}.suspended`);
  date(entry.created_at, `${path}.created_at`); date(entry.updated_at, `${path}.updated_at`);
  numeric(entry.revision, `${path}.revision`, 0, 1_000_000_000, true);
  const tags = array(entry.tags, `${path}.tags`, 200);
  tags.forEach((tag, index) => text(tag, `${path}.tags[${index}]`, 200));
  return entry as unknown as Entry;
}
export function validateSettings(value: unknown, path = 'settings'): Settings {
  const settings = object(value, path, ['batch_size', 'timezone', 'hide_chinese', 'production_enabled', 'cloze_enabled', 'retention']);
  numeric(settings.batch_size, `${path}.batch_size`, 1, 100, true);
  numeric(settings.retention, `${path}.retention`, 0.7, 0.99);
  for (const key of ['hide_chinese', 'production_enabled', 'cloze_enabled']) bool(settings[key], `${path}.${key}`);
  text(settings.timezone, `${path}.timezone`, 100);
  try { new Intl.DateTimeFormat('en-US', { timeZone: settings.timezone as string }).format(new Date()); }
  catch { fail(`${path}.timezone`, '不是有效时区。'); }
  return settings as unknown as Settings;
}

export function validateBackup(value: unknown): Backup {
  const backup = object(value, 'backup', ['version', 'exported_at', 'data']);
  if (backup.version !== 1) fail('version', '版本不受支持，请使用版本 1 的备份。');
  date(backup.exported_at, 'exported_at');
  const snapshot = object(backup.data, 'data', ['entries', 'cards', 'reviews', 'batches', 'settings']);
  const entries = array(snapshot.entries, 'entries', 50_000).map((entry, index) => validateEntry(entry, `entries[${index}]`));
  const entryIds = uniqueIds(entries.map(entry => entry.id), 'entries');
  const cards = array(snapshot.cards, 'cards', 150_000).map((card, index) => validateCard(card, `cards[${index}]`, entryIds));
  uniqueIds(cards.map(card => card.id), 'cards');
  const cardById = new Map(cards.map(card => [card.id, card]));
  const cardKinds = new Set<string>();
  for (const card of cards) {
    const key = `${card.entry_id.toLowerCase()}:${card.kind}`;
    if (cardKinds.has(key)) fail('cards', '同一条目的同一题型只能有一张卡片。');
    cardKinds.add(key);
  }
  const reviews = array(snapshot.reviews, 'reviews', 200_000).map((value, index) => {
    const path = `reviews[${index}]`;
    const review = object(value, path, ['id', 'card_id', 'entry_id', 'rating', 'reviewed_at', 'before', 'after', 'undone']);
    uuid(review.id, `${path}.id`); uuid(review.card_id, `${path}.card_id`); uuid(review.entry_id, `${path}.entry_id`);
    choice(review.rating, `${path}.rating`, [1, 2, 3, 4]); date(review.reviewed_at, `${path}.reviewed_at`); bool(review.undone, `${path}.undone`);
    const referenced = cardById.get(review.card_id);
    if (!referenced || referenced.entry_id !== review.entry_id) fail(path, '引用的卡片或条目不存在或不匹配。');
    for (const key of ['before', 'after']) {
      const card = validateCard(review[key], `${path}.${key}`, entryIds);
      if (card.id !== review.card_id || card.entry_id !== review.entry_id || card.kind !== referenced.kind) fail(`${path}.${key}`, '卡片身份与复习记录不匹配。');
    }
    return review;
  });
  uniqueIds(reviews.map(review => review.id), 'reviews');
  const batches = array(snapshot.batches, 'batches', 50_000).map((value, index) => {
    const path = `batches[${index}]`;
    const batch = object(value, path, ['id', 'entry_ids', 'completed_ids', 'created_at', 'completed_at']);
    uuid(batch.id, `${path}.id`); date(batch.created_at, `${path}.created_at`);
    if (batch.completed_at !== null) date(batch.completed_at, `${path}.completed_at`);
    const ids = uniqueIds(array(batch.entry_ids, `${path}.entry_ids`, 100), `${path}.entry_ids`);
    const completed = uniqueIds(array(batch.completed_ids, `${path}.completed_ids`, 100), `${path}.completed_ids`);
    for (const id of ids) if (!entryIds.has(id)) fail(path, '批次引用了不存在的条目。');
    for (const id of completed) if (!ids.has(id)) fail(path, '已完成条目不属于该批次。');
    return batch;
  });
  uniqueIds(batches.map(batch => batch.id), 'batches');
  if (batches.filter(batch => batch.completed_at === null).length > 1) fail('batches', '不能存在多个未结束的学习批次。');
  validateSettings(snapshot.settings);
  return backup as unknown as Backup;
}

export function parseBackup(text: string): Backup {
  if (new TextEncoder().encode(text).byteLength > MAX_FILE_SIZE) throw new Error('备份不能超过 50 MB。');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('无法读取备份，请选择有效的 JSON 文件。'); }
  return validateBackup(value);
}
export function exportBackup(snapshot: Snapshot): Backup {
  return validateBackup({ version: 1, exported_at: new Date().toISOString(), data: structuredClone(snapshot) });
}
export function downloadText(filename: string, text: string, mime = 'text/plain;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename;
  document.body.append(anchor); anchor.click(); anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
