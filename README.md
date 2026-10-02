# Notas (PWA + Supabase)

App de celular, no estilo WhatsApp, para guardar links e textos organizados por assunto. Cada pessoa entra com a própria conta Google, e um assunto pode ser compartilhado com a outra pessoa.

Especificação completa em [SPEC.md](SPEC.md), andamento em [TAREFAS.md](TAREFAS.md) e cuidados do dia a dia em [MANUTENCAO.md](MANUTENCAO.md).

## Arquivos

| Arquivo | O que é |
|---|---|
| `index.html`, `css/app.css` | Telas do app: login, lista de assuntos, conversa, configurações |
| `js/main.js` | Inicialização, lista de assuntos, menu do assunto e rotas (`#/` lista, `#/c/<id>` conversa) |
| `js/conversa.js` | Mensagens, campo de digitar, preview de links, seleção, editar, excluir, copiar e mover |
| `js/formatar.js`, `js/preview.js`, `js/util.js` | Negrito/itálico/links, chamadas ao preview e às thumbs, utilitários |
| `js/store.js`, `js/sync.js` | Cache no aparelho (IndexedDB) e fila de envio offline |
| `js/busca.js` | Busca nas mensagens (servidor ou, sem internet, o cache) |
| `js/auth.js` | Login Google → Supabase, plano B por redirecionamento, regra dos 180 dias |
| `js/db.js`, `js/vendor/supabase.js` | Cliente do Supabase (biblioteca guardada no próprio repositório, sem depender de CDN) |
| `config.js` | Endereços e chaves públicas: Supabase e Google |
| `manifest.webmanifest`, `icons/` | Instalação na tela inicial |
| `sw.js` | Service worker: abre rápido e funciona offline. Ao publicar mudanças, aumente `CACHE = 'notas-vN'` |
| `supabase/migrations/001_schema.sql` | Tabelas, regras de acesso (RLS), funções e o bucket das thumbs |
| `supabase/migrations/002_ultimas_mensagens.sql` | Prévia da última mensagem de cada assunto na lista |
| `supabase/migrations/003_tempo_real_nao_lidas.sql` | Tempo real para assuntos compartilhados + contador de não lidas |
| `supabase/migrations/004_busca.sql` | Busca sem acento e por pedaço de palavra (texto, título, descrição e endereço do link) |
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

✅ Concluído e testado.

## 9. Salvar pelo botão Compartilhar (Fase 6)

**1. Publicar:**

```bash
cd ~/Web/mav/notes
git add -A
git commit -m "Fase 6: receber do botão Compartilhar"
git push
```

**2. Android** — o Android só lê a lista de "apps para compartilhar" quando o app é instalado:

1. Desinstale o Notas (toque longo no ícone → Desinstalar). Os dados não se perdem: ficam no Supabase.
2. Abra https://mauvalente.github.io/app-notas/ no Chrome → ⋮ → **Instalar app** → entre.
3. No Instagram: num post ou reel, toque em **Compartilhar** (avião de papel) → role até **Mais** / **Compartilhar via…** → **Notas**.
4. Abre a tela **"Salvar em…"**: escolha o assunto (ou **＋ Novo assunto**). A conversa abre com o link no campo e o preview carregando; complete se quiser e toque em enviar.

**3. iPhone** — o Safari não deixa o app aparecer no Compartilhar, então criamos um Atalho:

1. Abra o app **Atalhos** → **＋** (novo atalho).
2. Toque no nome no topo → **Renomear** → `Salvar no Notas`. (Se quiser, troque o ícone.)
3. Toque em **ⓘ** (Detalhes) → ligue **Mostrar na Folha de Compartilhamento** → em tipos, deixe só **URLs** e **Texto** → OK.
4. No bloco *"Receber … da Folha de Compartilhamento"*, toque em **Se não houver entrada** → **Obter da Área de Transferência**. (Assim, com um link copiado, dá para rodar o atalho direto.)
5. Adicione a ação **Codificar URL** (em inglês: *URL Encode*). Ela já usa a *Entrada do Atalho*.
6. Adicione a ação **URL** e escreva `https://mauvalente.github.io/app-notas/?text=` — logo depois do `=`, toque em **Variável** e escolha **Texto Codificado em URL**.
7. Adicione a ação **Abrir URLs** → **OK**.

