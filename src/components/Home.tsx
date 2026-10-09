import { ArrowRight, BookOpen, Clock3, Leaf, Plus, Sprout, Sunrise } from 'lucide-react';
import { eligibleCards, isReady, learningDay } from '../lib/domain';
import type { Snapshot } from '../types';

export default function Home({ snapshot, navigate }: { snapshot: Snapshot; navigate: (page: string) => void }) {
  const today = learningDay(new Date(), snapshot.settings.timezone);
  const due = eligibleCards(snapshot);
  const ready = snapshot.entries.filter(e => isReady(e) && !e.suspended);
  const learnedIds = new Set(snapshot.cards.filter(c => c.kind === 'recognition' && c.state.reps > 0).map(c => c.entry_id));
  const available = ready.filter(e => !learnedIds.has(e.id));
  const firstEvents = snapshot.reviews.filter(r => !r.undone && r.before.kind === 'recognition' && r.before.state.reps === 0 && learningDay(r.reviewed_at, snapshot.settings.timezone) === today);
  const todayNew = new Set(firstEvents.map(r => r.entry_id)).size;
  const todayReviews = snapshot.reviews.filter(r => !r.undone && learningDay(r.reviewed_at, snapshot.settings.timezone) === today).length;
  const active = snapshot.batches.find(b => !b.completed_at && b.entry_ids.length > b.completed_ids.length);
  const recent = [...snapshot.entries].sort((a,b) => Number(b.favorite)-Number(a.favorite) || b.created_at.localeCompare(a.created_at)).slice(0, 3);
  const date = new Intl.DateTimeFormat('zh-CN', { timeZone: snapshot.settings.timezone, month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
  return <div className="home-page page-enter">
    <div className="home-date"><Sunrise size={17}/><span>{date}</span><span className="date-line"/></div>
    <section className="home-hero">
      <div className="hero-copy"><p className="eyebrow">A LITTLE, EVERY DAY</p><h1>让每次遇见，<br/>都多一分<span>理解。</span></h1><p className="hero-description">从一个词，到一种表达。<br/>每天留一点时间，让英文慢慢成为自己的语言。</p><div className="hero-caption"><span className="tiny-dot"/> 按自己的节奏，慢慢积累</div></div>
      <div className="word-art" aria-label="英文词卡示意"><div className="art-orbit"/><div className="art-leaf one"><Leaf/></div><div className="art-leaf two"><Sprout/></div><div className="art-card back"><span>one word at a time.</span></div><div className="art-card front"><span className="art-index">A WORD TO KEEP</span><div className="art-word">serendipity<span>n.</span></div><p className="ipa">/ˌserənˈdɪpəti/</p><div className="art-rule"/><p>The quiet joy of finding<br/>something unexpected.</p><span className="art-footer">偶然相遇，也可以慢慢记住。 <Leaf size={15}/></span></div><span className="art-note">Small steps. Lasting words.</span></div>
    </section>
    <section className="daily-actions">
      <div className="action-card review-action"><div className="action-top"><span className="action-icon"><Clock3 size={22}/></span><span className="pill light">先温故，再知新</span></div><div className="action-heading"><h2>今日复习</h2><span className="action-count">{due.length}<small>张待复习</small></span></div><p>在快要忘记的时候，再见一面。</p><button className="btn cream wide" onClick={() => navigate('study-review')}>{due.length ? '开始复习' : '查看复习安排'}<ArrowRight size={18}/></button></div>
      <div className="action-card new-action"><div className="action-top"><span className="action-icon"><BookOpen size={22}/></span><span className="pill">每批 {snapshot.settings.batch_size} 个 · 不限批次</span></div><div className="action-heading"><h2>{active ? '接着上次学' : '认识新词'}</h2><span className="action-count">{active ? active.entry_ids.length-active.completed_ids.length : Math.min(snapshot.settings.batch_size, available.length)}<small>{active ? '个待完成' : '个一小步'}</small></span></div><p>{active ? `本批已完成 ${active.completed_ids.length} / ${active.entry_ids.length}，随时接着来。` : '看英文，想一想它的中文或英文意思。'}</p><button className="btn primary wide" onClick={() => navigate(available.length || active ? 'study-new' : 'import')}>{active ? '继续本批学习' : available.length ? '开始学习新词' : '添加你的第一个词'}<ArrowRight size={18}/></button></div>
    </section>
    <section className="today-metrics" aria-label="学习概况"><div><span>今日初学</span><strong>{todayNew}<small>个词条</small></strong></div><div><span>今日练习</span><strong>{todayReviews}<small>次回忆</small></strong></div><div><span>我的词库</span><strong>{snapshot.entries.length}<small>个表达</small></strong></div><p><Sprout size={25}/><span>不必一次记住很多，<br/>每次多理解一点就好。</span></p></section>
    <section className="home-library"><div className="section-heading"><div><p className="eyebrow">YOUR COLLECTION</p><h2>在你的词间</h2></div><button className="text-link" onClick={() => navigate('library')}>查看词库 <ArrowRight size={16}/></button></div>{recent.length ? <div className="mini-entries">{recent.map(e => <button className="mini-entry" key={e.id} onClick={() => navigate('library')}><span className="mini-type">{e.type === 'word' ? 'WORD' : e.type === 'sentence' ? 'SENTENCE' : 'EXPRESSION'}</span><h3>{e.term}</h3><p className="ipa">{e.ipa_us || '音标待补全'}</p><p className="mini-definition">{e.definition_en || '等待你为它添上一个解释。'}</p><span className="mini-bottom">{e.tags[0] || '我的收藏'} <ArrowRight size={15}/></span></button>)}</div> : <div className="empty-state inline-empty"><BookOpen size={30}/><div><h3>这间词汇书房，等待你的第一本笔记。</h3><p>输入英文、导入 Markdown，或把阅读中遇到的表达先收集起来。</p></div><button className="btn secondary" onClick={() => navigate('import')}><Plus size={16}/>添加词条</button></div>}</section>
    <footer className="page-footer">词间 LEXICON <span>理解一点，留住一点。</span></footer>
  </div>;
}
