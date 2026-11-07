/** Higher precedence wins; credential layers always apply last. */
export interface EnvLayer {

  name: string;
  /** Higher overrides lower (among non-sensitive layers). */
  precedence: number;
  vars: Record<string, string | undefined>;
  /** Credential material: always wins. */
  sensitive?: boolean;
}

/**
 * Merge `base` (e.g. process.env) with the given layers. Non-sensitive layers
 * apply in ascending precedence; sensitive layers apply last (so a misconfigured
 * lower layer can never shadow a voucher path or protected key). `undefined`
 * values are skipped (lets a layer "not set" a key without clobbering).
 */
export function mergeEnvLayers(base: NodeJS.ProcessEnv, layers: EnvLayer[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };

  const ordered = [
    ...layers.filter((l) => !l.sensitive).sort((a, b) => a.precedence - b.precedence),
    ...layers.filter((l) => l.sensitive).sort((a, b) => a.precedence - b.precedence),
  ];

  for (const layer of ordered) {
    for (const [k, v] of Object.entries(layer.vars)) {
      if (v === undefined) continue;
      env[k] = v;
    }
  }

  return env;
}
