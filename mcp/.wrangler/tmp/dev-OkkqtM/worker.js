var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// protocol.js
var PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
var ok = /* @__PURE__ */ __name((id, result) => ({ jsonrpc: "2.0", id, result }), "ok");
var fail = /* @__PURE__ */ __name((id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } }), "fail");
function createMcpServer({ info, instructions, tools, prompts = [] }) {
  const toolsByName = new Map(tools.map((t) => [t.name, t]));
  const promptsByName = new Map(prompts.map((p) => [p.name, p]));
  return /* @__PURE__ */ __name(async function handle(message) {
    if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") {
      return fail(message?.id ?? null, -32600, "Invalid request");
    }
    if (message.method === void 0 || message.id === void 0 || message.id === null) return null;
    const { id, method, params = {} } = message;
    switch (method) {
      case "initialize":
        return ok(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
          serverInfo: info,
          instructions
        });
      case "ping":
        return ok(id, {});
      case "tools/list":
        return ok(id, {
          tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations }))
        });
      case "tools/call": {
        const tool = toolsByName.get(params.name);
        if (!tool) return fail(id, -32602, `Unknown tool: ${params.name}`);
        try {
          const result = await tool.run(params.arguments ?? {});
          const text2 = typeof result === "string" ? result : JSON.stringify(result, null, 2);
          return ok(id, { content: [{ type: "text", text: text2 }] });
        } catch (err) {
          return ok(id, { content: [{ type: "text", text: `Error: ${err?.message ?? err}` }], isError: true });
        }
      }
      case "prompts/list":
        return ok(id, { prompts: prompts.map(({ name, title, description, arguments: args }) => ({ name, title, description, arguments: args })) });
      case "prompts/get": {
        const prompt = promptsByName.get(params.name);
        if (!prompt) return fail(id, -32602, `Unknown prompt: ${params.name}`);
        return ok(id, { description: prompt.description, messages: [{ role: "user", content: { type: "text", text: prompt.text(params.arguments ?? {}) } }] });
      }
      case "resources/list":
        return ok(id, { resources: [] });
      case "resources/templates/list":
        return ok(id, { resourceTemplates: [] });
      default:
        return fail(id, -32601, `Method not found: ${method}`);
    }
  }, "handle");
}
__name(createMcpServer, "createMcpServer");
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
__name(safeEqual, "safeEqual");
var json = /* @__PURE__ */ __name((body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } }), "json");
var plain = /* @__PURE__ */ __name((body, status, headers = {}) => new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...headers } }), "plain");
var TRUSTED_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*(claude\.ai|claude\.com|anthropic\.com)$|^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
function originAllowed(origin, extra) {
  return !origin || TRUSTED_ORIGIN.test(origin) || extra.includes(origin);
}
__name(originAllowed, "originAllowed");
async function handleHttp(request, { handle, secret, allowedOrigins = [] }) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (!originAllowed(request.headers.get("origin"), allowedOrigins)) return plain("Forbidden origin\n", 403);
  if (path === "/" && request.method === "GET") return plain("Tracker MCP server. Connect your MCP client to /mcp/<secret>.\n", 200);
  if (path !== "/mcp" && !path.startsWith("/mcp/")) return plain("Not found\n", 404);
  if (!secret || secret.length < 16) return plain("MCP_SECRET is not configured (use at least 16 characters).\n", 500);
  if (path === "/mcp") {
    const auth = request.headers.get("authorization") ?? "";
    const token = auth.replace(/^Bearer\s+/i, "");
    if (!auth || !safeEqual(token, secret)) return plain("Unauthorized\n", 401);
  } else {
    let given = "";
    try {
      given = decodeURIComponent(path.slice("/mcp/".length));
    } catch {
    }
    if (!safeEqual(given, secret)) return plain("Not found\n", 404);
  }
  if (request.method !== "POST") return plain("Method not allowed\n", 405, { Allow: "POST" });
  let body;
  try {
    body = await request.json();
  } catch {
    return json(fail(null, -32700, "Parse error"), 400);
  }
  const messages = Array.isArray(body) ? body : [body];
  const responses = (await Promise.all(messages.map(handle))).filter(Boolean);
  if (!responses.length) return new Response(null, { status: 202 });
  return json(Array.isArray(body) ? responses : responses[0]);
}
__name(handleHttp, "handleHttp");

