/**
 * A payload as a tree: objects and arrays fold and unfold, each line carries
 * its path (`data-path="payload.lease.holder"`, `payload.items[0]`) for
 * automation, and values in the common masking format are marked "redacted".
 */
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';

import { useI18n } from '../../i18n/locale-context';
import { TESTID } from '../../testing/testids';
import { Badge } from '../../ui/badge';
import { isRedacted } from './event-display';

function childPath(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${key}]`;
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function Leaf({ value }: { value: unknown }) {
  const { t } = useI18n();
  if (isRedacted(value)) {
    return (
      <span className="tb-json__redacted" data-testid={TESTID.testbed.detail.redacted}>
        <code>{JSON.stringify(value)}</code>{' '}
        <Badge tone="warning">{t('testbed.detail.redacted')}</Badge>
      </span>
    );
  }
  return (
    <code className="tb-json__value" data-type={value === null ? 'null' : typeof value}>
      {JSON.stringify(value)}
    </code>
  );
}

function Node({
  name,
  value,
  path,
  depth,
}: {
  name: string;
  value: unknown;
  path: string;
  depth: number;
}) {
  const [open, setOpen] = useState(depth < 2);
  const branch = typeof value === 'object' && value !== null;
  const entries: [string | number, unknown][] = branch
    ? Array.isArray(value)
      ? value.map((item, index) => [index, item])
      : Object.entries(value)
    : [];
  return (
    <li className="tb-json__node">
      <div className="tb-json__line" data-path={path}>
        {branch ? (
          <button
            type="button"
            className="tb-json__toggle"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? (
              <ChevronDown aria-hidden size="1em" />
            ) : (
              <ChevronRight aria-hidden size="1em" />
            )}
            <span className="tb-json__key">{name}</span>
            <span className="muted">
              {Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}
            </span>
          </button>
        ) : (
          <>
            <span className="tb-json__key">{name}</span>
            <Leaf value={value} />
          </>
        )}
      </div>
      {branch && open && (
        <ul className="tb-json__children">
          {entries.map(([key, child]) => (
            <Node
              key={key}
              name={String(key)}
              value={child}
              path={childPath(path, key)}
              depth={depth + 1}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function JsonViewer({ value, root }: { value: unknown; root: string }) {
  return (
    <ul className="tb-json">
      <Node name={root} value={value} path={root} depth={0} />
    </ul>
  );
}
