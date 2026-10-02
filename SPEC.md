# APP Notas — Especificação

App de celular (PWA) para guardar links de redes sociais, com a thumbnail, e textos curtos, organizados por assunto. A interface imita o WhatsApp: a lista de assuntos à esquerda e a conversa do assunto à direita, com o campo de digitar embaixo.

Status: rascunho v0.2 (02/10/2026) — v0.2 acrescenta o assunto do tipo **Nota** (seção 12)

---

## 1. Objetivos

- Salvar um link em poucos toques, inclusive direto do botão **Compartilhar** do Instagram, TikTok, YouTube, X etc.
- Ver cada link como um card com a thumb, o título e a descrição, e abrir a página original com um toque.
- Achar depois: por assunto e por busca de texto.
- Mesmos dados no celular e no computador, com login Google.
- Cada pessoa tem os próprios assuntos e pode compartilhar um assunto com a outra.

**Fora do escopo por enquanto:** app nativo, anexos de foto e arquivo, notificações push, lembretes, versão pública ou multiempresa.

---

## 2. Decisões de arquitetura

| Tema | Decisão | Por quê |
|---|---|---|
| Front-end | PWA em HTML, CSS e JS puro com ES modules, **sem etapa de build** | Mesmo modelo do APP de Contas: publica copiando os arquivos |
| Hospedagem | **GitHub Pages** no repositório `mauvalente/app-notas`, em `https://mauvalente.github.io/app-notas/` | Pedido do projeto; HTTPS e endereço fixo, que o login Google exige |
| Banco | **Supabase**, plano gratuito: Postgres com RLS | Banco relacional, regras de acesso no próprio banco, SDK JS |
| Arquivos | **Supabase Storage**, bucket `thumbs` | As URLs de imagem do Instagram e do Facebook expiram, então é preciso guardar uma cópia |
| Preview de links | **Supabase Edge Function** `link-preview` | O navegador não consegue ler o HTML de outro site por causa do CORS; a busca precisa ser feita num servidor |
| Login | **Google Identity Services** (botão "Fazer login com o Google") → `supabase.auth.signInWithIdToken` | Reaproveita o **mesmo cliente OAuth** do projeto Google do APP de Contas |
| Sessão | Sessão do Supabase salva no aparelho e renovada sozinha, com limite de **180 dias sem uso** | Mesmo comportamento do APP de Contas |
| Backup | Dump semanal do banco por GitHub Actions num repositório **privado** (`app-notas-backup`), que também serve de keep-alive | O plano gratuito não tem backup que se possa baixar |
| Offline | Cache em IndexedDB e fila de envio ("aguardando envio"), com IDs gerados no aparelho | Mesmo padrão do APP de Contas: reenviar nunca duplica |

### 2.1 Configuração no app (`config.js`)

Tudo o que muda entre ambientes fica num arquivo só, versionado:

```js
export const CONFIG = {
  SUPABASE_URL: 'https://<projeto>.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_…', // chave nova do Supabase (substitui a "anon key"); é pública, quem protege os dados é o RLS
  GOOGLE_CLIENT_ID: '<mesmo ID do APP de Contas>.apps.googleusercontent.com',
  SESSAO_DIAS: 180,
};
// PREVIEW_URL é derivado: SUPABASE_URL + '/functions/v1/link-preview'
```

### 2.2 Limites do plano gratuito do Supabase (conferir na hora de criar)

- Banco de 500 MB, Storage de 1 GB e cerca de 500 mil chamadas de Edge Function por mês. Sobra bastante para uso pessoal; as thumbs são o que mais ocupa (ver T5.3, compressão).
- **O projeto é pausado depois de cerca de 7 dias sem nenhum acesso.** Com uso diário isso não acontece, mas o workflow semanal (T8.3) faz um "ping" de qualquer forma.
- **Não há backup que se possa baixar no plano gratuito.** O mesmo workflow salva um `pg_dump` semanal num repositório privado.

---

## 3. Login e acesso

### 3.1 Fluxo

1. O app carrega o Google Identity Services e mostra o botão de login.
2. O Google devolve um **ID token** (JWT). O app gera um `nonce` e manda o hash dele para o Google e o valor original para o Supabase.
3. `supabase.auth.signInWithIdToken({ provider: 'google', token, nonce })` cria a sessão, com access token de 1 h e refresh token.
4. O `supabase-js` guarda a sessão no aparelho e renova o access token sozinho.
5. **Regra dos 180 dias:** o app grava `ultimoUso` a cada abertura. Se passaram mais de 180 dias, faz `signOut()` e pede login de novo.
6. **Sair desta conta** (na engrenagem) faz `signOut()` e apaga o cache local.

### 3.2 Quem pode entrar

