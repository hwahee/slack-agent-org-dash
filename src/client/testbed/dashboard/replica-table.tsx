/**
 * An external core's replicas on its card (docs/testbed/dashboard.md §1): one
 * row each with state, pid, restarts, the last ping and the endpoints. A row
 * opens to the replica's latest stderr lines (`GET /cores/:core/log?replica=`),
 * read again every few seconds while open.
 */
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';

import type { ReplicaStatus } from '@shared/testbed/core';

import { testbedApi } from '../../api/endpoints';
import { useI18n } from '../../i18n/locale-context';
import { TESTID } from '../../testing/testids';
import { Badge } from '../../ui/badge';
import { STATE_TONE } from './state-tone';

const LOG_REFRESH_MS = 2000;
const COLUMNS = 6;

function ReplicaLog({ core, replica }: { core: string; replica: string }) {
  const { t } = useI18n();
  const log = useQuery({
    queryKey: ['testbed', 'core-log', core, replica] as const,
    queryFn: () => testbedApi.coreLog(core, replica),
    refetchInterval: LOG_REFRESH_MS,
  });
  const lines = log.data?.replicas[0]?.lines;
  return (
    <pre
      className="tb-code tb-replicas__log"
      data-testid={TESTID.testbed.coreCardReplicaLog(core, replica)}
    >
      {lines === undefined
        ? t('common.loading')
        : lines.length === 0
          ? t('testbed.replicas.logEmpty')
          : lines.join('\n')}
    </pre>
  );
}

function ReplicaRow({ core, replica }: { core: string; replica: ReplicaStatus }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const logId = `tb-replica-log-${core}-${replica.id}`;
  return (
    <>
      <tr
        data-testid={TESTID.testbed.coreCardReplica(core, replica.id)}
        data-state={replica.state}
        data-restarts={replica.restarts}
      >
        <th scope="row">
          <button
            type="button"
            className="tb-replicas__toggle"
            aria-expanded={open}
            aria-controls={logId}
            aria-label={t('testbed.replicas.showLog', { replica: replica.id })}
            onClick={() => setOpen(!open)}
          >
            {open ? (
              <ChevronDown aria-hidden size="1em" />
            ) : (
              <ChevronRight aria-hidden size="1em" />
            )}
            {replica.id}
          </button>
        </th>
        <td>
          <Badge tone={STATE_TONE[replica.state]}>{replica.state}</Badge>
          {replica.detail === undefined ? null : <span className="muted"> {replica.detail}</span>}
        </td>
        <td>{replica.pid ?? '–'}</td>
        <td>{replica.restarts}</td>
        <td>{replica.lastPingMs === undefined ? '–' : `${replica.lastPingMs}ms`}</td>
        <td className="tb-replicas__endpoints">
          {replica.endpoints.map((endpoint) => endpoint.url).join(' ') || '–'}
        </td>
      </tr>
      {open && (
        <tr id={logId}>
          <td colSpan={COLUMNS}>
            <ReplicaLog core={core} replica={replica.id} />
          </td>
        </tr>
      )}
    </>
  );
}

export function ReplicaTable({ core, replicas }: { core: string; replicas: ReplicaStatus[] }) {
  const { t } = useI18n();
  return (
    <div className="tb-replicas">
      <table className="tb-table" data-testid={TESTID.testbed.coreCardReplicas(core)}>
        <caption>{t('testbed.replicas.title')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('testbed.replicas.id')}</th>
            <th scope="col">{t('testbed.replicas.state')}</th>
            <th scope="col">{t('testbed.replicas.pid')}</th>
            <th scope="col">{t('testbed.replicas.restarts')}</th>
            <th scope="col">{t('testbed.replicas.lastPing')}</th>
            <th scope="col">{t('testbed.replicas.endpoints')}</th>
          </tr>
        </thead>
        <tbody>
          {replicas.map((replica) => (
            <ReplicaRow key={replica.id} core={core} replica={replica} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
