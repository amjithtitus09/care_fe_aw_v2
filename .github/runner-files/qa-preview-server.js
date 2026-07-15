// Zero-dependency static + reverse-proxy server for the gh-aw Visual QA workflow.
//
// It serves the built care_fe SPA (history fallback to index.html) on a single
// port AND reverse-proxies the API paths to the care backend running on the same
// runner. Because the browser only ever talks to one origin (the QA port), the
// SPA's API calls are same-origin — no CORS, and the sandboxed agent browser only
// needs the single firewall-allowed port (80) to reach both the UI and the API.
//
// Configuration (all optional, via env):
//   QA_BUILD_DIR     directory of the built SPA            (default: ./build)
//   QA_PORT          port to listen on                     (default: 80)
//   QA_BACKEND_HOST  backend host to proxy API calls to    (default: 127.0.0.1)
//   QA_BACKEND_PORT  backend port to proxy API calls to    (default: 9000)
//   QA_CARE_DIR      care backend checkout (compose project) (default: ./care)
//
// It forwards bytes between the browser and the local backend, and exposes ONE
// extra endpoint for QA data seeding:
//
//   POST /__qa_seed   body = a Python script (<=256KB). The server pipes it into
//                     `docker compose exec -T backend python manage.py shell` in
//                     the care backend container (ORM depth the agent's sandbox
//                     cannot reach) and returns the combined stdout+stderr, with a
//                     final line `QA-SEED-EXIT: <code>`. Non-POST -> 405.
//
//   TRUST MODEL: this runs arbitrary Python, but ONLY against the EPHEMERAL fixture
//   backend on a THROWAWAY runner that is torn down after the job — the same trust
//   domain as the fixture superuser REST token the QA agent already holds. The
//   server binds a firewall-restricted port; nothing here is a production system and
//   no secrets are handled. The bridge lets QA decide and seed the exact data state
//   the PR under test needs, at QA time.

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const BUILD = path.resolve(process.env.QA_BUILD_DIR || "build");
const PORT = parseInt(process.env.QA_PORT || "80", 10);
const BK = {
  host: process.env.QA_BACKEND_HOST || "127.0.0.1",
  port: parseInt(process.env.QA_BACKEND_PORT || "9000", 10),
};
const CARE_DIR = path.resolve(process.env.QA_CARE_DIR || "care");
const SEED_PATH = "/__qa_seed";
const SEED_MAX_BYTES = 256 * 1024;
const SEED_TIMEOUT_MS = 120000;

// Anything under these prefixes is proxied to the backend; everything else is a
// static asset or an SPA route.
const PROXY_PREFIXES = ["/api", "/ws", "/static", "/media"];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
};

function isProxied(url) {
  return PROXY_PREFIXES.some(
    (p) => url === p || url.startsWith(p + "/") || url.startsWith(p + "?"),
  );
}

function proxy(req, res) {
  const opts = {
    host: BK.host,
    port: BK.port,
    method: req.method,
    path: req.url,
    // Rewrite Host so Django's ALLOWED_HOSTS accepts the forwarded request
    // (the browser's Host is the QA origin, which the backend doesn't know).
    headers: { ...req.headers, host: BK.host + ":" + BK.port },
  };
  const upstream = http.request(opts, (r) => {
    res.writeHead(r.statusCode || 502, r.headers);
    r.pipe(res);
  });
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("backend proxy error");
  });
  req.pipe(upstream);
}

// QA-env shim, injected into served HTML. This preview runs on an INSECURE http origin
// (http://host.docker.internal), where Chromium exposes a missing/partial
// navigator.mediaDevices — so any media-aware code (e.g. a livekit-style plugin calling
// mediaDevices.addEventListener) crashes pages that work fine on production https. That is
// an environment defect, not an app defect: feature-detect and fill ONLY the gaps so real
// browsers are unaffected and real app bugs still surface.
const QA_ENV_SHIM =
  "<script>(function(){try{var md=navigator.mediaDevices;" +
  'if(!md){md={};try{Object.defineProperty(navigator,"mediaDevices",{value:md,configurable:true});}catch(e){}}' +
  'if(typeof md.addEventListener!=="function"){md.addEventListener=function(){};}' +
  'if(typeof md.removeEventListener!=="function"){md.removeEventListener=function(){};}' +
  'if(typeof md.enumerateDevices!=="function"){md.enumerateDevices=function(){return Promise.resolve([]);};}' +
  'if(typeof md.getUserMedia!=="function"){md.getUserMedia=function(){return Promise.reject(new Error("getUserMedia unavailable in QA env"));};}' +
  "}catch(e){}})();</script>";

