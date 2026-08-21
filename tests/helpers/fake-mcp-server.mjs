#!/usr/bin/env node
/**
 * A downstream MCP server for broker tests.
 *
 * Advertises a deliberate mix of read, write, destructive, and unclassifiable
 * tools so the classifier and policy filter have something real to refuse. It
 * also records every tool call it actually receives to FAKE_MCP_CALL_LOG, which
 * is how the security tests prove a refused call never reached the server.
 *
 * Minimal hand-rolled JSON-RPC over stdio: the point is to be a hostile-ish
 * third party, not to depend on our own SDK usage being correct.
 */
import { appendFileSync } from 'node:fs';

const callLog = process.env.FAKE_MCP_CALL_LOG;

const TOOLS = [
  { name: 'get_issue', description: 'Fetch one issue by key.', inputSchema: { type: 'object', properties: { key: { type: 'string' } } } },
  { name: 'search_issues', description: 'Search issues with JQL.', inputSchema: { type: 'object', properties: { jql: { type: 'string' } } } },
  { name: 'list_tables', description: 'List database tables.', inputSchema: { type: 'object', properties: {} } },
  { name: 'read_query', description: 'Run a read-only SQL query.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } } } },
  { name: 'execute_query', description: 'Run an arbitrary SQL statement.', inputSchema: { type: 'object', properties: { sql: { type: 'string' } } } },
  { name: 'create_issue', description: 'Create a new issue.', inputSchema: { type: 'object', properties: {} } },
  { name: 'add_comment', description: 'Comment on an issue.', inputSchema: { type: 'object', properties: {} } },
  { name: 'transition_issue', description: 'Move an issue to another status.', inputSchema: { type: 'object', properties: {} } },
  { name: 'delete_issue', description: 'Delete an issue permanently.', inputSchema: { type: 'object', properties: {} } },
  { name: 'upload_file', description: 'Upload a file to the server.', inputSchema: { type: 'object', properties: {} } },
  { name: 'frobnicate', description: 'Does something unspecified.', inputSchema: { type: 'object', properties: {} } },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(request) {
  const { id, method, params } = request;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-downstream', version: '1.0.0' },
      },
    };
  }

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }

  if (method === 'tools/call') {
    if (callLog) appendFileSync(callLog, `${JSON.stringify({ name: params.name, arguments: params.arguments })}\n`);
    return {
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, tool: params.name, args: params.arguments }) }] },
    };
  }

  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }
    // Notifications carry no id and expect no reply.
    if (request.id === undefined) continue;
    send(handle(request));
  }
});
