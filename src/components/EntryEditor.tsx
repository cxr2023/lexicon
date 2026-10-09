import { useId, useState } from 'react';
import type { Entry } from '../types';

export const typeLabels: Record<Entry['type'], string> = { word: '单词', phrase: '短语', idiom: '习惯用语', sentence: '句子' };

export default function EntryEditor({ entry, onChange, disabled = false, showPreferences = true }: {
  entry: Entry; onChange: (entry: Entry) => void; disabled?: boolean; showPreferences?: boolean;
}) {
  const prefix = useId();
  const [tagsText, setTagsText] = useState(entry.tags.join(', '));
  const set = <K extends keyof Entry>(key: K, value: Entry[K]) => onChange({ ...entry, [key]: value });
  return <fieldset className="entry-editor" disabled={disabled}>
    <div className="form-grid">
      <div className="field field-wide"><label htmlFor={`${prefix}-term`}>英语词条 <span aria-hidden="true">*</span></label><input id={`${prefix}-term`} value={entry.term} onChange={event => set('term', event.target.value)} required placeholder="例如：take something for granted" lang="en" autoComplete="off" /></div>
      <div className="field"><label htmlFor={`${prefix}-type`}>词条类型</label><select id={`${prefix}-type`} value={entry.type} onChange={event => set('type', event.target.value as Entry['type'])}>{Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
      <div className="field"><label htmlFor={`${prefix}-pos`}>词性</label><input id={`${prefix}-pos`} value={entry.pos} onChange={event => set('pos', event.target.value)} placeholder="例如：verb / noun" /></div>
      <div className="field field-wide"><label htmlFor={`${prefix}-ipa`}>美式音标 <span className="muted">· 加入学习前必填</span></label><input id={`${prefix}-ipa`} value={entry.ipa_us} onChange={event => set('ipa_us', event.target.value)} placeholder="例如：/ɡrænt/" lang="en" /></div>
      <div className="field field-wide"><label htmlFor={`${prefix}-en`}>英文释义 <span className="muted">· 加入学习前必填</span></label><textarea id={`${prefix}-en`} value={entry.definition_en} onChange={event => set('definition_en', event.target.value)} placeholder="用简洁英语解释含义" rows={2} lang="en" /></div>
      <div className="field field-wide"><label htmlFor={`${prefix}-zh`}>中文释义</label><textarea id={`${prefix}-zh`} value={entry.meaning_zh} onChange={event => set('meaning_zh', event.target.value)} placeholder="作为需要时展开的辅助提示" rows={2} /></div>
      <div className="field field-wide"><label htmlFor={`${prefix}-example`}>英文例句</label><textarea id={`${prefix}-example`} value={entry.example} onChange={event => set('example', event.target.value)} placeholder="一个能够帮助你理解用法的句子" rows={2} lang="en" /></div>
      <div className="field field-wide"><label htmlFor={`${prefix}-translation`}>例句翻译</label><textarea id={`${prefix}-translation`} value={entry.example_translation} onChange={event => set('example_translation', event.target.value)} rows={2} /></div>
      <div className="field field-wide"><label htmlFor={`${prefix}-usage`}>用法与搭配</label><textarea id={`${prefix}-usage`} value={entry.usage} onChange={event => set('usage', event.target.value)} placeholder="常见搭配、语气或易混辨析" rows={2} /></div>
      <div className="field"><label htmlFor={`${prefix}-tags`}>标签</label><input id={`${prefix}-tags`} value={tagsText} onChange={event => { setTagsText(event.target.value); set('tags', [...new Set(event.target.value.split(/[,，]/).map(tag => tag.trim()).filter(Boolean))]); }} placeholder="工作, 日常, 阅读" /></div>
      <div className="field"><label htmlFor={`${prefix}-source`}>来源</label><input id={`${prefix}-source`} value={entry.source} onChange={event => set('source', event.target.value)} placeholder="书名、文章或链接" /></div>
      <div className="field field-wide"><label htmlFor={`${prefix}-notes`}>个人笔记</label><textarea id={`${prefix}-notes`} value={entry.notes} onChange={event => set('notes', event.target.value)} rows={3} /></div>
    </div>
    {showPreferences && <div className="checkbox-row"><label><input type="checkbox" checked={entry.favorite} onChange={event => set('favorite', event.target.checked)} /> 收藏词条</label><label><input type="checkbox" checked={entry.suspended} onChange={event => set('suspended', event.target.checked)} /> 暂停学习</label></div>}
    <p className="muted form-hint">只填写英语词条也可以保存为草稿。补齐美式音标与英文释义后，即可加入学习。</p>
  </fieldset>;
}
