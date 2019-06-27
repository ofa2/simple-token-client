import { readJSON, writeJSON } from 'fs-extra';
import { tmpdir } from 'os';
import { resolve as pathResolve } from 'path';
import rp, { Options } from 'request-promise';
import retry from 'retry';
import { Url } from 'url';

function defer() {
  let resolve;
  let reject;
  let promise = new Promise((...args) => {
    [resolve, reject] = args;
  });

  return {
    resolve,
    reject,
    promise,
  };
}

export type TokenResponse =
  | { accessToken: string; expiresAt: number }
  | { accessToken: string; expiresIn: number };

export interface ITokenConfig {
  saveFile?: string;
  getToken?: {
    (): Promise<{ accessToken: string; tokenExpiresAt: string }>;
  };
  saveToken?: {
    ({ accessToken, tokenExpiresAt }: { accessToken: string; tokenExpiresAt: Date }): void;
  };
  transformBody?: {
    (body?: object): TokenResponse | Promise<TokenResponse>;
  };
  requestOpts?: Options;
  createRequestBody?: {
    (): object | Promise<TokenResponse>;
  };
  tokenEndpoint?: string | Url;
  tokenRetryOptions?: {
    retries?: number;
    factor?: number;
    minTimeout?: number;
    maxTimeout?: number;
    randomize?: boolean;
  };
}

class SimpleTokenClient {
  private config: ITokenConfig;

  private accessToken = '';

  private tokenExpiresAt = new Date();

  private pendingRequests: any[] = [];

  private defaultConfig = {
    tokenRetryOptions: {
      retries: 5,
      factor: 3,
      minTimeout: 1000,
      maxTimeout: 60 * 1000,
      randomize: true,
    },
  };

  constructor(config: ITokenConfig) {
    this.config = {
      ...this.defaultConfig,
      ...config,
    };

    this.saveDirBuild();
  }

  async getToken(isForce = false) {
    if (isForce) {
      await this.requestToken();
    }

    let tokenInfo = await this.getTokenInfo();

    if (
      !tokenInfo
      || !tokenInfo.tokenExpiresAt
      || new Date() > new Date(tokenInfo.tokenExpiresAt)
    ) {
      return this.requestTokenWithBlock();
    }

    return tokenInfo.accessToken;
  }

  private async requestTokenWithBlock() {
    let deferred = defer();
    if (!this.pendingRequests.length) {
      this.pendingRequests.push(deferred);
      this.requestToken();
    } else {
      this.pendingRequests.push(deferred);
    }

    return deferred.promise;
  }

  private async requestToken() {
    try {
      let body = await this.requestTokenWithRetry();

      if (this.config.transformBody) {
        body = await this.config.transformBody(body);
      }

      if (!body.accessToken) {
        throw new Error('no accessToken found');
      }

      this.accessToken = body.accessToken;

      if ('expiresAt' in body) {
        this.tokenExpiresAt = new Date(body.expiresAt);
      } else if ('expiresIn' in body) {
        this.tokenExpiresAt = new Date(new Date().getTime() + body.expiresIn * 1000 - 120 * 1000);
      } else {
        throw new Error('no expiresIn or expiresAt found');
      }

      if (this.config.saveToken) {
        await this.config.saveToken({
          accessToken: this.accessToken,
          tokenExpiresAt: this.tokenExpiresAt,
        });
      }

      this.pendingRequests.forEach((deferred) => {
        process.nextTick(() => {
          return deferred.resolve(this.accessToken);
        });
      });
      this.pendingRequests.length = 0;
    } catch (e) {
      this.pendingRequests.forEach((deferred) => {
        process.nextTick(() => {
          return deferred.reject(e);
        });
      });
      this.pendingRequests.length = 0;

      throw e;
    }
  }

  private saveDirBuild() {
    if (!this.config.saveFile) {
      return;
    }

    let dir = tmpdir();
    let filePath = pathResolve(dir, this.config.saveFile);

    this.config.getToken = async () => {
      return readJSON(filePath).catch(() => {
        return { accessToken: '', tokenExpiresAt: new Date(0) };
      });
    };

    this.config.saveToken = async (data: object) => {
      await writeJSON(filePath, data);
    };
  }

  private async requestTokenBuild(): Promise<TokenResponse> {
    if (!this.config.requestOpts && !this.config.createRequestBody) {
      throw new Error('no requestOpts && no createRequestBody');
    }

    let opts: Options;
    if (this.config.requestOpts) {
      opts = this.config.requestOpts;
    } else if (this.config.createRequestBody && this.config.tokenEndpoint) {
      let body = await this.config.createRequestBody();

      opts = {
        url: this.config.tokenEndpoint,
        method: 'POST',
        proxy: false,
        json: true,
        followRedirect: false,
        body,
      };
    } else {
      throw new Error('no requestOpts and no (createRequestBody & tokenEndpoint)');
    }

    return rp(opts);
  }

  private async requestTokenWithRetry() {
    let operation = retry.operation(this.config.tokenRetryOptions);

    return new Promise<TokenResponse>((resolve, reject) => {
      operation.attempt(() => {
        return this.requestTokenBuild()
          .then((body) => {
            resolve(body);
          })
          .catch((e) => {
            if (operation.retry(e)) {
              return null;
            }

            return reject(operation.mainError());
          });
      });
    });
  }

  private async getTokenInfo() {
    if (this.config.getToken) {
      return this.config.getToken();
    }

    return {
      accessToken: this.accessToken,
      tokenExpiresAt: this.tokenExpiresAt,
    };
  }
}

export { SimpleTokenClient };
export default SimpleTokenClient;
