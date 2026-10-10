import { useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { ArrowRight, Check, Clipboard, Download, FileText, Plus, Sparkles, Upload } from 'lucide-react';
import type { Entry, WorkspaceProps } from '../types';
import { isReady } from '../lib/domain';
import { buildEnrichmentPrompt, buildMarkdownTemplate, parseMarkdown, type MarkdownIssue } from '../lib/markdown';
import { downloadText } from '../lib/backup';
import { needsIpaNotationReview, normalizeEntryIpa } from '../lib/ipa';
import { cleanTerm, mergeWordForms, needsWordForms } from '../lib/wordForms';
import EntryEditor, { typeLabels } from './EntryEditor';
import { errorMessage, Modal } from './Common';
import WordForms, { pruneEmptyWordForms } from './WordForms';

export interface ImportRow {
  key: string; entry: Entry; line: number; suppliedId?: string; ipaNormalized?: boolean; originalTerm?: string;
  action: 'auto' | 'merge' | 'separate' | 'skip'; targetId?: string; overwrite: boolean;
}
interface PlannedRow {
  row: ImportRow; candidates: Entry[]; target?: Entry;
  mode: 'new' | 'matched' | 'duplicate' | 'unresolved' | 'skipped' | 'invalid'; result?: Entry;
}
const textFields = ['term', 'ipa_us', 'definition_en', 'meaning_zh', 'pos', 'example', 'example_translation', 'usage', 'source', 'notes'] as const;
const canonical = (term: string) => cleanTerm(term.normalize('NFKC')).toLocaleLowerCase();

export function mergeImportedEntry(target: Entry, incoming: Entry, overwrite: boolean): Entry {
  const merged = { ...target, term: cleanTerm(target.term), tags: [...target.tags] };
  for (const field of textFields) {
    const value = field === 'term' ? cleanTerm(incoming.term) : incoming[field];
    if (value.trim() && (overwrite || !merged[field].trim())) merged[field] = value;
  }
  if (incoming.tags.length && (overwrite || !target.tags.length)) merged.tags = [...incoming.tags];
  if (overwrite) merged.type = incoming.type;
  const wordForms = mergeWordForms(target.word_forms, incoming.word_forms, overwrite);
  if (wordForms) merged.word_forms = wordForms;
  merged.term = cleanTerm(merged.term);
  return merged;
}

export function enrichmentCandidates(entries: Entry[], includeComplete = false): Entry[] {
  return entries.filter(entry => includeComplete || !isReady(entry) || needsWordForms(entry));
}

// Resolve in file order so several rows can enrich one target without creating duplicate writes.
export function buildImportPlan(rows: ImportRow[], existing: Entry[]) {
  const working = new Map(existing.map(entry => [entry.id, entry]));
  const existingIds = new Set(existing.map(entry => entry.id));
  const changed = new Map<string, Entry>();
  const planned: PlannedRow[] = [];
  for (const originalRow of rows) {
    const normalized = normalizeEntryIpa(originalRow.entry);
    const term = cleanTerm(normalized.term);
    const entry = term === normalized.term ? normalized : { ...normalized, term };
    const row = { ...originalRow, entry,
      ...(normalized !== originalRow.entry ? { ipaNormalized: true } : {}),
      ...(term !== originalRow.entry.term ? { originalTerm: originalRow.originalTerm ?? originalRow.entry.term } : {}),
    };
    const exact = row.suppliedId ? working.get(row.suppliedId) : undefined;
    const candidates = row.suppliedId ? [] : [...working.values()].filter(entry => canonical(entry.term) === canonical(row.entry.term));
    const target = exact ?? candidates.find(entry => entry.id === row.targetId) ?? candidates[0];
    if (row.action === 'skip') { planned.push({ row, candidates, target, mode: 'skipped' }); continue; }
    if (!term) { planned.push({ row, candidates, target, mode: 'invalid' }); continue; }
    if (exact) {
      const result = mergeImportedEntry(exact, row.entry, row.overwrite);
      working.set(result.id, result); changed.set(result.id, result);
      planned.push({ row, candidates, target: exact, mode: 'matched', result }); continue;
    }
    if (candidates.length && row.action === 'auto') { planned.push({ row, candidates, target, mode: 'unresolved' }); continue; }
    if (candidates.length && row.action === 'merge' && target) {
      const result = mergeImportedEntry(target, row.entry, row.overwrite);
      working.set(result.id, result); changed.set(result.id, result);
      planned.push({ row, candidates, target, mode: 'duplicate', result }); continue;
    }
    const result = { ...row.entry, revision: 0 };
    working.set(result.id, result); changed.set(result.id, result);
    planned.push({ row, candidates, target, mode: 'new', result });
  }
  const entries = [...changed.values()];
  return {
    rows: planned, entries,
    unresolved: planned.filter(item => item.mode === 'unresolved').length,
    added: entries.filter(entry => !existingIds.has(entry.id)).length,
    updated: entries.filter(entry => existingIds.has(entry.id)).length,
  };
}

export default function ImportPage({ snapshot, repository, refresh, notify }: WorkspaceProps) {
  const [source, setSource] = useState('');
  const [parsedSource, setParsedSource] = useState<string | null>(null);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [issues, setIssues] = useState<MarkdownIssue[]>([]);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const lock = useRef(false);
  const [editing, setEditing] = useState<{ key: string; entry: Entry } | null>(null);
  const [enrichmentScope, setEnrichmentScope] = useState<'missing' | 'all'>('missing');
  const drafts = enrichmentCandidates(snapshot.entries, enrichmentScope === 'all');
  const [selectedDraftIds, setSelectedDraftIds] = useState<Set<string>>(() => new Set(snapshot.entries.filter(entry => !isReady(entry)).map(entry => entry.id)));
  const [prompt, setPrompt] = useState('');
  const promptArea = useRef<HTMLTextAreaElement>(null);
  const plan = useMemo(() => buildImportPlan(rows, snapshot.entries), [rows, snapshot.entries]);
  const isStale = parsedSource !== null && source !== parsedSource;
  const selectedDrafts = drafts.filter(entry => selectedDraftIds.has(entry.id));
  const patchRow = (key: string, patch: Partial<ImportRow>) => setRows(current => current.map(row => row.key === key ? { ...row, ...patch } : row));

  function preview(text: string) {
    if (busy || reading) return;
    try {
      const result = parseMarkdown(text);
      setRows(result.entries.map(entry => ({
        key: entry.id, entry, line: result.metadata[entry.id]?.line ?? 1,
        suppliedId: result.metadata[entry.id]?.suppliedId, ipaNormalized: result.metadata[entry.id]?.ipaNormalized, originalTerm: result.metadata[entry.id]?.originalTerm, action: 'auto', overwrite: false,
      })));
      setIssues(result.issues); setParsedSource(text);
      if (!result.entries.length && !result.issues.length) notify('还没有识别到词条，请先输入一些英语。');
    } catch (error) { notify(errorMessage(error), 'error'); }
  }
  async function readFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file || busy || reading) return;
    if (file.size > 10_000_000) { notify('文件不能超过 10 MB，请分批导入。', 'error'); return; }
    setReading(true);
    try {
      const text = await file.text();
      const result = parseMarkdown(text);
      setSource(text); setParsedSource(text); setIssues(result.issues);
      setRows(result.entries.map(entry => ({ key: entry.id, entry, line: result.metadata[entry.id]?.line ?? 1, suppliedId: result.metadata[entry.id]?.suppliedId, ipaNormalized: result.metadata[entry.id]?.ipaNormalized, originalTerm: result.metadata[entry.id]?.originalTerm, action: 'auto', overwrite: false })));
    } catch (error) { notify(errorMessage(error), 'error'); }
    finally { setReading(false); }
  }
  async function commitImport() {
    if (lock.current || isStale || plan.unresolved || !plan.entries.length) return;
    lock.current = true; setBusy(true);
    try {
      await repository.saveEntries(plan.entries); await refresh();
      setSelectedDraftIds(current => new Set([...current, ...enrichmentCandidates(plan.entries).map(entry => entry.id)]));
      notify(`已新增 ${plan.added} 个词条，更新 ${plan.updated} 个词条。`, 'success');
      setRows([]); setIssues([]); setSource(''); setParsedSource(null);
    } catch (error) { notify(errorMessage(error), 'error'); }
    finally { lock.current = false; setBusy(false); }
  }
  function savePreview(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    const term = cleanTerm(editing.entry.term);
    if (!term) { notify('词头清理括号后为空，请填写目标英文。', 'error'); return; }
    const entry = normalizeEntryIpa({ ...editing.entry, term });
    const wordForms = pruneEmptyWordForms(entry.word_forms);
    if (wordForms) entry.word_forms = wordForms;
    else delete entry.word_forms;
    patchRow(editing.key, { entry, targetId: undefined, ...(term !== editing.entry.term ? { originalTerm: editing.entry.term } : {}), ...(entry.ipa_us !== editing.entry.ipa_us ? { ipaNormalized: true } : {}) });
    setEditing(null);
  }
  async function copyPrompt(text: string) {
    setPrompt(text);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(text); notify('提示词已复制，可粘贴到你现有的 ChatGPT 对话。', 'success');
    } catch {
      notify('提示词已生成，请在弹窗中选择文字并手动复制。');
      requestAnimationFrame(() => { promptArea.current?.focus(); promptArea.current?.select(); });
    }
  }
  function downloadTemplate() {
    downloadText('lexicon-template.md', buildMarkdownTemplate(), 'text/markdown;charset=utf-8');
  }

  return <section className="import-page">
    <div className="page-heading"><div><p className="eyebrow">A PLACE FOR NEW WORDS</p><h1>把偶然遇见，<br />变成日常积累。</h1><p className="muted">从 Markdown 或几行英语开始，整理好再收入词库。</p></div><button className="btn secondary" onClick={downloadTemplate}><Download size={16} /> 下载 Markdown 模板</button></div>
    <div className="import-layout">
      <div className="panel import-source"><div className="section-heading"><div><p className="eyebrow">01 / COLLECT</p><h2>放入你的英语素材</h2></div><FileText size={23} strokeWidth={1.4} /></div><label htmlFor="import-source" className="muted">支持标准 Markdown；也可以每行输入一个单词、短语或句子。</label><textarea id="import-source" className="source-textarea" rows={12} value={source} onChange={event => setSource(event.target.value)} disabled={busy || reading} placeholder={'serendipity\ntake something for granted\nIt never hurts to ask.\n\n或粘贴包含音标、释义和例句的 Markdown…'} spellCheck={false} /><div className="toolbar"><label className={`btn secondary file-button${busy || reading ? ' disabled' : ''}`}><Upload size={16} />{reading ? '读取中…' : '选择 Markdown 文件'}<input type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" onChange={event => void readFile(event)} disabled={busy || reading} aria-label="选择 Markdown 或文本文件" /></label><button className="btn primary" onClick={() => preview(source)} disabled={!source.trim() || busy || reading}>生成预览 <ArrowRight size={16} /></button></div><p className="muted form-hint">词头中的成对括号及内容会先清理，再参与重复匹配；预览不会写入词库。缺少音标或英文释义时保存为草稿。</p></div>
      <aside className="panel import-guide"><p className="eyebrow">YOUR OWN LEARNING MATERIAL</p><h2>一个词条，<br />一小段语境。</h2><ol className="steps"><li><span>1</span><div><strong>收集</strong><p>直接输入原文，或导入标准 Markdown。</p></div></li><li><span>2</span><div><strong>整理</strong><p>预览内容、处理重复词，按需补全释义。</p></div></li><li><span>3</span><div><strong>开始记忆</strong><p>完整词条进入学习；草稿留在词库等待补全。</p></div></li></ol><p className="muted">每个导出词条都带有 ID。让 ChatGPT 保留 ID，补全结果就能准确回到原词条。</p></aside>
    </div>
    {parsedSource !== null && <section className="panel import-preview"><div className="section-heading"><div><p className="eyebrow">02 / REVIEW</p><h2>确认后，再收入词库</h2><p className="muted">识别到 {rows.length} 条 · 预计新增 {plan.added} 条 · 更新 {plan.updated} 条</p></div></div>
      {issues.length > 0 && <div className="notice warning" role="status"><strong>有 {issues.length} 处内容需要留意</strong><ul>{issues.map((issue, index) => <li key={`${issue.line}-${index}`}>第 {issue.line} 行：{issue.message}</li>)}</ul><p>请检查后导入其余有效词条；修正原文后可以重新生成预览。</p></div>}
      {isStale && <p className="notice warning" role="status">原文已改变。请重新生成预览后再导入；重新生成会清除本次预览中的手动修改。</p>}
      {plan.rows.length ? <div className="import-preview-list">{plan.rows.map(item => {
        const { row } = item;
        const merging = item.mode === 'matched' || item.mode === 'duplicate';
        const duplicate = !row.suppliedId && item.candidates.length > 0;
        return <article className={`import-preview-row${row.action === 'skip' ? ' skipped' : ''}`} key={row.key}>
          <div className="preview-entry-heading"><label className="preview-select"><input type="checkbox" checked={row.action !== 'skip'} disabled={busy} onChange={event => patchRow(row.key, { action: event.target.checked ? 'auto' : 'skip' })} aria-label={`导入 ${row.entry.term}`} /><strong lang="en">{row.entry.term}</strong></label><div className="toolbar"><span className="tag">{typeLabels[row.entry.type]}</span><span className="tag">{isReady(item.result ?? row.entry) ? '可学习' : '草稿'}</span><button className="btn ghost" disabled={busy} onClick={() => setEditing({ key: row.key, entry: { ...row.entry, tags: [...row.entry.tags] } })}>编辑</button></div></div>
          <p className="muted">第 {row.line} 行 · <span className="ipa">{row.entry.ipa_us || '音标待补全'}</span></p><p className="preview-definition">{row.entry.definition_en || row.entry.meaning_zh || '英文释义待补全'}</p>
          {row.originalTerm && <p className="match-note">词头已由「{row.originalTerm}」清理为「{row.entry.term}」；使用清理后的英文匹配重复词条，原 ID 与已有学习进度保留。</p>}
          {item.mode === 'invalid' && <p className="notice warning">词头清理后为空，此条不会导入；请编辑目标英文。</p>}
          <WordForms forms={(item.result ?? row.entry).word_forms} />
          {row.ipaNormalized && <p className="match-note">音标写法已整理：ɹ → r，并清理隐藏字符；这不代表读音已经核验。</p>}
          {needsIpaNotationReview(row.entry.ipa_us) && <p className="match-note">含 ᵻ / ɐ / ɾ 等特殊转写，需要按具体单词核对为常见美式词典记法；未自动替换。</p>}
          {row.suppliedId && <p className="match-note">{item.target ? '已通过 ID 匹配词库中的原词条。' : '这是尚未收入词库的有效 ID，将新增词条。'}</p>}
          {duplicate && <div className="duplicate-choice"><label className="field"><span>发现同名词条，选择处理方式</span><select value={row.action} disabled={busy} onChange={event => patchRow(row.key, { action: event.target.value as ImportRow['action'] })}><option value="auto">请选择处理方式</option><option value="merge">合并到已有词条</option><option value="separate">作为独立词条保存</option><option value="skip">跳过此条</option></select></label>{row.action === 'merge' && <label className="field"><span>合并目标</span><select value={item.target?.id ?? ''} disabled={busy} onChange={event => patchRow(row.key, { targetId: event.target.value })}>{item.candidates.map(target => <option key={target.id} value={target.id}>{target.term} · {typeLabels[target.type]} · {target.meaning_zh || target.definition_en || target.id.slice(0, 8)}</option>)}</select></label>}</div>}
          {merging && <div className="merge-options"><p className="muted">默认逐项补空白字段和词形，未提供的词形不会清空；原词条的收藏、暂停与学习进度会保留。如需更新「待确认」等占位内容，请勾选下方替换选项。</p><label><input type="checkbox" checked={row.overwrite} disabled={busy} onChange={event => patchRow(row.key, { overwrite: event.target.checked })} /> 允许导入的非空内容替换已有字段（含原文、类型和笔记）</label></div>}
        </article>;
      })}</div> : <div className="empty-state"><p>没有可导入的词条。请检查原文和提示。</p></div>}
      <div className="import-commit"><p className="muted">{plan.unresolved ? `还有 ${plan.unresolved} 条同名词条需要选择处理方式。` : '保存词条时，会保留已有卡片的复习进度。'}</p><button className="btn primary" disabled={busy || reading || isStale || plan.unresolved > 0 || !plan.entries.length} onClick={() => void commitImport()}>{busy ? '正在导入…' : <><Plus size={17} /> 确认导入 {plan.entries.length} 个词条</>}</button></div>
    </section>}
    <section className="panel enrichment-panel">
      <div className="section-heading"><div><p className="eyebrow">03 / ENRICH</p><h2>交给你的 ChatGPT，补全学习材料</h2><p className="muted">草稿和已可学习的词条都能补充词形、比较等级与派生词。选择条目，复制提示词；把返回的 Markdown 粘贴到上方预览。</p></div><Sparkles size={25} strokeWidth={1.4} /></div>
      <label className="field"><span>补全范围</span><select value={enrichmentScope} onChange={event => setEnrichmentScope(event.target.value as 'missing' | 'all')}><option value="missing">待补释义、音标或词形</option><option value="all">全部词条（可补充派生词）</option></select></label>
      {drafts.length ? <>
        <div className="toolbar"><button className="btn ghost" onClick={() => setSelectedDraftIds(new Set(drafts.map(entry => entry.id)))}>全选</button><button className="btn ghost" onClick={() => setSelectedDraftIds(new Set())}>清空选择</button><span className="muted">已选 {selectedDrafts.length} / {drafts.length} 个词条</span></div>
        <div className="draft-selection">{drafts.map(entry => <label className="draft-item" key={entry.id}>
          <input type="checkbox" checked={selectedDraftIds.has(entry.id)} onChange={event => setSelectedDraftIds(current => { const next = new Set(current); if (event.target.checked) next.add(entry.id); else next.delete(entry.id); return next; })} />
          <span><strong lang="en">{entry.term}</strong><small className="muted">{[!entry.ipa_us.trim() && '缺音标', !entry.definition_en.trim() && '缺英文释义', needsWordForms(entry) && '词形待补全'].filter(Boolean).join(' · ') || (isReady(entry) ? '可补充或核对派生词' : '内容待确认')}</small></span>
        </label>)}</div>
        <button className="btn primary" disabled={!selectedDrafts.length} onClick={() => void copyPrompt(buildEnrichmentPrompt(selectedDrafts))}><Clipboard size={16} /> 生成并复制补全提示词</button>
      </> : <div className="empty-state compact"><Check size={25} /><p>当前范围没有待补全词条。</p><p className="muted">切换到全部词条，可以继续补充派生词或核对已有材料。</p></div>}
    </section>
    {editing && <Modal title="编辑导入预览" wide onClose={() => setEditing(null)}><form onSubmit={savePreview}><EntryEditor key={editing.key} entry={editing.entry} onChange={entry => setEditing(current => current ? { ...current, entry } : null)} showPreferences={false} /><div className="modal-actions"><button type="button" className="btn secondary" onClick={() => setEditing(null)}>取消</button><button className="btn primary" disabled={!editing.entry.term.trim()}>保存到预览</button></div></form></Modal>}
    {prompt && <Modal title="复制到 ChatGPT" wide onClose={() => setPrompt('')}><p className="muted">将下面内容粘贴到 ChatGPT。收到回复后，复制完整 Markdown 回到本页导入。</p><label className="field"><span>完整补全提示词</span><textarea ref={promptArea} className="source-textarea prompt-textarea" rows={13} value={prompt} readOnly onFocus={event => event.target.select()} /></label><div className="modal-actions"><button className="btn secondary" onClick={() => { promptArea.current?.focus(); promptArea.current?.select(); }}>全选文本</button><button className="btn primary" onClick={() => void copyPrompt(prompt)}><Clipboard size={16} /> 复制提示词</button></div></Modal>}
  </section>;
}
