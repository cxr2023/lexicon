-- Optimistic version conflicts are permanent for that request, not serialization failures.
-- PostgREST 14 retries SQLSTATE 40001 indefinitely; PT409 returns HTTP 409 immediately.
-- Patch the existing function in place, preserving its body, security settings and grants.
-- This is also safe after the corrected initial migration or when applied again.
do $migration$
declare
  definition text;
begin
  select pg_get_functiondef('public.lexicon_action(text,jsonb)'::regprocedure) into definition;
  if position('errcode = ''40001''' in definition) > 0 then
    execute replace(definition, 'errcode = ''40001''', 'errcode = ''PT409''');
  end if;
end
$migration$;
