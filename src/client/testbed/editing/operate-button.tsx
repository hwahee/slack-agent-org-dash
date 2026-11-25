/**
 * A button that operates the testbed. While someone holds the control lease
 * it stays focusable but `aria-disabled="true"` and does nothing
 * (docs/testbed/dashboard.md §2). `useCanOperate()` alone decides that.
 * `disabled` is separate: the operation does not apply right now (a running
 * core's start), so the button is really disabled whoever holds the lease.
 */
import type { ReactNode } from 'react';

import { Button } from '../../ui/button';
import { useCanOperate } from '../store/hooks';

interface OperateButtonProps {
  onClick: () => void;
  testId: string;
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  loading?: boolean;
  /** The operation would do nothing in the current state. */
  disabled?: boolean;
  /** `false` for things the lease does not stop (read-only actions). */
  lockable?: boolean;
}

export function OperateButton({
  onClick,
  lockable = true,
  disabled = false,
  ...rest
}: OperateButtonProps) {
  const canOperate = useCanOperate();
  const blocked = lockable && !canOperate;
  return (
    <Button
      {...rest}
      aria-disabled={blocked || undefined}
      disabled={disabled || rest.loading}
      onClick={() => {
        if (!blocked) onClick();
      }}
    />
  );
}
