/**
 * Where things connect (docs/testbed/dashboard.md §1): each data-plane
 * address, the control-plane MCP URL, the `.mcp.json` snippet and the
 * CLAUDE.md block for the product repository. The addresses and the two
 * snippets have a copy button; the MCP URL is inside `.mcp.json` already.
 */
import type { TestbedManifest, TestbedStatus } from '@shared/testbed/control';

import { useI18n } from '../../i18n/locale-context';
import { TESTID } from '../../testing/testids';
import { claudeMdSnippet, mcpJsonSnippet, mcpUrl } from '../connection';
import { CopyButton } from './copy-button';

export function ConnectionPanel({
  manifest,
  status,
}: {
  manifest: TestbedManifest;
  status: TestbedStatus | null;
}) {
  const { t } = useI18n();
  // Live addresses: a core restarted on port 0 has a new one.
  const cores = status?.cores ?? manifest.cores;
  const live = { ...manifest, cores };
  const mcp = mcpUrl(manifest);
  const mcpJson = mcpJsonSnippet(live);
  const claudeMd = claudeMdSnippet(live);

  return (
    <section
      className="tb-panel"
      aria-labelledby="tb-connection-title"
      data-testid={TESTID.testbed.connection.root}
    >
      <h2 id="tb-connection-title" className="tb-panel__title">
        {t('testbed.connection.title')}
      </h2>

      <h3 className="tb-panel__subtitle">{t('testbed.connection.dataPlane')}</h3>
      <ul className="tb-connection__list">
        {cores.flatMap((core) =>
          core.endpoints.map((endpoint) => (
            <li key={`${core.id}/${endpoint.name}`} className="tb-connection__row">
              <span className="muted">
                {core.id} · {endpoint.name}
              </span>
              <code data-testid={TESTID.testbed.connection.endpoint(core.id, endpoint.name)}>
                {endpoint.url}
              </code>
              <CopyButton
                text={endpoint.url}
                label={`${core.id} ${endpoint.name}`}
                testId={TESTID.testbed.connection.copyEndpoint(core.id, endpoint.name)}
              />
            </li>
          )),
        )}
      </ul>

      <h3 className="tb-panel__subtitle">{t('testbed.connection.mcpUrl')}</h3>
      <div className="tb-connection__row">
        <code data-testid={TESTID.testbed.connection.mcpUrl}>{mcp}</code>
      </div>

      <div className="tb-connection__snippet-head">
        <h3 className="tb-panel__subtitle">{t('testbed.connection.mcpJson')}</h3>
        <CopyButton
          text={mcpJson}
          label={t('testbed.connection.mcpJson')}
          testId={TESTID.testbed.connection.copyMcpJson}
        />
      </div>
      <pre className="tb-code">{mcpJson}</pre>

      <div className="tb-connection__snippet-head">
        <h3 className="tb-panel__subtitle">{t('testbed.connection.claudeMd')}</h3>
        <CopyButton
          text={claudeMd}
          label={t('testbed.connection.claudeMd')}
          testId={TESTID.testbed.connection.copyClaudeMd}
        />
      </div>
      <pre className="tb-code">{claudeMd}</pre>
    </section>
  );
}
