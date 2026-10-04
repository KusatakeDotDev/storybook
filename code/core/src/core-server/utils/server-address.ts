import net from 'node:net';
import os from 'node:os';

import { SERVER_CHANNEL_PATH } from 'storybook/internal/channels';
import { logger } from 'storybook/internal/node-logger';
import { NoFreePortError } from 'storybook/internal/server-errors';

import detectFreePort from 'detect-port';

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

// detect-port never settles when given a hostname that nothing can be bound on.
const assertCanListenOn = (host: string) =>
  new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, host, () => server.close(() => resolve()));
  });

// Windows lets a bind on one address succeed while another process listens on the wildcard or
// the other loopback address, so a successful bind on the host alone does not prove the port free.
const isPortInUse = (port: number) =>
  Promise.all(
    ['127.0.0.1', '::1'].map(
      (address) =>
        new Promise<boolean>((resolve) => {
          const socket = net.connect({ port, host: address });
          socket.once('connect', () => {
            socket.destroy();
            resolve(true);
          });
          socket.once('error', () => resolve(false));
        })
    )
  ).then((results) => results.includes(true));

const findFreePort = async (port: number | undefined, host: string | undefined) => {
  let freePort = await detectFreePort({ port, hostname: host });
  while (host && freePort && (await isPortInUse(freePort))) {
    freePort = await detectFreePort({ port: freePort + 1, hostname: host });
  }
  return freePort;
};

export const getServerPort = async (port?: number, { exactPort, host }: PortOptions = {}) => {
  if (host) {
    await assertCanListenOn(host).catch((error: NodeJS.ErrnoException) => {
      throw new NoFreePortError({ requestedPort: port, host, code: error.code });
    });
  }

  return findFreePort(port, host)
    .catch((error) => {
      logger.error(error);
      process.exit(-1);
    })
    .then((freePort) => {
      // detect-port resolves `undefined` instead of rejecting when the environment refuses
      // every bind attempt, e.g. sandboxed shells that deny listening on network ports.
      // Throwing (instead of exiting) lets `storybook dev` report the error through telemetry
      // and lets `storybook init`, which probes for a port opportunistically, recover from it.
      if (!freePort) {
        throw new NoFreePortError({ requestedPort: port });
      }
      if (exactPort && port != null && freePort !== port) {
        logger.error(`Port ${port} is not available. Exiting because --exact-port was provided.`);
        process.exit(-1);
      }
      return freePort;
    });
};

export const getServerChannelUrl = (port: number, { https }: { https?: boolean }) => {
  return `${https ? 'wss' : 'ws'}://localhost:${port}${SERVER_CHANNEL_PATH}`;
};

const getLocalIp = () => {
  const allIps = Object.values(os.networkInterfaces()).flat();
  const allFilteredIps = allIps.filter((ip) => ip && ip.family === 'IPv4' && !ip.internal);

  return allFilteredIps.length ? allFilteredIps[0]?.address : '0.0.0.0';
};