- Tabela `usuarios_permitidos (email, nome)` com os dois e-mails.
- O RLS de todas as tabelas exige que o e-mail do JWT esteja nessa lista. Quem entrar com outra conta Google até cria um usuário no Supabase, mas não lê nem grava nada, e o app mostra "Este e-mail não tem acesso".
- Tirar um e-mail da tabela bloqueia a pessoa na hora.
- A tela de permissão OAuth continua em modo **Teste**, só com os dois e-mails como usuários de teste. É a mesma trava a mais do APP de Contas.

### 3.3 Configuração no Google Cloud (projeto já existente)

- No mesmo cliente OAuth do APP de Contas, adicionar às **Origens JavaScript autorizadas**: `https://mauvalente.github.io` e `http://localhost:8000`.
- No Supabase, em **Authentication → Providers → Google**: ativar, colar o Client ID em *Authorized Client IDs* e o Client Secret (necessário só para o fluxo por redirecionamento, que fica como plano B).

### 3.4 Login no iPhone (risco a testar cedo)

No iPhone, com o PWA instalado na tela de início, o pop-up do Google às vezes não consegue devolver o login para o app. Por isso a T3.4 testa isso logo no começo. Se falhar, o plano B é o login por redirecionamento do Supabase (`signInWithOAuth`), que usa o Client Secret e a URL de retorno `https://mauvalente.github.io/app-notas/`.

---

## 4. Modelo de dados (Postgres)

```sql
usuarios_permitidos (
  email        text primary key,          -- sempre em minúsculas
  nome         text not null
)

categorias (
  id              uuid primary key,       -- gerado no app
  dono_id         uuid not null references auth.users,
  nome            text not null,          -- sem limite de tamanho
  emoji           text,                   -- opcional, aparece como "avatar"
  cor             text,                   -- opcional
  ultima_msg_em   timestamptz,            -- ordena a lista, como no WhatsApp
  criado_em       timestamptz default now(),
  atualizado_em   timestamptz default now()
)

categoria_membros (                       -- também inclui o dono, o que simplifica o RLS
  categoria_id  uuid references categorias on delete cascade,
  usuario_id    uuid references auth.users,
  papel         text check (papel in ('dono','editor')),
  fixada        boolean default false,    -- fixar e arquivar são por pessoa
  arquivada     boolean default false,
  lido_ate      timestamptz,              -- para o contador de não lidas em assunto compartilhado
  primary key (categoria_id, usuario_id)
)

mensagens (
  id            uuid primary key,         -- gerado no app (idempotente)
  categoria_id  uuid not null references categorias on delete cascade,
  autor_id      uuid not null references auth.users,
  texto         text not null default '', -- texto bruto com marcações *negrito* _itálico_ ~riscado~ `mono`
  link          jsonb,                    -- cópia do preview no momento do envio (ver 4.1)
  criado_em     timestamptz default now(),
  editado_em    timestamptz,
  apagado_em    timestamptz,              -- exclusão lógica, para a sincronização saber que sumiu
  atualizado_em timestamptz,              -- trigger; base do sync incremental
  busca         tsvector generated always as (
                  to_tsvector('portuguese', texto || ' ' || coalesce(link->>'titulo','') || ' ' || coalesce(link->>'descricao',''))
                ) stored
)

link_previews (                           -- cache compartilhado por URL, preenchido pela Edge Function
  url_normalizada  text primary key,
  url_final        text,
  titulo           text,
  descricao        text,
  site             text,                  -- ex.: "Instagram", "youtube.com"
  imagem_path      text,                  -- caminho no bucket thumbs
  imagem_largura   int,
  imagem_altura    int,
  status           text,                  -- ok | sem_meta | bloqueado | erro
  buscado_em       timestamptz
)
```

Índices: `mensagens (categoria_id, criado_em)`, GIN em `mensagens.busca`, `categoria_membros (usuario_id)`.

### 4.1 Formato de `mensagens.link`

```json
{ "url": "https://www.instagram.com/p/XYZ/", "titulo": "...", "descricao": "...",
  "site": "Instagram", "imagem": "thumbs/ab/abcd1234.webp", "w": 1080, "h": 1080 }
```

Guardar uma cópia na mensagem, e não só uma referência ao cache, mantém a mensagem igual para sempre, mesmo que a página mude depois.

### 4.2 Regras de acesso (RLS)

- Função auxiliar `eh_permitido()`: o e-mail do JWT está em `usuarios_permitidos`.
- `categorias`: SELECT e UPDATE se a pessoa for membro; INSERT se `dono_id = auth.uid()`; DELETE só o dono.
- `categoria_membros`: SELECT se for membro da categoria; INSERT e DELETE só pelas funções abaixo.
- `mensagens`: SELECT e INSERT se for membro da categoria (e, no INSERT, `autor_id = auth.uid()`); UPDATE e DELETE pelo autor, ou pelo dono da categoria.
- `link_previews`: SELECT para quem é permitido; gravação só pela Edge Function (service role).
- Storage `thumbs`: leitura para quem está autenticado e permitido; gravação só pela Edge Function.

