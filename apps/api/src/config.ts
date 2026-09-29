function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required server setting ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  host: process.env.HOST ?? '0.0.0.0',
  databaseUrl: process.env.DATABASE_URL ?? '',
  redisUrl: process.env.REDIS_URL ?? '',
  supabaseUrl: process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL ?? '',
  jwksUrl: process.env.SUPABASE_JWKS_URL ?? '',
  issuer: process.env.SUPABASE_ISSUER ?? '',
  audience: process.env.SUPABASE_AUDIENCE ?? 'authenticated',
  opsAdmins: new Set((process.env.OPS_ADMIN_USER_IDS ?? '').split(',').map((value) => value.trim()).filter(Boolean)),
  get ready() { return Boolean(this.databaseUrl && this.redisUrl && this.supabaseUrl); },
};

export function assertConfigured() {
  required('DATABASE_URL');
  required('REDIS_URL');
  if (!config.supabaseUrl) throw new Error('Missing required server setting SUPABASE_URL');
}
