import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { ArrowRight, BarChart3, BookOpen, Check, ChevronRight, Cloud, Flower2, Home as HomeIcon, Import, LoaderCircle, LogOut, Settings2, WifiOff, X } from 'lucide-react';
import { createCloudRepository, createDemoRepository, supabase } from './lib/repository';
import { emptySnapshot } from './lib/domain';
import { sampleEntries } from './data/sample';
import Home from './components/Home';
import Library from './components/Library';
import ImportPage from './components/ImportPage';
import Stats from './components/Stats';
import SettingsPage from './components/SettingsPage';
import Study from './components/Study';
import type { Repository, Snapshot } from './types';

const navigation = [
  {id:'today',label:'今日学习',icon:HomeIcon}, {id:'library',label:'我的词库',icon:BookOpen},
  {id:'import',label:'导入与补全',icon:Import}, {id:'stats',label:'学习统计',icon:BarChart3},
  {id:'settings',label:'设置',icon:Settings2},
];
function currentPage() { const hash = location.hash.replace(/^#\/?/,'').split('?')[0]; return ['today','library','import','stats','settings','study-new','study-review'].includes(hash)?hash:'today'; }

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(!supabase);
  const [demo, setDemo] = useState(()=>localStorage.getItem('lexicon.demo.active')==='yes');
  const [page, setPage] = useState(currentPage);
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [online, setOnline] = useState(navigator.onLine);
  const [toast, setToast] = useState<{message:string;type:'success'|'error'}|null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  const notify = useCallback((message:string,type:'success'|'error'='success')=>setToast({message,type}),[]);
  useEffect(()=>{if(!toast)return;const timer=setTimeout(()=>setToast(null),7000);return()=>clearTimeout(timer);},[toast]);
  useEffect(()=>{const change=()=>{setPage(currentPage());window.scrollTo(0,0);};window.addEventListener('hashchange',change);return()=>window.removeEventListener('hashchange',change);},[]);
  const navigate = useCallback((next:string)=>{ location.hash=`/${next}`; if(currentPage()===next) setPage(next);},[]);
  useEffect(()=>{
    if(!supabase)return;
    supabase.auth.getSession().then(({data,error})=>{if(error)setAuthError(error.message);setSession(data.session);setAuthReady(true);}).catch(e=>{setAuthError(e.message);setAuthReady(true);});
    const {data:{subscription}}=supabase.auth.onAuthStateChange((_event,next)=>{setSession(next);setAuthReady(true);});
    return()=>subscription.unsubscribe();
  },[]);
  const repository = useMemo<Repository|null>(()=>demo?createDemoRepository():session?createCloudRepository():null,[demo,session?.user.id]);
  const repositoryRef = useRef(repository); repositoryRef.current=repository;
  const refreshQueue = useRef<Promise<void>>(Promise.resolve());
  // A refresh requested after a write must read after any older request, never reuse it.
  const refresh = useCallback(()=>{
    if(!repository)return Promise.resolve();
    const load = async()=>{
      if(repositoryRef.current!==repository)return;
      try {const data=await repository.load();if(repositoryRef.current===repository){setSnapshot(data);setLoadError('');}}
      catch(error){if(repositoryRef.current===repository)setLoadError((error as Error).message);throw error;}
    };
    const request=refreshQueue.current.then(load,load);
    refreshQueue.current=request.catch(()=>{});
    return request;
  },[repository]);
  useEffect(()=>{
    setSnapshot(emptySnapshot());setLoadError('');
    if(!repository)return;
    setLoading(true);void refresh().catch(()=>{}).finally(()=>{if(repositoryRef.current===repository)setLoading(false);});
    const timer=window.setInterval(()=>{if(document.visibilityState==='visible'&&navigator.onLine)void refresh().catch(()=>{});},15000);
    const onVisible=()=>{if(document.visibilityState==='visible')void refresh().catch(()=>{});};
    const onOnline=()=>{setOnline(true);void refresh().catch(()=>{});};const onOffline=()=>setOnline(false);
    const onStorage=(event:StorageEvent)=>{if(repository.mode==='demo'&&event.key?.includes('lexicon'))void refresh().catch(()=>{});};
    document.addEventListener('visibilitychange',onVisible);window.addEventListener('online',onOnline);window.addEventListener('offline',onOffline);window.addEventListener('storage',onStorage);
    return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',onVisible);window.removeEventListener('online',onOnline);window.removeEventListener('offline',onOffline);window.removeEventListener('storage',onStorage);};
  },[repository,refresh]);
  const openDemo = async()=>{
    setSigningIn(true);setAuthError('');
    try {
      const repo=createDemoRepository();
      if(!localStorage.getItem('lexicon.demo.initialized')){
        const data=await repo.load();if(!data.entries.length)await repo.saveEntries(sampleEntries());
        localStorage.setItem('lexicon.demo.initialized','yes');
      }
      localStorage.setItem('lexicon.demo.active','yes');setDemo(true);navigate('today');
    }catch(e){setAuthError((e as Error).message);}finally{setSigningIn(false);}
  };
  const signIn=async(event:React.FormEvent)=>{
    event.preventDefault();if(!supabase)return;setSigningIn(true);setAuthError('');
    try {const {error}=await supabase.auth.signInWithPassword({email,password});if(error)throw error;setPassword('');localStorage.removeItem('lexicon.demo.active');setDemo(false);navigate('today');}
    catch(e){setAuthError((e as Error).message);}finally{setSigningIn(false);}
  };
  const signOut=async()=>{
    try {
      if(demo){localStorage.removeItem('lexicon.demo.active');setDemo(false);}else if(supabase){const {error}=await supabase.auth.signOut({ scope: 'local' });if(error)throw error;}
      setSnapshot(emptySnapshot());navigate('today');
    }catch(error){notify((error as Error).message,'error');}
  };
  if(!authReady)return <div className="boot-screen"><Flower2 size={34}/><p>正在打开你的词间…</p></div>;
  if(!repository)return <div className="welcome-page"><div className="welcome-brand"><span className="brand-mark"><BookOpen size={26}/></span><strong>词间</strong><span>LEXICON</span></div><main className="welcome-main"><section className="welcome-copy"><p className="eyebrow">YOUR OWN LITTLE WORD GARDEN</p><h1>让英文，<br/>在记忆里<span>生根。</span></h1><p>把阅读中遇到的单词、短语和句子，<br/>收进属于自己的词汇书房。</p><div className="welcome-features"><span><Check size={15}/>美式音标与英文释义</span><span><Check size={15}/>每次十个，随时继续</span><span><Check size={15}/>按记忆安排下一次相遇</span></div><span className="welcome-motto">A little understanding, every day.</span></section><section className="login-panel panel"><BookOpen size={30}/><h2>{supabase?'回到你的词间':'你的词汇书房，准备好了'}</h2><p>{supabase?'登录私人账号，在手机和电脑上接着学习。':'先用示例词库，体验一次轻松的英文回忆。'}</p>{supabase?<form onSubmit={signIn}><label className="field"><span>邮箱</span><input type="email" autoComplete="username" required value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com"/></label><label className="field"><span>密码</span><input type="password" autoComplete="current-password" required value={password} onChange={e=>setPassword(e.target.value)}/></label><button className="btn primary wide" disabled={signingIn} type="submit">{signingIn?'正在登录…':'进入词间'}<ArrowRight size={17}/></button></form>:<div className="setup-note"><span className="status-dot demo"/><div><strong>本地预览已就绪</strong><p>云端连接尚未配置。示例模式只保存到当前浏览器。</p></div></div>}{authError&&<p className="error-message" role="alert">{authError}</p>}<button className={`btn ${supabase?'secondary':'primary'} wide demo-button`} disabled={signingIn} onClick={openDemo}>{signingIn?'正在打开…':'体验示例词库'}<ArrowRight size={17}/></button><small className="login-footnote">{supabase?'私人词库不开放注册。示例模式与个人账号数据独立。':'连接 Supabase 后，即可使用私人账号并跨设备同步。'}</small></section></main><footer className="welcome-footer">词间 · 一个词，一点理解。</footer></div>;
  const props={snapshot,repository,refresh,notify};
  const selected=page.startsWith('study')?'today':page;
  return <div className="app-shell"><aside className="sidebar"><a className="brand" href="#/today"><span className="brand-mark"><BookOpen size={24}/></span><div><strong>词间</strong><span>LEXICON</span></div></a><p className="nav-label">我的学习空间</p><nav aria-label="主导航">{navigation.map(item=><a className={`nav-item ${selected===item.id?'active':''}`} key={item.id} href={`#/${item.id}`} aria-current={selected===item.id?'page':undefined}><item.icon size={19}/><span>{item.label}</span>{selected===item.id&&<span className="nav-dot"/>}</a>)}</nav><div className="sidebar-note"><Flower2 size={24}/><p>词汇是一点一点<br/>长进生活里的。</p><span>KEEP GROWING</span></div><div className="sidebar-account"><span className="avatar">{demo?'L':session?.user.email?.slice(0,1).toUpperCase()||'L'}</span><div><strong>{demo?'示例书房':'我的私人词库'}</strong><small>{demo?'仅此浏览器':session?.user.email}</small></div><button className="icon-button" aria-label={demo?'退出示例模式':'退出登录'} onClick={signOut}><LogOut size={16}/></button></div></aside><div className="main-wrap"><header className="topbar"><div className="breadcrumb">我的学习空间<ChevronRight size={13}/><span>{navigation.find(i=>i.id===selected)?.label}</span></div><div className={`sync-status ${loadError?'sync-error':''}`}>{!online?<WifiOff size={14}/>:repository.mode==='cloud'?<Cloud size={14}/>:<span className="status-dot demo"/>}<span>{!online?'当前离线':loadError?'同步待重试':repository.mode==='cloud'?'云端已连接':'本地示例 · 不跨设备同步'}</span></div><button className="icon-button" aria-label={demo?'退出示例模式并返回登录页':'退出账号并返回登录页'} title={demo?'退出示例模式':'退出登录'} onClick={signOut}><LogOut size={16}/></button></header>{loadError&&<div className="connection-error" role="alert"><span>暂时无法同步：{loadError}</span><button className="text-link" onClick={()=>void refresh().catch(()=>{})}>重新连接</button></div>}<main className="main-content" id="main-content">{loading?<div className="empty-state"><LoaderCircle className="spin" size={26}/><p>正在打开词库…</p></div>:page==='library'?<Library {...props}/>:page==='import'?<ImportPage {...props}/>:page==='stats'?<Stats snapshot={snapshot}/>:page==='settings'?<SettingsPage {...props}/>:page.startsWith('study-')?<Study key={`${demo?'demo':session?.user.id}-${page}`} {...props} mode={page==='study-new'?'new':'review'} navigate={navigate} pendingKey={`lexicon.pending.${demo?'demo':session?.user.id}`}/>:<Home snapshot={snapshot} navigate={navigate}/>}</main></div>{toast&&<div className={`toast ${toast.type}`} role={toast.type==='error'?'alert':'status'}>{toast.type==='success'?<Check size={18}/>:<X size={18}/>}<span>{toast.message}</span><button aria-label="关闭提示" onClick={()=>setToast(null)}><X size={15}/></button></div>}</div>;
}