### 4.3 Funções (RPC, `security definer`) — implementadas em `supabase/migrations/001_schema.sql`

- `compartilhar_categoria(categoria_id, email)`: só o dono chama; o e-mail precisa estar em `usuarios_permitidos`, e a pessoa precisa já ter entrado no app uma vez; adiciona como `editor`.
- `remover_membro(categoria_id, usuario_id)`: o dono tira alguém do assunto.
- `sair_da_categoria(categoria_id)`: o editor deixa de ver o assunto.
- `mover_mensagens(ids[], nova_categoria_id)`: move uma ou mais mensagens; só move as que a pessoa pode alterar.
- `membros_da_categoria(categoria_id)`: participantes com nome e papel.
- `buscar_mensagens(q, categoria_id?, limite?)`: busca full-text (`security invoker`, então o RLS vale).
- Triggers: `ultima_msg_em` ao inserir uma mensagem; o dono vira membro ao criar um assunto; `atualizado_em` em cada update.
- Permissões por coluna: o app só consegue alterar `nome`, `emoji` e `cor` do assunto; `fixada`, `arquivada` e `lido_ate` da própria participação; e `texto`, `link`, `editado_em` e `apagado_em` da mensagem. Para reenviar uma mensagem criada offline, usa-se `insert … on conflict do nothing`.

---

## 5. Preview de links

### 5.1 Detectar o link no campo de texto

- Enquanto a pessoa digita, com espera de 400 ms, procura o **primeiro** link do texto (regex para `http(s)://…` e `www.…`).
- Achou: o campo "cresce" para cima e mostra o card de preview em modo carregando, depois com a thumb, o título, a descrição e o site. Um ✕ remove o preview dessa mensagem.
- A pessoa pode continuar escrevendo, com quebra de linha, e o preview fica.
- Se o link mudar ou for apagado do texto, o preview acompanha.

### 5.2 Edge Function `link-preview`

Entrada: `POST { url }` com o JWT do usuário. Saída: o objeto do item 4.1.

1. Confere o JWT e se o e-mail é permitido.
2. **Normaliza a URL**: tira `utm_*`, `igsh`, `si`, `fbclid` etc., e resolve encurtadores (`youtu.be`, `vm.tiktok.com`, `t.co`) seguindo os redirecionamentos.
3. Se a URL já está em `link_previews` e o registro tem menos de 30 dias, devolve o cache.
4. Busca por tipo de site, na ordem:
   - **YouTube**: oEmbed público (`youtube.com/oembed`), com thumb em `i.ytimg.com`.
   - **TikTok**: oEmbed público (`tiktok.com/oembed`).
   - **Instagram e Facebook**: oEmbed da Meta, que exige um token de app da Meta (não vamos usar; ver decisão 11.1). Tenta as meta tags OG com o user-agent de robô de preview. O Instagram costuma bloquear; nesse caso o card sai "leve", com o ícone do site, "Instagram" e a URL, e ainda funciona como link.
   - **X/Twitter**: oEmbed (`publish.twitter.com`, só texto) e, depois, as meta tags.
   - **Qualquer outro site**: baixa até cerca de 512 KB do HTML e lê `og:title`, `og:description`, `og:image`, `og:site_name`, `twitter:*`, `<title>`, `<meta name="description">` e o favicon.
5. **Thumbnail**: baixa a imagem (até 5 MB), grava em `thumbs/<hash>.<ext>` e devolve o caminho. Futuro: reduzir para no máximo 600 px em WebP (T5.3).
6. Grava no cache e responde.
7. Segurança: só `http` e `https`; bloqueia IPs internos e privados (SSRF); tempo limite de 8 s; no máximo 5 redirecionamentos.

### 5.3 Na conversa

- A bolha com link mostra primeiro o card (thumb em cima, título em negrito, descrição com no máximo 2 linhas e o domínio) e embaixo o texto.
- Tocar na bolha abre a URL numa aba nova (`target="_blank"`, `rel="noopener"`). No Android, links do Instagram, YouTube etc. abrem no app da rede social.
- Links no meio do texto também ficam clicáveis.
- A thumb carrega sob demanda (`loading="lazy"`), a partir de uma URL assinada do Storage guardada em cache.

---

## 6. Receber compartilhamentos (Share Target)

