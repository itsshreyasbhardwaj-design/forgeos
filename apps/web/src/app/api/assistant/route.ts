import { createId, summariseConversation, type ChatMessage } from '@forgeos/core';
import { getContext } from '@/lib/server/context';
import { route, readJson, requireString, optionalString } from '@/lib/server/http';
import { createAssistant, detectInjectionAttempt } from '@/lib/server/assistant';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export const POST = route(
  async ({ workspace, user, request }) => {
    const { store } = await getContext();
    const body = await readJson(request);
    const message = requireString(body, 'message', 8000);
    const model = optionalString(body, 'model');
    const projectId = optionalString(body, 'projectId');
    const conversationId = optionalString(body, 'conversationId');

    const now = Date.now();

    // Load or start the conversation.
    let conversation = conversationId
      ? await store.getConversation(workspace.id, conversationId)
      : null;

    if (!conversation) {
      conversation = {
        id: createId('cnv', now),
        workspaceId: workspace.id,
        title: summariseConversation([{ role: 'user', content: message }]),
        createdAt: now,
        updatedAt: now,
        userId: user.id,
        ...(projectId ? { projectId } : {}),
      };
      await store.saveConversation(conversation);
    }

    const history = await store.listMessages(conversation.id);
    const messages: ChatMessage[] = [
      ...history
        .filter((entry) => entry.role === 'user' || entry.role === 'assistant')
        .map((entry) => ({ role: entry.role as 'user' | 'assistant', content: entry.content })),
      { role: 'user', content: message },
    ];

    await store.saveMessage({
      id: createId('msg', now),
      conversationId: conversation.id,
      role: 'user',
      content: message,
      createdAt: now,
    });

    const assistant = await createAssistant({
      workspaceId: workspace.id,
      ...(model ? { model } : {}),
      ...(projectId ? { projectId } : {}),
    });

    const answer = await assistant.ask(
      messages,
      { workspaceId: workspace.id, userId: user.id, ...(projectId ? { projectId } : {}) },
      conversation.id
    );

    const answeredAt = Date.now();
    await store.saveMessage({
      id: createId('msg', answeredAt),
      conversationId: conversation.id,
      role: 'assistant',
      content: answer.text,
      createdAt: answeredAt,
      model: answer.model,
      costUsd: answer.costUsd,
      citations: answer.citations,
    });

    await store.saveConversation({ ...conversation, updatedAt: answeredAt });

    // Surface, rather than silently strip, instruction-shaped content that came
    // back from a tool. The user is best placed to judge it.
    const injection = detectInjectionAttempt(
      answer.steps.map((step) => step.result?.content ?? '').join('\n')
    );

    return {
      text: answer.text,
      citations: answer.citations,
      steps: answer.steps.map((step) => ({
        tool: step.toolCall.name,
        durationMs: step.durationMs,
        ok: step.result !== null,
        error: step.error ?? null,
      })),
      model: answer.model,
      costUsd: answer.costUsd,
      latencyMs: answer.latencyMs,
      conversationId: conversation.id,
      ...(injection.suspicious ? { warning: { kind: 'prompt_injection', matches: injection.matches } } : {}),
    };
  },
  { limit: 60, audit: 'assistant.ask' }
);
