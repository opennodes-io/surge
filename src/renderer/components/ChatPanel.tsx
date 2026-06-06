import React, { useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import McpToolCallBlock from './McpToolCallBlock';
import { IconUser, IconBot } from './Icons';
import type { ChatMessage } from '../types';
import type { ToolCallData } from './McpToolCallBlock';
import './ChatPanel.css';

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
              {msg.role === 'assistant' ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {msg.content}
                </ReactMarkdown>
              ) : (
                <p>{msg.content}</p>
              )}
            </div>
          </div>
        ))}

        {toolCalls.length > 0 && (
          <div className="tool-calls-section fade-in">
            {toolCalls.map((tc) => (
              <McpToolCallBlock key={tc.id} data={tc} />
            ))}
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
