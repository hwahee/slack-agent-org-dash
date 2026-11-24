import { describe, expect, test } from 'bun:test';

import { claudeMdSnippet, mcpJsonSnippet, mcpServerName } from './connection';

const manifest = {
  name: 'testbed-llm',
  publicUrl: 'http://testbed.example:40100',
  control: { rest: '/testbed/api', mcp: '/testbed/mcp', ws: '/testbed/ws' },
  cores: [
    {
      id: 'llm',
      endpoints: [{ name: 'openai', protocol: 'http', url: 'http://testbed.example:40101' }],
    },
  ],
};

describe('.mcp.json snippet', () => {
  test('without a control token: just the URL under publicUrl', () => {
    expect(JSON.parse(mcpJsonSnippet({ ...manifest, auth: { control: 'none' } }))).toEqual({
      mcpServers: {
        'tb-llm': { type: 'http', url: 'http://testbed.example:40100/testbed/mcp' },
      },
    });
  });

  test('with a control token: the Bearer header reads it from the env', () => {
    expect(JSON.parse(mcpJsonSnippet({ ...manifest, auth: { control: 'bearer' } }))).toEqual({
      mcpServers: {
        'tb-llm': {
          type: 'http',
          url: 'http://testbed.example:40100/testbed/mcp',
          headers: { Authorization: 'Bearer ${TESTBED_CONTROL_TOKEN}' },
        },
      },
    });
  });

  test('the server name drops a leading "testbed-"', () => {
    expect(mcpServerName('testbed-base')).toBe('tb-base');
    expect(mcpServerName('echo')).toBe('tb-echo');
  });
});

describe('CLAUDE.md snippet', () => {
  test('names the MCP server, the basic flow and every data-plane address', () => {
    const text = claudeMdSnippet({ ...manifest, auth: { control: 'none' } });
    expect(text).toContain('`tb-llm`');
    expect(text).toContain('http://testbed.example:40100/testbed/mcp');
    expect(text).toContain(
      '`testbed_info` → `start_run` → 제품 작업 → `check` → `end_run` → `release_control`',
    );
    expect(text).toContain('- llm openai: http://testbed.example:40101');
  });
});
