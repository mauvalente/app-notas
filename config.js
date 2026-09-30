// Configuração do APP Notas.
// Tudo aqui é público por natureza: quem protege os dados é o RLS do Supabase.
// Preencha seguindo o README (passos 2 e 4).
export const CONFIG = {
  APP_NOME: 'Notas',

  // Supabase → Project Settings → API Keys / Data API
  SUPABASE_URL: 'https://COLE-AQUI.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_COLE-AQUI',

  // Mesmo ID do cliente OAuth do APP de Contas (Google Cloud → Clientes)
  GOOGLE_CLIENT_ID: 'COLE-AQUI.apps.googleusercontent.com',

  // Por quantos dias sem abrir o app o login continua valendo
  SESSAO_DIAS: 180,
};

// Derivado: endereço da Edge Function que gera os previews dos links
CONFIG.PREVIEW_URL = CONFIG.SUPABASE_URL + '/functions/v1/link-preview';
