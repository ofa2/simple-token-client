import { readJSON, writeJSON } from 'fs-extra';
import got from 'got';
import {
  CancelableRequest, Options, Response, URLArgument
} from 'got/dist/utils/types';
import { tmpdir } from 'os';
import { resolve as pathResolve } from 'path';
import { URL } from 'url';

function defer() {
  let resolve;
  let reject;
  const promise = new Promise((...args) => {
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
    (response?: CancelableRequest<Response>): Promise<TokenResponse>;
  };
  requestOpts?: Options;
  createRequestBody?: {
    (): object | Promise<TokenResponse>;
  };
  tokenEndpoint?: string | URL;
}

class SimpleTokenClient {
  private config: ITokenConfig;

  private accessToken = '';

  private tokenExpiresAt = new Date();

  private pendingRequests: any[] = [];

  private defaultRequestConfig = {
    responseType: 'json' as 'json',
    retry: {
      limit: 2,
    },
  };

  constructor(config: ITokenConfig) {
    this.config = {
      ...config,
    };

    this.saveDirBuild();
  }

  async getToken(isForce = false) {
    if (isForce) {
      await this.requestToken();
    }

    const tokenInfo = await this.getTokenInfo();

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
    const deferred = defer();
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
      const body = await this.requestTokenBuild();

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

    const dir = tmpdir();
    const filePath = pathResolve(dir, this.config.saveFile);

    this.config.getToken = async () => {
      if (this.accessToken && this.tokenExpiresAt) {
        return { accessToken: this.accessToken, tokenExpiresAt: this.tokenExpiresAt };
      }

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
      opts = { ...this.defaultRequestConfig, ...this.config.requestOpts };
    } else if (this.config.createRequestBody && this.config.tokenEndpoint) {
      const body = await this.config.createRequestBody();

      opts = {
        ...this.defaultRequestConfig,
        url: this.config.tokenEndpoint,
        method: 'POST',
        followRedirect: false,
        json: body,
      };
    } else {
      throw new Error('no requestOpts and no (createRequestBody & tokenEndpoint)');
    }

    const request = got(opts as Options & { url: URLArgument; stream: false });

    if (this.config.transformBody) {
      return this.config.transformBody(request);
    }

    const response = await request;
    return response.body;
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
