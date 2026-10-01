// Configuração do APP Notas.
// Tudo aqui é público por natureza: quem protege os dados é o RLS do Supabase.
// Preencha seguindo o README (passos 2 e 4).
export const CONFIG = {
  APP_NOME: 'Notas',

  // Supabase → Project Settings → API Keys / Data API
  SUPABASE_URL: 'https://gcmvcbvuntxusospqanb.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_GCtatjCJjfYy1bz-UWZ88Q_FkVViHVt',

  // Mesmo ID do cliente OAuth do APP de Contas (Google Cloud → Clientes)
  GOOGLE_CLIENT_ID: '773722587678-lltru94iku8jb7er3jgbk0glatrtfieh.apps.googleusercontent.com',

  // Por quantos dias sem abrir o app o login continua valendo
  SESSAO_DIAS: 180,
};

// Derivado: endereço da Edge Function que gera os previews dos links
CONFIG.PREVIEW_URL = CONFIG.SUPABASE_URL + '/functions/v1/link-preview';
