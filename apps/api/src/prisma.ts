import { FileBackend, MemoryBackend, PostgresBackend, asPrismaStoreClient, type StorageBackend } from "@ledgerlands/match-store";

/**
 * Resolve the match persistence backend.
 *
 * Priority: LEDGERLANDS_DATABASE_URL/DATABASE_URL (Postgres) >
 * LEDGERLANDS_DATA_DIR (file) > memory.
 *
 * Postgres requires the @prisma/client runtime plus a migrated database
 * (`npm run db:push` with DATABASE_URL set). When unavailable, resolution
 * falls back with a warning — the API always boots.
 */
export async function resolveMatchBackend(): Promise<{ backend: StorageBackend; persistence: string }> {
  const dbUrl = process.env.LEDGERLANDS_DATABASE_URL ?? process.env.DATABASE_URL;
  if (dbUrl) {
    try {
      // Non-literal specifier: resolved at runtime only, never pulled into tsc programs.
      const specifier =
        process.env.LEDGERLANDS_PRISMA_CLIENT ?? "../../../generated/prisma/client.js";
      const mod = (await import(specifier)) as {
        PrismaClient?: new (...args: unknown[]) => unknown;
      };
      if (!mod.PrismaClient) throw new Error("Generated Prisma client has no PrismaClient export.");
      const client = new mod.PrismaClient({ datasourceUrl: dbUrl });
      const backend = new PostgresBackend(asPrismaStoreClient(client));
      return { backend, persistence: "postgres" };
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(`[ledgerlands] Postgres backend unavailable (${(error as Error).message}); falling back. Run \`npm i @prisma/client\` with a live DB to enable.`);
    }
  }
  const dataDir = process.env.LEDGERLANDS_DATA_DIR;
  if (dataDir) return { backend: new FileBackend(dataDir), persistence: "file" };
  return { backend: new MemoryBackend(), persistence: "memory" };
}
