import { ForgeError, type ChatMessage } from '@forgeos/core';
import { getActiveWorkspace, getCurrentUser } from '@/lib/server/context';
import { createAssistant } from '@/lib/server/assistant';
import { errorResponse } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * Server-sent events for the assistant.
 *
 * Not wrapped in the shared `route()` helper because that returns JSON; the
 * auth and workspace resolution are performed explicitly instead.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const user = await getCurrentUser();
    const workspace = await getActiveWorkspace(request.headers.get('x-forgeos-workspace'));

    const body = (await request.json().catch(() => ({}))) as {
      message?: string;
      model?: string;
      projectId?: string;
    };

    const message = (body.message ?? '').trim();
    if (message === '') {
      throw new ForgeError("'message' is required", { code: 'invalid_input' });
    }

    const assistant = await createAssistant({
      workspaceId: workspace.id,
      ...(body.model ? { model: body.model } : {}),
      ...(body.projectId ? { projectId: body.projectId } : {}),
    });

    const messages: ChatMessage[] = [{ role: 'user', content: message }];
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (payload: unknown): void => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        };

        try {
          for await (const chunk of assistant.askStream(messages, {
            workspaceId: workspace.id,
            userId: user.id,
            ...(body.projectId ? { projectId: body.projectId } : {}),
          })) {
            if (chunk.done) {
              send({
                done: true,
                model: chunk.response?.model,
                costUsd: chunk.response?.costUsd,
                steps: chunk.steps?.map((step) => step.toolCall.name) ?? [],
              });
              break;
            }
            if (chunk.delta) send({ delta: chunk.delta });
          }
        } catch (error) {
          send({ error: ForgeError.from(error).message });
        } finally {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Disable proxy buffering, which otherwise defeats streaming entirely.
        'x-accel-buffering': 'no',
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
