-- =====================================================================
-- APP Notas — 002: prévia da última mensagem de cada assunto (lista)
-- Como aplicar: Supabase → SQL Editor → New query → cole tudo → Run.
-- =====================================================================

create or replace function public.ultimas_mensagens()
returns table (categoria_id uuid, texto text, titulo text, criado_em timestamptz)
language sql stable security invoker set search_path = '' as $$
  select distinct on (m.categoria_id)
         m.categoria_id,
         left(m.texto, 200),
         coalesce(m.link ->> 'titulo', m.link ->> 'url'),
         m.criado_em
    from public.mensagens m
   where m.apagado_em is null
   order by m.categoria_id, m.criado_em desc;
$$;

revoke execute on function public.ultimas_mensagens() from public, anon;
grant  execute on function public.ultimas_mensagens() to authenticated;