- **Android (Chrome, com o PWA instalado)**: `share_target` no `manifest.webmanifest` com `action: "./"` (o GitHub Pages não tem rota `/compartilhar`; o app detecta `?title`, `?text` e `?url`), `method: GET`, `params: { title, text, url }`. Com isso o **APP Notas aparece na lista do botão Compartilhar** do Instagram e dos outros apps.
- Ao receber: o app junta `title`, `text` e `url`. O Instagram manda o link dentro de `text`, então o app extrai a URL. Depois abre o seletor **"Salvar em…"** com a lista de assuntos, com busca e a opção de criar um assunto novo. Escolhido o assunto, abre a conversa com o campo **já preenchido e o preview carregado**, e a pessoa só complementa e envia.
- **iPhone**: o Safari não aceita Share Target em PWA. Alternativa: um **Atalho do iOS** ("Salvar no Notas") que abre `https://mauvalente.github.io/app-notas/?text=<conteúdo>` (no Safari; o login lá é separado do app da tela de início). Faz parte do MVP (T6.3). Também dá para copiar o link e colar no app.

---

## 7. Interface

### 7.1 Layout

- **Celular** (menos de 768 px): duas telas, como o WhatsApp no celular. A lista de assuntos, ao tocar num assunto, leva à conversa, com o botão ← para voltar (o voltar do Android também funciona, via `history`).
- **Tablet e computador**: duas colunas, com a lista à esquerda (cerca de 360 px) e a conversa à direita.
- Tema claro e escuro conforme o sistema, com cores inspiradas no WhatsApp mas com identidade própria.

### 7.2 Lista de assuntos

- Cada item mostra o avatar (emoji ou inicial com cor), o nome, a prévia da última mensagem (📎 + título, se for link), a data ou hora da última mensagem e o contador de não lidas (só nos compartilhados).
- Ordem: fixados primeiro, depois os de `ultima_msg_em` mais recente.
- Ícone 👥 nos assuntos compartilhados.
- No topo, uma busca que filtra por nome do assunto e que também procura no conteúdo das mensagens (ver 7.5).
- Botão flutuante **＋**: novo assunto (nome, emoji opcional e o tipo: **Conversa** ou **Nota**, ver seção 12).
- Toque longo num assunto: fixar, renomear, emoji e cor, compartilhar, arquivar e excluir. Excluir só aparece para o dono e pede confirmação com um segundo toque; num assunto de outra pessoa, no lugar dele aparece **Sair do assunto**.

### 7.3 Conversa

- Cabeçalho: ←, avatar, nome do assunto e o menu ⋮ (buscar nesta conversa, compartilhar, renomear, arquivar).
- Bolhas alinhadas à direita para as minhas mensagens. Num assunto compartilhado, as da outra pessoa ficam à esquerda com o nome dela.
- Separadores de data ("Hoje", "Ontem", "12/09/2026").
- Horário na bolha, ✏️ quando editada e 🕓 quando está "aguardando envio".
- Rolagem infinita para cima, carregando 50 mensagens por vez.

### 7.3.1 Selecionar, editar e excluir mensagens

**Modo seleção**
- Um **toque longo** numa mensagem (ou um clique com o botão direito no computador) seleciona a mensagem e entra no modo seleção.
- No modo seleção, um toque simples em outra mensagem acrescenta essa mensagem à seleção, e um toque numa mensagem já selecionada tira a seleção dela. Nesse modo, tocar na bolha **não abre o link**.
- A mensagem selecionada fica com um fundo destacado e um ✓.
- O cabeçalho da conversa é trocado por uma **barra de ações**: ✕ (sair), o contador ("2 selecionadas") e os botões **✏️ Editar**, **📋 Copiar**, **↪️ Mover** e **🗑️ Excluir**.
- O modo seleção termina com ✕, com o voltar do Android, com Esc no computador ou quando a última seleção é desmarcada.
- Num assunto compartilhado, só entram na seleção as mensagens que a pessoa pode alterar: as dela, ou todas se ela for dona do assunto.

**Editar** (habilitado só com **1** mensagem selecionada)
1. O texto da mensagem vai para o **campo de digitar**, e o modo seleção termina.
2. Acima do campo aparece uma faixa "✏️ Editando mensagem" com um ✕ para cancelar. O rascunho que estava no campo fica guardado e volta ao cancelar.
3. O preview de link segue a regra normal: se o link continuar igual, mantém o card; se mudar, busca o novo; se for apagado, some.
4. O botão ✈️ vira ✓. Ao tocar, a **mesma** mensagem é atualizada no lugar (preenche `editado_em`) e aparece o ✏️ "editada" na bolha. Não cria mensagem nova.
5. Se o texto ficar vazio e não houver preview, o ✓ fica desabilitado; para apagar, usa-se Excluir.
6. Sem internet, a edição entra na fila como as outras ações.

**Excluir** (1 ou mais mensagens selecionadas)
- Como no APP de Contas: o primeiro toque em 🗑️ troca o botão por **"Confirmar exclusão (N)"**, em vermelho, e só o segundo toque apaga. Se não houver o segundo toque em cerca de 4 s, o botão volta ao normal.
- A exclusão é lógica (`apagado_em`) e em lote: um único `update … where id in (…)`.

