import { useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowUpRight, Bookmark, Download, Pause, Play, Plus, Search, Trash2 } from 'lucide-react';
import type { Entry, EntryType, WorkspaceProps } from '../types';
import { createEntry, isReady } from '../lib/domain';
import { exportMarkdown } from '../lib/markdown';
import { downloadText } from '../lib/backup';
import { normalizeEntryIpa } from '../lib/ipa';
import { cleanTerm } from '../lib/wordForms';
import EntryEditor, { typeLabels } from './EntryEditor';
import WordForms, { hasWordForms, pruneEmptyWordForms } from './WordForms';
import { errorMessage, Modal } from './Common';

type LibraryFilter = 'all' | 'ready' | 'draft' | 'favorite' | 'suspended';
const filters: { id: LibraryFilter; label: string }[] = [
  { id: 'all', label: '全部词条' }, { id: 'ready', label: '可学习' }, { id: 'draft', label: '待补全' },
  { id: 'favorite', label: '已收藏' }, { id: 'suspended', label: '已暂停' },
];

export default function Library({ snapshot, repository, refresh, notify }: WorkspaceProps) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<LibraryFilter>('all');
  const [entryType, setEntryType] = useState<EntryType | 'all'>('all');
  const [editing, setEditing] = useState<Entry | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Entry | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const detail = snapshot.entries.find(entry => entry.id === selectedId);
  const counts = useMemo(() => ({
    all: snapshot.entries.length,
    ready: snapshot.entries.filter(entry => isReady(entry) && !entry.suspended).length,
    draft: snapshot.entries.filter(entry => !isReady(entry)).length,
    favorite: snapshot.entries.filter(entry => entry.favorite).length,
    suspended: snapshot.entries.filter(entry => entry.suspended).length,
  }), [snapshot.entries]);
  const visible = useMemo(() => {
    const normalized = query.trim().normalize('NFKC').toLocaleLowerCase();
    return snapshot.entries.filter(entry => {
      if (entryType !== 'all' && entry.type !== entryType) return false;
      if (filter === 'ready' && (!isReady(entry) || entry.suspended)) return false;
      if (filter === 'draft' && isReady(entry)) return false;
      if (filter === 'favorite' && !entry.favorite) return false;
      if (filter === 'suspended' && !entry.suspended) return false;
      return !normalized || [entry.term, entry.definition_en, entry.meaning_zh, ...entry.tags].join(' ').normalize('NFKC').toLocaleLowerCase().includes(normalized);
    });
  }, [snapshot.entries, query, filter, entryType]);

  async function run(action: () => Promise<void>, message: string): Promise<boolean> {
    if (lock.current) return false;
    lock.current = true; setBusy(true);
    try { await action(); await refresh(); notify(message, 'success'); return true; }
    catch (error) { notify(errorMessage(error), 'error'); return false; }
    finally { lock.current = false; setBusy(false); }
  }
  const openEditor = (entry?: Entry) => {
    setIsNew(!entry); setEditing(entry ? { ...entry, tags: [...entry.tags] } : createEntry({ term: '' })); setSelectedId(null);
  };
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editing?.term.trim()) return;
    const term = cleanTerm(editing.term);
    if (!term) { notify('清理括号后词条为空，请填写需要学习的英语。', 'error'); return; }
    const entry = normalizeEntryIpa({ ...editing, term });
    const wordForms = pruneEmptyWordForms(entry.word_forms);
    if (wordForms) entry.word_forms = wordForms;
    else if (Object.hasOwn(editing, 'word_forms')) entry.word_forms = {};
    else delete entry.word_forms;
    if (await run(() => repository.saveEntries([entry]), isNew ? '词条已收入词库。' : '词条已更新，学习进度已保留。')) setEditing(null);
  }
  const toggle = (entry: Entry, field: 'favorite' | 'suspended') => run(
    () => repository.saveEntries([{ ...entry, [field]: !entry[field] }]),
    field === 'favorite' ? (entry.favorite ? '已取消收藏。' : '已收藏。') : (entry.suspended ? '已恢复学习。' : '已暂停学习，进度已保留。'),
  );
  const askDelete = (entry: Entry) => { setDeleting(entry); setSelectedId(null); };
  async function confirmDelete(event: FormEvent) {
    event.preventDefault();
    if (!deleting) return;
    if (await run(() => repository.deleteEntry(deleting.id, deleting.revision), '词条及其学习记录已删除。')) setDeleting(null);
  }

  return <section className="library-page">
    <div className="page-heading"><div><p className="eyebrow">YOUR PERSONAL COLLECTION</p><h1>让每一个词，<br />慢慢成为你的表达。</h1><p className="muted">收藏遇见的英语，在自己的语境里理解它。</p></div><div className="toolbar"><button className="btn secondary" disabled={!snapshot.entries.length} onClick={() => downloadText(`lexicon-${new Date().toISOString().slice(0, 10)}.md`, exportMarkdown(snapshot.entries), 'text/markdown;charset=utf-8')}><Download size={16} /> 导出 Markdown</button><button className="btn primary" onClick={() => openEditor()}><Plus size={17} /> 添加词条</button></div></div>
    <div className="panel library-panel">
      <div className="toolbar library-search"><label className="search-field"><Search size={18} aria-hidden="true" /><span className="sr-only">搜索英语、释义或标签</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索英语、释义或标签…" /></label><label className="type-filter"><span className="sr-only">筛选词条类型</span><select value={entryType} onChange={event => setEntryType(event.target.value as EntryType | 'all')}><option value="all">所有类型</option>{Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
      <div className="filter-tabs" aria-label="筛选词条状态">{filters.map(item => <button key={item.id} className={filter === item.id ? 'active' : ''} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}<span>{counts[item.id]}</span></button>)}</div>
      <div className="list-caption"><span>{visible.length} 个词条</span><span>每一次遇见，都值得记住。</span></div>
      {visible.length ? <div className="entry-list">{visible.map(entry => <article className="entry-row" key={entry.id}>
        <button className="entry-main" onClick={() => setSelectedId(entry.id)}><div className="entry-title-line"><h3 lang="en">{entry.term}</h3><span className="tag">{typeLabels[entry.type]}</span>{hasWordForms(entry.word_forms) && <span className="tag word-form-tag">有词形</span>}{!isReady(entry) && <span className="tag draft">待补全</span>}{entry.suspended && <span className="tag">已暂停</span>}</div><p className="entry-pronunciation">{entry.ipa_us || '美式音标待补全'}{entry.pos && ` · ${entry.pos}`}</p><p className="entry-definition" lang="en">{entry.definition_en || entry.meaning_zh || '先收入词库，释义可以稍后补全。'}</p>{!!entry.tags.length && <div className="entry-tags">{entry.tags.map(tag => <span key={tag}>#{tag}</span>)}</div>}</button>
        <div className="entry-actions"><button className={`icon-button${entry.favorite ? ' active' : ''}`} disabled={busy} title={entry.favorite ? '取消收藏' : '收藏词条'} aria-label={`${entry.favorite ? '取消收藏' : '收藏'} ${entry.term}`} aria-pressed={entry.favorite} onClick={() => void toggle(entry, 'favorite')}><Bookmark size={18} fill={entry.favorite ? 'currentColor' : 'none'} /></button><button className="icon-button" title="查看词条" aria-label={`查看 ${entry.term}`} onClick={() => setSelectedId(entry.id)}><ArrowUpRight size={19} /></button><button className="icon-button danger-text" disabled={busy} title="永久删除词条" aria-label={`永久删除 ${entry.term}`} onClick={() => askDelete(entry)}><Trash2 size={17} /></button></div>
      </article>)}</div> : <div className="empty-state"><Bookmark size={32} strokeWidth={1.3} /><h3>{snapshot.entries.length ? '没有找到匹配的词条' : '从你今天遇见的一个词开始'}</h3><p className="muted">{snapshot.entries.length ? '试试其他关键词，或切换类型与状态。' : '添加单词、短语或句子，也可以从「导入」批量整理。'}</p>{!snapshot.entries.length && <button className="btn primary" onClick={() => openEditor()}>添加第一个词条</button>}</div>}
    </div>
    {editing && <Modal title={isNew ? '收下一个新表达' : '编辑词条'} wide onClose={() => { if (!busy) setEditing(null); }}><form onSubmit={event => void save(event)}><EntryEditor key={editing.id} entry={editing} onChange={setEditing} disabled={busy} /><div className="modal-actions"><button type="button" className="btn secondary" disabled={busy} onClick={() => setEditing(null)}>取消</button><button className="btn primary" disabled={busy || !editing.term.trim()}>{busy ? '保存中…' : '保存词条'}</button></div></form></Modal>}
    {detail && <Modal title={detail.term} wide onClose={() => setSelectedId(null)}><div className="entry-detail"><div className="toolbar"><span className="tag">{typeLabels[detail.type]}</span>{detail.pos && <span className="muted">{detail.pos}</span>}<span className="entry-pronunciation">{detail.ipa_us || '音标待补全'}</span></div><dl>{[
      ['英文释义', detail.definition_en], ['中文释义', detail.meaning_zh], ['例句', detail.example], ['例句翻译', detail.example_translation], ['用法与搭配', detail.usage], ['标签', detail.tags.join(' · ')], ['来源', detail.source], ['个人笔记', detail.notes],
    ].filter(([, value]) => value).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><WordForms forms={detail.word_forms} />{!isReady(detail) && <p className="notice">这个词条还是草稿。补齐美式音标和英文释义后，就能开始学习。</p>}<div className="toolbar"><button className="btn secondary" disabled={busy} onClick={() => void toggle(detail, 'favorite')}><Bookmark size={16} />{detail.favorite ? '取消收藏' : '收藏'}</button><button className="btn secondary" disabled={busy} onClick={() => void toggle(detail, 'suspended')}>{detail.suspended ? <Play size={16} /> : <Pause size={16} />}{detail.suspended ? '恢复学习' : '暂停学习'}</button></div><div className="modal-actions"><button className="btn danger" disabled={busy} onClick={() => askDelete(detail)}>永久删除</button><button className="btn primary" disabled={busy} onClick={() => openEditor(detail)}>编辑词条</button></div></div></Modal>}
    {deleting && <Modal title="永久删除词条" onClose={() => { if (!busy) setDeleting(null); }}><form onSubmit={event => void confirmDelete(event)}><p>确定永久删除 <strong>{deleting.term}</strong>？对应的学习卡片和复习记录也会删除，无法撤销。</p><div className="modal-actions"><button type="button" className="btn secondary" disabled={busy} onClick={() => setDeleting(null)}>取消</button><button className="btn danger" disabled={busy}>{busy ? '删除中…' : '永久删除'}</button></div></form></Modal>}
  </section>;
}
