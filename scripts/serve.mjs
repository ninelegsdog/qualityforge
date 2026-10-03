/**
 * Minimal static file server for the bundled fixtures.
 *
 * Zero dependencies on purpose: a fresh clone must be able to run
 * `npm ci && npm test` without installing a web server, and without reaching
 * any third-party host. Swapping in a real product means setting BASE_URL.
 *
 * Binds to loopback only. This is a test fixture, never a production server.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../fixtures/", import.meta.url));
const PORT = Number.parseInt(process.env.FIXTURE_PORT ?? "4311", 10);
const HOST = "127.0.0.1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;

  // Contain every request inside ROOT: reject traversal before touching disk.
  const target = join(ROOT, normalize(requested));
  if (!target.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("403 Forbidden\n");
    return;
  }

  try {
    const body = await readFile(target);
    res.writeHead(200, {
      "content-type": MIME[extname(target)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("404 Not Found\n");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[fixtures] serving ${ROOT} at http://${HOST}:${PORT}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
