-- =====================================================================
-- APP Notas — 005: assunto do tipo Nota (SPEC.md, seção 12)
-- Um assunto pode ser do tipo 'conversa' (bolhas, como hoje) ou 'nota'
-- (um texto só, em Markdown, editado direto na tela — ex.: lista de compras).
-- Como aplicar: Supabase → SQL Editor → New query → cole tudo → Run.
-- Pode rodar de novo sem problema.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Tipo do assunto
--    O app informa o tipo só ao criar (INSERT). Não há permissão de
--    UPDATE nessa coluna (ver 001, seção 5), então o tipo não muda depois.
-- ---------------------------------------------------------------------

alter table public.categorias add column if not exists tipo text not null default 'conversa';

do $$
begin
  alter table public.categorias
    add constraint categorias_tipo_check check (tipo in ('conversa', 'nota'));
exception when duplicate_object then null;
end $$;

create or replace function public.tipo_da_categoria(p_categoria uuid)
returns text language sql stable security definer set search_path = '' as $$
  select tipo from public.categorias where id = p_categoria;
$$;

-- ---------------------------------------------------------------------
-- 2. Tabela das notas (uma por assunto do tipo 'nota')
--    A linha nasce no primeiro salvamento. Sem linha = nota vazia, versão 0.
-- ---------------------------------------------------------------------

create table if not exists public.notas (
  categoria_id    uuid primary key references public.categorias (id) on delete cascade,
  conteudo        text not null default '' check (length(conteudo) <= 200000),   -- Markdown (GFM)
  versao          int  not null default 0,
  atualizado_por  uuid references auth.users (id) on delete set null,
  atualizado_em   timestamptz not null default now(),                          -- sync incremental
  busca           tsvector generated always as (to_tsvector('portuguese', conteudo)) stored
);

create index if not exists notas_busca_idx      on public.notas using gin (busca);
create index if not exists notas_atualizado_idx on public.notas (atualizado_em);

-- ---------------------------------------------------------------------
-- 3. RLS: o app só lê. Gravar é só pela função salvar_nota (seção 4);
--    apagar vem do "on delete cascade" quando o assunto é excluído.
-- ---------------------------------------------------------------------

alter table public.notas enable row level security;

drop policy if exists nota_select on public.notas;
create policy nota_select on public.notas for select to authenticated
  using (public.eh_permitido() and public.eh_membro(categoria_id));

revoke all on public.notas from anon;
revoke insert, update, delete, truncate on public.notas from authenticated;
grant  select on public.notas to authenticated;

-- Mensagens só em assunto do tipo 'conversa'.
drop policy if exists msg_insert on public.mensagens;
create policy msg_insert on public.mensagens for insert to authenticated
  with check (public.eh_permitido()
              and autor_id = auth.uid()
              and public.eh_membro(categoria_id)
              and public.tipo_da_categoria(categoria_id) = 'conversa');

-- ---------------------------------------------------------------------
-- 4. Salvar a nota com controle de versão
--    p_versao_base = a versão que o app carregou (0 se a nota ainda não existe).
--    - Versão igual: grava, soma 1 na versão e devolve ok = true.
--    - Versão diferente (a outra pessoa salvou antes): NÃO grava e devolve
--      ok = false com o conteúdo atual, para o app juntar as mudanças
--      linha a linha e chamar de novo com a versão nova (SPEC 12.6).
-- ---------------------------------------------------------------------

drop function if exists public.salvar_nota(uuid, text, int);

