import { ipcMain } from 'electron';
import {
  generateAgentSpec,
  buildAgentVirtualServer,
  runAgentCodeSandbox,
  specUsesCode,
  agentServerId,
  type McpManager,
  type AiService,
  type BrowserPort,
  type PageContext,
  type WebAgentSpec,
} from '@surge/core';
import type { BrowserService } from './browser-service';
import { SettingsService } from './settings-service';
import { getStore } from './store';

function safeParse(v: any): any {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
}

/**
 * Agentic per-site agents: generate a declarative agent from the current page, let the
 * user approve it, persist it to the active profile, and register it as a virtual MCP
 * server (rehydrated on startup). Arbitrary-code tools run only via the gated sandbox.
 */
export function registerAgentHandlers(
  mcpManager: McpManager,
  aiService: AiService,
  browserService: BrowserService,
  browserPort: BrowserPort,
  settings: SettingsService,
): void {
  const registerAgent = (spec: WebAgentSpec) => {
    if (!spec || !Array.isArray(spec.tools) || spec.tools.length === 0) return;
    mcpManager.registerVirtualServer(
      buildAgentVirtualServer(spec, browserPort, {
        runCode: (code, input, page) => runAgentCodeSandbox(code, input, page),
      }),
    );
  };

  // Rehydrate saved agents for the active profile on startup.
  (async () => {
    const store = await getStore();
    await store.profiles.ensureDefault();
    const profile = await store.profiles.getActive();
    const agents = await store.agents.list(profile?.id);
    for (const a of agents) {
      if ((a.kind === 'web-mcp' || a.kind === 'codegen') && a.spec) registerAgent(a.spec as unknown as WebAgentSpec);
    }
  })().catch((err) => console.error('[surge] agent rehydrate failed:', err));

  async function gatherPageContext(): Promise<PageContext> {
    const url = browserPort.getUrl() || '';
    let domain = 'site';
    try {
      domain = new URL(url).hostname || 'site';
    } catch {
      /* keep default */
    }
    const meta = safeParse(await browserService.executeTool('getPageMetadata', {}).catch(() => ''));
    const forms = safeParse(await browserService.executeTool('getFormFields', {}).catch(() => ''));
    const links = safeParse(await browserService.executeTool('getLinks', {}).catch(() => ''));
    const textRaw = await browserService.executeTool('getPageContent', {}).catch(() => '');
    return {
      url,
      domain,
      title: meta?.title,
      headings: meta?.headings,
      forms,
      links: Array.isArray(links) ? links.slice(0, 30) : links,
      text: typeof textRaw === 'string' ? textRaw.slice(0, 1500) : '',
    };
  }

  // Generate a proposal (NOT saved, NOT run — the user must approve first).
  ipcMain.handle('agents:generate', async (_e, model: string) => {
    try {
      const ctx = await gatherPageContext();
      const chosen = model || settings.get('ai.defaultModel') || 'gemini-flash-lite';
      const spec = await generateAgentSpec(aiService, chosen, ctx);
      return { success: true, spec, usesCode: specUsesCode(spec) };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // Persist an approved agent to the active profile and register it.
  ipcMain.handle('agents:save', async (_e, spec: WebAgentSpec) => {
    try {
      if (!spec?.tools?.length) return { success: false, error: 'Agent has no tools' };
      const store = await getStore();
      const profile = await store.profiles.ensureDefault();
      const saved = await store.agents.create({
        name: spec.name,
        description: spec.description,
        kind: spec.source === 'codegen' ? 'codegen' : 'web-mcp',
        spec: spec as any,
        profileId: profile.id,
      });
      registerAgent(spec);
      return { success: true, agent: saved };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('agents:list', async () => {
    const store = await getStore();
    const profile = await store.profiles.getActive();
    return store.agents.list(profile?.id);
  });

  ipcMain.handle('agents:remove', async (_e, id: string, domain?: string) => {
    const store = await getStore();
    const removed = await store.agents.remove(id);
    if (domain) mcpManager.unregisterVirtualServer(agentServerId(domain));
    return { removed };
  });
}
