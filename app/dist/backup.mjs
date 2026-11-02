// src/backend/backup.ts
import { createHash as createHash2, randomUUID as randomUUID2 } from "node:crypto";
import { createReadStream as createReadStream2, existsSync as existsSync2, readFileSync } from "node:fs";
import { copyFile as copyFile2, lstat as lstat3, mkdir as mkdir2, readdir as readdir2, rename as rename2, rm as rm2, stat as stat2, writeFile as writeFile2 } from "node:fs/promises";
import path3 from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";

// src/backend/filesystem.ts
import { lstat, rename } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
async function renameWithWindowsRetry(from, to, options = {}) {
  const move = options.move ?? rename, platform = options.platform ?? process.platform, waits = [50, 100, 200, 400, 750, 1e3, 1500];
  for (let attempt = 0; ; attempt++) {
    try {
      await move(from, to);
      return;
    } catch (error) {
      if (platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code ?? "") || attempt >= waits.length) throw error;
      if (!options.replaceExisting) {
        const destination = await lstat(to).then(() => "exists", (error2) => error2.code === "ENOENT" ? "missing" : "unknown");
        if (destination !== "missing") throw error;
      }
      await delay(waits[attempt]);
    }
  }
}

// src/backend/backup-restore.ts
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat as lstat2, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path2 from "node:path";
import { DatabaseSync } from "node:sqlite";

// src/backend/security.ts
import { realpathSync, existsSync } from "node:fs";
import path from "node:path";

// src/backend/windows-console.ts
var WINDOWS_CONSOLE_PRELOAD = String.raw`
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {promisify} from 'node:util';
if(process.platform==='win32'){
  const preload='--import='+import.meta.url;
  if(!(process.env.NODE_OPTIONS||'').includes(preload))process.env.NODE_OPTIONS=[process.env.NODE_OPTIONS,preload].filter(Boolean).join(' ');
  for(const method of ['spawn','spawnSync','execFile','execFileSync','exec','execSync','fork']){
    const original=cp[method];
    cp[method]=function(...argv){
      const index=method==='exec'||method==='execSync'?1:Array.isArray(argv[1])?2:1;
      const options=argv[index];
      if(typeof options==='function')argv.splice(index,0,{windowsHide:true});
      else argv[index]={...options,windowsHide:true};
      return original.apply(this,argv);
    };
    if(original[promisify.custom])cp[method][promisify.custom]=function(...argv){
      let child;
      const promise=new Promise((resolve,reject)=>{
        child=cp[method](...argv,(error,stdout,stderr)=>{
          if(error){Object.assign(error,{stdout,stderr});reject(error);}else resolve({stdout,stderr});
        });
      });
      promise.child=child;return promise;
    };
  }
  syncBuiltinESMExports();
}
`;

// src/backend/security.ts
var sensitiveKey = /^(?:.*[_-])?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|oauth[_-]?token|auth[_-]?token|token|authorization|password|passwd|secret|credentials|cookie|set-cookie)$/i;
var knownSecrets = new Set(Object.entries(process.env).filter(([key, value]) => sensitiveKey.test(key) && value && value.length >= 8).map(([, value]) => value));
function contained(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}
function resolveSafePath(root, relative = "") {
  if (typeof relative !== "string" || relative.includes("\0") || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) || relative.includes(":")) throw new Error("\u6587\u4EF6\u8DEF\u5F84\u5FC5\u987B\u5728\u6240\u9009\u5DE5\u4F5C\u533A\u5185\u3002");
  const realRoot = realpathSync(root);
  const candidate = path.resolve(realRoot, relative);
  if (!contained(realRoot, candidate)) throw new Error("\u6587\u4EF6\u8DEF\u5F84\u8D85\u51FA\u6240\u9009\u5DE5\u4F5C\u533A\u3002");
  let ancestor = candidate;
  while (!existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error("\u65E0\u6CD5\u6821\u9A8C\u6587\u4EF6\u8DEF\u5F84\u3002");
    ancestor = parent;
  }
  if (!contained(realRoot, realpathSync(ancestor))) throw new Error("\u6587\u4EF6\u94FE\u63A5\u6307\u5411\u5DE5\u4F5C\u533A\u4E4B\u5916\u3002");
  return candidate;
}

