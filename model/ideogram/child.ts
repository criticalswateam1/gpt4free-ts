import { ChildOptions, ComChild, DestroyOptions } from '../../utils/pool';
import {
  Account,
  ClertAuth,
  PredictionsReq,
  PredictionsRes,
  ResultRes,
} from './define';
import {
  CreateNewAxios,
  CreateNewPage,
  getProxy,
} from '../../utils/proxyAgent';
import { Page, Protocol } from 'puppeteer';
import moment from 'moment';
import { loginGoogle } from '../../utils/puppeteer';
import {
  downloadAndUploadCDN,
  ErrorData,
  Event,
  EventStream,
  parseJSON,
  sleep,
} from '../../utils';
import es from 'event-stream';
import { AxiosInstance } from 'axios';

export class Child extends ComChild<Account> {
  private _client!: AxiosInstance;
  private page!: Page;
  private apipage!: Page;
  private proxy: string = this.info.proxy || getProxy();
  private updateTimer: NodeJS.Timeout | null = null;
  clert!: ClertAuth;

  constructor(
    private tmp: boolean,
    label: string,
    info: Account,
    options?: ChildOptions,
  ) {
    super(label, info, options);
  }

  get client() {
    if (!this._client) {
      this._client = CreateNewAxios(
        {
          baseURL: 'https://ideogram.ai/api/',
        },
        {
          proxy: this.proxy,
          errorHandler: (e) => {
            this.logger.error(
              JSON.stringify({
                message: e.message,
                status: e.response?.status,
                response: e.response?.data,
              }),
            );
            if (e.response?.status === 401) {
              this.logger.info('not login');
              this.update({ cookies: [] });
              this.destroy({ delFile: false, delMem: true });
              return;
            }
            if (e.response?.status === 402) {
              this.logger.info('not enough quota');
              this.update({ refresh_time: moment().add(365, 'day').unix() });
              this.destroy({ delFile: false, delMem: true });
              return;
            }
          },
        },
      );
    }
    return this._client;
  }

  async saveCookies() {
    const cookies = await this.page.cookies('https://clerk.flux1.ai');
    const client = cookies.find((v) => v.name === '__client');
    if (!client) {
      throw new Error('not found cookies');
    }
    this.update({ cookies });
    const sessionCookies = await this.page.cookies('https://flux1.ai');
    const session = sessionCookies.filter((v) =>
      v.name.startsWith('__session'),
    );
    if (!session?.length) {
      throw new Error('not found session');
    }
    this.update({ sessCookies: session });
    this.logger.info('cookies saved ok');
  }

  async getHeader() {
    if (!this.clert) {
      this.clert = new ClertAuth(
        'flux1.ai',
        this.info.cookies.find((v) => v.name === '__client')!.value,
        '5.14.0',
        this.info.ua!,
        this.proxy,
      );
    }
    const token = await this.clert.getToken();
    return {
      accept: '*/*',
      'accept-language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7,en-GB;q=0.6',
      origin: 'https://flux1.ai',
      priority: 'u=1, i',
      referer: 'https://flux1.ai/create',
      'user-agent': this.info.ua!,
      Cookie:
        `__client_uat=${moment().unix()}` +
        '; ' +
        this.info.sessCookies.map((v) => `${v.name}=${token}`).join('; '),
      'content-type': 'text/plain;charset=UTF-8',
    };
  }

  async saveUA() {
    const ua = await this.page.evaluate(() => navigator.userAgent.toString());
    this.update({ ua });
  }

  async chat(messages: string) {
    return (
      await this.client.post<{ data: string }>(
        '/chat',
        { messages },
        {
          headers: await this.getHeader(),
        },
      )
    ).data;
  }

  async predictions(req: PredictionsReq) {
    return (
      await this.client.post<PredictionsRes>('/predictions', req, {
        headers: await this.getHeader(),
      })
    ).data;
  }

  async result(id: string) {
    const { data } = await this.client.get<ResultRes>(`/result/${id}`, {
      headers: await this.getHeader(),
    });
    if (data.imgAfterSrc) {
      data.imgAfterSrc = await downloadAndUploadCDN(data.imgAfterSrc);
    }
    return data;
  }

  async init() {
    if (!this.info.email) {
      throw new Error('email is required');
    }
    this.update({ destroyed: false });
    let page;
    if (!this.info.cookies?.length) {
      page = await CreateNewPage('https://ideogram.ai/login', {
        proxy: this.proxy,
      });
      this.page = page;
      // click login
      await page.waitForSelector('.MuiButton-containedPrimary');
      await page.click('.MuiButton-containedPrimary');

      await loginGoogle(
        page,
        this.info.email,
        this.info.password,
        this.info.recovery,
      );
      await sleep(10000);
      await this.page.goto('https://flux1.ai/create');
      this.update({ proxy: this.proxy });
      await this.saveUA();
      await this.saveCookies();
      await this.page.close();
    }
  }

  initFailed() {
    this.update({ proxy: undefined });
    this.destroy({ delFile: false, delMem: true });
  }

  use() {
    this.update({
      lastUseTime: moment().unix(),
      useCount: (this.info.useCount || 0) + 1,
    });
  }

  destroy(options?: DestroyOptions) {
    super.destroy(options);
    this.page
      ?.browser()
      .close()
      .catch((err) => this.logger.error(err.message));
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
    }
  }
}
