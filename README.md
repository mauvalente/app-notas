# Notas (PWA + Supabase)

App de celular, no estilo WhatsApp, para guardar links e textos organizados por assunto. Cada pessoa entra com a própria conta Google, e um assunto pode ser compartilhado com a outra pessoa.

Especificação completa em [SPEC.md](SPEC.md) e andamento em [TAREFAS.md](TAREFAS.md).

## Arquivos

| Arquivo | O que é |
|---|---|
| `index.html` | O app (por enquanto, uma página provisória que confere o `config.js`) |
| `config.js` | Endereços e chaves públicas: Supabase e Google |
| `manifest.webmanifest`, `icons/` | Instalação na tela inicial |
| `supabase/migrations/001_schema.sql` | Tabelas, regras de acesso (RLS), funções e o bucket das thumbs |
| `.github/workflows/backup.yml` | Backup semanal do banco + ping para o Supabase não pausar (vem em `ci/backup.yml`; ver o passo 1) |

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

## 6. Me avise

Quando os passos 1 a 5 estiverem prontos, me diga se:

- a página mostra "config.js preenchido ✓";
- o workflow de backup rodou verde;
- apareceu algum erro no caminho.

Aí seguimos para a **Fase 1** (casca do app) e para a **Fase 3** (login).

---

## Testar no computador

Dentro da pasta, rode `python3 -m http.server 8000` e abra `http://localhost:8000`.