**Copiar** junta o texto das selecionadas, na ordem da conversa e separadas por uma linha em branco. **Mover** abre a lista de assuntos para escolher o destino (vale para 1 ou mais).

### 7.4 Campo de digitar

- `textarea` que cresce até cerca de 6 linhas.
- Botão de emoji: abre o teclado de emoji do sistema no celular; no computador, um seletor leve (T4.6).
- Marcações do WhatsApp: `*negrito*`, `_itálico_`, `~riscado~` e `` `mono` ``. No computador, Ctrl+B e Ctrl+I envolvem a seleção.
- No computador, Enter envia e Shift+Enter quebra linha. No celular, Enter quebra linha e só o botão ✈️ envia.
- O botão ✈️ só fica ativo quando há texto ou preview.
- O rascunho de cada assunto fica salvo no aparelho.

### 7.5 Busca

- Busca geral: *full-text* em português sobre o texto, o título e a descrição do link, com resultados agrupados por assunto. Tocar num resultado abre a conversa rolada até a mensagem, que fica destacada.
- Busca dentro de uma conversa: a mesma coisa, filtrada pela categoria.
- Sem internet, a busca é feita no cache local (IndexedDB), com correspondência simples.

### 7.6 Engrenagem (configurações)

- Conta logada e botão **Sair desta conta**.
- Assuntos arquivados.
- Exportar tudo em JSON (backup).
- Versão do app e botão "Procurar atualização".

---

## 8. Sincronização e offline

- **Leitura**: ao abrir, carrega do IndexedDB (instantâneo) e depois busca no Supabase o que mudou desde o último sync (`atualizado_em`, `editado_em` e `apagado_em` maiores que o último sync).
- **Escrita**: cada ação (criar assunto, enviar, editar, apagar, mover) vai para a fila local com o ID já gerado no aparelho e é enviada com `upsert`, então reenviar não duplica. Sem internet, fica como "aguardando envio".
- **Preview offline**: se enviar sem internet, a mensagem sai com o link cru, e o preview é buscado e anexado quando a conexão voltar.
- **Tempo real (opcional)**: Supabase Realtime nas tabelas `mensagens` e `categorias`, para quem estiver com o app aberto num assunto compartilhado ver a mensagem do outro na hora (T7.4).
- **Service worker**: cacheia a "casca" do app (HTML, CSS, JS, ícones e o `supabase-js`). Mesmo esquema de versão do Contas (`CACHE = 'notas-vN'`).

---

## 9. Estrutura de arquivos

```
notes/                      (repositório app-notas)
├── index.html
├── config.js               URLs e chaves públicas (seção 2.1)
├── manifest.webmanifest    inclui share_target
├── sw.js
├── css/app.css
├── js/
│   ├── main.js             inicialização e rotas (#/, #/c/<id>, /compartilhar)
│   ├── auth.js             Google Identity Services + Supabase + regra dos 180 dias
│   ├── db.js               cliente Supabase e chamadas
│   ├── vendor/supabase.js  supabase-js empacotado no repositório (sem depender de CDN)
│   ├── vendor/tiptap.js    editor da nota, empacotado uma vez (seção 12.5)
│   ├── nota.js             tela da nota: editor, salvamento, merge e tempo real (seção 12)
│   ├── mesclar.js          junta duas versões da nota linha a linha (seção 12.6)
│   ├── store.js / sync.js  cache IndexedDB e fila offline
│   ├── busca.js            busca nas mensagens (servidor/cache)
│   ├── store.js            IndexedDB, fila de envio e sync
│   ├── ui-lista.js         lista de assuntos
│   ├── ui-conversa.js      conversa e bolhas
│   ├── composer.js         campo de digitar, detecção de link e preview
│   ├── formatar.js         marcações → HTML seguro (escapa antes)
│   └── busca.js
├── icons/
├── supabase/
│   ├── migrations/001_schema.sql   tabelas, índices, RLS, funções e triggers
│   ├── migrations/002_ultimas_mensagens.sql   prévia da última mensagem na lista
│   ├── migrations/003_tempo_real_nao_lidas.sql   tempo real + não lidas
│   ├── migrations/004_busca.sql   busca sem acento e por pedaço de palavra
│   ├── migrations/005_notas.sql   assunto do tipo Nota (seção 12.3)
│   ├── testes/supabase_simulado.sql   imita o Supabase (auth, papéis, storage) num Postgres local
│   ├── testes/teste_005_notas.sql     roteiro de teste da 005
│   └── functions/link-preview/index.ts
├── ci/tiptap/                  script que gera o js/vendor/tiptap.js (esbuild)
├── ci/testes/mesclar.mjs       teste da junção de mudanças (node ci/testes/mesclar.mjs)
├── .github/workflows/backup.yml     backup semanal + keep-alive
├── README.md               passo a passo de instalação, no estilo do Contas
├── SPEC.md
└── TAREFAS.md
```

