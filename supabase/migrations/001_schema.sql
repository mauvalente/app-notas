-- =====================================================================
-- APP Notas — esquema do banco (Supabase / Postgres)
-- Como aplicar: Supabase → SQL Editor → New query → cole tudo → Run.
-- Pode rodar de novo sem problema: o script é idempotente onde dá.
-- Detalhes no SPEC.md, seção 4.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Tabelas
-- ---------------------------------------------------------------------

-- Quem pode usar o app. E-mails sempre em minúsculas.
create table if not exists public.usuarios_permitidos (
  email  text primary key check (email = lower(email)),
  nome   text not null
);

create table if not exists public.categorias (
  id             uuid primary key default gen_random_uuid(),   -- o app manda o próprio id
  dono_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  nome           text not null check (length(btrim(nome)) > 0),
  emoji          text,
  cor            text,
  ultima_msg_em  timestamptz,
  criado_em      timestamptz not null default now(),
  atualizado_em  timestamptz not null default now()
);

-- Todos os participantes, inclusive o dono. Fixar/arquivar/lido é por pessoa.
create table if not exists public.categoria_membros (
  categoria_id   uuid not null references public.categorias (id) on delete cascade,
  usuario_id     uuid not null references auth.users (id) on delete cascade,
  papel          text not null check (papel in ('dono', 'editor')),
  fixada         boolean not null default false,
  arquivada      boolean not null default false,
  lido_ate       timestamptz,
  adicionado_em  timestamptz not null default now(),
  primary key (categoria_id, usuario_id)
);

create table if not exists public.mensagens (
  id             uuid primary key default gen_random_uuid(),   -- o app manda o próprio id
  categoria_id   uuid not null references public.categorias (id) on delete cascade,
  autor_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  texto          text not null default '',
  link           jsonb,
  criado_em      timestamptz not null default now(),
  editado_em     timestamptz,
  apagado_em     timestamptz,
  atualizado_em  timestamptz not null default now(),           -- usado pelo sync incremental
  busca          tsvector generated always as (
                   to_tsvector('portuguese',
                     coalesce(texto, '') || ' ' ||
                     coalesce(link ->> 'titulo', '') || ' ' ||
                     coalesce(link ->> 'descricao', ''))
                 ) stored
);

-- Cache de previews, preenchido só pela Edge Function (service role).
create table if not exists public.link_previews (
  url_normalizada  text primary key,
  url_final        text,
  titulo           text,
  descricao        text,
  site             text,
  imagem_path      text,
  imagem_largura   int,
  imagem_altura    int,
  status           text check (status in ('ok', 'sem_meta', 'bloqueado', 'erro')),
  buscado_em       timestamptz not null default now()
);

create index if not exists categoria_membros_usuario_idx on public.categoria_membros (usuario_id);
create index if not exists mensagens_categoria_criado_idx on public.mensagens (categoria_id, criado_em);
create index if not exists mensagens_atualizado_idx on public.mensagens (atualizado_em);
create index if not exists mensagens_busca_idx on public.mensagens using gin (busca);

-- ---------------------------------------------------------------------
-- 2. Funções auxiliares (security definer evita recursão no RLS)
-- ---------------------------------------------------------------------

create or replace function public.eh_permitido()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.usuarios_permitidos
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

create or replace function public.eh_membro(p_categoria uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.categoria_membros
    where categoria_id = p_categoria and usuario_id = auth.uid()
  );
$$;

create or replace function public.eh_dono(p_categoria uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.categorias
    where id = p_categoria and dono_id = auth.uid()
  );
$$;

-- ---------------------------------------------------------------------
-- 3. Triggers
-- ---------------------------------------------------------------------

create or replace function public.tg_atualizado_em()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.atualizado_em := now();
  return new;
end $$;

drop trigger if exists categorias_atualizado_em on public.categorias;
create trigger categorias_atualizado_em before update on public.categorias
  for each row execute function public.tg_atualizado_em();

drop trigger if exists mensagens_atualizado_em on public.mensagens;
create trigger mensagens_atualizado_em before update on public.mensagens
  for each row execute function public.tg_atualizado_em();

-- Ao criar um assunto, o dono vira membro.
create or replace function public.tg_categoria_dono_membro()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.categoria_membros (categoria_id, usuario_id, papel)
  values (new.id, new.dono_id, 'dono')
  on conflict do nothing;
  return new;
end $$;

drop trigger if exists categorias_dono_membro on public.categorias;
create trigger categorias_dono_membro after insert on public.categorias
  for each row execute function public.tg_categoria_dono_membro();