create or replace function public.salvar_nota(p_categoria uuid, p_conteudo text, p_versao_base int)
returns table (ok boolean, versao int, conteudo text, atualizado_por uuid, atualizado_em timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v_conteudo text := coalesce(p_conteudo, '');
  v_nota     public.notas%rowtype;
begin
  if not public.eh_permitido() or not public.eh_membro(p_categoria) then
    raise exception 'Você não participa deste assunto.';
  end if;
  if public.tipo_da_categoria(p_categoria) is distinct from 'nota' then
    raise exception 'Este assunto não é do tipo Nota.';
  end if;
  if length(v_conteudo) > 200000 then
    raise exception 'A nota passou do limite de 200 mil caracteres.';
  end if;

  if coalesce(p_versao_base, 0) = 0 then
    -- Primeira gravação: cria a linha (se outra pessoa criou antes, cai no conflito).
    insert into public.notas as n (categoria_id, conteudo, versao, atualizado_por, atualizado_em)
    values (p_categoria, v_conteudo, 1, auth.uid(), clock_timestamp())
    on conflict (categoria_id) do nothing
    returning n.* into v_nota;
  else
    -- Troca atômica: só grava se ninguém salvou depois da versão carregada.
    update public.notas as n
       set conteudo       = v_conteudo,
           versao         = n.versao + 1,
           atualizado_por = auth.uid(),
           atualizado_em  = clock_timestamp()
     where n.categoria_id = p_categoria
       and n.versao = p_versao_base
    returning n.* into v_nota;
  end if;

  if v_nota.categoria_id is not null then
    -- Gravou. Não devolve o conteúdo (o app já tem).
    return query select true, v_nota.versao, null::text, v_nota.atualizado_por, v_nota.atualizado_em;
    return;
  end if;

  -- Conflito: devolve o estado atual do servidor.
  select * into v_nota from public.notas n where n.categoria_id = p_categoria;
  return query select false,
                      coalesce(v_nota.versao, 0),
                      coalesce(v_nota.conteudo, ''),
                      v_nota.atualizado_por,
                      v_nota.atualizado_em;
end $$;

-- ---------------------------------------------------------------------
-- 5. Salvar a nota também sobe o assunto na lista (como mensagem nova)
-- ---------------------------------------------------------------------

create or replace function public.tg_nota_ultima_msg()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.categorias
     set ultima_msg_em = greatest(coalesce(ultima_msg_em, new.atualizado_em), new.atualizado_em)
   where id = new.categoria_id;
  return new;
end $$;

drop trigger if exists notas_ultima_msg on public.notas;
create trigger notas_ultima_msg after insert or update on public.notas
  for each row execute function public.tg_nota_ultima_msg();

-- ---------------------------------------------------------------------
-- 6. Mover mensagens: o destino precisa ser do tipo 'conversa'
--    (mesma função da 001, só com a checagem a mais)
-- ---------------------------------------------------------------------

create or replace function public.mover_mensagens(p_ids uuid[], p_destino uuid)
returns int language plpgsql security definer set search_path = '' as $$
declare v_qtd int;
begin
  if not public.eh_permitido() or not public.eh_membro(p_destino) then
    raise exception 'Você não participa do assunto de destino.';
  end if;
  if public.tipo_da_categoria(p_destino) is distinct from 'conversa' then
    raise exception 'Não dá para mover mensagens para um assunto do tipo Nota.';
  end if;
  update public.mensagens m
     set categoria_id = p_destino
   where m.id = any (p_ids)
     and public.eh_membro(m.categoria_id)
     and (m.autor_id = auth.uid() or public.eh_dono(m.categoria_id));
  get diagnostics v_qtd = row_count;
  update public.categorias c
     set ultima_msg_em = (select max(criado_em) from public.mensagens
                           where categoria_id = p_destino and apagado_em is null)
   where c.id = p_destino;
  return v_qtd;
end $$;

-- ---------------------------------------------------------------------
-- 7. Busca nas notas (mesma regra da 004: full-text, pedaço de palavra
--    e sem acento). Roda com as permissões de quem chama (RLS vale).
-- ---------------------------------------------------------------------

create or replace function public.buscar_notas(p_q text, p_limite int default 50)
returns table (categoria_id uuid, conteudo text, atualizado_em timestamptz)
language sql stable security invoker set search_path = '' as $$
  with q as (
    select public.sem_acento(btrim(p_q)) as termo,
           websearch_to_tsquery('portuguese', p_q) as ts
  )
  select n.categoria_id, n.conteudo, n.atualizado_em
    from public.notas n, q
   where length(q.termo) >= 2
     and (
       n.busca @@ q.ts
       or public.sem_acento(n.conteudo)
          like '%' || replace(replace(replace(q.termo, '\', '\\'), '%', '\%'), '_', '\_') || '%'
     )
   order by n.atualizado_em desc
   limit least(coalesce(p_limite, 50), 200);
$$;

-- ---------------------------------------------------------------------
-- 8. Notas que a outra pessoa editou depois da última vez que eu abri
--    (ponto na lista de assuntos; abrir a nota grava lido_ate)
-- ---------------------------------------------------------------------

create or replace function public.notas_alteradas()
returns table (categoria_id uuid, atualizado_em timestamptz)
language sql stable security invoker set search_path = '' as $$
  select n.categoria_id, n.atualizado_em
    from public.notas n
    join public.categoria_membros cm
      on cm.categoria_id = n.categoria_id and cm.usuario_id = auth.uid()
   where n.atualizado_por is distinct from auth.uid()
     and n.atualizado_em > coalesce(cm.lido_ate, cm.adicionado_em);
$$;

-- ---------------------------------------------------------------------
-- 9. Permissões das funções
-- ---------------------------------------------------------------------

revoke execute on function
  public.tipo_da_categoria(uuid),
  public.salvar_nota(uuid, text, int),
  public.buscar_notas(text, int),
  public.notas_alteradas()
from public, anon;

grant execute on function
  public.tipo_da_categoria(uuid),
  public.salvar_nota(uuid, text, int),
  public.buscar_notas(text, int),
  public.notas_alteradas()
to authenticated;

-- Funções de trigger não são chamadas pelo app.
revoke execute on function public.tg_nota_ultima_msg() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 10. Tempo real: a outra pessoa vê a nota mudar na hora
-- ---------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.notas;
    exception when duplicate_object then null;
    end;
  end if;
end $$;
