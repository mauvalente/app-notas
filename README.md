# Notas (PWA + Supabase)

App de celular, no estilo WhatsApp, para guardar links e textos organizados por assunto. Cada pessoa entra com a própria conta Google, e um assunto pode ser compartilhado com a outra pessoa.

Especificação completa em [SPEC.md](SPEC.md) e andamento em [TAREFAS.md](TAREFAS.md).

## Arquivos

| Arquivo | O que é |
|---|---|
| `index.html`, `css/app.css` | Telas do app: login, lista de assuntos, conversa, configurações |
| `js/main.js` | Inicialização, lista de assuntos, menu do assunto e rotas (`#/` lista, `#/c/<id>` conversa) |
| `js/conversa.js` | Mensagens, campo de digitar, preview de links, seleção, editar, excluir, copiar e mover |
| `js/formatar.js`, `js/preview.js`, `js/util.js` | Negrito/itálico/links, chamadas ao preview e às thumbs, utilitários |
| `js/auth.js` | Login Google → Supabase, plano B por redirecionamento, regra dos 180 dias |
| `js/db.js`, `js/vendor/supabase.js` | Cliente do Supabase (biblioteca guardada no próprio repositório, sem depender de CDN) |
| `config.js` | Endereços e chaves públicas: Supabase e Google |
| `manifest.webmanifest`, `icons/` | Instalação na tela inicial |
| `sw.js` | Service worker: abre rápido e funciona offline. Ao publicar mudanças, aumente `CACHE = 'notas-vN'` |
| `supabase/migrations/001_schema.sql` | Tabelas, regras de acesso (RLS), funções e o bucket das thumbs |
| `supabase/migrations/002_ultimas_mensagens.sql` | Prévia da última mensagem de cada assunto na lista |
| `supabase/functions/link-preview/index.ts` | Edge Function que lê título, descrição e imagem dos links e guarda a thumb |
| `.github/workflows/backup.yml` | Backup semanal do banco + ping para o Supabase não pausar |

---

# O que você precisa fazer (Fase 0)

Siga na ordem. Anote os valores marcados com 📝, porque vão para o `config.js` ou para os segredos do GitHub.

## 1. GitHub: repositório e Pages

1. Crie o repositório **`app-notas`** em https://github.com/new:
   - **Público**. O GitHub Pages gratuito exige isso, e nenhum dado seu fica no repositório: os dados ficam no Supabase.
   - Sem README, sem .gitignore e sem licença (os arquivos já estão aqui).
2. No terminal, dentro desta pasta. A primeira linha move o workflow para o lugar certo: eu não tenho permissão para gravar direto em `.github/`.
   ```bash
   cd ~/Web/mav/notes
   mkdir -p .github/workflows && mv ci/backup.yml .github/workflows/ && rmdir ci
   git init -b main
   git add .
   git commit -m "Fase 0: estrutura, esquema do banco e página provisória"
   git remote add origin git@github.com:mauvalente/app-notas.git
   git push -u origin main
   ```
3. No repositório: **Settings → Pages → Build and deployment**:
   - Source: **Deploy from a branch**
   - Branch: **main**, pasta **/ (root)** → Save
4. Em um ou dois minutos, abra 📝 **https://mauvalente.github.io/app-notas/**. Deve aparecer "Notas — Em construção", com uma lista do que falta no `config.js`.

## 2. Supabase: criar o projeto

1. Entre em https://supabase.com/dashboard (dá para entrar com o GitHub) → **New project**:
   - Name: `app-notas`
   - Database password: gere uma e **guarde num gerenciador de senhas** (vai no passo 5)
   - Region: **South America (São Paulo)**
   - Plano: Free
2. Quando terminar de criar, pegue:
   - 📝 **Project URL**, em *Project Settings → Data API*, no formato `https://xxxx.supabase.co`
   - 📝 **Publishable key**, em *Project Settings → API Keys*, no formato `sb_publishable_...`. É a chave nova que substitui a antiga "anon key". **Não** use a *secret key* no app.
3. Cole esses dois valores no `config.js` (`SUPABASE_URL` e `SUPABASE_PUBLISHABLE_KEY`).

## 3. Supabase: criar as tabelas

1. **SQL Editor → New query**, cole o conteúdo inteiro de `supabase/migrations/001_schema.sql` e clique em **Run**. Deve terminar com "Success. No rows returned".
2. Em outra query, cadastre quem pode entrar (e-mails em minúsculas):
   ```sql
   insert into public.usuarios_permitidos (email, nome) values
     ('mau.valente@gmail.com', 'Maurício'),
     ('EMAIL-DELA@gmail.com',  'NOME-DELA');
   ```
