import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginLogger } from "../api.js";
import type { CheckpointEngine } from "./checkpoint-engine.js";
import type { CheckpointStore } from "./store.js";

const API_PREFIX = "/plugins/checkpoint/api/";
const VIEWER_PREFIX = "/plugins/checkpoint/";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWER_DIR = path.join(__dirname, "viewer");

export function createCheckpointHttpHandler(params: {
  store: CheckpointStore;
  engine: CheckpointEngine;
  logger?: PluginLogger;
}) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const parsed = parseRequestUrl(req.url);
    if (!parsed) {
      return false;
    }

    const pathname = parsed.pathname;

    // API routes
    if (pathname.startsWith(API_PREFIX)) {
      return await handleApiRequest(req, res, pathname, parsed.searchParams, params);
    }

    // Viewer static assets
    if (pathname === VIEWER_PREFIX || pathname === `${VIEWER_PREFIX}index.html`) {
      return await serveViewerFile(req, res, "index.html");
    }
    if (pathname === `${VIEWER_PREFIX}styles.css`) {
      return await serveViewerFile(req, res, "styles.css");
    }
    if (pathname === `${VIEWER_PREFIX}app.js`) {
      return await serveViewerFile(req, res, "app.js");
    }

    return false;
  };
}

async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  searchParams: URLSearchParams,
  params: { store: CheckpointStore; engine: CheckpointEngine; logger?: PluginLogger },
): Promise<boolean> {
  const apiPath = pathname.slice(API_PREFIX.length);
  const parts = apiPath.split("/").filter(Boolean);

  try {
    // GET /api/sessions
    if (parts[0] === "sessions" && !parts[1] && req.method === "GET") {
      const agentId = searchParams.get("agentId") ?? undefined;
      const sessions = await params.engine.listSessions(agentId);
      respondJson(res, 200, { sessions });
      return true;
    }

    // GET /api/sessions/:sessionId?agentId=...
    if (parts[0] === "sessions" && parts[1] && req.method === "GET") {
      const sessionId = parts[1];
      const agentId = searchParams.get("agentId") ?? "main";
      const checkpoints = await params.engine.listCheckpoints(agentId, sessionId);
      respondJson(res, 200, { checkpoints });
      return true;
    }

    // GET /api/checkpoints/:id?agentId=...&sessionId=...
    if (parts[0] === "checkpoints" && parts[1] && !parts[2] && req.method === "GET") {
      const checkpointId = parts[1];
      const agentId = searchParams.get("agentId") ?? "main";
      const sessionId = searchParams.get("sessionId");
      if (!sessionId) {
        respondJson(res, 400, { error: "sessionId query parameter required" });
        return true;
      }
      const meta = await params.store.getCheckpoint(agentId, sessionId, checkpointId);
      if (!meta) {
        respondJson(res, 404, { error: "Checkpoint not found" });
        return true;
      }
      respondJson(res, 200, { checkpoint: meta });
      return true;
    }

    // GET /api/checkpoints/:id/diff?agentId=...&sessionId=...&workspaceDir=...
    if (parts[0] === "checkpoints" && parts[1] && parts[2] === "diff" && req.method === "GET") {
      const checkpointId = parts[1];
      const agentId = searchParams.get("agentId") ?? "main";
      const sessionId = searchParams.get("sessionId");
      const workspaceDir = searchParams.get("workspaceDir");
      if (!sessionId || !workspaceDir) {
        respondJson(res, 400, { error: "sessionId and workspaceDir query parameters required" });
        return true;
      }
      const diff = await params.engine.getCheckpointDiff(
        agentId,
        sessionId,
        checkpointId,
        workspaceDir,
      );
      respondJson(res, 200, { diff });
      return true;
    }

    // POST /api/checkpoints/:id/restore
    if (parts[0] === "checkpoints" && parts[1] && parts[2] === "restore" && req.method === "POST") {
      const checkpointId = parts[1];
      const body = await readBody(req);
      const agentId = String(body.agentId ?? "main");
      const sessionId = body.sessionId ? String(body.sessionId) : undefined;
      const workspaceDir = body.workspaceDir ? String(body.workspaceDir) : undefined;
      const scope = body.scope as import("./types.js").RestoreScope | undefined;

      if (!sessionId || !workspaceDir) {
        respondJson(res, 400, { error: "sessionId and workspaceDir required in body" });
        return true;
      }

      const result = await params.engine.restoreCheckpoint({
        agentId,
        sessionId,
        checkpointId,
        workspaceDir,
        scope,
      });
      respondJson(res, 200, { result });
      return true;
    }

    respondJson(res, 404, { error: "Not found" });
    return true;
  } catch (error) {
    params.logger?.warn(`Checkpoint API error: ${String(error)}`);
    respondJson(res, 500, { error: String(error) });
    return true;
  }
}

async function serveViewerFile(
  req: IncomingMessage,
  res: ServerResponse,
  fileName: string,
): Promise<boolean> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    respondText(res, 405, "Method not allowed");
    return true;
  }

  try {
    const filePath = path.join(VIEWER_DIR, fileName);
    const content = await fs.readFile(filePath, "utf8");

    const contentType = fileName.endsWith(".html")
      ? "text/html; charset=utf-8"
      : fileName.endsWith(".css")
        ? "text/css; charset=utf-8"
        : fileName.endsWith(".js")
          ? "application/javascript; charset=utf-8"
          : "text/plain; charset=utf-8";

    res.statusCode = 200;
    setHeaders(res, contentType);
    if (req.method === "HEAD") {
      res.end();
    } else {
      res.end(content);
    }
    return true;
  } catch {
    respondText(res, 404, "File not found");
    return true;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseRequestUrl(rawUrl?: string): URL | null {
  if (!rawUrl) {
    return null;
  }
  try {
    return new URL(rawUrl, "http://127.0.0.1");
  } catch {
    return null;
  }
}

function respondJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  setHeaders(res, "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function respondText(res: ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  setHeaders(res, "text/plain; charset=utf-8");
  res.end(body);
}

function setHeaders(res: ServerResponse, contentType: string): void {
  res.setHeader("cache-control", "no-store, max-age=0");
  res.setHeader("content-type", contentType);
  res.setHeader("x-content-type-options", "nosniff");
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}
