-- Personal vocabulary workspace. All mutations lock one per-user row and commit atomically.
-- Run once in the Supabase SQL editor, or with `supabase db push`.
create table if not exists public.lexicon_workspaces (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.lexicon_workspaces enable row level security;
create policy "Read own vocabulary" on public.lexicon_workspaces for select to authenticated using (auth.uid() = user_id);
revoke all on public.lexicon_workspaces from anon, authenticated;
grant select on public.lexicon_workspaces to authenticated;

create function public.lexicon_now() returns text language sql stable as $$
  select to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;
create function public.lexicon_iso(v jsonb) returns boolean language plpgsql immutable as $$
begin
  if jsonb_typeof(v) is distinct from 'string' or (v #>> '{}') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$' then return false; end if;
  perform (v #>> '{}')::timestamptz;
  return true;
exception when others then return false;
end $$;
create function public.lexicon_uuid(v jsonb) returns boolean language sql immutable as $$
  select coalesce(jsonb_typeof(v) = 'string' and (v #>> '{}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false)
$$;
create function public.lexicon_int(v jsonb) returns boolean language sql immutable as $$
  select coalesce(jsonb_typeof(v) = 'number' and (v #>> '{}') ~ '^\d+$' and (v #>> '{}')::numeric <= 1000000000, false)
$$;
create function public.lexicon_keys(v jsonb, required text[], optional text[] default array[]::text[]) returns boolean language sql immutable as $$
  select coalesce(jsonb_typeof(v) = 'object' and v ?& required
    and not exists(select 1 from jsonb_object_keys(v) as k where not k = any(required || optional)), false)
$$;
create function public.lexicon_ready(e jsonb) returns boolean language sql immutable as $$
  select not exists (
    select 1 from unnest(array[e->>'term',e->>'ipa_us',e->>'definition_en']) as v
    where length(trim(v)) = 0 or v ~* '待确认|待补全|待核实|需确认|\m(TBD|TODO)\M|\[uncertain\]'
      or trim(v) ~* '^([-—–?？…]+|unknown|n/a|null|undefined)$'
  ) and coalesce(e->>'notes','') !~* '待确认|待补全|待核实|需确认|\m(TBD|TODO)\M|\[uncertain\]'
$$;
create function public.lexicon_valid_state(s jsonb) returns boolean language plpgsql immutable as $$
declare k text;
begin
  if not public.lexicon_keys(s,array['due','stability','difficulty','elapsed_days','scheduled_days','learning_steps','reps','lapses','state'],array['last_review']) or not public.lexicon_iso(s->'due') then return false; end if;
  foreach k in array array['stability','difficulty','elapsed_days','scheduled_days'] loop
    if jsonb_typeof(s->k) is distinct from 'number' or (s->>k)::numeric < 0 then return false; end if;
  end loop;
  foreach k in array array['reps','lapses','learning_steps','state'] loop
    if not public.lexicon_int(s->k) then return false; end if;
  end loop;
  if (s->>'stability')::numeric > 1000000 or (s->>'elapsed_days')::numeric > 1000000000 or (s->>'scheduled_days')::numeric > 1000000000 or not public.lexicon_int(s->'elapsed_days') or not public.lexicon_int(s->'scheduled_days') or (s->>'difficulty')::numeric > 10 or (s->>'state')::int > 3 or (s->>'lapses')::numeric > (s->>'reps')::numeric then return false; end if;
  if s ? 'last_review' and not public.lexicon_iso(s->'last_review') then return false; end if;
  if (s->>'state')::int <> 0 and (not s ? 'last_review' or (s->>'reps')::numeric = 0) then return false; end if;
  if (s->>'state')::int = 0 and (s->>'reps')::numeric <> 0 then return false; end if;
  return true;
exception when others then return false;
end $$;
create function public.lexicon_valid_card(c jsonb) returns boolean language sql immutable as $$
  select coalesce(public.lexicon_keys(c,array['id','entry_id','kind','state','revision','bury_until']) and public.lexicon_uuid(c->'id') and public.lexicon_uuid(c->'entry_id')
    and c->>'kind' in ('recognition','production','cloze') and public.lexicon_int(c->'revision')
    and public.lexicon_valid_state(c->'state') and (c->'bury_until' = 'null'::jsonb or public.lexicon_iso(c->'bury_until')), false)
$$;
create function public.lexicon_validate_settings(s jsonb) returns void language plpgsql as $$
declare k text;
begin
  if not public.lexicon_keys(s,array['batch_size','timezone','hide_chinese','production_enabled','cloze_enabled','retention']) or not public.lexicon_int(s->'batch_size') or (s->>'batch_size')::int not between 1 and 100
     or jsonb_typeof(s->'retention') is distinct from 'number' or (s->>'retention')::numeric not between 0.7 and 0.99 then
    raise exception '学习设置无效。';
  end if;
  foreach k in array array['hide_chinese','production_enabled','cloze_enabled'] loop
    if jsonb_typeof(s->k) is distinct from 'boolean' then raise exception '学习设置缺少布尔字段。'; end if;
  end loop;
  if jsonb_typeof(s->'timezone') is distinct from 'string' or not exists (select 1 from pg_timezone_names where name = s->>'timezone') then
    raise exception '学习时区无效。';
  end if;
end $$;
create function public.lexicon_validate_entry(e jsonb) returns void language plpgsql as $$
declare k text;
begin
  if not public.lexicon_keys(e,array['id','term','ipa_us','definition_en','meaning_zh','type','pos','example','example_translation','usage','tags','source','notes','favorite','suspended','created_at','updated_at','revision']) or not public.lexicon_uuid(e->'id') or not public.lexicon_int(e->'revision') then raise exception '词条 ID 或版本无效。'; end if;
  foreach k in array array['term','ipa_us','definition_en','meaning_zh','type','pos','example','example_translation','usage','source','notes'] loop
    if jsonb_typeof(e->k) is distinct from 'string' or length(e->>k) > 20000 then raise exception '词条字段 % 无效。', k; end if;
  end loop;
  if length(e->>'term') > 2000 or length(trim(e->>'term')) = 0 or e->>'type' not in ('word','phrase','idiom','sentence') then raise exception '英文原文或条目类型无效。'; end if;
  if not public.lexicon_iso(e->'created_at') or not public.lexicon_iso(e->'updated_at') or
    jsonb_typeof(e->'favorite') is distinct from 'boolean' or jsonb_typeof(e->'suspended') is distinct from 'boolean' or
    jsonb_typeof(e->'tags') is distinct from 'array' then raise exception '词条元数据无效。'; end if;
  if jsonb_array_length(e->'tags') > 200 or exists(select 1 from jsonb_array_elements(e->'tags') as x where jsonb_typeof(x) is distinct from 'string' or length(x #>> '{}') > 200) then raise exception '标签必须是文本。'; end if;
end $$;
create function public.lexicon_validate_snapshot(d jsonb) returns void language plpgsql as $$
declare k text; e jsonb; c jsonb; r jsonb; b jsonb; x jsonb;
begin
  if not public.lexicon_keys(d,array['entries','cards','reviews','batches','settings']) then raise exception '备份必须是对象。'; end if;
  perform public.lexicon_validate_settings(d->'settings');
  foreach k in array array['entries','cards','reviews','batches'] loop
    if jsonb_typeof(d->k) is distinct from 'array' then raise exception '备份缺少 % 数组。', k; end if;
    if exists(select 1 from jsonb_array_elements(d->k) as v group by lower(v->>'id') having count(*) > 1) then raise exception '备份存在重复 ID。'; end if;
  end loop;
  if jsonb_array_length(d->'entries') > 50000 or jsonb_array_length(d->'cards') > 150000 or jsonb_array_length(d->'reviews') > 200000 or jsonb_array_length(d->'batches') > 50000 then raise exception '备份内容过多。'; end if;
  if (select count(*) from jsonb_array_elements(d->'batches') as v where v->'completed_at' = 'null'::jsonb) > 1 then raise exception '不能存在多个未结束的学习批次。'; end if;
  for e in select value from jsonb_array_elements(d->'entries') loop perform public.lexicon_validate_entry(e); end loop;
  for c in select value from jsonb_array_elements(d->'cards') loop
    if not public.lexicon_valid_card(c) or not exists(select 1 from jsonb_array_elements(d->'entries') as v where v->>'id' = c->>'entry_id') then raise exception '卡片或词条引用无效。'; end if;
  end loop;
  if exists(select 1 from jsonb_array_elements(d->'cards') as v group by v->>'entry_id', v->>'kind' having count(*) > 1) then raise exception '同一词条的题型重复。'; end if;
  for r in select value from jsonb_array_elements(d->'reviews') loop
    if not public.lexicon_keys(r,array['id','card_id','entry_id','rating','reviewed_at','before','after','undone']) or not public.lexicon_uuid(r->'id') or not public.lexicon_int(r->'rating') or (r->>'rating')::int not between 1 and 4
       or not public.lexicon_iso(r->'reviewed_at') or jsonb_typeof(r->'undone') is distinct from 'boolean'
       or not public.lexicon_valid_card(r->'before') or not public.lexicon_valid_card(r->'after') then raise exception '复习历史无效。'; end if;
    if not exists(select 1 from jsonb_array_elements(d->'cards') as v where v->>'id' = r->>'card_id' and v->>'entry_id' = r->>'entry_id' and v->>'kind' = r#>>'{before,kind}' and v->>'kind' = r#>>'{after,kind}')
      or r#>>'{before,id}' is distinct from r->>'card_id' or r#>>'{after,id}' is distinct from r->>'card_id'
      or r#>>'{before,entry_id}' is distinct from r->>'entry_id' or r#>>'{after,entry_id}' is distinct from r->>'entry_id' then raise exception '复习记录引用无效。'; end if;
  end loop;
  for b in select value from jsonb_array_elements(d->'batches') loop
    if not public.lexicon_keys(b,array['id','entry_ids','completed_ids','created_at','completed_at']) or not public.lexicon_uuid(b->'id') or not public.lexicon_iso(b->'created_at') or not (b->'completed_at' = 'null'::jsonb or public.lexicon_iso(b->'completed_at'))
       or jsonb_typeof(b->'entry_ids') is distinct from 'array' or jsonb_typeof(b->'completed_ids') is distinct from 'array' then raise exception '学习批次无效。'; end if;
    foreach k in array array['entry_ids','completed_ids'] loop
      if jsonb_array_length(b->k) > 100 then raise exception '每批最多 100 项。'; end if;
      if exists(select 1 from jsonb_array_elements(b->k) as v group by v having count(*) > 1) then raise exception '学习批次包含重复 ID。'; end if;
    end loop;
    for x in select value from jsonb_array_elements(b->'entry_ids') loop
      if not public.lexicon_uuid(x) or not exists(select 1 from jsonb_array_elements(d->'entries') as v where v->'id' = x) then raise exception '学习批次引用无效。'; end if;
    end loop;
    for x in select value from jsonb_array_elements(b->'completed_ids') loop
      if not (b->'entry_ids' @> jsonb_build_array(x)) then raise exception '批次完成列表无效。'; end if;
    end loop;
  end loop;
end $$;
create function public.lexicon_initial_state() returns jsonb language sql stable as $$
  select jsonb_build_object('due',public.lexicon_now(),'stability',0,'difficulty',0,'elapsed_days',0,'scheduled_days',0,'learning_steps',0,'reps',0,'lapses',0,'state',0)
$$;
create function public.lexicon_empty(p_timezone text) returns jsonb language sql stable as $$
  select jsonb_build_object('entries','[]'::jsonb,'cards','[]'::jsonb,'reviews','[]'::jsonb,'batches','[]'::jsonb,
    'settings',jsonb_build_object('batch_size',10,'timezone',p_timezone,'hide_chinese',false,'production_enabled',false,'cloze_enabled',false,'retention',0.9))
$$;
create function public.lexicon_maintain_cards(d jsonb) returns jsonb language plpgsql as $$
declare e jsonb; k text; kinds text[]; cards jsonb := d->'cards'; b jsonb; ids jsonb; batches jsonb := '[]'::jsonb; until_time text;
begin
  for e in select value from jsonb_array_elements(d->'entries') loop
    if not public.lexicon_ready(e) then continue; end if;
    kinds := array['recognition'];
    if (d#>>'{settings,production_enabled}')::boolean and length(trim(e->>'meaning_zh')) > 0 then kinds := array_append(kinds,'production'); end if;
    if (d#>>'{settings,cloze_enabled}')::boolean and e->>'example' ~ '\{\{[^{}]+\}\}' then kinds := array_append(kinds,'cloze'); end if;
    foreach k in array kinds loop
      if not exists(select 1 from jsonb_array_elements(cards) as c where c->>'entry_id' = e->>'id' and c->>'kind' = k) then
        select max(public.lexicon_next_day(v->>'reviewed_at',d#>>'{settings,timezone}')) into until_time
          from jsonb_array_elements(d->'reviews') as v where not (v->>'undone')::boolean and v->>'entry_id' = e->>'id';
        if until_time::timestamptz <= now() then until_time := null; end if;
        cards := cards || jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'entry_id',e->>'id','kind',k,'state',public.lexicon_initial_state(),'revision',1,'bury_until',until_time));
      end if;
    end loop;
  end loop;
  for b in select value from jsonb_array_elements(d->'batches') loop
    if b->'completed_at' = 'null'::jsonb then
      select coalesce(jsonb_agg(v),'[]'::jsonb) into ids from jsonb_array_elements(b->'entry_ids') as v
      where b->'completed_ids' @> jsonb_build_array(v) or exists (
        select 1 from jsonb_array_elements(d->'entries') as entry
        where entry->'id' = v and public.lexicon_ready(entry) and not (entry->>'suspended')::boolean
      );
      b := jsonb_set(b,'{entry_ids}',ids);
      if b->'completed_ids' @> ids then b := jsonb_set(b,'{completed_at}',to_jsonb(public.lexicon_now())); end if;
    end if;
    batches := batches || jsonb_build_array(b);
  end loop;
  return jsonb_set(jsonb_set(d,'{cards}',cards),'{batches}',batches);
end $$;
create function public.lexicon_next_day(at_time text, timezone text) returns text language sql stable as $$
  select to_char((((at_time::timestamptz at time zone timezone)::date + 1)::timestamp at time zone timezone) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;

-- Internal dispatcher. It is NOT callable by clients; public RPC wrappers below are the only mutation path.
create function public.lexicon_action(p_action text, p_payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  uid uuid := auth.uid(); d jsonb; result jsonb := 'null'::jsonb;
  e jsonb; existing jsonb; c jsonb; before_card jsonb; after_card jsonb; event jsonb; latest jsonb; b jsonb; item jsonb;
  arr jsonb; other jsonb; ids jsonb; completed jsonb; incoming jsonb; until_time text; revised numeric; k text;
  default_timezone text := coalesce(p_payload->>'timezone','UTC');
begin
  if uid is null then raise exception '请先登录。' using errcode = '42501'; end if;
  if not exists(select 1 from pg_timezone_names where name = default_timezone) then default_timezone := 'UTC'; end if;
  insert into public.lexicon_workspaces(user_id,data) values(uid,public.lexicon_empty(default_timezone)) on conflict(user_id) do nothing;
  select data into d from public.lexicon_workspaces where user_id = uid for update;

  if p_action = 'load' then return d;

  elsif p_action = 'save_entries' then
    incoming := p_payload->'entries';
    if jsonb_typeof(incoming) is distinct from 'array' then raise exception '词条列表无效。'; end if;
    if exists(select 1 from jsonb_array_elements(incoming) as v group by v->>'id' having count(*) > 1) then raise exception '一次保存不能包含重复词条 ID。'; end if;
    for e in select value from jsonb_array_elements(incoming) loop
      perform public.lexicon_validate_entry(e);
      select value into existing from jsonb_array_elements(d->'entries') where lower(value->>'id') = lower(e->>'id');
      if existing is not null and existing->>'id' <> e->>'id' then raise exception '词条 ID 的大小写与已有记录不一致。'; end if;
      if (existing is null and (e->>'revision')::numeric <> 0) or (existing is not null and existing->'revision' <> e->'revision') then
        raise exception '词条已修改或删除，请刷新后重试。' using errcode = '40001';
      end if;
      e := e || jsonb_build_object('revision',(e->>'revision')::numeric + 1,'updated_at',public.lexicon_now(),'created_at',coalesce(existing->>'created_at',e->>'created_at'));
      perform public.lexicon_validate_entry(e);
      if existing is null then arr := d->'entries' || jsonb_build_array(e);
      else select coalesce(jsonb_agg(case when v->>'id' = e->>'id' then e else v end),'[]'::jsonb) into arr from jsonb_array_elements(d->'entries') as v; end if;
      d := jsonb_set(d,'{entries}',arr);
    end loop;
    d := public.lexicon_maintain_cards(d);

  elsif p_action = 'start_batch' then
    select value into b from jsonb_array_elements(d->'batches') where value->'completed_at' = 'null'::jsonb and not (value->'completed_ids' @> (value->'entry_ids')) limit 1;
    if b is not null then return b; end if;
    select coalesce(jsonb_agg(v->'id'),'[]'::jsonb) into ids from (
      select entry_value as v from jsonb_array_elements(d->'entries') as all_entries(entry_value)
      where public.lexicon_ready(entry_value) and not (entry_value->>'suspended')::boolean and exists(
        select 1 from jsonb_array_elements(d->'cards') as card where card->>'entry_id' = entry_value->>'id' and card->>'kind' = 'recognition' and (card#>>'{state,reps}')::numeric = 0)
      order by entry_value->>'created_at',entry_value->>'id' limit (d#>>'{settings,batch_size}')::int
    ) eligible;
    if jsonb_array_length(ids) = 0 then return 'null'::jsonb; end if;
    b := jsonb_build_object('id',gen_random_uuid()::text,'entry_ids',ids,'completed_ids','[]'::jsonb,'created_at',public.lexicon_now(),'completed_at',null);
    d := jsonb_set(d,'{batches}',d->'batches' || jsonb_build_array(b)); result := b;

  elsif p_action = 'submit_review' then
    incoming := p_payload->'input';
    if not public.lexicon_uuid(incoming->'operation_id') or not public.lexicon_uuid(incoming->'card_id') or not public.lexicon_int(incoming->'expected_revision')
       or not public.lexicon_iso(incoming->'reviewed_at') or not public.lexicon_int(incoming->'rating') or (incoming->>'rating')::int not between 1 and 4
       or not public.lexicon_valid_state(incoming->'next_state') then raise exception '评分数据无效。'; end if;
    select value into event from jsonb_array_elements(d->'reviews') where lower(value->>'id') = lower(incoming->>'operation_id');
    if event is not null then
      if (event->>'undone')::boolean or event->'card_id' <> incoming->'card_id' or event#>'{before,revision}' <> incoming->'expected_revision'
         or event->'rating' <> incoming->'rating' or event->'reviewed_at' <> incoming->'reviewed_at' or event#>'{after,state}' <> incoming->'next_state' then raise exception '此提交编号已使用，请重新评分。'; end if;
      return 'null'::jsonb;
    end if;
    select value into c from jsonb_array_elements(d->'cards') where value->>'id' = incoming->>'card_id';
    if c is null then raise exception '词条已被删除，请刷新学习队列。'; end if;
    if (c->>'revision')::numeric >= 1000000000 then raise exception '卡片版本超出支持范围。'; end if;
    if c->'revision' <> incoming->'expected_revision' then raise exception '学习进度已在其他页面更新，请刷新后重试。' using errcode = '40001'; end if;
    select value into e from jsonb_array_elements(d->'entries') where value->>'id' = c->>'entry_id';
    if not public.lexicon_ready(e) or (e->>'suspended')::boolean or (c->>'kind' = 'production' and (not (d#>>'{settings,production_enabled}')::boolean or length(trim(e->>'meaning_zh'))=0))
       or (c->>'kind' = 'cloze' and (not (d#>>'{settings,cloze_enabled}')::boolean or e->>'example' !~ '\{\{[^{}]+\}\}')) then raise exception '词条已暂停、尚未补全或题型已关闭。'; end if;
    if (incoming#>>'{next_state,reps}')::numeric <> (c#>>'{state,reps}')::numeric + 1 or incoming#>'{next_state,last_review}' is distinct from incoming->'reviewed_at'
       or (incoming#>>'{next_state,due}')::timestamptz < (incoming->>'reviewed_at')::timestamptz then raise exception '评分调度数据无效。'; end if;
    before_card := c;
    c := c || jsonb_build_object('state',incoming->'next_state','revision',(c->>'revision')::numeric + 1,'bury_until',null);
    event := jsonb_build_object('id',incoming->>'operation_id','card_id',c->>'id','entry_id',c->>'entry_id','rating',incoming->'rating','reviewed_at',incoming->>'reviewed_at','before',before_card,'after',c,'undone',false);
    d := jsonb_set(d,'{reviews}',d->'reviews' || jsonb_build_array(event));
    until_time := public.lexicon_next_day(incoming->>'reviewed_at',d#>>'{settings,timezone}');
    arr := '[]'::jsonb;
    for item in select value from jsonb_array_elements(d->'cards') loop
      if item->>'id' = c->>'id' then item := c;
      elsif item->>'entry_id' = c->>'entry_id' and (item->>'bury_until' is null or (item->>'bury_until')::timestamptz < until_time::timestamptz) then
        item := item || jsonb_build_object('bury_until',until_time,'revision',(item->>'revision')::numeric + 1);
      end if;
      arr := arr || jsonb_build_array(item);
    end loop;
    d := jsonb_set(d,'{cards}',arr);
    if c->>'kind' = 'recognition' then
      arr := '[]'::jsonb;
      for b in select value from jsonb_array_elements(d->'batches') loop
        if b->'entry_ids' @> jsonb_build_array(c->>'entry_id') then
          completed := b->'completed_ids';
          if not completed @> jsonb_build_array(c->>'entry_id') then completed := completed || jsonb_build_array(c->>'entry_id'); end if;
          b := jsonb_set(b,'{completed_ids}',completed);
          if completed @> (b->'entry_ids') then b := jsonb_set(b,'{completed_at}',to_jsonb(coalesce(b->>'completed_at',public.lexicon_now()))); end if;
        end if;
        arr := arr || jsonb_build_array(b);
      end loop;
      d := jsonb_set(d,'{batches}',arr);
    end if;

  elsif p_action = 'undo_review' then
    select value into event from jsonb_array_elements(d->'reviews') where value->>'id' = p_payload->>'id';
    if event is null then raise exception '这条评分已不存在。'; end if;
    if (event->>'undone')::boolean then return 'null'::jsonb; end if;
    select value into latest from jsonb_array_elements(d->'reviews') with ordinality as v(value,n) where not (value->>'undone')::boolean order by n desc limit 1;
    select value into c from jsonb_array_elements(d->'cards') where value->>'id' = event->>'card_id';
    if latest->>'id' <> event->>'id' or c is null or c->'revision' <> event#>'{after,revision}' then raise exception '已有更新的学习操作，无法撤销这条评分。' using errcode = '40001'; end if;
    c := event->'before' || jsonb_build_object('revision',(c->>'revision')::numeric + 1);
    select jsonb_agg(case when v->>'id' = event->>'id' then jsonb_set(v,'{undone}','true'::jsonb) else v end) into arr from jsonb_array_elements(d->'reviews') as v;
    d := jsonb_set(d,'{reviews}',arr);
    arr := '[]'::jsonb;
    for item in select value from jsonb_array_elements(d->'cards') loop
      if item->>'id' = c->>'id' then item := c;
      elsif item->>'entry_id' = c->>'entry_id' then
        select max(public.lexicon_next_day(v->>'reviewed_at',d#>>'{settings,timezone}')) into until_time from jsonb_array_elements(d->'reviews') as v
          where not (v->>'undone')::boolean and v->>'entry_id' = c->>'entry_id' and v->>'card_id' <> item->>'id';
        if item->>'bury_until' is distinct from until_time then item := item || jsonb_build_object('bury_until',until_time,'revision',(item->>'revision')::numeric + 1); end if;
      end if;
      arr := arr || jsonb_build_array(item);
    end loop;
    d := jsonb_set(d,'{cards}',arr);
    if c->>'kind' = 'recognition' and (c#>>'{state,reps}')::numeric = 0 then
      select coalesce(jsonb_agg(v),'[]'::jsonb) into arr from jsonb_array_elements(d->'batches') as v
        where v->'completed_at' <> 'null'::jsonb or jsonb_array_length(v->'completed_ids') > 0 or v->'entry_ids' @> jsonb_build_array(c->>'entry_id');
      d := jsonb_set(d,'{batches}',arr);
      arr := '[]'::jsonb;
      for b in select value from jsonb_array_elements(d->'batches') loop
        if b->'entry_ids' @> jsonb_build_array(c->>'entry_id') then
          select coalesce(jsonb_agg(v),'[]'::jsonb) into completed from jsonb_array_elements(b->'completed_ids') as v where v #>> '{}' <> c->>'entry_id';
          b := b || jsonb_build_object('completed_ids',completed,'completed_at',null);
        end if;
        arr := arr || jsonb_build_array(b);
      end loop;
      d := jsonb_set(d,'{batches}',arr);
    end if;

  elsif p_action = 'delete_entry' then
    if not public.lexicon_int(p_payload->'revision') then raise exception '词条版本无效。'; end if;
    select value into e from jsonb_array_elements(d->'entries') where value->>'id' = p_payload->>'id';
    if e is null then return 'null'::jsonb; end if;
    if e->'revision' <> p_payload->'revision' then raise exception '词条已更新，请刷新后再删除。' using errcode = '40001'; end if;
    select coalesce(jsonb_agg(v),'[]'::jsonb) into arr from jsonb_array_elements(d->'entries') as v where v->>'id' <> e->>'id'; d := jsonb_set(d,'{entries}',arr);
    foreach k in array array['cards','reviews'] loop
      select coalesce(jsonb_agg(v),'[]'::jsonb) into arr from jsonb_array_elements(d->k) as v where v->>'entry_id' <> e->>'id'; d := jsonb_set(d,array[k],arr);
    end loop;
    arr := '[]'::jsonb;
    for b in select value from jsonb_array_elements(d->'batches') loop
      select coalesce(jsonb_agg(v),'[]'::jsonb) into ids from jsonb_array_elements(b->'entry_ids') as v where v #>> '{}' <> e->>'id';
      select coalesce(jsonb_agg(v),'[]'::jsonb) into completed from jsonb_array_elements(b->'completed_ids') as v where v #>> '{}' <> e->>'id';
      b := b || jsonb_build_object('entry_ids',ids,'completed_ids',completed);
      if completed @> ids then b := jsonb_set(b,'{completed_at}',to_jsonb(coalesce(b->>'completed_at',public.lexicon_now()))); end if;
      arr := arr || jsonb_build_array(b);
    end loop;
    d := jsonb_set(d,'{batches}',arr);

  elsif p_action = 'save_settings' then
    perform public.lexicon_validate_settings(p_payload->'settings');
    d := public.lexicon_maintain_cards(jsonb_set(d,'{settings}',p_payload->'settings'));

  elsif p_action = 'restore_backup' then
    if not public.lexicon_keys(p_payload->'backup',array['version','exported_at','data']) or p_payload#>'{backup,version}' is distinct from '1'::jsonb or not public.lexicon_iso(p_payload#>'{backup,exported_at}') then raise exception '备份格式或版本无效。'; end if;
    incoming := p_payload#>'{backup,data}'; perform public.lexicon_validate_snapshot(incoming);
    select coalesce(max((v->>'revision')::numeric),0) + 1 into revised from jsonb_array_elements((d->'entries') || (d->'cards') || (incoming->'entries') || (incoming->'cards')) as v;
    if revised > 1000000000 then raise exception '备份版本超出支持范围。'; end if;
    foreach k in array array['entries','cards'] loop
      select coalesce(jsonb_agg(jsonb_set(v,'{revision}',to_jsonb(revised))),'[]'::jsonb) into arr from jsonb_array_elements(incoming->k) as v;
      incoming := jsonb_set(incoming,array[k],arr);
    end loop;
    d := public.lexicon_maintain_cards(incoming);

  else raise exception '未知操作。';
  end if;
  if jsonb_array_length(d->'entries') > 50000 or jsonb_array_length(d->'cards') > 150000
     or jsonb_array_length(d->'reviews') > 200000 or jsonb_array_length(d->'batches') > 50000 then
    raise exception '词库或学习记录已达到当前版本容量上限，请先备份并升级存储方案。';
  end if;
  -- Existing state was constructed only through these validated RPCs. Each mutation validates
  -- its incoming payload and preserves references under the same row lock. Revalidating every
  -- historical review against every card here made each answer O(reviews * cards). Full graph
  -- validation remains mandatory for restore_backup above, where untrusted graphs enter.
  update public.lexicon_workspaces set data = d, updated_at = now() where user_id = uid;
  return result;
end $$;

create function public.load_snapshot(p_timezone text default 'UTC') returns jsonb language sql security definer set search_path = public, pg_temp as $$ select public.lexicon_action('load',jsonb_build_object('timezone',p_timezone)) $$;
create function public.save_entries(p_entries jsonb) returns void language sql security definer set search_path = public, pg_temp as $$ select public.lexicon_action('save_entries',jsonb_build_object('entries',p_entries)); $$;
create function public.start_next_batch() returns jsonb language sql security definer set search_path = public, pg_temp as $$ select public.lexicon_action('start_batch') $$;
create function public.submit_review(p_input jsonb) returns void language sql security definer set search_path = public, pg_temp as $$ select public.lexicon_action('submit_review',jsonb_build_object('input',p_input)); $$;
create function public.undo_review(p_review_id text) returns void language sql security definer set search_path = public, pg_temp as $$ select public.lexicon_action('undo_review',jsonb_build_object('id',p_review_id)); $$;
create function public.delete_entry(p_entry_id text,p_expected_revision numeric) returns void language sql security definer set search_path = public, pg_temp as $$ select public.lexicon_action('delete_entry',jsonb_build_object('id',p_entry_id,'revision',p_expected_revision)); $$;
create function public.save_settings(p_settings jsonb) returns void language sql security definer set search_path = public, pg_temp as $$ select public.lexicon_action('save_settings',jsonb_build_object('settings',p_settings)); $$;
create function public.restore_backup(p_backup jsonb) returns void language sql security definer set search_path = public, pg_temp as $$ select public.lexicon_action('restore_backup',jsonb_build_object('backup',p_backup)); $$;

do $$ declare f record; begin
  for f in select oid::regprocedure as signature from pg_proc where pronamespace = 'public'::regnamespace and proname like 'lexicon_%' loop
    execute format('revoke all on function %s from public, anon, authenticated', f.signature);
  end loop;
end $$;
revoke all on function public.load_snapshot(text),public.save_entries(jsonb),public.start_next_batch(),public.submit_review(jsonb),public.undo_review(text),public.delete_entry(text,numeric),public.save_settings(jsonb),public.restore_backup(jsonb) from public, anon;
grant execute on function public.load_snapshot(text),public.save_entries(jsonb),public.start_next_batch(),public.submit_review(jsonb),public.undo_review(text),public.delete_entry(text,numeric),public.save_settings(jsonb),public.restore_backup(jsonb) to authenticated;
