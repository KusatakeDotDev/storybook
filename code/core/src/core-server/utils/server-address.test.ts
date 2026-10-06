import { EventEmitter } from 'node:events';
import net from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { logger } from 'storybook/internal/node-logger';

import { getServerAddresses, getServerChannelUrl, getServerPort } from './server-address.ts';

vi.mock('node:os', () => ({
  default: {
    release: () => '',
    networkInterfaces: () => ({
      eth0: [{ address: '192.168.0.10', family: 'IPv4', internal: false }],
    }),
  },
  platform: 'darwin',
  constants: {
    signals: {},
  },
}));
vi.mock('storybook/internal/node-logger');

const OS_PICKED_PORT = 61000;

const errorWithCode = (code: string) => Object.assign(new Error(code), { code });

const fakeNetwork = ({
  taken = {},
  serving = {},
  unresponsive = [],
  bindError,
}: {
  taken?: Record<string, number[]>;
  serving?: Record<string, number[]>;
  unresponsive?: string[];
  bindError?: string;
} = {}) => {
  const listen = vi.fn();

  vi.spyOn(net, 'createServer').mockImplementation((() => {
    let boundPort = 0;
    const server = Object.assign(new EventEmitter(), {
      listen: (port: number, host: string | undefined, onListening: () => void) => {
        listen(port, host);
        const code = bindError ?? (taken[host ?? '::']?.includes(port) ? 'EADDRINUSE' : undefined);
        boundPort = port || OS_PICKED_PORT;
        process.nextTick(() => (code ? server.emit('error', errorWithCode(code)) : onListening()));
        return server;
      },
      address: () => ({ port: boundPort }),
      close: (onClose: () => void) => onClose(),
    });
    return server;
  }) as unknown as typeof net.createServer);

  vi.spyOn(net, 'connect').mockImplementation(((options: net.TcpNetConnectOpts) => {
    const socket = Object.assign(new EventEmitter(), { destroy: () => socket });
    const host = options.host ?? '';
    process.nextTick(() => {
      if (unresponsive.includes(host)) {
        socket.emit('timeout');
      } else if (serving[host]?.includes(options.port)) {
        socket.emit('connect');
      } else {
        socket.emit('error', errorWithCode('ECONNREFUSED'));
      }
    });
    return socket;
  }) as unknown as typeof net.connect);

  return { listen };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getServerAddresses', () => {
  const port = 3000;
  const host = 'localhost';
  const proto = 'http';

  it('should return server addresses without initial path by default', () => {
    const expectedAddress = `${proto}://localhost:${port}/`;
    const expectedNetworkAddress = `${proto}://${host}:${port}/`;

    const result = getServerAddresses(port, host, proto);

    expect(result.address).toBe(expectedAddress);
    expect(result.networkAddress).toBe(expectedNetworkAddress);
  });

  it('should return server addresses with initial path', () => {
    const initialPath = '/foo/bar';

    const expectedAddress = `${proto}://localhost:${port}/?path=/foo/bar`;
    const expectedNetworkAddress = `${proto}://${host}:${port}/?path=/foo/bar`;

    const result = getServerAddresses(port, host, proto, initialPath);

    expect(result.address).toBe(expectedAddress);
    expect(result.networkAddress).toBe(expectedNetworkAddress);
  });

  it('should return server addresses with initial path and add slash if missing', () => {
    const initialPath = 'foo/bar';

    const expectedAddress = `${proto}://localhost:${port}/?path=/foo/bar`;
    const expectedNetworkAddress = `${proto}://${host}:${port}/?path=/foo/bar`;

    const result = getServerAddresses(port, host, proto, initialPath);

    expect(result.address).toBe(expectedAddress);
    expect(result.networkAddress).toBe(expectedNetworkAddress);
  });
});

describe('getServerPort', () => {
  const port = 3000;

  it('should resolve with the requested port when it is free', async () => {
    fakeNetwork();

    expect(await getServerPort(port)).toBe(port);
  });

  it('should move to the next port when the requested port is taken', async () => {
    fakeNetwork({ taken: { '::': [port] } });

    expect(await getServerPort(port)).toBe(port + 1);
  });

  it.each([
    { host: undefined, address: '127.0.0.1' },
    { host: '127.0.0.1', address: '::1' },
  ])(
    'should skip a port another process serves on $address when the host is $host',
    async ({ host, address }) => {
      fakeNetwork({ serving: { [address]: [port] } });

      expect(await getServerPort(port, { host })).toBe(port + 1);
    }
  );

  it('should skip a port another process holds on the network address when listening on every address', async () => {
    fakeNetwork({ taken: { '192.168.0.10': [port] } });

    expect(await getServerPort(port, { host: '0.0.0.0' })).toBe(port + 1);
  });

  it('should listen on the given host only', async () => {
    const { listen } = fakeNetwork();

    await getServerPort(port, { host: '127.0.0.1' });

    expect(new Set(listen.mock.calls.map(([, host]) => host))).toEqual(new Set(['127.0.0.1']));
  });

  it('should treat a localhost address that never answers as free', async () => {
    fakeNetwork({ unresponsive: ['::1'] });

    expect(await getServerPort(port)).toBe(port);
  });

  it('should let the OS pick a port when the next ten ports are taken', async () => {
    fakeNetwork({ taken: { '::': Array.from({ length: 10 }, (_, offset) => port + offset) } });

    expect(await getServerPort(port)).toBe(OS_PICKED_PORT);
  });

  it('should not look past port 65535', async () => {
    const { listen } = fakeNetwork({ taken: { '::': [65535] } });

    expect(await getServerPort(65535)).toBe(OS_PICKED_PORT);
    expect(listen).not.toHaveBeenCalledWith(65536, undefined);
  });

  it('should reject with an actionable error when the host is not an address of this machine', async () => {
    fakeNetwork({ bindError: 'EADDRNOTAVAIL' });

    await expect(getServerPort(port, { host: '192.0.2.1' })).rejects.toThrow(
      "Storybook's dev server cannot listen on 192.0.2.1 (EADDRNOTAVAIL)"
    );
  });

  it('should reject with an actionable error when the environment refuses to listen', async () => {
    fakeNetwork({ bindError: 'EPERM' });

    await expect(getServerPort(port)).rejects.toThrow(
      'Your environment appears to block Storybook from listening on network ports (EPERM)'
    );
  });

  it('should log an error and exit when the port is taken and exactPort is set', async () => {
    fakeNetwork({ taken: { '::': [port] } });
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await getServerPort(port, { exactPort: true });

    expect(logger.error).toHaveBeenCalledWith(
      `Port ${port} is not available. Exiting because --exact-port was provided.`
    );
    expect(exit).toHaveBeenCalledWith(-1);
  });

  it('should not exit for exactPort when no port was requested', async () => {
    fakeNetwork();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    expect(await getServerPort(undefined, { exactPort: true })).toBe(OS_PICKED_PORT);
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('getServerChannelUrl', () => {
  const port = 3000;
  it('should return WebSocket URL with HTTP', () => {
    const options = { https: false };
    const expectedUrl = `ws://localhost:${port}/storybook-server-channel`;

    const result = getServerChannelUrl(port, options);

    expect(result).toBe(expectedUrl);
  });

  it('should return WebSocket URL with HTTPS', () => {
    const options = { https: true };
    const expectedUrl = `wss://localhost:${port}/storybook-server-channel`;

    const result = getServerChannelUrl(port, options);

    expect(result).toBe(expectedUrl);
  });
});
