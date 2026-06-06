// @surge/core — platform-agnostic logic shared by the desktop shell, the mobile
// shell, and the standalone MCP servers. Consumed as TypeScript source (bundled
// by the consumer's build), so there is no separate compile step.

export * from './ports/index.js';
export * from './storage/index.js';
export * from './ai/index.js';
export * from './mcp/index.js';
export * from './orchestrator/index.js';
export * from './webmcp/index.js';
export * from './ui/index.js';
export * from './discovery/index.js';
