import { Badge, Card, CardContent } from '@forgeos/ui';
import { FORGEOS_CORE_VERSION, PERMISSION_DESCRIPTIONS, PLUGIN_PERMISSIONS } from '@forgeos/core';
import { getActiveWorkspace, getContext, getRuntimeStatus } from '@/lib/server/context';
import { PageHeader, Section, KeyValue, Mono } from '@/components/primitives';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Settings' };

const SUBSYSTEMS = [
  {
    name: 'Storage',
    variable: 'DATABASE_URL',
    fallback: 'File storage under .forgeos/',
    upgrade: 'PostgreSQL with pgvector for semantic memory',
  },
  {
    name: 'AI',
    variable: 'OPENROUTER_API_KEY',
    fallback: 'forge-local — deterministic, offline, free',
    upgrade: 'Hosted models through OpenRouter',
  },
  {
    name: 'Authentication',
    variable: 'CLERK_SECRET_KEY',
    fallback: 'Local single-user session (development only)',
    upgrade: 'Clerk-managed identity and sessions',
  },
  {
    name: 'Cache and rate limiting',
    variable: 'REDIS_URL',
    fallback: 'In-process token bucket (per instance)',
    upgrade: 'Shared limits across every instance',
  },
  {
    name: 'Background jobs',
    variable: 'TRIGGER_SECRET_KEY',
    fallback: 'Inline execution with a bounded queue',
    upgrade: 'Durable background execution via Trigger.dev',
  },
] as const;

export default async function SettingsPage() {
  const workspace = await getActiveWorkspace();
  const { store } = await getContext();
  const runtime = await getRuntimeStatus();
  const members = await store.listMembers(workspace.id);
  const audit = await store.listAudit(workspace.id, { limit: 20 });

  const isActive = (variable: string): boolean =>
    Boolean(process.env[variable as keyof NodeJS.ProcessEnv]);

  return (
    <>
      <PageHeader
        title="Settings"
        description="What is running right now, and what changes if you configure more."
      />

      <Section title="Workspace">
        <Card>
          <CardContent className="pt-5">
            <KeyValue label="Name" value={workspace.name} />
            <KeyValue label="Identifier" value={<Mono>{workspace.id}</Mono>} />
            <KeyValue label="Slug" value={<Mono>{workspace.slug}</Mono>} />
            <KeyValue label="Members" value={members.length} />
            <KeyValue label="Created" value={new Date(workspace.createdAt).toLocaleDateString()} />
          </CardContent>
        </Card>
      </Section>

      <Section
        title="Runtime"
        description="Every subsystem has a working default. Setting an environment variable upgrades it at boot — no code changes, no rebuild."
      >
        <div className="space-y-2">
          {SUBSYSTEMS.map((subsystem) => {
            const active = isActive(subsystem.variable);
            return (
              <Card key={subsystem.name}>
                <CardContent className="pt-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[13px] font-semibold">{subsystem.name}</span>
                        <Badge tone={active ? 'success' : 'neutral'}>
                          {active ? 'configured' : 'using the default'}
                        </Badge>
                      </div>
                      <p className="mt-1 text-[12px] text-[var(--forge-text-muted)]">
                        {active ? subsystem.upgrade : subsystem.fallback}
                      </p>
                    </div>
                    <Mono>{subsystem.variable}</Mono>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        <Card className="mt-4">
          <CardContent className="pt-5">
            <KeyValue label="Kernel version" value={<Mono>{FORGEOS_CORE_VERSION}</Mono>} />
            <KeyValue label="Storage backend" value={runtime.storage} />
            <KeyValue label="AI providers" value={runtime.ai.join(', ')} />
            <KeyValue label="Default model" value={<Mono>{runtime.defaultModel}</Mono>} />
            <KeyValue label="Health endpoint" value={<Mono>GET /api/system/health</Mono>} />
          </CardContent>
        </Card>
      </Section>

      <Section
        title="Plugin permissions"
        description="Plugins declare what they need up front, and the host refuses anything they did not declare. This is the complete list a plugin can request."
      >
        <div className="grid gap-2 md:grid-cols-2">
          {PLUGIN_PERMISSIONS.map((permission) => (
            <div
              key={permission}
              className="flex items-start gap-3 rounded-[var(--forge-radius)] border border-[var(--forge-border)] p-3"
            >
              <Mono>{permission}</Mono>
              <span className="text-[12px] leading-relaxed text-[var(--forge-text-muted)]">
                {PERMISSION_DESCRIPTIONS[permission]}
              </span>
            </div>
          ))}
        </div>
      </Section>

      {audit.length > 0 ? (
        <Section title="Audit log" description="Every mutating API call, recorded server-side.">
          <div className="space-y-1">
            {audit.map((entry) => (
              <div
                key={entry.id}
                className="flex flex-wrap items-center gap-3 rounded-[var(--forge-radius)] border border-[var(--forge-border)] px-3 py-2 text-[12px]"
              >
                <Mono>{entry.action}</Mono>
                <span className="text-[var(--forge-text-muted)]">{entry.actorId}</span>
                <span className="ml-auto text-[var(--forge-text-subtle)]">
                  {new Date(entry.createdAt).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </Section>
      ) : null}
    </>
  );
}
