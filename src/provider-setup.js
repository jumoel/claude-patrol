function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function providerSetup(config) {
  const resolver = config.work_items?.resolver;
  const providers = !resolver ? [] : resolver.provider ? [resolver.provider] : ['claude', 'codex'];
  const result = {
    claude: { model_login_command: 'claude auth login', resolver_mcp_commands: [] },
    codex: { model_login_command: 'codex login', resolver_mcp_commands: [] },
  };
  if (!resolver) return result;
  if (providers.includes('claude')) {
    result.claude.resolver_mcp_commands = [
      `claude mcp add --transport http --scope user ${resolver.server.name} ${shellQuote(resolver.server.url)}`,
      `claude mcp login ${resolver.server.name}`,
    ];
  }
  if (providers.includes('codex')) {
    result.codex.resolver_mcp_commands = [
      `codex mcp add ${resolver.server.name} --url ${shellQuote(resolver.server.url)}`,
      `codex mcp login ${resolver.server.name}`,
    ];
  }
  return result;
}
