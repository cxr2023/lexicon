import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, CheckCircle2, Clock3, Eye, LoaderCircle, Pause, RotateCcw, Trash2 } from 'lucide-react';
import { eligibleCards, isCardEnabled, isReady, previewIntervals, schedule } from '../lib/domain';
import type { RatingValue, ReviewInput, StudyCard, WorkspaceProps } from '../types';

const ratingLabels: Record<RatingValue, [string, string]> = {
  1: ['忘了', '没有想起或含义不对'], 2: ['费力想起', '答对了，但很费力'],
  3: ['记得', '正常回忆出含义'], 4: ['很轻松', '立即、准确地想起'],
};
interface PendingAnswer { input: ReviewInput; committed: boolean }
function readPending(key: string): PendingAnswer | null {
  try {
    const stored = JSON.parse(localStorage.getItem(key) || 'null');
    const value = stored?.input || stored;
    return value?.operation_id && value?.card_id && value?.next_state && [1, 2, 3, 4].includes(value.rating)
      ? { input: value, committed: Boolean(stored?.committed) } : null;
  } catch { return null; }
}
const errorText = (error: unknown) => error instanceof Error ? error.message : '暂时无法完成操作，请重试。';
const terminalReviewError = /冲突|已删除|版本|不存在|进度已|已修改|已更新|已暂停|尚未补全|题型已关闭|提交编号已使用|评分.*无效|调度.*无效|CONFLICT|NOT_FOUND|DELETED|STALE/i;

