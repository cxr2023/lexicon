import { useId } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { WordForms as WordFormsData } from '../types';

const verbFields = [
  ['base', '原形'], ['third_person', '第三人称单数'], ['past', '过去式'],
  ['past_participle', '过去分词'], ['present_participle', '现在分词'],
] as const;
const comparisonFields = [['positive', '原级'], ['comparative', '比较级'], ['superlative', '最高级']] as const;
const derivativeFields = [['term', '派生词'], ['pos', '词性'], ['meaning', '中文义'], ['affix', '前后缀与构词关系']] as const;
const hasText = (value: object | undefined) => value && Object.values(value).some(text => typeof text === 'string' && text.trim());

// Form-only cleanup. Existing snapshots and JSON backups never pass through it.
export function pruneEmptyWordForms(forms?: WordFormsData): WordFormsData | undefined {
  if (!forms) return undefined;
  const verb = hasText(forms.verb) ? forms.verb : undefined;
  const comparison = hasText(forms.comparison) ? forms.comparison : undefined;
  const derivatives = forms.derivatives?.filter(item => hasText(item));
  return verb || comparison || derivatives?.length ? {
    ...(verb ? { verb } : {}), ...(comparison ? { comparison } : {}),
    ...(derivatives?.length ? { derivatives } : {}),
  } : undefined;
}

export const hasWordForms = (forms?: WordFormsData) => Boolean(pruneEmptyWordForms(forms));

export default function WordForms({ forms }: { forms?: WordFormsData }) {
  const headingId = useId();
  const content = pruneEmptyWordForms(forms);
  if (!content) return null;
  const hasMissing = (content.verb && verbFields.some(([key]) => !content.verb?.[key]?.trim())) ||
    (content.comparison && comparisonFields.some(([key]) => !content.comparison?.[key]?.trim()));
  return <section className="word-forms" aria-labelledby={headingId}>
    <div className="word-forms-heading"><p className="eyebrow">WORD FAMILY</p><h3 id={headingId}>词形与派生</h3></div>
    {content.verb && <div className="word-form-block"><h4>动词变化</h4><dl className="word-form-grid verb-forms">{verbFields.map(([key, label]) => <div key={key}><dt>{label}</dt><dd lang="en">{content.verb?.[key]?.trim() || '—'}</dd></div>)}</dl>{content.verb.note && <p className="word-form-note">{content.verb.note}</p>}</div>}
    {content.comparison && <div className="word-form-block"><h4>比较等级</h4><dl className="word-form-grid comparison-forms">{comparisonFields.map(([key, label]) => <div key={key}><dt>{label}</dt><dd lang="en">{content.comparison?.[key]?.trim() || '—'}</dd></div>)}</dl>{content.comparison.note && <p className="word-form-note">{content.comparison.note}</p>}</div>}
    {!!content.derivatives?.length && <div className="word-form-block"><h4>派生词</h4><ul className="derivative-list">{content.derivatives.map((item, index) => <li key={index}><div className="derivative-term"><strong lang="en">{item.term || '—'}</strong><span>{item.pos || '词性未填'}</span></div><p>{item.meaning || '中文义未填'}</p><small><span>构词</span>{item.affix || '构词关系未填'}</small></li>)}</ul></div>}
    {hasMissing && <p className="word-forms-footnote">— 表示未填写；不适用的词形请见备注。</p>}
  </section>;
}

export function WordFormsEditor({ value, onChange }: { value?: WordFormsData; onChange: (value: WordFormsData | undefined) => void }) {
  const prefix = useId();
  const update = <K extends keyof WordFormsData>(key: K, next: WordFormsData[K]) => {
    const result = { ...value, [key]: next };
    if (next === undefined) delete result[key];
    onChange(Object.keys(result).length ? result : undefined);
  };
  const addDerivative = () => update('derivatives', [...(value?.derivatives ?? []), { term: '', pos: '', meaning: '', affix: '' }]);
  return <section className="word-forms-editor" aria-labelledby={`${prefix}-heading`}>
    <div className="word-forms-heading"><p className="eyebrow">WORD FAMILY · OPTIONAL</p><h3 id={`${prefix}-heading`}>词形与派生</h3><p className="muted">按具体词义填写；没有适用形式可以留空，并在备注说明。</p></div>
    {value?.verb ? <fieldset className="word-form-edit-block"><legend>动词变化</legend><button type="button" className="text-link danger-text word-form-remove" onClick={() => update('verb', undefined)}>清空动词变化</button><div className="word-form-edit-grid">{verbFields.map(([key, label]) => <label className="field" key={key} htmlFor={`${prefix}-${key}`}><span>{label}</span><input id={`${prefix}-${key}`} lang="en" value={value.verb?.[key] ?? ''} onChange={event => update('verb', { ...value.verb!, [key]: event.target.value })} /></label>)}</div><label className="field"><span>动词变化备注</span><textarea rows={2} value={value.verb.note ?? ''} onChange={event => update('verb', { ...value.verb!, note: event.target.value })} placeholder="如：不规则变化、不同词义的区别，或某个形式不适用" /></label></fieldset> : <button type="button" className="btn secondary word-form-add" onClick={() => update('verb', { base: '', third_person: '', past: '', past_participle: '', present_participle: '' })}><Plus size={15} /> 添加动词变化</button>}
    {value?.comparison ? <fieldset className="word-form-edit-block"><legend>比较等级</legend><button type="button" className="text-link danger-text word-form-remove" onClick={() => update('comparison', undefined)}>清空比较等级</button><div className="word-form-edit-grid comparison-edit">{comparisonFields.map(([key, label]) => <label className="field" key={key} htmlFor={`${prefix}-${key}`}><span>{label}</span><input id={`${prefix}-${key}`} lang="en" value={value.comparison?.[key] ?? ''} onChange={event => update('comparison', { ...value.comparison!, [key]: event.target.value })} /></label>)}</div><label className="field"><span>比较等级备注</span><textarea rows={2} value={value.comparison.note ?? ''} onChange={event => update('comparison', { ...value.comparison!, note: event.target.value })} placeholder="如：通常不分等级，或 more / most 与其他形式的用法区别" /></label></fieldset> : <button type="button" className="btn secondary word-form-add" onClick={() => update('comparison', { positive: '', comparative: '', superlative: '' })}><Plus size={15} /> 添加比较等级</button>}
    {!!value?.derivatives?.length && <fieldset className="word-form-edit-block"><legend>派生词</legend>{value.derivatives.map((item, index) => <div className="derivative-edit" key={index}><div className="derivative-edit-heading"><strong>派生词 {index + 1}</strong><button type="button" className="icon-button danger-text" aria-label={`删除派生词 ${index + 1}`} onClick={() => { const next = value.derivatives?.filter((_, i) => i !== index); update('derivatives', next?.length ? next : undefined); }}><Trash2 size={16} /></button></div><div className="form-grid">{derivativeFields.map(([key, label]) => <label className={`field${key === 'affix' ? ' field-wide' : ''}`} key={key} htmlFor={`${prefix}-derivative-${index}-${key}`}><span>{label}</span><input id={`${prefix}-derivative-${index}-${key}`} lang={key === 'term' || key === 'pos' ? 'en' : undefined} value={item[key]} onChange={event => update('derivatives', value.derivatives?.map((existing, i) => i === index ? { ...existing, [key]: event.target.value } : existing))} /></label>)}</div></div>)}</fieldset>}
    <button type="button" className="btn secondary word-form-add" onClick={addDerivative}><Plus size={15} /> 添加派生词</button>
  </section>;
}
