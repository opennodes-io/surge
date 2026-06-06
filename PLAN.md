# MCP Client — Standalone .NET 8 Project

## Context
Separate project at `D:\Projects\AI\Projects\MCP_client\` for all MCP functionality:
- MCP server discovery (via MCP_Index at `D:\Projects\AI\Projects\MCP_Index`)
- Dynamic MCP server connections
- LLM tool calling with connected MCP server tools
- MCP dashboard UI + tool call visualization
- Uses .NET 8 with official `ModelContextProtocol` NuGet SDK

MCP_Browser (`D:\Projects\AI\Projects\MCP_browser`) stays focused on AI document chat (RAG).

## Tech Stack
- .NET 8 (ASP.NET Core)
- `ModelContextProtocol` 0.8.0-preview.1 — official C# MCP client/server SDK
- `Microsoft.Extensions.AI` 10.3.0 — IChatClient abstraction
- SignalR for real-time streaming
- Blazor Server or Razor Pages for UI (TBD)

## Solution Structure

```
D:\Projects\AI\Projects\MCP_client\
├── MCP_client.sln
├── src/
│   ├── McpClient.Core/              # Core services, models, no UI dependency
│   │   ├── Models/
│   │   │   └── McpModels.cs          # MCP server, tool, connection models
│   │   ├── Services/
│   │   │   ├── McpIndexService.cs    # REST client for MCP_Index API
│   │   │   ├── McpConnectionManager.cs # Connect/disconnect MCP servers via SDK
│   │   │   ├── ToolRouter.cs         # Route LLM tool calls to correct MCP server
│   │   │   └── ChatService.cs        # LLM chat with tool-calling loop
│   │   └── McpClient.Core.csproj
│   ├── McpClient.Web/               # ASP.NET Core web app
│   │   ├── Controllers/
│   │   │   ├── McpController.cs      # Dashboard API (servers, connections)
│   │   │   └── ChatController.cs     # Chat with tool calling
│   │   ├── Hubs/
│   │   │   └── ChatHub.cs           # SignalR: token streaming + tool-call events
│   │   ├── Pages/ or Views/
│   │   │   ├── Index.cshtml          # Main dashboard + chat UI
│   │   │   └── _Layout.cshtml
│   │   ├── wwwroot/
│   │   ├── Program.cs               # DI setup, service registration
│   │   └── McpClient.Web.csproj
│   └── McpClient.Tests/
│       └── McpClient.Tests.csproj
```

## Phase 1: Project Setup + MCP_Index Browsing

### 1.1 Create solution and projects
```bash
dotnet new sln -n MCP_client -o D:\Projects\AI\Projects\MCP_client
dotnet new classlib -n McpClient.Core -o src/McpClient.Core -f net8.0
dotnet new web -n McpClient.Web -o src/McpClient.Web -f net8.0
dotnet sln add src/McpClient.Core src/McpClient.Web
```

### 1.2 NuGet packages

**McpClient.Core:**
- `ModelContextProtocol` (0.8.0-preview.1)
- `Microsoft.Extensions.AI` (10.3.0)
- `System.Text.Json`

**McpClient.Web:**
- `Microsoft.AspNetCore.SignalR`
- Reference McpClient.Core

### 1.3 McpIndexService — Browse MCP_Index registry
REST client calling MCP_Index API at `http://localhost:3000/api/v1`:
- `SearchServersAsync(query, category, limit)` → GET /servers
- `GetServerDetailAsync(slug)` → GET /servers/:slug
- `GetCategoriesAsync()` → GET /categories
- `GetStatsAsync()` → GET /stats

### 1.4 McpModels
- `McpServerInfo` — slug, name, description, category, qualityScore, tools, installCommand
- `McpCategory` — id, name, slug, serverCount
- `McpConnection` — slug, displayName, state, transportType, tools
- `McpToolDefinition` — name, description, inputSchema
- `McpToolCallResult` — toolCallId, name, content, isError, durationMs

### 1.5 Dashboard UI (Razor Pages)
- Server browser: search, category filter, server cards
- Server detail: tools list, install command, connect button
- Connection panel: active connections with their tools

## Phase 2: MCP Server Connections

### 2.1 McpConnectionManager — Connect to MCP servers
Uses `ModelContextProtocol` SDK's MCP client:
- `ConnectAsync(slug)` — resolve install command from MCP_Index, spawn via stdio
- `ConnectAsync(command, args)` — direct stdio connection
- `ConnectAsync(url)` — SSE/HTTP transport connection
- `DisconnectAsync(slug)`
- `GetConnectionsAsync()` — list active connections
- `GetAllToolsAsync()` — aggregate tools from all connected servers
- `CallToolAsync(serverSlug, toolName, arguments)` — route call to correct connection

The `ModelContextProtocol` SDK handles:
- MCP JSON-RPC protocol
- Stdio/SSE/Streamable HTTP transports
- Tool/resource/prompt discovery
- Session management

### 2.2 Connection persistence
Store connected server configs in a JSON file so they auto-reconnect on restart.

## Phase 3: LLM Tool Calling

### 3.1 ChatService with tool-calling loop
Uses `Microsoft.Extensions.AI` `IChatClient` or raw HttpClient to vLLM:
1. Build messages with system prompt + user message
2. Include `tools` array from connected MCP servers
3. Send to vLLM with `tool_choice: "auto"`
4. Parse response — if tool_calls: execute via McpConnectionManager, loop
5. Stream final text response

### 3.2 ChatHub SignalR events
- `onToken(token)` — streaming text
- `onToolCallStart(id, serverSlug, toolName, argsJson)` — tool invocation
- `onToolCallResult(id, toolName, result, isError, durationMs)` — tool result
- `onComplete()` / `onError(msg)`

### 3.3 Tool call visualization in chat UI
Inline tool-call blocks with:
- Server + tool name header
- Collapsible arguments/result
- Status indicator (spinner → checkmark/X)
- Duration badge

## Phase 4: MCP_Index Integration (Discovery)

### 4.1 Auto-discovery
Use MCP_Index's `discover_server` capability to probe `.well-known/mcp` endpoints.

### 4.2 Gateway integration (optional)
Use `@mcp-rating/gateway` for dynamic server management with trust tiers, profiles, etc.

## Config (appsettings.json)
```json
{
  "McpIndex": {
    "Endpoint": "http://localhost:3000/api/v1"
  },
  "Vllm": {
    "ChatEndpoint": "http://localhost:8000/v1",
    "ChatModel": "meta-llama/Llama-3.3-70B-Instruct",
    "MaxTokens": 4096,
    "Temperature": 0.3
  },
  "Mcp": {
    "ToolCallingEnabled": true,
    "MaxConnections": 10,
    "ConnectionsFile": "mcp_connections.json"
  }
}
```

## Verification
1. `dotnet build` — compiles clean
2. `dotnet run --project src/McpClient.Web` — starts web server
3. Open dashboard → search MCP_Index servers
4. Connect to a server (e.g., filesystem) → see its tools listed
5. Chat → LLM uses connected tool → tool-call block appears → result feeds back

## Implementation Order
1. Solution scaffolding + NuGet packages
2. McpModels + McpIndexService (browse registry)
3. Dashboard UI (server browser)
4. McpConnectionManager (connect to servers via SDK)
5. Connection UI (connect/disconnect in dashboard)
6. ChatService with tool calling
7. ChatHub + tool call visualization
