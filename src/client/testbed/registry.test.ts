import { describe, expect, test } from 'bun:test';

import { COMMON_TABS, dashboardTabs, type ClientCoreModule } from './registry';

describe('dashboardTabs', () => {
  test('the common tabs alone when no core registers panels', () => {
    expect(dashboardTabs([]).map((tab) => tab.id)).toEqual(['events', 'stats', 'runs', 'agent']);
  });

  test('a registered core panel appears after the common tabs, as <core>.<panel>', () => {
    const Panel = () => null;
    const fake: ClientCoreModule = {
      core: 'fake',
      panels: [{ id: 'traffic', title: 'testbed.tab.stats', component: Panel }],
    };
    const tabs = dashboardTabs([fake, { core: 'plain' }]);
    expect(tabs.map((tab) => tab.id)).toEqual([
      ...COMMON_TABS.map((tab) => tab.id),
      'fake.traffic',
    ]);
    expect(tabs.at(-1)?.component).toBe(Panel);
  });
});
