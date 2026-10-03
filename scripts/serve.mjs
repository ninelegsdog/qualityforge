/**
 * Minimal web server for the bundled demo app.
 *
 * Zero dependencies on purpose: a fresh clone must be able to run
 * `npm ci && npm test` without installing a web server and without reaching
 * any third-party host. Pointing BASE_URL at a real product is the supported
 * alternative.
 *
 * Binds to loopback only. This is a test fixture, never a production server.
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../fixtures/", import.meta.url));
/** ROOT always carries a trailing separator, so prefix matching is sound. */
const ROOT_PREFIX = ROOT.endsWith(sep) ? ROOT : ROOT + sep;
const PORT = Number.parseInt(process.env.FIXTURE_PORT ?? "4311", 10);
const HOST = "127.0.0.1";

/** Clean URLs: extension-less paths map to real files. */
const ROUTES = {
  "/": "index.html",
  "/docs": "docs.html",
  "/contact": "contact.html",
};

/** Sample payload for the entity list on the overview page. */
const ITEMS = [
  { id: "AUTH-001", name: "sign-in with valid credentials" },
  { id: "AUTH-003", name: "reset password link expires" },
  { id: "CART-002", name: "remove item updates total" },
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

/**
 * Resolve a URL path to a file inside ROOT, or null if it escapes or is absent.
 * Traversal is rejected here, before any disk access happens.
 *
 * @param {string} pathname
 * @returns {Promise<string | null>}
 */
async function resolveInRoot(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null; // malformed percent-encoding
  }

  const relative = normalize(decoded)
    .replace(/^(\.\.[/\\])+/, "")
    .replace(/^[/\\]+/, "");
  const target = join(ROOT, relative);

  // Defence in depth: even after normalization the result must stay under ROOT.
  if (!target.startsWith(ROOT_PREFIX)) {
    return null;
  }

  const candidates = [target];
  if (!extname(target)) {
    candidates.push(`${target}.html`);
  }

  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) {
        return candidate;
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "cache-control": "no-store", ...headers });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  const pathname = url.pathname;

  try {
    // Deliberately broken endpoint. Exists so the evidence pipeline can be
    // exercised against a real 500 later; never linked from the UI.
    if (pathname === "/boom") {
      return send(res, 500, "internal error\n", { "content-type": "text/plain; charset=utf-8" });
    }

    if (pathname === "/api/items") {
      return send(res, 200, JSON.stringify(ITEMS), {
        "content-type": "application/json; charset=utf-8",
      });
    }

    const mapped = ROUTES[pathname] ?? pathname.replace(/^\/+/, "");
    const file = await resolveInRoot(mapped === "" ? "index.html" : mapped);

    if (file === null) {
      return send(res, 404, "404 Not Found\n", { "content-type": "text/plain; charset=utf-8" });
    }

    const body = await readFile(file);
    return send(res, 200, body, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
    });
  } catch (error) {
    // Fail loudly: a fixture server that swallows errors turns a broken test
    // run into a confusing one.
    console.error("[fixtures] request failed:", error);
    if (!res.headersSent) {
      return send(res, 500, "internal error\n", { "content-type": "text/plain; charset=utf-8" });
    }
    return res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[fixtures] serving ${ROOT} at http://${HOST}:${PORT}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