// ../app/js/github.js
var GitHubError = class extends Error {
  static {
    __name(this, "GitHubError");
  }
  constructor(message, status) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
  }
};
function encodeBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 32768) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
  }
  return btoa(binary);
}
__name(encodeBase64, "encodeBase64");
function decodeBase64(value) {
  const binary = atob(value.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
__name(decodeBase64, "decodeBase64");
var encodePath = /* @__PURE__ */ __name((p) => p.split("/").filter(Boolean).map(encodeURIComponent).join("/"), "encodePath");
function describeError(status, data, headers) {
  const detail = data?.message ? ` GitHub says: \u201C${data.message}\u201D.` : "";
  switch (status) {
    case 401:
      return "GitHub rejected the token (401). Check that it was copied correctly and has not expired.";
    case 403:
      if (headers.get("x-ratelimit-remaining") === "0") return "GitHub API rate limit reached. Sync will retry later.";
      return `Permission denied (403). The token needs \u201CContents: Read and write\u201D access to this repository.${detail}`;
    case 404:
      return "Not found (404). Check the owner, repository and branch, and that the token has access to that repository.";
    case 409:
      return `Conflict (409).${detail}`;
    case 422:
      return `GitHub refused the change (422).${detail}`;
    default:
      return `GitHub error ${status}.${detail}`;
  }
}
__name(describeError, "describeError");
function createGitHubClient({
  token,
  owner,
  repo,
  fetchImpl = globalThis.fetch.bind(globalThis),
  apiBase = "https://api.github.com",
  cacheMode = "no-store",
  userAgent = ""
}) {
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  async function request(method, path, { body, query } = {}) {
    const url = new URL(apiBase + path);
    for (const [key, value] of Object.entries(query ?? {})) if (value) url.searchParams.set(key, value);
    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28"
    };
    if (body) headers["Content-Type"] = "application/json";
    if (userAgent) headers["User-Agent"] = userAgent;
    const init = { method, headers, body: body ? JSON.stringify(body) : void 0 };
    if (cacheMode) init.cache = cacheMode;
    let res;
    try {
      res = await fetchImpl(url.toString(), init);
    } catch {
      throw new GitHubError("Could not reach GitHub. Check your internet connection.", 0);
    }
    const raw = await res.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }
    if (!res.ok) throw new GitHubError(describeError(res.status, data, res.headers), res.status);
    return data;
  }
  __name(request, "request");
  return {
    getRepo() {
      return request("GET", repoPath);
    },
    // Returns { sha, text } or null when the file (or branch) does not exist.
    async getFile(filePath, ref) {
      let data;
      try {
        data = await request("GET", `${repoPath}/contents/${encodePath(filePath)}`, { query: { ref } });
      } catch (err) {
        if (err.status === 404) return null;
        throw err;
      }
      if (Array.isArray(data) || data?.type !== "file") {
        throw new GitHubError(`\u201C${filePath}\u201D in ${owner}/${repo} is a folder, not a file. Choose a file path such as tracker.json.`, 400);
      }
      let content = data.content;
      if (!content && data.size > 0) {
        content = (await request("GET", `${repoPath}/git/blobs/${data.sha}`)).content;
      }
      return { sha: data.sha, text: decodeBase64(content ?? "") };
    },
    async putFile(filePath, { text: text2, sha, branch, message }) {
      const body = { message, content: encodeBase64(text2) };
      if (sha) body.sha = sha;
      if (branch) body.branch = branch;
      const data = await request("PUT", `${repoPath}/contents/${encodePath(filePath)}`, { body });
      return { sha: data?.content?.sha ?? null, commit: data?.commit?.sha ?? null };
    },
    // Creates `branch` from the default branch if it does not exist yet.
    async ensureBranch(branch) {
      try {
        await request("GET", `${repoPath}/branches/${encodePath(branch)}`);
        return false;
      } catch (err) {
        if (err.status !== 404) throw err;
      }
      const info = await request("GET", repoPath);
      if (info.default_branch === branch) return false;
      let base;
      try {
        base = await request("GET", `${repoPath}/git/ref/heads/${encodePath(info.default_branch)}`);
      } catch (err) {
        if (err.status === 409 || err.status === 404) {
          throw new GitHubError("The repository is empty. Leave \u201CBranch\u201D blank for the first sync, or add a README to the repository first.", 409);
        }
        throw err;
      }
      await request("POST", `${repoPath}/git/refs`, { body: { ref: `refs/heads/${branch}`, sha: base.object.sha } });
      return true;
    }
  };
}
__name(createGitHubClient, "createGitHubClient");

