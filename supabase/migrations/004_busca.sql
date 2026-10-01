-- =====================================================================
-- APP Notas — 004: busca melhor (pedaços de palavra e sem acento)
-- "ceno" acha "cenoura"; "acucar" acha "açúcar"; também procura no título,
-- na descrição e no endereço do link.
-- Como aplicar: Supabase → SQL Editor → New query → cole tudo → Run.
-- =====================================================================

create extension if not exists unaccent with schema extensions;

-- unaccent "imutável" para poder ser usada em índice
create or replace function public.sem_acento(t text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select lower(extensions.unaccent('extensions.unaccent'::regdictionary, coalesce(t, '')));
$$;

drop function if exists public.buscar_mensagens(text, uuid, int);

create or replace function public.buscar_mensagens(p_q text, p_categoria uuid default null, p_limite int default 50)
returns table (id uuid, categoria_id uuid, autor_id uuid, texto text, link jsonb, criado_em timestamptz, editado_em timestamptz)
language sql stable security invoker set search_path = '' as $$
  with q as (
    select public.sem_acento(btrim(p_q)) as termo,
           websearch_to_tsquery('portuguese', p_q) as ts
  )
  select m.id, m.categoria_id, m.autor_id, m.texto, m.link, m.criado_em, m.editado_em
    from public.mensagens m, q
   where m.apagado_em is null
     and length(q.termo) >= 2
     and (p_categoria is null or m.categoria_id = p_categoria)
     and (
       m.busca @@ q.ts
       or public.sem_acento(m.texto || ' ' || coalesce(m.link ->> 'titulo', '') || ' ' ||
                            coalesce(m.link ->> 'descricao', '') || ' ' || coalesce(m.link ->> 'url', ''))
          like '%' || replace(replace(replace(q.termo, '\', '\\'), '%', '\%'), '_', '\_') || '%'
     )
   order by m.criado_em desc
   limit least(coalesce(p_limite, 50), 200);
$$;

revoke execute on function public.buscar_mensagens(text, uuid, int) from public, anon;
grant  execute on function public.buscar_mensagens(text, uuid, int) to authenticated;
revoke execute on function public.sem_acento(text) from public, anon;
grant  execute on function public.sem_acento(text) to authenticated;