---

## 10. Segurança

- O texto nunca vira HTML direto: o app escapa tudo e só depois aplica as marcações.
- Os links abertos a partir das bolhas só aceitam `http` e `https`.
- A publishable key é pública; toda a proteção dos dados está no RLS, que precisa de teste (T2.5).
- A Edge Function valida o JWT, bloqueia SSRF e limita tamanho e tempo.
- A service role key fica só nos segredos da Edge Function, nunca no repositório.

---

## 11. Decisões tomadas (30/09/2026)

1. **Preview do Instagram**: quando o Instagram bloquear, fica o card "leve" (ícone, nome do site e URL, sem thumb). **Sem app na Meta**; a T5.5 foi descartada.
2. **iPhone**: vai ser usado, então o Atalho do iOS (T6.3) entra no MVP. Ver também o risco do login no iPhone (seção 3.4).
3. **Excluir assunto compartilhado**: só o dono pode excluir, e o assunto some para todos. As mensagens e as ligações dos membros são apagadas junto (`on delete cascade`), e o assunto deixa de aparecer para quem estava nele. Quem não é dono pode **sair** do assunto a qualquer momento.
4. **Várias URLs numa mensagem**: preview só da primeira, por enquanto.
5. **Nome do app**: **Notas**.
6. **Revisão de 30/09/2026**: backup semanal por GitHub Actions num repositório privado; o app usa a *publishable key* nova do Supabase; ícone próprio do app (balão de conversa com marcador), já em `icons/`.
7. **Assunto do tipo Nota (02/10/2026)**: editor de texto no lugar da conversa, salvo em **Markdown (GFM)** numa coluna `text`; checkbox com riscado por CSS; URL sozinha na linha vira card; editor Tiptap empacotado em `js/vendor/`; gravação só pela RPC `salvar_nota` com controle de versão e merge por linha. O tipo não muda depois de criado. Detalhes na seção 12.

---

## 12. Assunto do tipo Nota (v0.2, 02/10/2026)

Além do assunto do tipo **Conversa** (o de hoje, com bolhas), passa a existir o assunto do tipo **Nota**: ao abrir, em vez das bolhas e do campo de digitar com ✈️, a tela inteira é **um editor de texto**. O uso principal é a lista de compras: itens com checkbox, e o item marcado aparece riscado.

### 12.1 Regras gerais

- O tipo é escolhido ao criar o assunto (**＋** → nome, emoji e **Conversa** ou **Nota**) e **não muda depois**.
- Fixar, arquivar, renomear, emoji e cor, compartilhar, sair e excluir funcionam igual aos assuntos do tipo Conversa (seção 7.2).
- Uma nota por assunto. Para ter várias listas, cria-se um assunto do tipo Nota para cada uma.

### 12.2 Formato salvo: Markdown

O conteúdo fica em **Markdown no padrão do GitHub (GFM)**, numa coluna `text`. O editor mostra o texto já formatado, e a pessoa não vê os símbolos do Markdown.

| Recurso | Markdown salvo | Na tela |
|---|---|---|
| Negrito / itálico / riscado | `**texto**` / `_texto_` / `~~texto~~` | formatado |
| Lista simples / numerada | `- item` / `1. item` | lista |
| Checkbox | `- [ ] leite` / `- [x] pão` | ☐ leite / ☑ ~~pão~~ |
| Subtítulo | `## Hortifrúti` | título menor (só `##`, para separar seções da lista) |
| Link no meio do texto | `[texto](https://…)` ou a URL solta | link clicável |
| **Card de link** | uma URL **sozinha numa linha** | card com miniatura, título e site (como na bolha) |

Regras:
- **O riscado do item marcado vem do CSS**, não do texto: grava-se só `- [x] pão`, e o estilo `li[data-checked="true"]` aplica riscado e opacidade menor. Desmarcar volta ao normal sem mexer no texto.
- **Card de link**: a nota guarda só a URL; o card é montado a partir do cache `link_previews` (com a Edge Function `link-preview` se ainda não houver cache). Diferente da mensagem, a nota **não** guarda cópia do preview. Se o preview falhar, a linha aparece como link comum.
- HTML dentro do Markdown **não é aceito** (o parser roda com `html: false`). Só os nós da tabela acima existem no editor; qualquer outra coisa vira texto puro.
- Limite de tamanho: 200 mil caracteres por nota (`check` no banco).

### 12.3 Banco (migration `005_notas.sql`)

