#!/usr/bin/env node
/**
 * E-commaxxing Interactive Setup
 *
 * Run: npm run setup
 *
 * This script will:
 *   1. Check prerequisites (Node, Wrangler, Cloudflare login)
 *   2. Ask for your configuration
 *   3. Create the D1 database (or configure MongoDB)
 *   4. Update wrangler.toml with your settings
 *   5. Push secrets to Cloudflare via `wrangler secret put`
 *   6. Run D1 migrations
 *   7. Optionally deploy the worker
 */

import { execSync, spawnSync } from "child_process";
import { createInterface } from "readline";
import { readFileSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOML_PATH = join(__dirname, "wrangler.toml");

// ─── Colours ──────────────────────────────────────────────────────────────────
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
};

const info = (msg) => console.log(`${c.cyan}ℹ${c.reset}  ${msg}`);
const success = (msg) => console.log(`${c.green}✔${c.reset}  ${msg}`);
const warn = (msg) => console.log(`${c.yellow}⚠${c.reset}  ${msg}`);
const error = (msg) => console.log(`${c.red}✖${c.reset}  ${msg}`);
const heading = (msg) => console.log(`\n${c.bold}${c.blue}${msg}${c.reset}`);
const dim = (msg) => console.log(`${c.dim}${msg}${c.reset}`);

// ─── Readline helpers ─────────────────────────────────────────────────────────
const rl = createInterface({ input: process.stdin, output: process.stdout });
const question = (q) => new Promise((resolve) => rl.question(q, resolve));

async function ask(prompt, defaultValue = "") {
  const hint = defaultValue ? ` ${c.dim}(${defaultValue})${c.reset}` : "";
  const answer = await question(`  ${prompt}${hint}: `);
  return answer.trim() || defaultValue;
}

async function askSecret(prompt) {
  process.stdout.write(`  ${prompt}: `);
  // Hide input on supported terminals.
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  return new Promise((resolve) => {
    let value = "";
    const onData = (char) => {
      const ch = char.toString();
      if (ch === "\r" || ch === "\n") {
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false);
          process.stdin.removeListener("data", onData);
        }
        process.stdout.write("\n");
        resolve(value);
      } else if (ch === "\u0003") {
        process.exit(0); // Ctrl+C
      } else if (ch === "\u007f") {
        value = value.slice(0, -1); // Backspace
      } else {
        value += ch;
      }
    };
    if (process.stdin.isTTY) {
      process.stdin.on("data", onData);
    } else {
      // Non-interactive (e.g. piped input) — read normally.
      rl.question("", (ans) => resolve(ans.trim()));
    }
  });
}

async function confirm(prompt, defaultYes = true) {
  const hint = defaultYes ? "Y/n" : "y/N";
  const answer = await ask(`${prompt} [${hint}]`);
  if (!answer) return defaultYes;
  return answer.toLowerCase().startsWith("y");
}

// ─── Shell helpers ────────────────────────────────────────────────────────────
function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: "utf8", ...opts }).trim();
  } catch (e) {
    return null;
  }
}

function runSecret(secretName, secretValue) {
  const result = spawnSync("wrangler", ["secret", "put", secretName], {
    input: secretValue,
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
  });
  return result.status === 0;
}

function generateApiKey(bytes = 32) {
  return randomBytes(bytes).toString("hex");
}

// ─── wrangler.toml helpers ────────────────────────────────────────────────────
function readToml() {
  return readFileSync(TOML_PATH, "utf8");
}

function writeToml(content) {
  writeFileSync(TOML_PATH, content, "utf8");
}

function setTomlVar(content, key, value) {
  // Replace existing [vars] key or append.
  const re = new RegExp(`^(${key}\\s*=\\s*).*$`, "m");
  if (re.test(content)) {
    return content.replace(re, `$1"${value}"`);
  }
  // Not found — append under [vars] section.
  return content.replace(/(\[vars\])/, `$1\n${key} = "${value}"`);
}

