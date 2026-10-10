-- Optional word-family metadata. Existing v1 snapshots remain valid without word_forms.
-- Empty field strings are allowed while editing; an explicit {} clears all word forms.
create or replace function public.lexicon_validate_word_forms(forms jsonb) returns void language plpgsql as $$
declare
  section_name text; section_value jsonb; required_keys text[]; k text; derivative jsonb;
begin
  if jsonb_typeof(forms) is distinct from 'object' then raise exception '词形 word_forms 必须是对象。'; end if;
  if not public.lexicon_keys(forms,array[]::text[],array['verb','comparison','derivatives']) then raise exception '词形包含不支持的字段。'; end if;
  foreach section_name in array array['verb','comparison'] loop
    if not (forms ? section_name) then continue; end if;
    section_value := forms->section_name;
    if jsonb_typeof(section_value) is distinct from 'object' then raise exception '词形 % 必须是对象。', section_name; end if;
    if section_name = 'verb' then required_keys := array['base','third_person','past','past_participle','present_participle'];
    else required_keys := array['positive','comparative','superlative']; end if;
    if not public.lexicon_keys(section_value,required_keys,array['note']) then raise exception '词形 % 缺少必需字段或包含不支持的字段。', section_name; end if;
    foreach k in array required_keys loop
      if jsonb_typeof(section_value->k) is distinct from 'string' or length(section_value->>k) > 2000 then raise exception '词形 %.% 必须是至多 2000 字符的文本。', section_name,k; end if;
    end loop;
    if section_value ? 'note' and (jsonb_typeof(section_value->'note') is distinct from 'string' or length(section_value->>'note') > 20000) then raise exception '词形备注必须是至多 20000 字符的文本。'; end if;
  end loop;
  if forms ? 'derivatives' then
    if jsonb_typeof(forms->'derivatives') is distinct from 'array' then raise exception '派生词必须是数组。'; end if;
    if jsonb_array_length(forms->'derivatives') > 30 then raise exception '派生词最多 30 项。'; end if;
    for derivative in select value from jsonb_array_elements(forms->'derivatives') loop
      if jsonb_typeof(derivative) is distinct from 'object' then raise exception '派生词必须是对象。'; end if;
      if not public.lexicon_keys(derivative,array['term','pos','meaning','affix']) then raise exception '派生词缺少必需字段或包含不支持的字段。'; end if;
      foreach k in array array['term','pos','meaning','affix'] loop
        if jsonb_typeof(derivative->k) is distinct from 'string' or length(derivative->>k) > 2000 then raise exception '派生词字段 % 必须是至多 2000 字符的文本。',k; end if;
      end loop;
    end loop;
  end if;
end $$;
revoke all on function public.lexicon_validate_word_forms(jsonb) from public, anon, authenticated;

create or replace function public.lexicon_validate_entry(e jsonb) returns void language plpgsql as $$
declare k text;
begin
  if not public.lexicon_keys(e,array['id','term','ipa_us','definition_en','meaning_zh','type','pos','example','example_translation','usage','tags','source','notes','favorite','suspended','created_at','updated_at','revision'],array['word_forms']) or not public.lexicon_uuid(e->'id') or not public.lexicon_int(e->'revision') then raise exception '词条 ID 或版本无效。'; end if;
  foreach k in array array['term','ipa_us','definition_en','meaning_zh','type','pos','example','example_translation','usage','source','notes'] loop
    if jsonb_typeof(e->k) is distinct from 'string' or length(e->>k) > 20000 then raise exception '词条字段 % 无效。', k; end if;
  end loop;
  if length(e->>'term') > 2000 or length(trim(e->>'term')) = 0 or e->>'type' not in ('word','phrase','idiom','sentence') then raise exception '英文原文或条目类型无效。'; end if;
  if not public.lexicon_iso(e->'created_at') or not public.lexicon_iso(e->'updated_at') or
    jsonb_typeof(e->'favorite') is distinct from 'boolean' or jsonb_typeof(e->'suspended') is distinct from 'boolean' or
    jsonb_typeof(e->'tags') is distinct from 'array' then raise exception '词条元数据无效。'; end if;
  if jsonb_array_length(e->'tags') > 200 or exists(select 1 from jsonb_array_elements(e->'tags') as x where jsonb_typeof(x) is distinct from 'string' or length(x #>> '{}') > 200) then raise exception '标签必须是文本。'; end if;
  if e ? 'word_forms' then perform public.lexicon_validate_word_forms(e->'word_forms'); end if;
end $$;

-- Patch just the entry-save assignment; preserve the dispatcher, locking and PT409 behavior.
-- Fail on unexpected source instead of silently deploying incomplete compatibility behavior.
do $migration$
declare
  definition text;
  needle text := $needle$      e := e || jsonb_build_object('revision'$needle$;
  replacement text := $replacement$      -- Preserve word forms omitted by older clients.
      if not (e ? 'word_forms') and existing is not null and existing ? 'word_forms' then
        e := e || jsonb_build_object('word_forms', existing->'word_forms');
      end if;
      e := e || jsonb_build_object('revision'$replacement$;
begin
  select pg_get_functiondef('public.lexicon_action(text,jsonb)'::regprocedure) into definition;
  if position('-- Preserve word forms omitted by older clients.' in definition) > 0 then return; end if;
  if (length(definition) - length(replace(definition,needle,''))) / length(needle) <> 1 then
    raise exception '无法定位词条保存逻辑；词形迁移未应用，请检查数据库函数版本。';
  end if;
  execute replace(definition,needle,replacement);
end
$migration$;