export default function Study({ snapshot, repository, refresh, notify, mode, navigate, pendingKey }: WorkspaceProps & { mode: 'new' | 'review'; navigate: (page: string) => void; pendingKey: string }) {
  const [batchId, setBatchId] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(mode === 'review');
  const [initialError, setInitialError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [showChinese, setShowChinese] = useState(!snapshot.settings.hide_chinese);
  const [answer, setAnswer] = useState('');
  const [inputEnabled, setInputEnabled] = useState(false);
  const [active, setActive] = useState<{ id: string; revision: number; entryRevision: number } | null>(null);
  const [reviewCount, setReviewCount] = useState(0);
  const [pendingRecord, setPendingRecord] = useState<PendingAnswer | null>(() => readPending(pendingKey));
  const pending = pendingRecord?.input ?? null;
  const [pendingError, setPendingError] = useState('');
  const [syncError, setSyncError] = useState('');
  const [clock, setClock] = useState(Date.now());
  const busyRef = useRef(false);
  const confirmedOperations = useRef(new Set<string>());
  const autoStarted = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const beginBatch = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setInitialized(false); setInitialError('');
    try {
      const batch = await repository.startBatch();
      if (!mounted.current) return;
      setBatchId(batch?.id ?? null);
      await refresh();
      if (!mounted.current) return;
      setActive(null); setRevealed(false); setReviewCount(0); setClock(Date.now()); setInitialized(true);
    } catch (error) { if (mounted.current) setInitialError(errorText(error)); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }, [repository, refresh]);
  useEffect(() => {
    if (mode === 'new' && !pending && !autoStarted.current) {
      autoStarted.current = true; void beginBatch();
    }
  }, [mode, pending, beginBatch]);
  useEffect(() => { const timer = window.setInterval(() => setClock(Date.now()), 15000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (mode !== 'new' || !initialized || busy || pending || !batchId || snapshot.batches.some(batch => batch.id === batchId)) return;
    // Undo/restore on another device can remove the currently displayed batch.
    setBatchId(snapshot.batches.find(batch => !batch.completed_at)?.id ?? null);
  }, [mode, initialized, busy, pending, batchId, snapshot.batches]);

  const batch = snapshot.batches.find(b => b.id === batchId);
  const batchRemaining = batch?.entry_ids.filter(id => !batch.completed_ids.includes(id)) ?? [];
  const batchComplete = mode === 'new' && initialized && !initialError && batchRemaining.length === 0;
  const due = useMemo(() => eligibleCards(snapshot, new Date(clock)), [snapshot, clock]);
  const queue: StudyCard[] = mode === 'review' ? due : batchRemaining.length ? [
    ...due.filter(c => c.state.state === 1 || c.state.state === 3),
    ...batchRemaining.flatMap(id => snapshot.cards.filter(c => c.entry_id === id && c.kind === 'recognition' && c.state.reps === 0 &&
      (!c.bury_until || Date.parse(c.bury_until) <= clock) && snapshot.entries.some(e => e.id === id && !e.suspended && isReady(e)))),
  ] : [];
  useEffect(() => {
    if (pending) {
      if (active?.id !== pending.card_id || active.revision !== pending.expected_revision) setActive({ id: pending.card_id, revision: pending.expected_revision, entryRevision: -1 });
      setRevealed(true); return;
    }
    if (busy || syncError || !initialized) return;
    if (active) {
      if (!queue.some(card => card.id === active.id && card.revision === active.revision && snapshot.entries.some(entry => entry.id === card.entry_id && entry.revision === active.entryRevision))) {
        setActive(null); setRevealed(false); setAnswer('');
      }
      return;
    }
    if (queue[0] && !(mode === 'review' && reviewCount >= 20) && !batchComplete) {
      setActive({ id: queue[0].id, revision: queue[0].revision, entryRevision: snapshot.entries.find(entry => entry.id === queue[0].entry_id)?.revision ?? -1 });
      setRevealed(false); setShowChinese(!snapshot.settings.hide_chinese); setAnswer('');
    }
  }, [snapshot, clock, active, pending, busy, syncError, initialized, queue[0]?.id, mode, reviewCount, batchComplete]);
  const card = snapshot.cards.find(c => c.id === (pending?.card_id || active?.id));
  const entry = snapshot.entries.find(e => e.id === card?.entry_id);
  const clearPending = useCallback((operationId: string) => {
    try { if (readPending(pendingKey)?.input.operation_id === operationId) localStorage.removeItem(pendingKey); } catch { /* A confirmed score is still committed if storage was disabled mid-session. */ }
    setPendingRecord(null); setPendingError('');
  }, [pendingKey]);
  const sendReview = useCallback(async (input: ReviewInput) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setPendingError('');
    const stored = readPending(pendingKey);
    let committed = confirmedOperations.current.has(input.operation_id) || (stored?.input.operation_id === input.operation_id && stored.committed);
    try {
      if (!committed) {
        try {
          if (repository.mode === 'cloud' && !navigator.onLine) throw new Error('当前离线。答案已暂存，联网后将重新提交。');
          await repository.submitReview(input);
          committed = true; confirmedOperations.current.add(input.operation_id);
          try { localStorage.setItem(pendingKey, JSON.stringify({ input, committed: true })); } catch { /* Replaying the original operation ID after reload is idempotent. */ }
          if (mounted.current) setPendingRecord({ input, committed: true });
        } catch (error) {
          const message = errorText(error);
          if (terminalReviewError.test(message)) {
            clearPending(input.operation_id); setActive(null); setRevealed(false);
            notify(message, 'error');
            try { await refresh(); } catch (refreshError) { setSyncError(errorText(refreshError)); }
          } else if (mounted.current) setPendingError(message);
          return;
        }
      }
      // A successful commit and an unsuccessful reload are separate states. Never rescore just to refresh.
      try {
        await refresh();
        if (!mounted.current) return;
        clearPending(input.operation_id); setActive(null); setRevealed(false); setAnswer('');
        setReviewCount(count => count + 1); setClock(Date.now());
      } catch (error) {
        if (mounted.current) setPendingError(`评分已保存；更新学习进度失败：${errorText(error)}。请刷新进度后继续。`);
      }
    } finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }, [repository, pendingKey, clearPending, refresh, notify]);
  const retryRef = useRef(sendReview); retryRef.current = sendReview;
  useEffect(() => {
    const retry = () => { const saved = readPending(pendingKey); if (saved) void retryRef.current(saved.input); };
    window.addEventListener('online', retry);
    if (readPending(pendingKey) && navigator.onLine) retry();
    return () => window.removeEventListener('online', retry);
  }, [pendingKey]);
  const rate = useCallback((rating: RatingValue) => {
    if (!card || !revealed || busyRef.current || pending || syncError) return;
    const otherPending = readPending(pendingKey);
    if (otherPending) {
      setPendingRecord(otherPending); setPendingError('检测到尚待确认的答案，请先处理它再继续。'); return;
    }
    try {
      const now = new Date(Math.max(Date.now(), Date.parse(card.state.last_review || '') || 0));
      const input: ReviewInput = { operation_id: crypto.randomUUID(), card_id: card.id, expected_revision: active?.revision ?? card.revision,
        reviewed_at: now.toISOString(), rating, next_state: schedule(card, rating, snapshot.settings, now) };
      localStorage.setItem(pendingKey, JSON.stringify({ input, committed: false }));
      setPendingRecord({ input, committed: false }); void sendReview(input);
    } catch (error) { notify(`未能暂存答案：${errorText(error)}`, 'error'); }
  }, [card, active, revealed, pending, syncError, snapshot.settings, pendingKey, sendReview, notify]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && /INPUT|TEXTAREA|SELECT|BUTTON/.test(e.target.tagName)) return;
      if (busy || pending || !card || syncError) return;
      if (e.code === 'Space') { e.preventDefault(); if (!revealed) setRevealed(true); }
      if (revealed && /^[1-4]$/.test(e.key)) { e.preventDefault(); rate(Number(e.key) as RatingValue); }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [rate, revealed, busy, pending, card, syncError]);
  const applyChange = async (action: () => Promise<void>, success: string, after?: () => void) => {
    if (busyRef.current || pending) return;
    busyRef.current = true; setBusy(true);
    try {
      await action(); setActive(null); setRevealed(false); after?.(); notify(success);
      try { await refresh(); setClock(Date.now()); } catch (error) { setSyncError(errorText(error)); }
    } catch (error) {
      notify(errorText(error), 'error');
      try { await refresh(); } catch (refreshError) { setSyncError(errorText(refreshError)); }
    } finally { busyRef.current = false; setBusy(false); }
  };
  const remove = async () => {
    if (!entry || busyRef.current || pending || !window.confirm(`永久删除「${entry.term}」？\n\n这将删除该词条、所有练习卡和复习记录。删除后无法撤销，也不会再复习。`)) return;
    await applyChange(() => repository.deleteEntry(entry.id, entry.revision), '词条及其学习记录已永久删除。');
  };
  const pause = async () => {
    if (!entry) return;
    await applyChange(() => repository.saveEntries([{ ...entry, suspended: true }]), '已暂停这个词条，可在词库中恢复。');
  };
  // The repository defines latest by transaction order, not by potentially different device clocks.
  const lastReview = [...snapshot.reviews].reverse().find(review => !review.undone);
  const undo = async () => {
    if (!lastReview) return;
    await applyChange(() => repository.undoReview(lastReview.id), '已撤销上一条评分。', () => setReviewCount(count => Math.max(0, count - 1)));
  };
  const retryRefresh = async () => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try { await refresh(); setSyncError(''); setActive(null); setClock(Date.now()); }
    catch (error) { setSyncError(errorText(error)); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const nextNewCount = snapshot.cards.filter(c => c.kind === 'recognition' && c.state.reps === 0 && snapshot.entries.some(e => e.id === c.entry_id && !e.suspended && isReady(e))).length;
  const complete = !pending && initialized && !syncError && (batchComplete || (mode === 'review' && (reviewCount >= 20 || (!card && !queue.length))));
  const previewResult = useMemo(() => {
    if (!card) return { items: [], error: '' };
    try { return { items: previewIntervals(card, snapshot.settings, new Date(Math.max(clock, Date.now(), Date.parse(card.state.last_review || '') || 0))), error: '' }; }
    catch (error) { return { items: [], error: errorText(error) }; }
  }, [card, snapshot.settings, clock]);
  const preview = previewResult.items;
  const clozeText = entry?.example.replace(/\{\{.*?\}\}/g, '________') ?? '';
  const expected = card?.kind === 'cloze' ? [...(entry?.example || '').matchAll(/\{\{(.*?)\}\}/g)].map(m => m[1]).join(' / ') : entry?.term;
  const nextDue = snapshot.cards.filter(c => c.state.reps > 0 && snapshot.entries.some(e => e.id === c.entry_id && !e.suspended && isReady(e) && isCardEnabled(c, e, snapshot.settings)))
    .map(c => Math.max(Date.parse(c.state.due), Date.parse(c.bury_until || '') || 0)).filter(time => time > clock).sort((a,b) => a-b)[0];

  return <div className="study-page page-enter">
    <div className="study-toolbar"><button className="text-link" onClick={() => navigate('today')}><ArrowLeft size={16}/> 返回今日学习</button><button className="text-link" disabled={!lastReview || busy || !!pending} onClick={undo}><RotateCcw size={15}/> 撤销上次评分</button></div>
    <div className="study-heading"><p className="eyebrow">{mode === 'new' ? 'ONE SMALL BATCH' : 'A MOMENT TO REMEMBER'}</p><h1>{mode === 'new' ? '认识新词' : '温故，知新。'}</h1><p>{mode === 'new' ? `本批初学 ${batch?.completed_ids.length ?? 0} / ${batch?.entry_ids.length ?? 0}` : `本组已完成 ${reviewCount} / 20 次回忆`}</p></div>
    <div className="study-progress"><span style={{ width: `${mode === 'new' ? (batch?.completed_ids.length ?? 0) / (batch?.entry_ids.length || 1) * 100 : Math.min(reviewCount,20)/20*100}%` }}/></div>
    {syncError ? <section className="empty-state panel" role="alert"><h3>需要更新学习进度</h3><p>{syncError}</p><p>已完成的操作不会重复执行，更新进度后即可继续。</p><button className="btn primary" disabled={busy} onClick={retryRefresh}>重新加载进度</button></section> : !initialized && !pending ? <div className="empty-state">{initialError ? <><p role="alert">{initialError}</p><button className="btn secondary" disabled={busy} onClick={beginBatch}>重新准备词条</button></> : <><LoaderCircle className="spin"/><p>正在准备本批词条…</p></>}</div> : complete ? <section className="study-complete panel"><span className="completion-icon"><CheckCircle2 size={42}/></span><p className="eyebrow">WELL SPENT, WELL REMEMBERED</p><h2>{mode === 'new' ? batch ? '这一小步，完成了。' : '新词已全部学完' : reviewCount >= 20 ? '本组练习完成了。' : '暂时没有到期的复习'}</h2><p>{mode === 'new' && batch ? `本批 ${batch.entry_ids.length} 个词条已完成初学，后续复习会按时安排。` : '留一点空间，给记忆慢慢生根。'}</p>{nextDue && <p className="muted">下次复习：{new Date(nextDue).toLocaleString('zh-CN', {timeZone: snapshot.settings.timezone, month:'short', day:'numeric', hour:'2-digit',minute:'2-digit'})}</p>}<div className="completion-actions">{mode === 'new' && nextNewCount > 0 && <button className="btn primary" onClick={beginBatch} disabled={busy}>继续学习{nextNewCount < snapshot.settings.batch_size ? `剩余 ${nextNewCount} 个` : `下 ${snapshot.settings.batch_size} 个`}<ArrowRight size={17}/></button>}{mode === 'review' && due.length > 0 && <button className="btn primary" onClick={() => {setReviewCount(0);setActive(null);setClock(Date.now());}}>继续复习下一组<ArrowRight size={17}/></button>}<button className="btn secondary" onClick={() => mode === 'new' ? navigate('study-review') : navigate(nextNewCount ? 'study-new' : 'import')}>{mode === 'new' ? '去复习' : nextNewCount ? '学习新词' : '添加更多词条'}</button><button className="btn ghost" onClick={() => navigate('today')}>结束本次学习</button></div></section> : card && entry ? <>
      <article className="flashcard panel"><div className="flashcard-meta"><span className="tag">{card.kind === 'recognition' ? '英 → 义 · 理解' : card.kind === 'production' ? '中 → 英 · 表达' : '语境填空'}</span><span className="muted">{card.state.reps ? '再次相遇' : '初次相识'}</span></div><div className="flashcard-question"><h2 className={card.kind === 'recognition' ? 'english-term' : 'question-text'}>{card.kind === 'recognition' ? entry.term : card.kind === 'production' ? entry.meaning_zh : clozeText}</h2>{card.kind === 'recognition' && <p className="ipa big-ipa">{entry.ipa_us}<span>美式</span></p>}<p className="recall-hint">{card.kind === 'recognition' ? '想一想它的意思，用中文或英文解释都可以。' : '先回忆目标表达，再对照参考答案。'}</p></div>
      {inputEnabled && <label className="field answer-input"><span>我的回答（仅辅助回忆，不自动判分）</span><textarea rows={2} value={answer} onChange={e => setAnswer(e.target.value)} placeholder="把想到的意思或表达写下来…" disabled={busy || !!pending}/></label>}
      {!revealed ? <div className="reveal-area"><button className="btn primary reveal-button" onClick={() => setRevealed(true)}><Eye size={18}/>显示答案<span className="keycap">空格</span></button><button className="text-link" onClick={() => setInputEnabled(v => !v)}>{inputEnabled ? '收起输入框' : '想写下来？打开输入框'}</button></div> : <div className="flashcard-answer" aria-live="polite">{card.kind !== 'recognition' && <div className="answer-term"><h3>{entry.term}</h3><p className="ipa">{entry.ipa_us}</p></div>}<span className="eyebrow">MEANING IN ENGLISH</span><p className="english-definition">{entry.definition_en}</p>{entry.meaning_zh && <div className="chinese-answer">{showChinese ? <p>{entry.meaning_zh}</p> : <button className="text-link" onClick={() => setShowChinese(true)}>展开中文释义</button>}</div>}{entry.example && <blockquote><p>{entry.example.replace(/\{\{|\}\}/g, '')}</p>{entry.example_translation && showChinese && <small>{entry.example_translation}</small>}</blockquote>}{entry.usage && <p className="usage-note">{entry.usage}</p>}{inputEnabled && answer && <div className="answer-comparison"><span>你的回答：{answer}</span>{card.kind !== 'recognition' && <span>参考表达：{expected}</span>}<small>{card.kind !== 'recognition' && answer.trim().toLowerCase() === expected?.trim().toLowerCase() ? '文字一致。仍请按实际回忆难度评分。' : '表达不必逐字相同，请自行判断含义是否准确。'}</small></div>}</div>}</article>
      {previewResult.error && <p className="error-message" role="alert">无法计算复习时间：{previewResult.error}</p>}
      {revealed && !pending && <div className="rating-grid">{preview.map(item => <button className={`rating-button rating-${item.rating}`} key={item.rating} onClick={() => rate(item.rating)} disabled={busy}><span className="rating-key">{item.rating}</span><strong>{ratingLabels[item.rating][0]}</strong><small>{ratingLabels[item.rating][1]}</small><span className="rating-interval">{item.label}</span></button>)}</div>}
      <div className="study-bottom"><span><Clock3 size={14}/> 先回忆，再揭晓。诚实评分就好。</span><div><button className="text-link" disabled={busy || !!pending} onClick={pause}><Pause size={14}/>暂停</button><button className="text-link danger-text" disabled={busy || !!pending} onClick={remove}><Trash2 size={14}/>永久删除</button></div></div>
    </> : <div className="empty-state panel"><Check size={30}/><h3>当前没有可练习的词条</h3><p>本批中的词条可能已暂停或正在其他设备更新。</p><button className="btn secondary" onClick={() => navigate('library')}>查看词库</button></div>}
    {pending && <div className="pending-answer" role="status">{busy ? <LoaderCircle className="spin" size={18}/> : <Clock3 size={18}/>}<div><strong>{pendingRecord?.committed ? '评分已保存，正在更新进度' : busy ? '正在确认保存…' : '答案已暂存，等待确认'}</strong><p>{pendingError || (pendingRecord?.committed ? '已确认保存；刷新完成后会继续下一题。' : '确认保存后才会继续，重试不会重复计分。')}</p></div><button className="btn secondary" disabled={busy} onClick={() => sendReview(pending)}>{pendingRecord?.committed ? '刷新进度' : '重新提交'}</button></div>}
  </div>;
}
