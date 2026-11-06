import postgres from 'postgres';
import { env } from './env';

export const sql = postgres(env.DATABASE_URL, { max: 5, onnotice: () => {} });
