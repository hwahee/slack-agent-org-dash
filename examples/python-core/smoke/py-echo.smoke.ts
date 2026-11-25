import { defineSmoke } from '@server/testbed/smoke';

export default defineSmoke({
  name: 'py-echo',
  title: '복제마다 echo가 되고, broadcast와 disconnect 결함이 동작함 (Python 외부 코어)',
  spec: 'docs/spec.md §11 M13',
  requires: { cores: ['py-echo'] },
  async run(t) {
    await t.call('start_run', { label: 'smoke:py-echo' });
    const core = t.manifest.cores.find((entry) => entry.id === 'py-echo');
    const endpoints = (core?.endpoints ?? []).filter((endpoint) => endpoint.name === 'echo');
    const replicas = core?.replicas ?? 0;
    t.equal(endpoints.length, replicas, 'an echo endpoint per replica');

    const clients = [];
    for (const endpoint of endpoints) {
      const client = await t.tcp(endpoint.url);
      client.send('hello');
      t.equal(await client.receive(5), 'hello', `echo on ${endpoint.replica ?? '?'}`);
      clients.push(client);
    }
    await t.expectCheck({ kind: 'py-echo.data.echoed' }, { count: `==${replicas}` });
    const echoed = await t.call<{ events: { id: string }[] }>('query_events', {
      runId: 'current',
      kind: 'py-echo.data.echoed',
    });
    const seen: string[] = [];
    for (const line of echoed.events) {
      const event = await t.call<{ replica?: string }>('get_event', { id: line.id });
      seen.push(event.replica ?? '');
    }
    t.equal(
      seen.sort(),
      endpoints.map((endpoint) => endpoint.replica ?? '').sort(),
      'one py-echo.data.echoed per replica',
    );

    const sent = await t.call<Record<string, { sent: number }>>('py_echo_broadcast', {
      text: 'hi',
    });
    // One replica answers with its output, several with { r0: …, r1: … }.
    const outputs = replicas > 1 ? Object.values(sent) : [sent as unknown as { sent: number }];
    t.equal(
      outputs.reduce((sum, output) => sum + output.sent, 0),
      clients.length,
      'broadcast reached every connection',
    );
    for (const client of clients) t.equal(await client.receive(2), 'hi', 'broadcast text');

    await t.call('set_config', {
      core: 'py-echo',
      patch: { faults: [{ id: 'py-cut', disconnect: true, times: 1 }] },
    });
    const dropped = await t.tcp(endpoints[0]?.url ?? '');
    dropped.send('bye');
    await dropped.closed();
    await t.expectCheck({ kind: 'testbed.fault.injected' }, { count: '==1' });
    await t.call('set_config', { core: 'py-echo', patch: { faults: [] } });
    for (const client of clients) client.close();
    await t.call('end_run', {});
  },
});
