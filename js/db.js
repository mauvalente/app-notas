// Cliente do Supabase (único para o app inteiro).
import { createClient } from './vendor/supabase.js';
import { CONFIG } from '../config.js';

export const configOk = ![CONFIG.SUPABASE_URL, CONFIG.SUPABASE_PUBLISHABLE_KEY, CONFIG.GOOGLE_CLIENT_ID]
  .some(v => !v || String(v).includes('COLE-AQUI'));

export const supabase = configOk
  ? createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_PUBLISHABLE_KEY, {
      auth: {
        persistSession: true,      // sessão fica salva no aparelho
        autoRefreshToken: true,    // renova o token sozinho
        detectSessionInUrl: true,  // plano B: volta do login por redirecionamento
        flowType: 'pkce',
        storageKey: 'notas-auth',
      },
    })
  : null;
