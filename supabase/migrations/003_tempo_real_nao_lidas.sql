-- =====================================================================
-- APP Notas — 003: tempo real para participações + contador de não lidas
-- Como aplicar: Supabase → SQL Editor → New query → cole tudo → Run.
-- =====================================================================

-- Quando alguém compartilha um assunto com você, ele aparece na hora
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.categoria_membros;
    exception when duplicate_object then null;
    end;
  end if;
end $$;

-- Mensagens da outra pessoa ainda não vistas, por assunto
create or replace function public.nao_lidas()
returns table (categoria_id uuid, qtd int)
language sql stable security invoker set search_path = '' as $$
  select m.categoria_id, count(*)::int
    from public.mensagens m
    join public.categoria_membros cm
      on cm.categoria_id = m.categoria_id and cm.usuario_id = auth.uid()
   where m.apagado_em is null
     and m.autor_id <> auth.uid()
     and m.criado_em > coalesce(cm.lido_ate, cm.adicionado_em)
   group by m.categoria_id;
$$;

revoke execute on function public.nao_lidas() from public, anon;
grant  execute on function public.nao_lidas() to authenticated;