```sql
alter table categorias add column tipo text not null default 'conversa'
  check (tipo in ('conversa','nota'));
-- o app só grava `tipo` no INSERT (sem permissão de UPDATE nessa coluna)

create table notas (
  categoria_id    uuid primary key references categorias on delete cascade,
  conteudo        text not null default '' check (length(conteudo) <= 200000),
  versao          int  not null default 0,
  atualizado_por  uuid references auth.users,
  atualizado_em   timestamptz not null default now(),
  busca           tsvector generated always as (to_tsvector('portuguese', conteudo)) stored
);
create index on notas using gin (busca);
```

- **RLS**: SELECT para quem é membro do assunto. Sem INSERT, UPDATE ou DELETE direto pelo app; a gravação é só pela RPC abaixo, e a exclusão vem do `on delete cascade` do assunto.
- **Nota que ainda não existe** no banco é tratada como nota vazia com `versao = 0`. A linha nasce no primeiro salvamento; por isso criar o assunto offline continua funcionando.
- **RPC `salvar_nota(p_categoria uuid, p_conteudo text, p_versao_base int)`** (`security definer`, confere `eh_permitido()`, se a pessoa é membro e se o assunto é do tipo `nota`):
  - Se a versão no banco é igual a `p_versao_base` (ou a linha não existe e `p_versao_base = 0`), grava, faz `versao + 1`, preenche `atualizado_por` e `atualizado_em`, e devolve `{ ok: true, versao }`.
  - Se não é, **não grava** e devolve `{ ok: false, versao, conteudo, atualizado_por, atualizado_em }` com o estado atual, para o app juntar as mudanças (12.6).
  - A troca é atômica: `update … where categoria_id = … and versao = p_versao_base`.
- **Trigger**: ao salvar a nota, atualiza `categorias.ultima_msg_em`, para a ordem da lista continuar valendo.
- **RPC `buscar_notas(p_q text, p_limite int)`**: mesma lógica da `buscar_mensagens` da migration 004 (full-text + `sem_acento` com `like`), devolvendo `categoria_id`, `conteudo` e `atualizado_em`.
- **RPC `notas_alteradas()`**: assuntos do tipo Nota em que `atualizado_por` não sou eu e `atualizado_em > coalesce(lido_ate, adicionado_em)`. Serve para o ponto de "editada" na lista (12.7).
- **Tempo real**: `notas` entra na publicação `supabase_realtime`.

### 12.4 Tela da nota

- Cabeçalho igual ao da conversa (←, avatar, nome, ⋮). No ⋮: buscar na nota, compartilhar, renomear, arquivar, **Copiar tudo** (Markdown), **Desmarcar todos** e **Apagar marcados** (este com o segundo toque para confirmar, padrão do Contas).
- Abaixo do cabeçalho, o editor ocupa toda a área. Não há campo de digitar nem botão ✈️.
- **Barra de formatação**: no computador, fixa embaixo do cabeçalho; no celular, logo acima do teclado (só aparece com o editor em foco). Botões: **B**, _I_, ~~S~~, ☑ (lista de checkbox), • (lista), **T** (subtítulo) e 🔗 (link).
- **Atalhos enquanto digita**: `[ ] ` ou `[] ` no começo da linha vira checkbox; `- ` vira lista; `## ` vira subtítulo; `**…**`, `_…_` e `~~…~~` formatam. No computador: Ctrl+B, Ctrl+I, Ctrl+Shift+S (riscado) e Ctrl+Shift+9 (checkbox).
- **Checkbox**: tocar no quadradinho marca ou desmarca **sem abrir o teclado** no celular. Enter numa linha de checkbox cria outro checkbox; Enter num checkbox vazio sai da lista.
- **Colar uma URL** sozinha numa linha vazia vira card de link (12.2). Tocar no card abre o link numa aba nova; para editar a URL, toque longo no card → Editar / Remover.
- Indicador discreto no cabeçalho: "Salvando…", "Salvo", "🕓 Aguardando envio" ou "Atualizada por <nome>" (por alguns segundos, quando chega mudança da outra pessoa).

### 12.5 Editor

