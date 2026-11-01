import { Pool } from "pg";

// One pool per process; kept on globalThis so dev-mode hot reload doesn't open new ones.
const holder = globalThis as unknown as { nakhelPool?: Pool };

export function pool(): Pool {
  if (!holder.nakhelPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    holder.nakhelPool = new Pool({
      connectionString,
      max: 10,
      connectionTimeoutMillis: 5000,
    });
  }
  return holder.nakhelPool;
}
