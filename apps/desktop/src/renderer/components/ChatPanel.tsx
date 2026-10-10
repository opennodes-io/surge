import React, { useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import McpToolCallBlock from './McpToolCallBlock';
import LiveUiView from './LiveUiView';
import { validateLiveUi } from '@surge/core/ui';
import { IconUser, IconBot } from './Icons';
import type { ChatMessage, OnpCall } from '../types';
import type { ToolCallData } from './McpToolCallBlock';
import './ChatPanel.css';

const RECEIPT_LABEL: Record<OnpCall['receipt'], string> = {
  verified: '✓ receipt verified',
  missing: 'no receipt',
  unverified: 'receipt not checked',
  invalid: '✗ receipt invalid',
};

// One line per OpenNodes call: who served it, at what pinned price, and what the signed receipt
// says. Registry-measured and this-call latency are labeled separately — never blended.
const OnpCallLine: React.FC<{ call: OnpCall }> = ({ call }) => (
  <div className="onp-call" title={`${call.offering} · card ${call.cardRevision}${call.receiptId ? ` · ${call.receiptId}` : ''}`}>
    {call.advisor && (
      <span className="onp-advisor" title={[...call.advisor.reasons, ...call.advisor.skipped.map(s => `skipped ${s}`)].join('\n')}>
        auto · {call.advisor.taskClass} → {call.modelName}{call.advisor.reasons[0] ? ` (${call.advisor.reasons[0]})` : ''}
        {call.advisor.skipped.length > 0 && ` · ${call.advisor.skipped.length} skipped`}
      </span>
    )}
    <span>{call.tier.toUpperCase()}</span>
    <span>{call.nodeId}</span>
    {call.registryTtftMsP50 != null && <span>p50 {call.registryTtftMsP50}ms (registry)</span>}
    <span>took {(call.durationMs / 1000).toFixed(1)}s</span>
    <span>{call.price}</span>
    <span className={`onp-receipt ${call.receipt}`}>
      {RECEIPT_LABEL[call.receipt]}{call.reason ? `: ${call.reason}` : ''}
    </span>
    {call.usage && <span>{call.usage.promptTokens}+{call.usage.completionTokens} tok</span>}
    {call.amount && <span>{call.amount.currency} {call.amount.value.toFixed(6)}</span>}
  </div>
);

// A ui__render call is drawn as its Live UI view: while the model writes it (pending) and runs it,
// as far as it goes and not yet clickable; then finished. Everything else, a view that has nothing
// valid yet, and a failed one are the usual tool-call block.
const ToolCall: React.FC<{ data: ToolCallData }> = ({ data }) => {
  const isView = data.serverId === 'ui' && data.toolName === 'render' && data.status !== 'error';
  if (isView && validateLiveUi(data.args).spec) return <LiveUiView args={data.args} pending={data.status !== 'success'} />;
  return <McpToolCallBlock data={data.status === 'pending' ? { ...data, status: 'running' } : data} />;
};

interface ChatPanelProps {
  messages: ChatMessage[];
  streamContent: string;
  isStreaming: boolean;
  toolCalls?: ToolCallData[];
}

const ChatPanel: React.FC<ChatPanelProps> = ({ messages, streamContent, isStreaming, toolCalls = [] }) => {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamContent, toolCalls]);

  return (
    <div className="chat-panel">
      <div className="chat-messages stagger-children">
        {messages.map((msg, i) => (
          <div key={i} className={`chat-message ${msg.role}`}>
            <div className="message-avatar">
              {msg.role === 'user' ? <IconUser size={16} /> : <IconBot size={16} />}
            </div>
            <div className="message-content">
              {msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0 && (
                <div className="tool-calls-section">
                  {msg.toolCalls.map((tc) => <ToolCall key={tc.id} data={tc} />)}
                </div>
              )}
              {msg.role === 'assistant' ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {msg.content}
                </ReactMarkdown>
              ) : (
                <p>{msg.content}</p>
              )}
              {msg.onpCalls?.map((call, j) => <OnpCallLine key={j} call={call} />)}
            </div>
          </div>
        ))}

        {toolCalls.length > 0 && (
          <div className="tool-calls-section fade-in">
            {toolCalls.map((tc) => <ToolCall key={tc.id} data={tc} />)}
          </div>
        )}

        {(isStreaming || streamContent) && (
          <div className="chat-message assistant streaming">
            <div className="message-avatar">
              <IconBot size={16} />
            </div>
            <div className="message-content">
              {streamContent ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {streamContent}
                </ReactMarkdown>
              ) : (
                <div className="typing-indicator">
                  <span></span><span></span><span></span>
                </div>
              )}
              {isStreaming && <span className="cursor-blink">▊</span>}
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>
    </div>
  );
};

export default ChatPanel;
