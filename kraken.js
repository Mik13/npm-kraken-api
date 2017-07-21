const request = require('request');
const crypto = require('crypto');
const querystring = require('qs');
const Bluebird = require('bluebird');

const AVAILABLE_METHODS = {
	public: ['Time', 'Assets', 'AssetPairs', 'Ticker', 'Depth', 'Trades', 'Spread', 'OHLC'],
	private: ['Balance', 'TradeBalance', 'OpenOrders', 'ClosedOrders', 'QueryOrders', 'TradesHistory', 'QueryTrades', 'OpenPositions', 'Ledgers', 'QueryLedgers', 'TradeVolume', 'AddOrder', 'CancelOrder', 'DepositMethods', 'DepositAddresses', 'DepositStatus', 'WithdrawInfo', 'Withdraw', 'WithdrawStatus', 'WithdrawCancel']
};

module.exports = class KrakenClient {
	/**
	 * KrakenClient connects to the Kraken.com API
	 *
	 * @constructor
	 * @param {String} key    API Key
	 * @param {String} secret API Secret
	 * @param {String|Object} [options={}]  Additional options. If a string is passed, will default to just setting `options.otp`.
	 * @param {String} [options.otp] Two-factor password (optional) (also, doesn't work)
	 * @param {Number} [options.timeout] Maximum timeout (in milliseconds) for all API-calls (passed to `request`)
	 */
	constructor(key, secret, options = {}) {
		if (typeof options === 'string') {
			options = {otp: options};
		}

		this._config = {
			url: 'https://api.kraken.com',
			version: options.version || '0',
			key: key,
			secret: secret,
			otp: options.otp,
			timeoutMS: options.timeout || 5000
		};

		this._lastNonce = Date.now() * 1000; // spoof microsecond

		this.api = this.api.bind(this);
	}

	/**
	 * This method makes a public or private API request.
	 *
	 * @param  {String}   method      The API method (public or private)
	 * @param  {Object}   params      Arguments to pass to the api call
	 * @param  {Function} [callback]  A callback function or falsy if you want to use promises
	 * @return {Object}               The request object
	 */
	api(method, params, callback) {
		if (AVAILABLE_METHODS.public.indexOf(method) !== -1) {
			return this._publicMethod(method, params, callback);
		} else if (AVAILABLE_METHODS.private.indexOf(method) !== -1) {
			return this._privateMethod(method, params, callback);
		} else {
			throw new Error(method + ' is not a valid API method.');
		}
	}

	/**
	 * This method makes a public API request.
	 *
	 * @param  {String}   method      The public API method
	 * @param  {Object}   params      Arguments to pass to the api call
	 * @param  {Function} [callback]  A callback function or falsy if you want to use promises
	 * @private
	 * @return {Object}               The request object
	 */
	_publicMethod(method, params = {}, callback = null) {
		const config = this._config;
		const path = `/${config.version}/public/${method}`;
		const url = `${config.url}${path}`;

		return this._rawRequest(url, {}, params, callback);
	}

	/**
	 * This method makes a private API request.
	 *
	 * @param  {String}   method      The private API method
	 * @param  {Object}   params      Arguments to pass to the api call
	 * @param  {Function} [callback]  A callback function or falsy if you want to use promises
	 * @private
	 * @return {Object}               The request object
	 */
	_privateMethod(method, params = {}, callback = null) {
		const config = this._config;
		const path = `/${config.version}/private/${method}`;
		const url = `${config.url}${path}`;

		if (!params.nonce) {
			let nonce = this._lastNonce;

			if (nonce) {
				nonce = nonce + 1;
			} else {
				//should never happen, since the constructor initializes the last nonce
				nonce = Date.now() * 1000; // spoof microsecond
			}

			params.nonce = nonce;
			this._lastNonce = nonce;
		}

		if (config.otp !== undefined) {
			params.otp = config.otp;
		}

		const signature = this._getMessageSignature(path, params, params.nonce);

		const headers = {
			'API-Key': config.key,
			'API-Sign': signature
		};

		return this._rawRequest(url, headers, params, callback);
	}

	/**
	 * This method returns a signature for a request as a Base64-encoded string
	 *
	 * @param  {String}  path    The relative URL path for the request
	 * @param  {Object}  request The POST body
	 * @param  {Number} nonce   A unique, incrementing integer
	 * @private
	 * @return {String}          The request signature
	 */
	_getMessageSignature(path, request, nonce) {
		const message = querystring.stringify(request);
		const secret = new Buffer(this._config.secret, 'base64');
		const hash = new crypto.createHash('sha256');
		const hmac = new crypto.createHmac('sha512', secret);

		let hash_digest = hash.update(nonce + message).digest('binary');
		return hmac.update(path + hash_digest, 'binary').digest('base64');
	}

	/**
	 * This method sends the actual HTTP request
	 *
	 * @param  {String}   url         The URL to make the request
	 * @param  {Object}   headers     Request headers
	 * @param  {Object}   params      POST body
	 * @param  {Function} [callback]  A callback function or falsy if you want to use promises
	 * @private
	 * @return {Bluebird} Always resolves if callback is given!
	 */
	_rawRequest(url, headers, params, callback) {
		// Set custom User-Agent string
		headers['User-Agent'] = 'Kraken Javascript API Client';

		const options = {
			url: url,
			method: 'POST',
			headers: headers,
			form: params,
			timeout: this._config.timeoutMS
		};

		return new Bluebird(function (resolve, reject) {
			request.post(options, function (error, response, body) {
				let data;

				if (error) {
					error = new Error('Error in server response: ' + JSON.stringify(error));

					if (callback) {
						resolve();
						return callback.call(self, error, null);
					} else {
						return reject(error);
					}
				}

				try {
					data = JSON.parse(body);
				} catch (e) {
					error = new Error('Could not understand response from server: ' + body);

					if (callback) {
						resolve();
						return callback.call(self, error, null);
					} else {
						return reject(error);
					}
				}

				//If any errors occured, Kraken will give back an array with error strings under
				//the key "error". We should then propagate back the error message as a proper error.
				if (data.error && Array.isArray(data.error) && data.error.length) {
					let krakenError = null;

					data.error.forEach(function (element) {
						if (element.charAt(0) === 'E') {
							krakenError = element.substr(1);
							return false;
						}
					});

					if (krakenError) {
						error = new Error('Kraken API returned error: ' + krakenError);

						if (callback) {
							resolve();
							return callback.call(self, error, null);
						} else {
							return reject(error);
						}
					} else {
						error = new Error('Kraken API returned an unknown error: ' + JSON.stringify(data.error));

						if (callback) {
							resolve();
							return callback.call(self, error, null);
						} else {
							return reject(error);
						}
					}
				} else {
					resolve(data.result || data);

					if (callback) {
						callback.call(self, null, data.result || data);
					}
				}
			});
		});
	}
};
