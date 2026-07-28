import { Badge, Card, CardContent, EmptyState, Stat } from '@forgeos/ui';
import { Brain } from 'lucide-react';
import { buildKnowledgeGraph, centralEntities } from '@forgeos/core';
import { getActiveWorkspace, getContext } from '@/lib/server/context';
import { PageHeader, Section } from '@/components/primitives';
import { AddMemoryForm } from '@/components/actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Memory' };

export default async function MemoryPage() {
  const workspace = await getActiveWorkspace();
  const { store } = await getContext();
  const memories = await store.listMemories(workspace.id, { limit: 500 });
  const graph = buildKnowledgeGraph(memories);
  const central = centralEntities(graph, 12);

  const byKind = memories.reduce<Record<string, number>>((counts, memory) => {
    counts[memory.kind] = (counts[memory.kind] ?? 0) + 1;
    return counts;
  }, {});

  return (
    <>
      <PageHeader
        title="Memory"
        description="Long-term semantic memory for the things a codebase cannot tell you: why a decision was made, what was tried before, and what the team agreed."
      />

      <Section>
        <div className="grid gap-4 sm:grid-cols-3">
          <Card>
            <CardContent className="pt-5">
              <Stat label="Memories" value={memories.length} hint={Object.entries(byKind).map(([kind, count]) => `${count} ${kind}`).join(' · ') || 'nothing stored yet'} />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5">
              <Stat
                label="Entities"
                value={graph.entities.length}
                hint="extracted from memory content"
              />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5">
              <Stat
                label="Relations"
                value={graph.edges.length}
                hint="co-occurrence links in the knowledge graph"
              />
            </CardContent>
          </Card>
        </div>
      </Section>

      <Section title="Record something">
        <Card>
          <CardContent className="pt-5">
            <AddMemoryForm />
            <p className="mt-3 text-[12px] text-[var(--forge-text-subtle)]">
              Retrieval is hybrid — BM25 lexical scoring fused with vector similarity — because
              lexical search misses paraphrase and vector search misses exact identifiers.
            </p>
          </CardContent>
        </Card>
      </Section>

      {central.length > 0 ? (
        <Section title="What this workspace is about" description="Entities ranked by weighted degree centrality in the knowledge graph.">
          <div className="flex flex-wrap gap-2">
            {central.map((entity) => (
              <span
                key={entity.id}
                className="inline-flex items-center gap-2 rounded-full border border-[var(--forge-border)] px-3 py-1.5 text-[12px]"
                title={`${entity.type} · mentioned ${entity.mentions} time(s)`}
              >
                <span className="font-medium">{entity.name}</span>
                <Badge tone="neutral">{entity.type}</Badge>
                <span className="tabular-nums text-[var(--forge-text-subtle)]">
                  {entity.mentions}
                </span>
              </span>
            ))}
          </div>
        </Section>
      ) : null}

      <Section title={`${memories.length} stored memories`}>
        {memories.length === 0 ? (
          <Card>
            <EmptyState
              icon={<Brain className="h-5 w-5" />}
              title="Nothing remembered yet"
              description="Record a decision, a convention or a hard-won fact. The assistant will recall it when it is relevant."
            />
          </Card>
        ) : (
          <div className="space-y-2">
            {memories.map((memory) => (
              <Card key={memory.id}>
                <CardContent className="pt-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="accent">{memory.kind}</Badge>
                    <span className="text-[11px] text-[var(--forge-text-subtle)]">
                      {new Date(memory.createdAt).toLocaleDateString()} · source: {memory.source} ·
                      recalled {memory.accessCount}×
                    </span>
                  </div>
                  <p className="mt-2 text-[13px] leading-relaxed text-[var(--forge-text)]">
                    {memory.content}
                  </p>
                  {memory.tags.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {memory.tags.map((tag) => (
                        <Badge key={tag} tone="neutral">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </Section>
    </>
  );
}
