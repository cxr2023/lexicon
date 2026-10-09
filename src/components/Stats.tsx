import { CalendarDays, CheckCircle2, Layers3, TrendingUp } from 'lucide-react';
import { isReady, learningDay } from '../lib/domain';
import type { Snapshot } from '../types';

export default function Stats({ snapshot }: { snapshot: Snapshot }) {
  const reviews = snapshot.reviews.filter(r => !r.undone);
  const recognition = reviews.filter(r => r.before.kind === 'recognition');
  const reviewed = recognition.filter(r => r.before.state.reps > 0);
  const success = reviewed.length ? Math.round(reviewed.filter(r => r.rating > 1).length/reviewed.length*100) : null;
  const days = new Set(reviews.map(r => learningDay(r.reviewed_at, snapshot.settings.timezone)));
  const learned = new Set(snapshot.cards.filter(c => c.kind === 'recognition' && c.state.reps > 0).map(c => c.entry_id));
  const today = learningDay(new Date(), snapshot.settings.timezone);
  const series = Array.from({length:14}, (_,i) => {
    const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate()-(13-i));
    const day = d.toISOString().slice(0,10);
    return { day, count: reviews.filter(r => learningDay(r.reviewed_at, snapshot.settings.timezone) === day).length };
  });
  const max = Math.max(5,...series.map(s=>s.count));
  const hard = snapshot.cards.filter(c=>c.kind==='recognition' && c.state.lapses>0).sort((a,b)=>b.state.lapses-a.state.lapses).slice(0,5);
  const stats = [
    { label:'已认识的词条', value:learned.size, unit:'个', icon:Layers3 },
    { label:'累计回忆', value:reviews.length, unit:'次', icon:TrendingUp },
    { label:'自评通过率', value:success === null ? '—' : success, unit:success === null ? '' : '%', icon:CheckCircle2 },
    { label:'学习过的日子', value:days.size, unit:'天', icon:CalendarDays },
  ];
  return <div className="page-enter"><header className="page-heading"><p className="eyebrow">GROWTH, IN LITTLE MOMENTS</p><h1>看见你的积累</h1><p>每一次回忆，都是理解留下的痕迹。</p></header><div className="stats-grid">{stats.map(s=><div className="stat-panel panel" key={s.label}><s.icon size={21}/><p>{s.label}</p><strong>{s.value}<small>{s.unit}</small></strong></div>)}</div><section className="panel activity-panel"><div className="section-heading"><div><h2>最近两周</h2><p className="muted">每天的有效回忆次数</p></div><span className="tag">过去 14 天</span></div><div className="activity-chart" role="img" aria-label={series.map(s=>`${s.day}: ${s.count} 次`).join('；')}>{series.map(s=><div className="chart-column" key={s.day}><span className="bar-count">{s.count || ''}</span><div className="bar-track"><div className={`bar ${s.day===today?'today':''}`} style={{height:`${Math.max(2,s.count/max*100)}%`}}/></div><span>{s.day.slice(5).replace('-','/')}</span></div>)}</div></section><div className="stats-bottom"><section className="panel"><p className="eyebrow">YOUR VOCABULARY</p><h2>词库概况</h2><dl className="stat-list"><div><dt>已具备音标与英文释义</dt><dd>{snapshot.entries.filter(isReady).length}</dd></div><div><dt>等待补全</dt><dd>{snapshot.entries.filter(e=>!isReady(e)).length}</dd></div><div><dt>已暂停学习</dt><dd>{snapshot.entries.filter(e=>e.suspended).length}</dd></div><div><dt>收藏的表达</dt><dd>{snapshot.entries.filter(e=>e.favorite).length}</dd></div></dl></section><section className="panel"><p className="eyebrow">A LITTLE MORE ATTENTION</p><h2>值得再看一眼</h2>{hard.length ? <div className="hard-words">{hard.map(c=>{const e=snapshot.entries.find(x=>x.id===c.entry_id);return <div key={c.id}><span>{e?.term}</span><small>遗忘 {c.state.lapses} 次</small></div>;})}</div> : <p className="muted empty-note">还没有反复遗忘的词条。随着复习积累，这里会帮你找出需要多关注的表达。</p>}</section></div><p className="stats-footnote">通过率仅统计已学理解卡的复习，评分为「费力想起 / 记得 / 很轻松」视为通过。已撤销及已永久删除的记录不计入统计。</p></div>;
}
