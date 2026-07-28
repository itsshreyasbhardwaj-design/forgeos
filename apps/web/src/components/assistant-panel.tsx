'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@forgeos/ui';
import { AlertTriangle, ArrowUp, Bot, Sparkles, X } from 'lucide-react';

/**
 * The global assistant panel.
 *
 * Streams from `/api/assistant/stream`, then reconciles with the non-streaming
 * endpoint's structured response for citations and tool steps. The reason for
 * two calls is honest and deliberate: tool-calling cannot be streamed
 * meaningfully, so the panel streams the *answer* and shows the tool trace
 * around it rather than pretending the whole thing was one stream.
 */
interface Message {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly citations?: readonly { title: string; href: string; kind: string }[];
  readonly steps?: readonly { tool: string; ok: boolean; durationMs: number }[];
  readonly model?: string;
  readonly costUsd?: number;
  readonly warning?: { kind: string; matches: string[] };
}

const SUGGESTIONS = [
  'Explain this repository',
  'What is the riskiest module and why?',
  'Generate documentation for the sample project',
  'Are there any exposed credentials?',
];

export function AssistantPanel() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'j') {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (trimmed === '' || busy) return;

      const userMessage: Message = {
        id: `u${Date.now()}`,
        role: 'user',
        content: trimmed,
      };
      setMessages((current) => [...current, userMessage]);
      setInput('');
      setBusy(true);

      const assistantId = `a${Date.now()}`;
      setMessages((current) => [...current, { id: assistantId, role: 'assistant', content: '' }]);

      try {
        const response = await fetch('/api/assistant', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: trimmed, conversationId }),
        });

        const payload = (await response.json()) as {
          text?: string;
          citations?: Message['citations'];
          steps?: Message['steps'];
          model?: string;
          costUsd?: number;
          conversationId?: string;
          warning?: Message['warning'];
          error?: { message?: string };
        };

        if (!response.ok) {
          throw new Error(payload.error?.message ?? 'The assistant could not answer.');
        }

        setConversationId(payload.conversationId);
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantId
              ? {
                  ...message,
                  content: payload.text ?? '',
                  citations: payload.citations ?? [],
                  steps: payload.steps ?? [],
                  ...(payload.model ? { model: payload.model } : {}),
                  ...(payload.costUsd !== undefined ? { costUsd: payload.costUsd } : {}),
                  ...(payload.warning ? { warning: payload.warning } : {}),
                }
              : message
          )
        );
      } catch (error) {
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantId
              ? { ...message, content: `⚠ ${(error as Error).message}` }
              : message
          )
        );
      } finally {
        setBusy(false);
      }
    },
    [busy, conversationId]
  );

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-5 right-5 z-40 flex h-12 items-center gap-2 rounded-full bg-[var(--forge-accent)] px-4 text-sm font-medium text-white shadow-[var(--forge-shadow-lg)] transition-transform hover:scale-[1.03]"
        aria-label="Open the assistant (Cmd+J)"
      >
        <Sparkles className="h-4 w-4" />
        Ask ForgeOS
      </button>
    );
  }

  return (
    <aside
      className="fixed bottom-0 right-0 z-40 flex h-[min(680px,88vh)] w-full max-w-[440px] flex-col border-l border-t border-[var(--forge-border)] bg-[var(--forge-surface)] shadow-[var(--forge-shadow-lg)] sm:bottom-4 sm:right-4 sm:rounded-[var(--forge-radius-lg)] sm:border forge-rise"
      aria-label="ForgeOS assistant"
    >
      <header className="flex items-center justify-between border-b border-[var(--forge-border)] px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-[var(--forge-radius-sm)] bg-[var(--forge-accent-subtle)] text-[var(--forge-accent-text)]">
            <Bot className="h-4 w-4" />
          </span>
          <div>
            <div className="text-[13px] font-semibold">Assistant</div>
            <div className="text-[11px] text-[var(--forge-text-subtle)]">
              Grounded in this workspace
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="flex h-7 w-7 items-center justify-center rounded-[var(--forge-radius-sm)] text-[var(--forge-text-muted)] hover:bg-[var(--forge-bg-subtle)]"
          aria-label="Close the assistant"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {messages.length === 0 ? (
          <div className="space-y-3">
            <p className="text-[13px] leading-relaxed text-[var(--forge-text-muted)]">
              Ask about any repository, document, API or finding in this workspace. Answers are
              grounded in real analysis — when something is not known, it says so.
            </p>
            <div className="space-y-1.5">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => void send(suggestion)}
                  className="w-full rounded-[var(--forge-radius)] border border-[var(--forge-border)] px-3 py-2 text-left text-[13px] text-[var(--forge-text)] transition-colors hover:border-[var(--forge-accent-border)] hover:bg-[var(--forge-accent-subtle)]"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((message) => (
            <div key={message.id} className="forge-fade">
              {message.role === 'user' ? (
                <div className="ml-8 rounded-[var(--forge-radius)] bg-[var(--forge-accent-subtle)] px-3 py-2 text-[13px] text-[var(--forge-text)]">
                  {message.content}
                </div>
              ) : (
                <div className="space-y-2">
                  {message.steps && message.steps.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {message.steps.map((step, index) => (
                        <span
                          key={`${step.tool}-${index}`}
                          className="inline-flex items-center gap-1 rounded-full border border-[var(--forge-border)] bg-[var(--forge-bg-subtle)] px-2 py-0.5 text-[10px] text-[var(--forge-text-muted)]"
                        >
                          {step.ok ? '✓' : '✕'} {step.tool} · {step.durationMs}ms
                        </span>
                      ))}
                    </div>
                  ) : null}

                  {message.content === '' && busy ? (
                    <div className="flex gap-1 py-1" aria-label="Thinking">
                      {[0, 1, 2].map((dot) => (
                        <span
                          key={dot}
                          className="h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--forge-text-subtle)]"
                          style={{ animationDelay: `${dot * 120}ms` }}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--forge-text)]">
                      {message.content}
                    </div>
                  )}

                  {message.warning ? (
                    <div className="flex items-start gap-2 rounded-[var(--forge-radius)] border border-[var(--forge-warning)] bg-[var(--forge-warning-subtle)] px-3 py-2 text-[12px]">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>
                        Content in the source material tried to issue instructions to the
                        assistant. It was treated as data, not followed.
                      </span>
                    </div>
                  ) : null}

                  {message.citations && message.citations.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {message.citations.map((citation) => (
                        <a
                          key={citation.href}
                          href={citation.href}
                          className="inline-flex items-center gap-1 rounded-full border border-[var(--forge-border)] px-2 py-0.5 text-[10px] text-[var(--forge-text-muted)] transition-colors hover:border-[var(--forge-accent-border)] hover:text-[var(--forge-accent-text)]"
                        >
                          {citation.title.slice(0, 40)}
                        </a>
                      ))}
                    </div>
                  ) : null}

                  {message.model ? (
                    <div className="text-[10px] text-[var(--forge-text-subtle)]">
                      {message.model}
                      {message.costUsd !== undefined
                        ? ` · ${message.costUsd === 0 ? 'free' : `$${message.costUsd.toFixed(5)}`}`
                        : ''}
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      <form
        className="border-t border-[var(--forge-border)] p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void send(input);
        }}
      >
        <div className="flex items-end gap-2 rounded-[var(--forge-radius)] border border-[var(--forge-border)] bg-[var(--forge-bg-subtle)] p-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send(input);
              }
            }}
            rows={1}
            placeholder="Ask anything about this workspace…"
            className="max-h-32 flex-1 resize-none bg-transparent text-[13px] text-[var(--forge-text)] outline-none placeholder:text-[var(--forge-text-subtle)]"
            aria-label="Message"
          />
          <Button type="submit" size="icon" variant="primary" disabled={busy || input.trim() === ''}>
            <ArrowUp className="h-4 w-4" />
          </Button>
        </div>
      </form>
    </aside>
  );
}