3. Confira em **Table Editor**: devem existir `usuarios_permitidos`, `categorias`, `categoria_membros`, `mensagens` e `link_previews`. Em **Storage**, deve existir o bucket `thumbs`, privado.

## 4. Login com Google

**No Google Cloud** (https://console.cloud.google.com), no **mesmo projeto do APP de Contas**:

1. **APIs e serviços → Credenciais** (ou *Google Auth Platform → Clientes*) → abra o cliente OAuth que o Contas já usa.
2. Em **Origens JavaScript autorizadas**, adicione:
   - `https://mauvalente.github.io`
   - `http://localhost:8000` (se ainda não estiver lá)
3. Em **URIs de redirecionamento autorizados**, adicione 📝 `https://xxxx.supabase.co/auth/v1/callback`, com o seu Project URL. Serve para o plano B do login no iPhone.
4. Copie:
   - 📝 **ID do cliente**: vai no `config.js` (`GOOGLE_CLIENT_ID`) e no Supabase
   - 📝 **Chave secreta do cliente**: vai só no Supabase, nunca no repositório
5. Em **Público-alvo**, confirme que os dois e-mails estão como usuários de teste.

**No Supabase:**

6. **Authentication → Sign In / Providers → Google** → ative:
   - **Client IDs**: o ID do cliente
   - **Client Secret**: a chave secreta
   - Deixe "Skip nonce check" **desligado**
   - Save
7. **Authentication → URL Configuration**:
   - Site URL: `https://mauvalente.github.io/app-notas/`
   - Redirect URLs: adicione `https://mauvalente.github.io/app-notas/**` e `http://localhost:8000/**`

Depois de preencher o `config.js`, faça um commit e um push:

```bash
git add config.js && git commit -m "Preenche config.js" && git push
```

Recarregue https://mauvalente.github.io/app-notas/. Deve aparecer **"config.js preenchido ✓"**.

## 5. Backup semanal e keep-alive

O plano gratuito do Supabase não guarda backups que você consiga baixar, e pausa o projeto depois de cerca de 7 dias sem acesso. O workflow `.github/workflows/backup.yml` resolve os dois: toda segunda-feira ele "pinga" o projeto e salva um dump do banco num repositório **privado**.

1. Crie o repositório **`app-notas-backup`**, **Privado**, **marcando "Add a README file"** (ele não pode estar vazio).
2. Crie um token só para isso: https://github.com/settings/personal-access-tokens/new
   - Nome: `app-notas-backup`; validade: 1 ano (anote para renovar)
   - Repository access: **Only select repositories** → `app-notas-backup`
   - Permissions → Repository → **Contents: Read and write**
   - 📝 Copie o token (`github_pat_...`)
3. Pegue a conexão do banco: no Supabase, botão **Connect** (no topo) → **Session pooler** → copie a URI e troque `[YOUR-PASSWORD]` pela senha do passo 2. 📝 Use a do **Session pooler**, porque o GitHub Actions não acessa a conexão direta.
4. No repositório **app-notas**: **Settings → Secrets and variables → Actions → New repository secret**, e crie:

   | Nome | Valor |
   |---|---|
   | `SUPABASE_URL` | Project URL |
   | `SUPABASE_PUBLISHABLE_KEY` | Publishable key |
   | `SUPABASE_DB_URL` | URI do Session pooler, com a senha |
   | `BACKUP_REPO_TOKEN` | o token `github_pat_...` |

5. Teste: aba **Actions → Backup e keep-alive → Run workflow**. Deve ficar verde, e o `app-notas-backup` deve ganhar `public.sql` e `auth_users.sql`.

> O GitHub desliga workflows agendados de repositórios públicos que ficam **60 dias sem nenhum commit**. Se aparecer o aviso, é só reativar na aba Actions. Enquanto estivermos desenvolvendo, isso não acontece.

## 6. Recriar o projeto do Supabase em São Paulo

O primeiro projeto ficou nos EUA (`us-west-2`). Como ainda está vazio, vale recriá-lo em São Paulo:

1. No projeto antigo: **Project Settings → General → Delete project**.
2. Crie o novo seguindo o **passo 2**, com Region **South America (São Paulo)**. Confira: a URI do Session pooler (botão **Connect**) deve conter `sa-east-1`.
3. Atualize o `config.js` com o **novo** Project URL e a **nova** Publishable key.
4. Refaça o **passo 3** inteiro (SQL + `insert` dos e-mails).
5. **Passo 4**:
   - Google Cloud: troque o URI de redirecionamento antigo pelo novo `https://NOVO.supabase.co/auth/v1/callback`. As origens e o Client ID não mudam.
   - Supabase novo: refaça os itens 6 (provedor Google) e 7 (URL Configuration).
6. **Passo 5**: no GitHub, atualize os segredos `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` e `SUPABASE_DB_URL`. O token não muda. Rode o **Run workflow** para conferir.

## 7. Publicar e testar o login (Fases 1 e 3)

```bash
cd ~/Web/mav/notes
git add -A
git commit -m "Fases 1 e 3: casca do app e login"
git push
```

Em um ou dois minutos:

1. **No computador**, abra https://mauvalente.github.io/app-notas/ → **Fazer login com o Google** → deve abrir a lista de assuntos (vazia). Toque em **＋**, crie um assunto e confira se ele aparece na lista e abre à direita.
2. **No Android** (Chrome): abra o endereço → menu ⋮ → **Instalar app** → abra pelo ícone e entre.
3. **No iPhone** (Safari): abra o endereço → Compartilhar → **Adicionar à Tela de Início** → abra pelo ícone e entre.
   - Se o botão do Google não fizer nada, ou abrir uma janela que não volta para o app, use o link **"Problemas para entrar? Entrar pelo navegador"**. Me conte qual dos dois funcionou (tarefa T3.4).
4. Faça um teste com um e-mail que **não** está na lista: deve aparecer "O e-mail … não tem acesso a este app".
5. Na ⚙️: **Sair desta conta** pede um segundo toque e volta para o login.

✅ Concluído em 01/10/2026 (computador, Android e iPhone).

## 8. Mensagens e preview de links (Fases 4 e 5)

**1. Banco:** no Supabase, **SQL Editor → New query**, cole `supabase/migrations/002_ultimas_mensagens.sql` → **Run**.

**2. Edge Function** (é ela que busca o título e a thumb dos links):

1. No Supabase: **Edge Functions → Deploy a new function → Via Editor**.
2. Nome: **`link-preview`** (exatamente assim).
3. Apague o exemplo, cole o conteúdo inteiro de `supabase/functions/link-preview/index.ts` → **Deploy function**.
4. Na função criada, aba **Details** (ou *Settings*): **desligue "Verify JWT with legacy secret"** (ou "Enforce JWT verification") e salve. A própria função confere o login e a lista de e-mails; com a verificação antiga ligada, os projetos novos recusam o pedido.

> Alternativa pelo terminal (opcional): `npx supabase login` e depois `npx supabase functions deploy link-preview --no-verify-jwt --project-ref SEU-ID`.

**3. Publicar o app:**

```bash
cd ~/Web/mav/notes
git add -A
git commit -m "Fases 4 e 5: mensagens, preview de links, seleção, editar e excluir"
git push
```

No celular, se o app não mudar sozinho: ⚙️ → **Procurar atualização** (ou feche e abra de novo).

**4. Roteiro de teste:**

1. Abra um assunto e envie um texto com `*negrito*`, `_itálico_` e `~riscado~`.
2. Cole um link do **YouTube**: o campo deve mostrar o card com a thumb em 1 ou 2 segundos. Envie e toque na bolha: deve abrir o vídeo.
3. Repita com um link de **notícia/site comum** e um do **Instagram** (pelo botão Compartilhar → Copiar link). No Instagram, o card pode vir "leve" (sem thumb) — combinado.
4. Cole um link e toque no **✕** do preview: a mensagem vai sem card.
5. **Toque longo** numa mensagem → barra de seleção. Toque em outras para marcar mais.
   - Com 1 selecionada: **✏️ Editar** → o texto desce para o campo → altere → **✓**. A bolha mostra "editada".
   - Com 2 ou mais: o ✏️ fica apagado. **🗑️** pede um segundo toque ("Excluir N?").
   - **📋 Copiar** e **↪️ Mover** para outro assunto.
   - O **voltar** do Android sai da seleção sem sair da conversa.
6. Na lista, **toque longo num assunto** (ou ⋮ dentro da conversa): fixar, renomear/emoji, arquivar, excluir. Os arquivados ficam em ⚙️ → *Assuntos arquivados*.

Me conte o que funcionou e o que não funcionou (de preferência com print). Se algum link não gerar preview, mande o link para eu ver.

---

## Testar no computador

Dentro da pasta, rode `python3 -m http.server 8000` e abra `http://localhost:8000`.
