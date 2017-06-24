import EventEmitter from 'events';
import Promise from 'bluebird';
import config from '../config';
import methods from './methods';
import {camelCase} from '../util';
import {hash} from '../auth/ecc';
import {ops} from '../auth/serializer';
import transports from './transports';

class Steem extends EventEmitter {
  constructor(options = {}) {
    super(options);
    this._setTransport(options);
    this.options = options;
  }

  _setTransport(options) {
    if (options.transport) {
      if (this.transport && this._transportType !== options.transport) {
        this.transport.stop();
      }

      this._transportType = options.transport;

      if (typeof options.transport === 'string') {
        if (!transports[options.transport]) {
          throw new TypeError(
            'Invalid `transport`, valid values are `http`, `ws` or a class',
          );
        }
        this.transport = new transports[options.transport](options);
      } else {
        this.transport = new options.transport(options);
      }
    } else {
      this.transport = new transports.ws(options);
    }
  }

  start() {
    return this.transport.start();
  }

  stop() {
    return this.transport.stop();
  }

  send(api, data, callback) {
    return this.transport.send(api, data, callback);
  }

  setOptions(options) {
    Object.assign(this.options, options);
    this._setTransport(this.options);
    this.transport.setOptions(this.options);
  }

  setWebSocket(url) {
    this.setOptions({websocket: url});
  }

  setUri(url) {
    this.setOptions({uri: url});
  }

  streamBlockNumber(mode = 'head', callback, ts = 200) {
    if (typeof mode === 'function') {
      callback = mode;
      mode = 'head';
    }
    let current = '';
    let running = true;

    const update = () => {
      if (!running) return;

      this.getDynamicGlobalPropertiesAsync().then(
        result => {
          const blockId = mode === 'irreversible'
            ? result.last_irreversible_block_num
            : result.head_block_number;

          if (blockId !== current) {
            if (current) {
              for (let i = current; i < blockId; i++) {
                if (i !== current) {
                  callback(null, i);
                }
                current = i;
              }
            } else {
              current = blockId;
              callback(null, blockId);
            }
          }

          Promise.delay(ts).then(() => {
            update();
          });
        },
        err => {
          callback(err);
        },
      );
    };

    update();

    return () => {
      running = false;
    };
  }

  streamBlock(mode = 'head', callback) {
    if (typeof mode === 'function') {
      callback = mode;
      mode = 'head';
    }

    let current = '';
    let last = '';

    const release = this.streamBlockNumber(mode, (err, id) => {
      if (err) {
        release();
        callback(err);
        return;
      }

      current = id;
      if (current !== last) {
        last = current;
        this.getBlock(current, callback);
      }
    });

    return release;
  }

  streamTransactions(mode = 'head', callback) {
    if (typeof mode === 'function') {
      callback = mode;
      mode = 'head';
    }

    const release = this.streamBlock(mode, (err, result) => {
      if (err) {
        release();
        callback(err);
        return;
      }

      if (result && result.transactions) {
        result.transactions.forEach(transaction => {
          callback(null, transaction);
        });
      }
    });

    return release;
  }

  streamOperations(mode = 'head', callback) {
    if (typeof mode === 'function') {
      callback = mode;
      mode = 'head';
    }

    const release = this.streamTransactions(mode, (err, transaction) => {
      if (err) {
        release();
        callback(err);
        return;
      }

      transaction.operations.forEach(operation => {
        callback(null, operation);
      });
    });

    return release;
  }
}

// Generate Methods from methods.json
methods.forEach(method => {
  const methodName = method.method_name || camelCase(method.method);
  const methodParams = method.params || [];

  Steem.prototype[`${methodName}With`] = function Steem$$specializedSendWith(
    options,
    callback,
  ) {
    const params = methodParams.map(param => options[param]);
    return this.send(
      method.api,
      {
        method: method.method,
        params,
      },
      callback,
    );
  };

  Steem.prototype[methodName] = function Steem$specializedSend(...args) {
    const options = methodParams.reduce((memo, param, i) => {
      memo[param] = args[i]; // eslint-disable-line no-param-reassign
      return memo;
    }, {});
    const callback = args[methodParams.length];
    return this[`${methodName}With`](options, callback);
  };
});

/*
 Wrap transaction broadcast: serializes the object and adds error reporting
 */
Steem.prototype.broadcastTransactionSynchronousWith = function Steem$$specializedSendWith(
  options,
  callback,
) {
  const trx = options.trx;
  return this.send(
    'network_broadcast_api',
    {
      method: 'broadcast_transaction_synchronous',
      params: [trx],
    },
    (err, result) => {
      if (err) {
        const {signed_transaction} = ops;
        // console.log('-- broadcastTransactionSynchronous -->', JSON.stringify(signed_transaction.toObject(trx), null, 2));
        // toObject converts objects into serializable types
        const trObject = signed_transaction.toObject(trx);
        const buf = signed_transaction.toBuffer(trx);
        err.digest = hash.sha256(buf).toString('hex');
        err.transaction_id = buf.toString('hex');
        err.transaction = JSON.stringify(trObject);
        callback(err, '');
      } else {
        callback('', result);
      }
    },
  );
};

delete Steem.prototype.broadcastTransaction; // not supported
delete Steem.prototype.broadcastTransactionWithCallback; // not supported

Promise.promisifyAll(Steem.prototype);

// Export singleton instance
const steem = new Steem(config);
exports = module.exports = steem;
exports.Steem = Steem;