function setD1Id(content, databaseId) {
  return content.replace(
    /database_id\s*=\s*"[^"]*"/,
    `database_id = "${databaseId}"`
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(
    `\n${c.bold}${c.blue}╔══════════════════════════════════════╗${c.reset}`
  );
  console.log(
    `${c.bold}${c.blue}║   E-commaxxing — Interactive Setup   ║${c.reset}`
  );
  console.log(
    `${c.bold}${c.blue}╚══════════════════════════════════════╝${c.reset}\n`
  );

  // ── Step 1: Prerequisites ──────────────────────────────────────────────────
  heading("Step 1/6 — Checking prerequisites");

  const nodeVersion = process.version;
  success(`Node.js ${nodeVersion}`);

  const wranglerVersion = run("wrangler --version");
  if (!wranglerVersion) {
    error("Wrangler is not installed.");
    info("Install it with:  npm install -g wrangler");
    process.exit(1);
  }
  success(`Wrangler ${wranglerVersion.replace("wrangler ", "")}`);

  const whoami = run("wrangler whoami 2>&1");
  if (!whoami || whoami.includes("not authenticated") || whoami.includes("error")) {
    warn("You are not logged in to Cloudflare.");
    info("Running: wrangler login");
    execSync("wrangler login", { stdio: "inherit" });
  } else {
    success(`Logged in to Cloudflare`);
    dim(`  ${whoami.split("\n")[0]}`);
  }

  // ── Step 2: Worker name ────────────────────────────────────────────────────
  heading("Step 2/6 — Worker configuration");

  const workerName = await ask("Worker name", "e-commaxxing");
  let toml = readToml();
  toml = toml.replace(/^name\s*=\s*"[^"]*"/m, `name = "${workerName}"`);

  // ── Step 3: Database ───────────────────────────────────────────────────────
  heading("Step 3/6 — Database");

  info("Choose your database adapter:");
  console.log("  1) Cloudflare D1  — built-in SQLite, zero config (recommended)");
  console.log("  2) MongoDB Atlas   — bring your own cluster");
  const dbChoice = await ask("Enter 1 or 2", "1");
  const useD1 = dbChoice !== "2";

  if (useD1) {
    toml = setTomlVar(toml, "DB_ADAPTER", "d1");

    const dbName = await ask("D1 database name", "ecommaxxing-db");
    toml = toml.replace(/database_name\s*=\s*"[^"]*"/, `database_name = "${dbName}"`);

    info(`Creating D1 database "${dbName}"...`);
    const createOutput = run(`wrangler d1 create ${dbName} 2>&1`);

    if (!createOutput) {
      error("Failed to create D1 database. Check your Cloudflare account and try again.");
      process.exit(1);
    }

    // Parse the database_id from wrangler output.
    const idMatch = createOutput.match(/database_id\s*=\s*"([^"]+)"/);
    if (!idMatch) {
      // Maybe it already exists — try to find it.
      warn("Could not parse database ID from output. Trying to look it up...");
      const listOutput = run(`wrangler d1 list --json 2>/dev/null`);
      if (listOutput) {
        try {
          const dbs = JSON.parse(listOutput);
          const existing = dbs.find((d) => d.name === dbName);
          if (existing) {
            toml = setD1Id(toml, existing.uuid);
            success(`Found existing database: ${existing.uuid}`);
          } else {
            error("Could not find the database ID. Update wrangler.toml manually.");
            error("Look for [[d1_databases]] → database_id");
          }
        } catch {
          error("Could not parse wrangler d1 list output.");
        }
      }
    } else {
      const databaseId = idMatch[1];
      toml = setD1Id(toml, databaseId);
      success(`D1 database created: ${databaseId}`);
    }
  } else {
    toml = setTomlVar(toml, "DB_ADAPTER", "mongodb");
    info(
      "You will be prompted for your MongoDB URI (mongodb+srv://...) as a secret below."
    );
    const mongoDbName = await ask("MongoDB database name", "ecommaxxing");
    toml = setTomlVar(toml, "MONGODB_DB_NAME", mongoDbName);
  }

  // ── Step 4: CORS & CSRF ────────────────────────────────────────────────────
  heading("Step 4/6 — CORS & CSRF");

  info("CORS — which origins can call your API?");
  console.log(
    `  ${c.dim}Examples: https://myshop.com   or   https://myshop.com,https://www.myshop.com${c.reset}`
  );
  console.log(`  ${c.dim}Use * to allow all origins (not recommended for production)${c.reset}`);
  const corsOrigins = await ask("Allowed origins", "*");
  toml = setTomlVar(toml, "CORS_ORIGINS", corsOrigins);

  const enableCsrf = await confirm(
    "Enable CSRF origin check? (Recommended if your frontend uses cookies)"
  );
  toml = setTomlVar(toml, "CSRF_ENABLED", enableCsrf ? "true" : "false");

  // ── Step 5: Stripe & Admin key ────────────────────────────────────────────
  heading("Step 5/6 — Stripe & Admin API key");

  info("Stripe keys — find them at https://dashboard.stripe.com/apikeys");

  let stripeSk = "";
  while (!stripeSk.startsWith("sk_")) {
    stripeSk = await ask("Stripe Secret Key (sk_test_... or sk_live_...)");
    if (!stripeSk.startsWith("sk_")) {
      warn("That doesn't look like a Stripe secret key. Try again.");
    }
  }

  let stripePk = "";
  while (!stripePk.startsWith("pk_")) {
    stripePk = await ask("Stripe Publishable Key (pk_test_... or pk_live_...)");
    if (!stripePk.startsWith("pk_")) {
      warn("That doesn't look like a Stripe publishable key. Try again.");
    }
  }
  toml = setTomlVar(toml, "STRIPE_PUBLISHABLE_KEY", stripePk);

  info("Stripe Webhook Secret — get this from the Webhooks section of the Stripe dashboard.");
  info("If you don't have one yet, press Enter to skip (you can add it later).");
  const stripeWh = await ask("Stripe Webhook Secret (whsec_... or leave blank)");

  info("Admin API Key — used to authenticate admin routes (POST/PUT/DELETE products).");
  const generatedKey = generateApiKey();
  const adminKey = await ask(
    `Admin API Key (press Enter to auto-generate)`,
    generatedKey
  );

  // ── Step 6: Currency ──────────────────────────────────────────────────────
  heading("Step 6/6 — Finishing up");

  const currency = await ask("Default currency (ISO 4217, e.g. usd, eur, gbp)", "usd");
  toml = setTomlVar(toml, "DEFAULT_CURRENCY", currency.toLowerCase());

  // ── Write wrangler.toml ───────────────────────────────────────────────────
  writeToml(toml);
  success("wrangler.toml updated");

  // ── Push secrets to Cloudflare ────────────────────────────────────────────
  info("Pushing secrets to Cloudflare Workers...");

  const secrets = [
    ["STRIPE_SECRET_KEY", stripeSk],
    ...(stripeWh ? [["STRIPE_WEBHOOK_SECRET", stripeWh]] : []),
    ["ADMIN_API_KEY", adminKey],
  ];

  if (!useD1) {
    const mongoUri = await ask("MongoDB URI (mongodb+srv://...)");
    secrets.push(["MONGODB_URI", mongoUri]);
  }

  for (const [name, value] of secrets) {
    const ok = runSecret(name, value);
    if (ok) {
      success(`Secret set: ${name}`);
    } else {
      warn(`Failed to set secret: ${name}. Set it manually: wrangler secret put ${name}`);
    }
  }

  // ── Run D1 migrations ─────────────────────────────────────────────────────
  if (useD1) {
    const dbName = toml.match(/database_name\s*=\s*"([^"]+)"/)?.[1] ?? "ecommaxxing-db";
    info("Running D1 migrations...");
    const migResult = run(`wrangler d1 migrations apply ${dbName} 2>&1`);
    if (migResult !== null) {
      success("Migrations applied");
    } else {
      warn("Migration command failed. Run manually: npm run db:migrate");
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${c.bold}${c.green}╔═══════════════════════════════╗${c.reset}`);
  console.log(`${c.bold}${c.green}║   Setup complete!             ║${c.reset}`);
  console.log(`${c.bold}${c.green}╚═══════════════════════════════╝${c.reset}\n`);

  console.log(`${c.bold}Your Admin API Key:${c.reset}`);
  console.log(`  ${c.yellow}${adminKey}${c.reset}`);
  console.log(`${c.dim}  (Save this — it won't be shown again)${c.reset}\n`);

  console.log(`${c.bold}Next steps:${c.reset}`);
  console.log(`  1. Start local dev:  ${c.cyan}npm run dev${c.reset}`);
  console.log(`  2. Deploy to prod:   ${c.cyan}npm run deploy${c.reset}`);
  if (!stripeWh) {
    console.log(
      `  3. Add webhook:      ${c.cyan}wrangler secret put STRIPE_WEBHOOK_SECRET${c.reset}`
    );
    console.log(
      `     (After adding the endpoint in your Stripe dashboard)`
    );
  }
  console.log();

  // ── Optional deploy ───────────────────────────────────────────────────────
  const deploy = await confirm("Deploy now?", false);
  if (deploy) {
    console.log();
    execSync("wrangler deploy", { stdio: "inherit" });
  } else {
    info("Run `npm run deploy` when you're ready.");
  }

  rl.close();
}

main().catch((e) => {
  error(`Setup failed: ${e.message}`);
  process.exit(1);
});