// ../app/js/model.js
var SCHEMA_VERSION = 1;
var TYPES = [
  { id: "task", label: "Task", plural: "Tasks" },
  { id: "idea", label: "Idea", plural: "Ideas" },
  { id: "claude", label: "Claude work", plural: "Claude work" },
  { id: "doc", label: "Document", plural: "Docs" }
];
var TYPE_IDS = TYPES.map((t) => t.id);
var STATUSES = ["pending", "in_progress", "done"];
var STATUS_LABELS = { pending: "Pending", in_progress: "In progress", done: "Done" };
var DOC_STATUS_LABELS = { pending: "To read", in_progress: "Reading", done: "Read" };
function statusLabel(status, type) {
  return (type === "doc" ? DOC_STATUS_LABELS : STATUS_LABELS)[status] ?? status;
}
__name(statusLabel, "statusLabel");
var PRIORITIES = [
  { id: "low", label: "Low" },
  { id: "normal", label: "Normal" },
  { id: "high", label: "High" },
  { id: "urgent", label: "Urgent" }
];
var PRIORITY_RANK = { low: 0, normal: 1, high: 2, urgent: 3 };
var KINDS = {
  claude: [
    { id: "code", label: "Claude Code session" },
    { id: "chat", label: "Chat / project" },
    { id: "pr", label: "Pull request" },
    { id: "artifact", label: "Artifact" },
    { id: "other", label: "Other" }
  ],
  doc: [
    { id: "proposal", label: "Proposal" },
    { id: "artifact", label: "Artifact" },
    { id: "claude", label: "Claude doc" },
    { id: "readme", label: "README" },
    { id: "spec", label: "Spec / plan" },
    { id: "report", label: "Report" },
    { id: "article", label: "Article / link" },
    { id: "other", label: "Other" }
  ]
};
var DECISIONS = [
  { id: "approved", label: "Approved" },
  { id: "changes", label: "Changes requested" },
  { id: "rejected", label: "Rejected" }
];
var DECISION_IDS = DECISIONS.map((d) => d.id);
function kindLabel(type, kind) {
  return KINDS[type]?.find((k) => k.id === kind)?.label ?? "";
}
__name(kindLabel, "kindLabel");
var EPOCH = "1970-01-01T00:00:00.000Z";
var KNOWN_KEYS = [
  "id",
  "type",
  "title",
  "status",
  "priority",
  "kind",
  "project",
  "tags",
  "url",
  "due",
  "notes",
  "files",
  "decision",
  "feedback",
  "createdAt",
  "updatedAt",
  "startedAt",
  "completedAt",
  "deleted"
];
var nowIso = /* @__PURE__ */ __name(() => (/* @__PURE__ */ new Date()).toISOString(), "nowIso");
function newId() {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  const rand = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${Date.now().toString(36)}-${rand}`;
}
__name(newId, "newId");
function isoOr(value, fallback) {
  if (typeof value === "string" && value) {
    const t = Date.parse(value);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  return fallback;
}
__name(isoOr, "isoOr");
function bumpTime(previous, now = nowIso()) {
  const prev = Date.parse(previous) || 0;
  return new Date(Math.max(Date.parse(now), prev + 1)).toISOString();
}
__name(bumpTime, "bumpTime");
var text = /* @__PURE__ */ __name((v) => typeof v === "string" ? v : v == null ? "" : String(v), "text");
function cleanTags(tags) {
  const list = Array.isArray(tags) ? tags : typeof tags === "string" ? tags.split(/[,\n]/) : [];
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const raw of list) {
    const tag = text(raw).trim().replace(/^#+/, "").replace(/\s+/g, "-");
    const key = tag.toLowerCase();
    if (tag && !seen.has(key)) {
      seen.add(key);
      out.push(tag);
    }
  }
  return out;
}
__name(cleanTags, "cleanTags");
var cleanDate = /* @__PURE__ */ __name((v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "", "cleanDate");
function cleanFiles(files) {
  if (!Array.isArray(files)) return [];
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const f of files) {
    if (!f || typeof f !== "object" || typeof f.path !== "string" || !f.path || seen.has(f.path)) continue;
    seen.add(f.path);
    out.push({
      path: f.path,
      name: text(f.name) || f.path.split("/").pop(),
      size: Number.isFinite(f.size) ? f.size : 0,
      sha: text(f.sha),
      addedAt: isoOr(f.addedAt, "")
    });
  }
  return out;
}
__name(cleanFiles, "cleanFiles");
function normalizeItem(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const id = typeof r.id === "string" && r.id ? r.id : newId();
  const type = TYPE_IDS.includes(r.type) ? r.type : "task";
  const createdAt = isoOr(r.createdAt, EPOCH);
  const updatedAt = isoOr(r.updatedAt, createdAt);
  if (r.deleted) return { id, type, deleted: true, createdAt, updatedAt };
  const item = {
    id,
    type,
    title: text(r.title).trim(),
    status: STATUSES.includes(r.status) ? r.status : "pending",
    priority: Object.hasOwn(PRIORITY_RANK, r.priority ?? "") ? r.priority : "normal",
    kind: KINDS[type]?.some((k) => k.id === r.kind) ? r.kind : "",
    project: text(r.project).trim(),
    tags: cleanTags(r.tags),
    url: text(r.url).trim(),
    due: cleanDate(r.due),
    notes: text(r.notes),
    files: cleanFiles(r.files),
    decision: DECISION_IDS.includes(r.decision) ? r.decision : "",
    feedback: text(r.feedback),
    createdAt,
    updatedAt,
    startedAt: isoOr(r.startedAt, ""),
    completedAt: isoOr(r.completedAt, "")
  };
  for (const [key, value] of Object.entries(r)) {
    if (!KNOWN_KEYS.includes(key)) item[key] = value;
  }
  return item;
}
__name(normalizeItem, "normalizeItem");
function createItem(fields = {}, now = nowIso()) {
  const item = normalizeItem({ ...fields, id: newId(), createdAt: now, updatedAt: now, deleted: false });
  if (item.status === "in_progress") item.startedAt = now;
  if (item.status === "done") item.completedAt = now;
  return item;
}
__name(createItem, "createItem");
function applyPatch(item, patch, now = nowIso()) {
  const updatedAt = bumpTime(item.updatedAt, now);
  const next = normalizeItem({ ...item, ...patch, id: item.id, createdAt: item.createdAt, updatedAt });
  if ("status" in patch && patch.status !== item.status) {
    if (next.status === "in_progress" && !next.startedAt) next.startedAt = updatedAt;
    next.completedAt = next.status === "done" ? updatedAt : "";
  }
  return next;
}
__name(applyPatch, "applyPatch");
function tombstone(item, now = nowIso()) {
  return { id: item.id, type: item.type, deleted: true, createdAt: item.createdAt, updatedAt: bumpTime(item.updatedAt, now) };
}
__name(tombstone, "tombstone");
var cmp = /* @__PURE__ */ __name((a, b) => a < b ? -1 : a > b ? 1 : 0, "cmp");
function serializeDocument(items) {
  const sorted = items.map(normalizeItem).sort((a, b) => cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id));
  const updatedAt = sorted.reduce((max, i) => i.updatedAt > max ? i.updatedAt : max, EPOCH);
  return `${JSON.stringify({ app: "tracker", schema: SCHEMA_VERSION, updatedAt, items: sorted }, null, 2)}
`;
}
__name(serializeDocument, "serializeDocument");
function parseDocument(source) {
  let data;
  try {
    data = JSON.parse(source);
  } catch (err) {
    throw new Error(`Data file is not valid JSON (${err.message})`);
  }
  const list = Array.isArray(data) ? data : data?.items;
  if (!Array.isArray(list)) throw new Error('Data file has no "items" list');
  return list.filter((x) => x && typeof x === "object" && typeof x.id === "string" && x.id).map(normalizeItem);
}
__name(parseDocument, "parseDocument");
var STATUS_ORDER = { in_progress: 0, pending: 1, done: 2 };
var byPriority = /* @__PURE__ */ __name((a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority], "byPriority");
var byDue = /* @__PURE__ */ __name((a, b) => cmp(a.due || "9999-99-99", b.due || "9999-99-99"), "byDue");
var byUpdated = /* @__PURE__ */ __name((a, b) => cmp(b.updatedAt, a.updatedAt), "byUpdated");
var byCompleted = /* @__PURE__ */ __name((a, b) => cmp(b.completedAt || b.updatedAt, a.completedAt || a.updatedAt), "byCompleted");
function compareSmart(a, b) {
  const s = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
  if (s) return s;
  if (a.status === "done") return byCompleted(a, b);
  return byPriority(a, b) || byDue(a, b) || byUpdated(a, b);
}
__name(compareSmart, "compareSmart");
var COMPARATORS = {
  smart: compareSmart,
  priority: /* @__PURE__ */ __name((a, b) => byPriority(a, b) || compareSmart(a, b), "priority"),
  due: /* @__PURE__ */ __name((a, b) => byDue(a, b) || compareSmart(a, b), "due"),
  updated: byUpdated,
  created: /* @__PURE__ */ __name((a, b) => cmp(b.createdAt, a.createdAt), "created"),
  title: /* @__PURE__ */ __name((a, b) => a.title.localeCompare(b.title, void 0, { sensitivity: "base" }), "title")
};
function sortItems(items, mode = "smart") {
  return [...items].sort(COMPARATORS[mode] ?? compareSmart);
}
__name(sortItems, "sortItems");
function localDate(date = /* @__PURE__ */ new Date()) {
  const pad = /* @__PURE__ */ __name((n) => String(n).padStart(2, "0"), "pad");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
__name(localDate, "localDate");
function addDays(day, n) {
  const [y, m, d] = day.split("-").map(Number);
  return localDate(new Date(y, m - 1, d + n));
}
__name(addDays, "addDays");
function slugify(value, max = 48) {
  const slug = text(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "");
  return slug || "item";
}
__name(slugify, "slugify");
function safeFileName(name, fallback = "document.md") {
  const base = text(name).split(/[\\/]/).pop().trim();
  const cleaned = base.replace(/[^\w.\- ]+/g, "").replace(/\s+/g, "-").replace(/^\.+/, "").slice(0, 96);
  return cleaned && /[^.]/.test(cleaned) ? cleaned : fallback;
}
__name(safeFileName, "safeFileName");
function formatBytes(bytes) {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
__name(formatBytes, "formatBytes");

// tracker.js
var MAX_FILE_BYTES = 2 * 1024 * 1024;
var MAX_READ_CHARS = 9e4;
var MAX_ATTEMPTS = 4;
var TrackerError = class extends Error {
  static {
    __name(this, "TrackerError");
  }
};
var isConflict = /* @__PURE__ */ __name((err) => err?.status === 409 || err?.status === 422, "isConflict");
var byteLength = /* @__PURE__ */ __name((s) => new TextEncoder().encode(s).length, "byteLength");
var has = /* @__PURE__ */ __name((obj, key) => obj[key] !== void 0 && obj[key] !== null, "has");
var EDITABLE = ["type", "title", "status", "priority", "kind", "project", "url", "due", "notes", "decision", "feedback"];
function checkFields(fields, type) {
  if (has(fields, "type") && !TYPE_IDS.includes(fields.type)) throw new TrackerError(`type must be one of ${TYPE_IDS.join(", ")}`);
  if (has(fields, "status") && !STATUSES.includes(fields.status)) throw new TrackerError(`status must be one of ${STATUSES.join(", ")}`);
  if (has(fields, "priority") && !PRIORITIES.some((p) => p.id === fields.priority)) {
    throw new TrackerError(`priority must be one of ${PRIORITIES.map((p) => p.id).join(", ")}`);
  }
  if (has(fields, "decision") && fields.decision !== "" && !DECISIONS.some((d) => d.id === fields.decision)) {
    throw new TrackerError(`decision must be one of ${DECISIONS.map((d) => d.id).join(", ")} or "" to clear it`);
  }
  if (has(fields, "due") && fields.due !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(fields.due)) throw new TrackerError('due must be YYYY-MM-DD or "" to clear it');
  const kinds = KINDS[fields.type ?? type];
  if (has(fields, "kind") && fields.kind !== "" && !kinds?.some((k) => k.id === fields.kind)) {
    throw new TrackerError(kinds ? `kind for ${fields.type ?? type} must be one of ${kinds.map((k) => k.id).join(", ")}` : `items of type ${fields.type ?? type} have no kind`);
  }
}
__name(checkFields, "checkFields");
function pickFields(input) {
  const out = {};
  for (const key of EDITABLE) if (has(input, key)) out[key] = input[key];
  if (has(input, "tags")) out.tags = cleanTags(input.tags);
  return out;
}
__name(pickFields, "pickFields");
function summarize(item) {
  const out = { id: item.id, type: item.type, title: item.title, status: item.status };
  if (item.kind) out.kind = item.kind;
  if (item.priority !== "normal") out.priority = item.priority;
  if (item.due) out.due = item.due;
  if (item.project) out.project = item.project;
  if (item.tags.length) out.tags = item.tags;
  if (item.url) out.url = item.url;
  if (item.decision) out.decision = item.decision;
  if (item.files.length) out.files = item.files.map((f) => f.path);
  out.updatedAt = item.updatedAt;
  return out;
}
__name(summarize, "summarize");
function createTracker({ client, path = "tracker.json", branch = "", filesDir = "files", device = "Claude", appUrl = "", now = nowIso }) {
  const ref = branch || void 0;
  const dir = filesDir.replace(/^\/+|\/+$/g, "") || "files";
  async function load() {
    const file = await client.getFile(path, ref);
    return { sha: file?.sha, items: file ? parseDocument(file.text) : [] };
  }
  __name(load, "load");
  async function commit(change, message) {
    for (let attempt = 1; ; attempt++) {
      const { sha, items } = await load();
      const next = change(items);
      if (!next) return items;
      if (!sha && branch) await client.ensureBranch(branch);
      try {
        await client.putFile(path, { text: serializeDocument(next), sha, branch: ref, message });
        return next;
      } catch (err) {
        if (!isConflict(err) || attempt >= MAX_ATTEMPTS) throw err;
      }
    }
  }
  __name(commit, "commit");
  async function writeFile(filePath, content, message) {
    const existing = await client.getFile(filePath, ref);
    const write = /* @__PURE__ */ __name(() => client.putFile(filePath, { text: content, sha: existing?.sha, branch: ref, message }), "write");
    try {
      return { ...await write(), replaced: Boolean(existing) };
    } catch (err) {
      if (err.status !== 404 && err.status !== 422) throw err;
      if (!branch || !await client.ensureBranch(branch)) throw err;
      return { ...await write(), replaced: Boolean(existing) };
    }
  }
  __name(writeFile, "writeFile");
  const live = /* @__PURE__ */ __name((items) => items.filter((i) => !i.deleted), "live");
  function resolve(items, key) {
    const wanted = String(key ?? "").trim();
    if (!wanted) throw new TrackerError("An item id is required.");
    const alive = live(items);
    const byId = alive.find((i) => i.id === wanted);
    if (byId) return byId;
    const byTitle = alive.filter((i) => i.title.toLowerCase() === wanted.toLowerCase());
    if (byTitle.length === 1) return byTitle[0];
    if (byTitle.length > 1) throw new TrackerError(`Several items are titled \u201C${wanted}\u201D; use the id instead (${byTitle.map((i) => i.id).join(", ")}).`);
    throw new TrackerError(`No item with id or title \u201C${wanted}\u201D. Use list_items to find it.`);
  }
  __name(resolve, "resolve");
  const link = /* @__PURE__ */ __name((id) => appUrl ? `${appUrl.replace(/#.*$/, "").replace(/\/?$/, "/")}#/item/${id}` : void 0, "link");
  const withLink = /* @__PURE__ */ __name((item) => ({ ...summarize(item), link: link(item.id) }), "withLink");
  return {
    async overview() {
      const items = live((await load()).items);
      const today = now().slice(0, 10);
      const counts = {};
      for (const t of TYPE_IDS) {
        const ofType = items.filter((i) => i.type === t);
        counts[t] = Object.fromEntries(STATUSES.map((s) => [s, ofType.filter((i) => i.status === s).length]));
      }
      const open = items.filter((i) => i.status !== "done");
      return {
        counts,
        inProgress: sortItems(items.filter((i) => i.status === "in_progress")).slice(0, 20).map(summarize),
        dueSoon: sortItems(open.filter((i) => i.due && i.due <= addDays(today, 7)), "due").slice(0, 20).map(summarize),
        awaitingReview: sortItems(items.filter((i) => i.type === "doc" && i.status !== "done" && (i.files.length || ["proposal", "artifact"].includes(i.kind)))).slice(0, 20).map(summarize),
        recentDecisions: sortItems(items.filter((i) => i.decision), "updated").slice(0, 10).map((i) => ({ ...summarize(i), feedback: i.feedback || void 0 }))
      };
    },
    async list({ type, status = "open", query = "", tag, project, kind, decision, limit = 50 } = {}) {
      const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
      const matches = live((await load()).items).filter(
        (i) => (!type || type === "all" || i.type === type) && (status === "all" || (status === "open" ? i.status !== "done" : i.status === status)) && (!tag || i.tags.some((t) => t.toLowerCase() === String(tag).replace(/^#/, "").toLowerCase())) && (!project || i.project.toLowerCase() === String(project).toLowerCase()) && (!kind || i.kind === kind) && (!decision || (decision === "none" ? !i.decision : i.decision === decision)) && terms.every((term) => [i.title, i.notes, i.feedback, i.project, i.url, ...i.tags, ...i.files.map((f) => f.name)].join("\n").toLowerCase().includes(term))
      );
      const max = Math.min(Math.max(Number(limit) || 50, 1), 200);
      return { total: matches.length, shown: Math.min(max, matches.length), items: sortItems(matches).slice(0, max).map(summarize) };
    },
    async get(id, { includeFiles = false } = {}) {
      const item = resolve((await load()).items, id);
      const result = { ...item, statusLabel: statusLabel(item.status, item.type), link: link(item.id) };
      if (includeFiles) {
        let budget = MAX_READ_CHARS;
        result.files = [];
        for (const f of item.files) {
          const file = await client.getFile(f.path, ref);
          if (!file) {
            result.files.push({ ...f, missing: true });
            continue;
          }
          const content = file.text.slice(0, Math.max(budget, 0));
          budget -= content.length;
          const truncated = content.length < file.text.length;
          result.files.push({ ...f, content, truncated: truncated ? `Showing ${content.length} of ${file.text.length} characters; use read_file with offset ${content.length} for the rest.` : void 0 });
        }
      }
      return result;
    },
    async readFile(filePath, offset = 0) {
      const p = String(filePath ?? "").replace(/^\/+/, "");
      if (!p.startsWith(`${dir}/`) || p.split("/").includes("..")) throw new TrackerError(`Only files under ${dir}/ can be read. Use the paths listed in an item's files.`);
      const file = await client.getFile(p, ref);
      if (!file) throw new TrackerError(`File not found: ${p}`);
      const start = Math.min(Math.max(Number(offset) || 0, 0), file.text.length);
      const content = file.text.slice(start, start + MAX_READ_CHARS);
      const end = start + content.length;
      return {
        path: p,
        totalChars: file.text.length,
        offset: start,
        nextOffset: end < file.text.length ? end : void 0,
        content
      };
    },
    async addItems(list) {
      if (!Array.isArray(list) || !list.length) throw new TrackerError("Provide at least one item.");
      const at = now();
      const created = list.map((input, n) => {
        const fields = pickFields(input);
        checkFields(fields, fields.type ?? "task");
        if (!String(fields.title ?? "").trim()) throw new TrackerError(`Item ${n + 1} needs a title.`);
        return createItem({ type: "task", ...fields }, at);
      });
      const label = created.length === 1 ? `\u201C${created[0].title}\u201D` : `${created.length} items`;
      await commit((items) => [...items, ...created], `Tracker: add ${label} (via ${device})`);
      return { added: created.map(withLink) };
    },
    async updateItems(updates) {
      if (!Array.isArray(updates) || !updates.length) throw new TrackerError("Provide at least one update.");
      const at = now();
      let changed = [];
      const next = await commit((items) => {
        changed = [];
        const patches = /* @__PURE__ */ new Map();
        for (const u of updates) {
          const item = resolve(items, u.id);
          const patch = pickFields(u);
          checkFields(patch, item.type);
          let tags = patch.tags ?? item.tags;
          if (u.add_tags) tags = cleanTags([...tags, ...cleanTags(u.add_tags)]);
          if (u.remove_tags) {
            const remove = new Set(cleanTags(u.remove_tags).map((t) => t.toLowerCase()));
            tags = tags.filter((t) => !remove.has(t.toLowerCase()));
          }
          if (u.add_tags || u.remove_tags) patch.tags = tags;
          if (u.append_notes) patch.notes = [patch.notes ?? item.notes, String(u.append_notes)].filter((s) => s.trim()).join("\n\n");
          if (has(patch, "type") && patch.type !== item.type && !has(patch, "kind")) patch.kind = "";
          patches.set(item.id, { ...patches.get(item.id) ?? {}, ...patch });
        }
        const out = items.map((i) => {
          if (!patches.has(i.id) || i.deleted) return i;
          const updated = applyPatch(i, patches.get(i.id), at);
          changed.push(updated);
          return updated;
        });
        return changed.length ? out : null;
      }, `Tracker: update ${updates.length === 1 ? "an item" : `${updates.length} items`} (via ${device})`);
      return { updated: changed.map((c) => withLink(next.find((i) => i.id === c.id) ?? c)) };
    },
    async deleteItems(ids) {
      if (!Array.isArray(ids) || !ids.length) throw new TrackerError("Provide at least one id.");
      const at = now();
      let removed = [];
      await commit((items) => {
        const targets = new Set(ids.map((id) => resolve(items, id).id));
        removed = items.filter((i) => targets.has(i.id));
        return items.map((i) => targets.has(i.id) ? tombstone(i, at) : i);
      }, `Tracker: delete ${ids.length === 1 ? "an item" : `${ids.length} items`} (via ${device})`);
      return { deleted: removed.map((i) => ({ id: i.id, title: i.title })) };
    },
    // Saves a document as a file in the repo and files it on the tracker:
    // as a new "doc" item, or as a new version on an existing item.
    async sendDocument(input) {
      const content = String(input.content ?? "");
      if (!content.trim()) throw new TrackerError("content is empty \u2014 pass the full text of the document.");
      const size = byteLength(content);
      if (size > MAX_FILE_BYTES) throw new TrackerError(`The document is ${formatBytes(size)}; the limit is ${formatBytes(MAX_FILE_BYTES)}.`);
      const kind = input.kind ?? "other";
      checkFields({ kind, priority: input.priority, due: input.due }, "doc");
      const at = now();
      let target = null;
      if (input.item_id) target = resolve((await load()).items, input.item_id);
      const title = String(input.title ?? "").trim() || target?.title;
      if (!title) throw new TrackerError("A title is required.");
      const fallbackName = kind === "proposal" || kind === "artifact" ? `${kind}.md` : `${slugify(title)}.md`;
      const filename = safeFileName(input.filename, fallbackName);
      const draft = target ? null : createItem({ type: "doc", title }, at);
      const folder = target?.files[0]?.path.split("/").slice(0, -1).join("/") || `${dir}/${at.slice(0, 10)}-${slugify(title)}-${draft.id.slice(-6)}`;
      const filePath = `${folder}/${filename}`;
      const written = await writeFile(filePath, content, `Tracker: ${target ? "update" : "add"} ${filePath} (via ${device})`);
      const file = { path: filePath, name: filename, size, sha: written.sha ?? "", addedAt: at };
      const fields = pickFields({ project: input.project, url: input.url, priority: input.priority, due: input.due });
      if (has(input, "tags")) fields.tags = cleanTags(input.tags);
      if (!target) {
        const item = normalizeItem({ ...draft, ...fields, kind, notes: input.summary ?? "", files: [file] });
        await commit((items) => [...items, item], `Tracker: add ${kindLabel("doc", kind).toLowerCase() || "document"} \u201C${title}\u201D (via ${device})`);
        return { created: true, item: withLink(item), file: { path: filePath, size: formatBytes(size) } };
      }
      let saved = null;
      await commit((items) => {
        const current = resolve(items, target.id);
        const notes = input.summary ? [current.notes, `**Update ${at.slice(0, 10)}:** ${input.summary}`].filter((s) => s.trim()).join("\n\n") : current.notes;
        saved = applyPatch(
          current,
          { ...fields, notes, files: [...current.files.filter((f) => f.path !== filePath), file], status: "pending", decision: "" },
          at
        );
        return items.map((i) => i.id === current.id ? saved : i);
      }, `Tracker: new version of \u201C${target.title}\u201D (via ${device})`);
      return { created: false, replacedFile: written.replaced, item: withLink(saved), file: { path: filePath, size: formatBytes(size) } };
    }
  };
}
__name(createTracker, "createTracker");

// ../app/js/version.js
var APP_VERSION = "1.1.0";

// tools.js
var SERVER_INFO = { name: "tracker", title: "Tracker", version: APP_VERSION };
var INSTRUCTIONS = `Tracker is the user's personal tracker for tasks, ideas, Claude work and documents. They read and review it in the Tracker app on their computers and phone. Data lives in a private GitHub repo; every write is a commit.

Model
- Item types: task, idea, claude (Claude work: Claude Code sessions, PRs, chats, artifacts), doc (things for the user to read or review).
- Status: pending \u2192 in_progress \u2192 done (docs show as To read \u2192 Reading \u2192 Read).
- Docs can carry files (proposal.md, report.html, \u2026) stored in the repo; the user reads them in the app.
- The user reviews docs by setting decision (approved | changes | rejected) and writing feedback.

How to handle requests
- "Send (this) proposal / plan / design to my tracker" \u2192 send_document with kind "proposal", the COMPLETE proposal as Markdown in content, and a 2\u20134 sentence summary. Do not send a shortened version.
- "Send (this) artifact / file / report / README / doc to my tracker" \u2192 send_document with the matching kind, the complete file content, and a filename with the right extension (dashboard.html, notes.md, script.py\u2026).
- A revised version of something already on the tracker \u2192 send_document with item_id (and the same filename to replace it); this puts it back in the user's review queue.
- "Update tasks on my tracker", "mark X done", "add a task \u2026" \u2192 list_items first to find existing items and avoid duplicates, then update_items / add_items. Batch several changes into one call.
- "Log / track this Claude work" \u2192 add_items with type "claude", kind (code, chat, pr, artifact) and url = the session, PR or artifact link.
- "What's on my tracker?" \u2192 get_overview. "Any feedback on my proposal?" \u2192 list_items with decision, or get_item; then read decision and feedback.

Conventions
- Set project to the repository or project name and url to the most relevant link (Claude session, PR, artifact) when you know them.
- Keep titles short and specific; put details in notes (Markdown, checklists with "- [ ]").
- Due dates are YYYY-MM-DD. Use tags sparingly and reuse existing ones.
- Never delete items unless the user explicitly asks. After a write, tell the user what changed and include the item link if one is returned.`;
var str = /* @__PURE__ */ __name((description) => ({ type: "string", description }), "str");
var enumOf = /* @__PURE__ */ __name((values, description) => ({ type: "string", enum: values, description }), "enumOf");
var tagsSchema = { type: "array", items: { type: "string" }, description: 'Tags without "#", e.g. ["work"].' };
var kindIds = /* @__PURE__ */ __name((type) => KINDS[type].map((k) => k.id), "kindIds");
var ITEM_FIELDS = {
  title: str("Short, specific title."),
  type: enumOf(TYPE_IDS, "task | idea | claude (Claude work) | doc (something to read). Default: task."),
  status: enumOf(STATUSES, "Default: pending."),
  priority: enumOf(PRIORITIES.map((p) => p.id), "Default: normal."),
  kind: str(`Optional subtype. For claude: ${kindIds("claude").join(", ")}. For doc: ${kindIds("doc").join(", ")}.`),
  project: str("Repository or project name."),
  tags: tagsSchema,
  url: str("Most relevant link: Claude session, PR, artifact or source."),
  due: str("Due date as YYYY-MM-DD."),
  notes: str('Details in Markdown. Checklists as "- [ ] step".')
};
function createTools(getTracker) {
  const run = /* @__PURE__ */ __name((fn) => async (args) => fn(await getTracker(), args), "run");
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  return [
    {
      name: "get_overview",
      title: "Tracker overview",
      description: "Summary of the tracker: counts per type and status, items in progress, items due within 7 days, documents waiting for review, and recent review decisions with feedback.",
      inputSchema: { type: "object", properties: {} },
      annotations: readOnly,
      run: run((t) => t.overview())
    },
    {
      name: "list_items",
      title: "List tracker items",
      description: "Find items on the tracker. By default returns open items (pending + in progress). Use before adding or updating so you work with existing items and their ids.",
      inputSchema: {
        type: "object",
        properties: {
          type: enumOf(["all", ...TYPE_IDS], "Filter by type. Default: all."),
          status: enumOf(["open", "all", ...STATUSES], "open = pending or in_progress (default)."),
          query: str("Words to search for in title, notes, feedback, project, url, tags and file names."),
          tag: str("Only items with this tag."),
          project: str("Only items for this project."),
          kind: str("Only items of this kind, e.g. proposal."),
          decision: enumOf([...DECISIONS.map((d) => d.id), "none"], "Only docs with this review decision (none = not reviewed yet)."),
          limit: { type: "integer", minimum: 1, maximum: 200, description: "Default 50." }
        }
      },
      annotations: readOnly,
      run: run((t, a) => t.list(a))
    },
    {
      name: "get_item",
      title: "Get a tracker item",
      description: "Full details of one item: notes, review decision and feedback, attached files. Set include_file_contents to also read the attached files (e.g. to revise a proposal the user reviewed).",
      inputSchema: {
        type: "object",
        properties: {
          id: str("Item id (or its exact title)."),
          include_file_contents: { type: "boolean", description: "Also return the text of attached files. Default false." }
        },
        required: ["id"]
      },
      annotations: readOnly,
      run: run((t, a) => t.get(a.id, { includeFiles: Boolean(a.include_file_contents) }))
    },
    {
      name: "read_file",
      title: "Read a tracker file",
      description: "Read a file attached to a tracker item, by the path listed in the item's files. Long files come in pages: pass nextOffset from the previous result as offset.",
      inputSchema: {
        type: "object",
        properties: {
          path: str("File path, e.g. files/2026-10-20-sync-plan-1a2b3c/proposal.md"),
          offset: { type: "integer", minimum: 0, description: "Character offset to start from. Default 0." }
        },
        required: ["path"]
      },
      annotations: readOnly,
      run: run((t, a) => t.readFile(a.path, a.offset))
    },
    {
      name: "add_items",
      title: "Add tracker items",
      description: "Add one or more tasks, ideas, Claude work entries or docs to the tracker (one commit). Check list_items first to avoid duplicates. To send a document with its file, use send_document instead.",
      inputSchema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            items: { type: "object", properties: ITEM_FIELDS, required: ["title"] }
          }
        },
        required: ["items"]
      },
      annotations: write,
      run: run((t, a) => t.addItems(a.items))
    },
    {
      name: "update_items",
      title: "Update tracker items",
      description: 'Change one or more existing items in one commit: status (e.g. mark done), title, priority, due, notes, tags, review fields. Only the fields you pass change; pass "" to clear due or decision.',
      inputSchema: {
        type: "object",
        properties: {
          updates: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            items: {
              type: "object",
              properties: {
                id: str("Item id (or exact title)."),
                ...ITEM_FIELDS,
                tags: { ...tagsSchema, description: "Replaces all tags." },
                add_tags: { ...tagsSchema, description: "Tags to add." },
                remove_tags: { ...tagsSchema, description: "Tags to remove." },
                append_notes: str("Markdown appended to the existing notes (use for progress logs)."),
                decision: enumOf(["", ...DECISIONS.map((d) => d.id)], "Review decision; normally set by the user."),
                feedback: str("Review feedback; normally written by the user.")
              },
              required: ["id"]
            }
          }
        },
        required: ["updates"]
      },
      annotations: { ...write, idempotentHint: true },
      run: run((t, a) => t.updateItems(a.updates))
    },
    {
      name: "delete_items",
      title: "Delete tracker items",
      description: "Delete items from the tracker. Only when the user explicitly asks to delete or remove them; prefer marking items done.",
      inputSchema: { type: "object", properties: { ids: { type: "array", minItems: 1, items: { type: "string" }, description: "Item ids." } }, required: ["ids"] },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      run: run((t, a) => t.deleteItems(a.ids))
    },
    {
      name: "send_document",
      title: "Send a document to the tracker",
      description: `Save a proposal, artifact, plan, report, README or any document to the tracker for the user to read and review. Use for "send this proposal to my tracker", "send the artifact to my tracker", "put this doc on my tracker". The file is stored in the tracker repo and appears in the user's reading list as a doc item. Pass item_id to add a new version to an existing item instead.`,
      inputSchema: {
        type: "object",
        properties: {
          title: str("Document title."),
          kind: enumOf(kindIds("doc"), "proposal for proposals/plans to approve, artifact for Claude artifacts, otherwise the closest match."),
          content: str("The COMPLETE document text (Markdown, HTML, code\u2026). Not a summary."),
          filename: str("File name with extension, e.g. proposal.md, dashboard.html, analysis.py. Default: <kind>.md."),
          summary: str("2\u20134 sentence Markdown summary shown above the file: what it is and what the user should decide."),
          project: ITEM_FIELDS.project,
          tags: tagsSchema,
          url: ITEM_FIELDS.url,
          priority: ITEM_FIELDS.priority,
          due: str("Review-by date as YYYY-MM-DD."),
          item_id: str('Existing item to attach this version to (resets it to "To read" and clears the decision).')
        },
        required: ["title", "content", "kind"]
      },
      annotations: write,
      run: run((t, a) => t.sendDocument(a))
    }
  ];
}
__name(createTools, "createTools");
var PROMPTS = [
  {
    name: "send_proposal",
    title: "Send proposal to my tracker",
    description: "Write up the current plan or proposal and send it to the tracker for review.",
    arguments: [{ name: "topic", description: "What the proposal is about (optional).", required: false }],
    text: /* @__PURE__ */ __name(({ topic }) => `Write the ${topic ? `proposal about ${topic}` : "proposal or plan we have been discussing"} as a complete Markdown document (context, proposal, alternatives, risks, open questions) and send it to my tracker with send_document (kind "proposal"). Include the project and a link to this session or PR if you know it. Then tell me the item link.`, "text")
  },
  {
    name: "update_tracker",
    title: "Update my tracker",
    description: "Sync the tracker with the work done in this conversation.",
    arguments: [],
    text: /* @__PURE__ */ __name(() => 'Look at what we did in this conversation and update my tracker: list_items to see what is there, mark finished tasks done, update in-progress items with a short progress note (append_notes), add follow-up tasks we identified, and log this Claude work (type "claude" with the session or PR link). Batch the changes, then summarize what you changed.', "text")
  },
  {
    name: "check_feedback",
    title: "Check tracker feedback",
    description: "Find review decisions and feedback on proposals and artifacts and act on them.",
    arguments: [{ name: "project", description: "Limit to one project (optional).", required: false }],
    text: /* @__PURE__ */ __name(({ project }) => `Check my tracker for docs I have reviewed${project ? ` in project ${project}` : ""} (list_items with status "all" and a decision; read the feedback with get_item). Summarize each decision and feedback, and propose next steps. For "changes" decisions, offer to revise and resend with send_document using item_id.`, "text")
  }
];

// server.js
function readConfig(env = {}) {
  const [owner = "", repo = ""] = String(env.TRACKER_REPO ?? "").trim().split("/");
  return {
    token: String(env.GITHUB_TOKEN ?? "").trim(),
    owner,
    repo,
    branch: String(env.TRACKER_BRANCH ?? "").trim(),
    path: String(env.TRACKER_PATH ?? "").trim() || "tracker.json",
    filesDir: String(env.TRACKER_FILES_DIR ?? "").trim() || "files",
    device: String(env.TRACKER_DEVICE ?? "").trim() || "Claude",
    appUrl: String(env.TRACKER_APP_URL ?? "").trim(),
    secret: String(env.MCP_SECRET ?? ""),
    allowedOrigins: String(env.MCP_ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean),
    apiBase: String(env.GITHUB_API_URL ?? "").trim() || "https://api.github.com"
  };
}
__name(readConfig, "readConfig");
function configProblems(config) {
  const problems = [];
  if (!config.token) problems.push("GITHUB_TOKEN is not set");
  if (!config.owner || !config.repo) problems.push('TRACKER_REPO must be "owner/repo"');
  return problems;
}
__name(configProblems, "configProblems");
function createServerFromEnv(env, { fetchImpl } = {}) {
  const config = readConfig(env);
  const getTracker = /* @__PURE__ */ __name(async () => {
    const problems = configProblems(config);
    if (problems.length) throw new Error(`The tracker connector is not configured: ${problems.join("; ")}.`);
    const client = createGitHubClient({
      token: config.token,
      owner: config.owner,
      repo: config.repo,
      apiBase: config.apiBase,
      fetchImpl,
      cacheMode: null,
      userAgent: `tracker-mcp/${SERVER_INFO.version}`
    });
    return createTracker({ client, ...config });
  }, "getTracker");
  return {
    config,
    handle: createMcpServer({ info: SERVER_INFO, instructions: INSTRUCTIONS, tools: createTools(getTracker), prompts: PROMPTS })
  };
}
__name(createServerFromEnv, "createServerFromEnv");

// worker.js
var worker_default = {
  async fetch(request, env) {
    const { config, handle } = createServerFromEnv(env);
    return handleHttp(request, { handle, secret: config.secret, allowedOrigins: config.allowedOrigins });
  }
};

// ../../../../root/.npm/_npx/c943b712072b77c4/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../../root/.npm/_npx/c943b712072b77c4/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-HeqvWy/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// ../../../../root/.npm/_npx/c943b712072b77c4/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-HeqvWy/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
