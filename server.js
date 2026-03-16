#!/usr/bin/env node
"use strict";
/**
 * CodeFire MCP Server — Standalone process for AI coding agents.
 * Exposes project data (tasks, notes, sessions, etc.) via MCP protocol over stdio.
 * Spawned by Claude Code, Gemini CLI, etc. via .mcp.json configuration.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const zod_1 = require("zod");
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const fs_1 = __importDefault(require("fs"));
const child_process_1 = require("child_process");
const util_1 = require("util");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
// ─── Database ────────────────────────────────────────────────────────────────
function getDatabasePath() {
    let dir;
    switch (process.platform) {
        case 'darwin':
            dir = path_1.default.join(os_1.default.homedir(), 'Library', 'Application Support', 'CodeFire');
            break;
        case 'win32':
            dir = path_1.default.join(process.env.APPDATA || path_1.default.join(os_1.default.homedir(), 'AppData', 'Roaming'), 'CodeFire');
            break;
        default:
            dir = path_1.default.join(os_1.default.homedir(), '.config', 'CodeFire');
    }
    fs_1.default.mkdirSync(dir, { recursive: true });
    return path_1.default.join(dir, 'codefire.db');
}
function openDatabase() {
    const dbPath = getDatabasePath();
    if (!fs_1.default.existsSync(dbPath)) {
        throw new Error(`CodeFire database not found at ${dbPath}. Please run the CodeFire app first.`);
    }
    const db = new better_sqlite3_1.default(dbPath, { readonly: false });
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    // Ensure browserCommands.authToken column exists (migration 27 may not have run yet)
    const cols = db.pragma('table_info(browserCommands)');
    if (cols.length > 0 && !cols.some(c => c.name === 'authToken')) {
        db.exec('ALTER TABLE browserCommands ADD COLUMN authToken TEXT;');
    }
    return db;
}
// ─── Connection tracking ─────────────────────────────────────────────────────
function getConnectionDir() {
    let dir;
    switch (process.platform) {
        case 'darwin':
            dir = path_1.default.join(os_1.default.homedir(), '.local', 'share', 'CodeFire', 'mcp-connections');
            break;
        case 'win32':
            dir = path_1.default.join(process.env.APPDATA || path_1.default.join(os_1.default.homedir(), 'AppData', 'Roaming'), 'CodeFire', 'mcp-connections');
            break;
        default:
            dir = path_1.default.join(os_1.default.homedir(), '.local', 'share', 'CodeFire', 'mcp-connections');
    }
    fs_1.default.mkdirSync(dir, { recursive: true });
    return dir;
}
function writeConnectionFile() {
    const connDir = getConnectionDir();
    const filePath = path_1.default.join(connDir, `${process.pid}.json`);
    const data = {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        transport: 'stdio',
    };
    fs_1.default.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return filePath;
}
function removeConnectionFile() {
    try {
        const connDir = getConnectionDir();
        const filePath = path_1.default.join(connDir, `${process.pid}.json`);
        if (fs_1.default.existsSync(filePath))
            fs_1.default.unlinkSync(filePath);
    }
    catch {
        // ignore cleanup errors
    }
}
// ─── Detect project from cwd ────────────────────────────────────────────────
function detectProject(db) {
    const cwd = process.cwd();
    const row = db
        .prepare('SELECT id, name, path FROM projects WHERE ? LIKE path || \'%\' ORDER BY LENGTH(path) DESC LIMIT 1')
        .get(cwd);
    return row ?? null;
}
// ─── MCP Server ──────────────────────────────────────────────────────────────
const db = openDatabase();
const server = new mcp_js_1.McpServer({
    name: 'codefire',
    version: '1.0.4',
});
// ── Projects ─────────────────────────────────────────────────────────────────
server.registerTool('get_current_project', {
    title: 'Get Current Project',
    description: 'Auto-detect the current CodeFire project based on the working directory',
}, async () => {
    const project = detectProject(db);
    if (!project) {
        return { content: [{ type: 'text', text: 'No CodeFire project found for the current working directory.' }] };
    }
    const full = db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id);
    return { content: [{ type: 'text', text: JSON.stringify(full, null, 2) }] };
});
server.registerTool('list_projects', {
    title: 'List Projects',
    description: 'List all CodeFire-tracked projects',
}, async () => {
    const rows = db.prepare('SELECT * FROM projects ORDER BY sortOrder ASC, name ASC').all();
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
});
// ── Tasks ────────────────────────────────────────────────────────────────────
server.registerTool('list_tasks', {
    title: 'List Tasks',
    description: 'List tasks for a project or globally. Filter by status, date range, or both.',
    inputSchema: zod_1.z.object({
        projectId: zod_1.z.string().optional().describe('Project ID. If omitted, lists global tasks.'),
        status: zod_1.z.enum(['todo', 'in_progress', 'done']).optional().describe('Filter by task status'),
        createdAfter: zod_1.z.string().optional().describe('ISO 8601 datetime — only tasks created after this time'),
        createdBefore: zod_1.z.string().optional().describe('ISO 8601 datetime — only tasks created before this time'),
        updatedAfter: zod_1.z.string().optional().describe('ISO 8601 datetime — only tasks updated after this time'),
        updatedBefore: zod_1.z.string().optional().describe('ISO 8601 datetime — only tasks updated before this time'),
    }),
}, async ({ projectId, status, createdAfter, createdBefore, updatedAfter, updatedBefore }) => {
    const conditions = [];
    const params = [];
    if (projectId) {
        conditions.push('projectId = ?');
        params.push(projectId);
    }
    else {
        conditions.push('isGlobal = 1');
    }
    if (status) {
        conditions.push('status = ?');
        params.push(status);
    }
    if (createdAfter) {
        conditions.push('createdAt >= ?');
        params.push(createdAfter);
    }
    if (createdBefore) {
        conditions.push('createdAt <= ?');
        params.push(createdBefore);
    }
    if (updatedAfter) {
        conditions.push('updatedAt >= ?');
        params.push(updatedAfter);
    }
    if (updatedBefore) {
        conditions.push('updatedAt <= ?');
        params.push(updatedBefore);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT * FROM taskItems ${where} ORDER BY priority DESC, createdAt DESC`).all(...params);
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
});
server.registerTool('get_task', {
    title: 'Get Task',
    description: 'Get a task by ID, including its notes',
    inputSchema: zod_1.z.object({
        taskId: zod_1.z.number().describe('Task ID'),
    }),
}, async ({ taskId }) => {
    const task = db.prepare('SELECT * FROM taskItems WHERE id = ?').get(taskId);
    if (!task) {
        return { content: [{ type: 'text', text: `Task ${taskId} not found.` }] };
    }
    const notes = db.prepare('SELECT * FROM taskNotes WHERE taskId = ? ORDER BY createdAt ASC').all(taskId);
    return { content: [{ type: 'text', text: JSON.stringify({ ...task, notes }, null, 2) }] };
});
server.registerTool('create_task', {
    title: 'Create Task',
    description: 'Create a new task in CodeFire',
    inputSchema: zod_1.z.object({
        projectId: zod_1.z.string().describe('Project ID'),
        title: zod_1.z.string().describe('Task title'),
        description: zod_1.z.string().optional().describe('Task description'),
        priority: zod_1.z.number().min(0).max(4).optional().describe('Priority 0-4 (4 = highest)'),
        isGlobal: zod_1.z.boolean().optional().describe('Whether this is a global task'),
    }),
}, async ({ projectId, title, description, priority, isGlobal }) => {
    // Deduplicate: if an active (non-done) task with the same title exists, return it
    // instead of creating a duplicate. Done tasks are allowed to be recreated.
    const existing = db.prepare(`SELECT * FROM taskItems WHERE projectId = ? AND title = ? COLLATE NOCASE AND status != 'done'`).get(projectId, title);
    if (existing) {
        return { content: [{ type: 'text', text: JSON.stringify(existing, null, 2) }] };
    }
    const now = new Date().toISOString();
    const result = db
        .prepare(`INSERT INTO taskItems (projectId, title, description, status, priority, source, isGlobal, createdAt, updatedAt)
         VALUES (?, ?, ?, 'todo', ?, 'mcp', ?, ?, ?)`)
        .run(projectId, title, description ?? null, Math.min(4, Math.max(0, priority ?? 0)), isGlobal ? 1 : 0, now, now);
    const task = db.prepare('SELECT * FROM taskItems WHERE id = ?').get(result.lastInsertRowid);
    return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
});
server.registerTool('update_task', {
    title: 'Update Task',
    description: 'Update a task (title, description, status, priority)',
    inputSchema: zod_1.z.object({
        taskId: zod_1.z.number().describe('Task ID'),
        title: zod_1.z.string().optional().describe('New title'),
        description: zod_1.z.string().optional().describe('New description'),
        status: zod_1.z.enum(['todo', 'in_progress', 'done']).optional().describe('New status'),
        priority: zod_1.z.number().min(0).max(4).optional().describe('New priority 0-4'),
    }),
}, async ({ taskId, title, description, status, priority }) => {
    const existing = db.prepare('SELECT * FROM taskItems WHERE id = ?').get(taskId);
    if (!existing) {
        return { content: [{ type: 'text', text: `Task ${taskId} not found.` }] };
    }
    const now = new Date().toISOString();
    const completedAt = status === 'done' && existing.status !== 'done'
        ? now
        : status && status !== 'done'
            ? null
            : existing.completedAt;
    const updatedAt = (status && status !== existing.status) ? now : (existing.updatedAt ?? now);
    db.prepare(`UPDATE taskItems SET title = ?, description = ?, status = ?, priority = ?, completedAt = ?, updatedAt = ? WHERE id = ?`).run(title ?? existing.title, description ?? existing.description, status ?? existing.status, priority ?? existing.priority, completedAt, updatedAt, taskId);
    const updated = db.prepare('SELECT * FROM taskItems WHERE id = ?').get(taskId);
    return { content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }] };
});
// ── Task Notes ───────────────────────────────────────────────────────────────
server.registerTool('list_task_notes', {
    title: 'List Task Notes',
    description: 'Get all notes for a specific task. Supports date-range filtering.',
    inputSchema: zod_1.z.object({
        taskId: zod_1.z.number().describe('Task ID'),
        createdAfter: zod_1.z.string().optional().describe('ISO 8601 datetime — only notes created after this time'),
        createdBefore: zod_1.z.string().optional().describe('ISO 8601 datetime — only notes created before this time'),
    }),
}, async ({ taskId, createdAfter, createdBefore }) => {
    const conditions = ['taskId = ?'];
    const params = [taskId];
    if (createdAfter) {
        conditions.push('createdAt >= ?');
        params.push(createdAfter);
    }
    if (createdBefore) {
        conditions.push('createdAt <= ?');
        params.push(createdBefore);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;
    const notes = db.prepare(`SELECT * FROM taskNotes ${where} ORDER BY createdAt ASC`).all(...params);
    return { content: [{ type: 'text', text: JSON.stringify(notes, null, 2) }] };
});
server.registerTool('create_task_note', {
    title: 'Create Task Note',
    description: 'Add a note to a task',
    inputSchema: zod_1.z.object({
        taskId: zod_1.z.number().describe('Task ID'),
        content: zod_1.z.string().describe('Note content'),
    }),
}, async ({ taskId, content }) => {
    const now = new Date().toISOString();
    const result = db
        .prepare('INSERT INTO taskNotes (taskId, content, source, createdAt) VALUES (?, ?, ?, ?)')
        .run(taskId, content, 'mcp', now);
    const note = db.prepare('SELECT * FROM taskNotes WHERE id = ?').get(result.lastInsertRowid);
    return { content: [{ type: 'text', text: JSON.stringify(note, null, 2) }] };
});
// ── Notes ────────────────────────────────────────────────────────────────────
server.registerTool('list_notes', {
    title: 'List Notes',
    description: 'List notes for a project or globally. Supports date-range filtering.',
    inputSchema: zod_1.z.object({
        projectId: zod_1.z.string().optional().describe('Project ID. If omitted, lists global notes.'),
        pinnedOnly: zod_1.z.boolean().optional().describe('Only return pinned notes'),
        createdAfter: zod_1.z.string().optional().describe('ISO 8601 datetime — only notes created after this time'),
        createdBefore: zod_1.z.string().optional().describe('ISO 8601 datetime — only notes created before this time'),
        updatedAfter: zod_1.z.string().optional().describe('ISO 8601 datetime — only notes updated after this time'),
        updatedBefore: zod_1.z.string().optional().describe('ISO 8601 datetime — only notes updated before this time'),
    }),
}, async ({ projectId, pinnedOnly, createdAfter, createdBefore, updatedAfter, updatedBefore }) => {
    const conditions = [];
    const params = [];
    if (projectId) {
        conditions.push('projectId = ?');
        params.push(projectId);
    }
    else {
        conditions.push('isGlobal = 1');
    }
    if (pinnedOnly) {
        conditions.push('pinned = 1');
    }
    if (createdAfter) {
        conditions.push('createdAt >= ?');
        params.push(createdAfter);
    }
    if (createdBefore) {
        conditions.push('createdAt <= ?');
        params.push(createdBefore);
    }
    if (updatedAfter) {
        conditions.push('updatedAt >= ?');
        params.push(updatedAfter);
    }
    if (updatedBefore) {
        conditions.push('updatedAt <= ?');
        params.push(updatedBefore);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT * FROM notes ${where} ORDER BY updatedAt DESC`).all(...params);
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
});
server.registerTool('get_note', {
    title: 'Get Note',
    description: 'Get a single note by ID',
    inputSchema: zod_1.z.object({
        noteId: zod_1.z.number().describe('Note ID'),
    }),
}, async ({ noteId }) => {
    const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId);
    if (!note) {
        return { content: [{ type: 'text', text: `Note ${noteId} not found.` }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(note, null, 2) }] };
});
server.registerTool('create_note', {
    title: 'Create Note',
    description: 'Create a new note',
    inputSchema: zod_1.z.object({
        projectId: zod_1.z.string().describe('Project ID'),
        title: zod_1.z.string().describe('Note title'),
        content: zod_1.z.string().optional().describe('Note content (markdown)'),
        isGlobal: zod_1.z.boolean().optional().describe('Whether this is a global note'),
    }),
}, async ({ projectId, title, content, isGlobal }) => {
    const now = new Date().toISOString();
    const result = db
        .prepare('INSERT INTO notes (projectId, title, content, pinned, isGlobal, createdAt, updatedAt) VALUES (?, ?, ?, 0, ?, ?, ?)')
        .run(projectId, title, content ?? '', isGlobal ? 1 : 0, now, now);
    const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(result.lastInsertRowid);
    return { content: [{ type: 'text', text: JSON.stringify(note, null, 2) }] };
});
server.registerTool('update_note', {
    title: 'Update Note',
    description: 'Update a note',
    inputSchema: zod_1.z.object({
        noteId: zod_1.z.number().describe('Note ID'),
        title: zod_1.z.string().optional().describe('New title'),
        content: zod_1.z.string().optional().describe('New content'),
    }),
}, async ({ noteId, title, content }) => {
    const existing = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId);
    if (!existing) {
        return { content: [{ type: 'text', text: `Note ${noteId} not found.` }] };
    }
    const now = new Date().toISOString();
    db.prepare('UPDATE notes SET title = ?, content = ?, updatedAt = ? WHERE id = ?').run(title ?? existing.title, content ?? existing.content, now, noteId);
    const updated = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId);
    return { content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }] };
});
server.registerTool('search_notes', {
    title: 'Search Notes',
    description: 'Full-text search across notes. Supports date-range filtering.',
    inputSchema: zod_1.z.object({
        query: zod_1.z.string().describe('Search query'),
        projectId: zod_1.z.string().optional().describe('Limit search to a project'),
        createdAfter: zod_1.z.string().optional().describe('ISO 8601 datetime — only notes created after this time'),
        createdBefore: zod_1.z.string().optional().describe('ISO 8601 datetime — only notes created before this time'),
        updatedAfter: zod_1.z.string().optional().describe('ISO 8601 datetime — only notes updated after this time'),
        updatedBefore: zod_1.z.string().optional().describe('ISO 8601 datetime — only notes updated before this time'),
    }),
}, async ({ query, projectId, createdAfter, createdBefore, updatedAfter, updatedBefore }) => {
    const conditions = ['notesFts MATCH ?'];
    const params = [query];
    if (projectId) {
        conditions.push('notes.projectId = ?');
        params.push(projectId);
    }
    if (createdAfter) {
        conditions.push('notes.createdAt >= ?');
        params.push(createdAfter);
    }
    if (createdBefore) {
        conditions.push('notes.createdAt <= ?');
        params.push(createdBefore);
    }
    if (updatedAfter) {
        conditions.push('notes.updatedAt >= ?');
        params.push(updatedAfter);
    }
    if (updatedBefore) {
        conditions.push('notes.updatedAt <= ?');
        params.push(updatedBefore);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;
    const rows = db.prepare(`SELECT notes.* FROM notes JOIN notesFts ON notes.id = notesFts.rowid ${where} ORDER BY rank`).all(...params);
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
});
// ── Sessions ─────────────────────────────────────────────────────────────────
server.registerTool('list_sessions', {
    title: 'List Sessions',
    description: 'List coding sessions for a project. Supports date-range filtering.',
    inputSchema: zod_1.z.object({
        projectId: zod_1.z.string().describe('Project ID'),
        limit: zod_1.z.number().optional().describe('Max results (default 20)'),
        startedAfter: zod_1.z.string().optional().describe('ISO 8601 datetime — only sessions started after this time'),
        startedBefore: zod_1.z.string().optional().describe('ISO 8601 datetime — only sessions started before this time'),
    }),
}, async ({ projectId, limit, startedAfter, startedBefore }) => {
    const conditions = ['projectId = ?'];
    const params = [projectId];
    if (startedAfter) {
        conditions.push('startedAt >= ?');
        params.push(startedAfter);
    }
    if (startedBefore) {
        conditions.push('startedAt <= ?');
        params.push(startedBefore);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;
    const rows = db
        .prepare(`SELECT * FROM sessions ${where} ORDER BY startedAt DESC LIMIT ?`)
        .all(...params, limit ?? 20);
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
});
server.registerTool('search_sessions', {
    title: 'Search Sessions',
    description: 'Full-text search across session summaries',
    inputSchema: zod_1.z.object({
        query: zod_1.z.string().describe('Search query'),
    }),
}, async ({ query }) => {
    const rows = db.prepare(`SELECT sessions.* FROM sessions
       JOIN sessionsFts ON sessions.rowid = sessionsFts.rowid
       WHERE sessionsFts MATCH ?
       ORDER BY rank`).all(query);
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
});
// ── Clients ──────────────────────────────────────────────────────────────────
server.registerTool('list_clients', {
    title: 'List Clients',
    description: 'List all billing clients',
}, async () => {
    const rows = db.prepare('SELECT * FROM clients ORDER BY sortOrder ASC, name ASC').all();
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
});
server.registerTool('create_client', {
    title: 'Create Client',
    description: 'Create a new billing client',
    inputSchema: zod_1.z.object({
        name: zod_1.z.string().describe('Client name'),
        color: zod_1.z.string().optional().describe('Hex color (default #3B82F6)'),
    }),
}, async ({ name, color }) => {
    const { randomUUID } = await Promise.resolve().then(() => __importStar(require('crypto')));
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare('INSERT INTO clients (id, name, color, sortOrder, createdAt) VALUES (?, ?, ?, 0, ?)').run(id, name, color ?? '#3B82F6', now);
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
    return { content: [{ type: 'text', text: JSON.stringify(client, null, 2) }] };
});
// ── Images ───────────────────────────────────────────────────────────────────
server.registerTool('list_images', {
    title: 'List Images',
    description: 'List generated images for a project',
    inputSchema: zod_1.z.object({
        projectId: zod_1.z.string().describe('Project ID'),
    }),
}, async ({ projectId }) => {
    const rows = db.prepare('SELECT * FROM generatedImages WHERE projectId = ? ORDER BY createdAt DESC').all(projectId);
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
});
// ── Code Search ──────────────────────────────────────────────────────────────
server.registerTool('search_code', {
    title: 'Search Code',
    description: 'Full-text search across indexed code chunks (requires indexing to be enabled)',
    inputSchema: zod_1.z.object({
        query: zod_1.z.string().describe('Search query'),
        projectId: zod_1.z.string().optional().describe('Limit search to a project'),
        limit: zod_1.z.number().optional().describe('Max results (default 10)'),
    }),
}, async ({ query, projectId, limit }) => {
    try {
        const rows = projectId
            ? db.prepare(`SELECT codeChunks.*, bm25(codeChunksFts) AS score FROM codeChunks
             JOIN codeChunksFts ON codeChunks.id = codeChunksFts.rowid
             WHERE codeChunksFts MATCH ? AND codeChunks.projectId = ?
             ORDER BY score LIMIT ?`).all(query, projectId, limit ?? 10)
            : db.prepare(`SELECT codeChunks.*, bm25(codeChunksFts) AS score FROM codeChunks
             JOIN codeChunksFts ON codeChunks.id = codeChunksFts.rowid
             WHERE codeChunksFts MATCH ?
             ORDER BY score LIMIT ?`).all(query, limit ?? 10);
        return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
    }
    catch {
        return { content: [{ type: 'text', text: 'Code search index not available. Enable semantic code search in CodeFire settings.' }] };
    }
});
// ── Browser Automation ───────────────────────────────────────────────────
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/** Read the browser session token written by the main Electron process */
function getBrowserSessionToken() {
    try {
        const appData = process.platform === 'win32'
            ? path_1.default.join(process.env.APPDATA || path_1.default.join(os_1.default.homedir(), 'AppData', 'Roaming'), 'CodeFire')
            : process.platform === 'darwin'
                ? path_1.default.join(os_1.default.homedir(), 'Library', 'Application Support', 'CodeFire')
                : path_1.default.join(os_1.default.homedir(), '.config', 'CodeFire');
        const tokenPath = path_1.default.join(appData, '.browser-session-token');
        return fs_1.default.readFileSync(tokenPath, 'utf-8').trim();
    }
    catch {
        return null;
    }
}
async function executeBrowserCommand(tool, args = {}, timeout = 5.0) {
    const argsJSON = Object.keys(args).length > 0 ? JSON.stringify(args) : null;
    const now = new Date().toISOString();
    const authToken = getBrowserSessionToken();
    const result = db
        .prepare('INSERT INTO browserCommands (tool, args, status, createdAt, authToken) VALUES (?, ?, ?, ?, ?)')
        .run(tool, argsJSON, 'pending', now, authToken);
    const commandId = result.lastInsertRowid;
    const startTime = Date.now();
    const timeoutMs = timeout * 1000;
    while (Date.now() - startTime < timeoutMs) {
        await sleep(50);
        const cmd = db
            .prepare('SELECT * FROM browserCommands WHERE id = ?')
            .get(commandId);
        if (!cmd) {
            throw new Error(`Browser command ${commandId} disappeared`);
        }
        if (cmd.status === 'completed') {
            db.prepare('DELETE FROM browserCommands WHERE id = ?').run(commandId);
            return cmd.result ?? '{}';
        }
        if (cmd.status === 'error') {
            db.prepare('DELETE FROM browserCommands WHERE id = ?').run(commandId);
            throw new Error(cmd.result ?? 'Browser command failed');
        }
    }
    // Timeout — clean up
    db.prepare('DELETE FROM browserCommands WHERE id = ?').run(commandId);
    throw new Error(`Browser command timed out after ${Math.round(timeout)}s. Is CodeFire running with the browser tab visible?`);
}
function textResult(text) {
    return { content: [{ type: 'text', text }] };
}
// ── browser_navigate ─────────────────────────────────────────────────────
server.registerTool('browser_navigate', {
    title: 'Browser Navigate',
    description: 'Navigate the browser to a URL. Opens a new tab if none are open. Waits for page load to complete. Requires CodeFire to be running.',
    inputSchema: zod_1.z.object({
        url: zod_1.z.string().describe('URL to navigate to'),
    }),
}, async ({ url }) => {
    const result = await executeBrowserCommand('browser_navigate', { url }, 15.0);
    return textResult(result);
});
// ── browser_snapshot ─────────────────────────────────────────────────────
server.registerTool('browser_snapshot', {
    title: 'Browser Snapshot',
    description: 'Get the accessibility tree of the current page as compact structured text. Returns ARIA roles, labels, and interactive element refs. This is the primary tool for understanding page content and structure. Requires CodeFire to be running.',
    inputSchema: zod_1.z.object({
        tab_id: zod_1.z.string().optional().describe('Tab ID (defaults to active tab)'),
        max_size: zod_1.z
            .number()
            .optional()
            .describe('Maximum response size in bytes (default: 102400 = 100KB). Set to 0 for unlimited. Large pages may be truncated with a hint to use browser_extract.'),
    }),
}, async ({ tab_id, max_size }) => {
    const args = {};
    if (tab_id)
        args.tab_id = tab_id;
    if (max_size !== undefined)
        args.max_size = max_size;
    const result = await executeBrowserCommand('browser_snapshot', args, 10.0);
    return textResult(result);
});
// ── browser_extract ──────────────────────────────────────────────────────
server.registerTool('browser_extract', {
    title: 'Browser Extract',
    description: 'Extract text content from a page element using a CSS selector. Returns the text content of the first matching element. Requires CodeFire to be running.',
    inputSchema: zod_1.z.object({
        selector: zod_1.z.string().describe('CSS selector to find the element'),
        tab_id: zod_1.z.string().optional().describe('Tab ID (defaults to active tab)'),
    }),
}, async ({ selector, tab_id }) => {
    const args = { selector };
    if (tab_id)
        args.tab_id = tab_id;
    const result = await executeBrowserCommand('browser_extract', args);
    return textResult(result);
});
// ── browser_list_tabs ────────────────────────────────────────────────────
server.registerTool('browser_list_tabs', {
    title: 'Browser List Tabs',
    description: 'List all open browser tabs with their URLs, titles, and loading state. Requires CodeFire to be running.',
}, async () => {
    const result = await executeBrowserCommand('browser_list_tabs');
    return textResult(result);
});
// ── browser_console_logs ─────────────────────────────────────────────────
server.registerTool('browser_console_logs', {
    title: 'Browser Console Logs',
    description: 'Get JavaScript console log entries (log, warn, error, info) from a browser tab. Useful for debugging web applications. Requires CodeFire to be running.',
    inputSchema: zod_1.z.object({
        tab_id: zod_1.z.string().optional().describe('Tab ID (defaults to active tab)'),
        level: zod_1.z
            .enum(['log', 'warn', 'error', 'info'])
            .optional()
            .describe('Filter by level: log, warn, error, info'),
    }),
}, async ({ tab_id, level }) => {
    const args = {};
    if (tab_id)
        args.tab_id = tab_id;
    if (level)
        args.level = level;
    const result = await executeBrowserCommand('browser_console_logs', args);
    return textResult(result);
});
// ── browser_screenshot ───────────────────────────────────────────────────
server.registerTool('browser_screenshot', {
    title: 'Browser Screenshot',
    description: 'Take a PNG screenshot of the current page. Returns the file path so you can read the image. Requires CodeFire to be running.',
    inputSchema: zod_1.z.object({
        tab_id: zod_1.z.string().optional().describe('Tab ID (defaults to active tab)'),
    }),
}, async ({ tab_id }) => {
    const args = {};
    if (tab_id)
        args.tab_id = tab_id;
    const result = await executeBrowserCommand('browser_screenshot', args, 10.0);
    return textResult(result);
});
// ── browser_tab_open ─────────────────────────────────────────────────────
server.registerTool('browser_tab_open', {
    title: 'Browser Tab Open',
    description: 'Open a new browser tab. Optionally navigate to a URL. Requires CodeFire to be running.',
    inputSchema: zod_1.z.object({
        url: zod_1.z.string().optional().describe('URL to navigate to (optional)'),
    }),
}, async ({ url }) => {
    const args = {};
    if (url)
        args.url = url;
    const result = await executeBrowserCommand('browser_tab_open', args, 15.0);
    return textResult(result);
});
// ── browser_tab_close ────────────────────────────────────────────────────
server.registerTool('browser_tab_close', {
    title: 'Browser Tab Close',
    description: 'Close a browser tab by its ID. Requires CodeFire to be running.',
    inputSchema: zod_1.z.object({
        tab_id: zod_1.z.string().describe('ID of the tab to close'),
    }),
}, async ({ tab_id }) => {
    const result = await executeBrowserCommand('browser_tab_close', { tab_id });
    return textResult(result);
});
// ── browser_tab_switch ───────────────────────────────────────────────────
server.registerTool('browser_tab_switch', {
    title: 'Browser Tab Switch',
    description: 'Switch the active browser tab to the specified tab. Requires CodeFire to be running.',
    inputSchema: zod_1.z.object({
        tab_id: zod_1.z.string().describe('ID of the tab to switch to'),
    }),
}, async ({ tab_id }) => {
    const result = await executeBrowserCommand('browser_tab_switch', { tab_id });
    return textResult(result);
});
// ── browser_click ────────────────────────────────────────────────────────
server.registerTool('browser_click', {
    title: 'Browser Click',
    description: "Click an element by its ref from browser_snapshot. Automatically scrolls into view first. Requires CodeFire to be running with the browser tab visible.",
    inputSchema: zod_1.z.object({
        ref: zod_1.z.string().describe("Element ref from browser_snapshot (e.g. 'e5')"),
        tab_id: zod_1.z.string().optional().describe('Tab ID (defaults to active tab)'),
    }),
}, async ({ ref, tab_id }) => {
    const args = { ref };
    if (tab_id)
        args.tab_id = tab_id;
    const result = await executeBrowserCommand('browser_click', args);
    return textResult(result);
});
// ── browser_type ─────────────────────────────────────────────────────────
server.registerTool('browser_type', {
    title: 'Browser Type',
    description: 'Type text into an input or textarea element by ref. Clears existing content by default. Works with React and other framework-controlled inputs. Requires CodeFire to be running with the browser tab visible.',
    inputSchema: zod_1.z.object({
        ref: zod_1.z.string().describe('Element ref from browser_snapshot'),
        text: zod_1.z.string().describe('Text to type'),
        clear: zod_1.z.boolean().optional().describe('Clear existing content first (default: true)'),
        tab_id: zod_1.z.string().optional().describe('Tab ID (defaults to active tab)'),
    }),
}, async ({ ref, text, clear, tab_id }) => {
    const args = { ref, text };
    if (clear !== undefined)
        args.clear = clear;
    if (tab_id)
        args.tab_id = tab_id;
    const result = await executeBrowserCommand('browser_type', args);
    return textResult(result);
});
// ── browser_select ───────────────────────────────────────────────────────
server.registerTool('browser_select', {
    title: 'Browser Select',
    description: 'Select an option from a <select> dropdown by value or visible label text. On mismatch, returns all available options. Requires CodeFire to be running with the browser tab visible.',
    inputSchema: zod_1.z.object({
        ref: zod_1.z.string().describe('Element ref of the <select> element'),
        value: zod_1.z.string().optional().describe('Option value to select'),
        label: zod_1.z
            .string()
            .optional()
            .describe('Option visible text to select (alternative to value)'),
        tab_id: zod_1.z.string().optional().describe('Tab ID (defaults to active tab)'),
    }),
}, async ({ ref, value, label, tab_id }) => {
    if (!value && !label) {
        throw new Error('value or label is required');
    }
    const args = { ref };
    if (value)
        args.value = value;
    if (label)
        args.label = label;
    if (tab_id)
        args.tab_id = tab_id;
    const result = await executeBrowserCommand('browser_select', args);
    return textResult(result);
});
// ── browser_scroll ───────────────────────────────────────────────────────
server.registerTool('browser_scroll', {
    title: 'Browser Scroll',
    description: 'Scroll the page by direction/amount, or scroll a specific element into view. Returns scroll position info. Requires CodeFire to be running with the browser tab visible.',
    inputSchema: zod_1.z.object({
        ref: zod_1.z
            .string()
            .optional()
            .describe('Scroll this element into view (overrides direction/amount)'),
        direction: zod_1.z
            .enum(['up', 'down', 'top', 'bottom'])
            .optional()
            .describe('Scroll direction'),
        amount: zod_1.z
            .number()
            .optional()
            .describe('Pixels to scroll (default: 500, ignored for top/bottom)'),
        tab_id: zod_1.z.string().optional().describe('Tab ID (defaults to active tab)'),
    }),
}, async ({ ref, direction, amount, tab_id }) => {
    const args = {};
    if (ref)
        args.ref = ref;
    if (direction)
        args.direction = direction;
    if (amount !== undefined)
        args.amount = amount;
    if (tab_id)
        args.tab_id = tab_id;
    const result = await executeBrowserCommand('browser_scroll', args);
    return textResult(result);
});
// ── browser_wait ─────────────────────────────────────────────────────────
server.registerTool('browser_wait', {
    title: 'Browser Wait',
    description: 'Wait for an element to appear on the page. Use after clicking something that triggers async loading. Accepts ref or CSS selector. Returns found status, not an error on timeout. Requires CodeFire to be running with the browser tab visible.',
    inputSchema: zod_1.z.object({
        ref: zod_1.z.string().optional().describe('Wait for element with this ref to exist'),
        selector: zod_1.z
            .string()
            .optional()
            .describe('CSS selector to wait for (use when element has no ref yet)'),
        timeout: zod_1.z
            .number()
            .optional()
            .describe('Max seconds to wait (default: 5, max: 15)'),
        tab_id: zod_1.z.string().optional().describe('Tab ID (defaults to active tab)'),
    }),
}, async ({ ref, selector, timeout: userTimeout, tab_id }) => {
    if (!ref && !selector) {
        throw new Error('ref or selector is required');
    }
    const args = {};
    if (ref)
        args.ref = ref;
    if (selector)
        args.selector = selector;
    const t = userTimeout ?? 5;
    args.timeout = t;
    if (tab_id)
        args.tab_id = tab_id;
    const swiftTimeout = Math.min(t, 15) + 3.0;
    const result = await executeBrowserCommand('browser_wait', args, swiftTimeout);
    return textResult(result);
});
// ── browser_press ────────────────────────────────────────────────────────
server.registerTool('browser_press', {
    title: 'Browser Press',
    description: 'Press a key or key combination. Targets a specific element by ref, or the currently focused element if no ref is provided. Handles Enter (submits forms), Tab (moves focus), Escape, arrow keys, and any single character. Requires CodeFire to be running with the browser tab visible.',
    inputSchema: zod_1.z.object({
        key: zod_1.z
            .string()
            .describe('Key to press: Enter, Tab, Escape, Backspace, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Space, Delete, Home, End, PageUp, PageDown, or any single character'),
        modifiers: zod_1.z
            .array(zod_1.z.enum(['shift', 'ctrl', 'alt', 'meta']))
            .optional()
            .describe("Modifier keys to hold (e.g. ['meta'] for Cmd+key on Mac)"),
        ref: zod_1.z
            .string()
            .optional()
            .describe('Element ref to target (defaults to currently focused element)'),
        tab_id: zod_1.z.string().optional().describe('Tab ID (defaults to active tab)'),
    }),
}, async ({ key, modifiers, ref, tab_id }) => {
    const args = { key };
    if (ref)
        args.ref = ref;
    if (modifiers)
        args.modifiers = modifiers;
    if (tab_id)
        args.tab_id = tab_id;
    const result = await executeBrowserCommand('browser_press', args);
    return textResult(result);
});
// ── browser_eval ─────────────────────────────────────────────────────────
server.registerTool('browser_eval', {
    title: 'Browser Eval',
    description: "Execute JavaScript on the page and return the result. The expression runs inside an async function body, so use 'return' to return values and 'await' for promises. Use for reading page state, calling APIs, or handling edge cases other tools can't cover. Requires CodeFire to be running with the browser tab visible. WARNING: This tool executes arbitrary JS in the browser context — use with caution.",
    inputSchema: zod_1.z.object({
        expression: zod_1.z
            .string()
            .describe("JavaScript to evaluate. Use 'return' to return a value (e.g. 'return document.title')"),
        tab_id: zod_1.z.string().optional().describe('Tab ID (defaults to active tab)'),
    }),
    annotations: {
        destructiveHint: true,
        readOnlyHint: false,
        openWorldHint: true,
    },
}, async ({ expression, tab_id }) => {
    const args = { expression };
    if (tab_id)
        args.tab_id = tab_id;
    const result = await executeBrowserCommand('browser_eval', args, 10.0);
    return textResult(result);
});
// ── browser_hover ────────────────────────────────────────────────────────
server.registerTool('browser_hover', {
    title: 'Browser Hover',
    description: 'Hover over an element by ref. Dispatches mouseenter and mouseover events. Useful for dropdown menus, tooltips, and hover-state UI that requires mouse presence. Scrolls element into view first. Requires CodeFire to be running with the browser tab visible.',
    inputSchema: zod_1.z.object({
        ref: zod_1.z.string().describe('Element ref from browser_snapshot'),
        tab_id: zod_1.z.string().optional().describe('Tab ID (defaults to active tab)'),
    }),
}, async ({ ref, tab_id }) => {
    const args = { ref };
    if (tab_id)
        args.tab_id = tab_id;
    const result = await executeBrowserCommand('browser_hover', args);
    return textResult(result);
});
// ── browser_upload ───────────────────────────────────────────────────────
server.registerTool('browser_upload', {
    title: 'Browser Upload',
    description: "Set a file on an <input type='file'> element. Reads the file from disk, encodes it, and assigns it to the input. Triggers change and input events. Requires CodeFire to be running with the browser tab visible.",
    inputSchema: zod_1.z.object({
        ref: zod_1.z
            .string()
            .describe('Element ref of the file input from browser_snapshot'),
        path: zod_1.z
            .string()
            .describe('Absolute path to the file on disk (must be within project directory)'),
        tab_id: zod_1.z.string().optional().describe('Tab ID (defaults to active tab)'),
        project_id: zod_1.z
            .string()
            .optional()
            .describe('Project ID (auto-detected if omitted)'),
    }),
}, async ({ ref, path: filePath, tab_id, project_id }) => {
    // Resolve project path for validation
    let projectPath = null;
    if (project_id) {
        const row = db
            .prepare('SELECT path FROM projects WHERE id = ?')
            .get(project_id);
        if (row)
            projectPath = row.path;
    }
    else {
        const project = detectProject(db);
        if (project)
            projectPath = project.path;
    }
    if (projectPath) {
        const resolvedFile = fs_1.default.realpathSync(filePath);
        const resolvedProject = fs_1.default.realpathSync(projectPath);
        if (!resolvedFile.startsWith(resolvedProject + '/') &&
            !resolvedFile.startsWith(resolvedProject + '\\')) {
            throw new Error(`Upload path must be within the project directory. Got: ${filePath}`);
        }
    }
    const args = { ref, path: filePath };
    if (tab_id)
        args.tab_id = tab_id;
    const result = await executeBrowserCommand('browser_upload', args, 10.0);
    return textResult(result);
});
// ── browser_drag ─────────────────────────────────────────────────────────
server.registerTool('browser_drag', {
    title: 'Browser Drag',
    description: 'Drag an element to a target element using HTML5 drag and drop events. Dispatches the full drag event sequence: dragstart, drag, dragenter, dragover, drop, dragend. Requires CodeFire to be running with the browser tab visible.',
    inputSchema: zod_1.z.object({
        from_ref: zod_1.z.string().describe('Ref of the element to drag'),
        to_ref: zod_1.z.string().describe('Ref of the drop target element'),
        tab_id: zod_1.z.string().optional().describe('Tab ID (defaults to active tab)'),
    }),
}, async ({ from_ref, to_ref, tab_id }) => {
    const args = { from_ref, to_ref };
    if (tab_id)
        args.tab_id = tab_id;
    const result = await executeBrowserCommand('browser_drag', args);
    return textResult(result);
});
// ── browser_iframe ───────────────────────────────────────────────────────
server.registerTool('browser_iframe', {
    title: 'Browser Iframe',
    description: 'Switch execution context to an iframe for subsequent commands (snapshot, click, type, etc.), or back to the main frame. Call with a ref to enter an iframe, or without ref to return to main frame. Only same-origin iframes are accessible. Use browser_snapshot to see available iframes. Requires CodeFire to be running with the browser tab visible.',
    inputSchema: zod_1.z.object({
        ref: zod_1.z
            .string()
            .optional()
            .describe('Ref of the iframe element to enter. Omit to return to main frame.'),
        tab_id: zod_1.z.string().optional().describe('Tab ID (defaults to active tab)'),
    }),
}, async ({ ref, tab_id }) => {
    const args = {};
    if (ref)
        args.ref = ref;
    if (tab_id)
        args.tab_id = tab_id;
    const result = await executeBrowserCommand('browser_iframe', args);
    return textResult(result);
});
// ── browser_clear_session ────────────────────────────────────────────────
server.registerTool('browser_clear_session', {
    title: 'Browser Clear Session',
    description: 'Clear browsing data (cookies, cache, localStorage). Useful for resetting login state, clearing cached data, or testing fresh page loads. Clears all data by default. Requires CodeFire to be running.',
    inputSchema: zod_1.z.object({
        types: zod_1.z
            .array(zod_1.z.enum(['cookies', 'cache', 'localStorage', 'all']))
            .optional()
            .describe('Data types to clear. Defaults to all.'),
        tab_id: zod_1.z.string().optional().describe('Tab ID (defaults to active tab)'),
    }),
    annotations: {
        destructiveHint: true,
        readOnlyHint: false,
    },
}, async ({ types, tab_id }) => {
    const args = {};
    if (types)
        args.types = types;
    if (tab_id)
        args.tab_id = tab_id;
    const result = await executeBrowserCommand('browser_clear_session', args, 10.0);
    return textResult(result);
});
// ── browser_get_cookies ──────────────────────────────────────────────────
server.registerTool('browser_get_cookies', {
    title: 'Browser Get Cookies',
    description: 'Get cookies for the current page, including httpOnly cookies not visible to JavaScript. Useful for debugging authentication, session management, and tracking. Requires CodeFire browser.',
    inputSchema: zod_1.z.object({
        domain: zod_1.z
            .string()
            .optional()
            .describe("Filter cookies by domain substring (e.g. 'example.com')"),
        tab_id: zod_1.z.string().optional().describe('Tab ID (defaults to active tab)'),
    }),
}, async ({ domain, tab_id }) => {
    const args = {};
    if (domain)
        args.domain = domain;
    if (tab_id)
        args.tab_id = tab_id;
    const result = await executeBrowserCommand('browser_get_cookies', args);
    return textResult(result);
});
// ── browser_get_storage ──────────────────────────────────────────────────
server.registerTool('browser_get_storage', {
    title: 'Browser Get Storage',
    description: 'Read localStorage or sessionStorage contents. Returns item count, key-value pairs, and total size in bytes. Requires CodeFire browser.',
    inputSchema: zod_1.z.object({
        type: zod_1.z
            .enum(['localStorage', 'sessionStorage'])
            .describe('Which storage to read'),
        prefix: zod_1.z
            .string()
            .optional()
            .describe('Only return keys starting with this prefix'),
        tab_id: zod_1.z.string().optional().describe('Tab ID (defaults to active tab)'),
    }),
}, async ({ type: storageType, prefix, tab_id }) => {
    const args = { type: storageType ?? 'localStorage' };
    if (prefix)
        args.prefix = prefix;
    if (tab_id)
        args.tab_id = tab_id;
    const result = await executeBrowserCommand('browser_get_storage', args);
    return textResult(result);
});
// ── browser_set_cookie ───────────────────────────────────────────────────
server.registerTool('browser_set_cookie', {
    title: 'Browser Set Cookie',
    description: 'Set a cookie on the current page. Useful for testing auth flows, spoofing sessions, or setting feature flags. Requires CodeFire browser.',
    inputSchema: zod_1.z.object({
        name: zod_1.z.string().describe('Cookie name'),
        value: zod_1.z.string().describe('Cookie value'),
        domain: zod_1.z
            .string()
            .optional()
            .describe('Cookie domain (defaults to current page domain)'),
        path: zod_1.z.string().optional().describe("Cookie path (defaults to '/')"),
        max_age: zod_1.z.number().optional().describe('Max age in seconds'),
        secure: zod_1.z.boolean().optional().describe('Secure flag'),
        same_site: zod_1.z
            .enum(['Strict', 'Lax', 'None'])
            .optional()
            .describe('SameSite attribute'),
        tab_id: zod_1.z.string().optional().describe('Tab ID (defaults to active tab)'),
    }),
    annotations: {
        destructiveHint: true,
        readOnlyHint: false,
    },
}, async ({ name, value, domain, path: cookiePath, max_age, secure, same_site, tab_id }) => {
    const args = { name, value };
    if (domain)
        args.domain = domain;
    if (cookiePath)
        args.path = cookiePath;
    if (max_age !== undefined)
        args.max_age = max_age;
    if (secure !== undefined)
        args.secure = secure;
    if (same_site)
        args.same_site = same_site;
    if (tab_id)
        args.tab_id = tab_id;
    const result = await executeBrowserCommand('browser_set_cookie', args);
    return textResult(result);
});
// ── Git Operations ───────────────────────────────────────────────────────────
const GIT_TIMEOUT_MS = 30000;
async function runGit(projectPath, args) {
    const { stdout } = await execFileAsync('git', ['-C', projectPath, ...args], {
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
}
function resolveProjectPath(projectPath) {
    if (projectPath)
        return projectPath;
    const project = detectProject(db);
    if (project)
        return project.path;
    return process.cwd();
}
server.registerTool('git_status', {
    title: 'Git Status',
    description: 'Get git status (branch, changed files, clean state) for a project',
    inputSchema: zod_1.z.object({
        projectPath: zod_1.z.string().optional().describe('Project path. Auto-detected from cwd if omitted.'),
    }),
}, async ({ projectPath }) => {
    const dir = resolveProjectPath(projectPath);
    const output = await runGit(dir, ['status', '--porcelain=v1', '-b']);
    const lines = output.split('\n').filter((l) => l.length > 0);
    let branch = '';
    const files = [];
    for (const line of lines) {
        if (line.startsWith('## ')) {
            const branchPart = line.slice(3);
            if (branchPart.startsWith('No commits yet on ')) {
                branch = branchPart.replace('No commits yet on ', '');
            }
            else {
                const dotIdx = branchPart.indexOf('...');
                branch = dotIdx >= 0 ? branchPart.slice(0, dotIdx) : branchPart;
            }
        }
        else {
            const statusCode = line.slice(0, 2).trim();
            const filePath = line.slice(3);
            if (statusCode && filePath) {
                files.push({ status: statusCode, path: filePath });
            }
        }
    }
    return { content: [{ type: 'text', text: JSON.stringify({ branch, files, isClean: files.length === 0 }, null, 2) }] };
});
server.registerTool('git_diff', {
    title: 'Git Diff',
    description: 'Get git diff output (unstaged by default, or staged with option)',
    inputSchema: zod_1.z.object({
        projectPath: zod_1.z.string().optional().describe('Project path. Auto-detected from cwd if omitted.'),
        staged: zod_1.z.boolean().optional().describe('Show staged changes instead of unstaged'),
        file: zod_1.z.string().optional().describe('Limit diff to a specific file'),
    }),
}, async ({ projectPath, staged, file }) => {
    const dir = resolveProjectPath(projectPath);
    const args = ['diff'];
    if (staged)
        args.push('--staged');
    if (file)
        args.push('--', file);
    const output = await runGit(dir, args);
    return { content: [{ type: 'text', text: output || '(no diff)' }] };
});
server.registerTool('git_log', {
    title: 'Git Log',
    description: 'Get recent commit log entries',
    inputSchema: zod_1.z.object({
        projectPath: zod_1.z.string().optional().describe('Project path. Auto-detected from cwd if omitted.'),
        limit: zod_1.z.number().optional().describe('Max number of commits (default 20)'),
        file: zod_1.z.string().optional().describe('Limit log to a specific file'),
    }),
}, async ({ projectPath, limit, file }) => {
    const dir = resolveProjectPath(projectPath);
    const sep = '---END---';
    const format = `%H%n%an%n%ae%n%at%n%s%n%b${sep}`;
    const args = ['log', `--pretty=format:${format}`, '-n', String(limit ?? 20)];
    if (file)
        args.push('--', file);
    const output = await runGit(dir, args);
    if (!output.trim()) {
        return { content: [{ type: 'text', text: '[]' }] };
    }
    const entries = [];
    for (const raw of output.split(sep).filter((e) => e.trim())) {
        const lines = raw.split('\n');
        const start = lines.findIndex((l) => l.length > 0);
        if (start < 0)
            continue;
        const m = lines.slice(start);
        if (m.length < 5)
            continue;
        entries.push({
            hash: m[0],
            author: m[1],
            email: m[2],
            date: new Date(parseInt(m[3], 10) * 1000).toISOString(),
            subject: m[4],
            body: m.slice(5).join('\n').trim(),
        });
    }
    return { content: [{ type: 'text', text: JSON.stringify(entries, null, 2) }] };
});
server.registerTool('git_stage', {
    title: 'Git Stage',
    description: 'Stage files for commit (git add)',
    inputSchema: zod_1.z.object({
        projectPath: zod_1.z.string().optional().describe('Project path. Auto-detected from cwd if omitted.'),
        files: zod_1.z.array(zod_1.z.string()).describe('File paths to stage'),
    }),
}, async ({ projectPath, files }) => {
    const dir = resolveProjectPath(projectPath);
    if (files.length === 0)
        return { content: [{ type: 'text', text: 'No files specified.' }] };
    await runGit(dir, ['add', ...files]);
    return { content: [{ type: 'text', text: `Staged ${files.length} file(s): ${files.join(', ')}` }] };
});
server.registerTool('git_unstage', {
    title: 'Git Unstage',
    description: 'Unstage files (git reset HEAD)',
    inputSchema: zod_1.z.object({
        projectPath: zod_1.z.string().optional().describe('Project path. Auto-detected from cwd if omitted.'),
        files: zod_1.z.array(zod_1.z.string()).describe('File paths to unstage'),
    }),
}, async ({ projectPath, files }) => {
    const dir = resolveProjectPath(projectPath);
    if (files.length === 0)
        return { content: [{ type: 'text', text: 'No files specified.' }] };
    await runGit(dir, ['reset', 'HEAD', '--', ...files]);
    return { content: [{ type: 'text', text: `Unstaged ${files.length} file(s): ${files.join(', ')}` }] };
});
server.registerTool('git_commit', {
    title: 'Git Commit',
    description: 'Create a git commit with the given message',
    inputSchema: zod_1.z.object({
        projectPath: zod_1.z.string().optional().describe('Project path. Auto-detected from cwd if omitted.'),
        message: zod_1.z.string().describe('Commit message'),
    }),
}, async ({ projectPath, message }) => {
    const dir = resolveProjectPath(projectPath);
    if (!message.trim())
        return { content: [{ type: 'text', text: 'Commit message cannot be empty.' }] };
    const output = await runGit(dir, ['commit', '-m', message]);
    const match = output.match(/\[.+\s+([a-f0-9]+)\]/);
    const hash = match ? match[1] : '(unknown)';
    return { content: [{ type: 'text', text: `Committed: ${hash}\n${output}` }] };
});
// ── Delete Note ──────────────────────────────────────────────────────────────
server.registerTool('delete_note', {
    title: 'Delete Note',
    description: 'Delete a note by ID',
    inputSchema: zod_1.z.object({
        noteId: zod_1.z.number().describe('Note ID to delete'),
    }),
}, async ({ noteId }) => {
    const existing = db.prepare('SELECT id, title FROM notes WHERE id = ?').get(noteId);
    if (!existing) {
        return { content: [{ type: 'text', text: `Note ${noteId} not found.` }] };
    }
    db.prepare('DELETE FROM notes WHERE id = ?').run(noteId);
    return { content: [{ type: 'text', text: `Deleted note ${noteId}: "${existing.title}"` }] };
});
// ── Network Inspection ───────────────────────────────────────────────────────
server.registerTool('browser_network_requests', {
    title: 'Browser Network Requests',
    description: 'Get recent network requests captured by the browser. Returns URLs, methods, status codes, and timing.',
    inputSchema: zod_1.z.object({
        tab_id: zod_1.z.string().optional().describe('Tab ID (defaults to active tab)'),
        filter: zod_1.z.string().optional().describe('Filter requests by URL substring'),
        limit: zod_1.z.number().optional().describe('Max requests to return (default 50)'),
    }),
}, async ({ tab_id, filter, limit }) => {
    const args = {};
    if (tab_id)
        args.tab_id = tab_id;
    if (filter)
        args.filter = filter;
    if (limit)
        args.limit = limit;
    const result = await executeBrowserCommand('browser_network_requests', args);
    return textResult(result);
});
server.registerTool('browser_network_clear', {
    title: 'Browser Clear Network Log',
    description: 'Clear the captured network request log',
    inputSchema: zod_1.z.object({
        tab_id: zod_1.z.string().optional().describe('Tab ID (defaults to active tab)'),
    }),
}, async ({ tab_id }) => {
    const args = {};
    if (tab_id)
        args.tab_id = tab_id;
    const result = await executeBrowserCommand('browser_network_clear', args);
    return textResult(result);
});
server.registerTool('browser_network_inspect', {
    title: 'Browser Inspect Network Request',
    description: 'Get full details (headers, body, response) of a specific network request by index',
    inputSchema: zod_1.z.object({
        index: zod_1.z.number().describe('Request index from the network log'),
        tab_id: zod_1.z.string().optional().describe('Tab ID (defaults to active tab)'),
    }),
}, async ({ index, tab_id }) => {
    const args = { index };
    if (tab_id)
        args.tab_id = tab_id;
    const result = await executeBrowserCommand('browser_network_inspect', args);
    return textResult(result);
});
// ── Environment Detection ────────────────────────────────────────────────────
server.registerTool('detect_ai_agents', {
    title: 'Detect AI Agents',
    description: 'Detect installed AI coding agents (Claude Code, Gemini CLI, Codex CLI, OpenCode, etc.)',
    inputSchema: zod_1.z.object({}),
}, async () => {
    const agents = [
        { name: 'Claude Code', commands: ['claude'] },
        { name: 'Gemini CLI', commands: ['gemini'] },
        { name: 'Codex CLI', commands: ['codex'] },
        { name: 'OpenCode', commands: ['opencode'] },
        { name: 'Aider', commands: ['aider'] },
        { name: 'Cursor', commands: ['cursor'] },
    ];
    const results = [];
    for (const agent of agents) {
        let found = false;
        let version = null;
        for (const cmd of agent.commands) {
            try {
                const { stdout } = await execFileAsync(cmd, ['--version'], { timeout: 5000 });
                found = true;
                version = stdout.trim().split('\n')[0];
                break;
            }
            catch {
                // not found
            }
        }
        results.push({ name: agent.name, installed: found, version });
    }
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
});
server.registerTool('detect_dev_environment', {
    title: 'Detect Dev Environment',
    description: 'Detect development tools and runtimes (Node.js, Python, git, Docker, etc.)',
    inputSchema: zod_1.z.object({}),
}, async () => {
    const tools = [
        { name: 'Node.js', cmd: 'node', args: ['--version'] },
        { name: 'npm', cmd: 'npm', args: ['--version'] },
        { name: 'Python', cmd: 'python3', args: ['--version'] },
        { name: 'git', cmd: 'git', args: ['--version'] },
        { name: 'Docker', cmd: 'docker', args: ['--version'] },
        { name: 'bun', cmd: 'bun', args: ['--version'] },
        { name: 'pnpm', cmd: 'pnpm', args: ['--version'] },
        { name: 'yarn', cmd: 'yarn', args: ['--version'] },
        { name: 'cargo', cmd: 'cargo', args: ['--version'] },
        { name: 'go', cmd: 'go', args: ['version'] },
    ];
    const results = [];
    for (const tool of tools) {
        try {
            const { stdout } = await execFileAsync(tool.cmd, tool.args, { timeout: 5000 });
            results.push({ name: tool.name, installed: true, version: stdout.trim().split('\n')[0] });
        }
        catch {
            results.push({ name: tool.name, installed: false, version: null });
        }
    }
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
});
server.registerTool('detect_project_stack', {
    title: 'Detect Project Stack',
    description: 'Detect the technology stack of the current project by checking for config files',
    inputSchema: zod_1.z.object({
        projectPath: zod_1.z.string().optional().describe('Project path. Auto-detected from cwd if omitted.'),
    }),
}, async ({ projectPath }) => {
    const dir = resolveProjectPath(projectPath);
    const indicators = [
        { technology: 'Node.js', files: ['package.json'] },
        { technology: 'TypeScript', files: ['tsconfig.json'] },
        { technology: 'React', files: ['node_modules/react/package.json'] },
        { technology: 'Next.js', files: ['next.config.js', 'next.config.mjs', 'next.config.ts'] },
        { technology: 'Vite', files: ['vite.config.ts', 'vite.config.js'] },
        { technology: 'Python', files: ['requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile'] },
        { technology: 'Rust', files: ['Cargo.toml'] },
        { technology: 'Go', files: ['go.mod'] },
        { technology: 'Docker', files: ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml'] },
        { technology: 'Swift', files: ['Package.swift'] },
        { technology: 'Flutter', files: ['pubspec.yaml'] },
        { technology: 'Tailwind CSS', files: ['tailwind.config.js', 'tailwind.config.ts'] },
        { technology: '.NET', files: ['*.csproj', '*.sln'] },
        { technology: 'Java', files: ['pom.xml', 'build.gradle'] },
    ];
    const detected = [];
    for (const ind of indicators) {
        for (const file of ind.files) {
            const fullPath = path_1.default.join(dir, file);
            if (fs_1.default.existsSync(fullPath)) {
                detected.push({ technology: ind.technology, matchedFile: file });
                break;
            }
        }
    }
    return { content: [{ type: 'text', text: JSON.stringify({ projectPath: dir, stack: detected }, null, 2) }] };
});
// ── Image Tools ──────────────────────────────────────────────────────────────
server.registerTool('get_image', {
    title: 'Get Image',
    description: 'Get a generated image by ID, including metadata and file path',
    inputSchema: zod_1.z.object({
        imageId: zod_1.z.number().describe('Image ID'),
    }),
}, async ({ imageId }) => {
    const image = db.prepare('SELECT * FROM generatedImages WHERE id = ?').get(imageId);
    if (!image) {
        return { content: [{ type: 'text', text: `Image ${imageId} not found.` }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(image, null, 2) }] };
});
server.registerTool('generate_image', {
    title: 'Generate Image',
    description: 'Generate an image using AI. Auto-reads OpenRouter API key from CodeFire settings, or pass one explicitly.',
    inputSchema: zod_1.z.object({
        projectId: zod_1.z.string().describe('Project ID to associate the image with'),
        prompt: zod_1.z.string().describe('Image generation prompt'),
        apiKey: zod_1.z.string().optional().describe('OpenRouter API key (optional — auto-reads from CodeFire settings if omitted)'),
        aspectRatio: zod_1.z.string().optional().describe("Aspect ratio (default '1:1'). Options: '1:1', '16:9', '9:16', '4:3', '3:4'"),
        imageSize: zod_1.z.string().optional().describe("Image size (default '1K'). Options: '1K', '2K'"),
    }),
}, async ({ projectId, prompt, apiKey, aspectRatio, imageSize }) => {
    const resolvedKey = apiKey || getOpenRouterKey();
    if (!resolvedKey) {
        return { content: [{ type: 'text', text: 'Error: OpenRouter API key not found. Set it in CodeFire Settings > Engine, or pass apiKey explicitly.' }] };
    }
    const model = 'google/gemini-3.1-flash-image-preview';
    const endpoint = 'https://openrouter.ai/api/v1/chat/completions';
    const body = JSON.stringify({
        model,
        modalities: ['image', 'text'],
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        image_config: {
            aspect_ratio: aspectRatio ?? '1:1',
            image_size: imageSize ?? '1K',
        },
    });
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${resolvedKey}`,
            'Content-Type': 'application/json',
            'X-Title': 'CodeFire',
        },
        body,
    });
    if (!response.ok) {
        const text = await response.text();
        return { content: [{ type: 'text', text: `HTTP ${response.status}: ${text.substring(0, 300)}` }] };
    }
    const json = await response.json();
    if (json.error?.message) {
        return { content: [{ type: 'text', text: `API Error: ${json.error.message}` }] };
    }
    const choices = json.choices;
    const message = choices?.[0]?.message;
    if (!message) {
        return { content: [{ type: 'text', text: 'Unexpected response format — no message.' }] };
    }
    // Extract text
    let responseText = null;
    if (typeof message.content === 'string') {
        responseText = message.content;
    }
    else if (Array.isArray(message.content)) {
        for (const part of message.content) {
            if (part.type === 'text' && part.text) {
                responseText = part.text;
                break;
            }
        }
    }
    // Extract image
    let imageBase64 = null;
    if (Array.isArray(message.images)) {
        for (const img of message.images) {
            const url = img.image_url?.url;
            if (url) {
                const commaIdx = url.indexOf(',');
                if (commaIdx !== -1) {
                    imageBase64 = url.substring(commaIdx + 1);
                    break;
                }
            }
        }
    }
    if (!imageBase64 && Array.isArray(message.content)) {
        for (const part of message.content) {
            if (part.type === 'image_url') {
                const url = part.image_url?.url;
                if (url) {
                    const commaIdx = url.indexOf(',');
                    if (commaIdx !== -1) {
                        imageBase64 = url.substring(commaIdx + 1);
                        break;
                    }
                }
            }
        }
    }
    if (!imageBase64) {
        return { content: [{ type: 'text', text: responseText ?? 'No image returned by the model.' }] };
    }
    // Save image to disk
    const dbDir = path_1.default.dirname(getDatabasePath());
    const imagesDir = path_1.default.join(dbDir, 'generated-images');
    fs_1.default.mkdirSync(imagesDir, { recursive: true });
    const fileName = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}.png`;
    const filePath = path_1.default.join(imagesDir, fileName);
    fs_1.default.writeFileSync(filePath, Buffer.from(imageBase64, 'base64'));
    // Insert into database
    const now = new Date().toISOString();
    const result = db.prepare('INSERT INTO generatedImages (projectId, prompt, responseText, filePath, model, aspectRatio, imageSize, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(projectId, prompt, responseText, filePath, model, aspectRatio ?? '1:1', imageSize ?? '1K', now);
    const image = db.prepare('SELECT * FROM generatedImages WHERE id = ?').get(result.lastInsertRowid);
    return { content: [{ type: 'text', text: JSON.stringify(image, null, 2) }] };
});
server.registerTool('edit_image', {
    title: 'Edit Image',
    description: 'Edit an existing image with an AI prompt (sends original + edit instruction). Auto-reads OpenRouter API key from settings.',
    inputSchema: zod_1.z.object({
        imageId: zod_1.z.number().describe('ID of the image to edit'),
        prompt: zod_1.z.string().describe('Edit instruction (e.g. "make the background blue")'),
        apiKey: zod_1.z.string().optional().describe('OpenRouter API key (optional — auto-reads from CodeFire settings if omitted)'),
        aspectRatio: zod_1.z.string().optional().describe("Aspect ratio (default: same as original)"),
        imageSize: zod_1.z.string().optional().describe("Image size (default: same as original)"),
    }),
}, async ({ imageId, prompt, apiKey, aspectRatio, imageSize }) => {
    const resolvedKey = apiKey || getOpenRouterKey();
    if (!resolvedKey) {
        return { content: [{ type: 'text', text: 'Error: OpenRouter API key not found. Set it in CodeFire Settings > Engine, or pass apiKey explicitly.' }] };
    }
    const original = db.prepare('SELECT * FROM generatedImages WHERE id = ?').get(imageId);
    if (!original) {
        return { content: [{ type: 'text', text: `Image ${imageId} not found.` }] };
    }
    const originalPath = original.filePath;
    if (!fs_1.default.existsSync(originalPath)) {
        return { content: [{ type: 'text', text: `Original image file not found at ${originalPath}` }] };
    }
    const imageData = fs_1.default.readFileSync(originalPath).toString('base64');
    const model = 'google/gemini-3.1-flash-image-preview';
    const endpoint = 'https://openrouter.ai/api/v1/chat/completions';
    const body = JSON.stringify({
        model,
        modalities: ['image', 'text'],
        messages: [{
                role: 'user',
                content: [
                    { type: 'image_url', image_url: { url: `data:image/png;base64,${imageData}` } },
                    { type: 'text', text: prompt },
                ],
            }],
        image_config: {
            aspect_ratio: aspectRatio ?? original.aspectRatio ?? '1:1',
            image_size: imageSize ?? original.imageSize ?? '1K',
        },
    });
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${resolvedKey}`,
            'Content-Type': 'application/json',
            'X-Title': 'CodeFire',
        },
        body,
    });
    if (!response.ok) {
        const text = await response.text();
        return { content: [{ type: 'text', text: `HTTP ${response.status}: ${text.substring(0, 300)}` }] };
    }
    const json = await response.json();
    const choices = json.choices;
    const message = choices?.[0]?.message;
    if (!message) {
        return { content: [{ type: 'text', text: 'Unexpected response format.' }] };
    }
    // Extract response text
    let responseText = null;
    if (typeof message.content === 'string') {
        responseText = message.content;
    }
    else if (Array.isArray(message.content)) {
        for (const part of message.content) {
            if (part.type === 'text' && part.text) {
                responseText = part.text;
                break;
            }
        }
    }
    // Extract image
    let newImageBase64 = null;
    if (Array.isArray(message.images)) {
        for (const img of message.images) {
            const url = img.image_url?.url;
            if (url) {
                const commaIdx = url.indexOf(',');
                if (commaIdx !== -1) {
                    newImageBase64 = url.substring(commaIdx + 1);
                    break;
                }
            }
        }
    }
    if (!newImageBase64 && Array.isArray(message.content)) {
        for (const part of message.content) {
            if (part.type === 'image_url') {
                const url = part.image_url?.url;
                if (url) {
                    const commaIdx = url.indexOf(',');
                    if (commaIdx !== -1) {
                        newImageBase64 = url.substring(commaIdx + 1);
                        break;
                    }
                }
            }
        }
    }
    if (!newImageBase64) {
        return { content: [{ type: 'text', text: responseText ?? 'No edited image returned.' }] };
    }
    // Save edited image
    const dbDir = path_1.default.dirname(getDatabasePath());
    const imagesDir = path_1.default.join(dbDir, 'generated-images');
    fs_1.default.mkdirSync(imagesDir, { recursive: true });
    const fileName = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}.png`;
    const filePath = path_1.default.join(imagesDir, fileName);
    fs_1.default.writeFileSync(filePath, Buffer.from(newImageBase64, 'base64'));
    const now = new Date().toISOString();
    const ar = aspectRatio ?? original.aspectRatio ?? '1:1';
    const is = imageSize ?? original.imageSize ?? '1K';
    const result = db.prepare('INSERT INTO generatedImages (projectId, prompt, responseText, filePath, model, aspectRatio, imageSize, parentImageId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(original.projectId, prompt, responseText, filePath, model, ar, is, imageId, now);
    const image = db.prepare('SELECT * FROM generatedImages WHERE id = ?').get(result.lastInsertRowid);
    return { content: [{ type: 'text', text: JSON.stringify(image, null, 2) }] };
});
const SYNONYM_MAP = {
    auth: ['authentication', 'login', 'signup', 'password', 'token', 'session', 'oauth', 'jwt', 'credential'],
    database: ['db', 'sql', 'query', 'migration', 'schema', 'table', 'model', 'orm', 'repository', 'dao'],
    api: ['endpoint', 'route', 'handler', 'controller', 'request', 'response', 'rest', 'graphql', 'fetch'],
    ui: ['component', 'view', 'render', 'layout', 'widget', 'screen', 'page', 'template', 'style'],
    error: ['exception', 'catch', 'throw', 'failure', 'crash', 'bug', 'issue', 'debug'],
    test: ['spec', 'assert', 'mock', 'fixture', 'expect', 'describe', 'it', 'vitest', 'jest'],
    network: ['http', 'https', 'socket', 'websocket', 'tcp', 'fetch', 'axios', 'request'],
    storage: ['cache', 'store', 'persist', 'save', 'load', 'write', 'read', 'file', 'disk'],
    config: ['settings', 'options', 'preferences', 'environment', 'env', 'dotenv', 'configuration'],
    nav: ['navigation', 'router', 'route', 'redirect', 'link', 'page', 'url', 'path'],
    state: ['store', 'redux', 'context', 'provider', 'reducer', 'action', 'dispatch', 'atom', 'signal'],
    style: ['css', 'tailwind', 'theme', 'color', 'font', 'layout', 'responsive', 'dark'],
    async: ['promise', 'await', 'callback', 'observable', 'stream', 'event', 'listener', 'subscribe'],
    parse: ['parser', 'tokenize', 'lexer', 'ast', 'transform', 'serialize', 'deserialize', 'decode', 'encode'],
    validate: ['validator', 'schema', 'zod', 'yup', 'sanitize', 'check', 'verify', 'constraint'],
    security: ['encrypt', 'decrypt', 'hash', 'salt', 'csrf', 'xss', 'cors', 'sanitize', 'auth'],
    deploy: ['build', 'ci', 'cd', 'pipeline', 'docker', 'container', 'release', 'publish', 'bundle'],
    git: ['commit', 'branch', 'merge', 'rebase', 'pull', 'push', 'diff', 'status', 'remote'],
};
const FILLER_WORDS = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
    'that', 'this', 'these', 'those', 'it', 'its', 'and', 'or', 'but',
    'not', 'no', 'nor', 'so', 'yet', 'both', 'each', 'every', 'all',
    'how', 'what', 'where', 'when', 'which', 'who', 'whom', 'why',
    'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'they',
    'them', 'their', 'about', 'up', 'out', 'if', 'then', 'than',
]);
function classifyQuery(query) {
    // Symbol queries: camelCase, snake_case, PascalCase, dot notation, contains ::, #, ->
    if (/[A-Z][a-z]+[A-Z]/.test(query) || /_[a-z]/.test(query) || /[.#:]{2}|->/.test(query)) {
        return 'symbol';
    }
    // Concept queries: natural language (4+ words)
    const words = query.split(/\s+/).filter(Boolean);
    if (words.length >= 4)
        return 'concept';
    // Pattern: balanced
    return 'pattern';
}
function preprocessQuery(query) {
    const queryType = classifyQuery(query);
    // Tokenize: strip filler words for 4+ word queries
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const tokens = words.length >= 4 ? words.filter((w) => !FILLER_WORDS.has(w)) : words;
    // Expand with synonyms
    const expanded = new Set(tokens);
    for (const token of tokens) {
        for (const [, synonyms] of Object.entries(SYNONYM_MAP)) {
            if (synonyms.includes(token)) {
                for (const syn of synonyms)
                    expanded.add(syn);
                break;
            }
        }
    }
    // Build FTS query: OR the original + expanded terms
    const ftsTerms = Array.from(expanded).map((t) => `"${t}"`).join(' OR ');
    // Select weights based on query type
    const weights = {
        symbol: { kw: 0.6, sem: 0.4 },
        concept: { kw: 0.15, sem: 0.85 },
        pattern: { kw: 0.3, sem: 0.7 },
    };
    return {
        ftsQuery: ftsTerms || query,
        queryType,
        keywordWeight: weights[queryType].kw,
        semanticWeight: weights[queryType].sem,
    };
}
// ── Embedding helpers ───────────────────────────────────────────────────────
const embeddingCache = new Map();
const EMBEDDING_CACHE_MAX = 50;
function getAppConfigDir() {
    switch (process.platform) {
        case 'darwin':
            return path_1.default.join(os_1.default.homedir(), 'Library', 'Application Support', 'CodeFire');
        case 'win32':
            return path_1.default.join(process.env.APPDATA || path_1.default.join(os_1.default.homedir(), 'AppData', 'Roaming'), 'CodeFire');
        default:
            return path_1.default.join(os_1.default.homedir(), '.config', 'CodeFire');
    }
}
function readConfigFromDisk() {
    try {
        const configPath = path_1.default.join(getAppConfigDir(), 'codefire-settings.json');
        if (fs_1.default.existsSync(configPath)) {
            return JSON.parse(fs_1.default.readFileSync(configPath, 'utf-8'));
        }
    }
    catch { }
    return {};
}
function getOpenRouterKey() {
    // Primary: read from mcp-secrets.json (written by Electron main process with decrypted keys)
    try {
        const secretsPath = path_1.default.join(getAppConfigDir(), 'mcp-secrets.json');
        if (fs_1.default.existsSync(secretsPath)) {
            const secrets = JSON.parse(fs_1.default.readFileSync(secretsPath, 'utf-8'));
            if (secrets.openRouterKey)
                return secrets.openRouterKey;
        }
    }
    catch { /* fall through */ }
    // Fallback: read from settings directly (works for plaintext keys only)
    const config = readConfigFromDisk();
    const key = config.openRouterKey || '';
    if (!key)
        return null;
    if (key.startsWith('enc:'))
        return null;
    return key;
}
function getEmbeddingModel() {
    const config = readConfigFromDisk();
    return config.embeddingModel || 'openai/text-embedding-3-small';
}
async function embedQuery(text, apiKey, model) {
    const cacheKey = text.toLowerCase().trim().replace(/\s+/g, ' ');
    if (embeddingCache.has(cacheKey))
        return embeddingCache.get(cacheKey);
    try {
        const response = await fetch('https://openrouter.ai/api/v1/embeddings', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'X-Title': 'CodeFire',
            },
            body: JSON.stringify({ model, input: text }),
        });
        if (!response.ok)
            return null;
        const json = await response.json();
        const embedding = json.data?.[0]?.embedding;
        if (!embedding)
            return null;
        // LRU cache
        if (embeddingCache.size >= EMBEDDING_CACHE_MAX) {
            const keys = Array.from(embeddingCache.keys());
            if (keys.length > 0)
                embeddingCache.delete(keys[0]);
        }
        embeddingCache.set(cacheKey, embedding);
        return embedding;
    }
    catch {
        return null;
    }
}
function cosineSimilarity(a, b) {
    if (a.length !== b.length)
        return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}
// ── Context Search Tool ─────────────────────────────────────────────────────
server.registerTool('context_search', {
    title: 'Context Search',
    description: 'Semantic code search across the current project. Finds functions, classes, documentation, and git history matching natural language queries. Uses hybrid vector similarity + keyword search when embeddings are available.',
    inputSchema: zod_1.z.object({
        query: zod_1.z.string().describe('Search query (natural language or code symbol)'),
        projectId: zod_1.z.string().optional().describe('Limit to a specific project'),
        scope: zod_1.z.enum(['all', 'notes', 'tasks', 'sessions', 'code']).optional().describe("Search scope (default 'all')"),
        limit: zod_1.z.number().optional().describe('Max results per category (default 10)'),
        types: zod_1.z.array(zod_1.z.enum(['function', 'class', 'block', 'doc', 'commit'])).optional().describe('Filter code results by chunk type'),
    }),
}, async ({ query, projectId, scope, limit, types }) => {
    const maxResults = limit ?? 10;
    const searchScope = scope ?? 'all';
    const { ftsQuery, queryType, keywordWeight, semanticWeight } = preprocessQuery(query);
    const results = {};
    const meta = { queryType };
    // Notes (FTS5)
    if (searchScope === 'all' || searchScope === 'notes') {
        try {
            const noteRows = projectId
                ? db.prepare(`SELECT notes.*, bm25(notesFts) AS score FROM notes JOIN notesFts ON notes.id = notesFts.rowid
               WHERE notesFts MATCH ? AND notes.projectId = ? ORDER BY score LIMIT ?`).all(ftsQuery, projectId, maxResults)
                : db.prepare(`SELECT notes.*, bm25(notesFts) AS score FROM notes JOIN notesFts ON notes.id = notesFts.rowid
               WHERE notesFts MATCH ? ORDER BY score LIMIT ?`).all(ftsQuery, maxResults);
            results.notes = noteRows;
        }
        catch {
            results.notes = [];
        }
    }
    // Tasks (FTS5 via taskItemsFts)
    if (searchScope === 'all' || searchScope === 'tasks') {
        try {
            const taskRows = projectId
                ? db.prepare(`SELECT taskItems.*, bm25(taskItemsFts) AS score FROM taskItems JOIN taskItemsFts ON taskItems.id = taskItemsFts.rowid
               WHERE taskItemsFts MATCH ? AND taskItems.projectId = ? ORDER BY score LIMIT ?`).all(ftsQuery, projectId, maxResults)
                : db.prepare(`SELECT taskItems.*, bm25(taskItemsFts) AS score FROM taskItems JOIN taskItemsFts ON taskItems.id = taskItemsFts.rowid
               WHERE taskItemsFts MATCH ? ORDER BY score LIMIT ?`).all(ftsQuery, maxResults);
            results.tasks = taskRows;
        }
        catch {
            // Fallback to LIKE if FTS table doesn't exist
            try {
                const taskRows = projectId
                    ? db.prepare(`SELECT * FROM taskItems WHERE projectId = ? AND (title LIKE '%' || ? || '%' OR description LIKE '%' || ? || '%') ORDER BY updatedAt DESC LIMIT ?`).all(projectId, query, query, maxResults)
                    : db.prepare(`SELECT * FROM taskItems WHERE title LIKE '%' || ? || '%' OR description LIKE '%' || ? || '%' ORDER BY updatedAt DESC LIMIT ?`).all(query, query, maxResults);
                results.tasks = taskRows;
            }
            catch {
                results.tasks = [];
            }
        }
    }
    // Sessions (FTS5 via sessionsFts)
    if (searchScope === 'all' || searchScope === 'sessions') {
        try {
            const sessionRows = projectId
                ? db.prepare(`SELECT sessions.id, sessions.projectId, sessions.agent, sessions.model, sessions.startedAt,
                      sessions.endedAt, sessions.inputTokens, sessions.outputTokens, sessions.totalCost,
                      sessions.summary, bm25(sessionsFts) AS score
               FROM sessions JOIN sessionsFts ON sessions.id = sessionsFts.rowid
               WHERE sessionsFts MATCH ? AND sessions.projectId = ?
               ORDER BY score LIMIT ?`).all(ftsQuery, projectId, maxResults)
                : db.prepare(`SELECT sessions.id, sessions.projectId, sessions.agent, sessions.model, sessions.startedAt,
                      sessions.endedAt, sessions.inputTokens, sessions.outputTokens, sessions.totalCost,
                      sessions.summary, bm25(sessionsFts) AS score
               FROM sessions JOIN sessionsFts ON sessions.id = sessionsFts.rowid
               WHERE sessionsFts MATCH ? ORDER BY score LIMIT ?`).all(ftsQuery, maxResults);
            results.sessions = sessionRows;
        }
        catch {
            // Fallback to LIKE
            try {
                const sessionRows = projectId
                    ? db.prepare(`SELECT id, projectId, agent, model, startedAt, endedAt, inputTokens, outputTokens, totalCost
                 FROM sessions WHERE projectId = ? AND (rawContent LIKE '%' || ? || '%' OR summary LIKE '%' || ? || '%')
                 ORDER BY startedAt DESC LIMIT ?`).all(projectId, query, query, maxResults)
                    : db.prepare(`SELECT id, projectId, agent, model, startedAt, endedAt, inputTokens, outputTokens, totalCost
                 FROM sessions WHERE rawContent LIKE '%' || ? || '%' OR summary LIKE '%' || ? || '%'
                 ORDER BY startedAt DESC LIMIT ?`).all(query, query, maxResults);
                results.sessions = sessionRows;
            }
            catch {
                results.sessions = [];
            }
        }
    }
    // Code — Hybrid FTS5 + semantic search
    if (searchScope === 'all' || searchScope === 'code') {
        // FTS5 keyword search
        let ftsResults = [];
        try {
            const typeFilter = types?.length
                ? ` AND codeChunks.chunkType IN (${types.map((t) => `'${t}'`).join(',')})`
                : '';
            const projectFilter = projectId ? ' AND codeChunks.projectId = ?' : '';
            const params = [ftsQuery];
            if (projectId)
                params.push(projectId);
            params.push(50); // fetch more for merging with semantic
            ftsResults = db.prepare(`SELECT codeChunks.*, bm25(codeChunksFts) AS score FROM codeChunks
           JOIN codeChunksFts ON codeChunks.id = codeChunksFts.rowid
           WHERE codeChunksFts MATCH ?${projectFilter}${typeFilter}
           ORDER BY score LIMIT ?`).all(...params);
        }
        catch { /* FTS may not be populated */ }
        // Normalize FTS scores (BM25 returns negative values, lower = better)
        const maxFts = ftsResults.length > 0 ? Math.min(...ftsResults.map((r) => r.score)) : 0;
        const ftsScoreMap = new Map();
        for (const row of ftsResults) {
            const normalized = maxFts !== 0 ? row.score / maxFts : 0;
            ftsScoreMap.set(row.id, normalized);
        }
        // Semantic search (if API key available and embeddings exist)
        let semanticScoreMap = new Map();
        const apiKey = getOpenRouterKey();
        let embeddingStatus = 'none';
        if (apiKey) {
            // Check if any chunks have embeddings
            try {
                const hasEmbeddings = db.prepare(projectId
                    ? 'SELECT COUNT(*) as cnt FROM codeChunks WHERE embedding IS NOT NULL AND projectId = ?'
                    : 'SELECT COUNT(*) as cnt FROM codeChunks WHERE embedding IS NOT NULL').get(...(projectId ? [projectId] : []));
                if (hasEmbeddings.cnt > 0) {
                    embeddingStatus = 'available';
                    const queryEmbedding = await embedQuery(query, apiKey, getEmbeddingModel());
                    if (queryEmbedding) {
                        // Fetch chunks with embeddings
                        const typeFilter = types?.length
                            ? ` AND chunkType IN (${types.map((t) => `'${t}'`).join(',')})`
                            : '';
                        const projectFilter = projectId ? ' AND projectId = ?' : '';
                        const params = projectId ? [projectId] : [];
                        const chunks = db.prepare(`SELECT id, embedding FROM codeChunks WHERE embedding IS NOT NULL${projectFilter}${typeFilter}`).all(...params);
                        for (const chunk of chunks) {
                            try {
                                const embeddingArray = Array.from(new Float32Array(chunk.embedding.buffer, chunk.embedding.byteOffset, chunk.embedding.byteLength / 4));
                                const similarity = cosineSimilarity(queryEmbedding, embeddingArray);
                                if (similarity > 0.15) {
                                    semanticScoreMap.set(chunk.id, similarity);
                                }
                            }
                            catch { /* skip malformed embeddings */ }
                        }
                    }
                }
                else {
                    embeddingStatus = 'no_embeddings';
                    // Request indexing
                    try {
                        const project = projectId
                            ? db.prepare('SELECT id, path FROM projects WHERE id = ?').get(projectId)
                            : detectProject(db);
                        if (project) {
                            db.prepare("INSERT OR IGNORE INTO indexRequests (projectId, projectPath, status, createdAt) VALUES (?, ?, 'pending', ?)").run(project.id, project.path, new Date().toISOString());
                        }
                    }
                    catch { /* ignore */ }
                }
            }
            catch {
                embeddingStatus = 'error';
            }
        }
        meta.embeddingStatus = embeddingStatus;
        // Merge FTS + semantic scores
        const allChunkIds = new Set(Array.from(ftsScoreMap.keys()).concat(Array.from(semanticScoreMap.keys())));
        const mergedScores = [];
        for (const id of Array.from(allChunkIds)) {
            const kw = ftsScoreMap.get(id) ?? 0;
            const sem = semanticScoreMap.get(id) ?? 0;
            const combined = kw * keywordWeight + sem * semanticWeight;
            mergedScores.push({ id, combinedScore: combined, keywordScore: kw, semanticScore: sem });
        }
        mergedScores.sort((a, b) => b.combinedScore - a.combinedScore);
        const topIds = mergedScores.slice(0, maxResults);
        if (topIds.length > 0) {
            const placeholders = topIds.map(() => '?').join(',');
            const chunks = db.prepare(`SELECT id, projectId, fileId, chunkType, name, startLine, endLine, content FROM codeChunks WHERE id IN (${placeholders})`).all(...topIds.map((t) => t.id));
            const chunkMap = new Map(chunks.map((c) => [c.id, c]));
            results.code = topIds.map((scored) => {
                const chunk = chunkMap.get(scored.id);
                if (!chunk)
                    return null;
                // Resolve file path
                let filePath = null;
                if (chunk.fileId) {
                    const file = db.prepare('SELECT relativePath FROM indexedFiles WHERE id = ?').get(chunk.fileId);
                    if (file)
                        filePath = file.relativePath;
                }
                return {
                    ...chunk,
                    file: filePath,
                    score: Math.round(scored.combinedScore * 1000) / 1000,
                    score_breakdown: {
                        keyword: Math.round(scored.keywordScore * 1000) / 1000,
                        semantic: Math.round(scored.semanticScore * 1000) / 1000,
                    },
                };
            }).filter(Boolean);
        }
        else {
            results.code = [];
        }
        // Check index status
        if (projectId) {
            try {
                const indexState = db.prepare('SELECT status FROM indexState WHERE projectId = ?').get(projectId);
                meta.indexStatus = indexState?.status ?? 'unknown';
            }
            catch { }
        }
    }
    const totalHits = Object.values(results).reduce((sum, arr) => sum + arr.length, 0);
    return {
        content: [{
                type: 'text',
                text: JSON.stringify({ totalHits, ...meta, results }, null, 2),
            }],
    };
});
// ── Environment Detection ────────────────────────────────────────────────────
server.registerTool('get_system_info', {
    title: 'Get System Info',
    description: 'Returns system information: OS, platform, architecture, hostname, home directory, Node version.',
    inputSchema: zod_1.z.object({}),
}, async () => {
    const info = {
        platform: process.platform,
        arch: process.arch,
        hostname: os_1.default.hostname(),
        homeDir: os_1.default.homedir(),
        nodeVersion: process.version,
        osType: os_1.default.type(),
        osRelease: os_1.default.release(),
        cpus: os_1.default.cpus().length,
        totalMemoryMB: Math.round(os_1.default.totalmem() / 1024 / 1024),
        freeMemoryMB: Math.round(os_1.default.freemem() / 1024 / 1024),
    };
    return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] };
});
server.registerTool('detect_coding_agents', {
    title: 'Detect Coding Agents',
    description: 'Detects which AI coding agents/CLIs are installed on the system (Claude Code, Gemini CLI, Codex CLI, Aider, etc.).',
    inputSchema: zod_1.z.object({}),
}, async () => {
    const agents = [
        { name: 'Claude Code', commands: ['claude'] },
        { name: 'Gemini CLI', commands: ['gemini'] },
        { name: 'Codex CLI', commands: ['codex'] },
        { name: 'Aider', commands: ['aider'] },
        { name: 'OpenCode', commands: ['opencode'] },
        { name: 'GitHub Copilot CLI', commands: ['gh copilot'] },
    ];
    const results = [];
    const which = process.platform === 'win32' ? 'where' : 'which';
    for (const agent of agents) {
        let installed = false;
        let version;
        for (const cmd of agent.commands) {
            try {
                await execFileAsync(which, [cmd.split(' ')[0]], { timeout: 3000 });
                installed = true;
                try {
                    const { stdout } = await execFileAsync(cmd.split(' ')[0], ['--version'], { timeout: 5000 });
                    version = stdout.trim().split('\n')[0];
                }
                catch { }
                break;
            }
            catch { }
        }
        results.push({ name: agent.name, installed, version });
    }
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
});
server.registerTool('get_project_environment', {
    title: 'Get Project Environment',
    description: 'Detects the development environment for a project: package manager, language, framework, git status.',
    inputSchema: zod_1.z.object({
        projectPath: zod_1.z.string().describe('Absolute path to the project directory'),
    }),
}, async ({ projectPath }) => {
    const env = { path: projectPath };
    // Detect package manager & language
    const markers = [
        ['package.json', 'Node.js', 'npm'],
        ['yarn.lock', 'Node.js', 'yarn'],
        ['pnpm-lock.yaml', 'Node.js', 'pnpm'],
        ['bun.lockb', 'Node.js', 'bun'],
        ['Cargo.toml', 'Rust', 'cargo'],
        ['go.mod', 'Go', 'go'],
        ['pyproject.toml', 'Python', 'pip/poetry'],
        ['requirements.txt', 'Python', 'pip'],
        ['Gemfile', 'Ruby', 'bundler'],
        ['Package.swift', 'Swift', 'swift'],
        ['build.gradle', 'Java/Kotlin', 'gradle'],
        ['pom.xml', 'Java', 'maven'],
        ['pubspec.yaml', 'Dart/Flutter', 'pub'],
    ];
    const detected = [];
    for (const [file, lang, pm] of markers) {
        if (fs_1.default.existsSync(path_1.default.join(projectPath, file))) {
            detected.push({ file, language: lang, packageManager: pm });
        }
    }
    env.detected = detected;
    env.languages = [...new Set(detected.map((d) => d.language))];
    // Git info
    try {
        const { stdout: branch } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectPath, timeout: 3000 });
        env.gitBranch = branch.trim();
        const { stdout: remote } = await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd: projectPath, timeout: 3000 });
        env.gitRemote = remote.trim();
    }
    catch { }
    return { content: [{ type: 'text', text: JSON.stringify(env, null, 2) }] };
});
// ── Cloud Service Detection ──────────────────────────────────────────────────
server.registerTool('detect_services', {
    title: 'Detect Cloud Services',
    description: 'Detect cloud services and deployment platforms configured in the project (Firebase, Supabase, Vercel, Netlify, Docker, Railway, AWS Amplify).',
    inputSchema: zod_1.z.object({
        project_id: zod_1.z.string().optional().describe('Project ID. Auto-detected if omitted.'),
    }),
}, async ({ project_id }) => {
    let dir;
    if (project_id) {
        const row = db.prepare('SELECT path FROM projects WHERE id = ?').get(project_id);
        if (!row)
            return { content: [{ type: 'text', text: `Project ${project_id} not found.` }] };
        dir = row.path;
    }
    else {
        dir = resolveProjectPath();
    }
    const serviceChecks = [
        { service: 'Firebase', files: ['firebase.json', '.firebaserc'], dashboardUrl: 'https://console.firebase.google.com' },
        { service: 'Supabase', files: ['supabase/config.toml'], dashboardUrl: 'https://supabase.com/dashboard' },
        { service: 'Vercel', files: ['vercel.json', '.vercel/project.json'], dashboardUrl: 'https://vercel.com/dashboard' },
        { service: 'Netlify', files: ['netlify.toml'], dashboardUrl: 'https://app.netlify.com' },
        { service: 'Docker', files: ['docker-compose.yml', 'docker-compose.yaml', 'Dockerfile'], dashboardUrl: 'https://hub.docker.com' },
        { service: 'Railway', files: ['railway.toml', 'railway.json'], dashboardUrl: 'https://railway.app/dashboard' },
        { service: 'AWS Amplify', files: ['amplify/'], dashboardUrl: 'https://console.aws.amazon.com/amplify' },
    ];
    const services = [];
    for (const check of serviceChecks) {
        for (const file of check.files) {
            const fullPath = path_1.default.join(dir, file);
            if (fs_1.default.existsSync(fullPath)) {
                services.push({ service: check.service, config_file: file, dashboard_url: check.dashboardUrl });
                break;
            }
        }
    }
    return {
        content: [{ type: 'text', text: JSON.stringify({ services, count: services.length }, null, 2) }],
    };
});
server.registerTool('list_env_files', {
    title: 'List Environment Files',
    description: 'List environment files (.env, .env.local, .env.development, etc.) in the project with variable counts.',
    inputSchema: zod_1.z.object({
        project_id: zod_1.z.string().optional().describe('Project ID. Auto-detected if omitted.'),
    }),
}, async ({ project_id }) => {
    let dir;
    if (project_id) {
        const row = db.prepare('SELECT path FROM projects WHERE id = ?').get(project_id);
        if (!row)
            return { content: [{ type: 'text', text: `Project ${project_id} not found.` }] };
        dir = row.path;
    }
    else {
        dir = resolveProjectPath();
    }
    const envFileNames = [
        '.env', '.env.local', '.env.development', '.env.staging',
        '.env.production', '.env.example', '.env.template', '.env.sample',
        '.env.test', '.env.development.local', '.env.production.local',
    ];
    const files = [];
    for (const name of envFileNames) {
        const fullPath = path_1.default.join(dir, name);
        if (fs_1.default.existsSync(fullPath)) {
            try {
                const content = fs_1.default.readFileSync(fullPath, 'utf-8');
                const variableCount = content
                    .split('\n')
                    .filter((line) => {
                    const trimmed = line.trim();
                    return trimmed && !trimmed.startsWith('#') && trimmed.includes('=');
                }).length;
                files.push({ name, variable_count: variableCount });
            }
            catch {
                files.push({ name, variable_count: 0 });
            }
        }
    }
    return {
        content: [{ type: 'text', text: JSON.stringify({ files, count: files.length }, null, 2) }],
    };
});
server.registerTool('get_env_variables', {
    title: 'Get Environment Variables',
    description: 'Parse and return variables from a specific environment file. Values are always masked for security.',
    inputSchema: zod_1.z.object({
        file_name: zod_1.z.string().describe("Environment file name (e.g. '.env', '.env.local')"),
        project_id: zod_1.z.string().optional().describe('Project ID. Auto-detected if omitted.'),
    }),
}, async ({ file_name, project_id }) => {
    let dir;
    if (project_id) {
        const row = db.prepare('SELECT path FROM projects WHERE id = ?').get(project_id);
        if (!row)
            return { content: [{ type: 'text', text: `Project ${project_id} not found.` }] };
        dir = row.path;
    }
    else {
        dir = resolveProjectPath();
    }
    // Security: ensure file is within project directory
    const fullPath = path_1.default.resolve(dir, file_name);
    const realDir = fs_1.default.realpathSync(dir);
    if (!fullPath.startsWith(realDir)) {
        return { content: [{ type: 'text', text: 'Error: File path must be within project directory.' }] };
    }
    if (!fs_1.default.existsSync(fullPath)) {
        return { content: [{ type: 'text', text: `File ${file_name} not found.` }] };
    }
    const content = fs_1.default.readFileSync(fullPath, 'utf-8');
    const variables = [];
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#'))
            continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1)
            continue;
        const key = trimmed.substring(0, eqIdx).trim();
        let value = trimmed.substring(eqIdx + 1).trim();
        // Strip surrounding quotes
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        // Mask value
        const masked = value.length <= 4 ? '*'.repeat(value.length) : value.substring(0, 2) + '*'.repeat(20);
        variables.push({ key, value: masked });
    }
    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify({ file: file_name, variables, count: variables.length, values_masked: true }, null, 2),
            },
        ],
    };
});
// ─── Patterns ─────────────────────────────────────────────────────────────────
server.registerTool('get_patterns', {
    title: 'Get Code Patterns',
    description: 'List recorded code patterns, conventions, and architecture decisions for a project. ' +
        'Filter by category (e.g., architecture, naming, schema, workflow).',
    inputSchema: zod_1.z.object({
        project_id: zod_1.z.string().optional().describe('Project ID. Auto-detected if omitted.'),
        category: zod_1.z.string().optional().describe('Filter by category name'),
    }),
}, async ({ project_id, category }) => {
    const pid = project_id ?? detectProject(db)?.id;
    if (!pid) {
        return {
            content: [{ type: 'text', text: 'No project found. Provide project_id.' }],
        };
    }
    let query = 'SELECT * FROM patterns WHERE projectId = ?';
    const params = [pid];
    if (category) {
        query += ' AND category = ?';
        params.push(category);
    }
    query += ' ORDER BY category, createdAt DESC';
    const patterns = db.prepare(query).all(...params);
    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify({
                    patterns: patterns.map((p) => ({
                        id: p.id,
                        category: p.category,
                        title: p.title,
                        description: p.description,
                        autoDetected: !!p.autoDetected,
                        createdAt: p.createdAt,
                    })),
                    count: patterns.length,
                }, null, 2),
            },
        ],
    };
});
// ─── Project Profile ─────────────────────────────────────────────────────────
server.registerTool('get_project_profile', {
    title: 'Get Project Profile',
    description: 'Get a comprehensive project profile including file structure, architecture, ' +
        'database schema, and recent git activity. Generates fresh if no cache exists. ' +
        'Use this to understand a project before making changes.',
    inputSchema: zod_1.z.object({
        project_id: zod_1.z.string().optional().describe('Project ID. Auto-detected if omitted.'),
        refresh: zod_1.z.boolean().optional().describe('Force regeneration even if cached. Default false.'),
    }),
}, async ({ project_id, refresh }) => {
    const project = project_id
        ? db.prepare('SELECT * FROM projects WHERE id = ?').get(project_id)
        : detectProject(db);
    if (!project) {
        return {
            content: [{ type: 'text', text: 'No project found. Provide project_id or run from a project directory.' }],
        };
    }
    // Check cache first
    if (!refresh) {
        const cached = db
            .prepare('SELECT profileText FROM codebaseSnapshots WHERE projectId = ? ORDER BY capturedAt DESC LIMIT 1')
            .get(project.id);
        if (cached?.profileText) {
            return {
                content: [{ type: 'text', text: cached.profileText }],
            };
        }
    }
    // Generate fresh profile inline (lightweight — no external dependencies)
    try {
        const profileText = await generateProfile(project.id, project.path, project.name);
        return {
            content: [{ type: 'text', text: profileText }],
        };
    }
    catch (err) {
        return {
            content: [{ type: 'text', text: `Failed to generate profile: ${err instanceof Error ? err.message : String(err)}` }],
        };
    }
});
/** Inline profile generator for MCP server (avoids importing heavy modules) */
async function generateProfile(projectId, projectPath, projectName) {
    const SKIP = new Set(['node_modules', '.build', 'build', '.dart_tool', '__pycache__', '.next', 'dist', '.git', '.gradle', 'Pods', 'dist-electron', '.svelte-kit', '.nuxt', '.output', 'coverage', '.cache']);
    const SRC_EXT = new Set(['ts', 'tsx', 'js', 'jsx', 'swift', 'dart', 'py', 'rs', 'go', 'java', 'kt', 'rb', 'php', 'c', 'cpp', 'h', 'cs', 'vue', 'svelte']);
    // Detect project type
    const exists = (n) => { try {
        return fs_1.default.existsSync(path_1.default.join(projectPath, n));
    }
    catch {
        return false;
    } };
    let projectType = 'Unknown';
    if (exists('pubspec.yaml'))
        projectType = 'Flutter / Dart';
    else if (exists('Package.swift'))
        projectType = 'Swift Package';
    else if (exists('next.config.js') || exists('next.config.ts'))
        projectType = 'Next.js';
    else if (exists('Cargo.toml'))
        projectType = 'Rust';
    else if (exists('go.mod'))
        projectType = 'Go';
    else if (exists('pyproject.toml') || exists('requirements.txt'))
        projectType = 'Python';
    else if (exists('tsconfig.json'))
        projectType = 'TypeScript';
    else if (exists('package.json'))
        projectType = 'Node.js';
    const files = [];
    function walk(dir) {
        if (files.length >= 2000)
            return;
        let entries;
        try {
            entries = fs_1.default.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const e of entries) {
            if (files.length >= 2000)
                break;
            if (e.isDirectory()) {
                if (!SKIP.has(e.name) && !e.name.startsWith('.'))
                    walk(path_1.default.join(dir, e.name));
            }
            else if (e.isFile()) {
                const ext = path_1.default.extname(e.name).slice(1).toLowerCase();
                if (!SRC_EXT.has(ext))
                    continue;
                const abs = path_1.default.join(dir, e.name);
                const rel = path_1.default.relative(projectPath, abs).replace(/\\/g, '/');
                let lines = 0;
                try {
                    lines = fs_1.default.readFileSync(abs, 'utf-8').split('\n').length;
                }
                catch { }
                files.push({ dir: path_1.default.dirname(rel), ext, lines });
            }
        }
    }
    walk(projectPath);
    // Git history
    let gitLines = [];
    try {
        const { stdout } = await execFileAsync('git', ['log', '--oneline', '--format=%H|%s|%an|%ai', '-n', '10'], { cwd: projectPath, timeout: 5000 });
        gitLines = String(stdout).trim().split('\n').filter(Boolean);
    }
    catch { }
    // Build profile
    const sections = [];
    sections.push(`PROJECT PROFILE: ${projectName}`);
    sections.push(`Type: ${projectType}`);
    sections.push(`Path: ${projectPath}`);
    sections.push('');
    // File tree
    if (files.length > 0) {
        const dirMap = new Map();
        for (const f of files) {
            const d = f.dir || '.';
            const e = dirMap.get(d) ?? { f: 0, l: 0, exts: new Set() };
            e.f++;
            e.l += f.lines;
            e.exts.add(f.ext);
            dirMap.set(d, e);
        }
        const totalLines = files.reduce((s, f) => s + f.lines, 0);
        sections.push(`FILE STRUCTURE (${files.length} files, ${totalLines.toLocaleString()} lines):`);
        const sorted = Array.from(dirMap.entries()).sort((a, b) => b[1].f - a[1].f).slice(0, 20);
        for (const [dir, info] of sorted) {
            sections.push(`  ${dir}/ (${info.f} files, ${info.l.toLocaleString()} lines) [${Array.from(info.exts).join(', ')}]`);
        }
        sections.push('');
    }
    // Git
    if (gitLines.length > 0) {
        sections.push('RECENT GIT ACTIVITY:');
        for (const line of gitLines) {
            const [, message, author, date] = line.split('|');
            sections.push(`  - ${date?.slice(0, 10)}: ${message} (${author})`);
        }
        sections.push('');
    }
    const profileText = sections.join('\n');
    // Cache in DB
    db.prepare('DELETE FROM codebaseSnapshots WHERE projectId = ?').run(projectId);
    db.prepare(`INSERT INTO codebaseSnapshots (projectId, capturedAt, profileText) VALUES (?, datetime('now'), ?)`).run(projectId, profileText);
    return profileText;
}
// ─── Start ───────────────────────────────────────────────────────────────────
async function main() {
    const connFile = writeConnectionFile();
    const cleanup = () => {
        removeConnectionFile();
        db.close();
        process.exit(0);
    };
    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);
    const transport = new stdio_js_1.StdioServerTransport();
    await server.connect(transport);
    // Log to stderr (stdout is reserved for MCP protocol)
    process.stderr.write(`CodeFire MCP server started (pid ${process.pid}, connection file: ${connFile})\n`);
}
main().catch((err) => {
    process.stderr.write(`Fatal: ${err}\n`);
    removeConnectionFile();
    db.close();
    process.exit(1);
});
