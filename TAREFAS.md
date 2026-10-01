# APP Notas — Tarefas

Detalhes de cada item no [SPEC.md](SPEC.md). Os marcados com ⭐ formam o **MVP**: login, assuntos, mensagens com preview e receber do botão Compartilhar do Android.

## Fase 0 — Preparação (passos seus no README)
- [x] ⭐ **T0.1** Criar o repositório `mauvalente/app-notas`, ligar o GitHub Pages (branch `main`, raiz) e confirmar a URL `https://mauvalente.github.io/app-notas/`
- [x] ⭐ **T0.2** Criar o projeto no Supabase (região São Paulo) e anotar a URL e a publishable key — recriado em São Paulo
- [x] ⭐ **T0.3** Google Cloud: no cliente OAuth do APP de Contas, adicionar as origens `https://mauvalente.github.io` e `http://localhost:8000`
- [x] ⭐ **T0.4** Supabase: ativar o provedor Google com o mesmo Client ID
- [x] ⭐ **T0.5** Criar o `config.js` (SPEC 2.1); falta preencher os valores (README, passos 2 e 4)
- [x] **T0.6** Ícone do app (`icons/`) + página provisória para testar o Pages

## Fase 1 — Casca do PWA — pronta e testada no Android e no iPhone
- [x] ⭐ **T1.1** `index.html`, `manifest.webmanifest`, ícones e `sw.js` (base do Contas, adaptada para o subcaminho `/app-notas/`)
- [x] ⭐ **T1.2** Layout responsivo: duas telas no celular e duas colunas no computador; rotas `#/` e `#/c/<id>`; voltar do Android
- [x] **T1.3** Tema claro e escuro

## Fase 2 — Banco (Supabase) — aplicado no projeto de São Paulo
- [x] ⭐ **T2.1** Migration `001_schema.sql`: tabelas e índices (SPEC 4)
- [x] ⭐ **T2.2** RLS em todas as tabelas + `eh_permitido()` (SPEC 4.2)
- [x] ⭐ **T2.3** RPCs `compartilhar_categoria`, `sair_da_categoria` e `mover_mensagem` (SPEC 4.3)
- [x] ⭐ **T2.4** Trigger `ultima_msg_em`; e o dono é inserido em `categoria_membros` ao criar um assunto
- [x] ⭐ **T2.5** Roteiro de teste do RLS (testado num Postgres local que simula o Supabase; repetir no projeto real depois do login): um e-mail não permitido não vê nada; um editor não apaga o assunto; ninguém lê assunto dos outros

## Fase 3 — Login — pronto e testado no computador, no Android e no iPhone
- [x] ⭐ **T3.1** Botão do Google Identity Services, `signInWithIdToken` com nonce
- [x] ⭐ **T3.2** Aviso "Este e-mail não tem acesso" para e-mails fora da lista
- [x] ⭐ **T3.4** Testar o login no iPhone com o app instalado; se o pop-up falhar, fazer o plano B por redirecionamento (SPEC 3.4)
- [x] ⭐ **T3.3** Regra dos 180 dias sem uso + **Sair desta conta** na engrenagem

## Fase 4 — Assuntos e mensagens — pronta e testada
- [x] ⭐ **T4.1** Lista de assuntos: criar, renomear, emoji e cor, fixar, arquivar, excluir; ordem por última mensagem
- [x] ⭐ **T4.2** Conversa: bolhas, separadores de data, horário, rolagem infinita para cima
- [x] ⭐ **T4.3** Campo de digitar: textarea que cresce, botão ✈️, regras de Enter, rascunho por assunto
- [x] ⭐ **T4.4** `formatar.js`: `*negrito*`, `_itálico_`, `~riscado~`, `` `mono` ``, links clicáveis, sempre com HTML escapado
- [x] ⭐ **T4.5** Modo seleção (toque longo e toques seguintes) + barra de ações no cabeçalho (SPEC 7.3.1)
- [x] ⭐ **T4.7** Editar: só com 1 selecionada, o texto vai para o campo de digitar, faixa "Editando", ✓ atualiza a mesma mensagem
- [x] ⭐ **T4.8** Excluir 1 ou mais com o segundo toque para confirmar (padrão do Contas), em lote
- [x] **T4.9** Copiar e mover as mensagens selecionadas
- [x] **T4.6** Ctrl+B e Ctrl+I prontos; seletor de emoji próprio dispensado (Windows: Win + . / Mac: Ctrl + Cmd + Espaço abrem o do sistema)

## Fase 5 — Preview de links — pronta e testada
- [x] ⭐ **T5.1** Edge Function `link-preview`: JWT, normalização de URL, leitura de OG, meta tags e `<title>`, cache em `link_previews`, proteção SSRF e limites
- [x] ⭐ **T5.2** Baixar a thumb para o bucket `thumbs` + URLs assinadas no app
- [x] ⭐ **T5.4** Casos especiais: oEmbed do YouTube e do TikTok, X, encurtadores; card "leve" quando o site bloquear
- [x] ⭐ **T5.6** Preview no campo de digitar: detecção do link com espera, carregando, ✕ para remover, acompanha a edição do texto
- [x] ⭐ **T5.7** Card na bolha (thumb, título, descrição, domínio), com a bolha inteira clicável
- [x] **T5.3** Reduzir as thumbs (no máximo 600 px, WebP) para economizar Storage
- [x] ~~**T5.5** App na Meta + oEmbed oficial do Instagram~~ — descartada: fica o card leve

## Fase 6 — Receber compartilhamentos — pronta e testada (Android e iPhone)
- [x] ⭐ **T6.1** `share_target` no manifest (abre `./?title&text&url`) e o app extrai a URL de `text`
- [x] ⭐ **T6.2** Tela "Salvar em…": escolher ou criar o assunto e abrir a conversa com o texto e o preview prontos
- [x] ⭐ **T6.3** Atalho do iOS "Salvar no Notas" + instruções de instalação no README

## Fase 7 — Sincronização, offline e compartilhamento — pronta e testada
- [x] **T7.1** Cache em IndexedDB e sync incremental (o que mudou desde o último sync)
- [x] **T7.2** Fila de envio offline ("aguardando envio"); preview buscado quando a conexão voltar
- [x] **T7.3** Compartilhar um assunto com a outra pessoa (UI da RPC); ícone 👥; "Sair do assunto" para quem não é dono; a exclusão pelo dono remove o assunto para todos
- [x] **T7.4** Supabase Realtime nos assuntos compartilhados
- [x] **T7.5** Contador de não lidas (`lido_ate`)

## Fase 8 — Busca e acabamento — pronta; publicar e testar (README, passo 11)
- [x] **T8.1** Busca geral (full-text) e dentro da conversa, com salto até a mensagem destacada
- [x] **T8.2** Exportar tudo em JSON (backup)
- [x] **T8.3** GitHub Actions: backup semanal (`pg_dump` num repositório privado) + ping para o Supabase não pausar — rodou OK em 01/10/2026
- [x] **T8.4** README com o passo a passo de instalação e de cada fase
- [x] **T8.5** Teste em aparelho real: instalar no Android, compartilhar do Instagram, YouTube e TikTok, uso offline, login depois de reinstalar

## Ordem sugerida
0 → 2 → 3 → 1 → 4 → 5 → 6 (MVP pronto) → 7 → 8
