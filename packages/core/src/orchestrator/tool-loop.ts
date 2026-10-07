import type { AiService, PendingToolCall, ChatMessageWithTools, OnpCallRecord } from '../ai/ai-service.js';
import type { ToolDefinition } from '../mcp/mcp-manager.js';

export interface ToolExecutionResult {
  resultText: string;
  rawContent?: any[];
  serverId?: string;
}

export interface ToolCallStartInfo {
  id: string;
  name: string;
  args: any;
}

export interface ToolCallResultInfo {
  id: string;
  name: string;
  serverId: string;
  status: 'success' | 'error';
  /** Rich content array when available (images/tables/ui), else a string. */
  result: any;
  durationMs: number;
  args: any;
}

export interface ToolLoopCallbacks {
  onToken: (token: string) => void;
  onToolCallStart: (info: ToolCallStartInfo) => void;
  onToolCallResult: (info: ToolCallResultInfo) => void;
  /** An ONP call settled (receipt checked, spend counted) — once per model round. */
  onOnpCall?: (call: OnpCallRecord) => void;
  onEnd: () => void;
  onError: (message: string) => void;
}

export interface ToolLoopOptions {
  ai: AiService;
  model: string;
  /** Conversation is mutated in place as the loop appends assistant/tool turns. */
  conversation: ChatMessageWithTools[];
  toolDefs: ToolDefinition[];
  systemPrompt?: string;
  executeTool: (tc: PendingToolCall) => Promise<ToolExecutionResult>;
  callbacks: ToolLoopCallbacks;
  maxRounds?: number;
}

/**
 * Platform-neutral multi-round tool-calling loop, extracted from the Electron IPC
 * handler. The shell supplies `executeTool` (which routes browser/MCP/virtual tools)
 * and callbacks (which forward events over IPC). Stream-end is emitted exactly once;
 * an error emits onError instead of onEnd.
 */
export async function runToolLoop(opts: ToolLoopOptions): Promise<void> {
  const { ai, model, conversation, toolDefs, systemPrompt, executeTool, callbacks } = opts;
  const maxRounds = opts.maxRounds ?? 10;
  const hasTools = toolDefs.length > 0;
  let round = 0;
  let streamEndSent = false;

  const runStream = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      ai.streamChat(
        conversation,
        model,
        {
          onToken: (token: string) => callbacks.onToken(token),

          onOnpCall: (call) => callbacks.onOnpCall?.(call),

          onToolCall: async (toolCalls: PendingToolCall[]) => {
            round++;
            if (round > maxRounds) {
              callbacks.onToken('\n\n*Reached maximum tool call depth. Stopping.*');
              if (!streamEndSent) {
                streamEndSent = true;
                callbacks.onEnd();
              }
              resolve();
              return;
            }

            // Record the assistant's tool-call turn.
            conversation.push({
              role: 'assistant',
              content: '',
              tool_calls: toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function' as const,
                function: { name: tc.functionName, arguments: JSON.stringify(tc.arguments) },
              })),
            });

            for (const tc of toolCalls) {
              callbacks.onToolCallStart({ id: tc.id, name: tc.functionName, args: tc.arguments });

              let resultText: string;
              const startedAt = Date.now();
              try {
                const result = await executeTool(tc);
                resultText = result.resultText;
                callbacks.onToolCallResult({
                  id: tc.id,
                  name: tc.functionName,
                  serverId: result.serverId || 'unknown',
                  status: 'success',
                  result: result.rawContent && result.rawContent.length > 0 ? result.rawContent : resultText,
                  durationMs: Date.now() - startedAt,
                  args: tc.arguments,
                });
              } catch (err: any) {
                resultText = `Error: ${err.message}`;
                callbacks.onToolCallResult({
                  id: tc.id,
                  name: tc.functionName,
                  serverId: 'unknown',
                  status: 'error',
                  result: resultText,
                  durationMs: Date.now() - startedAt,
                  args: tc.arguments,
                });
              }

              conversation.push({ role: 'tool', content: resultText, tool_call_id: tc.id, name: tc.functionName });
            }

            // Feed results back to the model.
            try {
              await runStream();
              resolve();
            } catch (err) {
              reject(err);
            }
          },

          onEnd: () => resolve(), // streamEnd is sent once after the whole orchestration

          onError: (err: string) => {
            if (!streamEndSent) {
              streamEndSent = true;
              callbacks.onError(err);
            }
            resolve();
          },
        },
        hasTools ? toolDefs : undefined,
        systemPrompt || undefined,
      ).catch(reject); // a provider that rejects instead of calling onError must still end the turn
    });

  try {
    await runStream();
    if (!streamEndSent) {
      streamEndSent = true;
      callbacks.onEnd();
    }
  } catch (err: any) {
    if (!streamEndSent) {
      streamEndSent = true;
      callbacks.onError(err?.message || 'Unknown streaming error');
    }
  }
}
