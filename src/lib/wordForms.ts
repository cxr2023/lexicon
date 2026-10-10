import type { ComparisonForms, Derivative, Entry, VerbForms, WordForms } from '../types';

/** Remove only matched English/Chinese round parentheses, including nested pairs. */
export function cleanTerm(term: string): string {
  const stack: { char: string; index: number }[] = [];
  const changes = new Int32Array(term.length + 1);
  for (let index = 0; index < term.length; index += 1) {
    const char = term[index];
    if (char === '(' || char === '（') stack.push({ char, index });
    else if (char === ')' || char === '）') {
      const opening = stack.at(-1);
      if (opening && opening.char === (char === ')' ? '(' : '（')) {
        stack.pop();
        changes[opening.index] += 1;
        changes[index + 1] -= 1;
      }
    }
  }
  let depth = 0;
  let cleaned = '';
  for (let index = 0; index < term.length; index += 1) {
    depth += changes[index];
    if (!depth) cleaned += term[index];
  }
  return cleaned.trim().replace(/\s+/g, ' ');
}

const identity = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase();
function mergeSection<T extends VerbForms | ComparisonForms | Derivative>(current: T | undefined, incoming: T, overwrite: boolean): T {
  const result = { ...current } as T;
  for (const key of Object.keys(incoming) as (keyof T)[]) {
    const value = incoming[key];
    if (typeof value === 'string' && (value.trim() || !current)) {
      const old = current?.[key];
      if (overwrite || typeof old !== 'string' || !old.trim()) result[key] = value;
    }
  }
  return result;
}

/** Filling one form never discards its siblings; old Markdown cannot erase new fields. */
export function mergeWordForms(current: WordForms | undefined, incoming: WordForms | undefined, overwrite = false): WordForms | undefined {
  if (!incoming) return current;
  const result: WordForms = { ...current };
  if (incoming.verb) result.verb = mergeSection(current?.verb, incoming.verb, overwrite);
  if (incoming.comparison) result.comparison = mergeSection(current?.comparison, incoming.comparison, overwrite);
  if (incoming.derivatives) {
    const derivatives = (current?.derivatives ?? []).map(item => ({ ...item }));
    for (const derivative of incoming.derivatives) {
      if (!derivative.term.trim() && derivatives.some(item => (['term', 'pos', 'meaning', 'affix'] as const).every(key => item[key] === derivative[key]))) continue;
      const matches = derivative.term.trim() ? derivatives.map((item, index) => ({ item, index })).filter(({ item }) => identity(item.term) === identity(derivative.term)) : [];
      const match = matches.find(({ item }) => identity(item.pos) === identity(derivative.pos))
        ?? (matches.length === 1 && (!matches[0].item.pos.trim() || !derivative.pos.trim()) ? matches[0] : undefined);
      if (match) derivatives[match.index] = mergeSection(match.item, derivative, overwrite);
      else derivatives.push({ ...derivative });
    }
    result.derivatives = derivatives;
  }
  return result;
}

export function needsWordForms(entry: Entry): boolean {
  const forms = entry.word_forms;
  const pos = [entry.pos, ...entry.tags].join(' ').toLowerCase();
  const isVerb = /动词|\bverb\b|(?:^|[\s/、，,;(（])v(?:t|i)?\.?(?:$|[\s/、，,;)）])/.test(pos);
  const isComparable = /形容词|副词|\badjective\b|\badverb\b|\badj\b|\badv\b/.test(pos);
  if (isVerb && !forms?.verb) return true;
  if (isComparable && !forms?.comparison) return true;
  if (forms?.verb) {
    const verb = forms.verb;
    if (!verb.base.trim()) return true;
    const explicitlyDefective = /(?:情态|缺陷)动词|defective\s+verb|modal\s+verb/i.test(verb.note ?? '');
    if (!explicitlyDefective && [verb.third_person, verb.past, verb.past_participle, verb.present_participle].some(value => !value.trim())) return true;
  }
  if (forms?.comparison && (!forms.comparison.positive.trim()
    || ((!forms.comparison.comparative.trim() || !forms.comparison.superlative.trim()) && !forms.comparison.note?.trim()))) return true;
  return false;
}
