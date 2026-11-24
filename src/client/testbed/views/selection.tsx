/**
 * The event picked in the log or the agent timeline, shared with the detail
 * panel. `onSelect` lets the shell open the detail sheet on narrow screens.
 */
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

import type { TestbedEvent } from '@shared/testbed/events';

interface Selection {
  selected: TestbedEvent | null;
  select: (event: TestbedEvent) => void;
}

const SelectionContext = createContext<Selection | null>(null);

export function SelectionProvider({
  onSelect,
  children,
}: {
  onSelect?: (event: TestbedEvent) => void;
  children: ReactNode;
}) {
  const [selected, setSelected] = useState<TestbedEvent | null>(null);
  // Goes down through context, so its identity matters (CLAUDE.md).
  const value = useMemo(
    () => ({
      selected,
      select: (event: TestbedEvent) => {
        setSelected(event);
        onSelect?.(event);
      },
    }),
    [selected, onSelect],
  );
  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

export function useSelection(): Selection {
  const selection = useContext(SelectionContext);
  if (!selection) throw new Error('useSelection needs <SelectionProvider> above it.');
  return selection;
}
