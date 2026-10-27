export function withoutNpmExecPackage(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => key.toLowerCase() !== "npm_config_package"),
  );
}