-- Nova mensagem atualiza a ordem da lista de assuntos.
create or replace function public.tg_mensagem_ultima_msg()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.categorias
     set ultima_msg_em = greatest(coalesce(ultima_msg_em, new.criado_em), new.criado_em)
   where id = new.categoria_id;
  return new;
end $$;

drop trigger if exists mensagens_ultima_msg on public.mensagens;
create trigger mensagens_ultima_msg after insert on public.mensagens
  for each row execute function public.tg_mensagem_ultima_msg();

-- ---------------------------------------------------------------------
-- 4. RLS
-- ---------------------------------------------------------------------

alter table public.usuarios_permitidos enable row level security;
alter table public.categorias          enable row level security;
alter table public.categoria_membros   enable row level security;
alter table public.mensagens           enable row level security;
alter table public.link_previews       enable row level security;

-- usuarios_permitidos: só leitura, para mostrar nomes.
drop policy if exists up_select on public.usuarios_permitidos;
create policy up_select on public.usuarios_permitidos for select to authenticated
  using (public.eh_permitido());

-- categorias
drop policy if exists cat_select on public.categorias;
create policy cat_select on public.categorias for select to authenticated
  using (public.eh_permitido() and (dono_id = auth.uid() or public.eh_membro(id)));

drop policy if exists cat_insert on public.categorias;
create policy cat_insert on public.categorias for insert to authenticated
  with check (public.eh_permitido() and dono_id = auth.uid());

drop policy if exists cat_update on public.categorias;
create policy cat_update on public.categorias for update to authenticated
  using (public.eh_permitido() and dono_id = auth.uid())
  with check (dono_id = auth.uid());

drop policy if exists cat_delete on public.categorias;
create policy cat_delete on public.categorias for delete to authenticated
  using (public.eh_permitido() and dono_id = auth.uid());

-- categoria_membros: ver os membros dos meus assuntos; alterar só a minha linha.
-- Entrar/sair é pelas funções compartilhar_categoria / sair_da_categoria.
drop policy if exists mem_select on public.categoria_membros;
create policy mem_select on public.categoria_membros for select to authenticated
  using (public.eh_permitido() and public.eh_membro(categoria_id));

drop policy if exists mem_update on public.categoria_membros;
create policy mem_update on public.categoria_membros for update to authenticated
  using (public.eh_permitido() and usuario_id = auth.uid())
  with check (usuario_id = auth.uid());

-- mensagens
drop policy if exists msg_select on public.mensagens;
create policy msg_select on public.mensagens for select to authenticated
  using (public.eh_permitido() and public.eh_membro(categoria_id));

drop policy if exists msg_insert on public.mensagens;
create policy msg_insert on public.mensagens for insert to authenticated
  with check (public.eh_permitido() and autor_id = auth.uid() and public.eh_membro(categoria_id));

drop policy if exists msg_update on public.mensagens;
create policy msg_update on public.mensagens for update to authenticated
  using (public.eh_permitido() and (autor_id = auth.uid() or public.eh_dono(categoria_id)))
  with check (public.eh_permitido() and (autor_id = auth.uid() or public.eh_dono(categoria_id)));
-- Sem policy de delete: exclusão é lógica (apagado_em).

-- link_previews: leitura para quem é permitido; escrita só pela Edge Function.
drop policy if exists lp_select on public.link_previews;
create policy lp_select on public.link_previews for select to authenticated
  using (public.eh_permitido());

-- ---------------------------------------------------------------------
-- 5. Permissões por coluna
--    O app só altera o que faz sentido. Para reenviar uma mensagem
--    criada offline, use insert ... on conflict do nothing
--    (supabase-js: upsert com ignoreDuplicates: true).
-- ---------------------------------------------------------------------

revoke all on public.usuarios_permitidos, public.categorias, public.categoria_membros,
              public.mensagens, public.link_previews from anon;

revoke update on public.categorias from authenticated;
grant  update (nome, emoji, cor) on public.categorias to authenticated;

revoke insert, update, delete on public.categoria_membros from authenticated;
grant  update (fixada, arquivada, lido_ate) on public.categoria_membros to authenticated;

revoke update, delete on public.mensagens from authenticated;
grant  update (texto, link, editado_em, apagado_em) on public.mensagens to authenticated;

revoke insert, update, delete on public.link_previews from authenticated;
revoke insert, update, delete on public.usuarios_permitidos from authenticated;

-- ---------------------------------------------------------------------
-- 6. Funções chamadas pelo app (RPC)
-- ---------------------------------------------------------------------

