#!/usr/bin/env node
/**
 * Serves the repo over HTTP so the live engine can fetch from it, and accepts PUTs
 * so it can hand build artifacts back. (T-8.2)
 *
 *   node tools/serve-repo.mjs
 *
 * The engine editor runs in a browser and cannot see the host filesystem, so the
 * rebuild pipeline moves files in both directions over this. It is a build-time tool
 * on localhost only: it is not part of the game, it is not in the container, and it
 * should not be left running.
 *
 * PUTs are confined to `build/` — the engine is writing generated artifacts, and
 * nothing it sends should be able to land on a source file. Paths are resolved and
 * checked against the repo root, so `..` cannot escape either.
 */
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, normalize } from "node:path";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8799;

const contentType = (p) =>
  p.endsWith(".json") ? "application/json; charset=utf-8"
  : p.endsWith(".js") || p.endsWith(".mjs") ? "text/javascript; charset=utf-8"
  : p.endsWith(".html") ? "text/html; charset=utf-8"
  : "text/plain; charset=utf-8";

createServer(async (req, res) => {
  // The editor is a different origin (:4174), so it needs CORS to reach this at all.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,PUT,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const rel = normalize(decodeURIComponent((req.url || "/").split("?")[0]));
  const abs = join(REPO, rel);
  if (!resolve(abs).startsWith(REPO)) { res.writeHead(403); return res.end("outside repo"); }

  if (req.method === "PUT") {
    if (!resolve(abs).startsWith(join(REPO, "build"))) {
      res.writeHead(403);
      return res.end("writes are confined to build/");
    }
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      try {
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, body, "utf8");
        console.log(`PUT  ${rel}  ${(body.length / 1024).toFixed(1)} KB`);
        res.writeHead(200); res.end("ok");
      } catch (err) {
        console.error(`PUT  ${rel}  ${err.message}`);
        res.writeHead(500); res.end(String(err.message));
      }
    });
    return;
  }

  try {
    const data = await readFile(abs);
    res.writeHead(200, { "Content-Type": contentType(rel) });
    res.end(data);
  } catch {
    res.writeHead(404); res.end("not found");
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`serving ${REPO}`);
  console.log(`  http://localhost:${PORT}/   (GET anywhere, PUT into build/ only)`);
  console.log(`  ctrl-c to stop — do not leave this running`);
});
