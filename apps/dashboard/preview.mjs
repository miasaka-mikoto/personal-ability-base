#!/usr/bin/env node
/**
 * Tiny dependency-free static server for inspecting the source tree.
 * Use `npm run dev` for the real TypeScript/Vite preview; this helper is
 * useful in constrained environments where dependencies are not installed.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PAB_DASHBOARD_PORT ?? 4173);
const contentTypes = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".ts": "text/javascript; charset=utf-8" };

const server = createServer(async (request, response) => {
  const requestPath = request.url?.split("?")[0] ?? "/";
  const relative = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
  let filePath = normalize(join(root, relative));
  if (!filePath.startsWith(root)) {
    response.writeHead(403); response.end("Forbidden"); return;
  }
  try {
    // Browser ESM requires an extension. Resolve the extensionless import
    // emitted by TypeScript (`./adapter`) to the source file for this tiny
    // preview server.
    try { await readFile(filePath); } catch {
      if (!extname(filePath)) filePath += ".ts";
    }
    let content = await readFile(filePath);
    if (filePath.endsWith(".ts")) {
      content = Buffer.from(stripTypeScriptTypes(content.toString())
        .replace(/import\s+["']\.\/styles\.css["'];?\s*/g, "")
        .replace(/(from\s+["']\.\/[^"']+)(["'])/g, "$1.ts$2"));
    }
    response.writeHead(200, { "content-type": contentTypes[extname(filePath)] ?? "application/octet-stream", "cache-control": "no-cache" });
    response.end(content);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found. Install dependencies and use npm run dev for the TypeScript preview.");
  }
});

server.listen(port, "127.0.0.1", () => console.log(`PAB dashboard source server: http://localhost:${port}`));