-- Dono compartilha um assunto com outro e-mail permitido.
-- A outra pessoa precisa ter entrado no app pelo menos uma vez.
create or replace function public.compartilhar_categoria(p_categoria uuid, p_email text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_usuario uuid;
begin
  if not public.eh_permitido() or not public.eh_dono(p_categoria) then
    raise exception 'Só o dono pode compartilhar este assunto.';
  end if;
  if not exists (select 1 from public.usuarios_permitidos where email = lower(btrim(p_email))) then
    raise exception 'Este e-mail não tem acesso ao app.';
  end if;
  select id into v_usuario from auth.users where lower(email) = lower(btrim(p_email)) limit 1;
  if v_usuario is null then
    raise exception 'Essa pessoa precisa entrar no app uma vez antes.';
  end if;
  insert into public.categoria_membros (categoria_id, usuario_id, papel)
  values (p_categoria, v_usuario, 'editor')
  on conflict do nothing;
end $$;

-- Dono tira alguém do assunto.
create or replace function public.remover_membro(p_categoria uuid, p_usuario uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.eh_permitido() or not public.eh_dono(p_categoria) then
    raise exception 'Só o dono pode remover participantes.';
  end if;
  delete from public.categoria_membros
   where categoria_id = p_categoria and usuario_id = p_usuario and papel = 'editor';
end $$;

-- Quem não é dono sai do assunto.
create or replace function public.sair_da_categoria(p_categoria uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from public.categoria_membros
   where categoria_id = p_categoria and usuario_id = auth.uid() and papel = 'editor';
end $$;

-- Move uma ou mais mensagens para outro assunto.
-- Só move as que a pessoa pode alterar (dela, ou todas se for dona do assunto de origem).
create or replace function public.mover_mensagens(p_ids uuid[], p_destino uuid)
returns int language plpgsql security definer set search_path = '' as $$
declare v_qtd int;
begin
  if not public.eh_permitido() or not public.eh_membro(p_destino) then
    raise exception 'Você não participa do assunto de destino.';
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

-- Participantes de um assunto, com nome.
create or replace function public.membros_da_categoria(p_categoria uuid)
returns table (usuario_id uuid, nome text, email text, papel text)
language sql stable security definer set search_path = '' as $$
  select m.usuario_id, coalesce(up.nome, u.email), u.email::text, m.papel
    from public.categoria_membros m
    join auth.users u on u.id = m.usuario_id
    left join public.usuarios_permitidos up on up.email = lower(u.email)
   where m.categoria_id = p_categoria
     and public.eh_permitido() and public.eh_membro(p_categoria)
   order by m.papel desc, m.adicionado_em;
$$;

-- Busca full-text. Roda com as permissões de quem chama (RLS vale).
create or replace function public.buscar_mensagens(p_q text, p_categoria uuid default null, p_limite int default 50)
returns setof public.mensagens
language sql stable security invoker set search_path = '' as $$
  select m.*
    from public.mensagens m
   where m.apagado_em is null
     and (p_categoria is null or m.categoria_id = p_categoria)
     and m.busca @@ websearch_to_tsquery('portuguese', p_q)
   order by ts_rank(m.busca, websearch_to_tsquery('portuguese', p_q)) desc, m.criado_em desc
   limit least(coalesce(p_limite, 50), 200);
$$;

revoke execute on function
  public.compartilhar_categoria(uuid, text), public.remover_membro(uuid, uuid),
  public.sair_da_categoria(uuid), public.mover_mensagens(uuid[], uuid),
  public.membros_da_categoria(uuid), public.buscar_mensagens(text, uuid, int),
  public.eh_permitido(), public.eh_membro(uuid), public.eh_dono(uuid)
from public, anon;

grant execute on function
  public.compartilhar_categoria(uuid, text), public.remover_membro(uuid, uuid),
  public.sair_da_categoria(uuid), public.mover_mensagens(uuid[], uuid),
  public.membros_da_categoria(uuid), public.buscar_mensagens(text, uuid, int),
  public.eh_permitido(), public.eh_membro(uuid), public.eh_dono(uuid)
to authenticated;

-- ---------------------------------------------------------------------
-- 7. Storage: bucket privado das thumbs
-- ---------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('thumbs', 'thumbs', false)
on conflict (id) do nothing;

drop policy if exists thumbs_select on storage.objects;
create policy thumbs_select on storage.objects for select to authenticated
  using (bucket_id = 'thumbs' and public.eh_permitido());
-- Gravação só pela Edge Function (service role ignora o RLS).

-- ---------------------------------------------------------------------
-- 8. Realtime (para assuntos compartilhados)
-- ---------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.mensagens;
    exception when duplicate_object then null;
    end;
    begin
      alter publication supabase_realtime add table public.categorias;
    exception when duplicate_object then null;
    end;
  end if;
end $$;
