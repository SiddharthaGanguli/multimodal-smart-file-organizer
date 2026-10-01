// Development only: serve the same static files that production hosts on HTTPS.
// Bind only to loopback, serve an explicit file list, and never log request data.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ALLOWED_EXTENSION_ORIGINS } from "./config.js";

const host = "127.0.0.1";
const port = 8765;
const files = new Map([
  ["/", ["picker.html", "text/html; charset=utf-8"]],
  ["/picker.html", ["picker.html", "text/html; charset=utf-8"]],
  ["/picker.js", ["picker.js", "text/javascript; charset=utf-8"]],
  ["/config.js", ["config.js", "text/javascript; charset=utf-8"]],
]);
const server = createServer(async (request, response) => {
  if (request.headers.host !== `${host}:${port}`) { response.writeHead(403); response.end(); return; }
  if (!["GET", "HEAD"].includes(request.method)) { response.writeHead(405); response.end(); return; }
  if (request.url === "/health") {
    response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(request.method === "HEAD" ? undefined : JSON.stringify({
      service: "filewise-picker-bridge", protocol: 1, pid: process.pid,
      serverPath: fileURLToPath(import.meta.url),
    }));
    return;
  }
  const entry = files.get(request.url);
  if (!entry) { response.writeHead(404); response.end(); return; }
  try {
    const body = await readFile(new URL(entry[0], import.meta.url));
    response.writeHead(200, {
      "Content-Type": entry[1], "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": `frame-ancestors ${ALLOWED_EXTENSION_ORIGINS.join(" ")}`,
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch { response.writeHead(500); response.end("Picker helper file could not be loaded."); }
});
server.on("error", (error) => {
  console.error(error.code === "EADDRINUSE" ? "Port 8765 is already in use. Check whether the Filewise Picker helper is already running." : "Could not start the Filewise Picker helper.");
  process.exitCode = 1;
});
server.listen(port, host, () => console.log(`Filewise Picker helper: http://${host}:${port}/picker.html (local development only)`));
