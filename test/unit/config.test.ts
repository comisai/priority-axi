import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readSettings, serviceRoot } from '../../src/config.ts';
import { AxiError } from '../../src/errors.ts';

const base = { PRIORITY_PASSWORD: 'p', PRIORITY_USER: 'user_a' };

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof AxiError);
    return error.code;
  }
  assert.fail('expected an AxiError');
}

describe('readSettings', () => {
  it('splits a full service root into origin, ini and company', () => {
    const s = readSettings({
      ...base,
      PRIORITY_URL: 'https://erp.example.com/odata/Priority/tabula.ini/demo',
    });
    assert.deepEqual(s, {
      origin: 'https://erp.example.com',
      ini: 'tabula.ini',
      company: 'demo',
      user: 'user_a',
      password: 'p',
    });
    assert.equal(
      serviceRoot(s),
      'https://erp.example.com/odata/Priority/tabula.ini/demo',
    );
  });

  it('takes an origin with the company from the environment and the default ini', () => {
    const s = readSettings({
      ...base,
      PRIORITY_URL: 'https://erp.example.com:8443/',
      PRIORITY_COMPANY: 'demo',
    });
    assert.equal(s.origin, 'https://erp.example.com:8443');
    assert.equal(s.ini, 'tabula.ini');
    assert.equal(s.company, 'demo');
  });

  it('lets flags win over variables and over the service root', () => {
    const s = readSettings(
      {
        ...base,
        PRIORITY_URL: 'https://erp.example.com/odata/Priority/tabula.ini/demo',
        PRIORITY_COMPANY: 'env_co',
      },
      { company: 'flag_co', user: 'flag_user', ini: 'tabtest.ini' },
    );
    assert.equal(s.company, 'flag_co');
    assert.equal(s.user, 'flag_user');
    assert.equal(s.ini, 'tabtest.ini');
  });

  it('reports not_connected when the address or password is missing', () => {
    assert.equal(
      code(() => readSettings({ ...base, PRIORITY_COMPANY: 'demo' })),
      'not_connected',
    );
    assert.equal(
      code(() =>
        readSettings({
          PRIORITY_URL: 'https://erp.example.com',
          PRIORITY_USER: 'u',
          PRIORITY_COMPANY: 'demo',
        }),
      ),
      'not_connected',
    );
  });

  it('reports missing_setting for the company and the username', () => {
    assert.equal(
      code(() =>
        readSettings({ ...base, PRIORITY_URL: 'https://erp.example.com' }),
      ),
      'missing_setting',
    );
    assert.equal(
      code(() =>
        readSettings({
          PRIORITY_PASSWORD: 'p',
          PRIORITY_URL: 'https://erp.example.com',
          PRIORITY_COMPANY: 'demo',
        }),
      ),
      'missing_setting',
    );
  });

  it('allows plain http only for a local fake server', () => {
    assert.equal(
      code(() =>
        readSettings({
          ...base,
          PRIORITY_URL: 'http://erp.example.com/odata/Priority/tabula.ini/demo',
        }),
      ),
      'usage',
    );
    const local = readSettings({
      ...base,
      PRIORITY_URL: 'http://127.0.0.1:4100/odata/Priority/tabula.ini/demo',
    });
    assert.equal(local.origin, 'http://127.0.0.1:4100');
  });

  it('refuses addresses with a path, a query or credentials', () => {
    for (const url of [
      'https://erp.example.com/other',
      'https://erp.example.com/?x=1',
      'https://user:pw@erp.example.com',
      'not a url',
    ]) {
      assert.equal(
        code(() =>
          readSettings({
            ...base,
            PRIORITY_COMPANY: 'demo',
            PRIORITY_URL: url,
          }),
        ),
        'usage',
        url,
      );
    }
  });

  it('refuses an ini or company the Gate segment cannot match, such as the ",3" language suffix', () => {
    const url = 'https://erp.example.com';
    assert.equal(
      code(() =>
        readSettings({
          ...base,
          PRIORITY_URL: url,
          PRIORITY_COMPANY: 'demo',
          PRIORITY_INI: 'tabula.ini,3',
        }),
      ),
      'usage',
    );
    assert.equal(
      code(() =>
        readSettings({ ...base, PRIORITY_URL: url, PRIORITY_COMPANY: 'de/mo' }),
      ),
      'usage',
    );
  });

  it('refuses a username Basic authentication cannot carry', () => {
    assert.equal(
      code(() =>
        readSettings({
          ...base,
          PRIORITY_URL: 'https://erp.example.com',
          PRIORITY_COMPANY: 'demo',
          PRIORITY_USER: 'a:b',
        }),
      ),
      'usage',
    );
  });

  it('never puts the password into an error message', () => {
    try {
      readSettings({
        PRIORITY_URL: 'https://erp.example.com',
        PRIORITY_PASSWORD: 'secret-value-9',
      });
    } catch (error) {
      assert.ok(error instanceof AxiError);
      assert.ok(!error.message.includes('secret-value-9'));
    }
  });
});