- **Tiptap** (sobre o ProseMirror), com as extensões StarterKit (limitada aos nós da tabela 12.2), Link, TaskList, TaskItem e Markdown (leitura e gravação de GFM), mais um nó próprio `cardLink` que vira uma URL solta numa linha ao salvar.
- O projeto não tem etapa de build, então o Tiptap entra **empacotado uma vez** num arquivo só, `js/vendor/tiptap.js` (ES module), gerado com esbuild por um script em `ci/tiptap/` (com `package.json` e versões fixas). O arquivo gerado vai para o repositório, como o `supabase-js`, e o app continua publicando só com cópia de arquivos.
- O service worker passa a cachear também o `tiptap.js`, e a versão do cache sobe.
- Versões fixas: Tiptap **3.31.4** e esbuild 0.28.2. O pacote tem cerca de 440 KB (cerca de 140 KB comprimido) e só é carregado (`import()` dinâmico) quando a pessoa abre uma nota.
- **Link → URL pura**: por padrão, o Markdown do Tiptap grava uma URL solta como `[url](url)`. O app estende o Link para gravar só a URL quando o texto é igual ao endereço, que é o formato do card (12.2).
- `<`, `>` e `&` digitados na nota ficam como `&lt;`, `&gt;` e `&amp;` no Markdown salvo (o Tiptap escapa para não virar HTML). Na tela aparecem normais, e abrir e salvar de novo não muda nada.
- **Teste**: `ci/tiptap/teste.html` roda no navegador e confere a ida e volta do Markdown (checkbox, formatação, subtítulo, listas, links, URL pura, HTML bloqueado, `javascript:` bloqueado, acentos) e o toque no checkbox. Rodar depois de cada atualização do Tiptap.

### 12.6 Salvamento, offline e conflitos

- **Salvamento automático**: 800 ms depois da última tecla, e também ao sair da nota, ao trocar de aba ou de app (`visibilitychange`) e antes de fechar.
- **Cópia local**: a nota fica no IndexedDB com `conteudo`, `versao_base` (a última versão confirmada pelo servidor) e `base_conteudo` (o texto dessa versão). Abrir a nota é instantâneo, mesmo offline.
- **Fila offline**: no máximo **um** item pendente por nota (salvar de novo substitui o anterior). Ao voltar a conexão, chama `salvar_nota` com a `versao_base`.
- **Conflito** (`ok: false`): o app junta as mudanças **por linha** (*merge* de 3 vias: a base, o meu texto e o do servidor). Como cada item da lista é uma linha, os casos comuns se resolvem sozinhos: cada um acrescenta itens diferentes, ou um marca e o outro acrescenta. Se os dois mudaram **a mesma linha** de jeitos diferentes, ficam as duas versões, uma embaixo da outra, e aparece o aviso "Algumas linhas foram editadas pelos dois — confira". Depois do merge, salva de novo com a versão nova.
- **Tempo real**: chegou mudança da outra pessoa e eu não tenho nada pendente → o editor troca o conteúdo mantendo o cursor e a rolagem o mais perto possível. Se eu tenho algo pendente → faz o merge acima.
- **Sync incremental**: `notas.atualizado_em` maior que o último sync entra no mesmo ciclo da seção 8.
- **Como ficou implementado (02/10/2026)**: a cópia local fica no IndexedDB, na tabela `kv`, com a chave `nota:<id>` e os campos `{ conteudo, base_versao, base_conteudo, pendente }`. A lista das notas com mudança não enviada fica em `notas-pendentes`. A nota não usa a fila de mensagens do `sync.js`: tem a própria, com no máximo um envio por nota. Ao abrir o app, quando a internet volta e quando o app volta para a tela, as pendentes sobem (`sincronizarPendentes`).
- **Junção (`mesclar.js`)**: duas pessoas acrescentando no mesmo ponto → entram as linhas dos dois, sem repetir. Mudanças em linhas diferentes, mesmo vizinhas → as duas valem. A mesma linha mudada de jeitos diferentes → ficam a do servidor e depois a minha, com o aviso. Nota vazia e os dois começam a escrever → os dois textos entram.

### 12.7 Lista, busca e outras telas

- **Lista de assuntos**: avatar com 📝 pequeno no canto para o tipo Nota. Prévia: o primeiro item ou linha do texto; se houver checkboxes, "☑ 3 de 10". Em vez do contador de não lidas, um **ponto** quando a outra pessoa editou a nota depois da última vez que eu a abri (`notas_alteradas()`); abrir a nota grava `lido_ate`.
- **Busca geral**: junta os resultados de `buscar_mensagens` e de `buscar_notas`. O resultado de nota mostra o trecho em volta do termo; tocar abre a nota rolada até o trecho, que fica destacado. Offline, busca na cópia local.
- **Salvar em… (compartilhamento)**: se o assunto escolhido for uma nota, a URL recebida é **acrescentada no fim** da nota, numa linha nova (vira card), e a nota abre com o cursor ali.
- **Mover mensagens**: os assuntos do tipo Nota não aparecem como destino, por enquanto.
- **Exportar tudo em JSON**: inclui as notas (`categoria_id`, `conteudo` em Markdown, `atualizado_em`).

### 12.8 Segurança

- O Markdown vira HTML só pelo schema do Tiptap: nós e marcas desconhecidos viram texto, e HTML bruto é ignorado.
- Links e cards só aceitam `http` e `https`; abrem com `target="_blank"` e `rel="noopener"`.
- O app não grava em `notas` diretamente; tudo passa pela `salvar_nota`, que confere permissão, tipo do assunto e versão.
