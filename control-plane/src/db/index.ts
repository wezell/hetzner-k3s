import postgres from 'postgres';

// DATABASE_URL is loaded from .env.local by Next.js before any module code runs.
// Local dev: kubectl port-forward -n postgres svc/postgres-rw 5432:5432
// In-cluster: postgres-rw.postgres.svc.cluster.local

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is not set');
}

const sql = postgres(process.env.DATABASE_URL, {
  max: 10,
  idle_timeout: 30,
  connect_timeout: 10,
});

export default sql;
export { sql };
