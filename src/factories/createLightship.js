// @flow

// eslint-disable-next-line fp/no-events
import EventEmitter from 'events';
import delay from 'delay';
import express from 'express';
import {
  serializeError,
} from 'serialize-error';
import Logger from '../Logger';
import type {
  ConfigurationInputType,
  ConfigurationType,
  LightshipType,
  ShutdownHandlerType,
} from '../types';
import {
  SERVER_IS_NOT_READY,
  SERVER_IS_NOT_SHUTTING_DOWN,
  SERVER_IS_READY,
  SERVER_IS_SHUTTING_DOWN,
} from '../states';
import {
  isKubernetes,
} from '../utilities';

const log = Logger.child({
  namespace: 'factories/createLightship',
});

const defaultConfiguration = {
  detectKubernetes: true,
  port: 9000,
  signals: [
    'SIGTERM',
    'SIGHUP',
    'SIGINT',
  ],
  timeout: 60000,
};

export default (userConfiguration?: ConfigurationInputType): LightshipType => {
  const eventEmitter = new EventEmitter();

  const beacons = [];

  const shutdownHandlers: Array<ShutdownHandlerType> = [];

  const configuration: ConfigurationType = {
    ...defaultConfiguration,
    ...userConfiguration,
  };

  let serverIsReady = false;
  let serverIsShuttingDown = false;

  const app = express();

  const modeIsLocal = configuration.detectKubernetes === true && isKubernetes() === false;

  const server = app.listen(modeIsLocal ? undefined : configuration.port, () => {
    log.info('Lightship HTTP service is running on port %s', server.address().port);
  });

  app.get('/health', (request, response) => {
    if (serverIsShuttingDown) {
      response.status(500).send(SERVER_IS_SHUTTING_DOWN);
    } else if (serverIsReady) {
      response.send(SERVER_IS_READY);
    } else {
      response.status(500).send(SERVER_IS_NOT_READY);
    }
  });

  app.get('/live', (request, response) => {
    if (serverIsShuttingDown) {
      response.status(500).send(SERVER_IS_SHUTTING_DOWN);
    } else {
      response.send(SERVER_IS_NOT_SHUTTING_DOWN);
    }
  });

  app.get('/ready', (request, response) => {
    if (serverIsReady) {
      response.send(SERVER_IS_READY);
    } else {
      response.status(500).send(SERVER_IS_NOT_READY);
    }
  });

  const signalNotReady = () => {
    if (serverIsShuttingDown) {
      log.warn('server is already shutting down');

      return;
    }

    if (serverIsReady === false) {
      log.warn('server is already in a SERVER_IS_NOT_READY state');
    }

    log.info('signaling that the server is not ready to accept connections');

    serverIsReady = false;
  };

  const signalReady = () => {
    if (serverIsShuttingDown) {
      log.warn('server is already shutting down');

      return;
    }

    log.info('signaling that the server is ready');

    serverIsReady = true;
  };

  const shutdown = async () => {
    if (serverIsShuttingDown) {
      log.warn('server is already shutting down');

      return;
    }

    log.info('received request to shutdown the service');

    if (configuration.timeout !== Infinity) {
      const timeoutId = setTimeout(() => {
        log.warn('timeout occurred before all the shutdown handlers could run to completion; forcing termination');

        // eslint-disable-next-line no-process-exit
        process.exit(1);
      }, configuration.timeout);

      // $FlowFixMe
      timeoutId.unref();
    }

    // @see https://github.com/gajus/lightship/issues/12
    serverIsReady = true;
    serverIsShuttingDown = true;

    if (beacons.length) {
      await new Promise((resolve) => {
        const check = () => {
          if (beacons.length > 0) {
            log.info({
              beacons,
            }, 'program termination is on hold because there are live beacons');
          } else {
            resolve();
          }
        };

        eventEmitter.on('beaconStateChange', () => {
          check();
        });

        check();
      });
    }

    for (const shutdownHandler of shutdownHandlers) {
      try {
        await shutdownHandler();
      } catch (error) {
        log.error({
          error: serializeError(error),
        }, 'shutdown handler produced an error');
      }
    }

    log.debug('all shutdown handlers have run to completion; proceeding to terminate the Node.js process');

    server.close((error) => {
      if (error) {
        log.error({
          error: serializeError(error),
        }, 'server was terminated with an error');
      }

      const timeoutId = setTimeout(() => {
        log.warn('process did not exit on its own; investigate what is keeping the event loop active');

        // eslint-disable-next-line no-process-exit
        process.exit(1);
      }, 1000);

      // $FlowFixMe
      timeoutId.unref();
    });
  };

  if (modeIsLocal) {
    log.warn('shutdown handlers are not used in the local mode');
  } else {
    for (const signal of configuration.signals) {
      process.on(signal, () => {
        log.debug({
          signal,
        }, 'received a shutdown signal');

        shutdown();
      });
    }
  }

  const createBeacon = (context) => {
    const beacon = {
      context: context || {},
    };

    beacons.push(beacon);

    return {
      die: async () => {
        log.trace({
          beacon,
        }, 'beacon has been killed');

        beacons.splice(beacons.indexOf(beacon), 1);

        eventEmitter.emit('beaconStateChange');

        await delay(0);
      },
    };
  };

  return {
    createBeacon,
    isServerReady: () => {
      return serverIsReady;
    },
    isServerShuttingDown: () => {
      return serverIsShuttingDown;
    },
    registerShutdownHandler: (shutdownHandler) => {
      shutdownHandlers.push(shutdownHandler);
    },
    server,
    shutdown,
    signalNotReady,
    signalReady,
  };
};
