-- =====================================================================
-- APP Notas — roteiro de teste da migration 005 (assunto do tipo Nota)
-- Roda num Postgres local que simula o Supabase:
--   createdb app
--   psql -d app -f supabase/testes/supabase_simulado.sql
--   psql -d app -f supabase/migrations/001_schema.sql   (e 002, 003, 004, 005)
--   psql -d app -v ON_ERROR_STOP=1 -f supabase/testes/teste_005_notas.sql
-- Cada verificação que falhar para o script com "FALHOU: …".
-- Tudo roda dentro de uma transação desfeita no fim (não deixa sujeira).
-- =====================================================================

begin;

-- Pessoas: A (dono), B (namorada, permitida), C (fora da lista)
insert into public.usuarios_permitidos (email, nome) values ('a@teste.com', 'A'), ('b@teste.com', 'B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'a@teste.com'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'b@teste.com'),
  ('cccccccc-0000-0000-0000-000000000003', 'c@teste.com');

-- Troca de usuário: imita o JWT do Supabase
create function pg_temp.como(p_id text, p_email text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_id, true),
         set_config('request.jwt.claims', json_build_object('sub', p_id, 'email', p_email)::text, true);
$$;
create function pg_temp.checa(p_ok boolean, p_msg text) returns void language plpgsql as $$
begin
  if p_ok is not true then raise exception 'FALHOU: %', p_msg; end if;
  raise notice 'ok: %', p_msg;
end $$;
grant execute on all functions in schema pg_temp to authenticated;

-- ---------------------------------------------------------------------
-- A cria uma nota e uma conversa, e compartilha a nota com B
-- ---------------------------------------------------------------------
select pg_temp.como('aaaaaaaa-0000-0000-0000-000000000001', 'a@teste.com');
set local role authenticated;

insert into public.categorias (id, nome, tipo) values
  ('11111111-0000-0000-0000-000000000001', 'Lista de compras', 'nota'),
  ('22222222-0000-0000-0000-000000000002', 'Links', 'conversa');
insert into public.categorias (id, nome) values ('33333333-0000-0000-0000-000000000003', 'Sem tipo');

select pg_temp.checa((select tipo from public.categorias where id = '33333333-0000-0000-0000-000000000003') = 'conversa',
                     'assunto sem tipo nasce como conversa');

do $$ begin
  update public.categorias set tipo = 'conversa' where id = '11111111-0000-0000-0000-000000000001';
  raise exception 'FALHOU: conseguiu trocar o tipo do assunto';
exception when insufficient_privilege then raise notice 'ok: o tipo não muda depois de criado';
end $$;

do $$ begin
  insert into public.categorias (nome, tipo) values ('X', 'planilha');
  raise exception 'FALHOU: aceitou tipo inválido';
exception when check_violation then raise notice 'ok: tipo inválido é recusado';
end $$;

select public.compartilhar_categoria('11111111-0000-0000-0000-000000000001', 'b@teste.com');

-- ---------------------------------------------------------------------
-- Gravação: só pela salvar_nota
-- ---------------------------------------------------------------------
select pg_temp.checa(not exists (select 1 from public.notas), 'nota nova não tem linha (= vazia, versão 0)');

do $$ begin
  insert into public.notas (categoria_id, conteudo) values ('11111111-0000-0000-0000-000000000001', 'x');
  raise exception 'FALHOU: insert direto em notas';
exception when insufficient_privilege then raise notice 'ok: insert direto em notas é bloqueado';
end $$;

select pg_temp.checa(s.ok and s.versao = 1 and s.conteudo is null,
                     'primeira gravação (base 0) cria a versão 1')
  from public.salvar_nota('11111111-0000-0000-0000-000000000001', E'- [ ] leite\n- [ ] pão', 0) s;

do $$ begin
  update public.notas set conteudo = 'x';
  raise exception 'FALHOU: update direto em notas';
exception when insufficient_privilege then raise notice 'ok: update direto em notas é bloqueado';
end $$;

do $$ begin
  delete from public.notas;
  raise exception 'FALHOU: delete direto em notas';
exception when insufficient_privilege then raise notice 'ok: delete direto em notas é bloqueado';
end $$;

select pg_temp.checa((select ultima_msg_em is not null from public.categorias
                       where id = '11111111-0000-0000-0000-000000000001'),
                     'salvar a nota preenche ultima_msg_em');

do $$ begin
  perform public.salvar_nota('22222222-0000-0000-0000-000000000002', 'x', 0);
  raise exception 'FALHOU: salvou nota em assunto do tipo conversa';
exception when raise_exception then
  if sqlerrm like 'FALHOU%' then raise; end if;
  raise notice 'ok: salvar_nota recusa assunto do tipo conversa (%)', sqlerrm;
end $$;

do $$ begin
  perform public.salvar_nota('11111111-0000-0000-0000-000000000001', repeat('a', 200001), 1);
  raise exception 'FALHOU: aceitou nota acima do limite';
exception when raise_exception then
  if sqlerrm like 'FALHOU%' then raise; end if;
  raise notice 'ok: limite de 200 mil caracteres (%)', sqlerrm;
end $$;

do $$ begin
  insert into public.mensagens (categoria_id, texto) values ('11111111-0000-0000-0000-000000000001', 'oi');
  raise exception 'FALHOU: mensagem dentro de nota';
exception when insufficient_privilege then raise notice 'ok: não dá para mandar mensagem num assunto do tipo nota';
end $$;

insert into public.mensagens (id, categoria_id, texto)
values ('44444444-0000-0000-0000-000000000004', '22222222-0000-0000-0000-000000000002', 'link qualquer');

do $$ begin
  perform public.mover_mensagens(array['44444444-0000-0000-0000-000000000004'::uuid], '11111111-0000-0000-0000-000000000001');
  raise exception 'FALHOU: moveu mensagem para nota';
exception when raise_exception then
  if sqlerrm like 'FALHOU%' then raise; end if;
  raise notice 'ok: mover para nota é recusado (%)', sqlerrm;
end $$;

select pg_temp.checa(public.mover_mensagens(array['44444444-0000-0000-0000-000000000004'::uuid],
                                             '33333333-0000-0000-0000-000000000003') = 1,
                     'mover entre conversas continua funcionando');

-- A abre a nota (marca como lida)
update public.categoria_membros set lido_ate = clock_timestamp()
 where categoria_id = '11111111-0000-0000-0000-000000000001' and usuario_id = auth.uid();

-- ---------------------------------------------------------------------
-- B: lê, edita, conflito de versão
-- ---------------------------------------------------------------------
reset role;
select pg_temp.como('bbbbbbbb-0000-0000-0000-000000000002', 'b@teste.com');
set local role authenticated;

select pg_temp.checa((select conteudo from public.notas) = E'- [ ] leite\n- [ ] pão',
                     'B (membro) lê a nota compartilhada');

select pg_temp.checa(exists (select 1 from public.notas_alteradas()
                              where categoria_id = '11111111-0000-0000-0000-000000000001'),
                     'para B, a nota editada por A aparece em notas_alteradas');

select pg_temp.checa(s.ok and s.versao = 2, 'B salva a partir da versão 1 → versão 2')
  from public.salvar_nota('11111111-0000-0000-0000-000000000001', E'- [x] leite\n- [ ] pão', 1) s;

-- A ainda está na versão 1 e tenta salvar: conflito
reset role;
select pg_temp.como('aaaaaaaa-0000-0000-0000-000000000001', 'a@teste.com');
set local role authenticated;

select pg_temp.checa(exists (select 1 from public.notas_alteradas()),
                     'para A, a edição de B (depois do lido_ate) aparece em notas_alteradas');

select pg_temp.checa(not s.ok and s.versao = 2 and s.conteudo = E'- [x] leite\n- [ ] pão'
                     and s.atualizado_por = 'bbbbbbbb-0000-0000-0000-000000000002',
                     'versão velha não grava e devolve o conteúdo atual')
  from public.salvar_nota('11111111-0000-0000-0000-000000000001', E'- [ ] leite\n- [ ] pão\n- [ ] café', 1) s;

select pg_temp.checa(not s.ok and s.versao = 2, 'base 0 numa nota que já existe também é conflito')
  from public.salvar_nota('11111111-0000-0000-0000-000000000001', 'outra', 0) s;

select pg_temp.checa(s.ok and s.versao = 3, 'depois do merge, A salva com a versão 2 → versão 3')
  from public.salvar_nota('11111111-0000-0000-0000-000000000001', E'- [x] leite\n- [ ] pão\n- [ ] café', 2) s;

select pg_temp.checa(not exists (select 1 from public.notas_alteradas()),
                     'a última edição foi de A: nada alterado para A');

-- Busca
select pg_temp.checa(exists (select 1 from public.buscar_notas('cafe')), 'buscar_notas acha "café" buscando "cafe"');
select pg_temp.checa(exists (select 1 from public.buscar_notas('lei')),  'buscar_notas acha pedaço de palavra');
select pg_temp.checa(not exists (select 1 from public.buscar_notas('arroz')), 'buscar_notas não inventa resultado');

-- ---------------------------------------------------------------------
-- C (fora da lista) e B depois de sair do assunto
-- ---------------------------------------------------------------------
reset role;
select pg_temp.como('cccccccc-0000-0000-0000-000000000003', 'c@teste.com');
set local role authenticated;

select pg_temp.checa(not exists (select 1 from public.notas), 'C (não permitido) não vê nenhuma nota');
select pg_temp.checa(not exists (select 1 from public.buscar_notas('leite')), 'C não acha nada na busca');
do $$ begin
  perform public.salvar_nota('11111111-0000-0000-0000-000000000001', 'hack', 3);
  raise exception 'FALHOU: C salvou a nota';
exception when raise_exception then
  if sqlerrm like 'FALHOU%' then raise; end if;
  raise notice 'ok: C não grava (%)', sqlerrm;
end $$;

reset role;
select pg_temp.como('bbbbbbbb-0000-0000-0000-000000000002', 'b@teste.com');
set local role authenticated;
select public.sair_da_categoria('11111111-0000-0000-0000-000000000001');
select pg_temp.checa(not exists (select 1 from public.notas), 'B saiu do assunto e não vê mais a nota');
do $$ begin
  perform public.salvar_nota('11111111-0000-0000-0000-000000000001', 'x', 3);
  raise exception 'FALHOU: B salvou depois de sair';
exception when raise_exception then
  if sqlerrm like 'FALHOU%' then raise; end if;
  raise notice 'ok: B não grava depois de sair (%)', sqlerrm;
end $$;

-- ---------------------------------------------------------------------
-- Excluir o assunto apaga a nota
-- ---------------------------------------------------------------------
reset role;
select pg_temp.como('aaaaaaaa-0000-0000-0000-000000000001', 'a@teste.com');
set local role authenticated;
delete from public.categorias where id = '11111111-0000-0000-0000-000000000001';
reset role;
select pg_temp.checa(not exists (select 1 from public.notas), 'excluir o assunto apaga a nota (cascade)');

select pg_temp.checa(exists (select 1 from pg_publication_tables
                              where pubname = 'supabase_realtime' and tablename = 'notas'),
                     'notas está no tempo real');

rollback;
\echo '>>> Todos os testes da 005 passaram.'