function sendFile(filePath, res) {
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("not found");
    }
    const type = MIME[path.extname(filePath)] || "application/octet-stream";
    if (type.startsWith("text/html")) {
      const html = buf.toString("utf8");
      const shimmed = html.includes("<head>")
        ? html.replace("<head>", "<head>" + QA_ENV_SHIM)
        : QA_ENV_SHIM + html;
      res.writeHead(200, { "content-type": type });
      return res.end(shimmed);
    }
    res.writeHead(200, { "content-type": type });
    res.end(buf);
  });
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const filePath = path.join(BUILD, urlPath);
  // Guard against path traversal outside the build dir.
  if (!filePath.startsWith(BUILD)) {
    res.writeHead(403, { "content-type": "text/plain" });
    return res.end("forbidden");
  }
  fs.stat(filePath, (err, st) => {
    if (!err && st.isFile()) return sendFile(filePath, res);
    // SPA history fallback.
    sendFile(path.join(BUILD, "index.html"), res);
  });
}

// ── QA seed bridge ─────────────────────────────────────────────────────────
// Pipe a Python script (request body) into the backend container's manage.py
// shell and stream the result back. Decided at QA time by the QA agent.
function handleSeed(req, res) {
  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on("data", (c) => {
    size += c.length;
    if (size > SEED_MAX_BYTES) {
      aborted = true;
      res.writeHead(413, { "content-type": "text/plain" });
      res.end("QA-SEED-EXIT: 1\nseed script too large (>256KB)");
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => {
    if (aborted) return;
    const script = Buffer.concat(chunks);
    if (!script.length) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("QA-SEED-EXIT: 1\nempty seed script");
      return;
    }
    if (!fs.existsSync(CARE_DIR)) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`QA-SEED-EXIT: 1\ncare dir not found at ${CARE_DIR}`);
      return;
    }
    // Mirror the Makefile's load-fixtures: bare `docker compose exec` from inside
    // the care project dir (the -f override alone fails compose model validation).
    const child = spawn(
      "docker",
      ["compose", "exec", "-T", "backend", "python", "manage.py", "shell"],
      { cwd: CARE_DIR },
    );
    const out = [];
    let done = false;
    const finish = (code, extra) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (extra) out.push(Buffer.from(extra));
      if (!res.headersSent) res.writeHead(200, { "content-type": "text/plain" });
      out.push(Buffer.from(`\nQA-SEED-EXIT: ${code}\n`));
      res.end(Buffer.concat(out));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(124, "\n[qa-seed] timed out after 120s");
    }, SEED_TIMEOUT_MS);
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => out.push(d));
    child.on("error", (e) => finish(1, `\n[qa-seed] spawn error: ${e.message}`));
    child.on("close", (code) => finish(code == null ? 1 : code));
    child.stdin.write(script);
    child.stdin.end();
  });
  req.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("QA-SEED-EXIT: 1\nrequest error");
    }
  });
}

const server = http.createServer((req, res) => {
  const urlPath = (req.url || "/").split("?")[0];
  if (urlPath === SEED_PATH) {
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "text/plain", allow: "POST" });
      return res.end("QA-SEED-EXIT: 1\nuse POST with a Python script body");
    }
    return handleSeed(req, res);
  }
  if (isProxied(req.url || "/")) return proxy(req, res);
  serveStatic(req, res);
});

// Best-effort WebSocket upgrade proxying (some flows open a socket).
server.on("upgrade", (req, socket, head) => {
  if (!isProxied(req.url || "/")) return socket.destroy();
  const opts = {
    host: BK.host,
    port: BK.port,
    method: req.method,
    path: req.url,
    headers: { ...req.headers, host: BK.host + ":" + BK.port },
  };
  const upstream = http.request(opts);
  upstream.on("upgrade", (upRes, upSocket, upHead) => {
    const head2 =
      "HTTP/1.1 101 Switching Protocols\r\n" +
      Object.entries(upRes.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\r\n") +
      "\r\n\r\n";
    socket.write(head2);
    if (upHead && upHead.length) upSocket.unshift(upHead);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
  });
  upstream.on("error", () => socket.destroy());
  if (head && head.length) upstream.write(head);
  upstream.end();
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `[qa-preview-server] serving ${BUILD} on :${PORT}, proxying ${PROXY_PREFIXES.join(
      ",",
    )} -> ${BK.host}:${BK.port}`,
  );
});
