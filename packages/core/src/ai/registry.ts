import { createLocalProvider, LOCAL_MODEL } from './local.js';
import { createOpenRouterProvider } from './openrouter.js';
import { notFound } from '../kernel/errors.js';
import type { AIProvider, ModelInfo } from './types.js';

/**
 * The model registry.
 *
 * Resolution is by model id, not by provider, so a caller asks for
 * `anthropic/claude-sonnet-4` or `forge-local` and the registry finds the
 * provider that serves it. The local provider is always registered first and
 * is always the fallback default, which is what guarantees the product works
 * with an empty environment.
 */
export class ModelRegistry {
  private readonly providers = new Map<string, AIProvider>();
  private catalogue: ModelInfo[] = [];
  private catalogueLoaded = false;

  constructor(private defaultModelId: string = LOCAL_MODEL.id) {}

  register(provider: AIProvider): this {
    this.providers.set(provider.id, provider);
    this.catalogueLoaded = false;
    return this;
  }

  has(providerId: string): boolean {
    return this.providers.has(providerId);
  }

  get providerIds(): string[] {
    return [...this.providers.keys()];
  }

  async models(): Promise<readonly ModelInfo[]> {
    if (this.catalogueLoaded) return this.catalogue;

    const collected: ModelInfo[] = [];
    for (const provider of this.providers.values()) {
      try {
        collected.push(...(await provider.models()));
      } catch {
        // A provider whose catalogue cannot be fetched (expired key, network
        // failure) must not prevent the rest of the registry from working.
      }
    }

    this.catalogue = collected;
    this.catalogueLoaded = true;
    return collected;
  }

  async resolve(modelId: string): Promise<{ provider: AIProvider; model: ModelInfo }> {
    const models = await this.models();
    const model = models.find((candidate) => candidate.id === modelId);
    if (!model) throw notFound('model', modelId);

    const provider = this.providers.get(model.provider);
    if (!provider) throw notFound('provider', model.provider);

    return { provider, model };
  }

  get defaultModel(): string {
    return this.defaultModelId;
  }

  setDefaultModel(modelId: string): void {
    this.defaultModelId = modelId;
  }
}

export interface RegistryEnvironment {
  readonly OPENROUTER_API_KEY?: string | undefined;
  readonly OPENROUTER_BASE_URL?: string | undefined;
  readonly FORGEOS_DEFAULT_MODEL?: string | undefined;
  readonly NEXT_PUBLIC_FORGEOS_URL?: string | undefined;
}

/**
 * Build a registry from the environment.
 *
 * The local provider is unconditional. Hosted providers are added only when
 * their credentials are present, and the default model only moves off
 * `forge-local` if the operator asked for that explicitly — no silent spending.
 */
export function createRegistry(env: RegistryEnvironment = {}): ModelRegistry {
  const registry = new ModelRegistry(env.FORGEOS_DEFAULT_MODEL || LOCAL_MODEL.id);
  registry.register(createLocalProvider());

  if (env.OPENROUTER_API_KEY) {
    registry.register(
      createOpenRouterProvider({
        apiKey: env.OPENROUTER_API_KEY,
        ...(env.OPENROUTER_BASE_URL ? { baseUrl: env.OPENROUTER_BASE_URL } : {}),
        ...(env.NEXT_PUBLIC_FORGEOS_URL ? { appUrl: env.NEXT_PUBLIC_FORGEOS_URL } : {}),
        appName: 'ForgeOS',
      })
    );
  }

  return registry;
}

/** Models grouped for a picker, cheapest first within each provider. */
export function groupModelsForPicker(
  models: readonly ModelInfo[]
): { provider: string; models: ModelInfo[] }[] {
  const groups = new Map<string, ModelInfo[]>();
  for (const model of models) {
    const bucket = groups.get(model.provider) ?? [];
    bucket.push(model);
    groups.set(model.provider, bucket);
  }
  return [...groups.entries()]
    .map(([provider, list]) => ({
      provider,
      models: list.sort(
        (a, b) =>
          Number(b.local) - Number(a.local) ||
          a.inputCostPerMillion - b.inputCostPerMillion ||
          a.name.localeCompare(b.name)
      ),
    }))
    .sort((a, b) => (a.provider === 'forgeos' ? -1 : b.provider === 'forgeos' ? 1 : 0));
}
