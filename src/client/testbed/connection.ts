/**
 * What the connection panel hands out for copying: where the product and the
 * agent connect (docs/testbed/dashboard.md §1). Every address is built on the
 * manifest's `publicUrl` (`TESTBED_PUBLIC_URL`).
 */
import type { TestbedManifest } from '@shared/testbed/control';
import type { CoreEndpoint } from '@shared/testbed/core';

/** The manifest fields the snippets use; `cores` may be the live status instead. */
type ManifestParts = Pick<TestbedManifest, 'name' | 'publicUrl' | 'control' | 'auth'> & {
  cores: readonly { id: string; endpoints: readonly CoreEndpoint[] }[];
};

/** `tb-<name without "testbed-">`, e.g. `testbed-llm` → `tb-llm`. */
export function mcpServerName(name: string): string {
  return `tb-${name.replace(/^testbed-/, '')}`;
}

/** The control-plane MCP URL. */
export function mcpUrl(manifest: Pick<TestbedManifest, 'publicUrl' | 'control'>): string {
  return new URL(manifest.control.mcp, manifest.publicUrl).href;
}

/** The `.mcp.json` snippet; with a control token, the Bearer header from the env. */
export function mcpJsonSnippet(manifest: ManifestParts): string {
  const server = {
    type: 'http',
    url: mcpUrl(manifest),
    ...(manifest.auth.control === 'bearer'
      ? { headers: { Authorization: 'Bearer ${TESTBED_CONTROL_TOKEN}' } }
      : {}),
  };
  return JSON.stringify({ mcpServers: { [mcpServerName(manifest.name)]: server } }, null, 2);
}

/**
 * The block for the product repository's CLAUDE.md. Only the frame for now:
 * what each testbed adds in its own words is not in the manifest yet.
 */
export function claudeMdSnippet(manifest: ManifestParts): string {
  const server = mcpServerName(manifest.name);
  const endpoints = manifest.cores.flatMap((core) =>
    core.endpoints.map((endpoint) => `- ${core.id} ${endpoint.name}: ${endpoint.url}`),
  );
  return [
    `## 테스트베드: ${manifest.name}`,
    '',
    `제품을 이 테스트베드에 붙여 시험합니다. 제어는 MCP 서버 \`${server}\`(${mcpUrl(manifest)})로 합니다.`,
    '',
    '기본 흐름: `testbed_info` → `start_run` → 제품 작업 → `check` → `end_run` → `release_control`',
    '',
    '데이터면 주소:',
    ...(endpoints.length > 0 ? endpoints : ['- (없음)']),
    '',
  ].join('\n');
}