Para usar: no Instagram → **Compartilhar** → role a fileira de baixo → **Salvar no Notas**.

> O Atalho abre o Notas **no Safari**, não no ícone da tela de início (o iPhone não deixa abrir um app da web pelo atalho). Na primeira vez, entre com o Google no Safari; depois fica salvo por 180 dias como no app.

**4. Teste:** compartilhe um reel do Instagram, um vídeo do YouTube e uma página do navegador. Em cada um: "Salvar em…" → escolher assunto → enviar. Me conte se o link chegou certo e se o preview apareceu.

✅ Concluído e testado.

## 10. Compartilhar assunto, tempo real e offline (Fase 7)

**1. Banco:** SQL Editor → cole `supabase/migrations/003_tempo_real_nao_lidas.sql` → **Run**.

**2. Publicar:**

```bash
cd ~/Web/mav/notes
git add -A
git commit -m "Fase 7: compartilhar assunto, tempo real, não lidas e offline"
git push
```

No celular: ⚙️ → **Procurar atualização** (ou feche e abra o app).

**3. Teste com ela** (ela precisa ter entrado no app pelo menos uma vez):

1. No seu celular, **toque longo num assunto** (ou ⋮ dentro dele) → **👥 Compartilhar** → **Adicionar** ao lado do nome dela.
2. No celular dela, o assunto aparece sozinho na lista (com 👥) — sem precisar recarregar.
3. Ela manda uma mensagem: **com o assunto aberto**, aparece na hora na sua tela; **com ele fechado**, aparece o contador verde na lista. Ao abrir, o contador zera.
4. Ela consegue editar/apagar só as mensagens dela. Você, como dono, pode apagar qualquer uma.
5. Para tirar alguém: 👥 Compartilhar → **Remover** (pede um segundo toque). Ela também pode sair por conta própria (toque longo → **Sair do assunto**).

**4. Teste offline:**

1. Abra um assunto com internet (assim ele fica guardado no aparelho).
2. Ligue o **modo avião** → aparece o aviso "Sem internet" no topo.
3. Escreva e envie uma mensagem com um link: ela aparece com 🕓. Apague ou edite outra.
4. Feche e abra o app ainda no modo avião: os assuntos e as mensagens continuam lá.
5. Desligue o modo avião: o 🕓 some, o preview do link aparece, e no computador tudo chega igual.

> Sem internet não dá para: criar/renomear/arquivar assuntos, mover mensagens e compartilhar. O app avisa.

✅ Concluído e testado.

## 11. Busca, backup e thumbs menores (Fase 8)

**1. Banco:** SQL Editor → cole `supabase/migrations/004_busca.sql` → **Run**.

**2. Edge Function** (thumbs reduzidas para no máximo 600 px em WebP):

1. Supabase → **Edge Functions** → `link-preview` → aba **Code**.
2. Apague tudo, cole o conteúdo novo de `supabase/functions/link-preview/index.ts` → **Deploy**.
3. Confira que **"Verify JWT"** continua **desligado**.

> As thumbs já guardadas continuam como estão; só as novas saem reduzidas.

**3. Publicar:**

```bash
cd ~/Web/mav/notes
git add -A
git commit -m "Fase 8: busca, exportar JSON e thumbs menores"
git push
```

**4. Teste:**

1. Na lista, digite no campo **Buscar** um pedaço de palavra, sem acento (ex.: `acuc` acha "açúcar"). Abaixo dos assuntos aparece **Mensagens** com os trechos marcados. Toque num resultado: abre a conversa já na mensagem, que pisca.
2. Dentro de uma conversa: **🔍** no topo → busca só naquele assunto (também acha pelo título do link).
3. Sem internet, a busca procura no que está guardado no aparelho (avisa no título).
4. ⚙️ → **⬇️ Exportar meus dados (JSON)**: baixa `notas-backup-AAAA-MM-DD.json` com todos os assuntos e mensagens.
5. Envie um link novo com imagem grande e confira que o preview continua aparecendo normal.

> Para conferir a redução: Supabase → **Storage** → `thumbs` → as imagens mais novas terminam em **.webp** e têm poucas dezenas de KB. Links de notícia (g1, UOL, Folha…) costumam ter imagens de 1200 px — bons para testar.

✅ Concluído e testado.

---

## Testar no computador

Dentro da pasta, rode `python3 -m http.server 8000` e abra `http://localhost:8000`.
