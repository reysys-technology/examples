const express = require("express");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const timers = require("node:timers/promises");
const { Pool } = require("pg");

const listenPort = 8080;
const outboundTimeoutMilliseconds = 5000;
const databaseReadyAttempts = 30;
const databaseRetryDelayMilliseconds = 2000;
const documentsDirectory = path.join(__dirname, "documents");

const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
});

const application = express();

application.get("/healthz", (request, response) => {
  response.json({ status: "ok" });
});

application.get("/users", async (request, response) => {
  const name = String(request.query.name ?? "");
  const statement = "SELECT id, name, email FROM users WHERE name = '" + name + "'";
  try {
    const result = await pool.query(statement);
    response.json(result.rows);
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

application.get("/fetch", async (request, response) => {
  const url = String(request.query.url ?? "");
  const [httpRequestOutcome, fetchOutcome] = await Promise.allSettled([
    requestWithHttpModule(url),
    requestWithFetch(url),
  ]);
  response.json({
    url,
    httpRequest: describeOutcome(httpRequestOutcome),
    fetch: describeOutcome(fetchOutcome),
  });
});

application.get("/file", (request, response) => {
  const name = String(request.query.name ?? "");
  const filePath = documentsDirectory + "/" + name;
  fs.readFile(filePath, "utf8", (error, contents) => {
    if (error) {
      response.status(404).json({ error: error.message });
      return;
    }
    response.type("text/plain").send(contents);
  });
});

function requestWithHttpModule(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https:") ? https : http;
    const outbound = client.request(url, { timeout: outboundTimeoutMilliseconds }, (inbound) => {
      const chunks = [];
      inbound.on("data", (chunk) => chunks.push(chunk));
      inbound.on("end", () => resolve({ status: inbound.statusCode, bodyLength: Buffer.concat(chunks).length }));
      inbound.on("error", reject);
    });
    outbound.on("timeout", () => outbound.destroy(new Error("request timed out")));
    outbound.on("error", reject);
    outbound.end();
  });
}

async function requestWithFetch(url) {
  const inbound = await fetch(url, { signal: AbortSignal.timeout(outboundTimeoutMilliseconds) });
  const body = await inbound.arrayBuffer();
  return { status: inbound.status, bodyLength: body.byteLength };
}

function describeOutcome(outcome) {
  if (outcome.status === "fulfilled") {
    return outcome.value;
  }
  return { error: outcome.reason.message };
}

function seedDocuments() {
  fs.mkdirSync(documentsDirectory, { recursive: true });
  fs.writeFileSync(path.join(documentsDirectory, "welcome.txt"), "Welcome to node-demo.\n");
  fs.writeFileSync(path.join(documentsDirectory, "notes.txt"), "Documents live under the documents directory.\n");
}

async function seedUsers() {
  await pool.query("CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL)");
  const existing = await pool.query("SELECT COUNT(*)::int AS count FROM users");
  if (existing.rows[0].count === 0) {
    await pool.query(
      "INSERT INTO users (name, email) VALUES ('alice', 'alice@example.com'), ('bob', 'bob@example.com'), ('carol', 'carol@example.com')",
    );
  }
}

async function waitForDatabaseAndSeed() {
  for (let attempt = 1; attempt <= databaseReadyAttempts; attempt += 1) {
    try {
      await seedUsers();
      return;
    } catch (error) {
      console.error("database not ready (attempt " + attempt + " of " + databaseReadyAttempts + "): " + error.message);
      await timers.setTimeout(databaseRetryDelayMilliseconds);
    }
  }
  throw new Error("database did not become ready");
}

async function start() {
  seedDocuments();
  await waitForDatabaseAndSeed();
  application.listen(listenPort, () => {
    console.log("node-demo listening on port " + listenPort);
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
