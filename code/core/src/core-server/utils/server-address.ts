import net from 'node:net';
import os from 'node:os';

import { SERVER_CHANNEL_PATH } from 'storybook/internal/channels';
import { logger } from 'storybook/internal/node-logger';
import { NoFreePortError, UnavailableHostError } from 'storybook/internal/server-errors';

export function getServerAddresses(
  port: number,
  host: string | undefined,
  proto: string,
  initialPath?: string
) {
  const address = new URL(`${proto}://localhost:${port}/`);
  const networkAddress = new URL(`${proto}://${host || getLocalIp()}:${port}/`);

  if (initialPath) {
    const searchParams = `?path=${decodeURIComponent(
      initialPath.startsWith('/') ? initialPath : `/${initialPath}`
    )}`;
    address.search = searchParams;
    networkAddress.search = searchParams;
  }

  return {
    address: address.href,
    networkAddress: networkAddress.href,
  };
}

interface PortOptions {
  exactPort?: boolean;
  host?: string;
}

const bindPort = (port: number, host: string | undefined) =>
  new Promise<number | undefined>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (error: NodeJS.ErrnoException) =>
      // Privileged ports and the port ranges Windows reserves fail with EACCES.
      error.code === 'EADDRINUSE' || error.code === 'EACCES' ? resolve(undefined) : reject(error)
    );
    server.listen(port, host, () => {
      const { port: boundPort } = server.address() as net.AddressInfo;
      server.close(() => resolve(boundPort));
    });
  });

const answers = (port: number, host: string) =>
  new Promise<boolean>((resolve) => {
    const socket = net.connect({ port, host, timeout: 250 });
    const settle = (served: boolean) => {
      socket.destroy();
      resolve(served);
    };
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });

// A bind succeeds next to another process serving the port on a different address (::1 beside
// 127.0.0.1, and any address on Windows), so also check the addresses Storybook prints.
// Connecting to the network address is refused only after ~2s on Windows, so bind it instead.
const tryPort = async (port: number, host: string | undefined) => {
  const boundPort = await bindPort(port, host);
  if (boundPort === undefined) {
    return undefined;
  }
  const isWildcard = !host || host === '0.0.0.0' || host === '::';
  if (isWildcard && (await bindPort(boundPort, getLocalIp())) === undefined) {
    return undefined;
  }
  const loopback = await Promise.all([answers(boundPort, '127.0.0.1'), answers(boundPort, '::1')]);
  return loopback.includes(true) ? undefined : boundPort;
};

export const getServerPort = async (port?: number, { exactPort, host }: PortOptions = {}) => {
  const candidates = !port
    ? []
    : exactPort
      ? [port]
      : Array.from({ length: Math.min(10, 65536 - port) }, (_, offset) => port + offset);

  try {
    for (const candidate of candidates) {
      const freePort = await tryPort(candidate, host);
      if (freePort) {
        return freePort;
      }
    }
    if (exactPort && port) {
      logger.error(`Port ${port} is not available. Exiting because --exact-port was provided.`);
      process.exit(-1);
    }
    const freePort = await tryPort(0, host);
    if (freePort) {
      return freePort;
    }
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (host && (code === 'EADDRNOTAVAIL' || code === 'ENOTFOUND')) {
      throw new UnavailableHostError({ host, code });
    }
    throw new NoFreePortError({ requestedPort: port, code });
  }
  throw new NoFreePortError({ requestedPort: port });
};

export const getServerChannelUrl = (port: number, { https }: { https?: boolean }) => {
  return `${https ? 'wss' : 'ws'}://localhost:${port}${SERVER_CHANNEL_PATH}`;
};

const getLocalIp = () => {
  const allIps = Object.values(os.networkInterfaces()).flat();
  const allFilteredIps = allIps.filter((ip) => ip && ip.family === 'IPv4' && !ip.internal);

  return allFilteredIps.length ? allFilteredIps[0]?.address : '0.0.0.0';
};
