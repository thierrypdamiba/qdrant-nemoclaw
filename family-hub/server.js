import { createServer } from "http";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createConnection } from "net";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || "18789", 10);
const DAD_PORT = parseInt(process.env.DAD_PORT || "18801", 10);
const DAUGHTER_PORT = parseInt(process.env.DAUGHTER_PORT || "18802", 10);
const BABYSITTER_PORT = parseInt(process.env.BABYSITTER_PORT || "18803", 10);

const AGENTS = {
  dad: { port: DAD_PORT, token: process.env.DAD_TOKEN || "" },
  daughter: { port: DAUGHTER_PORT, token: process.env.DAUGHTER_TOKEN || "" },
  babysitter: { port: BABYSITTER_PORT, token: process.env.BABYSITTER_TOKEN || "" },
};

const hubHtml = readFileSync(join(__dirname, "index.html"), "utf-8");

async function proxy(req, res, agentName) {
  const agent = AGENTS[agentName];
  if (!agent) {
    res.writeHead(404);
    res.end("Agent not found");
    return;
  }

  const targetPath = req.url.replace(`/${agentName}`, "") || "/";
  const targetUrl = `http://127.0.0.1:${agent.port}${targetPath}`;

  try {
    const headers = { ...req.headers };
    headers.host = `127.0.0.1:${agent.port}`;
    if (agent.token) {
      headers["authorization"] = `Bearer ${agent.token}`;
    }

    const fetchOpts = {
      method: req.method,
      headers,
      redirect: "manual",
    };

    if (req.method !== "GET" && req.method !== "HEAD") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      fetchOpts.body = Buffer.concat(chunks);
    }

    const upstream = await fetch(targetUrl, fetchOpts);
    const responseHeaders = Object.fromEntries(upstream.headers.entries());
    res.writeHead(upstream.status, responseHeaders);
    const body = Buffer.from(await upstream.arrayBuffer());
    res.end(body);
  } catch (err) {
    console.error(`proxy error for ${agentName}:`, err.message);
    res.writeHead(502);
    res.end(`Proxy error: ${err.message}`);
  }
}

const server = createServer(async (req, res) => {
  const url = req.url || "/";

  if (url === "/" || url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(hubHtml);
    return;
  }

  if (url === "/health") {
    const statuses = {};
    for (const [name, agent] of Object.entries(AGENTS)) {
      try {
        const r = await fetch(`http://127.0.0.1:${agent.port}/`, {
          headers: agent.token ? { Authorization: `Bearer ${agent.token}` } : {},
          signal: AbortSignal.timeout(2000),
        });
        statuses[name] = r.ok ? "up" : `status:${r.status}`;
      } catch {
        statuses[name] = "down";
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", agents: statuses }));
    return;
  }

  const match = url.match(/^\/(dad|daughter|babysitter)(\/.*)?$/);
  if (match) {
    await proxy(req, res, match[1]);
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

// WebSocket upgrade handler
server.on("upgrade", (req, socket, head) => {
  const url = req.url || "/";
  const match = url.match(/^\/(dad|daughter|babysitter)(\/.*)?$/);
  if (!match) {
    socket.destroy();
    return;
  }

  const agent = AGENTS[match[1]];
  const targetPath = url.replace(`/${match[1]}`, "") || "/";

  const upstream = createConnection({ port: agent.port, host: "127.0.0.1" }, () => {
    const lines = [`${req.method} ${targetPath} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (req.rawHeaders[i].toLowerCase() === "host") {
        lines.push(`Host: 127.0.0.1:${agent.port}`);
      } else {
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
    }
    if (agent.token) {
      lines.push(`Authorization: Bearer ${agent.token}`);
    }
    lines.push("", "");

    upstream.write(lines.join("\r\n"));
    if (head.length) upstream.write(head);

    socket.pipe(upstream);
    upstream.pipe(socket);
  });

  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`family hub listening on http://0.0.0.0:${PORT}`);
  console.log(`  dad       -> http://127.0.0.1:${DAD_PORT}`);
  console.log(`  daughter  -> http://127.0.0.1:${DAUGHTER_PORT}`);
  console.log(`  babysitter -> http://127.0.0.1:${BABYSITTER_PORT}`);
});
