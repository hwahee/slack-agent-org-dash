/**
 * A button that operates the testbed. While someone holds the control lease
 * it stays focusable but `aria-disabled="true"` and does nothing
 * (docs/testbed/dashboard.md §2). `useCanOperate()` alone decides.
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
  /** `false` for things the lease does not stop (read-only actions). */
  lockable?: boolean;
}

export function OperateButton({ onClick, lockable = true, ...rest }: OperateButtonProps) {
  const canOperate = useCanOperate();
  const blocked = lockable && !canOperate;
  return (
    <Button
      {...rest}
      aria-disabled={blocked || undefined}
      onClick={() => {
        if (!blocked) onClick();
      }}
    />
  );
}
