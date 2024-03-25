import { ComChild } from '../../utils/pool';
import {
  Account,
  GenerationResponse,
  GenRequestOptions,
  LibraryVideo,
} from './define';
import { AxiosInstance } from 'axios';
import { CreateNewAxios, CreateNewPage } from '../../utils/proxyAgent';
import FormData from 'form-data';
import { Page, Protocol } from 'puppeteer';
import moment from 'moment';
import { loginGoogle } from '../../utils/puppeteer';
import { parseJSON } from '../../utils';

export class Child extends ComChild<Account> {
  private client!: AxiosInstance;
  private page!: Page;

  async init() {
    if (!this.info.email) {
      throw new Error('email is required');
    }
    let page;
    if (this.info.cookies) {
      const cookies: Protocol.Network.CookieParam[] = [];
      page = await CreateNewPage('https://pika.art/my-library/', {
        simplify: true,
        cookies: this.info.cookies,
      });
    } else {
      page = await CreateNewPage('https://pika.art/login', {
        simplify: false,
      });
      // click login
      await page.waitForSelector('form > div > button');
      await page.click('form > div > button');

      await loginGoogle(
        page,
        this.info.email,
        this.info.password,
        this.info.recovery,
      );
    }
    this.page = page;
    // 保存cookies
    const cookies = await page.cookies('https://pika.art');
    this.update({ cookies });
    this.logger.debug('saved cookies');
    this.saveToken();
    this.client = CreateNewAxios(
      {
        baseURL: 'https://api.pika.art/',
        headers: {
          Authorization: `Bearer ${this.info.token}`,
        },
      },
      { proxy: true },
    );
  }

  saveToken() {
    let login = this.info.cookies.find(
      (v) => v.name === 'sb-login-auth-token',
    )?.value;
    if (!login) {
      throw new Error('login token not found');
    }
    login = decodeURIComponent(login);
    const loginInfo = parseJSON<{
      access_token?: string;
      user?: { id: string };
    }>(login, {});
    if (!loginInfo.access_token) {
      throw new Error('login token not found');
    }
    if (!loginInfo?.user?.id) {
      throw new Error('login user id not found');
    }
    this.update({ token: loginInfo.access_token, user_id: loginInfo.user.id });
    this.logger.info('saved token ok');
  }

  initFailed() {
    super.initFailed();
    if (this.page) {
      this.page.browser().close();
    }
  }

  use() {
    this.update({
      lastUseTime: moment().unix(),
      useCount: (this.info.useCount || 0) + 1,
    });
  }

  async generate(prompt: string) {
    const formData = new FormData();
    const options: GenRequestOptions = {
      aspectRatio: 1.7777777777777777,
      frameRate: 24,
      camera: {},
      parameters: {
        guidanceScale: 12,
        motion: 1,
        negativePrompt: '',
      },
      extend: false,
    };

    formData.append('promptText', prompt);
    formData.append('options', JSON.stringify(options));
    formData.append('userId', this.info.user_id);
    const res: { data: GenerationResponse } = await this.client.post(
      '/generate',
      formData,
      { ...formData.getHeaders() },
    );
    if (res.data.data.generation.id) {
    }
    return this.info.id + '|' + res.data.data.generation.id;
  }

  async fetchVideo(id: string) {
    return await this.page.evaluate((id) => {
      const selectors = document.querySelectorAll('video > source');
      // @ts-ignore
      const src_list = [];
      selectors.forEach((v) => {
        src_list.push(v.getAttribute('src'));
      });
      // @ts-ignore
      return src_list.find((v) => v.indexOf(id) !== -1);
    }, id);
  }

  async myLibrary(id: string) {
    const result = await this.fetch<string>('/my-library', {
      body: JSON.stringify([{ ids: [id] }]),
      method: 'POST',
    });
    if (!result) {
      throw new Error('fetch my-library failed');
    }
    let [_, info] = result?.split('\n');
    info = info.replace('1:', '');

    return parseJSON<LibraryVideo | undefined>(info, undefined);
  }

  async fetch<T>(path: string, requestInit: RequestInit): Promise<T> {
    return (await this.page.evaluate(
      (token, path, requestInit) => {
        return new Promise((resolve) => {
          fetch(`https://pika.art${path}`, {
            referrer: 'https://pika.art/my-library',
            referrerPolicy: 'same-origin',
            body: null,
            method: 'GET',
            mode: 'cors',
            credentials: 'include',
            ...requestInit,
            headers: {
              accept: 'text/x-component',
              'accept-language': 'en-US,en;q=0.9',
              'content-type': 'text/plain;charset=UTF-8',
              'next-action': 'a4f7d00566d7755f69cb53e2b2bbaf32236f107e',
              'next-router-state-tree':
                '%5B%22%22%2C%7B%22children%22%3A%5B%22(dashboard)%22%2C%7B%22children%22%3A%5B%22my-library%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%5D%7D%5D%7D%5D%7D%2Cnull%2Cnull%2Ctrue%5D',
              'sec-ch-ua':
                '" Not;A Brand";v="99", "Google Chrome";v="115", "Chromium";v="115"',
              'sec-ch-ua-mobile': '?0',
              'sec-ch-ua-platform': '"Mac OS X"',
              'sec-fetch-dest': 'empty',
              'sec-fetch-mode': 'cors',
              'sec-fetch-site': 'same-origin',
              ...requestInit.headers,
            },
          })
            .then((res) => {
              return res.text();
            })
            .then((data) => {
              resolve(data);
            })
            .catch((error) => {
              resolve(null);
            });
        });
      },
      this.info.token,
      path,
      requestInit,
    )) as T;
  }
}
