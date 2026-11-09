// Phase 0 spike: dump node-sql-parser's AST for one small DDL per dialect into
// test/ast-samples/<dialect>.json. The parser module is written against these.
// Run: npx tsx scripts/ast-spike.ts
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import nsp from "node-sql-parser";

const { Parser } = nsp;

const samples: Record<string, string[]> = {
  PostgreSQL: [
    `CREATE TABLE public.users (id SERIAL PRIMARY KEY, email VARCHAR(255) NOT NULL UNIQUE, created_at TIMESTAMP DEFAULT now(), score NUMERIC(10,2))`,
    `CREATE TABLE posts (id INT, user_id INT NOT NULL REFERENCES users(id), title TEXT, PRIMARY KEY (id), UNIQUE (title), CONSTRAINT fk_u FOREIGN KEY (user_id) REFERENCES users (id))`,
    `ALTER TABLE posts ADD CONSTRAINT fk_x FOREIGN KEY (user_id) REFERENCES users (id)`,
    `CREATE VIEW v AS SELECT u.id, u.email AS mail, p.* FROM users u JOIN posts p ON p.user_id = u.id`,
  ],
  MySQL: [
    "CREATE TABLE `users` (`id` INT AUTO_INCREMENT PRIMARY KEY, `email` VARCHAR(255) NOT NULL UNIQUE) ENGINE=InnoDB",
    "CREATE TABLE posts (id INT, user_id INT, PRIMARY KEY (id), FOREIGN KEY (user_id) REFERENCES users(id))",
    "ALTER TABLE posts ADD CONSTRAINT fk_x FOREIGN KEY (user_id) REFERENCES users (id)",
  ],
  MariaDB: [
    "CREATE TABLE users (id INT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(255) NOT NULL UNIQUE)",
    "CREATE TABLE posts (id INT, user_id INT, PRIMARY KEY (id), FOREIGN KEY (user_id) REFERENCES users(id))",
  ],
  SQLite: [
    "CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE)",
    "CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), FOREIGN KEY (user_id) REFERENCES users(id))",
  ],
  TransactSQL: [
    "CREATE TABLE dbo.users (id INT IDENTITY(1,1) PRIMARY KEY, email NVARCHAR(255) NOT NULL UNIQUE)",
    "CREATE TABLE posts (id INT, user_id INT, CONSTRAINT pk_posts PRIMARY KEY (id), CONSTRAINT fk_u FOREIGN KEY (user_id) REFERENCES users(id))",
  ],
  BigQuery: [
    "CREATE TABLE `proj.ds.users` (id INT64 NOT NULL, email STRING, tags ARRAY<STRING>)",
  ],
};

const outDir = join(import.meta.dirname, "..", "test", "ast-samples");
mkdirSync(outDir, { recursive: true });
const parser = new Parser();
for (const [database, stmts] of Object.entries(samples)) {
  const out = stmts.map((sql) => {
    try {
      return { sql, ast: parser.astify(sql, { database }) };
    } catch (e) {
      return { sql, error: (e as Error).message };
    }
  });
  writeFileSync(join(outDir, `${database.toLowerCase()}.json`), JSON.stringify(out, null, 2) + "\n");
  process.stderr.write(`${database}: ${out.filter((o) => "error" in o).length} errors\n`);
}