// src/backend/backup-restore.ts
var VALID_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/;
var PAYLOAD = ["airoom.sqlite", "assets", "attachments"];
var LOCAL_LOGIN = ["native", "secrets", "deepseek.secret"];
var REPLACED = [...PAYLOAD, "airoom.sqlite-wal", "airoom.sqlite-shm"];
var JOURNAL_NAMES = [...REPLACED, ...LOCAL_LOGIN];
var STAGE_LIFETIME = 30 * 6e4;
var exists = async (file) => {
  try {
    await lstat2(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};
function backupDirectory(dataDirectory) {
  return path2.join(path2.dirname(path2.resolve(dataDirectory)), "backups");
}
function journalPath(dataDirectory) {
  return path2.join(path2.dirname(dataDirectory), `.restore-journal-${createHash("sha256").update(dataDirectory.toLowerCase()).digest("hex").slice(0, 20)}.json`);
}
async function saveJournal(file, journal) {
  const temporary = file + ".tmp";
  await writeFile(temporary, JSON.stringify(journal), "utf8");
  await renameWithWindowsRetry(temporary, file, { replaceExisting: true });
}
var RestoreFailure = class extends Error {
  constructor(message, requiresRepair = false) {
    super(message);
    this.requiresRepair = requiresRepair;
  }
  requiresRepair;
};
async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
function payloadPath(value) {
  return value === "airoom.sqlite" || /^(?:assets|attachments)\//.test(value) && !value.split("/").some((part) => !part || part === "." || part === "..") && !/[\\:\0]/.test(value);
}
function manifestOf(value) {
  const item = value;
  if (!item || item.formatVersion !== 1 || !["deploy", "manual", "before-restore"].includes(item.reason) || !Number.isFinite(Date.parse(item.createdAt)) || !Array.isArray(item.files) || item.files.length > 2e5) throw new Error("\u5907\u4EFD\u683C\u5F0F\u4E0D\u53D7\u652F\u6301\u6216\u5185\u5BB9\u6E05\u5355\u4E0D\u5B8C\u6574\u3002");
  if (typeof item.createdAt !== "string" || item.appVersion !== void 0 && typeof item.appVersion !== "string" || item.sourceCommit !== void 0 && typeof item.sourceCommit !== "string") throw new Error("\u5907\u4EFD\u7248\u672C\u6216\u65F6\u95F4\u8BB0\u5F55\u65E0\u6548\u3002");
  const seen = /* @__PURE__ */ new Set();
  for (const file of item.files) {
    if (!file || typeof file.path !== "string" || !payloadPath(file.path) || !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(file.sha256) || seen.has(file.path.toLowerCase())) throw new Error("\u5907\u4EFD\u542B\u65E0\u6548\u3001\u91CD\u590D\u6216\u8D8A\u754C\u7684\u6587\u4EF6\u8BB0\u5F55\u3002");
    seen.add(file.path.toLowerCase());
  }
  if (!seen.has("airoom.sqlite") || !item.counts || Object.values(item.counts).some((count) => !Number.isSafeInteger(count) || count < 0)) throw new Error("\u5907\u4EFD\u7F3A\u5C11\u6570\u636E\u5E93\u6216\u6570\u91CF\u8BB0\u5F55\u3002");
  for (const key of ["threads", "messages", "members", "sessions", "runs"]) if (!Number.isSafeInteger(item.counts[key])) throw new Error("\u5907\u4EFD\u6570\u91CF\u8BB0\u5F55\u4E0D\u5B8C\u6574\u3002");
  return item;
}
async function checkedRoot(root) {
  await mkdir(root, { recursive: true });
  if ((await lstat2(root)).isSymbolicLink()) throw new Error("\u5907\u4EFD\u76EE\u5F55\u4E0D\u80FD\u662F\u94FE\u63A5\uFF0C\u8BF7\u5148\u6838\u5BF9\u5B58\u50A8\u4F4D\u7F6E\u3002");
  return root;
}
async function readManifest(directory) {
  const file = resolveSafePath(directory, "manifest.json");
  if ((await lstat2(file)).isSymbolicLink() || (await stat(file)).size > 32 * 1024 * 1024) throw new Error("\u5907\u4EFD\u6E05\u5355\u5F02\u5E38\uFF0C\u672A\u8BFB\u53D6\u3002");
  return manifestOf(JSON.parse(await readFile(file, "utf8")));
}
async function checkedFile(root, relative) {
  const file = resolveSafePath(root, relative);
  let current = root;
  for (const segment of relative.split("/")) {
    current = path2.join(current, segment);
    if ((await lstat2(current)).isSymbolicLink()) throw new Error("\u5907\u4EFD\u6587\u4EF6\u5305\u542B\u94FE\u63A5\uFF0C\u672A\u6062\u590D\u3002");
  }
  if (!(await lstat2(file)).isFile()) throw new Error(`\u5907\u4EFD\u6587\u4EF6\u4E0D\u5B58\u5728\u6216\u4E0D\u662F\u6587\u4EF6\uFF1A${relative}`);
  return file;
}
async function verifyFiles(root, files) {
  for (const file of files) {
    const target = await checkedFile(root, file.path);
    if ((await stat(target)).size !== file.size || await digest(target) !== file.sha256.toLowerCase()) throw new Error(`\u5907\u4EFD\u6587\u4EF6\u6821\u9A8C\u5931\u8D25\uFF1A${file.path}\u3002\u5F53\u524D\u6570\u636E\u6CA1\u6709\u88AB\u66FF\u6362\u3002`);
  }
}
function inspectDatabase(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const check = db.prepare("PRAGMA quick_check").all();
    if (check.length !== 1 || Object.values(check[0])[0] !== "ok") throw new Error("\u5907\u4EFD\u6570\u636E\u5E93\u5B8C\u6574\u6027\u68C0\u67E5\u5931\u8D25\u3002");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('entities','events')").all();
    if (tables.length !== 2 || db.prepare("SELECT name FROM sqlite_master WHERE type IN ('trigger','view')").all().length) throw new Error("\u5907\u4EFD\u6570\u636E\u5E93\u7ED3\u6784\u4E0E\u5F53\u524D\u7248\u672C\u4E0D\u517C\u5BB9\u3002");
    const rows = db.prepare("SELECT entity,id,value FROM entities").all();
    const counts = { threads: 0, messages: 0, members: 0, sessions: 0, runs: 0 }, memberNames = [];
    let historyOnlySessions = 0;
    const countKeys = { room_threads: "threads", room_messages: "messages", members: "members", sessions: "sessions", runs: "runs" };
    const identified = /* @__PURE__ */ new Set(["projects", "sessions", "runs", "members", "room_threads", "room_messages", "approvals", "timed_jobs", "timed_occurrences", "collaborations", "executors"]);
    for (const row of rows) {
      const value = JSON.parse(row.value);
      if (!value || typeof value !== "object") throw new Error("\u5907\u4EFD\u4E2D\u7684\u8BB0\u5F55\u683C\u5F0F\u4E0D\u5B8C\u6574\u3002");
      if (identified.has(row.entity) && (typeof value.id !== "string" || value.id !== row.id)) throw new Error("\u5907\u4EFD\u4E2D\u7684\u8BB0\u5F55\u7F16\u53F7\u4E0D\u5B8C\u6574\uFF0C\u8BF7\u4FDD\u7559\u539F\u5907\u4EFD\u3002");
      if (countKeys[row.entity]) counts[countKeys[row.entity]]++;
      if (row.entity === "members" && typeof value.name === "string") memberNames.push(value.name);
      if (row.entity === "sessions") historyOnlySessions++;
    }
    db.prepare("SELECT id,session_id,run_id,value FROM events LIMIT 1").all();
    return { counts, memberNames, historyOnlySessions };
  } finally {
    db.close();
  }
}
function sanitizeRestoredDatabase(file, targetDirectory, backupId) {
  const db = new DatabaseSync(file), at = (/* @__PURE__ */ new Date()).toISOString();
  try {
    db.exec("BEGIN IMMEDIATE");
    const rows = db.prepare("SELECT entity,id,value FROM entities").all();
    const update = db.prepare("UPDATE entities SET value=? WHERE entity=? AND id=?");
    const roomProjects = new Set(rows.filter((row) => row.entity === "projects" && JSON.parse(row.value).kind === "lounge").map((row) => row.id));
    const removedEntities = /* @__PURE__ */ new Set(["providers", "quotas", "room_sessions", "blocked_sessions", "automatic_reservations", "workspace_conflicts"]);
    for (const row of rows) {
      let value = JSON.parse(row.value);
      if (removedEntities.has(row.entity)) {
        db.prepare("DELETE FROM entities WHERE entity=? AND id=?").run(row.entity, row.id);
        continue;
      }
      if (row.entity === "sessions") {
        const { nativeId: _native, nativeHome: _home, workspace: _workspace, workspaceKind: _kind, workspaceSource: _source, ...rest } = value;
        value = { ...rest, restoredHistoryOnly: !roomProjects.has(value.projectId), updatedAt: at };
      } else if (row.entity === "runs") {
        if (!value.completedAt && ["queued", "running", "waiting_user", "rate_limited", "stopping"].includes(value.status)) value = { ...value, status: ["sent", "confirmed", "unknown"].includes(value.delivery) ? "unknown" : "interrupted", completedAt: at, updatedAt: at, error: "\u5907\u4EFD\u6062\u590D\u540E\u4FDD\u7559\u4E3A\u5386\u53F2\uFF0C\u672A\u81EA\u52A8\u91CD\u53D1\u3002" };
        if (value.workspaceUndo) value.workspaceUndo = { status: "unavailable", reason: "\u5907\u4EFD\u4E0D\u5305\u542B\u5DE5\u4F5C\u526F\u672C\u548C\u8FD8\u539F\u70B9\uFF0C\u672C\u8BB0\u5F55\u4EC5\u4F9B\u67E5\u770B\u3002" };
      } else if (row.entity === "roundtable_topics") value = { ...value, status: "ended", archivedAt: value.archivedAt ?? at, restoredHistoryOnly: true, error: "\u5907\u4EFD\u4E0D\u5305\u542B\u5706\u684C\u5DE5\u4F5C\u526F\u672C\uFF0C\u4FDD\u7559\u8BAE\u9898\u548C\u771F\u5B9E\u8BA8\u8BBA\u8BB0\u5F55\uFF0C\u53EA\u4F9B\u9605\u8BFB\u3002" };
      else if (row.entity === "flow_joint_reviews") value = { ...value, status: "cancelled", dispatchMode: "paused", error: "\u5907\u4EFD\u6062\u590D\u540E\u53EA\u4FDD\u7559\u5386\u53F2\uFF1B\u672A\u81EA\u52A8\u7EE7\u7EED\u8BC4\u5BA1\uFF0C\u5DE5\u4F5C\u526F\u672C\u4E0D\u5728\u5907\u4EFD\u5185\u3002" };
      else if (row.entity === "collaborations") value = { ...value, status: "paused", stage: "\u5907\u4EFD\u6062\u590D\u540E\u4EC5\u4FDD\u7559\u534F\u4F5C\u8BB0\u5F55\uFF0C\u8BF7\u660E\u786E\u65B0\u5EFA\u4EFB\u52A1\u3002", restoredHistoryOnly: true };
      else if (row.entity === "workflows") {
        const { workspaceResult: _result, ...rest } = value;
        value = rest;
      } else if (row.entity === "approvals" && value.state === "pending") value = { ...value, state: "expired" };
      else if (row.entity === "outbox" && ["prepared", "sent"].includes(value.delivery)) value = { ...value, delivery: value.delivery === "prepared" && value.kind !== "steer" ? "withdrawn" : "unknown", updatedAt: at };
      else if (row.entity === "settings" && row.id === "main") value = { ...value, automationPolicies: Object.fromEntries(Object.entries(value.automationPolicies ?? {}).map(([key, policy]) => [key, { ...policy, enabled: false }])) };
      else if (row.entity === "timed_jobs") value = { ...value, enabled: false, pausedReason: "\u5907\u4EFD\u6062\u590D\u540E\u672A\u81EA\u52A8\u542F\u7528\uFF0C\u8BF7\u6838\u5BF9\u540E\u91CD\u65B0\u8BBE\u7F6E\u3002" };
      else if (row.entity === "timed_occurrences" && value.status === "running") value = { ...value, status: "unknown", finishedAt: at, reason: "\u5907\u4EFD\u6062\u590D\u540E\u672A\u81EA\u52A8\u91CD\u53D1\u3002" };
      else if (row.entity === "room_states" || row.entity === "room" && row.id === "state") value = { ...value, active: false, speaking: void 0, compressing: void 0, generatingImage: void 0, ...value.discussion ? { discussion: { ...value.discussion, phase: row.id.startsWith("roundtable:") ? "idle" : "paused", pausedByUser: true, mentionQueue: [], workWaiting: false, proposal: void 0, handRound: void 0, meetingMinutes: void 0, reason: "\u5DF2\u6062\u590D\u8BDD\u9898\u8BB0\u5F55\uFF0C\u7B49\u5F85\u660E\u786E\u65B0\u8BDD\u9898\uFF1B\u672A\u81EA\u52A8\u7EE7\u7EED\u539F\u8BA8\u8BBA\u3002" } } : {} };
      else if (row.entity === "room_messages" && value.status === "speaking") value = { ...value, status: "failed", text: "", error: "\u8FD9\u6761\u53D1\u8A00\u5728\u5907\u4EFD\u65F6\u672A\u7ED3\u675F\uFF0C\u6062\u590D\u540E\u672A\u91CD\u53D1\u3002" };
      else if (row.entity === "projects") {
        value = { ...value, collaborationPaused: true, ...value.kind === "roundtable" ? { directory: path2.join(targetDirectory, "roundtable", value.id.replace(/^roundtable-/, ""), "material") } : value.kind === "lounge" ? { directory: path2.join(targetDirectory, value.roomId && value.roomId !== "global" ? path2.join("lounges", `room-lounge-${createHash("sha256").update(value.roomId).digest("hex").slice(0, 24)}`) : "lounge") } : {} };
      }
      update.run(JSON.stringify(value), row.entity, row.id);
    }
    db.prepare("INSERT INTO entities(entity,id,value) VALUES(?,?,?) ON CONFLICT(entity,id) DO UPDATE SET value=excluded.value").run("automation_state", "main", JSON.stringify({ paused: true, at }));
    db.prepare("INSERT INTO entities(entity,id,value) VALUES(?,?,?) ON CONFLICT(entity,id) DO UPDATE SET value=excluded.value").run("restore_info", "main", JSON.stringify({ at, backupId, historyOnly: true }));
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
    }
    throw error;
  } finally {
    db.close();
  }
}
var BackupRestorer = class {
  constructor(dataDirectory) {
    this.dataDirectory = dataDirectory;
    this.dataDirectory = path2.resolve(dataDirectory);
    this.root = backupDirectory(this.dataDirectory);
  }
  dataDirectory;
  pending = /* @__PURE__ */ new Map();
  root;
  async source(id) {
    if (!VALID_ID.test(id) || id === "." || id === "..") throw new Error("\u5907\u4EFD\u7F16\u53F7\u65E0\u6548\u3002");
    await checkedRoot(this.root);
    const source = resolveSafePath(this.root, id);
    if ((await lstat2(source)).isSymbolicLink() || !(await stat(source)).isDirectory()) throw new Error("\u5907\u4EFD\u76EE\u5F55\u65E0\u6548\u3002");
    return source;
  }
  async list() {
    await checkedRoot(this.root);
    const entries = [];
    for (const item of await readdir(this.root, { withFileTypes: true })) {
      if (!item.isDirectory() || !VALID_ID.test(item.name) || item.name.startsWith(".")) continue;
      try {
        const manifest = await readManifest(await this.source(item.name));
        entries.push({ id: item.name, manifest, bytes: manifest.files.reduce((sum, file) => sum + file.size, 0) });
      } catch (error) {
        entries.push({ id: item.name, bytes: 0, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return entries.sort((a, b) => (b.manifest?.createdAt ?? b.id).localeCompare(a.manifest?.createdAt ?? a.id));
  }
  async preview(id) {
    const source = await this.source(id), manifest = await readManifest(source);
    await verifyFiles(source, manifest.files);
    const details = inspectDatabase(path2.join(source, "airoom.sqlite"));
    for (const key of Object.keys(details.counts)) if (details.counts[key] !== manifest.counts[key]) throw new Error("\u5907\u4EFD\u6570\u91CF\u4E0E\u6570\u636E\u5E93\u4E0D\u4E00\u81F4\uFF0C\u8BF7\u6838\u5BF9\u5907\u4EFD\u6E05\u5355\u3002");
    return { id, manifest, bytes: manifest.files.reduce((sum, file) => sum + file.size, 0), memberNames: details.memberNames, historyOnlySessions: details.historyOnlySessions };
  }
  assertRemovable(id) {
    if ([...this.pending.values()].some((entry) => entry.preview.backup.id === id)) throw new Error("\u8FD9\u4EFD\u5907\u4EFD\u6B63\u5728\u51C6\u5907\u6062\u590D\uFF0C\u8BF7\u5148\u53D6\u6D88\u6062\u590D\u3002");
  }
  async remove(id) {
    this.assertRemovable(id);
    const directory = await this.source(id);
    if (path2.dirname(path2.resolve(directory)) !== path2.resolve(this.root)) throw new Error("\u5907\u4EFD\u5220\u9664\u8DEF\u5F84\u65E0\u6548\u3002");
    const inspect = async (folder) => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const file = resolveSafePath(directory, path2.relative(directory, path2.join(folder, entry.name))), info = await lstat2(file);
        if (info.isSymbolicLink()) throw new Error("\u5907\u4EFD\u542B\u76EE\u5F55\u6216\u6587\u4EF6\u94FE\u63A5\uFF0C\u672A\u5220\u9664\uFF0C\u8BF7\u5148\u6838\u5BF9\u5B58\u50A8\u4F4D\u7F6E\u3002");
        if (info.isDirectory()) await inspect(file);
        else if (!info.isFile()) throw new Error("\u5907\u4EFD\u542B\u4E0D\u652F\u6301\u7684\u6587\u4EF6\uFF0C\u672A\u5220\u9664\u3002");
      }
    };
    await inspect(directory);
    await rm(directory, { recursive: true, force: false });
    return { deleted: true };
  }
  async prepare(id) {
    const backup = await this.preview(id), source = await this.source(id), stageRoot = path2.join(path2.dirname(this.dataDirectory), ".restore-previews");
    await checkedRoot(stageRoot);
    const token = randomUUID(), directory = resolveSafePath(stageRoot, token);
    await mkdir(directory);
    try {
      for (const file of backup.manifest.files) {
        const target = resolveSafePath(directory, file.path);
        await mkdir(path2.dirname(target), { recursive: true });
        await copyFile(await checkedFile(source, file.path), target);
      }
      await verifyFiles(directory, backup.manifest.files);
      inspectDatabase(path2.join(directory, "airoom.sqlite"));
      sanitizeRestoredDatabase(path2.join(directory, "airoom.sqlite"), this.dataDirectory, id);
      const files = [];
      for (const file of backup.manifest.files) {
        const target = path2.join(directory, file.path);
        files.push({ ...file, size: (await stat(target)).size, sha256: await digest(target) });
      }
      const preview = { token, backup, expiresAt: new Date(Date.now() + STAGE_LIFETIME).toISOString() };
      this.pending.set(token, { preview, directory, files });
      return preview;
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
  preparation(token) {
    const entry = this.pending.get(token);
    if (!entry || Date.parse(entry.preview.expiresAt) < Date.now()) throw new Error("\u6062\u590D\u9884\u89C8\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9\u5E76\u6821\u9A8C\u5907\u4EFD\u3002");
    return entry;
  }
  async verifyPrepared(token) {
    const entry = this.preparation(token);
    await verifyFiles(entry.directory, entry.files);
    inspectDatabase(path2.join(entry.directory, "airoom.sqlite"));
    return entry.preview;
  }
  async cancel(token) {
    const entry = this.pending.get(token);
    if (!entry) return;
    this.pending.delete(token);
    await rm(entry.directory, { recursive: true, force: true });
  }
  /** Caller must close the execution worker and create a before-restore backup first. */
  async apply(token, beforeBackupId, move = renameWithWindowsRetry) {
    const entry = this.preparation(token);
    await this.verifyPrepared(token);
    const before = await this.preview(beforeBackupId);
    if (before.manifest.reason !== "before-restore") throw new Error("\u66FF\u6362\u524D\u7684\u5F53\u524D\u6570\u636E\u5907\u4EFD\u5C1A\u672A\u786E\u8BA4\uFF0C\u672A\u5F00\u59CB\u6062\u590D\u3002");
    await checkedRoot(this.dataDirectory);
    const parent = path2.dirname(this.dataDirectory), rollbackDirectory = path2.join(parent, `.restore-rollback-${randomUUID()}`);
    await mkdir(rollbackDirectory);
    const old = [], installed = [], file = journalPath(this.dataDirectory);
    if (await exists(file)) throw new RestoreFailure("\u4E0A\u4E00\u4EFD\u6062\u590D\u73B0\u573A\u5C1A\u672A\u6838\u5BF9\uFF0C\u8BF7\u5148\u91CD\u65B0\u542F\u52A8\u5DE5\u4F5C\u53F0\u3002", true);
    const original = [];
    for (const name of REPLACED) if (await exists(path2.join(this.dataDirectory, name))) original.push(name);
    const payload = [];
    for (const name of PAYLOAD) if (await exists(path2.join(entry.directory, name))) payload.push(name);
    const journal = { dataDirectory: this.dataDirectory, stage: entry.directory, rollback: rollbackDirectory, original, payload, phase: "replacing" };
    await saveJournal(file, journal);
    try {
      for (const name of REPLACED) {
        const source = resolveSafePath(this.dataDirectory, name);
        if (!await exists(source)) continue;
        if ((await lstat2(source)).isSymbolicLink()) throw new Error("\u5F53\u524D\u6570\u636E\u5305\u542B\u76EE\u5F55\u94FE\u63A5\uFF0C\u8BF7\u5148\u6838\u5BF9\u540E\u518D\u6062\u590D\u3002");
        await move(source, path2.join(rollbackDirectory, name));
        old.push(name);
      }
      for (const name of PAYLOAD) {
        const source = path2.join(entry.directory, name);
        if (!await exists(source)) continue;
        await move(source, resolveSafePath(this.dataDirectory, name));
        installed.push(name);
      }
      await mkdir(path2.join(this.dataDirectory, "lounge"), { recursive: true });
      await saveJournal(file, { ...journal, phase: "committed" });
    } catch (error) {
      const failures = [];
      for (const name of [...installed].reverse()) try {
        await renameWithWindowsRetry(path2.join(this.dataDirectory, name), path2.join(entry.directory, name));
      } catch (e) {
        failures.push(e);
      }
      for (const name of [...old].reverse()) try {
        await renameWithWindowsRetry(path2.join(rollbackDirectory, name), path2.join(this.dataDirectory, name));
      } catch (e) {
        failures.push(e);
      }
      if (failures.length) throw new RestoreFailure(`\u6062\u590D\u6CA1\u6709\u5B8C\u6210\uFF0C\u81EA\u52A8\u56DE\u9000\u4E5F\u672A\u5168\u90E8\u5B8C\u6210\u3002\u65E7\u6570\u636E\u4FDD\u5B58\u5728 ${rollbackDirectory}\uFF0C\u8BF7\u4FDD\u7559\u73B0\u573A\u3002`, true);
      await rm(file, { force: true });
      throw new RestoreFailure(`\u6062\u590D\u6CA1\u6709\u5B8C\u6210\uFF0C\u5F53\u524D\u6570\u636E\u5DF2\u6062\u590D\u539F\u72B6\uFF1A${error instanceof Error ? error.message : String(error)}`);
    }
    await rm(file, { force: true }).catch(() => {
    });
    this.pending.delete(token);
    await rm(entry.directory, { recursive: true, force: true }).catch(() => {
    });
    return { restored: true, beforeBackupId, rollbackDirectory, detail: "\u5DF2\u6062\u590D\u804A\u5929\u4E0E\u4EBA\u7269\u8D44\u6599\uFF0C\u5F53\u524D\u6210\u5458\u767B\u5F55\u5DF2\u4FDD\u7559\u3002\u65E7\u9879\u76EE\u4F1A\u8BDD\u4EC5\u4F9B\u67E5\u770B\uFF0C\u8BF7\u65B0\u5EFA\u4EFB\u52A1\uFF1B\u81EA\u52A8\u529F\u80FD\u4FDD\u6301\u6682\u505C\u3002" };
  }
};

// src/backend/backup.ts
var BACKUPS_KEPT = 1;
var DEPLOY_BACKUPS_KEPT = BACKUPS_KEPT;
var writers = /* @__PURE__ */ new Map();
var REASONS = ["deploy", "manual", "before-restore"];
var COPIED = ["assets", "attachments"];
var COUNTED = { room_threads: "threads", room_messages: "messages", members: "members", sessions: "sessions", runs: "runs" };
async function digest2(file) {
  const hash = createHash2("sha256");
  for await (const chunk of createReadStream2(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function publishBackupDirectory(partial, directory, move = rename2, platform = process.platform) {
  await renameWithWindowsRetry(partial, directory, { move, platform });
}
async function copyTree(source, target, relative = "") {
  const from = path3.join(source, relative);
  for (const entry of await readdir2(from, { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name, file = path3.join(source, name);
    if ((await lstat3(file)).isSymbolicLink()) throw new Error(`\u8D44\u6599\u76EE\u5F55\u91CC\u6709\u94FE\u63A5\uFF0C\u672A\u5907\u4EFD\uFF1A${name}`);
    if (entry.isDirectory()) {
      await mkdir2(path3.join(target, name), { recursive: true });
      await copyTree(source, target, name);
    } else if (entry.isFile()) await copyFile2(file, path3.join(target, name));
  }
}
async function listFiles(root, relative = "") {
  const files = [];
  for (const entry of await readdir2(path3.join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(root, name));
    else if (entry.isFile() && name !== "manifest.json") files.push(name);
  }
  return files.sort();
}
function origin(dataDirectory) {
  const parent = path3.dirname(path3.resolve(dataDirectory));
  const json = (file) => {
    try {
      return JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
    } catch {
      return void 0;
    }
  };
  const appRoot = path3.resolve(process.env.AIROOM_APP_ROOT ?? process.cwd());
  const installedRoot = path3.basename(appRoot) === "app" && path3.basename(path3.dirname(appRoot)) === "resources" ? path3.resolve(appRoot, "../..") : void 0;
  const receipt = (installedRoot ? json(path3.join(installedRoot, "deployment-receipt.json")) ?? json(path3.join(installedRoot, "build-manifest.json")) : void 0) ?? json(path3.join(parent, "deployment-receipt.json"));
  const app = json(path3.join(appRoot, "package.json")) ?? json(path3.join(parent, "resources", "app", "package.json"));
  return { ...typeof receipt?.sourceCommit === "string" ? { sourceCommit: receipt.sourceCommit } : {}, ...typeof app?.version === "string" ? { appVersion: app.version } : {} };
}
async function createBackup(dataDirectory, reason) {
  const key = path3.resolve(dataDirectory);
  const previous = writers.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {
  }).then(() => writeVerifiedBackup(key, reason));
  writers.set(key, next);
  try {
    return await next;
  } finally {
    if (writers.get(key) === next) writers.delete(key);
  }
}
async function writeVerifiedBackup(dataDirectory, reason) {
  if (!REASONS.includes(reason)) throw new Error("\u5907\u4EFD\u539F\u56E0\u65E0\u6548\u3002");
  dataDirectory = path3.resolve(dataDirectory);
  const database = path3.join(dataDirectory, "airoom.sqlite");
  if (!existsSync2(database)) throw new Error("\u8FD8\u6CA1\u6709\u53EF\u5907\u4EFD\u7684\u8D44\u6599\u3002");
  const root = backupDirectory(dataDirectory);
  await mkdir2(root, { recursive: true });
  if ((await lstat3(root)).isSymbolicLink()) throw new Error("\u5907\u4EFD\u76EE\u5F55\u4E0D\u80FD\u662F\u94FE\u63A5\uFF0C\u8BF7\u5148\u6838\u5BF9\u5B58\u50A8\u4F4D\u7F6E\u3002");
  const createdAt = (/* @__PURE__ */ new Date()).toISOString(), id = `${createdAt.replace(/[:.]/g, "-")}-${reason}-${randomUUID2().slice(0, 8)}`;
  const partial = path3.join(root, `.partial-${id}`), directory = path3.join(root, id);
  await mkdir2(partial);
  try {
    const db = new DatabaseSync2(database);
    try {
      db.exec("PRAGMA busy_timeout = 10000");
      db.exec(`VACUUM INTO '${path3.join(partial, "airoom.sqlite").replaceAll("'", "''")}'`);
    } finally {
      db.close();
    }
    const counts = { threads: 0, messages: 0, members: 0, sessions: 0, runs: 0 };
    const copy = new DatabaseSync2(path3.join(partial, "airoom.sqlite"), { readOnly: true });
    try {
      for (const row of copy.prepare("SELECT entity, COUNT(*) AS count FROM entities GROUP BY entity").all()) if (COUNTED[row.entity]) counts[COUNTED[row.entity]] = Number(row.count);
    } finally {
      copy.close();
    }
    for (const name of COPIED) if (existsSync2(path3.join(dataDirectory, name))) {
      await mkdir2(path3.join(partial, name));
      await copyTree(path3.join(dataDirectory, name), path3.join(partial, name));
    }
    const files = [];
    for (const name of await listFiles(partial)) files.push({ path: name, size: (await stat2(path3.join(partial, name))).size, sha256: await digest2(path3.join(partial, name)) });
    const manifest = { formatVersion: 1, createdAt, reason, ...origin(dataDirectory), counts, files };
    await writeFile2(path3.join(partial, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    await publishBackupDirectory(partial, directory);
    const backups = new BackupRestorer(dataDirectory);
    await backups.preview(id);
    for (const old of await backups.list()) {
      if (old.id === id || !old.manifest || old.error) continue;
      try {
        await backups.preview(old.id);
      } catch {
        continue;
      }
      try {
        await backups.remove(old.id);
      } catch (error) {
        throw new Error(`\u65B0\u5907\u4EFD\u5DF2\u4FDD\u5B58\u5E76\u6821\u9A8C\uFF0C\u4F46\u65E7\u5907\u4EFD\u672A\u80FD\u5220\u9664\uFF1A${old.id}\u3002${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { id, directory, manifest };
  } catch (error) {
    await rm2(partial, { recursive: true, force: true }).catch(() => {
    });
    throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path3.resolve(process.argv[1])).href) {
  const [dataDirectory, reason = "deploy"] = process.argv.slice(2);
  if (!dataDirectory) {
    console.error("\u7528\u6CD5\uFF1Anode backup.mjs <\u8D44\u6599\u76EE\u5F55> [deploy|manual|before-restore]");
    process.exit(2);
  }
  if (!existsSync2(path3.join(dataDirectory, "airoom.sqlite"))) {
    console.log("\u6CA1\u6709\u627E\u5230\u8D44\u6599\u6570\u636E\u5E93\uFF0C\u8DF3\u8FC7\u5907\u4EFD\u3002");
    process.exit(0);
  }
  createBackup(dataDirectory, reason).then((result) => {
    console.log(`\u5DF2\u5907\u4EFD\uFF1A${result.directory}\uFF08${result.manifest.counts.messages} \u6761\u804A\u5929\u3001${result.manifest.counts.members} \u5F20\u4EBA\u7269\u5361\u3001${result.manifest.files.length} \u4E2A\u6587\u4EF6\uFF09`);
  }, (error) => {
    console.error(`\u5907\u4EFD\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
export {
  BACKUPS_KEPT,
  DEPLOY_BACKUPS_KEPT,
  createBackup,
  publishBackupDirectory
};
//# sourceMappingURL=backup.mjs.map
