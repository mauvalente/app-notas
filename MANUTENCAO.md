# Notas — Manutenção

Cuidados para manter o app funcionando depois de pronto. Instalação e configuração estão no [README.md](README.md).

## Lembretes periódicos

| Quando | O quê | Como |
|---|---|---|
| **Todo ano** (o token vence 1 ano depois de criado) | Renovar o token do backup | GitHub → *Settings → Developer settings → Personal access tokens → Fine-grained* → gere um token novo igual ao anterior: só o repositório `app-notas-backup`, permissão *Contents: Read and write*. Depois, em `app-notas` → *Settings → Secrets and variables → Actions*, atualize o `BACKUP_REPO_TOKEN`. Teste em *Actions → Backup e keep-alive → Run workflow*. |
| **Se o repositório ficar 60 dias sem commit** | Reativar o backup agendado | Aparece um aviso na aba **Actions** do `app-notas` → **Enable workflow**. Qualquer commit também reinicia a contagem. |
| **De vez em quando** | Ver o espaço usado no Supabase | *Supabase → Project Settings → Usage*. No plano gratuito: 500 MB de banco e 1 GB de Storage. As thumbs (em WebP) são o que mais ocupa. |
| **De vez em quando** | Conferir se o backup está rodando | O repositório `app-notas-backup` deve ter um commit "Backup AAAA-MM-DD" toda segunda-feira. |

## Sinais de problema e o que fazer

- **E-mail do GitHub dizendo que o "Backup e keep-alive" falhou:** abra a execução em *Actions* e veja a anotação de erro. Os motivos mais comuns são:
  - token vencido: renove como na tabela acima;
  - senha do banco trocada: atualize o `SUPABASE_DB_URL` com a URI do *Session pooler* e a senha nova.
- **App mostra "Não consegui carregar" e o Supabase diz que o projeto está pausado:** abra o projeto no painel do Supabase e clique em **Restore project**. O backup semanal existe justamente para evitar a pausa, então confira também o item anterior.
- **Previews pararam de aparecer:** veja em *Supabase → Edge Functions → link-preview → Logs*. Depois de um novo deploy da função, confira se o **"Verify JWT"** continua desligado.
- **Login do Google parou:** confira, no Google Cloud, se as origens `https://mauvalente.github.io` e `http://localhost:8000` continuam no cliente OAuth e se os dois e-mails continuam como usuários de teste.

## Tarefas comuns

- **Dar acesso a mais alguém:**
  1. Supabase → *SQL Editor* → `insert into public.usuarios_permitidos (email, nome) values ('email@gmail.com', 'Nome');`
  2. Adicione o e-mail como usuário de teste no Google Cloud (*Público-alvo*).
- **Tirar o acesso de alguém:** `delete from public.usuarios_permitidos where email = 'email@gmail.com';`. O bloqueio vale na hora, mesmo para quem já estava logado.
- **Perdeu um celular:** derrube todas as sessões da pessoa no SQL Editor:
  ```sql
  delete from auth.sessions where user_id = (select id from auth.users where email = 'email@gmail.com');
  ```
  O celular perdido para de funcionar em até 1 hora, quando o acesso atual vence. Os outros aparelhos dela pedem login de novo, e os dados continuam no Supabase.
- **Publicar uma mudança no app:** aumente o número em `CACHE = 'notas-vN'` no `sw.js` antes do `git push`, para os celulares baixarem a versão nova. No celular: ⚙️ → **Procurar atualização**.
- **Atualizar o editor das notas (Tiptap):** só quando houver motivo (um bug corrigido, um recurso novo). Precisa do Node.js 18+.
  1. Em `ci/tiptap/package.json`, troque a versão de **todos** os `@tiptap/*` pelo mesmo número novo.
  2. `cd ci/tiptap && npm install && npm run build` (gera o `js/vendor/tiptap.js`).
  3. Na raiz: `python3 -m http.server 8000` e abra `http://localhost:8000/ci/tiptap/teste.html`. Tem que dar **Tudo OK**.
  4. Abra uma nota no app, aumente o `CACHE` no `sw.js` e publique.
- **Backup manual:** ⚙️ → **⬇️ Exportar meus dados (JSON)**. É bom fazer antes de mudanças grandes.

## Restaurar um backup (emergência)

Há duas cópias dos dados:

- **Backup semanal automático**, no repositório privado `app-notas-backup`:
  - `public.sql`: estrutura e dados das tabelas do app;
  - `auth_users.sql`: os usuários do login.
- **Exportação manual em JSON**, feita pela ⚙️: legível e fácil de guardar.

Restaurar num projeto novo do Supabase exige alguns passos na ordem certa: usuários primeiro, depois as tabelas, depois o bucket das thumbs e o tempo real. O roteiro exato depende do que aconteceu, então, se um dia precisar, peça ajuda com o arquivo em mãos.

As thumbs não entram em nenhum dos backups. Se um card ficar sem imagem, o texto, o título e o link continuam, e os links novos geram thumbs normalmente.
